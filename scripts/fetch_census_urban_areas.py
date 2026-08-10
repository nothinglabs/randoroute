#!/usr/bin/env python3
"""Fetch 2020 Census Urban Area polygons covering one state's coverage box.

The result is a small build-only GeoJSON input for build_graph.py and
build_roads.py. It remains git-ignored like the OSM and agency source files.

The box comes from `maps/<state>/region.json`, the same place scripts/fetch_dem.sh
reads it, so the urban/rural test cannot cover a different rectangle than the
one the app filters place searches against. Washington's envelope was hardcoded
here for as long as there was only one state.

Usage:
  python3 scripts/fetch_census_urban_areas.py <state>
  python3 scripts/fetch_census_urban_areas.py <state> --out data/urban.geojson
"""
import argparse
import json
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen


URL = ('https://tigerweb.geo.census.gov/arcgis/rest/services/'
       'TIGERweb/tigerWMS_ACS2024/MapServer/88/query')
ROOT = Path(__file__).resolve().parent.parent


def envelope(state):
    """The state's declared coverage box as an EPSG:4326 esri envelope."""
    config = json.loads((ROOT / 'maps' / state / 'region.json').read_text())
    b = config['bounds']
    return f"{b['minLon']},{b['minLat']},{b['maxLon']},{b['maxLat']}"


def fetch(out_path, box):
    params = {
        'where': '1=1',
        'outFields': 'GEOID,NAME',
        'geometry': box,
        'geometryType': 'esriGeometryEnvelope',
        'inSR': '4326',
        'spatialRel': 'esriSpatialRelIntersects',
        'outSR': '4326',
        'returnGeometry': 'true',
        'f': 'geojson',
    }
    with urlopen(URL + '?' + urlencode(params), timeout=90) as response:
        body = response.read()
    payload = json.loads(body)
    if payload.get('error') or not payload.get('features'):
        raise RuntimeError(f'Census urban-area request returned no features: {payload.get("error")}')
    target = Path(out_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(body)
    print(f'Wrote {target}: {len(payload["features"]):,} Census urban areas')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('state', nargs='?', default='washington',
                        help='the maps/<state>/ folder whose bounds to cover')
    parser.add_argument('--out', default=None,
                        help='default data/census-urban-areas-2020-<state>.geojson')
    args = parser.parse_args()
    fetch(args.out or f'data/census-urban-areas-2020-{args.state}.geojson',
          envelope(args.state))
