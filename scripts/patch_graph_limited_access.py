#!/usr/bin/env python3
"""Backfill WSDOT limited-access caution flags into an existing BGR3/BGR4/BGR5 graph.

This is a conservative final safety net after a normal build, and a migration
tool when the raw OSM and DEM inputs used to build the checked-in graph are
unavailable. It preserves all graph geometry and elevation values, changing
only edge flag bit 128 (WSDOT limited-access caution). It deliberately leaves
bit 4 alone: that is the original OSM motorway/freeway flag, which the router
treats as a true last resort.

For a normal future rebuild, build_graph.py is authoritative and applies the
same WSDOT LimitedAccess rule while it creates the graph.

The match follows the build-time 0.00035-degree proximity tolerance. To avoid
marking a nearby frontage road, a graph edge must either be very close to the
WSDOT centerline (0.00018 degrees) or carry the same route number.
"""
import argparse
import gzip
import json
import math
import os
import re
import struct
from collections import Counter, defaultdict
from pathlib import Path

MATCH_DEG = 0.00035
STRICT_MATCH_DEG = 0.00018
CELL_DEG = 0.01
LIMITED_ACCESS_CAUTION_FLAG = 128


def align4(offset):
    return (offset + 3) & ~3


def route_number(value):
    """Extract 104 from WSDOT's 104d / 104SPAURORAd-style identifiers."""
    match = re.match(r'\D*0*(\d+)', str(value or ''))
    return int(match.group(1)) if match else None


def name_numbers(value):
    return {int(token) for token in re.findall(r'\d+', value or '')}


