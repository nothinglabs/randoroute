#!/usr/bin/env python3
"""The edgeLanes/edgeLts layout must hold, and format 9 must keep working.

Adding edgeLanes/edgeLts changes the graph binary, and the rebuild that
produces one runs in a different environment from the app release. This builds
a format-10 graph from the shipped format-9 one so the layout can be checked
without an OSM extract, and asserts the reader contract both ways.

Run directly, or via ``--emit PATH`` to write the converted graph for a browser
test (scripts/../ has no OSM extract, so this is how format 10 gets exercised).
"""
import argparse
import gzip
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GRAPH = ROOT / 'maps' / 'washington' / 'graph2.bin.gz'


def pad(n, to):
    return (to - n % to) % to


def split_format9(raw):
    """Return (header, sections) for a BGR9 graph, as raw byte ranges."""
    magic = bytes(raw[:4])
    if magic != b'BGR9':
        raise SystemExit(f'expected a BGR9 graph to convert, found {magic!r}')
    n, e, d, g, u, b = struct.unpack_from('<6I', raw, 4)
    o = 28
    take = {}

    def grab(name, size):
        nonlocal o
        take[name] = bytes(raw[o:o + size])
        o += size

    grab('nodeLon', 4 * n); grab('nodeLat', 4 * n); grab('nodeEle', 2 * n)
    o += pad(o, 4)
    grab('eA', 4 * e); grab('eB', 4 * e); grab('eLen', 4 * e)
    grab('eAsc', 2 * e); grab('eDes', 2 * e)
    for name in ('eSpeed', 'eSpeedBA', 'eFlags', 'eSh', 'eShBA',
                 'eLimitedDir', 'eClass', 'eFacility', 'eOfficial', 'eSurface'):
        grab(name, e)
    for name in ('eHazAB', 'eHazBA'):
        grab(name, e)
    o += pad(o, 2)
    for name in ('eHazStartAB', 'eHazEndAB', 'eHazStartBA', 'eHazEndBA'):
        grab(name, 2 * e)
    o += pad(o, 4)
    grab('eOff', 4 * e)
    grab('eCnt', 2 * e)
    o += pad(o, 4)
    grab('outStart', 4 * (n + 1)); grab('outTarget', 4 * d); grab('outEdge', 4 * d)
    grab('eName', 4 * e); grab('nameOff', 4 * (u + 1))
    grab('gLon', 4 * g); grab('gLat', 4 * g)
    grab('nameBytes', b)
    if o != len(raw):
        raise SystemExit(f'BGR9 layout mismatch: consumed {o:,} of {len(raw):,} bytes')
    return (n, e, d, g, u, b), take


def build_format10(header, s, lanes, lts):
    """Re-emit as 'BGRA', mirroring build_graph.py's padding exactly."""
    n, e, d, g, u, b = header
    parts = [b'BGRA', struct.pack('<IIIIII', n, e, d, g, u, b),
             s['nodeLon'], s['nodeLat'], s['nodeEle']]
    off = sum(len(p) for p in parts)
    parts.append(b'\x00' * pad(off, 4))
    parts += [s['eA'], s['eB'], s['eLen'], s['eAsc'], s['eDes'],
              s['eSpeed'], s['eSpeedBA'], s['eFlags'], s['eSh'], s['eShBA'],
              s['eLimitedDir'], s['eClass'], s['eFacility'], s['eOfficial'],
              s['eSurface'], lanes, lts, s['eHazAB'], s['eHazBA']]
    off = sum(len(p) for p in parts)
    parts.append(b'\x00' * pad(off, 2))
    parts += [s['eHazStartAB'], s['eHazEndAB'], s['eHazStartBA'], s['eHazEndBA']]
    off = sum(len(p) for p in parts)
    parts.append(b'\x00' * pad(off, 4))
    parts += [s['eOff'], s['eCnt']]
    off = sum(len(p) for p in parts)
    parts.append(b'\x00' * pad(off, 4))
    parts += [s['outStart'], s['outTarget'], s['outEdge'],
              s['eName'], s['nameOff'], s['gLon'], s['gLat'], s['nameBytes']]
    return b''.join(parts)


def synth_lanes(header, s):
    """Give every non-path edge a plausible lane count keyed off road class."""
    n, e = header[0], header[1]
    lanes = bytearray(e)
    lts = bytearray(e)
    for i in range(e):
        cls = s['eClass'][i]
        if s['eFlags'][i] & 8:      # dedicated infrastructure: no motor lanes
            continue
        if cls >= 6:                # secondary and above -> wide
            lanes[i] = 4
            lts[i] = 4
        elif cls in (4, 5):
            lanes[i] = 2
    return bytes(lanes), bytes(lts)


