#!/usr/bin/env python3
"""Verify detailed offline land at two independent Puget Sound shorelines."""

import json
import math
import subprocess

from shapely.geometry import Point, shape

import shutil

# tippecanoe-decode is a build-time tool and is not present in every checkout
# (the cloud container has no tippecanoe at all). Exit 77 -- the runner reads
# that as SKIPPED, so a missing build tool never reads as a broken test.
if shutil.which("tippecanoe-decode") is None:
    print("SKIP: tippecanoe-decode is not installed")
    raise SystemExit(77)


def tile_for(lon, lat, zoom=13):
    scale = 2 ** zoom
    x = math.floor((lon + 180) / 360 * scale)
    y = math.floor(
        (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * scale
    )
    return zoom, x, y


def detailed_land_contains(archive, lon, lat):
    zoom, x, y = tile_for(lon, lat)
    decoded = subprocess.run(
        ["tippecanoe-decode", archive, str(zoom), str(x), str(y)],
        check=True,
        capture_output=True,
        text=True,
    )
    collection = json.loads(decoded.stdout)
    point = Point(lon, lat)
    features = [
        feature
        for layer in collection["features"]
        if layer.get("properties", {}).get("layer") == "land_detail"
        for feature in layer.get("features", [])
    ]
    return any(shape(feature["geometry"]).covers(point) for feature in features)


for name, lon, lat in (
    ("Langley", -122.447333, 48.001199),
    ("Kingston", -122.4982, 47.7986),
):
    assert detailed_land_contains("data/basemap.pmtiles", lon, lat), (
        f"{name} should be on detailed OSM coastline land"
    )

print("Detailed basemap coastline tests passed.")
