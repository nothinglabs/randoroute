#!/usr/bin/env python3
"""
Build step: routing graph for fully client-side bike routing.

Reads the OSM extract and emits data/graph.bin.gz — a compact binary graph
the browser routes over locally (A* in a web worker). No routing server.

Included edges:
  - drivable roads (same classes/filters as build_roads.py, with the same
    BNA-style speed inference), excluding bicycle=no and retaining
    bicycle=dismount as walk-bike connectors
  - rideable bike infrastructure (same keep logic as build_osm.py classify,
    excluding prohibited), including explicitly bike-designated service links
    closed to public motor traffic — flagged infra=1

One-way streets are honored for bikes (oneway / junction=roundabout, with
oneway:bicycle=no overriding; oneway=-1 reverses the edge).

Binary layout (little-endian), after header 'BGRC' + N,E,D,G,U,B (u32).
'BGRC' is format 12; the magic is four bytes, so 12 is written as the hex
digit C. Readers must keep accepting 'BGR9' (which lacks the arrays marked
"format 10"), 'BGRA' (which lacks those marked "format 11") and 'BGRB'
(which lacks those marked "format 12") — see
router-worker.js. A rider keeps routing on the graph already cached on their
phone, and the next data rebuild upgrades them without a coordinated deploy.
  nodeLon f32[N], nodeLat f32[N]
  edgeA u32[E], edgeB u32[E], edgeLen f32[E] (meters),
  edgeSpeedAB u8[E], edgeSpeedBA u8[E] (mph; 0 = separated infra),
  edgeFlags u8[E]
    (1=est speed, 2=bike facility, 4=OSM motorway/freeway, 8=infra,
     16=oneway a->b, 32=ferry crossing, 64=designated bike route),
  edgeShoulderAB i8[E], edgeShoulderBA i8[E]
    (-128 permanent prohibition, -1 unknown, else ft),
  edgeLimitedDir u8[E] (bit 0 = a->b, bit 1 = b->a),
  edgeRoadClass u8[E] (OSM highway class; 0 for infrastructure/ferries),
  edgeFacility u8[E] (0=none, 1=shared lane, 2=bike lane,
                      3=buffered lane, 4=separated lane, 5=shared-use path),
  edgeOfficial u8[E] (1=WSDOT legal speed, 2=WSDOT facility,
                      4=explicit mountain-bike path, 8=bicycle=dismount,
                      16=mapped sidewalk, 32=explicitly no sidewalk,
                      64=Census urban area),
  edgeSurface u8[E] (0=unknown, 1=paved, 2=gravel/compacted,
                     3=rough unpaved),
  edgeLanes u8[E] (format 10; bits 0-5 = through lanes, 0 = not tagged;
                   bit 6 = tagged centre turn lane. OSM `lanes`, falling back
                   to WSDOT LaneCount on state routes),
  edgeLts u8[E] (format 10; WSDOT LTS_Bicycle 1-4, 0 = no rating. State
                 highways only; WSDOT derives it from lanes, speed and volume),
  edgeEdgeSpace u8[E] (format 11; 255 = unknown, else bit 7 = the lane-width
                 clamp was applied, bits 0-6 = bail-out space PER SIDE in ft,
                 derived from the CRAB road log. This is total edge space,
                 paved or not — somewhere to go when a truck comes past — and
                 is NOT a ridable shoulder),
  edgeCountyShoulder u8[E] (format 11; 255 = unknown, else reported PAVED
                 shoulder in ft from the CRAB road log. Populated on only ~15%
                 of county segments; a blank there means "not separately
                 inventoried", not "no shoulder". Carried for display only —
                 it deliberately does not feed the shoulder rule),
  edgeAdt u16[E] (format 11; annual average daily traffic, 0 = unknown,
                 saturating at 65535),
  edgeAdtMeta u8[E] (format 11; bits 0-6 = count year minus 1940, 0 = unknown.
                 Bit 7 was a single "came from the state" flag in format 11 and
                 is unused in format 12, which needs three source values and so
                 gives them their own byte),
  edgeAdtSource u8[E] (format 12; 0 unknown, 1 county road log, 2 WSDOT state
                 count, 3 FHWA HPMS. Kept separate rather than squeezed into
                 edgeAdtMeta because the year needs all seven of its bits to
                 span 1940-2035, and because a modelled HPMS estimate is a
                 different kind of claim from a measured count -- worth a field
                 of its own rather than a spare bit),
  edgeClassOwner u8[E] (format 11; bits 0-3 = FHWA functional class 1-7,
                 0 = unclassified; bits 4-7 = FHWA roadway owner, 1 state,
                 2 county, 3 town, 4 city, 0 unknown),
  edgeHazardAB u8[E], edgeHazardBA u8[E]
    (0=none; 1-3 directional possible limited-visibility uphill curve),
  edgeHazardStartAB u16[E], edgeHazardEndAB u16[E],
  edgeHazardStartBA u16[E], edgeHazardEndBA u16[E]
    (inclusive geometry indexes for the directional warning),
  edgeGeomOff u32[E], edgeGeomCnt u16[E]  (into the geometry pool)
  outStart u32[N+1], outTarget u32[D], outEdge u32[D]   (directed CSR)
  geomLon f32[G], geomLat f32[G]  (pool; G = sum of edgeGeomCnt)

WSDOT conflation: BLTS provides measured shoulder/access-control context;
Roadway Characteristic Data provides authoritative legal speeds; and Active
Transportation Data provides typed bicycle facilities. Official attributes
are matched to OSM topology so they improve routing without creating duplicate
or disconnected linework. Permanent bike restrictions are omitted entirely.

Usage: python3 scripts/build_graph.py [--src data/washington-latest.osm.pbf]
"""
import argparse
import gzip
import json
import math
import re
import struct
import sys
from array import array

import osmium
from shapely.geometry import LineString, Point, shape
from shapely.strtree import STRtree

from roadmeasure import RoadMeasures

DRIVE = {
    'motorway', 'motorway_link', 'trunk', 'trunk_link',
    'primary', 'primary_link', 'secondary', 'secondary_link',
    'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street',
}
DEFAULT_MPH = {
    'motorway': 65, 'motorway_link': 45, 'trunk': 55, 'trunk_link': 40,
    'primary': 50, 'primary_link': 35, 'secondary': 45, 'secondary_link': 35,
    'tertiary': 35, 'tertiary_link': 30, 'unclassified': 35,
    'residential': 25, 'living_street': 15,
}
LIMITED = {'motorway', 'motorway_link'}
# Stored independently of speed: signed 25 mph arterials and residential
# streets otherwise look identical to the router.  Keep the values compact and
# stable because one byte is written for every graph edge.
ROAD_CLASS = {
    'residential': 1,
    'living_street': 2,
    'unclassified': 3,
    'tertiary': 4,
    'tertiary_link': 5,
    'secondary': 6,
    'secondary_link': 7,
    'primary': 8,
    'primary_link': 9,
    'trunk': 10,
    'trunk_link': 11,
    'motorway': 12,
    'motorway_link': 13,
}
CYCLEWAY_KEYS = ('cycleway', 'cycleway:both', 'cycleway:right', 'cycleway:left')
SIMPLIFY_DEG = 0.00005  # ~5 m — match the locally rendered road geometry
_num = re.compile(r'^\s*(\d+(?:\.\d+)?)')
# Edges eligible for WSDOT conflation: state-highway-ish classes or state refs.
WSDOT_CLASSES = {'motorway', 'motorway_link', 'trunk', 'trunk_link',
                 'primary', 'primary_link', 'secondary', 'secondary_link'}
REF_STATE = re.compile(r'(^|[;,\s])(I|US|SR|WA)[-\s]?\d+', re.I)
WSDOT_MATCH_DEG = 0.00035  # ~30 m
WSDOT_STRICT_DEG = 0.00009  # ~8–10 m; safe without a shared route number
PROHIBITED_SHOULDER = -128

# ---- format 11: the statewide road measurements, packed per edge.
# 255 means "not known", which is emphatically not the same as zero: a county
# that never separately inventoried a shoulder is not asserting there is none.
MEASURE_UNKNOWN = 255
EDGE_SPACE_CLAMPED = 128   # bit 7 of edgeEdgeSpace
# 126, not 127: 127 with the clamp bit set is 255, which is the "not known"
# sentinel. A road with 127 ft of edge space a side does not exist, but a silent
# collision between a value and "no value" is not a thing to leave in a format.
EDGE_SPACE_MAX_FT = 126
ADT_YEAR_EPOCH = 1940      # the oldest count in the CRAB log
# Format 12 moves the count's provenance into its own byte. Mirrors
# ADT_SOURCE_* in scripts/roadmeasure.py and the decoder in router-worker.js.
ADT_SOURCE_NONE = 0
ADT_SOURCE_COUNTY = 1
ADT_SOURCE_STATE = 2
ADT_SOURCE_HPMS = 3