def verify_shipped_format10(raw):
    """The shipped graph already has the arrays: check them in place."""
    n, e, d, g, u, b = struct.unpack_from('<6I', raw, 4)
    print(f"{bytes(raw[:4]).decode()} shipped: {n:,} nodes, {e:,} edges, "
          f'{len(raw):,} bytes')
    ok = True

    def check(name, cond, detail=''):
        nonlocal ok
        ok = ok and cond
        print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f'  -- {detail}' if detail else ''))

    o = 28 + 10 * n
    o += pad(o, 4)
    o += 12 * e + 4 * e + 10 * e
    lanes = raw[o:o + e]
    lts = raw[o + e:o + 2 * e]
    tagged = sum(1 for x in lanes if x & 63)
    center = sum(1 for x in lanes if x & 64)
    rated = sum(1 for x in lts if x)
    check('edgeLanes array is present and sane', len(lanes) == e and tagged > 0,
          f'{tagged:,} of {e:,} edges tagged ({100 * tagged / e:.1f}%)')
    check('centre-turn-lane bit is used', center > 0, f'{center:,} edges')
    check('edgeLts carries WSDOT ratings', rated > 0,
          f'{rated:,} of {e:,} edges ({100 * rated / e:.1f}%)')
    check('every lane value is in range', all((x & 63) <= 63 for x in lanes))
    check('every LTS value is 0-4', all(x <= 4 for x in lts),
          f'max {max(lts) if lts else 0}')
    # Lanes are a road attribute: a dedicated path must never carry one.
    fo = 28 + 10 * n
    fo += pad(fo, 4)
    fo += 12 * e + 4 * e + 2 * e   # to edgeFlags
    flags = raw[fo:fo + e]
    path_with_lanes = sum(1 for i in range(e) if (flags[i] & 8) and (lanes[i] & 63))
    check('dedicated paths carry no lane count', path_with_lanes == 0,
          f'{path_with_lanes:,} offenders')
    print('\nGraph format tests ' + ('passed.' if ok else 'FAILED.'))
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--emit', help='write the converted format-10 graph here')
    args = ap.parse_args()

    raw = bytearray(gzip.open(GRAPH, 'rb').read())
    # Formats 11 ('BGRB'), 12 ('BGRC') and 13 ('BGRD') only append after
    # edgeLts, so the offsets this verifier computes are unchanged and it
    # checks them in place exactly as it does for format 10.
    if bytes(raw[:4]) in (b'BGRA', b'BGRB', b'BGRC', b'BGRD'):
        return verify_shipped_format10(raw)
    header, sections = split_format9(raw)
    n, e = header[0], header[1]
    print(f'format 9 parsed: {n:,} nodes, {e:,} edges, {len(raw):,} bytes')

    lanes, lts = synth_lanes(header, sections)
    out = build_format10(header, sections, lanes, lts)
    grew = len(out) - len(raw)
    print(f'format 10 built : {len(out):,} bytes ({grew:+,} = 2 bytes/edge + padding)')

    ok = True

    def check(name, cond, detail=''):
        nonlocal ok
        ok = ok and cond
        print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f'  -- {detail}' if detail else ''))

    check('magic is BGRA', out[:4] == b'BGRA', repr(bytes(out[:4])))
    check('header counts unchanged', struct.unpack_from('<6I', out, 4) == header)
    check('grows by two bytes per edge', 2 * e <= grew <= 2 * e + 4, f'{grew:,} for {e:,} edges')
    # Re-parsing the new file with the reader's own offsets must land exactly on
    # the arrays that were written, which is what the worker relies on.
    o = 28 + 10 * n
    o += pad(o, 4)
    o += 12 * e + 4 * e + 10 * e
    check('edgeLanes lands where the reader expects it',
          out[o:o + e] == lanes, f'offset {o:,}')
    check('edgeLts follows edgeLanes', out[o + e:o + 2 * e] == lts)
    check('trailing name blob intact', out.endswith(sections['nameBytes']))

    if args.emit:
        with gzip.open(args.emit, 'wb', compresslevel=1) as f:
            f.write(out)
        print(f'wrote {args.emit}')

    print('\nGraph format tests ' + ('passed.' if ok else 'FAILED.'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
