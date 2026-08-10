#!/usr/bin/env python3
"""Make the short land approach to every ferry terminal two-way for bikes.

One-way streets are baked into the directed CSR: a `oneway a->b` edge only
gets the a->b arc, so the reverse is physically untraversable. Car-oriented
one-way tagging around ferry docks (exit ramps, Alaskan Way, terminal
approaches) then leaves a terminal reachable going OUT but not IN — a cyclist
in downtown Seattle cannot reach Colman Dock and the router detours ~40 miles
via another ferry.

A boarding cyclist rolls or walks the final approach, so within a short radius
of a ferry-terminal land node the one-way restriction should not apply. This
patch adds the missing reverse arc for every one-way non-ferry edge whose
endpoint lies within ACCESS_RADIUS_M of a ferry-terminal node. Nothing else in
the graph changes: same nodes, same edges, same attributes — only the directed
adjacency (outStart/outTarget/outEdge, and D in the header) is rebuilt.

Idempotent: re-running adds nothing new (the reverse arcs already exist).

Raw OSM and DEM inputs are not required.

Usage: python3 scripts/patch_graph_ferry_access.py [--apply]
"""
import argparse
import gzip
import math
import struct
from array import array
from pathlib import Path

GRAPH = Path('maps/washington/graph2.bin.gz')
FERRY_FLAG = 32
ONEWAY_FLAG = 16
ACCESS_RADIUS_M = 250.0


def align4(offset):
    return offset + ((4 - (offset % 4)) % 4)


def haversine_m(lon1, lat1, lon2, lat2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def load(raw):
    """Return (header dict, section byte offsets) for a BGR8 graph."""
    if bytes(raw[:4]) != b'BGR8':
        raise ValueError('ferry-access patch requires a BGR8 graph')
    n, e, d, g, u, name_bytes = struct.unpack_from('<6I', raw, 4)
    o = 28
    node_lon = o; o += 4 * n
    node_lat = o; o += 4 * n
    o += 2 * n                       # node elevation
    o = align4(o)
    edge_a = o; o += 4 * e
    edge_b = o; o += 4 * e
    o += 4 * e                       # length
    o += 2 * e + 2 * e               # ascent, descent
    o += e                           # speed
    edge_flags = o; o += e
    o += e                           # shoulder
    o += e                           # road class
    o += e + e + e                   # facility, official, surface
    o += e + e                       # hazard a->b, b->a
    o += o % 2
    o += 8 * e                       # four u16 hazard ranges
    o = align4(o)
    o += 4 * e                       # geom offset
    o += 2 * e                       # geom count
    o = align4(o)
    csr_start = o
    o += 4 * (n + 1)                 # outStart
    o += 4 * d                       # outTarget
    o += 4 * d                       # outEdge
    csr_end = o                      # eName begins here; everything after is unchanged
    hdr = {'n': n, 'e': e, 'd': d, 'g': g, 'u': u, 'name_bytes': name_bytes,
           'node_lon': node_lon, 'node_lat': node_lat,
           'edge_a': edge_a, 'edge_b': edge_b, 'edge_flags': edge_flags,
           'csr_start': csr_start, 'csr_end': csr_end}
    return hdr


def u32(raw, off, count):
    a = array('I'); a.frombytes(raw[off:off + 4 * count])
    return a


def f32(raw, off, count):
    a = array('f'); a.frombytes(raw[off:off + 4 * count])
    return a


def u8(raw, off, count):
    a = array('B'); a.frombytes(raw[off:off + count])
    return a


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='write the patched graph')
    args = ap.parse_args()

    raw = bytearray(gzip.open(GRAPH, 'rb').read())
    h = load(raw)
    n, e, d = h['n'], h['e'], h['d']
    node_lon = f32(raw, h['node_lon'], n)
    node_lat = f32(raw, h['node_lat'], n)
    ea = u32(raw, h['edge_a'], e)
    eb = u32(raw, h['edge_b'], e)
    flags = u8(raw, h['edge_flags'], e)

    # Ferry-terminal land nodes: touch a ferry edge AND a non-ferry edge.
    ferry_node = bytearray(n)
    land_node = bytearray(n)
    for i in range(e):
        if flags[i] & FERRY_FLAG:
            ferry_node[ea[i]] = 1
            ferry_node[eb[i]] = 1
        else:
            land_node[ea[i]] = 1
            land_node[eb[i]] = 1
    term = [nd for nd in range(n) if ferry_node[nd] and land_node[nd]]
    term_pts = [(node_lon[nd], node_lat[nd]) for nd in term]
    print(f'  ferry-terminal land nodes: {len(term)}', flush=True)

    # Degree box for a quick prefilter before the haversine check.
    deg_box = ACCESS_RADIUS_M / 111320.0 + 1e-4

    def near_terminal(nd):
        lon, lat = node_lon[nd], node_lat[nd]
        for tlon, tlat in term_pts:
            if abs(lat - tlat) > deg_box:
                continue
            if abs(lon - tlon) > deg_box / max(0.2, math.cos(math.radians(lat))):
                continue
            if haversine_m(lon, lat, tlon, tlat) <= ACCESS_RADIUS_M:
                return True
        return False

    # One-way non-ferry edges with an endpoint near a terminal get a reverse arc.
    freed = []
    for i in range(e):
        if not (flags[i] & ONEWAY_FLAG) or (flags[i] & FERRY_FLAG):
            continue
        if near_terminal(ea[i]) or near_terminal(eb[i]):
            freed.append(i)
    freed_set = set(freed)
    print(f'  one-way approach edges made two-way: {len(freed)}', flush=True)

    if not args.apply:
        print('  (dry run — pass --apply to write)', flush=True)
        return

    # Rebuild the directed CSR: forward arc always; reverse arc when the edge is
    # two-way OR a freed ferry-approach edge.
    def bidir(i):
        return not (flags[i] & ONEWAY_FLAG) or i in freed_set

    out_deg = array('I', bytes(4 * n))
    for i in range(e):
        out_deg[ea[i]] += 1
        if bidir(i):
            out_deg[eb[i]] += 1
    out_start = array('I', bytes(4 * (n + 1)))
    s = 0
    for nd in range(n):
        out_start[nd] = s
        s += out_deg[nd]
    out_start[n] = s
    new_d = s
    out_target = array('I', bytes(4 * new_d))
    out_edge = array('I', bytes(4 * new_d))
    cursor = array('I', out_start[:n])
    for i in range(e):
        a, b = ea[i], eb[i]
        c = cursor[a]; out_target[c] = b; out_edge[c] = i; cursor[a] = c + 1
        if bidir(i):
            c = cursor[b]; out_target[c] = a; out_edge[c] = i; cursor[b] = c + 1
    print(f'  directed arcs {d:,} -> {new_d:,} (+{new_d - d})', flush=True)

    # Re-emit: header (new D) + unchanged pre-CSR + new CSR + unchanged post-CSR.
    head = bytearray(raw[:28])
    struct.pack_into('<I', head, 12, new_d)  # D is the 4th u32 after the magic
    pre = raw[28:h['csr_start']]
    post = raw[h['csr_end']:]
    csr = bytearray()
    csr += memoryview(out_start).cast('B')
    csr += memoryview(out_target).cast('B')
    csr += memoryview(out_edge).cast('B')
    out = bytes(head) + bytes(pre) + bytes(csr) + bytes(post)

    with gzip.open(GRAPH, 'wb') as fh:
        fh.write(out)
    print(f'  wrote {GRAPH} ({len(out):,} bytes uncompressed)', flush=True)


if __name__ == '__main__':
    main()
