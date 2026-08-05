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
  w  shoulder width, ft (OSM tag first, else WSDOT inventory; shoulder=no -> 0)
  wsh 1 = shoulder came from the WSDOT inventory (provenance for the card)
  w2 the BETTER direction's WSDOT shoulder when the two sides differ (w keeps
     the worse for the map colour; the card labels the spread)
  fo 1 = facility from the official WSDOT registry; fbw buffer ft;
     fsm separation material; fsd which side(s)
  csl county-certified surface type (CRAB road log; display only)
  n  name                   r  ref (route number)
  g  1 = on a designated bike route (USBR / regional trail)
  k  sidewalk state (1=present, 2=explicitly absent)
  u  1 = Census urban area   l  1 = WSDOT limited-access caution
  d  1 = WSDOT-enriched state-highway geometry
  ln through lanes           ctl 1 = centre turn lane
  ft typed bike facility (1 shared .. 4 separated)
  su surface class (1 paved, 2 gravel, 3 rough)
  rc numeric road class      lts WSDOT bicycle level of traffic stress (1-4)
  adt annual average daily traffic   ay year that count was taken
  asrc which inventory the count came from: 1 county road log, 2 WSDOT state
      count, 3 FHWA HPMS (modelled on non-state roads, not measured)
  es  bail-out space per side, ft (CRAB, derived); ec 1 = lane clamp applied
  cs  county-reported PAVED shoulder, ft (display only, never a rule input)
  fc  FHWA functional class 1-7      ow FHWA owner (1 state 2 county 3 town 4 city)

These last six mirror the graph exactly. Anything the router can read and the
map cannot is a card that disagrees with the colour under it.

Requires: osmium (pyosmium), shapely.
Usage: python3 scripts/build_roads.py --src data/washington-latest.osm.pbf \
                                      --out-prefix data/roads