def pack_edge_space(ft, clamped):
    if ft is None:
        return MEASURE_UNKNOWN
    value = max(0, min(EDGE_SPACE_MAX_FT, int(round(ft))))
    return value | (EDGE_SPACE_CLAMPED if clamped else 0)


def pack_county_shoulder(ft):
    if ft is None:
        return MEASURE_UNKNOWN
    return max(0, min(254, int(round(ft))))


def pack_adt_meta(year):
    if year is None:
        return 0
    offset = int(year) - ADT_YEAR_EPOCH
    return offset if 0 < offset <= 127 else 0


def pack_class_owner(functional_class, owner):
    fc = functional_class if functional_class in range(1, 8) else 0
    own = owner if owner in range(1, 5) else 0
    return (own << 4) | fc

FACILITY_NONE = 0
FACILITY_SHARED = 1
FACILITY_LANE = 2
FACILITY_BUFFERED = 3
FACILITY_SEPARATED = 4
FACILITY_PATH = 5
OFFICIAL_SPEED = 1
OFFICIAL_FACILITY = 2
# This byte has spare bits beyond the two WSDOT-source markers.  Keeping the
# MTB marker here preserves the compact BGR8 layout while making technical
# paths available to a rider-controlled runtime option instead of deleting
# them during the build.
EDGE_MTB = 4
# ``bicycle=dismount`` is distinct from ``bicycle=no``: it allows a rider to
# take a bike through the segment on foot.  Retain that access fact in an
# unused bit of the compact source/edge byte rather than expanding the binary
# layout.  The worker charges walking time plus a per-section penalty, so it
# can repair an otherwise valid trail corridor without becoming a shortcut.
EDGE_DISMOUNT = 8
# Sidewalk data is deliberately ternary.  A missing OSM tag is not evidence
# that a sidewalk is absent, while an explicit `sidewalk=no` is useful soft
# safety context.  `sidewalk=separate` still means a sidewalk is available.
EDGE_SIDEWALK = 16
EDGE_SIDEWALK_NO = 32
# Census 2020 Urban Areas distinguish built-up road context from rural roads
# without tying routing to a local jurisdiction's traffic-count feed.
EDGE_URBAN = 64

# A bridge or tunnel deck, from the OSM `bridge`/`tunnel` tags.
#
# This exists because edge_climb() below asks a TERRAIN model for elevation:
# it walks the geometry sampling a DEM, which describes the ground, not the
# structure standing over it. A flat trail deck across a gully therefore
# recorded the gully as real climb -- the Burke-Gilman bridge at Matthews
# Beach read 15%, and Mine Creek Trestle on the Palouse to Cascades read
# 37.7% on a rail-trail graded to about 2%. Downstream that is priced as a
# climb, and routes detoured off perfectly flat trail onto surface streets.
#
# It rides in eOfficial rather than eFlags because eFlags has no bit left:
# router-worker.js builds a segment's flags as `eFlags[ei] | 128` for
# limited-access, so bit 7 there already means something else to the UI.
EDGE_STRUCTURE = 128
# Three DEM pixels. Shorter than this a structure's end-to-end rise is noise,
# not slope -- see structure_climb().
STRUCTURE_MIN_GRADE_M = 80
# Surface is intentionally a tiny routing category rather than the original
# OSM string.  It lets the client prefer pavement without treating incomplete
# OSM tagging as an instruction to avoid a road.  Gravel rail trails remain
# routable; rough dirt/ground paths simply receive the stronger soft cost.
SURFACE_UNKNOWN = 0
SURFACE_PAVED = 1
SURFACE_GRAVEL = 2
SURFACE_ROUGH = 3
PAVED_SURFACES = {
    'asphalt', 'concrete', 'paved', 'paving_stones', 'sett', 'cobblestone',
    'concrete:lanes', 'concrete:plates', 'metal',
}
GRAVEL_SURFACES = {
    'gravel', 'fine_gravel', 'compacted', 'pebblestone', 'chipseal', 'wood',
}
ROUGH_SURFACES = {
    'ground', 'dirt', 'earth', 'sand', 'grass', 'mud', 'clay', 'rock',
    'rocks', 'unpaved', 'soil', 'ice', 'snow',
}
WSDOT_FACILITY_TYPE = {
    'Shared Lane': FACILITY_SHARED,
    'Bike Lane': FACILITY_LANE,
    'Buffered Bike Lane': FACILITY_BUFFERED,
    'One-Way Separated Bike Lane': FACILITY_SEPARATED,
    'Two-Way Separated Bike Lane': FACILITY_SEPARATED,
    'Shared-Use Path': FACILITY_PATH,
}


DEM_Z = 12
DEM_DIR = 'data/dem'
# A marker placed in the middle of a long OSM path otherwise snaps to a distant
# way endpoint or nearby road.  Add graph-only nodes at this spacing while
# retaining the original path geometry for display and turn-by-turn output.
PATH_SNAP_SPACING_M = 120.0

def load_dem():
    """Mosaic terrarium tiles into one int16 elevation array (meters)."""
    import glob
    import numpy as np
    from PIL import Image
    files = glob.glob(f'{DEM_DIR}/{DEM_Z}_*.png')
    if not files:
        return None
    xs, ys = set(), set()
    for f in files:
        _, x, y = f.rsplit('/', 1)[-1][:-4].split('_')
        xs.add(int(x)); ys.add(int(y))
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    W, H = (x1 - x0 + 1) * 256, (y1 - y0 + 1) * 256
    mosaic = np.zeros((H, W), dtype=np.int16)
    n = 0
    for f in files:
        _, x, y = f.rsplit('/', 1)[-1][:-4].split('_')
        x, y = int(x), int(y)
        try:
            a = np.asarray(Image.open(f).convert('RGB'), dtype=np.float32)
        except Exception:
            continue
        ele = (a[:, :, 0] * 256 + a[:, :, 1] + a[:, :, 2] / 256) - 32768
        mosaic[(y - y0) * 256:(y - y0 + 1) * 256, (x - x0) * 256:(x - x0 + 1) * 256] = \
            np.clip(ele, -32000, 32000).astype(np.int16)
        n += 1
    print(f'  DEM mosaic: {n} tiles, {W}x{H} px', flush=True)
    scale = 2 ** DEM_Z
    def ele_at(lon, lat):
        fx = (lon + 180) / 360 * scale
        fy = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * scale
        px = int((fx - x0) * 256); py = int((fy - y0) * 256)
        if 0 <= py < H and 0 <= px < W:
            return int(mosaic[py, px])
        return 0
    return ele_at


def structure_climb(coords, way_coords, ele_at):
    """(ascent, descent) for one edge of a bridge or tunnel.

    edge_climb() samples the terrain under the way. On a structure that is the
    wrong surface entirely, so take the deck instead: a straight grade between
    the ends of the whole structure -- the only two points on it that meet the
    ground -- shared out by how much of the structure this edge spans.

    The whole way matters, not this edge: a long bridge is split at its
    junction nodes, and those interior nodes hang over the gully. Measuring an
    interior edge against its own endpoints would sample mid-air.
    """
    total = line_len_m(way_coords)
    if total <= 0:
        return 0.0, 0.0
    # Below a few DEM samples there is no grade to measure. The z12 mosaic is
    # about 26 m per pixel, so a 24 m bridge is ONE pixel: its two ends can
    # land either side of the ravine and the "rise" is pure sampling artifact.
    # This is most of the residue -- of the structures still reading steep
    # after the ramp above, the median is 21 m long and the worst are 5-9 m.
    #
    # It is also the Burke-Gilman crossing at Ravenna (OSM way 4704942,
    # bridge=yes, layer=1, TWO nodes). A two-node way is nothing but its own
    # endpoints, so sharing the rise out along it changes nothing at all -- the
    # ramp and the terrain are the same measurement.
    if total < STRUCTURE_MIN_GRADE_M:
        return 0.0, 0.0
    rise = ele_at(*way_coords[-1]) - ele_at(*way_coords[0])
    delta = rise * (line_len_m(coords) / total)
    return (max(0.0, delta), max(0.0, -delta))


