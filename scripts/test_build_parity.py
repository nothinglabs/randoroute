#!/usr/bin/env python3
"""The tile build and the graph build must describe one road the same way.

build_roads.py (map tiles / the tap card) and build_graph.py (the router)
consume the same OSM extract and the same WSDOT layers. While each kept its
own copies of the shared constants and parsers they drifted four ways --
km/h speeds parsed differently, cycleway:buffer=yes buffered in one and
plain in the other, WSDOT speed beating a real OSM maxspeed only in the
tile, and the limited-access caution ungated by a bike lane only in the
tile. The copies are now imports; this holds the door shut.
"""
import os
import sys

try:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import build_graph
    import build_roads
except ImportError as e:
    print(f'SKIP: {e}')
    sys.exit(77)

failures = []


def check(name, ok, detail=''):
    if ok:
        print(f'PASS  {name}')
    else:
        failures.append(name)
        print(f'FAIL  {name}{f"  -- {detail}" if detail else ""}')


# Everything both builds need is ONE object, imported, not a lookalike copy.
for symbol in ('parse_mph', 'parse_shoulder_ft', 'osm_facility_class',
               'DEFAULT_MPH', 'DRIVE', 'LIMITED',
               'WSDOT_ALWAYS_CLASSES', 'SIMPLIFY_DEG', 'ROAD_CLASS',
               'surface_class', 'lane_class', 'sidewalk_flags', 'blts_match',
               'load_official_index', 'official_match', 'FACILITY_PATH'):
    check(f'{symbol} is shared, not copied',
          getattr(build_roads, symbol) is getattr(build_graph, symbol))

# REF_STATE shares differently: --region reassigns it on build_graph, so a
# from-import in build_roads would freeze the pre-region copy. Parity there
# means build_roads has NO name of its own and reads build_graph.REF_STATE at
# use time (test_state_ref_gate.py proves the reassignment is seen).
check('REF_STATE is read live, never imported by name',
      not hasattr(build_roads, 'REF_STATE'))

# The drift that existed: 'maxspeed=50 km' parsed as 50 mph in the tile and
# 31 mph in the graph. One parser now, and it converts.
check("'50 km' converts to mph", build_graph.parse_mph('50 km') == 31,
      str(build_graph.parse_mph('50 km')))
check("'30 km/h' converts to mph", build_graph.parse_mph('30 km/h') == 19,
      str(build_graph.parse_mph('30 km/h')))
check("'25 mph' stays 25", build_graph.parse_mph('25 mph') == 25)
check("'signals' is unparseable", build_graph.parse_mph('signals') is None)

# The other drift: the facility ladder honoured cycleway:buffer=yes in the
# graph only. One ladder now.
fc = build_graph.osm_facility_class
check('a plain lane is FACILITY_LANE', fc({'cycleway': 'lane'}) == 2)
check('lane + :buffer=yes is FACILITY_BUFFERED',
      fc({'cycleway': 'lane', 'cycleway:buffer': 'yes'}) == 3)
check('a track is FACILITY_SEPARATED', fc({'cycleway': 'track'}) == 4)
check('a sharrow is FACILITY_SHARED', fc({'cycleway': 'shared_lane'}) == 1)
check('no tags, no facility', fc({}) == 0)

# The dead WSDOT_CLASSES lists (one of which documented a conflation scope
# twice as wide as the real gate) must not return.
check('no stale WSDOT_CLASSES in build_graph',
      not hasattr(build_graph, 'WSDOT_CLASSES'))
check('no stale WSDOT_CLASSES in build_roads',
      not hasattr(build_roads, 'WSDOT_CLASSES'))

print(f'\n{len(failures)} failed' if failures else '\nBuild parity holds.')
sys.exit(1 if failures else 0)
