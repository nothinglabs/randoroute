#!/usr/bin/env python3
"""
Phase 1 build step: prepare data/blts.geojson from WSDOT's BikePedLTS export.

This is a BUILD-TIME step. The app makes no runtime calls to WSDOT — it renders
only from the static data/blts.geojson this script produces.

Source: WSDOT "Bicycle and Pedestrian Level of Traffic Stress (LTS)"
  https://data.wsdot.wa.gov/geospatial/DOT_ActiveTransportation/BikePedLTS.zip
  (File Geodatabase, EPSG:2927 / WA State Plane South, US survey feet)

Output: data/blts.geojson  (EPSG:4326, ~55k line features)

Requires: geopandas, pyogrio, pyproj, shapely  (pip install geopandas pyogrio)

Usage:
  python3 scripts/build_blts.py \
    --src data/BikePedLTS.gdb --out data/blts.geojson
"""
import argparse
import json
import math
import os

import geopandas as gpd

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


def build(src, out):
    gdf = gpd.read_file(src, layer=LAYER)
    print(f"read {len(gdf)} features from {src} ({gdf.crs})")
    gdf = gdf.to_crs(4326)
    print(f"reprojected -> {gdf.crs}")

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

        feats.append({"type": "Feature", "properties": props, "geometry": gj})

    fc = {"type": "FeatureCollection", "features": feats}
    with open(out, "w") as f:
        json.dump(fc, f, separators=(",", ":"))
    print(f"wrote {len(feats)} features -> {out} ({os.path.getsize(out):,} bytes)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="data/BikePedLTS.gdb")
    ap.add_argument("--out", default="data/blts.geojson")
    args = ap.parse_args()
    build(args.src, args.out)
