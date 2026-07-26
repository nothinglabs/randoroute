#!/usr/bin/env python3
"""Regression checks for the direction-aware SR-525 map rendering."""

import json
import math
import subprocess
import sys
from pathlib import Path

from shapely.geometry import Point, shape


ROOT = Path(__file__).resolve().parents[1]
ROADS = ROOT / "data" / "roads.pmtiles"
REPRO_LON = -122.447333
REPRO_LAT = 48.001199


def tile_for(lon, lat, zoom):
    scale = 2**zoom
    x = int((lon + 180) / 360 * scale)
    y = int(
        (1 - math.asinh(math.tan(math.radians(lat))) / math.pi)
        / 2
        * scale
    )
    return x, y


def main():
    roads = Path(sys.argv[1]) if len(sys.argv) > 1 else ROADS
    zoom = 13
    x, y = tile_for(REPRO_LON, REPRO_LAT, zoom)
    decoded = subprocess.run(
        ["tippecanoe-decode", str(roads), str(zoom), str(x), str(y)],
        check=True,
        capture_output=True,
        text=True,
    )
    tile = json.loads(decoded.stdout)
    features = [
        feature
        for layer in tile.get("features", [])
        for feature in layer.get("features", [])
        if feature.get("properties", {}).get("n") == "State Route 525"
    ]
    point = Point(REPRO_LON, REPRO_LAT)
    nearby = sorted(
        (
            (shape(feature["geometry"]).distance(point), feature)
            for feature in features
        ),
        key=lambda item: item[0],
    )
    if not nearby or nearby[0][0] > 0.00015:
        raise AssertionError("no SR-525 road tile geometry near the repro point")

    closest_distance, closest = nearby[0]
    props = closest["properties"]
    assert props.get("d") == 1, "SR-525 should be WSDOT-enriched on OSM geometry"
    assert props.get("s") == 55, "map display should retain the 55 mph limit"
    assert props.get("w") == 0, (
        "passive map display should conservatively show the narrower direction"
    )

    overlapping = [
        feature
        for distance, feature in nearby
        if distance <= max(closest_distance + 0.00001, 0.00004)
    ]
    assert len(overlapping) == 1, (
        "SR-525 should render as one OSM-centered physical road, not overlapping "
        "increasing/decreasing WSDOT lines"
    )
    print("Directional road tile tests passed.")


if __name__ == "__main__":
    main()
