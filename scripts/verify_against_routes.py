#!/usr/bin/env python3
"""Score what scripts/verify_against_routes.mjs dumped: how much of each option
the router offered actually runs along the published corridor.

The measure is deliberately simple and stated in the report rather than tuned:
the fraction of an option's length whose midpoint lies within TOLERANCE_M of the
published route line. 60 m is wide enough for the offset between a relation's
member ways and the graph edges under them, and for a one-block parallel street,
and narrow enough that a different road through the same valley does not count.

  python3 scripts/verify_against_routes.py < dump.json
"""
import json
import sys

import shapely
from shapely.geometry import LineString
from shapely.strtree import STRtree

TOLERANCE_M = 60.0
MI = 1609.344


def metres(a, b):
    import math
    dx = (b[0] - a[0]) * math.cos(math.radians((a[1] + b[1]) / 2)) * 111_320.0
    dy = (b[1] - a[1]) * 110_540.0
    return math.hypot(dx, dy)


def overlap_fraction(coords, corridor_tree, tol_deg):
    """Metres of `coords` running within tolerance of the corridor, and total."""
    if len(coords) < 2:
        return 0.0, 0.0
    mids, lengths = [], []
    for a, b in zip(coords, coords[1:]):
        mids.append(((a[0] + b[0]) / 2, (a[1] + b[1]) / 2))
        lengths.append(metres(a, b))
    points = shapely.points(mids)
    hit_idx, _ = corridor_tree.query(points, predicate="dwithin", distance=tol_deg)
    on = set(int(i) for i in hit_idx)
    matched = sum(length for i, length in enumerate(lengths) if i in on)
    return matched, sum(lengths)


def main():
    records = json.load(sys.stdin)
    rows = []
    for rec in records:
        lines = [LineString(c) for c in rec["corridor"] if len(c) >= 2]
        if not lines:
            continue
        # A metre in degrees varies with latitude; take it at the corridor's own.
        lat = lines[0].coords[0][1]
        import math
        tol_deg = TOLERANCE_M / (111_320.0 * math.cos(math.radians(lat)))
        tree = STRtree(lines)
        best = None
        shortest = None
        for option in rec["options"]:
            matched, total = overlap_fraction(option["coords"], tree, tol_deg)
            share = matched / total if total else 0.0
            entry = {**{k: v for k, v in option.items() if k != "coords"},
                     "onCorridorM": round(matched), "totalM": round(total),
                     "share": share}
            if best is None or share > best["share"]:
                best = entry
            if shortest is None or entry["distM"] < shortest["distM"]:
                shortest = entry
        rows.append({
            "name": rec["name"],
            "ok": rec["ok"],
            "publishedMi": rec["publishedM"] / MI,
            "spanMi": rec["spanM"] / MI,
            "options": len(rec["options"]),
            "best": best,
            "shortest": shortest,
        })

    rows.sort(key=lambda r: -(r["best"]["share"] if r["best"] else 0))
    print(f"{'route':46} {'pub mi':>7} {'best mi':>8} {'on corr':>8} "
          f"{'short mi':>9} {'on corr':>8}  {'fail mi':>7}")
    for r in rows:
        if not r["best"]:
            print(f"{r['name'][:46]:46} {r['publishedMi']:7.1f}   NO ROUTE")
            continue
        b, s = r["best"], r["shortest"]
        print(f"{r['name'][:46]:46} {r['publishedMi']:7.1f} "
              f"{b['distM'] / MI:8.1f} {b['share'] * 100:7.0f}% "
              f"{s['distM'] / MI:9.1f} {s['share'] * 100:7.0f}% "
              f"{b['failM'] / MI:7.2f}")
    json.dump(rows, open("data/_verify_scored.json", "w"), indent=1)
    print(f"\n{len(rows)} corridors scored -> data/_verify_scored.json")


if __name__ == "__main__":
    main()
