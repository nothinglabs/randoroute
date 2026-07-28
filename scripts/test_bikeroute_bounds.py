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
app = (root / 'app.js').read_text(encoding='utf-8')
assert f'ROUTE_BOUNDS = {ROUTE_BOUNDS!r}' in builder
assert "src.ribbon ? 'round'" not in app
assert "'line-cap': 'butt'" in app
assert 'zRank: 2.5' in app
# The designation ribbon is a duller relative of the bike-network lime, about a
# quarter wider than it used to be: family with real infrastructure, without
# claiming to be it.
assert "const DESIGNATED_COLOR = '#6f9400'" in app
assert "map.setPaintProperty(src.id, 'line-color', DESIGNATED_COLOR)" in app
assert "6, ['match', ['get', 't'], 'ncn', 5.4, 3.5]" in app
assert "10, ['match', ['get', 't'], 'ncn', 10.5, 6.5]" in app
assert "14, ['match', ['get', 't'], 'ncn', 18, 11.3]" in app
assert "map.setPaintProperty(src.id, 'line-opacity', backgroundLineOpacity(0.4))" in app
with gzip.open(root / 'data/bikeroutes.geojson.gz', 'rt', encoding='utf-8') as handle:
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
