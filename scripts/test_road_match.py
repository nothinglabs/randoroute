#!/usr/bin/env python3
"""
Guards on the conflation rule in scripts/roadmeasure.py.

Two failure modes, pulling in opposite directions, and the rule has to survive
both:

  TOO LOOSE  A source line that merely crosses or runs beside a way claims it.
             A county import once matched by nearest midpoint and turned 33.5
             miles of source into 72 miles of "matched" graph.

  TOO TIGHT  A source segment shorter than the graph edge is rejected even
             though it is lying directly on it. Requiring every sample point to
             fall on ONE segment did exactly this, discarding 4.13 of Pioneer
             Way East's 5.83 miles whose nearest road-log line was touching the
             edge at zero distance.

Geometry here is synthetic so the test does not depend on a fetched extract.

Usage: python3 scripts/test_road_match.py
"""
import json
import math
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from roadmeasure import MATCH_M, MeasureIndex  # noqa: E402

LAT = 47.6
DEG_PER_M_LAT = 1.0 / 110_540.0
DEG_PER_M_LON = 1.0 / (111_320.0 * math.cos(math.radians(LAT)))

failures = []


def check(name, got, want):
    ok = bool(got) == bool(want)
    print(f'  {"PASS" if ok else "FAIL"}  {name}')
    if not ok:
        failures.append(name)


def line(start_m, end_m, offset_m=0.0, bearing_deg=90.0):
    """A straight line from start_m to end_m along `bearing_deg`, shifted
    `offset_m` perpendicular to it. Metres, so tolerances mean what they say."""
    rad = math.radians(bearing_deg)
    dx, dy = math.sin(rad), math.cos(rad)
    nx, ny = -dy, dx
    pts = []
    for t in (start_m, (start_m + end_m) / 2, end_m):
        x_m = dx * t + nx * offset_m
        y_m = dy * t + ny * offset_m
        pts.append([-122.3 + x_m * DEG_PER_M_LON, LAT + y_m * DEG_PER_M_LAT])
    return pts


def index_of(*segments):
    fc = {'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'properties': {'adt': 1000 + i},
         'geometry': {'type': 'LineString', 'coordinates': cs}}
        for i, cs in enumerate(segments)]}
    fh = tempfile.NamedTemporaryFile('w', suffix='.geojson', delete=False)
    json.dump(fc, fh)
    fh.close()
    return MeasureIndex(fh.name, 'test'), fh.name


WAY = line(0, 1000)          # a 1 km way running due east

print('\nthe rule must not be too loose:')
idx, path = index_of(line(0, 1000, offset_m=0))
check('a source lying on the way matches', idx.match(WAY), True)
os.unlink(path)

for offset in (10, 17):
    idx, path = index_of(line(0, 1000, offset_m=offset))
    check(f'a source {offset} m to the side still matches (tolerance {MATCH_M:.0f} m)',
          idx.match(WAY), True)
    os.unlink(path)

for offset in (25, 40, 100):
    idx, path = index_of(line(0, 1000, offset_m=offset))
    check(f'a parallel road {offset} m away does NOT match', idx.match(WAY), False)
    os.unlink(path)

idx, path = index_of(line(-500, 500, bearing_deg=0))
check('a street crossing at 90 degrees does NOT match', idx.match(WAY), False)
os.unlink(path)

idx, path = index_of(line(-500, 500, bearing_deg=45))
check('a road meeting it at 45 degrees does NOT match', idx.match(WAY), False)
os.unlink(path)

print('\nthe rule must not be too tight:')
# The Pioneer Way case: source segments far shorter than the graph edge.
idx, path = index_of(line(0, 700))
check('a source covering 70% of the way matches', idx.match(WAY), True)
os.unlink(path)

idx, path = index_of(line(0, 500))
check('a source covering half the way matches', idx.match(WAY), True)
os.unlink(path)

idx, path = index_of(line(0, 250))
check('a source covering only a quarter does NOT match', idx.match(WAY), False)
os.unlink(path)

# Several short consecutive records, as the road log actually stores them.
idx, path = index_of(line(0, 200), line(200, 400), line(400, 600),
                     line(600, 800), line(800, 1000))
got = idx.match(WAY)
check('a way split across five short source records still matches', got, True)
os.unlink(path)

print('\nthe matched portion, not the whole way, is credited:')
idx, path = index_of(line(0, 600))
idx.match(WAY)
credited = idx.matched_m
check(f'credited {credited:.0f} m of a 1000 m way, not all of it',
      credited < 900, True)
os.unlink(path)

print()
if failures:
    print(f'{len(failures)} FAILED: {failures}')
    sys.exit(1)
print('all conflation guards hold')
