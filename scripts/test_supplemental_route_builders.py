#!/usr/bin/env python3
"""The supplemental-route pipeline stays approval-gated and idempotent."""

import gzip
import json
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def write(path, value):
    path.write_text(json.dumps(value), encoding='utf-8')


with tempfile.TemporaryDirectory() as directory:
    tmp = Path(directory)
    unapproved = tmp / 'unapproved.json'
    write(unapproved, {
        'format': 1,
        'regions': {'test': {'sources': [{
            'id': 'not-reviewed', 'approved': False, 'adapter': 'arcgis-geojson',
        }]}}
    })
    result = subprocess.run([
        'python3', str(ROOT / 'scripts' / 'build_supplemental_routes.py'),
        '--registry', str(unapproved), '--out', str(tmp / 'should-not-exist.gz'),
    ], capture_output=True, text=True, check=False)
    assert result.returncode != 0
    assert 'not approved' in result.stderr + result.stdout
    assert not (tmp / 'should-not-exist.gz').exists()

    registry = tmp / 'registry.json'
    base = tmp / 'routes.geojson'
    snapshot = tmp / 'supplemental.json'
    write(registry, {
        'format': 1,
        'regions': {'test': {'sources': [{
            'id': 'agency', 'label': 'County Routes', 'authority': 'Test County',
            'approved': True, 'sourceUrl': 'https://example.test/routes',
        }]}}
    })
    write(base, {
        'type': 'FeatureCollection', 'routeCount': 1,
        'features': [{
            'type': 'Feature',
            'properties': {'n': 'River Route', 't': 'rcn', 'r': 'RR'},
            'geometry': {'type': 'LineString',
                         'coordinates': [[-122.0, 47.0], [-121.99, 47.0]]},
        }],
    })
    write(snapshot, {
        'type': 'FeatureCollection', 'format': 1,
        'features': [{
            'type': 'Feature',
            'properties': {'region': 'test', 'sourceId': 'agency',
                           'routeId': 'river', 'n': 'River Route'},
            'geometry': {'type': 'MultiLineString', 'coordinates': [
                [[-122.0, 47.0], [-121.99, 47.0], [-121.98, 47.0]],
            ]},
        }],
    })
    command = [
        'python3', str(ROOT / 'scripts' / 'merge_route_sources.py'),
        '--region', 'test', '--base', str(base), '--out', str(base),
        '--registry', str(registry), '--supplemental', str(snapshot),
    ]
    subprocess.run(command, check=True, capture_output=True, text=True)
    first = json.loads(base.read_text())
    subprocess.run(command, check=True, capture_output=True, text=True)
    second = json.loads(base.read_text())
    assert second == first, 're-running a source merge must not duplicate geometry'
    assert len(second['routeCatalog']) == 1
    assert second['routeCatalog'][0]['sourceIds'] == ['osm', 'agency']
    assert len(second['features']) == 2, 'only the uncovered official run is appended'

print('Supplemental-route builders reject unapproved inputs and merge idempotently.')
