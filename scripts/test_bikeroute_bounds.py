#!/usr/bin/env python3
"""Verify shipped bicycle-route overlays stay inside app coverage."""
import gzip
import json
from pathlib import Path

ROUTE_BOUNDS = (-125.5, 45.2, -116.7, 50.0)


def coordinates(value):
    if isinstance(value, list) and len(value) >= 2 and all(
            isinstance(part, (int, float)) for part in value[:2]):
        yield value
    elif isinstance(value, list):
        for child in value:
            yield from coordinates(child)


root = Path(__file__).resolve().parent.parent
builder = (root / 'scripts/build_routes.py').read_text(encoding='utf-8')
assert f'ROUTE_BOUNDS = {ROUTE_BOUNDS!r}' in builder
with gzip.open(root / 'data/bikeroutes.geojson.gz', 'rt', encoding='utf-8') as handle:
    routes = json.load(handle)

west, south, east, north = ROUTE_BOUNDS
points = 0
for feature in routes['features']:
    for longitude, latitude, *_ in coordinates(feature.get('geometry', {}).get('coordinates', [])):
        points += 1
        assert west <= longitude <= east, (feature['properties'], longitude, latitude)
        assert south <= latitude <= north, (feature['properties'], longitude, latitude)

assert points > 0
print(f'Bicycle-route bounds verified for {points:,} coordinates.')
