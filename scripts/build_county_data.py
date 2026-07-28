#!/usr/bin/env python3
"""Build one county's bike-network and traffic overlay from its open GIS data.

Washington counties publish transportation data one county at a time, in their
own ArcGIS orgs, with their own schemas. There is no statewide equivalent: the
WSDOT layers we already use cover state routes only, so a county road is
invisible to us no matter how well the county has mapped it.

This script pulls a county's data and writes a single self-describing bundle
that the app conflates onto the routing graph AT RUNTIME. Nothing here touches
graph2.bin.gz, so adding a second county is dropping in another bundle -- not a
statewide rebuild.

Output: data/county/<slug>.json

    {
      "county": "Island", "state": "WA", "fips": "53029",
      "built": "2026-07-28",
      "sources": { ... provenance, one entry per upstream service ... },
      "routes":  [ {"name","status","network","coords":[[lon,lat],...]}, ... ],
      "traffic": [ {"name","adt","year","lanes","speed","coords":[...]}, ... ]
    }

Usage:
    python3 scripts/build_county_data.py --county island
    python3 scripts/build_county_data.py --county island --out data/county/island.json
"""

import argparse
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request

# --------------------------------------------------------------- county specs
#
# One entry per county we can reach. Everything county-specific lives here, so
# a new county is a new dict and no new code. The field names differ per county
# on purpose -- normalizing happens below, against the shared output schema.

# `exclude_when` is how a county states our refusals in its own vocabulary:
# each (field, pattern) pair drops a feature whose value matches. It is
# explicit rather than inferred, because these values are hand-typed -- see
# docs/county-data-import.md.
COUNTIES = {
    'island': {
        'name': 'Island',
        'state': 'WA',
        'fips': '53029',
        'routes': {
            'url': 'https://services6.arcgis.com/Q2crTJYujvn27IJC/arcgis/rest/'
                   'services/Bridge_to_Boat_v2/FeatureServer/0',
            'label': 'Island County Public Works — Bridge to Boat bike routes',
            'name_field': 'Route',
            # Island County marks unbuilt corridors by suffixing the route name.
            # A planned route is a plan, not pavement: it may be shown, but it
            # must never earn a routing preference.
            'planned_marker': '(Planned)',
        },
        'traffic': {
            'url': 'https://services6.arcgis.com/Q2crTJYujvn27IJC/arcgis/rest/'
                   'services/Average_Daily_Trips/FeatureServer/0',
            'label': 'Island County Public Works — Average Daily Trips on County Roads',
            'fields': {
                'name': 'RoadName', 'adt': 'ADT', 'year': 'ADTYear',
                'lanes': 'NumThruLanes', 'speed': 'SpeedLimit',
            },
        },
    },
    'clallam': {
        'name': 'Clallam',
        'state': 'WA',
        'fips': '53009',
        'routes': {
            'url': 'https://services8.arcgis.com/noCZ2SM2C0rVag8y/arcgis/rest/'
                   'services/Olympic_Discovery_Trail/FeatureServer/0',
            'label': 'Clallam County — Olympic Discovery Trail',
            'name_field': 'LABEL',
            'type_field': 'ROUTE_TYPE',
            'surface_field': 'SURFACE',
            # A county saying "our signed route runs along here" is not the same
            # as "this is bike infrastructure", and Clallam says which is which.
            # Only the segments it calls trail or bike lane may satisfy the
            # shoulder and lane rules; where it says the route is on ordinary
            # road, the road is judged as a road. Without this, county trust
            # turned US 101 at 60 mph with no shoulder into a pass.
            'trust_when': r'trail|bike lane',
            # Clallam classifies its own route honestly, which is the reason to
            # import it: OSM's relation flattens 158 miles of trail, highway
            # connector and backcountry tread into one line. These drops are our
            # stated refusals expressed in Clallam's fields.
            'exclude_when': [
                ('STATUS', r'propos|under construction'),   # not built
                ('ROUTE_TYPE', r'propos'),
                ('STATUS', r'adventure'),                   # gravel/backcountry variant
                ('TRAIL_TYPE', r'adventure|natural tread'),
                ('ODT_Use', r'no\s*(road\s*bike|rd\s*bike)'),  # county says not for a road bike
            ],
        },
        # Clallam publishes no traffic counts. Checked its ArcGIS org (160
        # services) and its road layers: names and class only, no ADT, no
        # shoulder, no speed. Counties differ in what they offer, and a missing
        # half is recorded rather than faked.
        'traffic': None,
    },
}

PAGE = 1000
RETRIES = 4


