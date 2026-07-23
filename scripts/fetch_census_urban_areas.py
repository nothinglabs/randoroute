#!/usr/bin/env python3
"""Fetch 2020 Census Urban Area polygons that intersect Washington.

The result is a small build-only GeoJSON input for build_graph.py and
build_roads.py. It remains git-ignored like the OSM and WSDOT source files.
"""
import argparse
import json
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen


URL = ('https://tigerweb.geo.census.gov/arcgis/rest/services/'
       'TIGERweb/tigerWMS_ACS2024/MapServer/88/query')
# Washington plus a small buffer, in EPSG:4326 (xmin, ymin, xmax, ymax).
WASHINGTON_ENVELOPE = '-124.85,45.54,-116.92,49.05'


def fetch(out_path):
    params = {
        'where': '1=1',
        'outFields': 'GEOID,NAME',
        'geometry': WASHINGTON_ENVELOPE,
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
    parser.add_argument('--out', default='data/census-urban-areas-2020-wa.geojson')
    fetch(parser.parse_args().out)