def edge_climb(coords, ele_at, step_m=60.0):
    """(ascent, descent) in meters going a->b, sampled every ~step_m with a
    2 m deadband to suppress DEM noise on flats."""
    # densify: walk the polyline, sampling elevation every step_m
    samples = [ele_at(coords[0][0], coords[0][1])]
    carry = 0.0
    for i in range(len(coords) - 1):
        (x1, y1), (x2, y2) = coords[i], coords[i + 1]
        seg = haversine_m(x1, y1, x2, y2)
        if seg <= 0:
            continue
        d = step_m - carry
        while d < seg:
            f = d / seg
            samples.append(ele_at(x1 + (x2 - x1) * f, y1 + (y2 - y1) * f))
            d += step_m
        carry = (carry + seg) % step_m
    samples.append(ele_at(coords[-1][0], coords[-1][1]))
    asc = des = 0.0
    ref = samples[0]
    for e in samples[1:]:
        delta = e - ref
        if delta > 2:
            asc += delta; ref = e
        elif delta < -2:
            des += -delta; ref = e
    return asc, des


def load_blts_index(path):
    """STRtree over WSDOT BLTS segments + per-segment attrs."""
    fc = json.load(open(path))
    geoms, attrs = [], []
    for f in fc['features']:
        p = f['properties']
        g = f['geometry']
        lines = [g['coordinates']] if g['type'] == 'LineString' else g['coordinates']
        for cs in lines:
            if len(cs) < 2:
                continue
            geoms.append(LineString(cs))
            identifier = str(p.get('RouteIdentifier') or '')
            suffix = identifier[-1:].lower()
            lts = p.get('LTS_Bicycle')
            lane_count = p.get('LaneCount')
            attrs.append({
                'sh': p.get('ShoulderWidth'),
                'spd': p.get('SpeedLimit'),
                'prohibited': p.get('Prohibited') == 1,
                'limited': p.get('LimitedAccess') == 1,
                'facility': bool(p.get('BikeFacilityType')),
                # WSDOT publishes a finished bicycle level-of-traffic-stress
                # rating (1 comfortable .. 4 high stress) already derived from
                # lanes, speed and volume. Carrying the rating itself is both
                # cheaper and better informed than re-deriving one from AADT.
                'lts': int(lts) if lts in (1, 2, 3, 4) else 0,
                'lanes': int(lane_count) if isinstance(lane_count, int) and 0 < lane_count <= LANES_COUNT_MASK else 0,
                'route': _route_number(identifier),
                # WSDOT stores each line from BeginARM to EndARM. Thus the
                # increasing record applies with the coordinate order and the
                # decreasing record applies against it.
                'direction': suffix if suffix in {'i', 'd'} else None,
            })
    print(f'  WSDOT index: {len(geoms):,} segments', flush=True)
    return STRtree(geoms), geoms, attrs


def load_restriction_index(path):
    """STRtree over the authoritative WSDOT permanent bike restrictions."""
    fc = json.load(open(path))
    geoms, routes = [], []
    for f in fc['features']:
        p = f['properties']
        g = f['geometry']
        lines = [g['coordinates']] if g['type'] == 'LineString' else g['coordinates']
        route = _route_number(p.get('RouteIdentifier') or p.get('Route'))
        for cs in lines:
            if len(cs) >= 2:
                geoms.append(LineString(cs))
                routes.append(route)
    print(f'  WSDOT restriction index: {len(geoms):,} segments', flush=True)
    return STRtree(geoms), geoms, routes


def load_official_index(path, kind):
    """Load official WSDOT legal-speed or bicycle-facility linework."""
    fc = json.load(open(path))
    geoms, attrs = [], []
    for feature in fc['features']:
        props = feature['properties']
        geometry = feature.get('geometry')
        if not geometry:
            continue
        if kind == 'speed':
            value = props.get('SpeedLimit')
            if not value or value <= 0:
                continue
        else:
            value = WSDOT_FACILITY_TYPE.get(props.get('BikeFacilityType'))
            if not value or props.get('Status') != 'Existing':
                continue
        lines = [geometry['coordinates']] if geometry['type'] == 'LineString' else geometry['coordinates']
        route = _route_number(props.get('RouteIdentifier'))
        for coords in lines:
            if len(coords) < 2:
                continue
            geoms.append(LineString(coords))
            attrs.append({'value': int(value), 'route': route})
    print(f'  WSDOT {kind} index: {len(geoms):,} segments', flush=True)
    return STRtree(geoms), geoms, attrs


def _route_number(value):
    m = re.search(r'\d+', str(value or ''))
    return int(m.group()) if m else None


def _route_numbers(*values):
    return {int(v) for value in values for v in re.findall(r'\d+', str(value or ''))}


def sampled_points(coords):
    """Three interior points keep nearby crossings from becoming matches."""
    line = LineString(coords)
    if line.length == 0:
        return []
    return [line.interpolate(frac, normalized=True) for frac in (0.2, 0.5, 0.8)]


def official_match(coords, tags, index, max_deg=WSDOT_MATCH_DEG):
    """Return the best official attribute matched along the edge.

    A matching route number permits normal WSDOT/OSM centerline offsets. With
    no common route number, at least two interior samples must be within the
    strict tolerance. This rejects roads that merely cross official linework.
    """
    tree, geoms, attrs = index
    points = sampled_points(coords)
    if not points:
        return None
    # Only explicit route refs relax the spatial tolerance. A numbered local
    # street name (for example, "40th Avenue") is not evidence that it is
    # WSDOT route 40.
    edge_routes = _route_numbers(tags.get('ref'))
    candidates = set()
    for point in points:
        candidates.update(int(i) for i in tree.query(point.buffer(max_deg)))
    best = None
    for gi in candidates:
        distances = [geoms[gi].distance(point) for point in points]
        same_route = attrs[gi]['route'] is not None and attrs[gi]['route'] in edge_routes
        close_count = sum(distance <= (max_deg if same_route else WSDOT_STRICT_DEG)
                          for distance in distances)
        if close_count < 2:
            continue
        score = sum(sorted(distances)[:2])
        if best is None or score < best[0]:
            best = (score, attrs[gi])
    return best[1] if best else None


def is_restricted_edge(coords, tags, index):
    """True only for a road that follows a WSDOT prohibited line.

    A near-exact match catches normal OSM/WSDOT centerline offset. A looser
    match also needs the same route number, so a legal parallel sidewalk or
    frontage road is not excluded just because it is nearby.
    """
    tree, geoms, routes = index
    edge_routes = _route_numbers(tags.get('ref'), tags.get('name'))
    strict = 0.00004  # ~4 m
    # Check every simplified geometry point, not only an edge midpoint: a
    # restriction boundary can fall inside a graph edge.
    for x, y in coords:
        point = Point(x, y)
        for gi in tree.query(point.buffer(WSDOT_MATCH_DEG)):
            distance = geoms[gi].distance(point)
            if distance <= strict:
                return True
            if distance <= WSDOT_MATCH_DEG and routes[gi] in edge_routes:
                return True
    return False


def blts_matches(coords, tags, index):
    """Best WSDOT BLTS attributes for a->b and b->a travel.

    Same discipline as official_match/is_restricted_edge: a shared route
    number permits the normal WSDOT/OSM centerline offset; otherwise at least
    two interior samples must fall within the strict tolerance. A bicycle-legal
    surface street that only passes *under* a prohibited freeway (or runs a few
    metres beside a limited-access ramp) is therefore never handed that
    freeway's prohibition, limited-access caution, shoulder, or speed. The old
    single-midpoint match at WSDOT_MATCH_DEG conflated exactly those crossings,
    which severed continuous bike routes like NE Ravenna Blvd under I-5.
    """
    tree, geoms, attrs = index
    points = sampled_points(coords)
    if not points:
        return None, None
    edge_routes = _route_numbers(tags.get('ref'))
    best = {'i': None, 'd': None, None: None}
    candidates = set()
    for point in points:
        candidates.update(int(i) for i in tree.query(point.buffer(WSDOT_MATCH_DEG)))
    for gi in candidates:
        distances = [geoms[gi].distance(point) for point in points]
        same_route = attrs[gi]['route'] is not None and attrs[gi]['route'] in edge_routes
        close_count = sum(distance <= (WSDOT_MATCH_DEG if same_route else WSDOT_STRICT_DEG)
                          for distance in distances)
        if close_count < 2:
            continue
        score = sum(sorted(distances)[:2])
        direction = attrs[gi]['direction']
        if best[direction] is None or score < best[direction][0]:
            best[direction] = (score, attrs[gi], geoms[gi])

    orientation = best['i'] or best['d'] or best[None]
    if orientation is None:
        return None, None
    line = orientation[2]
    aligned = line.project(Point(coords[-1])) >= line.project(Point(coords[0]))
    fallback = best[None][1] if best[None] else None
    increasing = best['i'][1] if best['i'] else fallback
    decreasing = best['d'][1] if best['d'] else fallback
    return (increasing, decreasing) if aligned else (decreasing, increasing)


