#!/usr/bin/env python3
"""
Phase 1 build step: prepare maps/washington/blts.geojson from WSDOT's BikePedLTS export.

This is a BUILD-TIME step. The app makes no runtime calls to WSDOT — it renders
only from the static maps/washington/blts.geojson this script produces.

Source: WSDOT "Bicycle and Pedestrian Level of Traffic Stress (LTS)"
  https://data.wsdot.wa.gov/geospatial/DOT_ActiveTransportation/BikePedLTS.zip
  (File Geodatabase, EPSG:2927 / WA State Plane South, US survey feet)

Output: maps/washington/blts.geojson  (EPSG:4326, ~55k line features)

Requires: geopandas, pyogrio, pyproj, shapely  (pip install geopandas pyogrio)

Usage:
  python3 scripts/build_blts.py \
    --src data/BikePedLTS.gdb --out maps/washington/blts.geojson

  # Add/rebuild Census urban context without needing the raw WSDOT export.
  python3 scripts/build_blts.py --enrich-existing --out maps/washington/blts.geojson
"""
import argparse
import json
import math
import os

# AccessControlTypeCode values that mean limited-access (freeway/expressway).
LIMITED_ACCESS_CODES = {"F", "M", "P"}
LAYER = "BikePedLevelOfTrafficStress"
COORD_DECIMALS = 5  # ~1.1 m at WA latitudes; plenty for statewide rendering


def _num(v):
    if v is None:
        return None
    try:
        f = float(v)
        return None if math.isnan(f) else f
    except (TypeError, ValueError):
        return None


def _str(v):
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def load_restrictions(path):
    """RouteIdentifier -> [(begin_arm, end_arm)] from WSDOT PermanentBikeRestrictions."""
    r = gpd.read_file(path, layer="PermanentBikeRestrictions")
    by_route = {}
    for row in r.itertuples(index=False):
        rid = _str(row.RouteIdentifier)
        b, e = _num(row.BeginAccumulatedRouteMile), _num(row.EndAccumulatedRouteMile)
        if rid is None or b is None or e is None:
            continue
        by_route.setdefault(rid, []).append((min(b, e), max(b, e)))
    print(f"restrictions: {sum(len(v) for v in by_route.values())} spans on {len(by_route)} routes")
    return by_route


def load_routes_index(path):
    """STRtree over designated bike-route lines (maps/washington/bikeroutes.geojson)."""
    from shapely import STRtree
    from shapely.geometry import LineString

    fc = json.load(open(path))
    geoms = []
    for f in fc["features"]:
        g = f["geometry"]
        lines = g["coordinates"] if g["type"] == "MultiLineString" else [g["coordinates"]]
        for cs in lines:
            if len(cs) >= 2:
                geoms.append(LineString(cs))
    print(f"designated routes: {len(geoms)} line members")
    return STRtree(geoms), geoms


ROUTE_MATCH_DEG = 0.0003  # ~25-30 m: highway centerline vs route line offset


def load_urban_index(path):
    """Load build-only Census urban polygons for the WSDOT display overlay."""
    from shapely.geometry import shape
    from shapely.strtree import STRtree

    fc = json.load(open(path))
    geoms = [shape(feature['geometry']) for feature in fc.get('features', [])
             if feature.get('geometry')]
    if not geoms:
        raise ValueError(f'no usable Census urban areas in {path}')
    print(f'urban context: {len(geoms):,} Census polygons')
    return STRtree(geoms), geoms


def is_urban_geometry(geom, index):
    """Classify a line by its midpoint, matching the graph builder policy."""
    if index is None or geom is None or geom.is_empty:
        return False
    midpoint = geom.interpolate(0.5, normalized=True)
    tree, geoms = index
    return any(geoms[int(candidate)].covers(midpoint) for candidate in tree.query(midpoint))


def enrich_existing(out, urban_areas):
    """Add Urban=1 to an existing WSDOT GeoJSON after Census data changes."""
    from shapely.geometry import shape

    urban_index = load_urban_index(urban_areas)
    fc = json.load(open(out))
    urban_count = 0
    for feature in fc.get('features', []):
        props = feature.setdefault('properties', {})
        if is_urban_geometry(shape(feature['geometry']), urban_index):
            props['Urban'] = 1
            urban_count += 1
        else:
            props.pop('Urban', None)
    with open(out, 'w') as fh:
        json.dump(fc, fh, separators=(',', ':'))
    print(f'added Urban=1 to {urban_count:,} of {len(fc.get("features", [])):,} WSDOT segments -> {out}')


