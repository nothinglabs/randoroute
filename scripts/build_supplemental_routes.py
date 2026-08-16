#!/usr/bin/env python3
"""Fetch the small, human-approved route sources in maps/route-sources.json.

OSM remains the default route source.  This script does not discover sources:
it will fetch only the exact regions, records and category values already
approved in the shared registry.  Its output is a source snapshot used by
merge_route_sources.py; it carries designation and provenance, never safety
facts.
"""

import argparse
import gzip
import json
import urllib.request
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_REGISTRY = ROOT / 'maps' / 'route-sources.json'
DEFAULT_OUT = ROOT / 'maps' / 'supplemental-routes.geojson.gz'
USER_AGENT = 'RandoRoute route-source builder/1 (+https://github.com/nothinglabs/randoroute)'


def fetch_json(url):
    request = urllib.request.Request(url, headers={
        'Accept': 'application/json',
        'User-Agent': USER_AGENT,
    })
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.load(response)


def geometry_lines(geometry):
    if not geometry:
        return []
    if geometry.get('type') == 'LineString':
        return [geometry.get('coordinates') or []]
    if geometry.get('type') == 'MultiLineString':
        return geometry.get('coordinates') or []
    return []


def route_feature(region, source, route_id, name, lines, page=None):
    cleaned = []
    for line in lines:
        coords = []
        for point in line:
            if not isinstance(point, (list, tuple)) or len(point) < 2:
                continue
            try:
                lon, lat = float(point[0]), float(point[1])
            except (TypeError, ValueError):
                continue
            if coords and coords[-1] == [lon, lat]:
                continue
            coords.append([lon, lat])
        if len(coords) >= 2:
            cleaned.append(coords)
    if not cleaned:
        raise ValueError(f'{source["id"]}:{route_id} has no usable line geometry')
    return {
        'type': 'Feature',
        'properties': {
            'region': region,
            'sourceId': source['id'],
            'sourceLabel': source['label'],
            'authority': source['authority'],
            'routeId': str(route_id),
            'n': str(name).strip(),
            'sourceUrl': page or source['sourceUrl'],
        },
        'geometry': {'type': 'MultiLineString', 'coordinates': cleaned},
    }


def fetch_arcgis(region, source):
    data = fetch_json(source['dataUrl'])
    approved = set(source.get('approvedValues') or [])
    if not approved:
        raise ValueError(f'{source["id"]} has no approvedValues')
    grouped = defaultdict(list)
    for feature in data.get('features') or []:
        name = (feature.get('properties') or {}).get(source['nameField'])
        if name not in approved:
            continue
        grouped[name].extend(geometry_lines(feature.get('geometry')))
    missing = sorted(approved - set(grouped))
    if missing:
        raise ValueError(f'{source["id"]} omitted approved routes: {", ".join(missing)}')
    return [route_feature(region, source, name, name, grouped[name])
            for name in sorted(grouped)]


def fetch_ridewithgps(region, source):
    features = []
    seen = set()
    for approved in source.get('routes') or []:
        route_id = int(approved['id'])
        if route_id in seen:
            raise ValueError(f'{source["id"]} repeats route {route_id}')
        seen.add(route_id)
        data = fetch_json(f'https://ridewithgps.com/routes/{route_id}.json')
        if int(data.get('id', -1)) != route_id:
            raise ValueError(f'{source["id"]} returned the wrong record for {route_id}')
        points = [[point.get('x'), point.get('y')]
                  for point in data.get('track_points') or []]
        features.append(route_feature(region, source, route_id, data.get('name'),
                                      [points], approved.get('page')))
    if not features:
        raise ValueError(f'{source["id"]} has no approved routes')
    return features


ADAPTERS = {
    'arcgis-geojson': fetch_arcgis,
    'ridewithgps-json': fetch_ridewithgps,
}


def write_gzip_json(path, value):
    encoded = (json.dumps(value, separators=(',', ':'), sort_keys=True) + '\n').encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('wb') as raw:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as zipped:
            zipped.write(encoded)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--registry', type=Path, default=DEFAULT_REGISTRY)
    parser.add_argument('--out', type=Path, default=DEFAULT_OUT)
    parser.add_argument('--region', action='append', help='fetch only this region (repeatable)')
    args = parser.parse_args()

    registry = json.loads(args.registry.read_text())
    if registry.get('format') != 1 or not isinstance(registry.get('regions'), dict):
        raise SystemExit('route source registry must use format 1 and contain regions')
    wanted = set(args.region or registry['regions'])
    unknown = wanted - set(registry['regions'])
    if unknown:
        raise SystemExit(f'unknown route-source region(s): {", ".join(sorted(unknown))}')

    features = []
    sources = []
    for region in sorted(wanted):
        for source in registry['regions'][region].get('sources') or []:
            if source.get('approved') is not True:
                raise SystemExit(f'{region}:{source.get("id", "unnamed")} is not approved')
            adapter = ADAPTERS.get(source.get('adapter'))
            if not adapter:
                raise SystemExit(f'{region}:{source["id"]} uses unknown adapter {source.get("adapter")}')
            built = adapter(region, source)
            features.extend(built)
            sources.append({
                'region': region,
                'id': source['id'],
                'label': source['label'],
                'authority': source['authority'],
                'reviewed': source['reviewed'],
                'sourceUrl': source['sourceUrl'],
                'routes': len(built),
            })
            print(f'{region}: {source["label"]}: {len(built)} approved routes')

    features.sort(key=lambda feature: (
        feature['properties']['region'], feature['properties']['sourceId'],
        feature['properties']['n']))
    output = {
        'type': 'FeatureCollection',
        'format': 1,
        'sources': sources,
        'features': features,
    }
    write_gzip_json(args.out, output)
    print(f'wrote {args.out}: {len(features)} supplemental routes')


if __name__ == '__main__':
    main()
