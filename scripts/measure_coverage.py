#!/usr/bin/env python3
"""
What does the app know about its own road network, and what would a source add?

BUILD-TIME ANALYSIS, not part of any build. Reads the shipped graph and reports
how much of the road network carries each measurement, broken down so the gaps
are attributable rather than just large.

Run it before adopting a source, so the decision rests on measured coverage
rather than on the source's own advertised row count. An earlier estimate here
put a source at ~50% by treating every row as conflatable; a third of them were
gravel roads absent from the routing graph entirely.

Usage:
  python3 scripts/measure_coverage.py                    # what we have now
  python3 scripts/measure_coverage.py --add data/hpms.geojson --label HPMS
"""
import argparse
import gzip
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from roadmeasure import MeasureIndex, length_m  # noqa: E402

MI = 1.0 / 1609.344
FLAG_INFRA = 8
FLAG_FERRY = 32
MEASURE_UNKNOWN = 255

# OSM road class -> the FHWA functional scale, matching app.js.
OSM_CLASS_TO_FUNCTIONAL = {1: 7, 2: 7, 3: 6, 4: 5, 5: 5, 6: 4, 7: 4,
                           8: 3, 9: 3, 10: 3, 11: 3, 12: 2, 13: 2}
CLASS_NAME = {1: 'Interstate', 2: 'Freeway/expressway', 3: 'Principal arterial',
              4: 'Minor arterial', 5: 'Major collector', 6: 'Minor collector',
              7: 'Local street'}


