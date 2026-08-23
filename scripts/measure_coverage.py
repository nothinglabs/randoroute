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
  python3 scripts/measure_coverage.py --signals                # per-signal detail
"""
import argparse
import gzip
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

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
OWNER_NAME = {0: 'unknown', 1: 'state', 2: 'county', 3: 'town', 4: 'city'}
ADT_SOURCE_NAME = {0: 'unknown', 1: 'county road log', 2: 'state DOT count',
                   3: 'FHWA HPMS'}
PROHIBITED_SHOULDER = -128
OFFICIAL_SPEED, OFFICIAL_FACILITY = 1, 2


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
    sh_at = off
    off += e + e                          # eSh, eShBA
    off += e                              # eLimitedDir
    class_at = off
    off += e                              # eClass
    off += e                              # eFacility
    official_at = off
    off += e + e                          # eOfficial, eSurface
    off += e                              # eLanes
    lts_at = off
    off += e                              # eLts
    space_at = off
    off += e                              # eEdgeSpace
    county_sh_at = off
    off += e                              # eCountyShoulder
    adt_at = off
    off += 2 * e                          # eAdt
    adt_meta_at = off
    off += e                              # eAdtMeta
    adt_source_at = off
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
        'sh': arr('b', sh_at, e),
        'shBA': arr('b', sh_at + e, e),
        'lts': arr('B', lts_at, e),
        'official': arr('B', official_at, e),
        'adtMeta': arr('B', adt_meta_at, e) if has_measures else None,
        'adtSource': arr('B', adt_source_at, e) if has_adt_source else None,
        'space': arr('B', space_at, e) if has_measures else None,
        'countySh': arr('B', county_sh_at, e) if has_measures else None,
        'adt': arr('H', adt_at, e) if has_measures else None,
        'classOwner': arr('B', class_owner_at, e) if has_measures else None,
        'geomOff': arr('I', geom_off_at, e),
        'geomCnt': arr('H', geom_cnt_at, e),
        'lon': arr('f', lon_at, g),
        'lat': arr('f', lat_at, g),
    }


def signal_report(G):
    """Coverage of the three measured signals: shoulder, agency stress, traffic.

    Shoulder is credited to the agency where the edge also carries an agency
    match (a stress rating, an official speed or an official facility) and to
    OSM where it does not -- the conflation only fills a shoulder OSM left
    blank, so a value outside the agency footprint can only be a tag.
    """
    E = G['E']
    total = paths = ferries = 0.0
    sh_either = sh_both = sh_agency = sh_osm = sh_ridable = 0.0
    lts_mi = adt_mi = speed_mi = facility_mi = est_speed_mi = prohibited = 0.0
    lts_hist, adt_src, adt_year = {}, {}, {}
    by_class, by_owner = {}, {}

    for i in range(E):
        flags = G['flags'][i]
        mi = G['len'][i] * MI
        if flags & FLAG_FERRY:
            ferries += mi
            continue
        if flags & FLAG_INFRA:
            paths += mi
            continue
        total += mi
        sh, sh_ba = G['sh'][i], G['shBA'][i]
        known = sh >= 0 or sh_ba >= 0
        lts = G['lts'][i]
        official = G['official'][i]
        agency = bool(lts) or bool(official & (OFFICIAL_SPEED | OFFICIAL_FACILITY))
        if sh == PROHIBITED_SHOULDER or sh_ba == PROHIBITED_SHOULDER:
            prohibited += mi
        if known:
            sh_either += mi
            if agency:
                sh_agency += mi
            else:
                sh_osm += mi
        if sh >= 0 and sh_ba >= 0:
            sh_both += mi
        if max(sh, sh_ba) >= 4:
            sh_ridable += mi
        if lts:
            lts_mi += mi
            lts_hist[lts] = lts_hist.get(lts, 0.0) + mi
        adt = G['adt'][i] if G['adt'] else 0
        if adt:
            adt_mi += mi
            src = G['adtSource'][i] if G['adtSource'] else 0
            adt_src[src] = adt_src.get(src, 0.0) + mi
            meta = G['adtMeta'][i] if G['adtMeta'] else 0
            year = 1940 + (meta & 0x7f) if meta & 0x7f else 0
            adt_year[year] = adt_year.get(year, 0.0) + mi
        if official & OFFICIAL_SPEED:
            speed_mi += mi
        if official & OFFICIAL_FACILITY:
            facility_mi += mi
        if flags & 1:
            est_speed_mi += mi

        owner_class = G['classOwner'][i] if G['classOwner'] else 0
        level = (owner_class & 15) or OSM_CLASS_TO_FUNCTIONAL.get(G['class'][i], 0)
        owner = (owner_class >> 4) & 15
        for table, key in ((by_class, level), (by_owner, owner)):
            row = table.setdefault(key, {'mi': 0.0, 'sh': 0.0, 'lts': 0.0, 'adt': 0.0})
            row['mi'] += mi
            if known:
                row['sh'] += mi
            if lts:
                row['lts'] += mi
            if adt:
                row['adt'] += mi

    pct = lambda x: f'{100.0 * x / total:5.1f}%' if total else '  n/a'
    line = lambda name, v: print(f'  {name:<38}{v:>10,.0f}  {pct(v)}')

    print(f'\nroad miles (excluding paths and ferries)  {total:,.0f}'
          f'   [paths {paths:,.0f}, ferries {ferries:,.0f}]')

    print('\nshoulder width')
    line('known in at least one direction', sh_either)
    line('  of which from an agency inventory', sh_agency)
    line('  of which from OSM tags alone', sh_osm)
    line('known in both directions', sh_both)
    line('4 ft or wider one direction+', sh_ridable)
    line('permanently prohibited to bicycles', prohibited)

    print('\nagency bicycle stress rating')
    line('rated', lts_mi)
    for level in sorted(lts_hist):
        line(f'  LTS {level}', lts_hist[level])

    print('\ntraffic volume')
    line('counted', adt_mi)
    for src in sorted(adt_src):
        line(f'  {ADT_SOURCE_NAME.get(src, src)}', adt_src[src])
    years = sorted((y for y in adt_year if y))
    if years:
        half = sum(adt_year[y] for y in years) / 2.0
        run = 0.0
        median = years[-1]
        for y in years:
            run += adt_year[y]
            if run >= half:
                median = y
                break
        stale = sum(adt_year[y] for y in years if y < 2015)
        print(f'  count year {years[0]}-{years[-1]}, median {median},'
              f' {100.0 * stale / adt_mi:.1f}% before 2015')

    print('\nother agency facts, for reference')
    line('official (legal) speed', speed_mi)
    line('official bicycle facility record', facility_mi)
    line('speed is a road-class estimate', est_speed_mi)

    for title, table, names in (('FHWA functional class', by_class, CLASS_NAME),
                                ('FHWA roadway owner', by_owner, OWNER_NAME)):
        print(f'\ncoverage by {title}:')
        print(f"  {'':<22}{'miles':>10}{'shoulder':>10}{'stress':>9}{'traffic':>9}")
        for key in sorted(table, key=lambda k: (k == 0, k)):
            row = table[key]
            m = row['mi']
            name = names.get(key, 'unclassified' if table is by_class else key)
            print(f'  {name:<22}{m:>10,.0f}{100*row["sh"]/m:>9.1f}%'
                  f'{100*row["lts"]/m:>8.1f}%{100*row["adt"]/m:>8.1f}%')


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--graph', default='maps/washington/graph2.bin.gz')
    ap.add_argument('--add', help='a candidate source to measure against the gap')
    ap.add_argument('--label', default='candidate')
    ap.add_argument('--signals', action='store_true',
                    help='per-signal coverage: shoulder, agency stress, traffic')
    args = ap.parse_args()

    print('reading graph...', flush=True)
    G = read_graph(args.graph)
    E = G['E']

    if args.signals:
        signal_report(G)
        if not args.add:
            return

    candidate = None
    if args.add:
        # Only the --add path needs the geometry index, and it drags in numpy
        # and shapely. Importing it lazily lets the plain reports run anywhere.
        from roadmeasure import MeasureIndex
        candidate = MeasureIndex(args.add, args.label)

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
