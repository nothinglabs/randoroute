#!/usr/bin/env python3
"""
Build data/aadt.geojson from WSDOT's traffic counts.

BUILD-TIME ONLY.

Source: WSDOT - Traffic Counts (AADT)
  https://data.wsdot.wa.gov/arcgis/rest/services/Shared/TrafficData/
    MapServer/1

Annual average daily traffic per section, state routes only. Small -- about
4,800 sections -- but it is the matching half of the county road log: CRAB gives
volume on county roads, this gives it on the state highways those roads run
beside. Without it the comparison a rider actually cares about, "is the side
road quieter than the highway", has a number on one side only.

Counts here are current (2025 at the time of writing) where the county counts
run 1940-2023, so the year travels with the number from both sources and the
card always says which it is showing.

Usage:
  python3 scripts/build_aadt.py --out data/aadt.geojson
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import arcgis  # noqa: E402

LAYER = ("https://data.wsdot.wa.gov/arcgis/rest/services/Shared/TrafficData/"
         "MapServer/1")

FIELDS = ["OBJECTID", "StateRouteNumber", "RouteIdentifier", "Location",
          "AADT", "ReportingYear"]


def build(out_path, cache_dir, limit=None):
    stats = {"rows": 0, "kept": 0}
    years = {}
    features = []
    for f in arcgis.fetch_all(LAYER, FIELDS, cache_dir=cache_dir,
                              label="WSDOT traffic counts (AADT)"):
        a = f.get("attributes") or {}
        stats["rows"] += 1
        aadt = arcgis.num(a.get("AADT"))
        if aadt is None or aadt <= 0:
            continue
        paths = arcgis.paths_of(f.get("geometry"))
        if not paths:
            continue
        stats["kept"] += 1
        year = arcgis.num(a.get("ReportingYear"))
        year = int(year) if year and 1930 <= year <= 2035 else None
        years[year] = years.get(year, 0) + 1
        props = {
            "sr": arcgis.text(a.get("StateRouteNumber")),
            "adt": int(aadt),
            "adty": year,
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

    print(f"\n  rows              {stats['rows']:,}")
    print(f"  with a count      {stats['kept']:,}")
    print(f"  line features out {len(features):,}")
    print("  by reporting year:")
    for y in sorted(years, key=lambda v: (v is None, v)):
        print(f"    {y}  {years[y]:,}")
    print(f"\n  -> {out_path}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="data/aadt.geojson")
    ap.add_argument("--cache", default="data/.cache/aadt")
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()
    build(args.out, args.cache, args.limit)


if __name__ == "__main__":
    main()