def blts_match(coords, tags, index):
    """Return conservative display attributes across both road directions."""
    ab, ba = blts_matches(coords, tags, index)
    matches = [match for match in (ab, ba) if match is not None]
    if not matches:
        return None
    return {
        'sh': min((match['sh'] for match in matches if match['sh'] is not None),
                  default=None),
        'spd': max((match['spd'] for match in matches if match['spd']), default=None),
        'prohibited': any(match['prohibited'] for match in matches),
        'limited': any(match['limited'] for match in matches),
        'facility': any(match.get('facility') for match in matches),
        # Conservative like the shoulder and prohibition above: the two
        # inventory directions describe one roadway, so a rider sees the worse
        # of the two stress ratings rather than the friendlier one.
        'lts': max((match.get('lts') or 0 for match in matches), default=0),
        'lanes': max((match.get('lanes') or 0 for match in matches), default=0),
        'route': matches[0]['route'],
    }


def parse_mph(v):
    if not v:
        return None
    first = v.split(';')[0].strip().lower()
    m = _num.match(first)
    if not m:
        return None
    val = float(m.group(1))
    if 'km' in first or 'kph' in first:
        val *= 0.621371
    return int(round(val))


FERRY_DEFAULT_MPH = 15  # ~13 knots, when a ferry way has no duration tag


def parse_duration_s(v):
    """OSM duration: 'MM', 'HH:MM', or 'HH:MM:SS' -> seconds (None if unparseable)."""
    if not v:
        return None
    try:
        nums = [float(p) for p in v.strip().split(':')]
    except ValueError:
        return None
    if len(nums) == 1:
        return nums[0] * 60
    if len(nums) == 2:
        return nums[0] * 3600 + nums[1] * 60
    if len(nums) == 3:
        return nums[0] * 3600 + nums[1] * 60 + nums[2]
    return None


def parse_shoulder_ft(tags):
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


def sidewalk_flags(tags):
    """Compact OSM sidewalk state: present, explicitly absent, or unknown."""
    values = [tags.get('sidewalk')]
    values.extend(tags.get(key) for key in (
        'sidewalk:both', 'sidewalk:left', 'sidewalk:right'))
    values = {str(value).strip().lower() for value in values if value is not None}
    if values & {'yes', 'both', 'left', 'right', 'separate'}:
        return EDGE_SIDEWALK
    if values & {'no', 'none'}:
        return EDGE_SIDEWALK_NO
    return 0


def load_urban_index(path):
    """Load Census Urban Area polygons from an EPSG:4326 GeoJSON file."""
    fc = json.load(open(path))
    geoms = []
    for feature in fc.get('features', []):
        geometry = feature.get('geometry')
        if not geometry:
            continue
        geom = shape(geometry)
        if not geom.is_empty:
            geoms.append(geom)
    if not geoms:
        raise ValueError(f'no usable Census urban areas in {path}')
    print(f'  Census urban areas: {len(geoms):,} polygons', flush=True)
    return STRtree(geoms), geoms


def is_urban_edge(coords, index):
    """Classify an edge by its midpoint so boundary crossings stay localized."""
    if not index or len(coords) < 2:
        return False
    tree, geoms = index
    midpoint = LineString(coords).interpolate(0.5, normalized=True)
    for candidate in tree.query(midpoint):
        if geoms[int(candidate)].covers(midpoint):
            return True
    return False


def collect_designated(src):
    """Way ids on a designated bike route (OSM route=bicycle, network ncn/rcn).

    Mirrors scripts/build_routes.py: national (USBR) + regional routes, skipping
    proposed ones; nested relations resolved transitively.
    """
    ids, way_members, sub_members = set(), {}, {}
    for o in osmium.FileProcessor(src, osmium.osm.RELATION):
        t = o.tags
        if t.get('route') != 'bicycle' or t.get('network') not in ('ncn', 'rcn'):
            continue
        if t.get('state') == 'proposed':
            continue
        ids.add(o.id)
        way_members[o.id] = {m.ref for m in o.members if m.type == 'w'}
        sub_members[o.id] = {m.ref for m in o.members if m.type == 'r'}
    ways = set()
    for rid in ids:
        ways |= way_members[rid]
        stack, seen = list(sub_members[rid]), set()
        while stack:
            s = stack.pop()
            if s in seen or s not in ids:
                continue
            seen.add(s)
            ways |= way_members[s]
            stack.extend(sub_members[s])
    return ways


def collect_mtb_route_members(src):
    """Return all way members of OSM ``route=mtb`` relations.

    Some technical routes apply their MTB designation to a relation instead of
    each constituent way.  Resolve nested route relations as well so the
    runtime MTB option sees a consistent path-level marker.
    """
    ids, way_members, sub_members = set(), {}, {}
    for obj in osmium.FileProcessor(src, osmium.osm.RELATION):
        if obj.tags.get('route') != 'mtb':
            continue
        ids.add(obj.id)
        way_members[obj.id] = {member.ref for member in obj.members if member.type == 'w'}
        sub_members[obj.id] = {member.ref for member in obj.members if member.type == 'r'}
    ways = set()
    for relation_id in ids:
        ways |= way_members[relation_id]
        stack, seen = list(sub_members[relation_id]), set()
        while stack:
            nested = stack.pop()
            if nested in seen or nested not in ids:
                continue
            seen.add(nested)
            ways |= way_members[nested]
            stack.extend(sub_members[nested])
    return ways


def is_mountain_bike_way(tags, way_id, mtb_route_members):
    """Recognize direct OSM MTB tags and MTB route-relation membership."""
    return (way_id in mtb_route_members
            or 'mtb' in tags
            or any(key.startswith('mtb:') for key in tags))


def surface_class(tags):
    """Return the compact rider-facing surface category for one OSM way."""
    surface = (tags.get('surface') or '').strip().lower()
    if surface in PAVED_SURFACES:
        return SURFACE_PAVED
    if surface in GRAVEL_SURFACES:
        return SURFACE_GRAVEL
    if surface in ROUGH_SURFACES:
        return SURFACE_ROUGH
    return SURFACE_UNKNOWN


LANES_CENTER_TURN = 64   # bit 6: a two-way left-turn lane down the middle
LANES_COUNT_MASK = 63    # bits 0-5: through lanes, 0 = not tagged


def lane_class(tags):
    """Through-lane count for one way, plus a centre-turn-lane marker.

    Seattle dropped every arterial to 25 mph in 2020, so a five-lane road and a
    quiet residential street now carry the same ``maxspeed``. Lane count is what
    still separates them, and OSM tags it on essentially every way that matters:
    100% of ``secondary`` in samples from both Seattle and rural Kittitas County,
    against 3-5% of ``residential``. Absent means "small road", never "unknown
    risk", so a missing tag must leave scoring exactly as it was.
    """
    def count(key):
        raw = tags.get(key)
        if not raw:
            return None
        match = re.match(r'\s*(\d+)', str(raw))
        if not match:
            return None
        value = int(match.group(1))
        return value if 0 < value <= LANES_COUNT_MASK else None

    total = count('lanes')
    # A tagged centre turn lane is the signature of a wide suburban arterial and
    # is worth keeping even where it inflates the through-lane count.
    center = bool(tags.get('lanes:both_ways') or tags.get('turn:lanes:both_ways'))
    if total is None:
        forward, backward = count('lanes:forward'), count('lanes:backward')
        if forward is not None or backward is not None:
            # ``lanes`` counts every marked lane including the centre one, so a
            # fallback built from the directional counts has to add it back or
            # a five-lane arterial reads as four. 22 ways statewide.
            total = (forward or 0) + (backward or 0) + (1 if center else 0)
    if total is None and not center:
        return 0
    encoded = min(total or 0, LANES_COUNT_MASK)
    return encoded | (LANES_CENTER_TURN if center else 0)


