#!/usr/bin/env python3
"""
Phase 3 build step: prepare data/roads-*.geojson — the full drivable road
network — from an OSM extract.

BUILD-TIME step. The app makes no runtime OSM/Overpass calls; it renders only
from the static files this script produces.

Source: Geofabrik Washington extract (washington-latest.osm.pbf), EPSG:4326.
Output: data/roads-1.geojson, data/roads-2.geojson, ... (split so each file
        stays under GitHub's 100 MB blob limit)

Included: motorway..tertiary (+links), unclassified, residential, living_street.
Excluded: service/track (driveways, parking aisles, logging roads) and
          access=private/no ways.

Missing maxspeed is INFERRED from road class (BNA-style: PeopleForBikes'
Bicycle Network Analysis pioneered class-based defaults for OSM gaps). The
`e` flag marks estimated speeds so the UI can label them.

Feature properties (short keys to keep the files small):
  h  highway class          s  speed mph (actual or estimated)
  e  1 = speed estimated    f  1 = has bike facility (cycleway lane/track)
  b  1 = bikes prohibited   m  1 = limited access (motorway)
  w  shoulder width, ft (only when OSM has real shoulder data; shoulder=no -> 0)
  n  name                   r  ref (route number)

Requires: osmium (pyosmium), shapely.
Usage: python3 scripts/build_roads.py --src data/washington-latest.osm.pbf \
                                      --out-prefix data/roads
"""
import argparse
import json
import os
import re

import osmium
from shapely.geometry import LineString

CLASSES = {
    'motorway', 'motorway_link', 'trunk', 'trunk_link',
    'primary', 'primary_link', 'secondary', 'secondary_link',
    'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street',
}
# Class-based speed defaults (mph) for ways with no usable maxspeed tag.
DEFAULT_MPH = {
    'motorway': 65, 'motorway_link': 45,
    'trunk': 55, 'trunk_link': 40,
    'primary': 50, 'primary_link': 35,
    'secondary': 45, 'secondary_link': 35,
    'tertiary': 35, 'tertiary_link': 30,
    'unclassified': 35, 'residential': 25, 'living_street': 15,
}
LIMITED = {'motorway', 'motorway_link'}
# Ways covered by the WSDOT BLTS layer (state highways). Flagged d=1 so the app
# can hide the OSM duplicate while the (data-rich) WSDOT source is enabled —
# otherwise OSM's unknown-shoulder "pass" visually masks WSDOT's measured fail.
WSDOT_CLASSES = {'motorway', 'motorway_link', 'trunk', 'trunk_link'}
REF_STATE = re.compile(r'(^|[;,\s])(I|US|SR|WA)[-\s]?\d+', re.I)
FACILITY = {'lane', 'shared_lane', 'buffered_lane', 'track', 'separated',
            'opposite_lane', 'opposite_track'}
CYCLEWAY_KEYS = ('cycleway', 'cycleway:both', 'cycleway:right', 'cycleway:left')

SIMPLIFY_DEG = 0.00005   # ~5 m
COORD_DECIMALS = 5
MAX_FILE_BYTES = 55 * 1024 * 1024  # split well under GitHub's 100 MB limit

_num = re.compile(r'^\s*(\d+(?:\.\d+)?)')


def parse_mph(v):
    """'35 mph' -> 35; bare numbers treated as mph (US tagging practice)."""
    if not v:
        return None
    first = v.split(';')[0].strip().lower()
    m = _num.match(first)
    if not m:
        return None  # 'signals', 'none', 'variable', ...
    val = float(m.group(1))
    if 'km/h' in first or 'kmh' in first or 'kph' in first:
        val *= 0.621371
    return int(round(val))


def parse_shoulder_ft(tags):
    """Real shoulder data only. shoulder=no -> 0 ft (known-bad); widths are meters."""
    s = tags.get('shoulder')
    if s in ('no', 'none'):
        return 0
    for k in ('shoulder:width', 'shoulder:both:width', 'shoulder:right:width'):
        v = tags.get(k)
        if v:
            m = _num.match(v)
            if m:
                return int(round(float(m.group(1)) * 3.28084))
    return None


def build(src, out_prefix):
    feats = []
    kept = skipped_private = 0
    for obj in osmium.FileProcessor(src).with_locations():
        if not obj.is_way():
            continue
        tags = {t.k: t.v for t in obj.tags}
        hw = tags.get('highway')
        if hw not in CLASSES:
            continue
        # Mode-specific tags override the blanket access default: keep roads
        # closed to general traffic but explicitly open to bikes.
        if tags.get('access') in ('private', 'no') and \
                tags.get('bicycle') not in ('yes', 'designated', 'permissive'):
            skipped_private += 1
            continue

        coords = [(nd.location.lon, nd.location.lat) for nd in obj.nodes if nd.location.valid()]
        if len(coords) < 2:
            continue
        line = LineString(coords)
        if len(coords) > 3:
            line = line.simplify(SIMPLIFY_DEG, preserve_topology=False)
        cc = [[round(x, COORD_DECIMALS), round(y, COORD_DECIMALS)] for x, y in line.coords]

        p = {'h': hw}
        spd = parse_mph(tags.get('maxspeed'))
        if spd is None:
            p['s'] = DEFAULT_MPH[hw]
            p['e'] = 1
        else:
            p['s'] = spd
        if hw in LIMITED:
            p['m'] = 1
        if tags.get('bicycle') in ('no', 'dismount'):
            p['b'] = 1
        for k in CYCLEWAY_KEYS:
            if tags.get(k) in FACILITY:
                p['f'] = 1
                break
        w = parse_shoulder_ft(tags)
        if w is not None:
            p['w'] = w
        if tags.get('name'):
            p['n'] = tags['name']
        if tags.get('ref'):
            p['r'] = tags['ref']
        if hw in WSDOT_CLASSES or (tags.get('ref') and REF_STATE.search(tags['ref'])):
            p['d'] = 1  # duplicated by the WSDOT BLTS layer

        feats.append(json.dumps(
            {'type': 'Feature', 'properties': p,
             'geometry': {'type': 'LineString', 'coordinates': cc}},
            separators=(',', ':')))
        kept += 1

    # Split into files, each under MAX_FILE_BYTES.
    files, cur, cur_bytes = [], [], 0
    for f in feats:
        if cur and cur_bytes + len(f) > MAX_FILE_BYTES:
            files.append(cur)
            cur, cur_bytes = [], 0
        cur.append(f)
        cur_bytes += len(f) + 1
    if cur:
        files.append(cur)

    names = []
    for i, chunk in enumerate(files, 1):
        name = f'{out_prefix}-{i}.geojson'
        with open(name, 'w') as fh:
            fh.write('{"type":"FeatureCollection","features":[')
            fh.write(','.join(chunk))
            fh.write(']}')
        names.append(name)
        print(f'wrote {name}: {len(chunk):,} features, {os.path.getsize(name):,} bytes')
    print(f'total kept {kept:,} ways ({skipped_private:,} private skipped) across {len(names)} file(s)')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default='data/washington-latest.osm.pbf')
    ap.add_argument('--out-prefix', default='data/roads')
    args = ap.parse_args()
    build(args.src, args.out_prefix)
