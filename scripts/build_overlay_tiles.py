#!/usr/bin/env python3
"""Build maps/<state>/overlays.pmtiles: the two street-detail overlays as vector tiles.

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
    python3 scripts/build_overlay_tiles.py --state oregon
    node scripts/stamp_tiles_version.mjs oregon   # then restamp so PWAs refresh

Inputs and output are the state's own folder. They were `data/` paths for as
long as the overlays lived there; the files moved into maps/<state>/ and this
script was left reading a directory that no longer holds them, so it could not
rebuild even Washington's archive without the sources being copied back by
hand. A state that ships no `blts.geojson.gz` gets an empty `blts` layer rather
than a missing one, because the app's source list expects the layer to exist.

Prints the per-layer feature counts; SOURCES in app.js bakes them (tiles do
not carry a global count).
"""
import argparse
import gzip
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'data'

DEDICATED_HW = {'cycleway', 'path', 'footway', 'bridleway', 'track', 'service'}


def osm_cycleway(props):
    # Tag precedence mirrors osmCycleway() in app.js: right before left.
    return (props.get('cycleway') or props.get('cycleway:both')
            or props.get('cycleway:right') or props.get('cycleway:left') or None)


def sharrow_only(props):
    if osm_cycleway(props) != 'shared_lane':
        return False
    return props.get('highway') not in DEDICATED_HW


def load(folder, name):
    path = folder / name
    if not path.exists():
        print(f'  {path} is not present; that layer will be empty')
        return {'type': 'FeatureCollection', 'features': []}
    with gzip.open(path) as fh:
        return json.load(fh)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--state', default='washington')
    args = ap.parse_args()
    folder = ROOT / 'maps' / args.state
    if not (folder / 'region.json').exists():
        raise SystemExit(f'no such state: maps/{args.state}/region.json')

    bikeinfra = load(folder, 'bikeinfra.geojson.gz')
    kept = [f for f in bikeinfra['features'] if not sharrow_only(f['properties'])]
    dropped = len(bikeinfra['features']) - len(kept)
    bikeinfra['features'] = kept

    blts = load(folder, 'blts.geojson.gz')

    tmp_bi = DATA / 'overlay-bikeinfra.tmp.geojson'
    tmp_bl = DATA / 'overlay-blts.tmp.geojson'
    tmp_bi.write_text(json.dumps(bikeinfra))
    tmp_bl.write_text(json.dumps(blts))

    out = folder / 'overlays.pmtiles'
    # Same shaping flags as the roads build (see README), with one deliberate
    # difference: NO --drop-densest-as-needed. Roads can thin at low zoom
    # because the class-based reveal hides most of them anyway; this archive
    # is the bike network itself, and a trail that vanishes when zoomed out
    # is data loss, not decluttering. --coalesce merges same-attribute
    # segments instead.
    # Below z9 a tile covers a county or more, and these low-zoom tiles used
    # to carry the ENTIRE statewide dataset each (no drop-densest, by design).
    # Loading them bucketed ~93k features per zoom level crossed -- measured
    # as WebKit killing the page on zoom-out (phone and Mac Safari alike).
    # What a statewide view actually shows is the trail network, so below z9
    # bikeinfra keeps only off-street ways and blts (which paints nothing --
    # it exists for tap cards, and taps only resolve from z9 up) is dropped
    # entirely. From z9 every feature is present, exactly as before.
    low_zoom_filter = json.dumps({
        'bikeinfra': ['any', ['>=', '$zoom', 9],
                      ['in', 'highway', 'cycleway', 'path', 'footway',
                       'bridleway', 'track', 'service']],
        'blts': ['all', ['>=', '$zoom', 9]],
    })
    cmd = [
        'tippecanoe', '-o', str(out), '--force',
        '-Z4', '-z13',
        '--coalesce',
        '--simplification=8', '--simplify-only-low-zooms',
        '--no-feature-limit', '--no-tile-size-limit',
        '--read-parallel',
        '-j', low_zoom_filter,
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
    print(f'bake the counts above into SOURCES in app.js, then run '
          f'node scripts/stamp_tiles_version.mjs {args.state}')


if __name__ == '__main__':
    sys.exit(main())
