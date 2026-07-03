#!/usr/bin/env python3
"""
Build step: prepare data/bike_restrictions.geojson from WSDOT's Permanent
Bike Restrictions export — the specific state-highway segments where bicycles
are prohibited by official State Traffic Engineer calendar action.

Source: https://data.wsdot.wa.gov/geospatial/DOT_ActiveTransportation/PermanentBikeRestrictions.zip
        (File Geodatabase, EPSG:2927)
Output: data/bike_restrictions.geojson (EPSG:4326, ~81 line features, tiny)

Also used by build_blts.py (--restrictions) to flag overlapping BLTS segments
as Prohibited via RouteIdentifier + accumulated-route-mile overlap.
"""
import argparse
import json
import math
import os

import geopandas as gpd

LAYER = 'PermanentBikeRestrictions'
COORD_DECIMALS = 5


def build(src, out):
    g = gpd.read_file(src, layer=LAYER)
    print(f'read {len(g)} restrictions ({g.crs})')
    g = g.to_crs(4326)

    feats = []
    for geom, row in zip(g.geometry.values, g.itertuples(index=False)):
        if geom is None or geom.is_empty:
            continue
        if geom.geom_type == 'MultiLineString':
            lines = [list(l.coords) for l in geom.geoms]
        else:
            lines = [list(geom.coords)]
        rc = lambda cs: [[round(x, COORD_DECIMALS), round(y, COORD_DECIMALS)] for x, y in cs]
        gj = ({'type': 'LineString', 'coordinates': rc(lines[0])} if len(lines) == 1
              else {'type': 'MultiLineString', 'coordinates': [rc(l) for l in lines]})
        p = {}
        def put(k, v):
            if v is not None and v == v and str(v).strip():
                p[k] = v
        put('Route', str(row.StateRouteNumber).strip())
        put('RouteIdentifier', str(row.RouteIdentifier).strip())
        put('Direction', str(row.RestrictionCardinalDirection).strip())
        put('Comment', str(row.Comment).strip() if row.Comment else None)
        b, e = row.BeginAccumulatedRouteMile, row.EndAccumulatedRouteMile
        if b is not None and not (isinstance(b, float) and math.isnan(b)):
            p['BeginMile'] = round(float(b), 2)
        if e is not None and not (isinstance(e, float) and math.isnan(e)):
            p['EndMile'] = round(float(e), 2)
        feats.append({'type': 'Feature', 'properties': p, 'geometry': gj})

    fc = {'type': 'FeatureCollection', 'features': feats}
    with open(out, 'w') as f:
        json.dump(fc, f, separators=(',', ':'))
    print(f'wrote {len(feats)} -> {out} ({os.path.getsize(out):,} bytes)')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default='data/permbike/PermanentBikeRestrictions.gdb')
    ap.add_argument('--out', default='data/bike_restrictions.geojson')
    args = ap.parse_args()
    build(args.src, args.out)
