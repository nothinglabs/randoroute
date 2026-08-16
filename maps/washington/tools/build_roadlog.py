#!/usr/bin/env python3
"""
Build data/roadlog.geojson from CRAB's certified county road log.

BUILD-TIME ONLY. The app makes no runtime calls; it renders from the static
file this produces (and, after conflation, from the graph and tiles).

Source: County Road Administration Board, certified county road log
  https://services9.arcgis.com/bwkxJJr72Wf3t8dm/arcgis/rest/services/
    CRAB_County_Road_Log_Certified_2023/FeatureServer/0

115,582 segments, all 39 counties, one schema. Counties are required to certify
this to CRAB annually, which is why it is uniform where their own open-data
portals are not. Do not confuse it with WSDOT's re-publication of the same
layer, which strips every attribute -- see docs/data-sources-found.md.

What we take, and why:

  ADTVolume / ADTYear   Traffic volume, populated on 98% of rows. The evidence
                        that a quiet county road beats a state highway. Useless
                        without its year: the counts run 1940-2023 and only 24%
                        are 2018 or newer, so the year travels with the number
                        everywhere, including onto the card.

  bail-out space        Derived, available on 100% of rows:
                          OperationalWidth - lanes x lane width
                        Validated against the 16,786 rows that also report
                        explicit shoulder widths: median error 0.00 ft, 86%
                        within 1 ft, and 99% of the disagreements are rows that
                        also report an unpaved shoulder. So this is TOTAL edge
                        space, paved or not -- "somewhere to go when a truck
                        comes past", NOT a ridable shoulder.

  paved shoulder        The explicit fields, populated on only ~15% of rows. A
                        blank means "not separately inventoried", not "no
                        shoulder": of 16,801 populated values only 15 are zero.
                        This is the one that may feed the shoulder rule.

What we deliberately do NOT take: speed. The road log has no speed field, and
the counties' separate speed layers hurt us -- a rural county road often carries
the statutory default (50 mph outside cities, RCW 46.61.400) on a road where no
limit was ever set, which records the absence of a decision rather than a
measured hazard. See docs/plan-county-road-log.md.

Usage:
  python3 scripts/build_roadlog.py --out data/roadlog.geojson
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'scripts'))
import arcgis  # noqa: E402

LAYER = ("https://services9.arcgis.com/bwkxJJr72Wf3t8dm/arcgis/rest/services/"
         "CRAB_County_Road_Log_Certified_2023/FeatureServer/0")

FIELDS = [
    "OBJECTID", "County", "RoadName", "ADTVolume", "ADTYear",
    "ThruLanes", "ThruLaneWidth", "OtherLanes", "OtherLaneWidth",
    "OperationalWidth", "ThruLaneSurface",
    "LeftPavedShoulderWidth", "RightPavedShoulderWidth",
    "LeftUnpavedShoulderWidth", "RightUnpavedShoulderWidth",
]

# --------------------------------------------------------------- the clamp
# 25,162 rows (21.8%) record a through-lane wider than 13 ft. No lane is 16 ft
# wide; the county has entered half the pavement width as the lane. Deer Lake
# Road on Whidbey is one: 2 lanes x 16 ft = 32 ft of 34 ft pavement, deriving
# 2 ft of edge where the reality is nearer 11-12 ft lanes plus 5 ft of edge.
#
# This is a WRITTEN, REVIEWED rule, not an inference applied silently: where the
# recorded lane exceeds MAX_PLAUSIBLE_LANE_FT, assume the lane is
# ASSUMED_LANE_FT and treat the remainder as edge space. Every row it touches is
# marked `clamped`, and the underived value is kept alongside so the two can be
# compared in the field before either is trusted.
MAX_PLAUSIBLE_LANE_FT = 13.0
ASSUMED_LANE_FT = 12.0

# A count this old describes a road that may have been rebuilt since. Kept, not
# dropped -- an old count is still evidence -- but flagged so the card can say
# so and so nothing downstream treats 1977 like 2022.
STALE_COUNT_BEFORE = 2000


def edge_space(a):
    """(clamped_ft, raw_ft, was_clamped) edge space PER SIDE for one row.

    The subtraction yields the total left over across both sides -- that is what
    the validation measured, against the sum of the left and right reported
    shoulders. Everything downstream wants the space on the side you are riding
    on: `minShoulder` is a per-side rule and `shP` below is a per-side number.
    So halve it here, once, rather than leaving a total to be misread as a side.

    Halving assumes the leftover is split evenly, which the source gives no way
    to check. On Deer Lake Road it yields 5 ft a side from 34 ft of pavement and
    two clamped 12 ft lanes -- the figure the road actually has.
    """
    op = arcgis.num(a.get("OperationalWidth")) or 0.0
    thru = arcgis.num(a.get("ThruLanes")) or 0
    thru_w = arcgis.num(a.get("ThruLaneWidth")) or 0.0
    other = arcgis.num(a.get("OtherLanes")) or 0
    other_w = arcgis.num(a.get("OtherLaneWidth")) or 0.0

    raw = op - (thru * thru_w) - (other * other_w)
    clamped_w = min(thru_w, ASSUMED_LANE_FT) if thru_w > MAX_PLAUSIBLE_LANE_FT else thru_w
    adj = op - (thru * clamped_w) - (other * other_w)
    # A negative result means the recorded parts exceed the recorded whole. That
    # is a data error either way, so report no space rather than a fiction.
    return max(0.0, adj) / 2.0, max(0.0, raw) / 2.0, clamped_w != thru_w


def paved_shoulder(a):
    """Widest reported PAVED shoulder, or None when not inventoried.

    Deliberately the max of the two sides rather than the sum: this number is
    about the space on the side you are riding on, and it is compared against a
    per-side rule.
    """
    vals = [arcgis.num(a.get(k)) for k in
            ("LeftPavedShoulderWidth", "RightPavedShoulderWidth")]
    vals = [v for v in vals if v is not None]
    return max(vals) if vals else None


def unpaved_shoulder(a):
    vals = [arcgis.num(a.get(k)) for k in
            ("LeftUnpavedShoulderWidth", "RightUnpavedShoulderWidth")]
    vals = [v for v in vals if v is not None]
    return max(vals) if vals else None


def year_of(a):
    y = arcgis.text(a.get("ADTYear"))
    if not y:
        return None
    try:
        n = int(float(y))
    except (TypeError, ValueError):
        return None
    # The field contains 0, 200, 220, 635 and 2051 among real years.
    return n if 1930 <= n <= 2035 else None


def build(out_path, cache_dir, limit=None, where="1=1"):
    stats = {"rows": 0, "geom": 0, "adt": 0, "stale": 0, "clamped": 0,
             "paved": 0, "edge_zero": 0, "edge_4plus": 0}
    features = []
    for f in arcgis.fetch_all(LAYER, FIELDS, where=where, cache_dir=cache_dir,
                              label="CRAB certified county road log"):
        a = f.get("attributes") or {}
        stats["rows"] += 1
        paths = arcgis.paths_of(f.get("geometry"))
        if not paths:
            continue
        stats["geom"] += 1

        adt = arcgis.num(a.get("ADTVolume"))
        adt = int(adt) if adt and adt > 0 else None
        year = year_of(a)
        if adt is not None:
            stats["adt"] += 1
            if year is not None and year < STALE_COUNT_BEFORE:
                stats["stale"] += 1

        edge, edge_raw, was_clamped = edge_space(a)
        if was_clamped:
            stats["clamped"] += 1
        if edge <= 0.01:
            stats["edge_zero"] += 1
        elif edge >= 4:
            stats["edge_4plus"] += 1

        paved = paved_shoulder(a)
        if paved is not None:
            stats["paved"] += 1

        props = {
            "name": arcgis.text(a.get("RoadName")),
            "county": int(arcgis.num(a.get("County")) or 0),
            "adt": adt,
            "adty": year,
            "edge": round(edge, 1),
            "edgeRaw": round(edge_raw, 1),
            "clamped": 1 if was_clamped else 0,
            "shP": None if paved is None else round(paved, 1),
            "shU": (lambda v: None if v is None else round(v, 1))(unpaved_shoulder(a)),
            "lanes": int(arcgis.num(a.get("ThruLanes")) or 0),
            "surface": arcgis.text(a.get("ThruLaneSurface")),
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

    r = stats["rows"] or 1
    print(f"\n  rows                 {stats['rows']:,}")
    print(f"  with geometry        {stats['geom']:,}")
    print(f"  line features out    {len(features):,}")
    print(f"  ADT volume           {stats['adt']:,}  ({100*stats['adt']/r:.1f}%)")
    print(f"    count before {STALE_COUNT_BEFORE}  {stats['stale']:,}")
    print(f"  paved shoulder       {stats['paved']:,}  ({100*stats['paved']/r:.1f}%)")
    print(f"  lane width clamped   {stats['clamped']:,}  ({100*stats['clamped']/r:.1f}%)")
    print(f"  edge space 0 ft      {stats['edge_zero']:,}  ({100*stats['edge_zero']/r:.1f}%)")
    print(f"  edge space >= 4 ft   {stats['edge_4plus']:,}  ({100*stats['edge_4plus']/r:.1f}%)")
    print(f"\n  -> {out_path}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="data/roadlog.geojson")
    ap.add_argument("--cache", default="data/.cache/roadlog",
                    help="page cache so an interrupted run resumes")
    ap.add_argument("--where", default="1=1")
    ap.add_argument("--limit", type=int, default=None,
                    help="stop after N rows (smoke test)")
    args = ap.parse_args()
    build(args.out, args.cache, args.limit, args.where)


if __name__ == "__main__":
    main()
