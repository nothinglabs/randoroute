#!/usr/bin/env python3
"""Build data/overlays.pmtiles: the two street-detail overlays as vector tiles.

The OSM bike-infrastructure layer (38k features) and the WSDOT BLTS layer
(55k) used to load as whole GeoJSON collections. Between the parsed copy the
map retains, the serialized copy in the map worker, and the worker's
geojson-vt tile index, they held ~440 MB of a ~1 GB renderer -- for data the
rider only ever sees a viewport's worth of. As vector tiles the browser
fetches only the tiles in view, exactly the move that took roads.geojson
(78 MB, crashing iOS) to roads.pmtiles.

Layer names are the app's source-layer contract: `bikeinfra` and `blts`.
Every attribute is preserved -- the tap cards re-score a tapped feature's
properties, and the layer filters read raw OSM tags (cycleway*, highway,
surface, mtb...), so nothing here may be trimmed to "what the paint needs".

The sharrow-only drop that app.js used to apply at load happens here instead:
a way whose only bike credential is sharrow paint is not bike infrastructure,
and dropping it lets the roads layer beneath answer taps with the speed,
shoulder and lane data this source lacks. Mirrors sharrowOnly() in app.js.

Usage:
    python3 scripts/build_overlay_tiles.py
    node scripts/stamp_tiles_version.mjs   # then restamp so PWAs refresh

Prints the per-layer feature counts; SOURCES in app.js bakes them (tiles do
not carry a global count).
"""
import gzip
import json
import subprocess
import sys
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / 'data'

DEDICATED_HW = {'cycleway', 'path', 'footway', 'bridleway', 'track', 'service'}


def osm_cycleway(props):
    # Tag precedence mirrors osmCycleway() in app.js: right before left.
    return (props.get('cycleway') or props.get('cycleway:both')
            or props.get('cycleway:right') or props.get('cycleway:left') or None)


def sharrow_only(props):
    if osm_cycleway(props) != 'shared_lane':
        return False
    return props.get('highway') not in DEDICATED_HW


def load(name):
    with gzip.open(DATA / name) as fh:
        return json.load(fh)


def main():
    bikeinfra = load('bikeinfra.geojson.gz')
    kept = [f for f in bikeinfra['features'] if not sharrow_only(f['properties'])]
    dropped = len(bikeinfra['features']) - len(kept)
    bikeinfra['features'] = kept

    blts = load('blts.geojson.gz')

    tmp_bi = DATA / 'overlay-bikeinfra.tmp.geojson'
    tmp_bl = DATA / 'overlay-blts.tmp.geojson'
    tmp_bi.write_text(json.dumps(bikeinfra))
    tmp_bl.write_text(json.dumps(blts))

    out = DATA / 'overlays.pmtiles'
    # Same shaping flags as the roads build (see README), with one deliberate
    # difference: NO --drop-densest-as-needed. Roads can thin at low zoom
    # because the class-based reveal hides most of them anyway; this archive
    # is the bike network itself, and a trail that vanishes when zoomed out
    # is data loss, not decluttering. --coalesce merges same-attribute
    # segments instead.
    cmd = [
        'tippecanoe', '-o', str(out), '--force',
        '-Z4', '-z13',
        '--coalesce',
        '--simplification=8', '--simplify-only-low-zooms',
        '--no-feature-limit', '--no-tile-size-limit',
        '--read-parallel',
        '-L', f'bikeinfra:{tmp_bi}',
        '-L', f'blts:{tmp_bl}',
    ]
    try:
        subprocess.run(cmd, check=True)
    finally:
        tmp_bi.unlink(missing_ok=True)
        tmp_bl.unlink(missing_ok=True)

    print(f'bikeinfra: {len(kept)} features ({dropped} sharrow-only ways dropped)')
    print(f'blts: {len(blts["features"])} features')
    print(f'wrote {out} ({out.stat().st_size / 1e6:.1f} MB)')
    print('bake the counts above into SOURCES in app.js, then run '
          'node scripts/stamp_tiles_version.mjs')


if __name__ == '__main__':
    sys.exit(main())
