#!/usr/bin/env python3
"""
Nevada's agency adapter: NDOT's linear-referencing asset system -> the shared
builder vocabulary.

BUILD-TIME ONLY. Writes into maps/nevada/; the app never calls these services.

WHERE THIS DATA LIVES, because no keyword search finds it
---------------------------------------------------------
NDOT publishes almost everything the routing build wants from ONE service:

  https://gis.dot.nv.gov/rhgis/rest/services/EAMS/NDOT_ALRS/FeatureServer

83 layers, named for the asset rather than the subject -- `ShoulderOutside`,
`SpeedLimit`, `AADT`, `FSystem`, `OwnershipMaintenance`. It sits in a folder
called `EAMS` on a second server (`rhgis`, not the `arcgis` one that answers
gis.dot.nv.gov/arcgis/rest/services), and nothing in either name says "road".
This is the porting method's "search at layer depth, not service names" rule
paying for itself.

Two traps worth naming:

* **Every layer is time-sliced.** Rows carry FromDate/ToDate and the retired
  ones are still served. `ToDate IS NULL` is the current slice; without it the
  shoulder layer returns 4,390 rows of which 3,164 are history, and their
  values are the ones NDOT superseded.
* **"NDOT" is two states.** Nebraska's DOT uses the same abbreviation and its
  ArcGIS Online items rank highly for "NDOT shoulder width". Nevada's server
  is gis.dot.nv.gov; Nebraska's is gis.ne.gov.

WHAT IS CLAIMED, AND WHAT IS NOT
--------------------------------
* Shoulder width, but only where NDOT records a SURFACED shoulder (type 2/3/5)
  or explicitly records none (type 1 "None", type 7 "barrier curb: no shoulder
  in front of curb"). An 8 ft *gravel* shoulder is bail-out space, not riding
  space, and reporting it as a shoulder is lesson D1 wearing new clothes -- a
  proxy excusing a road. Types 4 and 6 are counted and reported here, and
  deliberately not emitted. See STATUS.md's known-backlog note.
* Posted speed, access control and lane count on the state system.
* Traffic counts: NDOT's own AADT event layer, which carries CountDate and
  CountStation -- measured counts, not the HPMS release.
* Functional class and roadway owner, statewide including local streets.
  NDOT's Ownership domain is already the FHWA code set (1 state, 2 county,
  3 town, 4 city), so it passes through untranslated.

Outputs (all under maps/nevada/):
  blts.geojson        the normalized roadway-inventory stream both shared
                      builders read as --blts. Nevada publishes no bicycle
                      stress rating, so LTS_Bicycle is 0 on every record and
                      the file carries shoulder/speed/lanes/access only.
  ndot_speed.geojson  --legal-speeds for build_graph.py
  funcclass.geojson   --funcclass: FHWA class + owner
  aadt.geojson        --aadt: NDOT's measured counts

Usage:
  python3 maps/nevada/tools/build_ndot.py
"""
import argparse
import json
import os
import sys
from collections import defaultdict

from shapely.geometry import LineString
from shapely.ops import substring

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                '..', '..', '..', 'scripts'))
import arcgis  # noqa: E402

ALRS = ("https://gis.dot.nv.gov/rhgis/rest/services/EAMS/NDOT_ALRS/"
        "FeatureServer")
CURRENT = "ToDate IS NULL"

# NDOT's ShoulderOutsideType domain. Only a surfaced shoulder is riding space.
SURFACED_SHOULDER = {"2", "3", "5"}     # bituminous, PCC, combination
NO_SHOULDER = {"1", "7"}                # none; barrier curb with none in front
UNSURFACED_SHOULDER = {"4", "6"}        # gravel/granular, earth -- see above

# StatewideRoutes.SystemType. 01 Interstate is the only one that is
# categorically limited-access; everything else is decided by AccessControl.
SYSTEM_INTERSTATE = "01"


