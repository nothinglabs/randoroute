#!/usr/bin/env python3
"""A short service way that is open to bikes and closed to cars is a link, not a driveway.

Dropping one severs a corridor. This happened twice:

  * `highway=track` + `bicycle=yes` -- a 70 m link joining two halves of a
    rail-trail (Issaquah-Preston, High Point). Fixed by accepting `yes`.
  * `highway=service` + `bicycle=yes` -- Hoffman Hill Boulevard continues into
    Mounts Road SW as a 9-node emergency-access link, OSM way 12189384, tagged
    `access=no bicycle=yes foot=yes motor_vehicle=no`. Service was the only
    infra category still demanding `bicycle=designated`, so this was dropped.
    Losing those 89 m left 1.3 mi of I-5 as the sole link out of DuPont, and at
    a freeway weight of 60 the router detoured 45 extra miles through Spanaway
    and Yelm -- turning Tacoma-Olympia into a 54 mi ride against a 26 mi
    straight line.

The rule to hold: every infra category treats `designated` and `yes` alike.
A category that diverges is how a corridor goes quietly missing.
"""
import importlib.util
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('build_graph', ROOT / 'scripts' / 'build_graph.py')
bg = importlib.util.module_from_spec(spec)
sys.modules['build_graph'] = bg
spec.loader.exec_module(bg)

failures = []


def check(name, ok, detail=''):
    if not ok:
        failures.append(f'{name}{"  -- " + detail if detail else ""}')


# ---- the exact way that severed the corridor ---------------------------
hoffman = {
    'highway': 'service', 'name': 'Hoffman Hill Boulevard', 'access': 'no',
    'bicycle': 'yes', 'foot': 'yes', 'motor_vehicle': 'no',
    'service': 'emergency_access',
}
got = bg.classify_way(hoffman)
check('OSM w12189384 (Hoffman Hill -> Mounts Rd link) is routable',
      got is not None, 'classify_way dropped it')
if got:
    check('and is treated as dedicated infrastructure', got.get('infra') is True, str(got))

# ---- designated and yes must behave identically, in every category -----
for hw in ('path', 'footway', 'bridleway', 'track', 'service'):
    for extra in ({'motor_vehicle': 'no'}, {'access': 'no'}, {'access': 'private'}):
        base = {'highway': hw, **extra}
        yes = bg.classify_way({**base, 'bicycle': 'yes'})
        des = bg.classify_way({**base, 'bicycle': 'designated'})
        check(f'{hw} with {extra}: bicycle=yes matches bicycle=designated',
              (yes is None) == (des is None), f'yes={yes is not None} designated={des is not None}')

# ---- but an explicit prohibition still wins ----------------------------
check('bicycle=no on a service link is still dropped',
      bg.classify_way({'highway': 'service', 'bicycle': 'no', 'access': 'no',
                       'motor_vehicle': 'no'}) is None)
check('bicycle=no on a track is still dropped',
      bg.classify_way({'highway': 'track', 'bicycle': 'no'}) is None)

# ---- and an ordinary service way is NOT promoted to a bike link --------
# The narrowness is the safety property: without a bike tag AND a motor-traffic
# exclusion, a service way stays out. Otherwise every parking aisle and alley in
# the state becomes routable bike infrastructure.
check('a plain service way is not routable',
      bg.classify_way({'highway': 'service'}) is None)
check('a service way open to cars is not a bike link',
      bg.classify_way({'highway': 'service', 'bicycle': 'yes'}) is None,
      'bicycle=yes alone must not promote a service way; cars must be excluded too')
check('a private driveway with no bike tag is not routable',
      bg.classify_way({'highway': 'service', 'service': 'driveway',
                       'access': 'private'}) is None)

# ---- the access=no blanket must not re-drop a bike-permitted way -------
# access=no is a default that mode-specific tags override; this is the same
# reasoning that keeps the SR 520 Trail bridge.
for tags in (
    {'highway': 'residential', 'access': 'no', 'bicycle': 'yes'},
    {'highway': 'residential', 'access': 'private', 'foot': 'designated'},
):
    check(f'access override honoured for {tags}', bg.classify_way(tags) is not None)

if failures:
    print(f'{len(failures)} failure(s):')
    for f in failures:
        print('  FAIL', f)
    raise SystemExit(1)
print('ok - bike-permitted service and track links stay in the routable graph')
