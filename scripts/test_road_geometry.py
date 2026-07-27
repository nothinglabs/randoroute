#!/usr/bin/env python3
"""Road tile geometry must survive vertex reduction.

Guards the traffic-circle regression: a fixed ~5 m Douglas-Peucker tolerance was
applied to every way, including closed rings whose whole diameter was smaller
than the tolerance. Washington's traffic circles collapsed into triangles and
there-and-back spikes -- 3,125 of 4,486 rings kept four or fewer distinct points
-- and drew on the map as arrowheads parked in the intersection.
"""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_roads import COORD_DECIMALS, RING_COORD_DECIMALS, compact_coords

# OSM way 964965391: the junction=roundabout at Dayton Avenue North and North
# 68th Street in Seattle, as surveyed -- 21 points across roughly 8 m.
DAYTON_CIRCLE = [
    [-122.352569, 47.6796289], [-122.3525669, 47.6796408], [-122.3525705, 47.6796526],
    [-122.3525794, 47.6796629], [-122.3525927, 47.6796709], [-122.3526091, 47.6796756],
    [-122.3526195, 47.6796761], [-122.3526268, 47.6796765], [-122.3526441, 47.6796737],
    [-122.35266, 47.6796667], [-122.3526715, 47.6796566], [-122.3526772, 47.6796445],
    [-122.3526767, 47.6796318], [-122.3526698, 47.67962], [-122.3526574, 47.6796104],
    [-122.3526409, 47.6796041], [-122.3526223, 47.679602], [-122.3526047, 47.6796039],
    [-122.352589, 47.6796095], [-122.3525766, 47.6796181], [-122.352569, 47.6796289],
]


def extent_m(coords):
    lat = coords[0][1]
    xs = [c[0] for c in coords]
    ys = [c[1] for c in coords]
    return ((max(xs) - min(xs)) * 111320 * math.cos(math.radians(lat)),
            (max(ys) - min(ys)) * 111320)


def check(name, condition, detail=''):
    status = 'PASS' if condition else 'FAIL'
    print(f'{status}  {name}' + (f'  -- {detail}' if detail else ''))
    return condition


def main():
    ok = True
    out = compact_coords(DAYTON_CIRCLE)
    distinct = len({tuple(p) for p in out})
    width, height = extent_m(out)
    source_width, source_height = extent_m(DAYTON_CIRCLE)

    ok &= check('a surveyed traffic circle keeps its vertices',
                len(out) == len(DAYTON_CIRCLE),
                f'{len(DAYTON_CIRCLE)} pts in, {len(out)} out')
    ok &= check('it never degrades to a triangle or spike', distinct >= 8,
                f'{distinct} distinct points')
    # A circle stays a circle: both axes survive, so it cannot flatten into the
    # 8.2 x 1.1 m sliver that used to reach the map.
    ok &= check('it stays round rather than flattening',
                min(width, height) > 0.6 * max(width, height),
                f'{width:.1f} x {height:.1f} m (source {source_width:.1f} x {source_height:.1f} m)')
    ok &= check('rings keep the finer precision their size needs',
                all(len(str(c[0]).split('.')[-1]) <= RING_COORD_DECIMALS for c in out))

    # An ordinary long road must still shed redundant vertices.
    straight = [[-122.35 + 0.0001 * i, 47.68 + 0.0000001 * i] for i in range(60)]
    thinned = compact_coords(straight)
    ok &= check('a long straight road is still simplified',
                len(thinned) < len(straight),
                f'{len(straight)} pts in, {len(thinned)} out')
    ok &= check('open ways keep the standard precision',
                all(len(str(c[0]).split('.')[-1]) <= COORD_DECIMALS for c in thinned))

    # A genuinely curved road keeps enough shape to read as a curve.
    curve = [[-122.35 + 0.0005 * math.cos(i / 12), 47.68 + 0.0005 * math.sin(i / 12)]
             for i in range(40)]
    curved = compact_coords(curve)
    ok &= check('a broad curve keeps its shape', len(curved) >= 5,
                f'{len(curved)} points retained')

    print('\nRoad geometry tests ' + ('passed.' if ok else 'FAILED.'))
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(main())