def point_segment_distance_sq(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    denom = dx * dx + dy * dy
    if denom == 0:
        dx, dy = px - ax, py - ay
        return dx * dx + dy * dy
    t = ((px - ax) * dx + (py - ay) * dy) / denom
    t = max(0.0, min(1.0, t))
    dx, dy = px - (ax + t * dx), py - (ay + t * dy)
    return dx * dx + dy * dy


def graph_layout(raw):
    magic = bytes(raw[:4])
    if magic not in (b'BGR3', b'BGR4', b'BGR5'):
        raise ValueError('not a BGR3, BGR4, or BGR5 graph')
    n, e, d, g, u, name_bytes = struct.unpack_from('<6I', raw, 4)
    offset = 28
    offset += 4 * n  # node longitude
    offset += 4 * n  # node latitude
    offset += 2 * n  # node elevation
    offset = align4(offset)
    offset += 4 * e  # edge A
    offset += 4 * e  # edge B
    offset += 4 * e  # edge length
    offset += 2 * e  # edge ascent
    offset += 2 * e  # edge descent
    offset += e      # edge speed
    edge_flags = offset
    offset += e
    edge_shoulder = offset
    offset += e      # edge shoulder
    edge_road_class = None
    if magic in (b'BGR4', b'BGR5'):
        edge_road_class = offset
        offset += e  # OSM highway class
    if magic == b'BGR5':
        offset += e  # typed bicycle facility
        offset += e  # authoritative WSDOT source bits
    offset = align4(offset)
    edge_geom_off = offset
    offset += 4 * e
    edge_geom_count = offset
    offset += 2 * e
    offset = align4(offset)
    offset += 4 * (n + 1)  # CSR starts
    offset += 4 * d        # CSR targets
    offset += 4 * d        # CSR edges
    edge_name = offset
    offset += 4 * e
    name_offsets = offset
    offset += 4 * (u + 1)
    geom_lon = offset
    offset += 4 * g
    geom_lat = offset
    offset += 4 * g
    if offset + name_bytes != len(raw):
        raise ValueError(f'unexpected {magic.decode()} layout')
    return {
        'edges': e,
        'edge_flags': edge_flags,
        'edge_shoulder': edge_shoulder,
        'edge_road_class': edge_road_class,
        'edge_geom_off': edge_geom_off,
        'edge_geom_count': edge_geom_count,
        'edge_name': edge_name,
        'name_offsets': name_offsets,
        'geom_lon': geom_lon,
        'geom_lat': geom_lat,
        'name_bytes': offset,
    }


def add_segment_to_grid(grid, segment, match_deg):
    ax, ay, bx, by, _ = segment
    x0 = math.floor((min(ax, bx) - match_deg) / CELL_DEG)
    x1 = math.floor((max(ax, bx) + match_deg) / CELL_DEG)
    y0 = math.floor((min(ay, by) - match_deg) / CELL_DEG)
    y1 = math.floor((max(ay, by) + match_deg) / CELL_DEG)
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            grid[x, y].append(segment)


def limited_access_grid(blts_path, match_deg):
    features = json.load(open(blts_path))['features']
    grid = defaultdict(list)
    count = 0
    for feature in features:
        props = feature['properties']
        if props.get('LimitedAccess') != 1:
            continue
        geometry = feature['geometry']
        lines = [geometry['coordinates']] if geometry['type'] == 'LineString' else geometry['coordinates']
        route = route_number(props.get('RouteIdentifier'))
        for coords in lines:
            for (ax, ay), (bx, by) in zip(coords, coords[1:]):
                add_segment_to_grid(grid, (ax, ay, bx, by, route), match_deg)
                count += 1
    print(f'Indexed {count:,} WSDOT limited-access line segments in {len(grid):,} grid cells.')
    return grid


def edge_name(raw, layout, edge):
    name_id = struct.unpack_from('<I', raw, layout['edge_name'] + 4 * edge)[0]
    start = struct.unpack_from('<I', raw, layout['name_offsets'] + 4 * name_id)[0]
    end = struct.unpack_from('<I', raw, layout['name_offsets'] + 4 * (name_id + 1))[0]
    return bytes(raw[layout['name_bytes'] + start:layout['name_bytes'] + end]).decode('utf-8', 'replace')


def patch_graph(raw, grid, match_deg, strict_match_deg):
    layout = graph_layout(raw)
    match_sq = match_deg * match_deg
    strict_sq = strict_match_deg * strict_match_deg
    changed = matched = strict_matches = numbered_matches = 0
    matched_by_route = Counter()
    changed_by_route = Counter()

    for edge in range(layout['edges']):
        # WSDOT's roadway centerline can run immediately beside a legal bike
        # path. The normal builder never conflates WSDOT road attributes onto
        # dedicated infrastructure, so the migration must not either.
        if raw[layout['edge_flags'] + edge] & 8:
            continue
        geom_off = struct.unpack_from('<I', raw, layout['edge_geom_off'] + 4 * edge)[0]
        geom_count = struct.unpack_from('<H', raw, layout['edge_geom_count'] + 2 * edge)[0]
        if geom_count < 2:
            continue
        midpoint = geom_off + geom_count // 2
        lon = struct.unpack_from('<f', raw, layout['geom_lon'] + 4 * midpoint)[0]
        lat = struct.unpack_from('<f', raw, layout['geom_lat'] + 4 * midpoint)[0]
        candidates = grid.get((math.floor(lon / CELL_DEG), math.floor(lat / CELL_DEG)))
        if not candidates:
            continue

        best_dist_sq, best_route = match_sq, None
        for ax, ay, bx, by, route in candidates:
            distance_sq = point_segment_distance_sq(lon, lat, ax, ay, bx, by)
            if distance_sq < best_dist_sq:
                best_dist_sq, best_route = distance_sq, route
        if best_route is None:
            continue

        close_match = best_dist_sq <= strict_sq
        if close_match:
            strict_matches += 1
        else:
            if best_route not in name_numbers(edge_name(raw, layout, edge)):
                continue
            numbered_matches += 1

        matched += 1
        matched_by_route[best_route] += 1
        flag_offset = layout['edge_flags'] + edge
        if not raw[flag_offset] & LIMITED_ACCESS_CAUTION_FLAG:
            raw[flag_offset] |= LIMITED_ACCESS_CAUTION_FLAG
            changed += 1
            changed_by_route[best_route] += 1

    print(f'Matched {matched:,} graph edges ({strict_matches:,} close, {numbered_matches:,} route-number matches).')
    print(f'Added WSDOT limited-access caution flags to {changed:,} graph edges.')
    for route in (5, 90, 104, 405, 520):
        if matched_by_route[route]:
            print(f'  SR/I-{route}: {changed_by_route[route]:,} new of {matched_by_route[route]:,} matched edges')
    return changed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--graph', default='data/graph2.bin.gz')
    parser.add_argument('--blts', default='data/blts.geojson')
    parser.add_argument('--out', default='data/graph2.bin.gz')
    parser.add_argument('--match-deg', type=float, default=MATCH_DEG)
    parser.add_argument('--strict-match-deg', type=float, default=STRICT_MATCH_DEG)
    parser.add_argument('--apply', action='store_true', help='write the patched graph to --out')
    args = parser.parse_args()

    graph_path = Path(args.graph)
    raw = bytearray(gzip.open(graph_path, 'rb').read())
    print(f'Loaded {graph_path} ({len(raw):,} bytes uncompressed).')
    changed = patch_graph(raw, limited_access_grid(args.blts, args.match_deg),
                          args.match_deg, args.strict_match_deg)
    if not args.apply:
        print('Dry run only; pass --apply to write the graph.')
        return
    if not changed:
        print('No graph bytes changed; nothing written.')
        return
    out_path = Path(args.out)
    temp_path = out_path.with_suffix(out_path.suffix + '.tmp')
    with gzip.open(temp_path, 'wb', compresslevel=9) as out:
        out.write(raw)
    os.replace(temp_path, out_path)
    print(f'Wrote {out_path} ({out_path.stat().st_size:,} bytes compressed).')


if __name__ == '__main__':
    main()