def read_graph(path):
    """Minimal reader for the fields this analysis needs."""
    raw = gzip.open(path, 'rb').read()
    magic = raw[:4]
    if magic not in (b'BGRA', b'BGRB', b'BGRC'):
        raise SystemExit(f'unexpected graph magic {magic!r}')
    has_measures = magic in (b'BGRB', b'BGRC')
    has_adt_source = magic == b'BGRC'
    n, e, d, g, u, b = struct.unpack_from('<IIIIII', raw, 4)
    off = 28

    def take(fmt_size, count):
        nonlocal off
        start = off
        off += fmt_size * count
        return start, count

    def pad(k):
        nonlocal off
        off += (k - off % k) % k

    off += 4 * n + 4 * n + 2 * n          # nodeLon, nodeLat, nodeEle
    pad(4)
    off += 4 * e + 4 * e                  # eA, eB
    len_at = off
    off += 4 * e                          # eLen
    off += 2 * e + 2 * e                  # eAsc, eDes
    off += e + e                          # eSpeed, eSpeedBA
    flags_at = off
    off += e                              # eFlags
    off += e + e + e                      # eSh, eShBA, eLimitedDir
    class_at = off
    off += e                              # eClass
    off += e + e + e                      # eFacility, eOfficial, eSurface
    off += e + e                          # eLanes, eLts
    space_at = off
    off += e                              # eEdgeSpace
    county_sh_at = off
    off += e                              # eCountyShoulder
    adt_at = off
    off += 2 * e                          # eAdt
    off += e                              # eAdtMeta
    if has_adt_source:
        off += e                          # eAdtSource (format 12)
    class_owner_at = off
    off += e                              # eClassOwner
    off += e + e                          # eHazAB, eHazBA
    pad(2)
    off += 2 * e * 4                      # hazard windows
    pad(4)
    geom_off_at = off
    off += 4 * e                          # eOff
    geom_cnt_at = off
    off += 2 * e                          # eCnt
    pad(4)
    off += 4 * (n + 1) + 4 * d + 4 * d    # CSR
    off += 4 * e + 4 * (u + 1)            # eName, nameOff
    lon_at = off
    off += 4 * g
    lat_at = off
    off += 4 * g

    import array

    def arr(code, at, count):
        a = array.array(code)
        a.frombytes(raw[at:at + a.itemsize * count])
        return a

    return {
        'E': e,
        'len': arr('f', len_at, e),
        'flags': arr('B', flags_at, e),
        'class': arr('B', class_at, e),
        'space': arr('B', space_at, e) if has_measures else None,
        'countySh': arr('B', county_sh_at, e) if has_measures else None,
        'adt': arr('H', adt_at, e) if has_measures else None,
        'classOwner': arr('B', class_owner_at, e) if has_measures else None,
        'geomOff': arr('I', geom_off_at, e),
        'geomCnt': arr('H', geom_cnt_at, e),
        'lon': arr('f', lon_at, g),
        'lat': arr('f', lat_at, g),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--graph', default='data/graph2.bin.gz')
    ap.add_argument('--add', help='a candidate source to measure against the gap')
    ap.add_argument('--label', default='candidate')
    args = ap.parse_args()

    print('reading graph...', flush=True)
    G = read_graph(args.graph)
    E = G['E']

    candidate = MeasureIndex(args.add, args.label) if args.add else None

    total = 0.0
    have_adt = 0.0
    have_space = 0.0
    by_class_total = {}
    by_class_adt = {}
    gained = 0.0
    gained_by_class = {}
    still_missing = 0.0
    missing_by_class = {}

    for i in range(E):
        if G['flags'][i] & (FLAG_INFRA | FLAG_FERRY):
            continue
        mi = G['len'][i] * MI
        total += mi
        adt = bool(G['adt'][i]) if G['adt'] else False
        if adt:
            have_adt += mi
        if G['space'] and G['space'][i] != MEASURE_UNKNOWN:
            have_space += mi

        official = (G['classOwner'][i] & 15) if G['classOwner'] else 0
        level = official or OSM_CLASS_TO_FUNCTIONAL.get(G['class'][i], 0)
        by_class_total[level] = by_class_total.get(level, 0.0) + mi
        if adt:
            by_class_adt[level] = by_class_adt.get(level, 0.0) + mi

        if candidate and not adt:
            o, c = G['geomOff'][i], G['geomCnt'][i]
            coords = [[G['lon'][o + j], G['lat'][o + j]] for j in range(c)]
            if len(coords) >= 2 and candidate.match(coords):
                gained += mi
                gained_by_class[level] = gained_by_class.get(level, 0.0) + mi
            else:
                still_missing += mi
                missing_by_class[level] = missing_by_class.get(level, 0.0) + mi

    pct = lambda x: f'{100.0 * x / total:5.1f}%'
    print(f'\nroad miles (excluding paths and ferries)  {total:,.0f}')
    print(f'  with a traffic count                    {have_adt:>9,.0f}  {pct(have_adt)}')
    print(f'  with bail-out space                     {have_space:>9,.0f}  {pct(have_space)}')

    print('\ntraffic-count coverage by road class:')
    print(f"  {'class':<22}{'miles':>10}{'with count':>13}{'':>3}{'share':>7}")
    for level in sorted(by_class_total, key=lambda k: (k == 0, k)):
        t = by_class_total[level]
        a = by_class_adt.get(level, 0.0)
        name = CLASS_NAME.get(level, 'unclassified')
        print(f'  {name:<22}{t:>10,.0f}{a:>13,.0f}   {100.0*a/t if t else 0:5.1f}%')

    if candidate:
        print(f'\n{args.label} against the {total - have_adt:,.0f} mi with no count today:')
        print(f'  would gain                              {gained:>9,.0f}  {pct(gained)}')
        print(f'  still nothing                           {still_missing:>9,.0f}  {pct(still_missing)}')
        print(f'  network with a count afterwards         {have_adt + gained:>9,.0f}  '
              f'{pct(have_adt + gained)}')
        print(f'\n  gained by class:')
        for level in sorted(gained_by_class, key=lambda k: (k == 0, k)):
            name = CLASS_NAME.get(level, 'unclassified')
            g = gained_by_class[level]
            m = missing_by_class.get(level, 0.0)
            print(f'    {name:<22}{g:>9,.0f} mi gained, {m:>9,.0f} mi still missing')


if __name__ == '__main__':
    main()
