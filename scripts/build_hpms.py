#!/usr/bin/env python3
"""
Build data/hpms.geojson from FHWA's HPMS Public Release for Washington.

BUILD-TIME ONLY.

Source: FHWA Highway Performance Monitoring System, public geospatial release
  https://geo.dot.gov/server/rest/services/Hosted/Washington_2018_PR/
    FeatureServer/0

Why this one matters: it is the only source found with traffic volume for CITY
streets. Both WSDOT traffic layers are keyed to a StateRouteNumber, and the CRAB
county road log stops at the city line -- so a city arterial like W Pioneer Ave
in Puyallup has no count from any state source at all. HPMS has 23,413
city-owned sections in Washington and every one of them carries an AADT.

Every state DOT must submit HPMS to FHWA annually and FHWA republishes it, so
the same service exists for all fifty states. That is the property that makes it
worth adopting over any per-city portal.

TWO THINGS THAT MUST TRAVEL WITH THE NUMBER.

  1. The hosted Washington release is 2018. Older than WSDOT's 2025 state
     counts, newer than most of the county road log.

  2. Non-state AADT in HPMS is frequently MODELLED, not counted. FHWA permits
     states to estimate volumes on lower functional classes rather than count
     every section, so a city-street figure is an official estimate. It is not
     the same kind of claim as a WSDOT tube count and must not be pooled with
     one under a single label.

Sections carry no usable name -- they are keyed by LRS `route_id` -- so matching
is geometric, and the sections are short. See scripts/roadmeasure.py.

Usage:
  python3 scripts/build_hpms.py --out data/hpms.geojson
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import arcgis  # noqa: E402

LAYER = ("https://geo.dot.gov/server/rest/services/Hosted/"
         "Washington_2018_PR/FeatureServer/0")

FIELDS = ["objectid", "route_id", "aadt", "year_record", "f_system",
          "ownership", "through_lanes", "speed_limit", "urban_code"]

# FHWA roadway ownership. Only the four that carry real mileage are named; the
# rest keep their raw code rather than being guessed at.
OWNER_STATE, OWNER_COUNTY, OWNER_TOWN, OWNER_CITY = 1, 2, 3, 4


def build(out_path, cache_dir, limit=None):
    stats = {"rows": 0, "geom": 0, "aadt": 0, "city": 0, "county": 0, "state": 0}
    by_class = {}
    features = []
    for f in arcgis.fetch_all(LAYER, FIELDS, where="aadt>0", cache_dir=cache_dir,
                              order_by="objectid", page=1000,
                              label="FHWA HPMS Washington"):
        a = f.get("attributes") or {}
        stats["rows"] += 1
        paths = arcgis.paths_of(f.get("geometry"))
        if not paths:
            continue
        stats["geom"] += 1

        aadt = arcgis.num(a.get("aadt"))
        aadt = int(aadt) if aadt and aadt > 0 else None
        if aadt is None:
            continue
        stats["aadt"] += 1

        owner = arcgis.num(a.get("ownership"))
        owner = int(owner) if owner is not None else None
        if owner == OWNER_CITY:
            stats["city"] += 1
        elif owner == OWNER_COUNTY:
            stats["county"] += 1
        elif owner == OWNER_STATE:
            stats["state"] += 1

        fc = arcgis.num(a.get("f_system"))
        fc = int(fc) if fc in range(1, 8) else None
        if fc:
            by_class[fc] = by_class.get(fc, 0) + 1

        year = arcgis.num(a.get("year_record"))
        year = int(year) if year and 1980 <= year <= 2035 else None
        lanes = arcgis.num(a.get("through_lanes"))
        speed = arcgis.num(a.get("speed_limit"))

        props = {
            "adt": aadt,
            "adty": year,
            "fc": fc,
            "owner": owner,
            "lanes": int(lanes) if lanes and lanes > 0 else None,
            # Carried but NOT imported into the model: HPMS speed on a local
            # road has the same problem as a county speed layer -- it is often
            # the statutory default rather than a posted, measured limit. Kept
            # here only so the question can be revisited from the data.
            "speed": int(speed) if speed and speed > 0 else None,
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

    print(f"\n  rows with a count   {stats['rows']:,}")
    print(f"  with geometry       {stats['geom']:,}")
    print(f"  line features out   {len(features):,}")
    print(f"  owner: state {stats['state']:,}  county {stats['county']:,}"
          f"  city {stats['city']:,}")
    print("  by functional class:")
    for code in sorted(by_class):
        print(f"    {code}  {by_class[code]:,}")
    print(f"\n  -> {out_path}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="data/hpms.geojson")
    ap.add_argument("--cache", default="data/.cache/hpms")
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()
    build(args.out, args.cache, args.limit)


if __name__ == "__main__":
    main()
