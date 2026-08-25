#!/usr/bin/env python3
"""DEM lookups read water as sea surface, never as sea floor.

Terrarium tiles carry real bathymetry: a pier node one pixel offshore
sampled -2,973 m in the released Washington graph, and the short edge
climbing back out invented 9,022 ft of ascent on a Kirkland-Tacoma ferry
route. The lookup clamps anything below -100 m (no US land is deeper;
Death Valley is -86 m) to 0, at read time so pre-existing cached mosaics
are covered. This runs the actual lookup the graph build samples through.
"""
import math
import sys

sys.path.insert(0, 'scripts')

try:
    import numpy as np
except ImportError:
    print('SKIP: numpy is not installed')
    sys.exit(77)

import build_graph

SCALE = 2 ** build_graph.DEM_Z


def lonlat_for_pixel(x0, y0, px, py):
    fx = x0 + (px + 0.5) / 256
    fy = y0 + (py + 0.5) / 256
    lon = fx / SCALE * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * fy / SCALE))))
    return lon, lat


failures = []


def check(name, ok, detail=''):
    print(f'{"PASS" if ok else "FAIL"}  {name}' + (f'  -- {detail}' if not ok and detail else ''))
    if not ok:
        failures.append(name)


mosaic = np.zeros((256, 256), dtype=np.int16)
mosaic[0, 0] = 14      # ordinary land
mosaic[0, 1] = -86     # Death Valley: real land below sea level, kept
mosaic[0, 2] = -2973   # the released graph's worst sounding
mosaic[0, 3] = -101    # just past the deepest possible US land
x0, y0 = 655, 1425     # arbitrary tile origin, exercised through the real math
ele_at = build_graph._dem_lookup(mosaic, x0, y0, 256, 256)

check('ordinary land reads through unchanged',
      ele_at(*lonlat_for_pixel(x0, y0, 0, 0)) == 14)
check('land below sea level survives (Death Valley stays -86 m)',
      ele_at(*lonlat_for_pixel(x0, y0, 1, 0)) == -86)
check('a bathymetric sounding reads as sea surface',
      ele_at(*lonlat_for_pixel(x0, y0, 2, 0)) == 0)
check('the clamp threshold sits just below the deepest US land',
      ele_at(*lonlat_for_pixel(x0, y0, 3, 0)) == 0)
check('outside the mosaic stays sea surface',
      ele_at(*lonlat_for_pixel(x0 + 10, y0, 0, 0)) == 0)

print(f'\n{5 - len(failures)} passed' + (f', {len(failures)} FAILED' if failures else ''))
sys.exit(1 if failures else 0)
