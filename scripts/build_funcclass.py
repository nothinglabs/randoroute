#!/usr/bin/env python3
"""
Build data/funcclass.geojson from WSDOT's non-state functional class layer.

BUILD-TIME ONLY.

Source: WSDOT - Functional Class Data for Non-State Routes
  https://data.wsdot.wa.gov/arcgis/rest/services/FunctionalClass/
    WSDOTFunctionalClassData/MapServer/1

Why this layer exists in our build: the CRAB road log stops at the city line --
its rows literally end "at CITY LIMITS: PUYALLUP" -- so it says nothing about a
street like W Pioneer Ave. This layer covers non-state roads, city and county
alike, and carries two fields worth having.

  FederalFunctionalClassCode   The FHWA classification. Nationally standardised,
                               which is the property that lets any of this
                               generalise past Washington. Measured against the
                               CRAB counts it tracks traffic volume
                               monotonically over a 60x spread:
                                 Principal Arterial 18,300/day
                                 Minor Arterial      7,830
                                 Major Collector     2,361
                                 Minor Collector       725
                                 Local                 297
                               So on a city street with no count, class is a
                               defensible stand-in -- but it is a PROXY FOR
                               VOLUME, NOT A MEASUREMENT OF IT, and it must be
                               presented as a class and never converted into a
                               fabricated vehicles-per-day figure.

  FHWARoadwayOwnerCode         Who maintains the road. Context and provenance;
                               never a verdict. "City street" does not mean
                               calm: W Pioneer Ave is a city street AND an urban
                               principal arterial.

Two rules decoded from the live service:

  * Codes 92-96 are PROPOSED classifications -- roads not built, or not yet
    reclassified. Dropped outright. This is Island County's "(Planned)" bike
    routes wearing a different hat, and that one caused a real bug.

  * WSDOTUrbanRuralCode is NOT a boolean. It is an urban-area identifier: 1-67
    name individual urbanized areas, 98 and 99 mean rural. It is carried as a
    cross-check only. The app's Census 2020 point-in-polygon flag is descriptive
    area context, not a switch between safety limits. WSDOT's urban/rural
    boundary descends from the larger FHWA *adjusted* urban boundary. See
    docs/plan-county-road-log.md.

Usage:
  python3 scripts/build_funcclass.py --out data/funcclass.geojson
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import arcgis  # noqa: E402

LAYER = ("https://data.wsdot.wa.gov/arcgis/rest/services/FunctionalClass/"
         "WSDOTFunctionalClassData/MapServer/1")

FIELDS = ["OBJECTID", "RoadName", "CityName", "LengthInMiles",
          "FederalFunctionalClassCode", "FHWARoadwayOwnerCode",
          "WSDOTUrbanRuralCode"]

# FHWA functional system. The description field carries an "Urban "/"Rural "
# prefix from WSDOT's adjusted boundary; we take the numeric code and name it
# ourselves so a second definition of "urban" cannot enter through the back door.
CLASS_NAME = {
    1: "Interstate",
    2: "Freeway or expressway",
    3: "Principal arterial",
    4: "Minor arterial",
    5: "Major collector",
    6: "Minor collector",
    7: "Local street",
}
PROPOSED = {92, 93, 94, 95, 96}

# Only the four owners that carry real mileage are named. The service also holds
# a scattering of federal and plainly corrupt codes (2135, 4046) across a few
# dozen rows; those keep their raw code rather than being guessed at.
OWNER_NAME = {1: "State", 2: "County", 3: "Town", 4: "City"}

RURAL_AREA_CODES = {98, 99}


def build(out_path, cache_dir, limit=None):
    stats = {"rows": 0, "geom": 0, "proposed": 0, "classed": 0,
             "city": 0, "county": 0, "rural": 0}
    by_class = {}
    features = []
    for f in arcgis.fetch_all(LAYER, FIELDS, cache_dir=cache_dir,
                              label="WSDOT non-state functional class"):
        a = f.get("attributes") or {}
        stats["rows"] += 1

        code = arcgis.num(a.get("FederalFunctionalClassCode"))
        code = int(code) if code is not None else None
        if code in PROPOSED:
            stats["proposed"] += 1
            continue
        if code not in CLASS_NAME:
            continue

        paths = arcgis.paths_of(f.get("geometry"))
        if not paths:
            continue
        stats["geom"] += 1
        stats["classed"] += 1
        by_class[code] = by_class.get(code, 0) + 1

        owner = arcgis.num(a.get("FHWARoadwayOwnerCode"))
        owner = int(owner) if owner is not None else None
        if owner == 4:
            stats["city"] += 1
        elif owner == 2:
            stats["county"] += 1

        area = arcgis.num(a.get("WSDOTUrbanRuralCode"))
        area = int(area) if area is not None else None
        if area in RURAL_AREA_CODES:
            stats["rural"] += 1

        props = {
            "name": arcgis.text(a.get("RoadName")),
            "city": arcgis.text(a.get("CityName")),
            "fc": code,
            "owner": owner,
            # WSDOT's own urban call, kept only so a disagreement with our
            # Census flag can be seen rather than silently resolved.
            "wsdotRural": 1 if area in RURAL_AREA_CODES else 0,
        }
        for path in paths:
            features.append({
                "type": "Feature",
                "properties": props,
                "geometry": {"type": "LineString", "coordinates": path},
            })
        if limit and stats["rows"] >= limit:
            break

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w") as fh:
        json.dump({"type": "FeatureCollection", "features": features}, fh,
                  separators=(",", ":"))

    print(f"\n  rows                 {stats['rows']:,}")
    print(f"  dropped as Proposed  {stats['proposed']:,}")
    print(f"  kept and classified  {stats['classed']:,}")
    print(f"  line features out    {len(features):,}")
    print("  by class:")
    for code in sorted(by_class):
        print(f"    {code} {CLASS_NAME[code]:<22} {by_class[code]:,}")
    print(f"  owner: city {stats['city']:,}   county {stats['county']:,}")
    print(f"  WSDOT says rural     {stats['rural']:,}")
    print(f"\n  -> {out_path}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="data/funcclass.geojson")
    ap.add_argument("--cache", default="data/.cache/funcclass")
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()
    build(args.out, args.cache, args.limit)


if __name__ == "__main__":
    main()
