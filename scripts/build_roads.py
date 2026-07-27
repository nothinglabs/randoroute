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
  g  1 = on a designated bike route (USBR / regional trail)
  k  sidewalk state (1=present, 2=explicitly absent)
  u  1 = Census urban area   l  1 = WSDOT limited-access caution
  d  1 = WSDOT-enriched state-highway geometry
  ln through lanes           ctl 1 = centre turn lane
  ft typed bike facility (1 shared .. 4 separated)
  su surface class (1 paved, 2 gravel, 3 rough)
  rc numeric road class      lts WSDOT bicycle level of traffic stress (1-4)

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
# Same ladder build_graph stores per edge, so the street card and the route card
# describe one road the same way instead of "yes" versus "Buffered bike lane".
OSM_FACILITY = {
    'shared_lane': 1,
    'lane': 2, 'opposite_lane': 2,
    'buffered_lane': 3,
    'track': 4, 'separated': 4, 'opposite_track': 4,
}

SIMPLIFY_DEG = 0.00005   # ~5 m
COORD_DECIMALS = 5
# A closed ring is a traffic circle, roundabout, or loop. Douglas-Peucker
# measures deviation from the chord joining the retained end points, and on a
# ring those are the same point, so a circle smaller across than the tolerance
# has nothing to measure against and collapses. Seattle's 8-13 m traffic circles
# all did: they reduced to a triangle or a there-and-back spike and drew on the
# map as arrowheads sitting in the intersection. Rings are 1.4% of Washington's
# ways, so keeping them verbatim - at the finer precision their size needs - is
# effectively free.
RING_COORD_DECIMALS = 6
# An open way must not be simplified by more than a fraction of its own size
# either, or a short connector (including the approach arcs of a circle that is
# mapped as several ways rather than one ring) straightens into its chord.
MAX_SIMPLIFY_FRACTION = 8
MAX_FILE_BYTES = 55 * 1024 * 1024  # split well under GitHub's 100 MB limit


def compact_coords(coords):
    """Drop redundant vertices without letting a feature lose its shape."""
    closed = len(coords) > 3 and tuple(coords[0]) == tuple(coords[-1])
    line = LineString(coords)
    if len(coords) > 3 and not closed:
        xs = [x for x, _ in coords]
        ys = [y for _, y in coords]
        extent = max(max(xs) - min(xs), max(ys) - min(ys))
        tolerance = min(SIMPLIFY_DEG, extent / MAX_SIMPLIFY_FRACTION)
        if tolerance > 0:
            line = line.simplify(tolerance, preserve_topology=False)
    decimals = RING_COORD_DECIMALS if closed else COORD_DECIMALS
    return [[round(x, decimals), round(y, decimals)] for x, y in line.coords]

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


