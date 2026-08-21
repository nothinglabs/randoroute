#!/usr/bin/env python3
"""What may be marked a mountain-bike way, and by what evidence.

The MTB marking is not a colour or a caution. The router SKIPS an MTB edge
outright unless the rider turns `allowMtbTrails` on, and it is off by default,
so anything marked here is removed from the network for most riders. That makes
the marking's inputs worth pinning.

Two sources, deliberately not equal:

  * a way-level `mtb` or `mtb:*` tag marks anything, because a mapper who wrote
    it was looking at that way;
  * `route=mtb` relation membership marks only ways a car does not drive on.

The second half is the rule this file exists for. Long-distance bikepacking
routes carry `route=mtb` and follow paved highway between their dirt sections,
so membership alone says nothing about the surface under a member way. Nevada's
SR 170 is the case that produced the rule: eight of its ways are members of
"The Plateau Passage", it is two-lane asphalt with a 6 ft shoulder, and it
carries the only bike-legal Virgin River bridge. Marking it left Mesquite with
no route at all to Bunkerville, four miles away.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_graph import DRIVE, is_mountain_bike_way  # noqa: E402

IN_RELATION = {101}
NOT_IN_RELATION = set()

failures = []


def check(name, got, want):
    if got == want:
        print(f'  ok   {name}')
        return
    failures.append(f'{name} -- expected {want}, got {got}')
    print(f'  FAIL {name}  -- expected {want}, got {got}')


# The real thing, from OSM: way 799093346, Riverside Road / SR 170.
SR_170 = {'highway': 'secondary', 'ref': 'SR 170', 'name': 'Riverside Road',
          'lanes': '2', 'surface': 'asphalt', 'smoothness': 'excellent',
          'cycleway:both': 'no', 'oneway': 'no', 'old_ref': 'US 91'}
check('a paved state highway in an MTB relation is not a mountain-bike way',
      is_mountain_bike_way(SR_170, 101, IN_RELATION), False)

# Every road class a bikepacking route might connect through.
for highway in sorted(DRIVE):
    check(f'{highway} in an MTB relation is not a mountain-bike way',
          is_mountain_bike_way({'highway': highway}, 101, IN_RELATION), False)

# What membership is for.
for highway in ('path', 'track', 'bridleway', 'cycleway', 'footway'):
    check(f'{highway} in an MTB relation is a mountain-bike way',
          is_mountain_bike_way({'highway': highway}, 101, IN_RELATION), True)

# A way-level tag outranks the highway class: a mapper looked at this way.
check('a road tagged mtb:scale is a mountain-bike way',
      is_mountain_bike_way({'highway': 'unclassified', 'mtb:scale': '2'}, 101, IN_RELATION), True)
check('a road tagged mtb is a mountain-bike way, with no relation at all',
      is_mountain_bike_way({'highway': 'residential', 'mtb': 'yes'}, 102, NOT_IN_RELATION), True)
check('a way-level tag still marks a path outside any relation',
      is_mountain_bike_way({'highway': 'path', 'mtb:scale:uphill': '3'}, 102, NOT_IN_RELATION), True)

# Nothing claims it, so nothing marks it.
check('a path in no relation and with no tag is not a mountain-bike way',
      is_mountain_bike_way({'highway': 'path'}, 102, NOT_IN_RELATION), False)
check('an untagged way in no relation is not a mountain-bike way',
      is_mountain_bike_way({}, 102, NOT_IN_RELATION), False)

# A way with no highway tag at all must not be swept in by membership: `get`
# returns None, and None is not in DRIVE, so this is the one case where the
# guard reads the wrong way round if it is ever rewritten as `in PATHS`.
check('a relation member with no highway tag is left to the path branch',
      is_mountain_bike_way({'route': 'mtb'}, 101, IN_RELATION), True)

print()
if failures:
    print(f'{len(failures)} FAILED\n  - ' + '\n  - '.join(failures))
    sys.exit(1)
print('mountain-bike marking: way tags mark anything, membership marks only non-roads')
