#!/usr/bin/env python3
"""The agency-conflation gate must spell route refs the loaded state's way.

Both Oregon imports shipped with OR-numbered highways silently refused ODOT
conflation because the gate only knew Washington's spellings. The gate now
derives from region.json's stateRoutePrefixes (--region on both builders);
this proves the derivation with the real pattern builder -- the default stays
exactly Washington's, each shipped state's region.json admits its own refs,
and build_roads sees the same reassigned pattern (it reads the module
attribute, where a from-import would have frozen the pre-region copy).
"""
import importlib
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
import build_graph  # noqa: E402

failures = []


def check(name, ok, detail=''):
    print(f'{"PASS" if ok else "FAIL"}  {name}' + (f'  -- {detail}' if not ok and detail else ''))
    if not ok:
        failures.append(name)


def matches(ref):
    return bool(build_graph.REF_STATE.search(ref))


# The default is Washington's, byte-identical to the historical gate.
build_graph.set_state_route_prefixes(build_graph.DEFAULT_STATE_ROUTE_PREFIXES)
check('default admits Washington spellings',
      all(matches(r) for r in ['SR 520', 'WA-9', 'US 2', 'I 5', 'I-90', 'US 101;SR 8']))
check('default refuses Oregon spellings', not matches('OR 224'))
check('default does not match prefixes inside words', not matches('ORCHARD 5') and not matches('WASHOUT 3'))

for state in sorted(os.listdir(os.path.join(ROOT, 'maps'))):
    region_path = os.path.join(ROOT, 'maps', state, 'region.json')
    if not os.path.isfile(region_path):
        continue
    with open(region_path, encoding='utf-8') as f:
        region = json.load(f)
    prefixes = region.get('stateRoutePrefixes')
    check(f'{state}: region.json declares stateRoutePrefixes', bool(prefixes), 'missing key')
    if not prefixes:
        continue
    build_graph.apply_region_config(region_path)
    sample = f'{prefixes[-1]} 224'
    check(f'{state}: the gate admits its own refs ("{sample}")', matches(sample))
    check(f'{state}: the gate still admits Interstates', matches('I 5') and matches('I-84'))

# build_roads must see the reassigned pattern, not a frozen import-time copy.
build_graph.set_state_route_prefixes(['I', 'US', 'OR'])
build_roads = importlib.import_module('build_roads')
check('build_roads reads the live module attribute',
      not hasattr(build_roads, 'REF_STATE')
      and bool(build_graph.REF_STATE.search('OR 224')))
build_graph.set_state_route_prefixes(build_graph.DEFAULT_STATE_ROUTE_PREFIXES)

if failures:
    sys.exit(1)
print(f'{"all checks passed"}')