def fetch(layer_id, fields, cache_dir, label, where=CURRENT):
    """Every current row of one ALRS event layer, with its geometry."""
    out = []
    url = f"{ALRS}/{layer_id}"
    for f in arcgis.fetch_all(url, fields, where=where, cache_dir=cache_dir,
                              label=label):
        a = f.get("attributes") or {}
        out.append((a, arcgis.paths_of(f.get("geometry"))))
    return out


def spans(rows, value_keys):
    """Group rows into {RouteID: [(from, to, {values}, paths)]} sorted by from."""
    by_route = defaultdict(list)
    for a, paths in rows:
        route = arcgis.text(a.get("RouteID"))
        lo = arcgis.num(a.get("FromMeasure"))
        hi = arcgis.num(a.get("ToMeasure"))
        if not route or lo is None or hi is None:
            continue
        lo, hi = min(lo, hi), max(lo, hi)
        if hi - lo < 1e-9:
            continue
        by_route[route].append((lo, hi, {k: a.get(k) for k in value_keys},
                                paths))
    for route in by_route:
        by_route[route].sort(key=lambda r: r[0])
    return by_route


def value_at(route_spans, route, lo, hi):
    """The values of the span covering the midpoint of [lo, hi], or None.

    A milepost join on one agency's own linear reference is exact: there is no
    geometric tolerance to get wrong, which is the whole reason to do the join
    here rather than leave four layers for roadmeasure.py to conflate
    separately onto OSM.
    """
    mid = (lo + hi) / 2.0
    for a, b, values, _ in route_spans.get(route, ()):
        if a <= mid <= b:
            return values
    return None


def slice_geometry(paths, lo, hi, sub_lo, sub_hi):
    """The part of a span's polyline between two mileposts along it.

    The span's own geometry runs from milepost `lo` to `hi`, so the atomic
    interval [sub_lo, sub_hi] is the same fractional slice of the line. Only
    valid because both come from the same route event.
    """
    if hi - lo < 1e-9:
        return []
    f0 = max(0.0, (sub_lo - lo) / (hi - lo))
    f1 = min(1.0, (sub_hi - lo) / (hi - lo))
    if f1 - f0 < 1e-6:
        return []
    out = []
    for ring in paths:
        if len(ring) < 2:
            continue
        line = LineString(ring)
        if line.length == 0:
            continue
        piece = substring(line, f0, f1, normalized=True)
        coords = [[round(x, 5), round(y, 5)] for x, y in piece.coords]
        dedup = [coords[0]] if coords else []
        for pt in coords[1:]:
            if pt != dedup[-1]:
                dedup.append(pt)
        if len(dedup) >= 2:
            out.append(dedup)
    return out


def write_fc(path, features, label):
    with open(path, "w") as fh:
        json.dump({"type": "FeatureCollection", "features": features}, fh)
    print(f"  wrote {path}: {len(features):,} features ({label})", flush=True)


