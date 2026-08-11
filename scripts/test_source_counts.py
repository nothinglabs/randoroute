#!/usr/bin/env python3
"""The bike-infrastructure count in region.json is the one the tiler produces.

test_source_counts.mjs pins the BLTS and roads totals, but it could only BOUND
this one: bikeinfra is filtered before tiling -- sharrow-only ways are dropped
-- and reproducing that filter in JavaScript would mean a second copy of the
rule, which is the exact defect this family of tests exists to catch.

So this lives in Python and imports the real sharrow_only() from the builder.
One rule, one place, and the number a rider reads in the layer list is checked
against the data that ships.

I claimed this needed a full build_overlay_tiles.py run over the pipeline. It
does not. The builder reads maps/<state>/bikeinfra.geojson.gz, which is
committed; only the TILING step needs tippecanoe, and the count does not.
"""
import gzip
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_overlay_tiles  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
failures = 0


def check(name, ok, detail=''):
    global failures
    if ok:
        print(f'  ok   {name}')
    else:
        failures += 1
        print(f'  FAIL {name}' + (f'  -- {detail}' if detail else ''))


states = json.load(open(os.path.join(ROOT, 'maps', 'states.json'))) \
    if os.path.exists(os.path.join(ROOT, 'maps', 'states.json')) else None
if states is None:
    states = []
    maps = os.path.join(ROOT, 'maps')
    for name in sorted(os.listdir(maps)):
        config = os.path.join(maps, name, 'region.json')
        if os.path.isfile(config):
            states.append(json.load(open(config)))

for state in states:
    counts = state.get('sourceCounts') or {}
    path = os.path.join(ROOT, 'maps', state['id'], 'bikeinfra.geojson.gz')
    if not counts.get('bikeinfra') or not os.path.exists(path):
        continue
    with gzip.open(path) as fh:
        data = json.load(fh)
    kept = sum(1 for f in data['features']
               if not build_overlay_tiles.sharrow_only(f['properties']))
    check(f"{state['id']}: the bike-infrastructure count is what the tiler keeps",
          counts['bikeinfra'] == kept,
          f"region.json says {counts['bikeinfra']:,}, the filter keeps {kept:,}")

if not failures:
    print(f'\n{len(states)} states checked, 0 failed')
sys.exit(1 if failures else 0)