def classify_way(tags):
    """Return edge attrs dict, or None to exclude from the routable graph."""
    bike = tags.get('bicycle')
    foot = tags.get('foot')
    hw = tags.get('highway')
    if bike == 'no':
        return None  # bicycle access is explicitly prohibited
    dismount = bike == 'dismount'
    # access=no/private is a blanket default that mode-specific tags override:
    # e.g. the SR 520 Trail bridge is access=no + bicycle=designated (closed to
    # general traffic, explicitly open to bikes). A numbered state/US/Interstate
    # route is public by definition, so an access=private/no tag on one is a
    # mapping error (e.g. the WA 507 bridge over the Nisqually was tagged
    # access=private, which severed the highway); keep those regardless.
    if (tags.get('access') in ('private', 'no')
            and bike not in ('yes', 'designated', 'permissive')
            and foot not in ('yes', 'designated', 'permissive')
            and not (tags.get('ref') and REF_STATE.search(tags.get('ref') or ''))):
        return None

    # Ferries (route=ferry, no highway tag): routable crossings for bikes.
    # Speed is derived from the duration tag at edge-build time; edge flag 32
    # marks them so the router prices them as a crossing, not a road.
    if tags.get('route') == 'ferry':
        if tags.get('foot') == 'private' or tags.get('motor_vehicle') == 'private':
            return None
        return {'speed': FERRY_DEFAULT_MPH, 'est': True, 'facility': FACILITY_NONE, 'lim': False,
                'infra': False, 'sh': None, 'road_class': 0, 'ferry': True,
                'duration': tags.get('duration'), 'surface': SURFACE_UNKNOWN,
                'lanes': 0, 'dismount': dismount}

    cycleways = [tags[k] for k in CYCLEWAY_KEYS if tags.get(k)]

    def osm_facility():
        values = set(cycleways)
        if values & {'track', 'separated', 'opposite_track'}:
            return FACILITY_SEPARATED
        if 'buffered_lane' in values or any(tags.get(f'{key}:buffer') == 'yes' for key in CYCLEWAY_KEYS):
            return FACILITY_BUFFERED
        if values & {'lane', 'opposite_lane'}:
            return FACILITY_LANE
        if 'shared_lane' in values:
            return FACILITY_SHARED
        return FACILITY_NONE

    # Rideable dedicated infrastructure (mirrors build_osm.py classify).
    # Tracks need explicit bike permission: a bicycle=yes track is often the
    # 70 m link that joins two halves of a rail-trail — dropping it severs
    # the trail and forces highway shoulders (Issaquah-Preston, High Point).
    # Some trails pass through plazas, transit centers, or maintenance access
    # links mapped as ``highway=service``. Keep the narrow, unambiguous subset
    # that is explicitly designated for bikes while public motor traffic is
    # prohibited. Dropping these short links can sever an otherwise continuous
    # rail-trail and force a multi-mile street detour.
    # `yes` as well as `designated`, matching path/footway/bridleway/track above.
    # Service was the only category demanding `designated`, and the difference
    # severed the Tacoma-Olympia corridor: Hoffman Hill Boulevard continues into
    # Mounts Road SW as a 9-node emergency-access link (w12189384) tagged
    # `access=no bicycle=yes foot=yes motor_vehicle=no` -- explicitly open to
    # bikes, closed to cars, and dropped. Losing those 89 m left I-5 as the only
    # link from DuPont, and with the freeway weight at 60 the router walked 45
    # extra miles around through Spanaway and Yelm.
    #
    # Statewide this admits 227 ways / 87 mi, all of them bike-permitted ways
    # that exclude motor traffic -- the same narrow combination the rule already
    # trusted, just not spelled `designated`.
    designated_bike_service = (
        hw == 'service'
        and bike in ('designated', 'yes')
        and (tags.get('motor_vehicle') in ('no', 'private')
             or tags.get('access') in ('no', 'private'))
    )
    infra = (
        hw == 'cycleway'
        or (hw == 'path' and bike in ('designated', 'yes'))
        or (hw == 'footway' and bike in ('designated', 'yes'))
        or (hw == 'bridleway' and bike in ('designated', 'yes'))
        or (hw == 'track' and bike in ('designated', 'yes'))
        or designated_bike_service
    )
    if infra:
        return {'speed': 0, 'est': False, 'facility': FACILITY_PATH, 'lim': False,
                'infra': True, 'sh': None, 'road_class': 0, 'surface': surface_class(tags),
                'lanes': 0, 'dismount': dismount}
    if hw not in DRIVE:
        return None

    spd = parse_mph(tags.get('maxspeed'))
    est = spd is None
    if est:
        spd = DEFAULT_MPH[hw]
    return {
        'speed': min(spd, 255), 'est': est,
        'facility': osm_facility(), 'lim': hw in LIMITED,
        'infra': False, 'sh': parse_shoulder_ft(tags),
        'road_class': ROAD_CLASS[hw], 'surface': surface_class(tags),
        'lanes': lane_class(tags), 'dismount': dismount,
    }


def oneway_dir(tags):
    """0 = two-way, 1 = forward only, -1 = reverse only (for bikes)."""
    if tags.get('oneway:bicycle') == 'no' or tags.get('cycleway') in ('opposite', 'opposite_lane', 'opposite_track'):
        return 0
    ow = tags.get('oneway')
    if ow in ('yes', 'true', '1') or tags.get('junction') in ('roundabout', 'circular'):
        return 1
    if ow == '-1':
        return -1
    return 0


def haversine_m(lon1, lat1, lon2, lat2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def line_len_m(coords):
    return sum(haversine_m(*coords[i], *coords[i + 1]) for i in range(len(coords) - 1))


def densify_path_nodes(points, way_id, max_spacing_m=PATH_SNAP_SPACING_M):
    """Insert graph-only path nodes so no dedicated-path edge is too long.

    OSM ways are normally split only where they join another way.  A trail can
    therefore be represented by a single multi-kilometre graph edge even
    though it visibly passes under a rider's marker.  These virtual references
    are unique to the way and only exist in the routing graph; the emitted
    geometry still follows the exact OSM line.
    """
    if len(points) < 2:
        return points
    output = [points[0]]
    serial = 0
    since_split = 0.0
    for start, end in zip(points, points[1:]):
        _, lon0, lat0 = start
        _, lon1, lat1 = end
        distance = haversine_m(lon0, lat0, lon1, lat1)
        if distance <= 0:
            output.append(end)
            continue
        traveled = 0.0
        # Most OSM path ways already have frequent shape nodes.  Splitting
        # only an individual long original segment misses the real problem:
        # thousands of short shape segments can still become one 3 km graph
        # edge.  Carry the distance since the last graph split across every
        # original segment instead.
        while distance - traveled > max_spacing_m - since_split:
            to_split = max_spacing_m - since_split
            traveled += to_split
            ratio = traveled / distance
            serial += 1
            output.append((('path-node', way_id, serial),
                           lon0 + (lon1 - lon0) * ratio,
                           lat0 + (lat1 - lat0) * ratio))
            since_split = 0.0
        since_split += distance - traveled
        output.append(end)
    return output


def is_virtual_path_node(node_ref):
    return isinstance(node_ref, tuple) and len(node_ref) == 3 and node_ref[0] == 'path-node'


def simplify_line(coords, tolerance=SIMPLIFY_DEG):
    """Small iterative Douglas-Peucker simplifier for millions of short ways.

    Constructing a Shapely geometry for every short road/path dominates graph
    build time; this keeps the same endpoint-preserving behavior with a
    lightweight planar tolerance suitable for Washington-scale coordinates.
    """
    if len(coords) <= 3:
        return coords
    keep = bytearray(len(coords)); keep[0] = keep[-1] = 1
    stack = [(0, len(coords) - 1)]
    tolerance_sq = tolerance * tolerance
    while stack:
        lo, hi = stack.pop()
        ax, ay = coords[lo]; bx, by = coords[hi]
        dx, dy = bx - ax, by - ay
        denom = dx * dx + dy * dy
        farthest, farthest_sq = -1, tolerance_sq
        for index in range(lo + 1, hi):
            px, py = coords[index]
            if denom:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / denom))
                ex, ey = px - (ax + t * dx), py - (ay + t * dy)
            else:
                ex, ey = px - ax, py - ay
            distance_sq = ex * ex + ey * ey
            if distance_sq > farthest_sq:
                farthest, farthest_sq = index, distance_sq
        if farthest >= 0:
            keep[farthest] = 1
            stack.append((lo, farthest)); stack.append((farthest, hi))
    return [coord for index, coord in enumerate(coords) if keep[index]]


