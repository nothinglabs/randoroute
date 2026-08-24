#!/usr/bin/env python3
"""Directional bike-facility mapping and packing.

Field origin: 37th Avenue NE carries cycleway:right=lane — a lane on one side
of a two-way street — and the route card claimed "Bike lane" to a rider
heading the other way. The graph now stores a per-direction rung pair packed
into the existing eFacility byte; these are the mapping and encoding
invariants the router's decoder (test_directional_facility_decode.mjs)
mirrors.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_graph as bg  # noqa: E402

failures = []


def check(label, actual, expected):
    if actual != expected:
        failures.append(f'{label}: {actual!r} != {expected!r}')
        print(f'FAIL {label} -- {actual!r} != {expected!r}')
    else:
        print(f'PASS {label}')


# The field case: a lane on the right side of a two-way street serves way-
# forward travel only.
check('right-side lane serves forward only',
      bg.osm_facility_directional({'cycleway:right': 'lane'}), (2, 0))
check('left-side lane serves reverse only',
      bg.osm_facility_directional({'cycleway:left': 'lane'}), (0, 2))
check('both-sides lane serves both',
      bg.osm_facility_directional({'cycleway:both': 'lane'}), (2, 2))
check('plain cycleway=lane serves both',
      bg.osm_facility_directional({'cycleway': 'lane'}), (2, 2))
check('sharrow one side, lane the other',
      bg.osm_facility_directional(
          {'cycleway:left': 'shared_lane', 'cycleway:right': 'lane'}), (2, 1))
check('a buffered right side upgrades forward only',
      bg.osm_facility_directional(
          {'cycleway:right': 'lane', 'cycleway:right:buffer': 'yes'}), (3, 0))
check('a separated track outranks the lane on the same side',
      bg.osm_facility_directional({'cycleway:right': 'track'}), (4, 0))

# Oneway streets: any with-flow lane serves the legal direction; only
# opposite_* describes contraflow.
check('oneway lane serves the legal direction',
      bg.osm_facility_directional({'oneway': 'yes', 'cycleway:left': 'lane'}), (2, 0))
check('contraflow lane on a oneway serves the reverse',
      bg.osm_facility_directional(
          {'oneway': 'yes', 'cycleway:left': 'opposite_lane'}), (0, 2))
check('reverse oneway mirrors the pair',
      bg.osm_facility_directional({'oneway': '-1', 'cycleway': 'opposite_lane'}), (2, 0))
check('plain opposite permits contraflow without claiming a facility',
      bg.osm_facility_directional({'oneway': 'yes', 'cycleway': 'opposite'}), (0, 0))

# The street-describing wrapper stays the better direction — the pooled
# ladder the tiles have always drawn.
check('street ladder is the better direction',
      bg.osm_facility_class({'cycleway:right': 'lane'}), 2)
check('street ladder unchanged for symmetric tagging',
      bg.osm_facility_class({'cycleway': 'shared_lane'}), 1)
check('street ladder still sees a contraflow lane',
      bg.osm_facility_class({'oneway': 'yes', 'cycleway:left': 'opposite_lane'}), 2)

# Packing: high nibble 0 is byte-identical to every previously built graph.
check('symmetric packs to the bare rung', bg.pack_directional_facility(2, 2), 2)
check('forward-only lane packs rung + reverse marker',
      bg.pack_directional_facility(2, 0), 2 | (1 << 4))
check('reverse-only lane packs empty forward',
      bg.pack_directional_facility(0, 2), (3 << 4))
check('shared-use path stays a plain byte', bg.pack_directional_facility(5, 5), 5)
for forward in range(6):
    for reverse in range(6):
        packed = bg.pack_directional_facility(forward, reverse)
        check(f'rung max round-trips {forward}/{reverse}',
              bg.facility_rung_max(packed), max(forward, reverse))

if failures:
    print(f'{len(failures)} FAILED')
    sys.exit(1)
print('all directional facility checks passed')
