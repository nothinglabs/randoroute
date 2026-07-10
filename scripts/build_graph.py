#!/usr/bin/env python3
"""
Build step: routing graph for fully client-side bike routing.

Reads the OSM extract and emits data/graph.bin.gz — a compact binary graph
the browser routes over locally (A* in a web worker). No routing server.

Included edges:
  - drivable roads (same classes/filters as build_roads.py, with the same
    BNA-style speed inference), EXCLUDING bicycle=no/dismount (illegal)
  - rideable bike infrastructure (same keep logic as build_osm.py classify,
    excluding prohibited) — flagged infra=1

One-way streets are honored for bikes (oneway / junction=roundabout, with
oneway:bicycle=no overriding; oneway=-1 reverses the edge).

Binary layout (little-endian), after 16-byte header 'BGR1' + N,E,D (u32):
  nodeLon f32[N], nodeLat f32[N]
  edgeA u32[E], edgeB u32[E], edgeLen f32[E] (meters),
  edgeSpeed u8[E] (mph; 0 = separated infra), edgeFlags u8[E]
    (1=est speed, 2=bike facility, 4=limited access, 8=infra, 16=oneway a->b,
     32=ferry crossing),
  edgeShoulder i8[E] (-1 unknown, else ft),
  edgeGeomOff u32[E], edgeGeomCnt u16[E]  (into the geometry pool)
  outStart u32[N+1], outTarget u32[D], outEdge u32[D]   (directed CSR)
  geomLon f32[G], geomLat f32[G]  (pool; G = sum of edgeGeomCnt)

WSDOT conflation: the map's WSDOT layer fails roads on MEASURED shoulder
width that OSM doesn't have — without it the router would happily use roads
the map shows as failing. For state-highway edges we spatially match the
nearest WSDOT BLTS segment (within ~30 m) and adopt its measured shoulder,
real speed limit, and bikes-prohibited flag, so routing and the map agree.

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
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

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
FACILITY = {'lane', 'shared_lane', 'buffered_lane', 'track', 'separated',
            'opposite_lane', 'opposite_track'}
CYCLEWAY_KEYS = ('cycleway', 'cycleway:both', 'cycleway:right', 'cycleway:left')
SIMPLIFY_DEG = 0.00012  # ~12 m — route display geometry
_num = re.compile(r'^\s*(\d+(?:\.\d+)?)')
# Edges eligible for WSDOT conflation: state-highway-ish classes or state refs.
WSDOT_CLASSES = {'motorway', 'motorway_link', 'trunk', 'trunk_link',
                 'primary', 'primary_link', 'secondary', 'secondary_link'}
REF_STATE = re.compile(r'(^|[;,\s])(I|US|SR|WA)[-\s]?\d+', re.I)
WSDOT_MATCH_DEG = 0.00035  # ~30 m


DEM_Z = 12
DEM_DIR = 'data/dem'

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
            attrs.append({
                'sh': p.get('ShoulderWidth'),
                'spd': p.get('SpeedLimit'),
                'prohibited': p.get('Prohibited') == 1,
            })
    print(f'  WSDOT index: {len(geoms):,} segments', flush=True)
    return STRtree(geoms), geoms, attrs


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


def classify_way(tags):
    """Return edge attrs dict, or None to exclude from the routable graph."""
    bike = tags.get('bicycle')
    hw = tags.get('highway')
    if bike in ('no', 'dismount'):
        return None  # illegal to ride — never routable
    # access=no/private is a blanket default that mode-specific tags override:
    # e.g. the SR 520 Trail bridge is access=no + bicycle=designated (closed to
    # general traffic, explicitly open to bikes).
    if tags.get('access') in ('private', 'no') and bike not in ('yes', 'designated', 'permissive'):
        return None

    # Ferries (route=ferry, no highway tag): routable crossings for bikes.
    # Speed is derived from the duration tag at edge-build time; edge flag 32
    # marks them so the router prices them as a crossing, not a road.
    if tags.get('route') == 'ferry':
        if tags.get('foot') == 'private' or tags.get('motor_vehicle') == 'private':
            return None
        return {'speed': FERRY_DEFAULT_MPH, 'est': True, 'fac': False, 'lim': False,
                'infra': False, 'sh': None, 'ferry': True,
                'duration': tags.get('duration')}

    cw = next((tags[k] for k in CYCLEWAY_KEYS if tags.get(k)), None)

    # Rideable dedicated infrastructure (mirrors build_osm.py classify)
    infra = (
        hw == 'cycleway'
        or (hw == 'path' and bike in ('designated', 'yes'))
        or (hw == 'footway' and bike == 'designated')
        or (hw == 'bridleway' and bike in ('designated', 'yes'))
    )
    if infra:
        return {'speed': 0, 'est': False, 'fac': True, 'lim': False,
                'infra': True, 'sh': None}
    if hw not in DRIVE:
        return None

    spd = parse_mph(tags.get('maxspeed'))
    est = spd is None
    if est:
        spd = DEFAULT_MPH[hw]
    return {
        'speed': min(spd, 255), 'est': est,
        'fac': cw in FACILITY, 'lim': hw in LIMITED,
        'infra': False, 'sh': parse_shoulder_ft(tags),
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


def build(src, out, blts=None):
    wsdot = load_blts_index(blts) if blts else None
    ele_at = load_dem()
    if ele_at is None:
        print('  WARNING: no DEM tiles found — building without elevation', flush=True)
        ele_at = lambda lon, lat: 0
    # ---- pass 1: which ways are kept; count node references to find junctions
    print('pass 1: scanning ways...', flush=True)
    refcount = {}
    kept_ways = 0
    for obj in osmium.FileProcessor(src, osmium.osm.WAY):
        tags = {t.k: t.v for t in obj.tags}
        if classify_way(tags) is None:
            continue
        kept_ways += 1
        refs = [n.ref for n in obj.nodes]
        for r in refs:
            refcount[r] = refcount.get(r, 0) + 1
        # endpoints always split points
        if refs:
            refcount[refs[0]] += 1
            refcount[refs[-1]] += 1
    print(f'  kept {kept_ways:,} ways, {len(refcount):,} referenced nodes', flush=True)

    # ---- pass 2: build edges split at junctions
    print('pass 2: building edges...', flush=True)
    node_index = {}          # osm node id -> graph node index
    node_lon = array('f'); node_lat = array('f')
    eA = array('I'); eB = array('I'); eLen = array('f')
    eSpeed = array('B'); eFlags = array('B'); eSh = array('b')
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

    oneway_arcs = 0
    conflated = [0]
    for obj in osmium.FileProcessor(src).with_locations():
        if not obj.is_way():
            continue
        tags = {t.k: t.v for t in obj.tags}
        attrs = classify_way(tags)
        if attrs is None:
            continue
        pts = [(n.ref, n.location.lon, n.location.lat) for n in obj.nodes if n.location.valid()]
        if len(pts) < 2:
            continue
        ow = oneway_dir(tags)
        if ow == -1:
            pts = pts[::-1]
            ow = 1

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
            and (tags.get('highway') in WSDOT_CLASSES
                 or (tags.get('ref') and REF_STATE.search(tags['ref'])))
        )

        flags = ((1 if attrs['est'] else 0) | (2 if attrs['fac'] else 0)
                 | (4 if attrs['lim'] else 0) | (8 if attrs['infra'] else 0)
                 | (16 if ow == 1 else 0) | (32 if is_ferry else 0))
        sh = -1 if attrs['sh'] is None else max(-1, min(127, attrs['sh']))

        seg = [pts[0]]
        for p in pts[1:]:
            seg.append(p)
            if refcount.get(p[0], 0) >= 2 or p is pts[-1]:
                coords = [(x, y) for _, x, y in seg]
                if len(coords) >= 2:
                    length = line_len_m(coords)
                    if length > 0.5:
                        if len(coords) > 3:
                            coords = list(LineString(coords).simplify(SIMPLIFY_DEG, preserve_topology=False).coords)
                        a = gnode(seg[0][0], *coords[0])
                        b = gnode(seg[-1][0], *coords[-1])
                        if a != b or length > 10:  # drop degenerate micro-loops
                            espeed, esh, eflags = attrs['speed'], sh, flags
                            if wsdot_candidate:
                                tree, geoms, wattrs = wsdot
                                mid = Point(coords[len(coords) // 2])
                                best, bestd = None, WSDOT_MATCH_DEG
                                for gi in tree.query(mid.buffer(WSDOT_MATCH_DEG)):
                                    d = geoms[gi].distance(mid)
                                    if d < bestd:
                                        bestd, best = d, wattrs[gi]
                                if best is not None:
                                    if best['prohibited']:
                                        seg = [p]
                                        continue  # WSDOT permanent bike restriction
                                    if best['sh'] is not None:
                                        esh = max(-1, min(127, int(best['sh'])))
                                    if best['spd'] and (eflags & 1):
                                        espeed = min(int(best['spd']), 255)
                                        eflags &= ~1  # measured, not estimated
                                    conflated[0] += 1
                            asc, des = (0.0, 0.0) if is_ferry else edge_climb(coords, ele_at)
                            eAsc.append(min(int(asc), 65535)); eDes.append(min(int(des), 65535))
                            eA.append(a); eB.append(b); eLen.append(length)
                            eSpeed.append(espeed); eFlags.append(eflags); eSh.append(esh)
                            eOff.append(len(gLon)); eCnt.append(min(len(coords), 65535))
                            for x, y in coords[:65535]:
                                gLon.append(x); gLat.append(y)
                            if ow == 1:
                                oneway_arcs += 1
                seg = [p]

    # ---- ferry terminal stitching
    # Docks often join the street grid only via ways we exclude (pedestrian
    # walkways) or one-way exit loops, leaving the ferry edge on a directed
    # pocket you can never enter (Colman Dock) or leave. Detect pockets with
    # a directed BFS over land edges from each ferry endpoint, in both
    # directions; a ferry node whose in- or out-reachable land world is a
    # small CLOSED set gets a walk-the-bike connector (drawn straight) to
    # the nearest land node outside that pocket.
    print('stitching ferry terminals...', flush=True)
    out_adj = {}
    in_adj = {}
    land_touch = bytearray(len(node_lon))
    ferry_nodes = set()
    for i in range(len(eA)):
        a, b = eA[i], eB[i]
        if eFlags[i] & 32:
            ferry_nodes.add(a); ferry_nodes.add(b)
            continue
        land_touch[a] = land_touch[b] = 1
        out_adj.setdefault(a, []).append(b)
        in_adj.setdefault(b, []).append(a)
        if not (eFlags[i] & 16):  # two-way
            out_adj.setdefault(b, []).append(a)
            in_adj.setdefault(a, []).append(b)

    POCKET_K = 2000     # a closed set smaller than this is a dock pocket
    STITCH_MAX_M = 400

    def pocket(n, adj):
        """BFS over adj from n; return visited set if CLOSED and small, else None."""
        seen = {n}
        frontier = [n]
        while frontier:
            nxt = []
            for u in frontier:
                for v in adj.get(u, ()):
                    if v not in seen:
                        seen.add(v)
                        if len(seen) >= POCKET_K:
                            return None  # big open world — fine
                        nxt.append(v)
            frontier = nxt
        return seen

    stitched = 0
    for n in sorted(ferry_nodes):
        p_out = pocket(n, out_adj)
        p_in = pocket(n, in_adj)
        if p_out is None and p_in is None:
            continue  # well connected both ways
        avoid = (p_out or set()) | (p_in or set())
        best, best_d = None, STITCH_MAX_M
        lon0, lat0 = node_lon[n], node_lat[n]
        box = STITCH_MAX_M / 111000.0 * 1.6  # generous degrees prefilter
        for m in range(len(node_lon)):
            if abs(node_lat[m] - lat0) > box or abs(node_lon[m] - lon0) > box:
                continue
            if not land_touch[m] or m in avoid:
                continue
            d = haversine_m(lon0, lat0, node_lon[m], node_lat[m])
            if d < best_d:
                best_d, best = d, m
        if best is None:
            continue  # no street grid nearby (e.g. mid-water junction, small island)
        eA.append(n); eB.append(best); eLen.append(max(best_d, 1.0))
        eAsc.append(0); eDes.append(0)
        eSpeed.append(0); eFlags.append(8); eSh.append(-1)  # infra: walk the bike
        eOff.append(len(gLon)); eCnt.append(2)
        gLon.append(lon0); gLat.append(lat0)
        gLon.append(node_lon[best]); gLat.append(node_lat[best])
        # register the connector so sibling ferry nodes on this dock see it
        out_adj.setdefault(n, []).append(best)
        out_adj.setdefault(best, []).append(n)
        in_adj.setdefault(n, []).append(best)
        in_adj.setdefault(best, []).append(n)
        land_touch[n] = 1
        stitched += 1
    print(f'  connector edges added: {stitched}', flush=True)

    N, E, G = len(node_lon), len(eA), len(gLon)
    print(f'  nodes {N:,}  edges {E:,}  geom vertices {G:,}  oneway edges {oneway_arcs:,}', flush=True)
    print(f'  WSDOT-conflated edges: {conflated[0]:,}', flush=True)

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
    for arr in (node_lon, node_lat, nEle, eA, eB, eLen, eAsc, eDes, eSpeed, eFlags, eSh,
                eOff, eCnt, outStart, outTarget, outEdge, gLon, gLat):
        if sys.byteorder == 'big':
            arr.byteswap()
    # JS typed-array views need 4-byte alignment: pad after the byte arrays
    # (3E bytes) and after the u16 array (2E bytes).
    parts = [b'BGR2', struct.pack('<III', N, E, D),
             node_lon.tobytes(), node_lat.tobytes(), nEle.tobytes()]
    off = sum(len(p) for p in parts)
    parts.append(b'\x00' * ((4 - off % 4) % 4))
    parts += [eA.tobytes(), eB.tobytes(), eLen.tobytes(),
              eAsc.tobytes(), eDes.tobytes(),
              eSpeed.tobytes(), eFlags.tobytes(), eSh.tobytes()]
    off = sum(len(p) for p in parts)
    parts.append(b'\x00' * ((4 - off % 4) % 4))
    parts.append(eOff.tobytes())
    parts.append(eCnt.tobytes())
    off = sum(len(p) for p in parts)
    parts.append(b'\x00' * ((4 - off % 4) % 4))
    parts += [outStart.tobytes(), outTarget.tobytes(), outEdge.tobytes(),
              gLon.tobytes(), gLat.tobytes()]
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
    args = ap.parse_args()
    build(args.src, args.out, args.blts)