def fetch_json(url, params):
    """One ArcGIS REST call, with backoff. These services rate-limit."""
    query = urllib.parse.urlencode(params)
    last = None
    for attempt in range(RETRIES):
        try:
            with urllib.request.urlopen(f'{url}?{query}', timeout=120) as response:
                return json.loads(response.read().decode('utf-8'))
        except Exception as error:          # noqa: BLE001 - any transport failure retries
            last = error
            time.sleep(2 ** attempt)
    raise RuntimeError(f'{url} failed after {RETRIES} attempts: {last}')


def fetch_layer(url, out_fields):
    """Every feature of an ArcGIS layer as GeoJSON, paged past the record cap."""
    features, offset = [], 0
    while True:
        page = fetch_json(f'{url}/query', {
            'where': '1=1',
            'outFields': ','.join(out_fields),
            'returnGeometry': 'true',
            'outSR': '4326',
            'f': 'geojson',
            'resultOffset': offset,
            'resultRecordCount': PAGE,
            'orderByFields': 'OBJECTID',
        })
        batch = page.get('features') or []
        features.extend(batch)
        if len(batch) < PAGE:
            return features
        offset += PAGE


def lines_of(geometry):
    """Every LineString in a geometry, as a list of coordinate lists."""
    if not geometry:
        return []
    if geometry['type'] == 'LineString':
        return [geometry['coordinates']]
    if geometry['type'] == 'MultiLineString':
        return list(geometry['coordinates'])
    return []


def simplify(coords, tolerance_m=4.0):
    """Douglas-Peucker, in metres. County geometry is survey-grade and far
    denser than a phone needs: the South Whidbey route alone ships 2,451
    points for 22 miles. Thinning it keeps the bundle small without moving the
    line enough to change which street it snaps to."""
    if len(coords) < 3:
        return coords
    lat0 = math.radians(coords[0][1])
    mx = 111_320 * math.cos(lat0)
    my = 110_540

    def dist_sq(p, a, b):
        px, py = (p[0] - a[0]) * mx, (p[1] - a[1]) * my
        bx, by = (b[0] - a[0]) * mx, (b[1] - a[1]) * my
        span = bx * bx + by * by
        t = 0.0 if span == 0 else max(0.0, min(1.0, (px * bx + py * by) / span))
        dx, dy = px - bx * t, py - by * t
        return dx * dx + dy * dy

    keep = [False] * len(coords)
    keep[0] = keep[-1] = True
    stack = [(0, len(coords) - 1)]
    limit = tolerance_m * tolerance_m
    while stack:
        lo, hi = stack.pop()
        if hi - lo < 2:
            continue
        worst, at = -1.0, -1
        for i in range(lo + 1, hi):
            d = dist_sq(coords[i], coords[lo], coords[hi])
            if d > worst:
                worst, at = d, i
        if worst > limit:
            keep[at] = True
            stack.append((lo, at))
            stack.append((at, hi))
    return [c for c, k in zip(coords, keep) if k]


def round_coords(coords, places=6):
    """~11 cm at this latitude -- far finer than the snap tolerance."""
    return [[round(lon, places), round(lat, places)] for lon, lat in coords]


def miles(coords):
    total = 0.0
    for (alon, alat), (blon, blat) in zip(coords, coords[1:]):
        dx = (blon - alon) * math.cos(math.radians(alat)) * 69.17
        dy = (blat - alat) * 69.17
        total += math.hypot(dx, dy)
    return total


def build_routes(spec):
    """The county's BUILT, clearly bikeable network.

    Everything we refuse is dropped here rather than shipped and hidden: a
    corridor nobody can ride yet is not route data, and a county's trail folder
    routinely mixes paved multi-use path with gravel logging road and 3-foot
    natural tread. Island's plan alone was 49 miles against 33 built, which put
    more provisional line on the map than real network.

    Returns (routes, dropped) where `dropped` counts by reason, so the build
    reports what it refused instead of silently thinning the data.
    """
    name_field = spec['name_field']
    marker = spec.get('planned_marker')
    excludes = [(field, re.compile(pattern, re.I))
                for field, pattern in spec.get('exclude_when', [])]
    wanted = ['OBJECTID', name_field]
    for extra in ('type_field', 'surface_field'):
        if spec.get(extra):
            wanted.append(spec[extra])
    wanted += [field for field, _p in spec.get('exclude_when', [])]
    features = fetch_layer(spec['url'], sorted(set(wanted)))

    routes = []
    dropped = {}
    for feature in features:
        props = feature.get('properties') or {}
        name = str(props.get(name_field) or '').strip()

        reason = None
        if marker and marker.lower() in name.lower():
            reason = 'planned'
        else:
            for field, pattern in excludes:
                if pattern.search(str(props.get(field) or '')):
                    reason = f'{field}~{pattern.pattern[:24]}'
                    break
        if reason:
            dropped[reason] = dropped.get(reason, 0) + 1
            continue

        entry_extra = {}
        if spec.get('type_field'):
            value = str(props.get(spec['type_field']) or '').strip()
            if value:
                entry_extra['type'] = value
            # `trust` gates the safety override, not whether we carry the
            # segment. An on-road stretch stays part of the route and is still
            # drawn; it just does not get to waive the rules that judge a road.
            if spec.get('trust_when'):
                entry_extra['trust'] = bool(re.search(spec['trust_when'], value, re.I))
        if spec.get('surface_field'):
            value = str(props.get(spec['surface_field']) or '').strip()
            if value:
                entry_extra['surface'] = value

        for line in lines_of(feature.get('geometry')):
            coords = round_coords(simplify(line))
            if len(coords) < 2:
                continue
            routes.append({
                'name': name or 'County bike route',
                # Kept in the schema: another county may publish a status field
                # of its own, and the readers already require 'existing'.
                'status': 'existing',
                'network': 'lcn',       # local cycling network, matching OSM's vocabulary
                'coords': coords,
                **entry_extra,
            })
    return routes, dropped