def build(src, out, restrictions=None, routes=None, urban_areas=None):
    import geopandas as gpd
    from shapely.geometry import Point

    gdf = gpd.read_file(src, layer=LAYER)
    print(f"read {len(gdf)} features from {src} ({gdf.crs})")
    gdf = gdf.to_crs(4326)
    print(f"reprojected -> {gdf.crs}")
    restr = load_restrictions(restrictions) if restrictions else {}
    rtree = load_routes_index(routes) if routes else None
    urban_index = load_urban_index(urban_areas) if urban_areas else None
    prohibited_count = designated_count = urban_count = 0

    feats = []
    for geom, row in zip(gdf.geometry.values, gdf.itertuples(index=False)):
        if geom is None or geom.is_empty:
            continue
        if geom.geom_type == "MultiLineString":
            lines = [list(g.coords) for g in geom.geoms]
        elif geom.geom_type == "LineString":
            lines = [list(geom.coords)]
        else:
            continue

        def rc(coords):
            return [[round(x, COORD_DECIMALS), round(y, COORD_DECIMALS)] for x, y in coords]

        if len(lines) == 1:
            gj = {"type": "LineString", "coordinates": rc(lines[0])}
        else:
            gj = {"type": "MultiLineString", "coordinates": [rc(l) for l in lines]}

        props = {}

        def put(k, v):
            if v is not None and v != "":
                props[k] = v

        # LTS_Bicycle: 1-4 authoritative rating; 999 or NaN = WSDOT no-data sentinel.
        lts = _num(row.LTS_Bicycle)
        lts = int(lts) if (lts is not None and int(lts) != 999) else None
        put("LTS_Bicycle", lts)

        put("SpeedLimit", int(_num(row.SpeedLimit)) if _num(row.SpeedLimit) not in (None, 0) else None)
        put("LaneCount", int(_num(row.LaneCount)) if _num(row.LaneCount) not in (None, 0) else None)
        put("AADT", int(_num(row.AADT)) if _num(row.AADT) not in (None, 0) else None)
        put("ShoulderWidth", int(_num(row.ShoulderWidth)) if _num(row.ShoulderWidth) is not None else None)
        put("BikeFacilityType", _str(row.BikeFacilityType))
        put("BikeFacilityWidth", round(_num(row.BikeFacilityWidth), 1) if _num(row.BikeFacilityWidth) else None)
        put("RouteIdentifier", _str(row.RouteIdentifier))
        if _str(row.AccessControlTypeCode) in LIMITED_ACCESS_CODES:
            props["LimitedAccess"] = 1
        # Bikes-prohibited flag: this segment's ARM range overlaps a WSDOT
        # permanent bike restriction on the same route (mainline match only).
        rid = _str(row.RouteIdentifier)
        if rid in restr:
            b, e = _num(row.BeginARM), _num(row.EndARM)
            if b is not None and e is not None:
                lo, hi = min(b, e), max(b, e)
                if any(lo < re_ and hi > rb for rb, re_ in restr[rid]):
                    props["Prohibited"] = 1
                    prohibited_count += 1

        # Designated bike route: 2 of 3 sample points along the segment lie on
        # a designated route line (2-of-3 so a mere crossing doesn't count).
        if rtree is not None:
            tree, rgeoms = rtree
            allc = [c for l in lines for c in l]
            samples = [allc[len(allc) // 4], allc[len(allc) // 2], allc[(3 * len(allc)) // 4]]
            hits = 0
            for sx, sy in samples:
                pt = Point(sx, sy)
                if any(rgeoms[gi].distance(pt) < ROUTE_MATCH_DEG
                       for gi in tree.query(pt.buffer(ROUTE_MATCH_DEG))):
                    hits += 1
            if hits >= 2:
                props["Designated"] = 1
                designated_count += 1

        if is_urban_geometry(geom, urban_index):
            props['Urban'] = 1
            urban_count += 1

        feats.append({"type": "Feature", "properties": props, "geometry": gj})

    fc = {"type": "FeatureCollection", "features": feats}
    with open(out, "w") as f:
        json.dump(fc, f, separators=(",", ":"))
    print(f"wrote {len(feats)} features -> {out} ({os.path.getsize(out):,} bytes)")
    if restrictions:
        print(f"flagged Prohibited on {prohibited_count} segments")
    if routes:
        print(f"flagged Designated on {designated_count} segments")
    if urban_areas:
        print(f"flagged Urban on {urban_count} segments")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="data/BikePedLTS.gdb")
    ap.add_argument("--out", default="maps/washington/blts.geojson")
    ap.add_argument("--restrictions", default=None,
                    help="path to PermanentBikeRestrictions.gdb to flag prohibited segments")
    ap.add_argument("--routes", default=None,
                    help="path to bikeroutes.geojson to flag designated-route segments")
    ap.add_argument('--urban-areas', default='data/census-urban-areas-2020-washington.geojson',
                    help='Census 2020 urban-area GeoJSON (EPSG:4326, build-only)')
    ap.add_argument('--enrich-existing', action='store_true',
                    help='add Urban=1 context to --out without reading the raw WSDOT export')
    args = ap.parse_args()
    if args.enrich_existing:
        enrich_existing(args.out, args.urban_areas)
    else:
        build(args.src, args.out, args.restrictions, args.routes, args.urban_areas)
