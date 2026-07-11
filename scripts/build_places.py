#!/usr/bin/env python3
"""Bake an offline place-search index from an OSM extract.

Settlements (place=city/town/village/hamlet/suburb/neighbourhood) plus named
ferry terminals, sorted by population (desc) so search ranks big places first.

Output: data/places.json — compact array of [name, lon, lat, type, population].

Usage: python3 scripts/build_places.py --src data/washington-latest.osm.pbf
"""
import argparse
import json

import osmium

PLACE_TYPES = {'city', 'town', 'village', 'hamlet', 'suburb', 'neighbourhood'}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default='data/washington-latest.osm.pbf')
    ap.add_argument('--out', default='data/places.json')
    args = ap.parse_args()

    rows = []
    seen = set()
    for o in osmium.FileProcessor(args.src, osmium.osm.NODE):
        t = o.tags
        name = t.get('name')
        if not name or not o.location.valid():
            continue
        kind = None
        if t.get('place') in PLACE_TYPES:
            kind = t.get('place')
        elif t.get('amenity') == 'ferry_terminal':
            kind = 'ferry'
        if kind is None:
            continue
        key = (name.lower(), kind)
        if key in seen:
            continue
        seen.add(key)
        try:
            pop = int(t.get('population', '0').replace(',', ''))
        except ValueError:
            pop = 0
        rows.append([name, round(o.location.lon, 5), round(o.location.lat, 5), kind, pop])

    order = {'city': 0, 'town': 1, 'ferry': 2, 'village': 3, 'suburb': 4,
             'hamlet': 5, 'neighbourhood': 6}
    rows.sort(key=lambda r: (-r[4], order.get(r[3], 9), r[0]))
    with open(args.out, 'w') as f:
        json.dump(rows, f, separators=(',', ':'), ensure_ascii=False)
    import os
    print(f'wrote {len(rows):,} places -> {args.out} ({os.path.getsize(args.out):,} bytes)')


if __name__ == '__main__':
    main()