def build_traffic(spec):
    """Average daily traffic per county-road segment, with its count year.

    The year matters as much as the number. Counties re-count a road when they
    get to it, so a log can hold a 2017 count next to one from 1977, and a
    reading with no year attached would be a guess dressed up as a measurement.
    """
    fields = spec['fields']
    wanted = ['OBJECTID'] + [fields[k] for k in ('name', 'adt', 'year', 'lanes', 'speed')]
    features = fetch_layer(spec['url'], wanted)
    segments = []
    for feature in features:
        props = feature.get('properties') or {}
        adt = props.get(fields['adt'])
        if adt is None:
            continue
        for line in lines_of(feature.get('geometry')):
            coords = round_coords(simplify(line, 6.0))
            if len(coords) < 2:
                continue
            segment = {
                'name': str(props.get(fields['name']) or '').strip(),
                'adt': int(adt),
                'coords': coords,
            }
            for key in ('year', 'lanes', 'speed'):
                value = props.get(fields[key])
                if value is not None:
                    segment[key] = int(value)
            segments.append(segment)
    return segments


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--county', required=True, choices=sorted(COUNTIES),
                        help='county slug to build')
    parser.add_argument('--out', default=None, help='output path')
    args = parser.parse_args()

    spec = COUNTIES[args.county]
    out = args.out or f'data/county/{args.county}.json'
    os.makedirs(os.path.dirname(out), exist_ok=True)

    print(f'{spec["name"]} County, {spec["state"]}', flush=True)
    print('  bike network …', flush=True)
    routes, dropped = build_routes(spec['routes'])
    if spec.get('traffic'):
        print('  traffic counts …', flush=True)
        traffic = build_traffic(spec['traffic'])
    else:
        print('  traffic counts … none published by this county', flush=True)
        traffic = []

    bundle = {
        'county': spec['name'],
        'state': spec['state'],
        'fips': spec['fips'],
        'built': time.strftime('%Y-%m-%d'),
        'sources': {
            'routes': {'label': spec['routes']['label'], 'url': spec['routes']['url']},
            **({'traffic': {'label': spec['traffic']['label'], 'url': spec['traffic']['url']}}
               if spec.get('traffic') else {}),
        },
        'routes': routes,
        'traffic': traffic,
    }
    with open(out, 'w', encoding='utf-8') as handle:
        json.dump(bundle, handle, separators=(',', ':'))

    years = sorted(s['year'] for s in traffic if s.get('year'))
    print(f'\n  {out}  ({os.path.getsize(out) / 1024:.0f} KB)')
    trusted = [r for r in routes if r.get('trust', True)]
    print(f'  routes  : {len(routes)} built ({sum(miles(r["coords"]) for r in routes):.1f} mi)')
    if len(trusted) != len(routes):
        on_road = sum(miles(r['coords']) for r in routes if not r.get('trust', True))
        print(f'      of which {sum(miles(r["coords"]) for r in trusted):.1f} mi may satisfy '
              f'the rules; {on_road:.1f} mi is on ordinary road and may not')
    for reason, count in sorted(dropped.items(), key=lambda kv: -kv[1]):
        print(f'      dropped {count:3} : {reason}')
    if years:
        stale = sum(1 for y in years if y < 2010)
        print(f'  traffic : {len(traffic):,} segments, counts {years[0]}-{years[-1]}, '
              f'{stale:,} older than 2010')
    return 0


if __name__ == '__main__':
    sys.exit(main())
