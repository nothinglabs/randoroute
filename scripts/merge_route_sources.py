#!/usr/bin/env python3
"""Merge reviewed supplemental routes into one state's OSM route overlay.

The output keeps OSM as the primary catalogue, adds official-only routes, and
adds only the missing portions of an official route when the same named route
already exists in OSM.  A top-level routeCatalog preserves source provenance
and full per-route geometry for Settings -> Routes and Preferred routing.
"""

import argparse
import gzip
import json
import math
import re
import unicodedata
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
GENERIC_WORDS = {
    'bike', 'bicycle', 'bikeway', 'bikeways', 'cycleway', 'designated',
    'loop', 'route', 'routes', 'scenic', 'state',
}


def read_json(path):
    opener = gzip.open if str(path).endswith('.gz') else open
    with opener(path, 'rt', encoding='utf-8') as handle:
        return json.load(handle)


def write_json(path, value):
    encoded = (json.dumps(value, separators=(',', ':'), sort_keys=True) + '\n').encode()
    if str(path).endswith('.gz'):
        with open(path, 'wb') as raw:
            with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as zipped:
                zipped.write(encoded)
    else:
        path.write_bytes(encoded)


def lines_of(feature):
    geometry = feature.get('geometry') or {}
    if geometry.get('type') == 'LineString':
        return [geometry.get('coordinates') or []]
    if geometry.get('type') == 'MultiLineString':
        return geometry.get('coordinates') or []
    return []


def line_length_m(lines):
    total = 0.0
    for line in lines:
        for a, b in zip(line, line[1:]):
            lat = math.radians((float(a[1]) + float(b[1])) / 2)
            dx = (float(b[0]) - float(a[0])) * 111_320 * math.cos(lat)
            dy = (float(b[1]) - float(a[1])) * 110_540
            total += math.hypot(dx, dy)
    return round(total)


def route_names(properties):
    names = [part.strip() for part in str(properties.get('n') or '').split(' / ')
             if part.strip()]
    if names:
        return names
    return [f'Route {part.strip()}' for part in
            re.split(r'[;,]', str(properties.get('r') or '')) if part.strip()]


def normalized_name(name):
    text = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode().lower()
    text = text.replace('mtn', 'mountain')
    words = re.findall(r'[a-z0-9]+', text)
    kept = [word for word in words if word not in GENERIC_WORDS]
    return ' '.join(kept or words)


def route_grid(lines, cell_deg=0.005):
    grid = defaultdict(list)
    for line in lines:
        for a, b in zip(line, line[1:]):
            if len(a) < 2 or len(b) < 2:
                continue
            x0, y0, x1, y1 = float(a[0]), float(a[1]), float(b[0]), float(b[1])
            min_x, max_x = sorted((math.floor(x0 / cell_deg), math.floor(x1 / cell_deg)))
            min_y, max_y = sorted((math.floor(y0 / cell_deg), math.floor(y1 / cell_deg)))
            for x in range(min_x - 1, max_x + 2):
                for y in range(min_y - 1, max_y + 2):
                    grid[(x, y)].append((x0, y0, x1, y1))
    return grid


def point_near_route(point, grid, tolerance_m=35, cell_deg=0.005):
    lon, lat = float(point[0]), float(point[1])
    segments = grid.get((math.floor(lon / cell_deg), math.floor(lat / cell_deg)), ())
    metres_lon = 111_320 * math.cos(math.radians(lat))
    limit = tolerance_m * tolerance_m
    for lon0, lat0, lon1, lat1 in segments:
        ax, ay = (lon0 - lon) * metres_lon, (lat0 - lat) * 110_540
        bx, by = (lon1 - lon) * metres_lon, (lat1 - lat) * 110_540
        dx, dy = bx - ax, by - ay
        span = dx * dx + dy * dy
        along = max(0, min(1, -(ax * dx + ay * dy) / span)) if span else 0
        px, py = ax + along * dx, ay + along * dy
        if px * px + py * py <= limit:
            return True
    return False


