#!/usr/bin/env python3
"""Verify shipped bicycle-route overlays stay inside app coverage."""
import ast
import gzip
import json
import re
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

# This file used to carry twelve assertions matching the TEXT of app.js -- the
# ribbon's hex colour, the exact setPaintProperty call strings, three zoom-stop
# expressions written out character for character. They pinned formatting rather
# than behaviour: the colour assertion broke the moment the ribbon was darkened,
# a deliberate change it had no business failing, and none of them would have
# noticed the ribbon failing to draw at all. Deleted. What follows checks the
# shipped data, which is what this test is actually for.
#
# The one cross-file fact worth keeping is that the bounds checked here are the
# bounds the builder used. That is READ from the builder and compared as a
# value, never matched as source text, so reformatting build_routes.py cannot
# fail it.
builder = (root / 'scripts/build_routes.py').read_text(encoding='utf-8')
match = re.search(r'^ROUTE_BOUNDS\s*=\s*(\([^)]*\))', builder, re.M)
assert match, 'build_routes.py should define ROUTE_BOUNDS'
builder_bounds = ast.literal_eval(match.group(1))
assert builder_bounds == ROUTE_BOUNDS, (
    'the builder clips to different bounds than this test verifies',
    builder_bounds, ROUTE_BOUNDS)

with gzip.open(root / 'maps/washington/bikeroutes.geojson.gz', 'rt', encoding='utf-8') as handle:
    routes = json.load(handle)

west, south, east, north = ROUTE_BOUNDS
points = 0
line_keys = set()
for feature in routes['features']:
    geometry = feature.get('geometry', {})
    lines = geometry.get('coordinates', [])
    if geometry.get('type') == 'LineString':
        lines = [lines]
    for line in lines:
        forward = tuple(tuple(point) for point in line)
        reverse = tuple(reversed(forward))
        key = min(forward, reverse)
        assert key not in line_keys, (
            'duplicate translucent route geometry would compound opacity',
            feature['properties'])
        line_keys.add(key)
    for longitude, latitude, *_ in coordinates(lines):
        points += 1
        assert west <= longitude <= east, (feature['properties'], longitude, latitude)
        assert south <= latitude <= north, (feature['properties'], longitude, latitude)

assert points > 0
assert routes.get('routeCount', 0) > 0
print(f'Bicycle-route bounds and {len(line_keys):,} unique corridors verified '
      f'across {routes["routeCount"]:,} route relations and {points:,} coordinates.')
