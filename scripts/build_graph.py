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
    (1=est speed, 2=bike facility, 4=limited access, 8=infra, 16=oneway a->b),
  edgeShoulder i8[E] (-1 unknown, else ft),
  edgeGeomOff u32[E], edgeGeomCnt u16[E]  (into the geometry pool)
  outStart u32[N+1], outTarget u32[D], outEdge u32[D]   (directed CSR)
  geomLon f32[G], geomLat f32[G]  (pool; G = sum of edgeGeomCnt)

Usage: python3 scripts/build_graph.py [--src data/washington-latest.osm.pbf]
"""
import argparse
import gzip
import math
import re
import struct
import sys
from array import array

import osmium
from shapely.geometry import LineString

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
    if tags.get('access') in ('private', 'no'):
        return None

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


def build(src, out):
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
    gLon = array('f'); gLat = array('f')

    def gnode(osmid, lon, lat):
        i = node_index.get(osmid)
        if i is None:
            i = len(node_lon)
            node_index[osmid] = i
            node_lon.append(lon); node_lat.append(lat)
        return i

    oneway_arcs = 0
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

        flags = ((1 if attrs['est'] else 0) | (2 if attrs['fac'] else 0)
                 | (4 if attrs['lim'] else 0) | (8 if attrs['infra'] else 0)
                 | (16 if ow == 1 else 0))
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
                            eA.append(a); eB.append(b); eLen.append(length)
                            eSpeed.append(attrs['speed']); eFlags.append(flags); eSh.append(sh)
                            eOff.append(len(gLon)); eCnt.append(min(len(coords), 65535))
                            for x, y in coords[:65535]:
                                gLon.append(x); gLat.append(y)
                            if ow == 1:
                                oneway_arcs += 1
                seg = [p]

    N, E, G = len(node_lon), len(eA), len(gLon)
    print(f'  nodes {N:,}  edges {E:,}  geom vertices {G:,}  oneway edges {oneway_arcs:,}', flush=True)

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
    for arr in (node_lon, node_lat, eA, eB, eLen, eSpeed, eFlags, eSh, eOff, eCnt,
                outStart, outTarget, outEdge, gLon, gLat):
        if sys.byteorder == 'big':
            arr.byteswap()
    # JS typed-array views need 4-byte alignment: pad after the byte arrays
    # (3E bytes) and after the u16 array (2E bytes).
    parts = [b'BGR1', struct.pack('<III', N, E, D),
             node_lon.tobytes(), node_lat.tobytes(),
             eA.tobytes(), eB.tobytes(), eLen.tobytes(),
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
    ap.add_argument('--out', default='data/graph.bin.gz')
    args = ap.parse_args()
    build(args.src, args.out)