def overlap_fraction(lines, candidate_lines):
    grid = route_grid(candidate_lines)
    sampled = hits = 0
    for line in lines:
        step = max(1, len(line) // 1200)
        for point in line[::step]:
            sampled += 1
            hits += point_near_route(point, grid)
    return hits / sampled if sampled else 0


def uncovered_runs(lines, candidate_lines):
    """Parts of official geometry not already represented by its OSM twin."""
    grid = route_grid(candidate_lines)
    runs = []
    for line in lines:
        current = []
        for a, b in zip(line, line[1:]):
            covered = (point_near_route(a, grid) and point_near_route(b, grid)
                       and point_near_route([(a[0] + b[0]) / 2,
                                             (a[1] + b[1]) / 2], grid))
            if not covered:
                if not current:
                    current.append(a)
                current.append(b)
            elif len(current) >= 2:
                runs.append(current)
                current = []
            else:
                current = []
        if len(current) >= 2:
            runs.append(current)
    return runs


def build_osm_catalog(features):
    routes = {}
    refs_by_name = defaultdict(set)
    for feature in features:
        properties = feature.get('properties') or {}
        names = route_names(properties)
        refs = [part.strip() for part in re.split(r'[;,]', str(properties.get('r') or ''))
                if part.strip()]
        for name in names:
            entry = routes.setdefault(name, {
                'id': f'osm:{normalized_name(name)}',
                'name': name,
                'network': 'regional',
                'sourceIds': ['osm'],
                'lines': [],
                'lengthM': 0,
            })
            if properties.get('t') == 'ncn':
                entry['network'] = 'national'
            entry['lines'].extend(lines_of(feature))
            refs_by_name[name].update(refs)
    for name, entry in routes.items():
        entry['lengthM'] = line_length_m(entry['lines'])
        refs = sorted(refs_by_name[name])
        if refs:
            entry['refs'] = refs
    return routes


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--region', required=True)
    parser.add_argument('--base', type=Path)
    parser.add_argument('--supplemental', type=Path,
                        default=ROOT / 'maps' / 'supplemental-routes.geojson.gz')
    parser.add_argument('--registry', type=Path,
                        default=ROOT / 'maps' / 'route-sources.json')
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    base_path = args.base or ROOT / 'maps' / args.region / 'bikeroutes.geojson'
    out_path = args.out or base_path

    base = read_json(base_path)
    # Re-running after a previous merge starts again from the retained OSM
    # features instead of compounding supplemental geometry.
    osm_features = [feature for feature in base.get('features') or []
                    if (feature.get('properties') or {}).get('s', 'osm') == 'osm']
    for feature in osm_features:
        feature.setdefault('properties', {})['s'] = 'osm'

    registry = read_json(args.registry)
    region_registry = registry.get('regions', {}).get(args.region)
    if region_registry is None:
        raise SystemExit(f'{args.region} has no route-source registry entry')
    approved_sources = {source['id']: source for source in region_registry.get('sources') or []
                        if source.get('approved') is True}
    supplemental = read_json(args.supplemental)
    official = [feature for feature in supplemental.get('features') or []
                if (feature.get('properties') or {}).get('region') == args.region]
    unknown = sorted({feature['properties']['sourceId'] for feature in official}
                     - set(approved_sources))
    if unknown:
        raise SystemExit(f'snapshot contains unapproved sources: {", ".join(unknown)}')

    catalog = build_osm_catalog(osm_features)
    by_normalized = defaultdict(list)
    for name in catalog:
        by_normalized[normalized_name(name)].append(name)
    added_features = []
    merged = 0
    for feature in sorted(official, key=lambda item: item['properties']['n']):
        properties = feature['properties']
        name = properties['n']
        lines = lines_of(feature)
        candidates = by_normalized.get(normalized_name(name), [])
        best_name = None
        best_overlap = 0
        for candidate in candidates:
            overlap = overlap_fraction(lines, catalog[candidate]['lines'])
            if overlap > best_overlap:
                best_name, best_overlap = candidate, overlap
        if best_name is not None and best_overlap >= 0.5:
            entry = catalog[best_name]
            if properties['sourceId'] not in entry['sourceIds']:
                entry['sourceIds'].append(properties['sourceId'])
            gaps = uncovered_runs(lines, entry['lines'])
            entry['lines'].extend(lines)
            # The official geometry is one complete published route, while an
            # OSM relation may be split across several overlay features. Use
            # the official length rather than counting their shared geometry
            # twice in the Settings list.
            entry['lengthM'] = line_length_m(lines)
            if gaps:
                added_features.append({
                    'type': 'Feature',
                    'properties': {'t': 'rcn', 'r': '', 'n': best_name,
                                   's': properties['sourceId']},
                    'geometry': {'type': 'MultiLineString', 'coordinates': gaps},
                })
            merged += 1
            print(f'merged {name} -> {best_name} ({best_overlap:.0%} OSM overlap, '
                  f'{len(gaps)} added runs)')
            continue

        route_id = f'{properties["sourceId"]}:{properties["routeId"]}'
        catalog[name] = {
            'id': route_id,
            'name': name,
            'network': 'official',
            'sourceIds': [properties['sourceId']],
            'lines': lines,
            'lengthM': line_length_m(lines),
        }
        added_features.append({
            'type': 'Feature',
            'properties': {'t': 'rcn', 'r': '', 'n': name,
                           's': properties['sourceId']},
            'geometry': {'type': 'MultiLineString', 'coordinates': lines},
        })

    sources = [{'id': 'osm', 'label': 'OSM routes',
                'authority': 'OpenStreetMap contributors'}]
    for source in approved_sources.values():
        sources.append({'id': source['id'], 'label': source['label'],
                        'authority': source['authority'],
                        'sourceUrl': source['sourceUrl']})
    route_catalog = sorted(catalog.values(), key=lambda route: route['name'].casefold())
    output = {
        'type': 'FeatureCollection',
        'routeCount': len(route_catalog),
        'osmRouteCount': base.get('osmRouteCount', base.get('routeCount')),
        'routeSources': sources,
        'routeCatalog': route_catalog,
        'features': osm_features + added_features,
    }
    write_json(out_path, output)
    print(f'wrote {out_path}: {len(route_catalog)} routes, {len(added_features)} '
          f'supplemental features, {merged} source duplicates merged')


if __name__ == '__main__':
    main()