def build(out_dir, cache_dir):
    os.makedirs(out_dir, exist_ok=True)

    routes = {}
    for a, _ in fetch(27, ["OBJECTID", "RouteID", "RouteNameFull",
                           "SystemType"], cache_dir, "NDOT statewide routes"):
        rid = arcgis.text(a.get("RouteID"))
        if rid:
            routes[rid] = (arcgis.text(a.get("RouteNameFull")),
                           arcgis.text(a.get("SystemType")))

    shoulder_rows = fetch(16, ["OBJECTID", "RouteID", "FromMeasure",
                               "ToMeasure", "ShoulderOutsideType",
                               "ShoulderOutsideWidth"],
                          cache_dir, "NDOT outside shoulder")
    speed_rows = fetch(42, ["OBJECTID", "RouteID", "FromMeasure", "ToMeasure",
                            "SpeedLimit"], cache_dir, "NDOT posted speed")
    access_rows = fetch(54, ["OBJECTID", "RouteID", "FromMeasure", "ToMeasure",
                             "AccessControl"], cache_dir, "NDOT access control")
    lane_rows = fetch(11, ["OBJECTID", "RouteID", "FromMeasure", "ToMeasure",
                           "ThroughLanes"], cache_dir, "NDOT through lanes")

    shoulder = spans(shoulder_rows, ("ShoulderOutsideType",
                                     "ShoulderOutsideWidth"))
    speed = spans(speed_rows, ("SpeedLimit",))
    access = spans(access_rows, ("AccessControl",))
    lanes = spans(lane_rows, ("ThroughLanes",))

    # ---- the normalized roadway-inventory stream (--blts on both builders)
    #
    # Four layers with independent milepost boundaries become one set of atomic
    # intervals per route: every breakpoint from any layer cuts every layer.
    # Without this a shoulder record that a speed record only half covers would
    # have to pick one value for the whole span.
    unsurfaced = 0
    surfaced = 0
    explicit_zero = 0
    features = []
    all_routes = set(shoulder) | set(speed) | set(access) | set(lanes)
    for route in sorted(all_routes):
        name, system = routes.get(route, (None, None))
        cuts = set()
        for table in (shoulder, speed, access, lanes):
            for lo, hi, _, _ in table.get(route, ()):
                cuts.add(round(lo, 6))
                cuts.add(round(hi, 6))
        edges = sorted(cuts)
        for lo, hi in zip(edges, edges[1:]):
            if hi - lo < 1e-6:
                continue
            sh = value_at(shoulder, route, lo, hi)
            sp = value_at(speed, route, lo, hi)
            ac = value_at(access, route, lo, hi)
            ln = value_at(lanes, route, lo, hi)
            if sh is None and sp is None and ac is None and ln is None:
                continue

            props = {"RouteIdentifier": name or route,
                     "NdotRouteId": route,
                     # Nevada publishes no bicycle level-of-traffic-stress
                     # rating. 0 is the shared "no rating" value; it is not a
                     # good score, and nothing downstream may invent one.
                     "LTS_Bicycle": 0}

            if sh is not None:
                code = arcgis.text(sh.get("ShoulderOutsideType"))
                width = arcgis.num(sh.get("ShoulderOutsideWidth"))
                if code in NO_SHOULDER:
                    props["ShoulderWidth"] = 0
                    explicit_zero += 1
                elif code in SURFACED_SHOULDER and width is not None and width >= 0:
                    props["ShoulderWidth"] = int(round(width))
                    surfaced += 1
                elif code in UNSURFACED_SHOULDER:
                    unsurfaced += 1
                    props["ShoulderSurface"] = code
            if sp is not None:
                limit = arcgis.num(sp.get("SpeedLimit"))
                if limit and 5 <= limit <= 85:
                    props["SpeedLimit"] = int(limit)
            if ln is not None:
                count = arcgis.num(ln.get("ThroughLanes"))
                if count and 1 <= count <= 12:
                    props["LaneCount"] = int(count)
            limited = system == SYSTEM_INTERSTATE
            if ac is not None and arcgis.text(ac.get("AccessControl")) == "1":
                limited = True
            props["LimitedAccess"] = 1 if limited else 0
            # Nevada publishes no permanent bicycle-prohibition inventory; the
            # OSM tag is the only prohibition signal. Declared, not omitted, so
            # a reader can tell "none published" from "forgot to fetch".
            props["Prohibited"] = 0

            geom = None
            for table in (shoulder, speed, access, lanes):
                for a, b, _, paths in table.get(route, ()):
                    if a <= (lo + hi) / 2 <= b:
                        geom = slice_geometry(paths, a, b, lo, hi)
                        break
                if geom:
                    break
            for ring in geom or ():
                features.append({
                    "type": "Feature",
                    "properties": props,
                    "geometry": {"type": "LineString", "coordinates": ring},
                })
    write_fc(os.path.join(out_dir, "blts.geojson"), features,
             "NDOT roadway inventory")
    print(f"    shoulder: {surfaced:,} surfaced, {explicit_zero:,} explicit "
          f"zero, {unsurfaced:,} gravel/earth spans withheld", flush=True)

    # ---- the dedicated speed layer (--legal-speeds on build_graph.py)
    speed_features = []
    for a, paths in speed_rows:
        limit = arcgis.num(a.get("SpeedLimit"))
        if not limit or not 5 <= limit <= 85:
            continue
        route = arcgis.text(a.get("RouteID"))
        name = routes.get(route, (None, None))[0]
        for ring in paths:
            speed_features.append({
                "type": "Feature",
                "properties": {"RouteIdentifier": name or route,
                               "SpeedLimit": int(limit)},
                "geometry": {"type": "LineString", "coordinates": ring},
            })
    write_fc(os.path.join(out_dir, "ndot_speed.geojson"), speed_features,
             "NDOT posted speed")

    # ---- functional class + owner (--funcclass)
    #
    # Two ALRS layers, joined on the route reference they share rather than
    # geometrically: FSystem carries the FHWA class, OwnershipMaintenance the
    # owner, and both are events on the same statewide route system.
    fsys_rows = fetch(65, ["OBJECTID", "RouteID", "FromMeasure", "ToMeasure",
                           "FSystem"], cache_dir, "NDOT functional class")
    own_rows = fetch(48, ["OBJECTID", "RouteID", "FromMeasure", "ToMeasure",
                          "Ownership"], cache_dir, "NDOT ownership")
    owner_spans = spans(own_rows, ("Ownership",))
    fc_features = []
    owned = 0
    for a, paths in fsys_rows:
        code = arcgis.text(a.get("FSystem"))
        if code not in {"1", "2", "3", "4", "5", "6", "7"}:
            continue
        route = arcgis.text(a.get("RouteID"))
        lo = arcgis.num(a.get("FromMeasure"))
        hi = arcgis.num(a.get("ToMeasure"))
        if route is None or lo is None or hi is None:
            continue
        props = {"fc": int(code)}
        own = value_at(owner_spans, route, min(lo, hi), max(lo, hi))
        if own is not None:
            owner = arcgis.num(own.get("Ownership"))
            # NDOT's Ownership domain is the FHWA code set already. Only the
            # four codes the shared model understands are passed through; a
            # railroad or an airport is not a roadway owner it can price.
            if owner and int(owner) in (1, 2, 3, 4):
                props["owner"] = int(owner)
                owned += 1
        for ring in paths:
            fc_features.append({
                "type": "Feature",
                "properties": props,
                "geometry": {"type": "LineString", "coordinates": ring},
            })
    write_fc(os.path.join(out_dir, "funcclass.geojson"), fc_features,
             f"NDOT functional class; {owned:,} with an owner code")

    # ---- measured traffic counts (--aadt)
    aadt_rows = fetch(50, ["OBJECTID", "RouteID", "FromMeasure", "ToMeasure",
                           "AADT", "CountDate", "CountStation",
                           "CountSourceType"], cache_dir, "NDOT AADT")
    aadt_features = []
    years = defaultdict(int)
    for a, paths in aadt_rows:
        volume = arcgis.num(a.get("AADT"))
        if not volume or volume <= 0:
            continue
        # CountDate is epoch milliseconds. The year travels with the number
        # because the road card prints it, and a count with no year must never
        # displace a dated one (lesson A5).
        stamp = arcgis.num(a.get("CountDate"))
        year = None
        if stamp:
            import datetime
            year = datetime.datetime.utcfromtimestamp(stamp / 1000.0).year
            if not 1930 <= year <= 2035:
                year = None
        years[year] += 1
        props = {"adt": int(volume), "adty": year}
        station = arcgis.text(a.get("CountStation"))
        if station:
            props["station"] = station
        for ring in paths:
            aadt_features.append({
                "type": "Feature",
                "properties": props,
                "geometry": {"type": "LineString", "coordinates": ring},
            })
    write_fc(os.path.join(out_dir, "aadt.geojson"), aadt_features,
             "NDOT measured traffic counts")
    print("    count years: " + ", ".join(
        f"{y}={n:,}" for y, n in sorted(years.items(),
                                        key=lambda kv: (kv[0] is None, kv[0]))),
          flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out-dir", default="maps/nevada")
    ap.add_argument("--cache", default="data/.cache/nevada-ndot")
    args = ap.parse_args()
    build(args.out_dir, args.cache)
