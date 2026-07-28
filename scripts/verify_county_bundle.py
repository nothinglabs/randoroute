#!/usr/bin/env python3
"""Gates a county bundle must pass before its routes are baked into the archives.

These are gates, not a report. Every one of them exists because something went
wrong without it -- see docs/county-data-import.md.

Usage:
    python3 scripts/verify_county_bundle.py data/county/island.json \\
        --pbf data/washington-latest.osm.pbf --expect-name "Deer Lake Road"
"""

import argparse
import json
import math
import sys

sys.path.insert(0, __file__.rsplit('/', 1)[0])
from county_conflate import SNAP_M, CountyRouteIndex, load_bundles   # noqa: E402


def miles(coords):
    total = 0.0
    for (alon, alat), (blon, blat) in zip(coords, coords[1:]):
        total += math.hypot((blon - alon) * math.cos(math.radians(alat)) * 69.17,
                            (blat - alat) * 69.17)
    return total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('bundle', nargs='+')
    ap.add_argument('--pbf', default='data/washington-latest.osm.pbf')
    ap.add_argument('--expect-name', action='append', default=[],
                    help='a road you checked by hand that MUST come out flagged')
    ap.add_argument('--max-ratio', type=float, default=1.6)
    ap.add_argument('--min-ratio', type=float, default=1.0)
    args = ap.parse_args()

    bundles = []
    for path in args.bundle:
        with open(path, encoding='utf-8') as handle:
            bundles.append((path, json.load(handle)))
    published = 0.0
    for path, bundle in bundles:
        own = sum(miles(r['coords']) for r in bundle.get('routes', [])
                  if r.get('status') == 'existing')
        published += own
        print(f"{bundle.get('county')} County: {own:.1f} mi of built route")

    failures = []

    # Gate 1: every route must be 'existing'. A planned corridor that reached
    # the bundle would be baked in as ridable.
    for path, bundle in bundles:
        planned = [r for r in bundle.get('routes', []) if r.get('status') != 'existing']
        if planned:
            failures.append(f'{path}: {len(planned)} routes are not status=existing')

    # Gate 2: matched mileage against published mileage. Below min the snap
    # missed the network; above max it is bleeding onto cross streets -- Island
    # matched 72 mi against 33.5 before the bearing test existed.
    import osmium

    index = CountyRouteIndex(load_bundles(args.bundle))
    if index.empty:
        print('  no built routes to check')
        return 1 if failures else 0

    class Matcher(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.matched_mi = 0.0
            self.names = set()

        def way(self, w):
            tags = dict(w.tags)
            if 'highway' not in tags:
                return
            try:
                coords = [[n.lon, n.lat] for n in w.nodes]
            except Exception:                       # noqa: BLE001 - incomplete way
                return
            if len(coords) < 2:
                return
            # Only the part of the way that lies on a route, not its whole
            # length -- an OSM way runs far past the stretch a route follows.
            matched_m = index.matched_length_m(coords)
            if matched_m <= 0:
                return
            self.matched_mi += matched_m / 1609.34
            if tags.get('name'):
                self.names.add(tags['name'])

    matcher = Matcher()
    matcher.apply_file(args.pbf, locations=True)
    ratio = matcher.matched_mi / published if published else 0
    print(f'  matched {matcher.matched_mi:.1f} mi of OSM ways  (ratio {ratio:.2f})')
    print(f'  distinct named roads matched: {len(matcher.names)}')
    if ratio < args.min_ratio:
        failures.append(f'match ratio {ratio:.2f} below {args.min_ratio}: the snap missed the network')
    if ratio > args.max_ratio:
        failures.append(f'match ratio {ratio:.2f} above {args.max_ratio}: bleeding onto cross streets')

    # Gate 3: a road checked by hand must come out flagged. If this fails,
    # nothing else in the report means anything.
    for expected in args.expect_name:
        if expected in matcher.names:
            print(f'  OK  hand-checked road present: {expected}')
        else:
            failures.append(f'hand-checked road missing from the match: {expected}')

    print(f'  snap tolerance {SNAP_M:.0f} m')
    for failure in failures:
        print(f'  FAIL  {failure}')
    print('PASS' if not failures else f'{len(failures)} gate(s) failed')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