def build(src, out_prefix, urban_areas, blts):
    from build_graph import (EDGE_SIDEWALK, EDGE_SIDEWALK_NO, EDGE_URBAN,
                             LANES_CENTER_TURN, LANES_COUNT_MASK, ROAD_CLASS,
                             blts_match, collect_designated, is_urban_edge,
                             lane_class, load_blts_index, load_urban_index,
                             sidewalk_flags, surface_class)
    designated = collect_designated(src)
    urban_index = load_urban_index(urban_areas)
    wsdot_index = load_blts_index(blts)
    print(f'{len(designated):,} designated-route member ways', flush=True)
    feats = []
    kept = skipped_private = 0

    def wsdot_values(match):
        if match is None:
            return None
        return (match['spd'], match['sh'], match['limited'],
                match['facility'], match['prohibited'])

    def add_feature(coords, base_props, match=None):
        nonlocal kept
        cc = compact_coords(coords)
        props = dict(base_props)
        if match is not None:
            props['d'] = 1
            if match['spd']:
                props['s'] = int(match['spd'])
                props.pop('e', None)
            if match['sh'] is not None:
                props['w'] = int(match['sh'])
            if match['limited']:
                props['l'] = 1
            if match.get('lts'):
                props['lts'] = int(match['lts'])
            if match.get('lanes') and not props.get('ln'):
                props['ln'] = int(match['lanes'])
            if match['facility']:
                props['f'] = 1
            if match['prohibited']:
                props['b'] = 1
        if is_urban_edge(cc, urban_index):
            props['u'] = 1
        feats.append(json.dumps(
            {'type': 'Feature', 'properties': props,
             'geometry': {'type': 'LineString', 'coordinates': cc}},
            separators=(',', ':')))
        kept += 1

    def process_way(obj):
        nonlocal kept, skipped_private
        tags = {t.k: t.v for t in obj.tags}
        hw = tags.get('highway')
        if hw not in CLASSES:
            return
        # Mode-specific tags override the blanket access default: keep roads
        # closed to general traffic but explicitly open to bikes.
        if tags.get('access') in ('private', 'no') and \
                tags.get('bicycle') not in ('yes', 'designated', 'permissive'):
            skipped_private += 1
            return

        coords = [(nd.location.lon, nd.location.lat) for nd in obj.nodes if nd.location.valid()]
        if len(coords) < 2:
            return
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
        facility = 0
        for k in CYCLEWAY_KEYS:
            facility = max(facility, OSM_FACILITY.get(tags.get(k), 0))
        if facility:
            p['f'] = 1
            p['ft'] = facility
        surface = surface_class(tags)
        if surface:
            p['su'] = surface
        if hw in ROAD_CLASS:
            p['rc'] = ROAD_CLASS[hw]
        # Lane count is the signal that still separates a de-facto arterial
        # from a side street where a city has signed both at the same speed.
        lanes = lane_class(tags)
        if lanes:
            p['ln'] = lanes & LANES_COUNT_MASK
            if lanes & LANES_CENTER_TURN:
                p['ctl'] = 1
        w = parse_shoulder_ft(tags)
        if w is not None:
            p['w'] = w
        if tags.get('name'):
            p['n'] = tags['name']
        if tags.get('ref'):
            p['r'] = tags['ref']
        if obj.id in designated:
            p['g'] = 1  # on a designated bike route (USBR / regional trail)
        sidewalk = sidewalk_flags(tags)
        if sidewalk & EDGE_SIDEWALK:
            p['k'] = 1
        elif sidewalk & EDGE_SIDEWALK_NO:
            p['k'] = 2
        wsdot_candidate = (hw in {'motorway', 'motorway_link', 'trunk', 'trunk_link'}
                           or (tags.get('ref') and REF_STATE.search(tags['ref'])))
        if not wsdot_candidate:
            add_feature(coords, p)
            return

        # Match each OSM node interval before coalescing equal runs. WSDOT
        # shoulder records can change inside one long OSM way; matching the
        # whole way selected whichever inventory record covered most of it and
        # misplaced the boundary by hundreds of feet.
        runs = []
        for start, end in zip(coords, coords[1:]):
            match = blts_match([start, end], tags, wsdot_index)
            signature = wsdot_values(match)
            if runs and runs[-1][0] == signature:
                runs[-1][1].append(end)
            else:
                runs.append([signature, [start, end], match])
        for _, run_coords, match in runs:
            add_feature(run_coords, p, match)

    class RoadsHandler(osmium.SimpleHandler):
        def way(self, obj):
            process_way(obj)

    # SimpleHandler keeps node locations in libosmium and calls Python only
    # for completed ways. FileProcessor also materialized hundreds of millions
    # of unrelated nodes/relations as Python objects and made this build take
    # many times longer without changing its result.
    RoadsHandler().apply_file(src, locations=True)

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
    ap.add_argument('--urban-areas', default='data/census-urban-areas-2020-wa.geojson',
                    help='Census 2020 urban-area GeoJSON (EPSG:4326, build-only)')
    ap.add_argument('--blts', default='data/blts.geojson',
                    help='WSDOT BLTS GeoJSON used to enrich state-highway geometry')
    args = ap.parse_args()
    build(args.src, args.out_prefix, args.urban_areas, args.blts)
