#!/usr/bin/env python3
"""Backfill WSDOT permanent bike restrictions into an existing BGR3/BGR4 graph.

Raw OSM and DEM inputs are not required. Matched graph edges retain their
geometry and elevation but receive the unused shoulder sentinel -128. The
router recognizes that sentinel as a hard bicycle prohibition and never
traverses the edge, regardless of routing mode or settings.

The matcher is deliberately conservative: it accepts a near-exact geometry
match, or a broader match only where the graph edge and WSDOT restriction share
the same route number. This prevents a legal parallel sidewalk or frontage road
from being blocked merely because it is near a restricted highway.
"""
import argparse
import gzip
import json
import math
import struct
from collections import Counter, defaultdict
from pathlib import Path

from patch_graph_limited_access import (
    CELL_DEG,
    add_segment_to_grid,
    edge_name,
    graph_layout,
    name_numbers,
    point_segment_distance_sq,
    route_number,
)

MATCH_DEG = 0.00035
STRICT_MATCH_DEG = 0.00004
PROHIBITED_SHOULDER = -128


def restriction_grid(path, match_deg):
    features = json.load(open(path))['features']
    grid = defaultdict(list)
    count = 0
    for feature in features:
        props = feature['properties']
        geometry = feature['geometry']
        lines = [geometry['coordinates']] if geometry['type'] == 'LineString' else geometry['coordinates']
        route = route_number(props.get('RouteIdentifier') or props.get('Route'))
        for coords in lines:
            for (ax, ay), (bx, by) in zip(coords, coords[1:]):
                add_segment_to_grid(grid, (ax, ay, bx, by, route), match_deg)
                count += 1
    print(f'Indexed {count:,} WSDOT restricted line segments in {len(grid):,} grid cells.')
    return grid


def best_match(raw, layout, edge, grid, match_deg, strict_match_deg):
    geom_off = struct.unpack_from('<I', raw, layout['edge_geom_off'] + 4 * edge)[0]
    geom_count = struct.unpack_from('<H', raw, layout['edge_geom_count'] + 2 * edge)[0]
    if geom_count < 2:
        return None
    match_sq = match_deg * match_deg
    strict_sq = strict_match_deg * strict_match_deg
    best_dist_sq, best_route = match_sq, None
    # Graph edges are generally short road pieces. Check every retained vertex
    # so a restriction boundary inside an edge cannot be skipped by midpoint-only
    # matching.
    for point in range(geom_off, geom_off + geom_count):
        lon = struct.unpack_from('<f', raw, layout['geom_lon'] + 4 * point)[0]
        lat = struct.unpack_from('<f', raw, layout['geom_lat'] + 4 * point)[0]
        for ax, ay, bx, by, route in grid.get((math.floor(lon / CELL_DEG), math.floor(lat / CELL_DEG)), ()):
            distance_sq = point_segment_distance_sq(lon, lat, ax, ay, bx, by)
            if distance_sq < best_dist_sq:
                best_dist_sq, best_route = distance_sq, route
    if best_route is None:
        return None
    if best_dist_sq <= strict_sq:
        return best_route, 'close'
    if best_route in name_numbers(edge_name(raw, layout, edge)):
        return best_route, 'route-number'
    return None


def patch_graph(raw, grid, match_deg, strict_match_deg):
    layout = graph_layout(raw)
    changed = matched = close = numbered = 0
    matched_by_route = Counter()
    changed_by_route = Counter()
    for edge in range(layout['edges']):
        # A mapped bike path or sidewalk can be the legal alternative beside
        # the restricted roadway (for example, a "bikes use sidewalk" order).
        # Keep dedicated infrastructure routable unless it is separately
        # tagged bicycle=no by OSM, which the graph builder already excludes.
        if raw[layout['edge_flags'] + edge] & 8:
            continue
        result = best_match(raw, layout, edge, grid, match_deg, strict_match_deg)
        if result is None:
            continue
        route, reason = result
        matched += 1
        matched_by_route[route] += 1
        close += reason == 'close'
        numbered += reason == 'route-number'
        offset = layout['edge_shoulder'] + edge
        if raw[offset] != 128:  # byte form of the signed -128 sentinel
            raw[offset] = 128
            changed += 1
            changed_by_route[route] += 1
    print(f'Matched {matched:,} graph edges ({close:,} near-exact, {numbered:,} route-number matches).')
    print(f'Marked {changed:,} graph edges as bicycle-prohibited.')
    for route, count in changed_by_route.most_common(12):
        print(f'  SR/I-{route}: {count:,} new of {matched_by_route[route]:,} matched edges')
    return changed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--graph', default='data/graph2.bin.gz')
    parser.add_argument('--restrictions', default='data/bike_restrictions.geojson')
    parser.add_argument('--out', default='data/graph2.bin.gz')
    parser.add_argument('--match-deg', type=float, default=MATCH_DEG)
    parser.add_argument('--strict-match-deg', type=float, default=STRICT_MATCH_DEG)
    parser.add_argument('--apply', action='store_true', help='write the patched graph to --out')
    args = parser.parse_args()

    graph_path = Path(args.graph)
    raw = bytearray(gzip.open(graph_path, 'rb').read())
    print(f'Loaded {graph_path} ({len(raw):,} bytes uncompressed).')
    changed = patch_graph(raw, restriction_grid(args.restrictions, args.match_deg),
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
    temp_path.replace(out_path)
    print(f'Wrote {out_path} ({out_path.stat().st_size:,} bytes compressed).')


if __name__ == '__main__':
    main()