def _bearing_deg(a, b):
    """Local planar bearing is sufficient for the short graph-edge windows."""
    lon1, lat1 = a; lon2, lat2 = b
    x = (lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    y = lat2 - lat1
    return math.degrees(math.atan2(x, y))


def _turn_delta(a, b):
    return abs((b - a + 180) % 360 - 180)


def _one_way_curve_hazard(coords, elevations, speed, shoulder, facility):
    """Return (severity, first-index, last-index) for travel coords[0]→[-1].

    This is intentionally a conservative *possible visibility* proxy, not a
    claim that sight distance was measured. It requires an uphill grade to
    overlap a substantial heading change, then uses speed and shoulder as the
    exposure multipliers. Intersections already split graph edges, preventing
    ordinary 90-degree junction turns from being mistaken for road curvature.
    """
    if len(coords) < 3 or speed < 30 or facility >= FACILITY_LANE:
        return 0, 0, 0
    cumulative = [0.0]
    for a, b in zip(coords, coords[1:]):
        cumulative.append(cumulative[-1] + haversine_m(*a, *b))
    if cumulative[-1] < 35:
        return 0, 0, 0
    bearings = [_bearing_deg(a, b) for a, b in zip(coords, coords[1:])]
    best = (0, 0, 0)
    for center in range(1, len(coords) - 1):
        lo = center
        while lo > 0 and cumulative[center] - cumulative[lo] < 35:
            lo -= 1
        hi = center
        while hi + 1 < len(coords) and cumulative[hi] - cumulative[center] < 35:
            hi += 1
        distance = cumulative[hi] - cumulative[lo]
        if distance < 30:
            continue
        turn = sum(_turn_delta(bearings[i - 1], bearings[i])
                   for i in range(max(1, lo + 1), min(len(bearings), hi)))
        grade = (elevations[hi] - elevations[lo]) / distance
        if turn < 30 or grade < 0.03:
            continue
        severity = 1
        if turn >= 50 or grade >= 0.05:
            severity = 2
        if turn >= 75 and grade >= 0.055:
            severity = 3
        if speed >= 45:
            severity += 1
        if shoulder >= 4:
            severity -= 2
        elif shoulder < 0:
            severity -= 1  # unknown is not the same as a known narrow shoulder
        elif shoulder <= 1 and speed >= 40:
            severity += 1
        severity = max(0, min(3, severity))
        if severity > best[0]:
            best = (severity, lo, hi)
    return best


def directional_curve_hazard(coords, ele_at, speed, shoulder, facility):
    """Directional hazard severity and geometry ranges in original order."""
    elevations = [ele_at(lon, lat) for lon, lat in coords]
    ab = _one_way_curve_hazard(coords, elevations, speed, shoulder, facility)
    ba_rev = _one_way_curve_hazard(list(reversed(coords)), list(reversed(elevations)),
                                   speed, shoulder, facility)
    if ba_rev[0]:
        ba = (ba_rev[0], len(coords) - 1 - ba_rev[2], len(coords) - 1 - ba_rev[1])
    else:
        ba = (0, 0, 0)
    return ab, ba


def build(src, out, blts=None, restrictions=None, legal_speeds=None, facilities=None,
          urban_areas=None, roadlog=None, funcclass=None, aadt=None, hpms=None):
    wsdot = load_blts_index(blts) if blts else None
    # The statewide measurements: traffic volume and bail-out space off the
    # state highway system, where until now we had nothing but estimates.
    print('loading road measurements...', flush=True)
    measures = RoadMeasures(roadlog=roadlog, funcclass=funcclass, aadt=aadt,
                            hpms=hpms)
    restriction_index = load_restriction_index(restrictions) if restrictions else None
    speed_index = load_official_index(legal_speeds, 'speed') if legal_speeds else None
    facility_index = load_official_index(facilities, 'facility') if facilities else None
    urban_index = load_urban_index(urban_areas) if urban_areas else None
    ele_at = load_dem()
    if ele_at is None:
        print('  WARNING: no DEM tiles found — building without elevation', flush=True)
        ele_at = lambda lon, lat: 0
    # ---- pass 0: route-relation membership
    print('pass 0: designated and mountain-bike route relations...', flush=True)
    designated = collect_designated(src)
    mtb_route_members = collect_mtb_route_members(src)
    print(f'  {len(designated):,} designated member ways; {len(mtb_route_members):,} MTB member ways', flush=True)

    # ---- pass 1: which ways are kept; count node references to find junctions
    print('pass 1: scanning ways...', flush=True)
    refcount = {}
    kept_ways = 0
    def count_way_refs(obj):
        nonlocal kept_ways
        tags = {t.k: t.v for t in obj.tags}
        if classify_way(tags) is None:
            return
        kept_ways += 1
        refs = [n.ref for n in obj.nodes]
        for r in refs:
            refcount[r] = refcount.get(r, 0) + 1
        # endpoints always split points
        if refs:
            refcount[refs[0]] += 1
            refcount[refs[-1]] += 1

    class RefcountHandler(osmium.SimpleHandler):
        def way(self, obj):
            count_way_refs(obj)

    RefcountHandler().apply_file(src, locations=False)
    print(f'  kept {kept_ways:,} ways, {len(refcount):,} referenced nodes', flush=True)

    # ---- pass 2: build edges split at junctions
    print('pass 2: building edges...', flush=True)
    node_index = {}          # osm node id -> graph node index
    node_lon = array('f'); node_lat = array('f')
    eA = array('I'); eB = array('I'); eLen = array('f')
    eSpeed = array('B'); eSpeedBA = array('B'); eFlags = array('B')
    eSh = array('b'); eShBA = array('b'); eLimitedDir = array('B')
    eClass = array('B')
    eFacility = array('B'); eOfficial = array('B'); eSurface = array('B')
    eHazAB = array('B'); eHazBA = array('B')
    eLanes = array('B'); eLts = array('B')
    eEdgeSpace = array('B'); eCountyShoulder = array('B')
    eAdt = array('H'); eAdtMeta = array('B'); eClassOwner = array('B')
    eAdtSource = array('B')
    eHazStartAB = array('H'); eHazEndAB = array('H')
    eHazStartBA = array('H'); eHazEndBA = array('H')
    eOff = array('I'); eCnt = array('H')
    eAsc = array('H'); eDes = array('H')   # meters of climb a->b / descent a->b
    nEle = array('h')                       # node elevation, meters
    gLon = array('f'); gLat = array('f')

    def gnode(osmid, lon, lat):
        i = node_index.get(osmid)
        if i is None:
            i = len(node_lon)
            node_index[osmid] = i
            node_lon.append(lon); node_lat.append(lat)
            nEle.append(ele_at(lon, lat))
        return i

    # Per-edge road/ferry name (deduped string table; empty string id 0).
    name_ids = {'': 0}
    name_list = ['']
    eName = array('I')

    def name_idx(s):
        s = (s or '').strip()[:60]
        i = name_ids.get(s)
        if i is None:
            i = len(name_list)
            name_ids[s] = i
            name_list.append(s)
        return i

    oneway_arcs = 0
    conflated = [0]
    official_speeds = [0]
    official_facilities = [0]
    restricted_edges = [0]
    hazard_edges = [0]
    mtb_edges = [0]
    densified_paths = [0]
    # ``FileProcessor(...).with_locations()`` only works when Python also
    # iterates every source node, which is extremely slow for this statewide
    # extract.  SimpleHandler keeps the location index in libosmium and streams
    # each completed way directly into the existing edge builder.
    def process_way(obj):
        nonlocal oneway_arcs
        tags = {t.k: t.v for t in obj.tags}
        attrs = classify_way(tags)
        if attrs is None:
            return
        attrs['mtb'] = is_mountain_bike_way(tags, obj.id, mtb_route_members)
        pts = [(n.ref, n.location.lon, n.location.lat) for n in obj.nodes if n.location.valid()]
        if len(pts) < 2:
            return
        if attrs['infra']:
            expanded = densify_path_nodes(pts, obj.id)
            if len(expanded) > len(pts):
                densified_paths[0] += 1
                pts = expanded
        ow = oneway_dir(tags)
        if ow == -1:
            pts = pts[::-1]
            ow = 1

        # The structure end to end, after any reversal above, so
        # structure_climb() measures the deck between the points where it
        # meets the ground rather than between two nodes hanging over a gully.
        way_coords = [(x, y) for _, x, y in pts]

        is_ferry = attrs.get('ferry', False)
        if is_ferry:
            # Crossing speed from the whole-way duration; keep the default for
            # missing/garbled tags (sanity-check the implied speed).
            dur_s = parse_duration_s(attrs.get('duration'))
            if dur_s and dur_s > 60:
                mph = (line_len_m([(x, y) for _, x, y in pts]) / 1609.34) / (dur_s / 3600.0)
                if 3 <= mph <= 45:
                    attrs['speed'] = int(round(mph))
                    attrs['est'] = False

        wsdot_candidate = (
            wsdot is not None and not attrs['infra'] and not is_ferry
            and (tags.get('highway') in {'motorway', 'motorway_link', 'trunk', 'trunk_link'}
                 or (tags.get('ref') and REF_STATE.search(tags['ref'])))
        )

        # `bridge=viaduct`, `bridge=trestle`, `tunnel=building_passage` and so
        # on are all structures; test the KEY, not the value. Only an explicit
        # "no" means the way is on the ground.
        is_structure = ((tags.get('bridge') not in (None, 'no'))
                        or (tags.get('tunnel') not in (None, 'no')))

        flags = ((1 if attrs['est'] else 0) | (2 if attrs['facility'] else 0)
                 | (4 if attrs['lim'] else 0) | (8 if attrs['infra'] else 0)
                 | (16 if ow == 1 else 0) | (32 if is_ferry else 0)
                 | (64 if obj.id in designated else 0))
        sh = -1 if attrs['sh'] is None else max(-1, min(127, attrs['sh']))

        seg = [pts[0]]
        for p in pts[1:]:
            seg.append(p)
            if (refcount.get(p[0], 0) >= 2 or is_virtual_path_node(p[0])
                    or wsdot_candidate or p is pts[-1]):
                coords = [(x, y) for _, x, y in seg]
                if len(coords) >= 2:
                    length = line_len_m(coords)
                    if length > 0.5:
                        if len(coords) > 3:
                            coords = simplify_line(coords)
                        a = gnode(seg[0][0], *coords[0])
                        b = gnode(seg[-1][0], *coords[-1])
                        if a != b or length > 10:  # drop degenerate micro-loops
                            espeed, espeed_ba = attrs['speed'], attrs['speed']
                            esh, esh_ba, eflags = sh, sh, flags
                            limited_dir = 0
                            efacility = attrs['facility']
                            elanes = attrs.get('lanes', 0)
                            elts = 0
                            eofficial = ((EDGE_STRUCTURE if is_structure else 0)
                                         | (EDGE_MTB if attrs['mtb'] else 0)
                                         | (EDGE_DISMOUNT if attrs.get('dismount') else 0)
                                         | sidewalk_flags(tags)
                                         | (EDGE_URBAN if is_urban_edge(coords, urban_index) else 0))
                            if (restriction_index and not attrs['infra']
                                    and is_restricted_edge(coords, tags, restriction_index)):
                                restricted_edges[0] += 1
                                seg = [p]
                                continue  # WSDOT permanent bike restriction
                            if wsdot_candidate:
                                match_ab, match_ba = blts_matches(coords, tags, wsdot)
                                if match_ab is not None or match_ba is not None:
                                    for direction, match in enumerate((match_ab, match_ba)):
                                        if match is None:
                                            continue
                                        if match['prohibited']:
                                            if direction == 0:
                                                esh = PROHIBITED_SHOULDER
                                            else:
                                                esh_ba = PROHIBITED_SHOULDER
                                        elif match['sh'] is not None:
                                            shoulder = max(-1, min(127, int(match['sh'])))
                                            if direction == 0:
                                                esh = shoulder
                                            else:
                                                esh_ba = shoulder
                                        if match['spd'] and (eflags & 1):
                                            speed = min(int(match['spd']), 255)
                                            if direction == 0:
                                                espeed = speed
                                            else:
                                                espeed_ba = speed
                                        if match['limited'] and efacility < FACILITY_LANE:
                                            limited_dir |= 1 << direction
                                        # The two inventory directions describe
                                        # one roadway, so take the worse rating
                                        # and the wider cross-section.
                                        if match['lts'] > elts:
                                            elts = match['lts']
                                        if not (elanes & LANES_COUNT_MASK) and match['lanes']:
                                            elanes |= min(match['lanes'], LANES_COUNT_MASK)
                                    if ((match_ab and match_ab['spd'])
                                            or (match_ba and match_ba['spd'])):
                                        eflags &= ~1  # measured, not estimated
                                    conflated[0] += 1
                            if speed_index and not attrs['infra'] and not is_ferry:
                                match = official_match(coords, tags, speed_index)
                                if match is not None:
                                    espeed = min(match['value'], 255)
                                    espeed_ba = espeed
                                    eflags &= ~1
                                    eofficial |= OFFICIAL_SPEED
                                    official_speeds[0] += 1
                            if facility_index and not is_ferry:
                                match = official_match(coords, tags, facility_index)
                                if match is not None:
                                    official_type = match['value']
                                    # Shared-use paths belong on OSM path topology;
                                    # on-street facilities belong on road topology.
                                    compatible = ((official_type == FACILITY_PATH) == bool(attrs['infra']))
                                    if compatible:
                                        efacility = official_type
                                        eflags |= 2
                                        eofficial |= OFFICIAL_FACILITY
                                        official_facilities[0] += 1
                                        if efacility >= FACILITY_LANE:
                                            limited_dir = 0
                            # ---- format 11: statewide measurements.
                            # Deliberately after the WSDOT block and deliberately
                            # not written into esh: phase 1 shows these numbers
                            # and changes no verdict. The county's paved shoulder
                            # travels in its own field precisely so that adding
                            # it here cannot quietly move a road across a rule.
                            e_space = MEASURE_UNKNOWN
                            e_county_sh = MEASURE_UNKNOWN
                            e_adt = 0
                            e_adt_meta = 0
                            e_adt_source = 0
                            e_class_owner = 0
                            if measures and not is_ferry:
                                m = measures.match(coords)
                                if m:
                                    e_space = pack_edge_space(m.get('edge'),
                                                              m.get('edgeClamp'))
                                    e_county_sh = pack_county_shoulder(m.get('shP'))
                                    e_adt = max(0, min(65535, int(m.get('adt') or 0)))
                                    e_adt_meta = pack_adt_meta(m.get('adty'))
                                    e_adt_source = int(m.get('adtSrc') or 0)
                                    e_class_owner = pack_class_owner(
                                        m.get('fc'), m.get('owner'))
                            if is_ferry:
                                asc, des = 0.0, 0.0
                            elif is_structure:
                                # A deck is a straight grade between its own
                                # ends, which are the only two points on it
                                # that sit on the ground the DEM describes.
                                # Everything between is what the bridge exists
                                # to ignore.
                                asc, des = structure_climb(coords, way_coords, ele_at)
                            else:
                                asc, des = edge_climb(coords, ele_at)
                            if is_ferry or attrs['infra']:
                                haz_ab = haz_ba = (0, 0, 0)
                            else:
                                hazard_speed = max(espeed, espeed_ba)
                                known_shoulders = [value for value in (esh, esh_ba) if value >= 0]
                                hazard_shoulder = min(known_shoulders) if known_shoulders else -1
                                haz_ab, haz_ba = directional_curve_hazard(
                                    coords, ele_at, hazard_speed, hazard_shoulder, efacility)
                            geom_off = len(gLon)
                            geom_cnt = min(len(coords), 65535)
                            for x, y in coords[:geom_cnt]:
                                gLon.append(x); gLat.append(y)

                            def append_edge(edge_flags, edge_speed, edge_speed_ba,
                                            edge_sh, edge_sh_ba, edge_limited_dir,
                                            edge_class, edge_facility, edge_official, edge_surface,
                                            edge_lanes, edge_lts,
                                            edge_space, edge_county_sh, edge_adt,
                                            edge_adt_meta, edge_adt_source,
                                            edge_class_owner,
                                            edge_asc, edge_des, ab, ba):
                                eAsc.append(min(int(edge_asc), 65535)); eDes.append(min(int(edge_des), 65535))
                                eA.append(a); eB.append(b); eLen.append(length)
                                eSpeed.append(edge_speed); eSpeedBA.append(edge_speed_ba)
                                eFlags.append(edge_flags)
                                eSh.append(edge_sh); eShBA.append(edge_sh_ba)
                                eLimitedDir.append(edge_limited_dir)
                                eClass.append(edge_class)
                                eFacility.append(edge_facility); eOfficial.append(edge_official)
                                eSurface.append(edge_surface)
                                eLanes.append(edge_lanes); eLts.append(edge_lts)
                                eEdgeSpace.append(edge_space)
                                eCountyShoulder.append(edge_county_sh)
                                eAdt.append(edge_adt); eAdtMeta.append(edge_adt_meta)
                                eAdtSource.append(edge_adt_source)
                                eClassOwner.append(edge_class_owner)
                                eHazAB.append(ab[0]); eHazBA.append(ba[0])
                                eHazStartAB.append(ab[1]); eHazEndAB.append(ab[2])
                                eHazStartBA.append(ba[1]); eHazEndBA.append(ba[2])
                                eName.append(name_idx(tags.get('name') or tags.get('ref')))
                                eOff.append(geom_off); eCnt.append(geom_cnt)

                            append_edge(eflags, espeed, espeed_ba, esh, esh_ba, limited_dir,
                                        attrs['road_class'], efacility, eofficial, attrs['surface'],
                                        elanes, elts,
                                        e_space, e_county_sh, e_adt, e_adt_meta,
                                        e_adt_source, e_class_owner,
                                        asc, des, haz_ab, haz_ba)
                            if attrs['mtb']:
                                mtb_edges[0] += 1
                            if haz_ab[0] or haz_ba[0]:
                                hazard_edges[0] += 1
                            if ow == 1:
                                oneway_arcs += 1
                seg = [p]

    class GraphWayHandler(osmium.SimpleHandler):
        def way(self, obj):
            process_way(obj)

    GraphWayHandler().apply_file(src, locations=True)

    N, E, G = len(node_lon), len(eA), len(gLon)
    print(f'  nodes {N:,}  edges {E:,}  geom vertices {G:,}  oneway edges {oneway_arcs:,}', flush=True)
    print(f'  WSDOT-conflated edges: {conflated[0]:,}; direct restrictions excluded: {restricted_edges[0]:,}', flush=True)
    print(f'  official legal speeds: {official_speeds[0]:,}; official facilities: {official_facilities[0]:,}', flush=True)
    print(f'  MTB-tagged edges: {mtb_edges[0]:,}; dedicated paths densified for snapping: {densified_paths[0]:,}', flush=True)
    measures.report()
    print(f'  directional curve-warning edges: {hazard_edges[0]:,}', flush=True)

    # ---- directed CSR adjacency
    print('building adjacency...', flush=True)
    deg = array('I', bytes(4 * (N)))
    for i in range(E):
        deg[eA[i]] += 1
        if not (eFlags[i] & 16):
            deg[eB[i]] += 1
    outStart = array('I', bytes(4 * (N + 1)))
    s = 0
    for i in range(N):
        outStart[i] = s
        s += deg[i]
    outStart[N] = s
    D = s
    outTarget = array('I', bytes(4 * D)); outEdge = array('I', bytes(4 * D))
    cursor = array('I', outStart[:N])
    for i in range(E):
        a, b = eA[i], eB[i]
        c = cursor[a]; outTarget[c] = b; outEdge[c] = i; cursor[a] = c + 1
        if not (eFlags[i] & 16):
            c = cursor[b]; outTarget[c] = a; outEdge[c] = i; cursor[b] = c + 1
    print(f'  directed arcs {D:,}', flush=True)

    # ---- write
    print('writing...', flush=True)
    # Name string table: per-edge u32 index -> [offsets u32[U+1]] + utf-8 blob.
    name_blob = bytearray()
    name_offs = array('I', [0])
    for s in name_list:
        name_blob += s.encode('utf-8')
        name_offs.append(len(name_blob))
    U, B = len(name_list), len(name_blob)
    print(f'  names: {U:,} unique, blob {B:,} bytes', flush=True)

    for arr in (node_lon, node_lat, nEle, eA, eB, eLen, eAsc, eDes,
                eSpeed, eSpeedBA, eFlags, eSh, eShBA, eLimitedDir, eClass,
                eFacility, eOfficial, eSurface, eLanes, eLts, eHazAB, eHazBA,
                eHazStartAB, eHazEndAB, eHazStartBA, eHazEndBA,
                eName, name_offs, eOff, eCnt, outStart, outTarget, outEdge, gLon, gLat):
        if sys.byteorder == 'big':
            arr.byteswap()
    # JS typed-array views need 4-byte alignment: pad after the byte arrays
    # and after the u16 arrays. The name blob goes LAST
    # so everything before it stays aligned.
    parts = [b'BGRC', struct.pack('<IIIIII', N, E, D, G, U, B),
             node_lon.tobytes(), node_lat.tobytes(), nEle.tobytes()]
    off = sum(len(p) for p in parts)
    parts.append(b'\x00' * ((4 - off % 4) % 4))
    parts += [eA.tobytes(), eB.tobytes(), eLen.tobytes(),
              eAsc.tobytes(), eDes.tobytes(),
              eSpeed.tobytes(), eSpeedBA.tobytes(), eFlags.tobytes(),
              eSh.tobytes(), eShBA.tobytes(), eLimitedDir.tobytes(),
              eClass.tobytes(),
              eFacility.tobytes(), eOfficial.tobytes(), eSurface.tobytes(),
              eLanes.tobytes(), eLts.tobytes(),
              eEdgeSpace.tobytes(), eCountyShoulder.tobytes()]
    # edgeAdt is u16, and the reader takes a typed-array view straight onto the
    # buffer, so this offset has to be even. Fourteen u8[E] arrays precede it
    # from a 4-aligned start, which is always even -- assert rather than pad
    # conditionally, because a pad the reader does not also apply is silent
    # corruption of every field after it.
    assert sum(len(p) for p in parts) % 2 == 0, 'edgeAdt must start 2-byte aligned'
    parts += [eAdt.tobytes(), eAdtMeta.tobytes(), eAdtSource.tobytes(),
              eClassOwner.tobytes(),
              eHazAB.tobytes(), eHazBA.tobytes()]
    off = sum(len(p) for p in parts)
    parts.append(b'\x00' * ((2 - off % 2) % 2))
    parts += [eHazStartAB.tobytes(), eHazEndAB.tobytes(),
              eHazStartBA.tobytes(), eHazEndBA.tobytes()]
    off = sum(len(p) for p in parts)
    parts.append(b'\x00' * ((4 - off % 4) % 4))
    parts.append(eOff.tobytes())
    parts.append(eCnt.tobytes())
    off = sum(len(p) for p in parts)
    parts.append(b'\x00' * ((4 - off % 4) % 4))
    parts += [outStart.tobytes(), outTarget.tobytes(), outEdge.tobytes(),
              eName.tobytes(), name_offs.tobytes(),
              gLon.tobytes(), gLat.tobytes(), bytes(name_blob)]
    raw = b''.join(parts)
    with gzip.open(out, 'wb', compresslevel=9) as f:
        f.write(raw)
    import os
    print(f'raw {len(raw):,} bytes -> {out} {os.path.getsize(out):,} bytes gz', flush=True)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default='data/washington-latest.osm.pbf')
    ap.add_argument('--out', default='data/graph2.bin.gz')
    ap.add_argument('--blts', default='data/blts.geojson',
                    help='WSDOT BLTS geojson for shoulder/speed/prohibition conflation')
    ap.add_argument('--restrictions', default='data/bike_restrictions.geojson',
                    help='WSDOT permanent bike restrictions geojson for hard graph exclusion')
    ap.add_argument('--legal-speeds', default='data/wsdot_legal_speeds.geojson',
                    help='WSDOT Roadway Characteristic legal-speed GeoJSON')
    ap.add_argument('--facilities', default='data/wsdot_bike_facilities.geojson',
                    help='WSDOT existing bicycle-facility GeoJSON')
    ap.add_argument('--urban-areas', default='data/census-urban-areas-2020-wa.geojson',
                    help='Census 2020 urban-area GeoJSON (EPSG:4326, build-only)')
    ap.add_argument('--roadlog', default='data/roadlog.geojson',
                    help='CRAB certified county road log (scripts/build_roadlog.py)')
    ap.add_argument('--funcclass', default='data/funcclass.geojson',
                    help='WSDOT non-state functional class (scripts/build_funcclass.py)')
    ap.add_argument('--aadt', default='data/aadt.geojson',
                    help='WSDOT traffic counts (scripts/build_aadt.py)')
    ap.add_argument('--hpms', default='data/hpms.geojson',
                    help='FHWA HPMS public release (scripts/build_hpms.py)')
    args = ap.parse_args()
    build(args.src, args.out, args.blts, args.restrictions, args.legal_speeds, args.facilities,
          args.urban_areas, args.roadlog, args.funcclass, args.aadt, args.hpms)