"""
import argparse
import json
import os

import osmium
from shapely.geometry import LineString

# One decision, one home: every constant and parser this build shares with the
# routing-graph build is IMPORTED from build_graph, never restated. The two
# outputs describe the same roads to the same app, and while each file kept
# its own copies they drifted -- km/h speeds parsed differently, and
# cycleway:buffer=yes counted as buffered in the graph but plain in the tile.
from build_graph import (DEFAULT_MPH, DRIVE, EDGE_SIDEWALK, EDGE_SIDEWALK_NO,
                         FACILITY_LANE, FACILITY_PATH, LANES_CENTER_TURN,
                         LANES_COUNT_MASK, LIMITED, REF_STATE, ROAD_CLASS,
                         SIMPLIFY_DEG, WSDOT_ALWAYS_CLASSES, blts_match,
                         collect_designated, is_urban_edge, lane_class,
                         load_blts_index, load_official_index,
                         load_urban_index, official_match, osm_facility_class,
                         parse_mph, parse_shoulder_ft, sidewalk_flags,
                         surface_class)
from roadmeasure import RoadMeasures
from roadmeasure import length_m as measure_length_m

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

def build(src, out_prefix, urban_areas, blts, roadlog=None, funcclass=None,
          aadt=None, hpms=None, facilities=None):
    designated = collect_designated(src)
    urban_index = load_urban_index(urban_areas)
    measures = RoadMeasures(roadlog=roadlog, funcclass=funcclass, aadt=aadt,
                            hpms=hpms)
    wsdot_index = load_blts_index(blts)
    # The SAME typed facilities registry the routing graph reads, so the road
    # card and the router describe one facility. The input is a git-ignored
    # fetch (scripts/fetch_wsdot_graph_data.py); a build without it still
    # runs, minus the official facility enrichment.
    facility_index = None
    if facilities and os.path.exists(facilities):
        facility_index = load_official_index(facilities, 'facility')
    elif facilities:
        print(f'WARNING: {facilities} not present; building without the '
              'official facilities registry', flush=True)
    print(f'{len(designated):,} designated-route member ways', flush=True)
    feats = []
    kept = skipped_private = 0

    def wsdot_values(match):
        if match is None:
            return None
        return (match['spd'], match['sh'], match['shMax'], match['limited'],
                match['prohibited'])

    # Graph edges are split at junctions and average ~190 m, while an OSM way
    # can run for kilometres. Matching a measurement to the whole way would give
    # the tile one value where the graph has several, so the road card and the
    # route card would disagree about the same spot -- the exact failure this
    # import is supposed to be free of. Ways longer than this are measured in
    # pieces of about this length, then equal neighbours are coalesced.
    MEASURE_SPLIT_M = 250.0

    def measured_runs(coords):
        """[(run_coords, measurements)] at roughly graph-edge granularity."""
        if not measures:
            return [(coords, None)]
        if measure_length_m(coords) <= MEASURE_SPLIT_M:
            return [(coords, measures.match(coords))]
        runs = []
        chunk = [coords[0]]
        run_m = 0.0
        for a, b in zip(coords, coords[1:]):
            chunk.append(b)
            run_m += measure_length_m([a, b])
            if run_m >= MEASURE_SPLIT_M:
                runs.append(chunk)
                chunk = [b]
                run_m = 0.0
        # A single leftover point is the previous run's own endpoint, already
        # covered; only a real remaining segment becomes a run.
        if len(chunk) >= 2:
            runs.append(chunk)
        out = []
        for run in runs:
            m = measures.match(run)
            key = tuple(sorted((m or {}).items()))
            if out and out[-1][0] == key:
                out[-1][1].extend(run[1:])
            else:
                out.append([key, list(run), m])
        return [(run_coords, m) for _, run_coords, m in out]

    def add_feature(coords, base_props, match=None, meas=None):
        nonlocal kept
        cc = compact_coords(coords)
        props = dict(base_props)
        if match is not None:
            props['d'] = 1
            # Precedence mirrors build_graph exactly (its lines are the
            # reference): the card and the router must answer alike.
            # WSDOT speed fills a gap; a real OSM maxspeed tag keeps winning.
            if match['spd'] and props.get('e'):
                props['s'] = int(match['spd'])
                props.pop('e', None)
            # And WSDOT shoulder fills a gap too -- an explicit OSM tag,
            # including an explicit zero, keeps winning. `wsh` marks the
            # inventory as the source so the card can say so; `w2` carries the
            # better direction when the two sides differ, because `w` keeps
            # the worse one for the map colour and an unlabelled collapse
            # reads as a card contradicting the route.
            if match['sh'] is not None and 'w' not in props:
                props['w'] = int(match['sh'])
                props['wsh'] = 1
                if match['shMax'] is not None and int(match['shMax']) != int(match['sh']):
                    props['w2'] = int(match['shMax'])
            # A road with a bike lane or better carries no limited-access
            # caution, exactly as the graph decides it.
            if match['limited'] and int(props.get('ft') or 0) < FACILITY_LANE:
                props['l'] = 1
            if match.get('lts'):
                props['lts'] = int(match['lts'])
            if match.get('lanes') and not props.get('ln'):
                props['ln'] = int(match['lanes'])
            # The BLTS facility field is the registry photocopied on the
            # analysis date; the registry itself (matched in process_way)
            # answers the facility question for the card and the router alike.
            if match['prohibited']:
                props['b'] = 1
        if is_urban_edge(cc, urban_index):
            props['u'] = 1
        # The same measurements the graph carries, matched the same way, so the
        # tap card and the route card cannot report different numbers for one
        # road. Display only in phase 1: none of these reaches roadLevelExpr.
        m = meas
        if m:
            if m.get('adt'):
                props['adt'] = int(m['adt'])
                if m.get('adty'):
                    props['ay'] = int(m['adty'])
                if m.get('adtSrc'):
                    props['asrc'] = int(m['adtSrc'])
            if m.get('edge') is not None:
                props['es'] = round(float(m['edge']), 1)
                if m.get('edgeClamp'):
                    props['ec'] = 1
            if m.get('shP') is not None:
                props['cs'] = round(float(m['shP']), 1)
            if m.get('surfC'):
                props['csl'] = m['surfC']
            if m.get('fc'):
                props['fc'] = int(m['fc'])
            if m.get('owner'):
                props['ow'] = int(m['owner'])
        feats.append(json.dumps(
            {'type': 'Feature', 'properties': props,
             'geometry': {'type': 'LineString', 'coordinates': cc}},
            separators=(',', ':')))
        kept += 1

    def process_way(obj):
        nonlocal kept, skipped_private
        tags = {t.k: t.v for t in obj.tags}
        hw = tags.get('highway')
        if hw not in DRIVE:
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
        # Only an outright ban is "prohibited". bicycle=dismount is legal to
        # walk, and the graph routes it as a walk link; painting it as
        # bikes-banned made the map contradict the router about the same way.
        if tags.get('bicycle') == 'no':
            p['b'] = 1
        facility = osm_facility_class(tags)
        if facility:
            p['f'] = 1
            p['ft'] = facility
        # The official WSDOT facilities registry, exactly as the graph applies
        # it: typed, Status=Existing, and an official record overrides the OSM
        # tag (build_graph.py's own precedence). Shared-use paths belong on
        # path topology, and this build carries roads only.
        if facility_index:
            official = official_match(coords, tags, facility_index)
            if official is not None and official['value'] != FACILITY_PATH:
                p['f'] = 1
                p['ft'] = int(official['value'])
                p['fo'] = 1
                if official.get('bufferFt'):
                    p['fbw'] = official['bufferFt']
                if official.get('material'):
                    p['fsm'] = official['material']
                if official.get('sides'):
                    p['fsd'] = official['sides']
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
        wsdot_candidate = (hw in WSDOT_ALWAYS_CLASSES
                           or (tags.get('ref') and REF_STATE.search(tags['ref'])))
        if not wsdot_candidate:
            for run_coords, meas in measured_runs(coords):
                add_feature(run_coords, p, meas=meas)
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
            for meas_coords, meas in measured_runs(run_coords):
                add_feature(meas_coords, p, match, meas=meas)

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
    measures.report()


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default='data/washington-latest.osm.pbf')
    ap.add_argument('--out-prefix', default='data/roads')
    ap.add_argument('--urban-areas', default='data/census-urban-areas-2020-wa.geojson',
                    help='Census 2020 urban-area GeoJSON (EPSG:4326, build-only)')
    ap.add_argument('--blts', default='data/blts.geojson',
                    help='WSDOT BLTS GeoJSON used to enrich state-highway geometry')
    ap.add_argument('--roadlog', default='data/roadlog.geojson',
                    help='CRAB certified county road log (scripts/build_roadlog.py)')
    ap.add_argument('--funcclass', default='data/funcclass.geojson',
                    help='WSDOT non-state functional class (scripts/build_funcclass.py)')
    ap.add_argument('--aadt', default='data/aadt.geojson',
                    help='WSDOT traffic counts (scripts/build_aadt.py)')
    ap.add_argument('--hpms', default='data/hpms.geojson',
                    help='FHWA HPMS public release (scripts/build_hpms.py)')
    ap.add_argument('--facilities', default='data/wsdot_bike_facilities.geojson',
                    help='official WSDOT bike facilities registry '
                         '(scripts/fetch_wsdot_graph_data.py); same input the '
                         'graph build reads')
    args = ap.parse_args()
    build(args.src, args.out_prefix, args.urban_areas, args.blts,
          args.roadlog, args.funcclass, args.aadt, args.hpms, args.facilities)
