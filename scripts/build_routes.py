#!/usr/bin/env python3
"""Extract designated bike-route relations from an OSM extract.

OSM maps designated cycling routes (U.S. Bicycle Routes, regional rail-trails)
as route=bicycle RELATIONS whose members are the ordinary ways the route
follows. WSDOT publishes these only as PDFs, but the designations are fully
mapped: network=ncn (national, i.e. USBR + Selkirk Loop) and network=rcn
(regional trails like the Burke-Gilman or Palouse to Cascades).

Output: data/bikeroutes.geojson — one MultiLineString feature per relation,
properties t (ncn|rcn), r (ref, e.g. "10"), n (name). Local networks (lcn,
neighborhood greenways) are skipped as visual noise at state scale.

Usage:
  python3 scripts/build_routes.py --src data/washington-latest.osm.pbf
"""
import argparse
import json

import osmium

KEEP_NETWORKS = {'ncn', 'rcn'}


def route_way_is_open(tags):
    """Whether a relation member should be drawn as a usable bike route.

    Relations can temporarily retain demolished, washed-out, construction, or
    otherwise closed ways. Drawing those members as an unbroken orange ribbon
    contradicts the routing graph and falsely suggests a safe connection.
    """
    bike = tags.get('bicycle')
    if bike in ('no', 'dismount'):
        return False
    if tags.get('access') in ('private', 'no') and bike not in ('yes', 'designated', 'permissive'):
        return False
    if tags.get('route') == 'ferry':
        return True
    highway = tags.get('highway')
    return bool(highway and highway not in ('construction', 'proposed', 'raceway', 'steps'))


def closure_reason(tags):
    """Return a human-readable closure reason, if this member is blocked."""
    if tags.get('destroyed:highway'):
        return tags.get('note') or 'Road destroyed or closed'
    if tags.get('highway') in ('construction', 'proposed'):
        return tags.get('construction') or 'Road under construction'
    if tags.get('bicycle') in ('no', 'dismount'):
        return 'Bicycles are not permitted'
    if tags.get('access') in ('private', 'no') and tags.get('bicycle') not in ('yes', 'designated', 'permissive'):
        return 'Route segment is closed to public bicycle access'
    return None


def collect_relations(src):
    """Pass A: route=bicycle relations -> meta + member way ids (transitive)."""
    meta = {}          # rel id -> {t, r, n}
    way_members = {}   # rel id -> set(way ids)
    sub_members = {}   # rel id -> set(rel ids)
    for o in osmium.FileProcessor(src, osmium.osm.RELATION):
        t = o.tags
        if t.get('route') != 'bicycle':
            continue
        if t.get('network') not in KEEP_NETWORKS:
            continue
        if t.get('state') == 'proposed':
            continue
        meta[o.id] = {'t': t.get('network'), 'r': t.get('ref', ''), 'n': t.get('name', '')}
        ways, subs = set(), set()
        for m in o.members:
            if m.type == 'w':
                ways.add(m.ref)
            elif m.type == 'r':
                subs.add(m.ref)
        way_members[o.id] = ways
        sub_members[o.id] = subs
    # resolve nested relations (super-routes) transitively within the kept set
    for rid in meta:
        seen, stack = set(), list(sub_members.get(rid, ()))
        while stack:
            s = stack.pop()
            if s in seen or s not in meta:
                continue
            seen.add(s)
            way_members[rid] |= way_members.get(s, set())
            stack.extend(sub_members.get(s, ()))
    return meta, way_members


def collect_geometry(src, needed):
    """Pass B: coords for every needed member way."""
    geom, closures = {}, {}
    for o in osmium.FileProcessor(src).with_locations():
        if not o.is_way() or o.id not in needed:
            continue
        tags = {t.k: t.v for t in o.tags}
        coords = [[round(n.lon, 6), round(n.lat, 6)] for n in o.nodes if n.location.valid()]
        reason = closure_reason(tags)
        if reason and len(coords) >= 2:
            closures[o.id] = {'coords': coords, 'name': tags.get('name', 'Closed route segment'),
                              'reason': reason}
            continue
        if not route_way_is_open(tags):
            continue
        if len(coords) >= 2:
            geom[o.id] = coords
    return geom, closures


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default='data/washington-latest.osm.pbf')
    ap.add_argument('--out', default='data/bikeroutes.geojson')
    args = ap.parse_args()

    meta, way_members = collect_relations(args.src)
    needed = set().union(*way_members.values()) if way_members else set()
    print(f'{len(meta)} route relations, {len(needed):,} member ways', flush=True)
    geom, closures = collect_geometry(args.src, needed)
    print(f'geometry resolved for {len(geom):,} ways', flush=True)

    feats = []
    for rid, m in sorted(meta.items()):
        lines = [geom[w] for w in sorted(way_members[rid]) if w in geom]
        if not lines:
            continue  # e.g. members entirely outside the extract
        feats.append({
            'type': 'Feature',
            'properties': {'t': m['t'], 'r': m['r'], 'n': m['n']},
            'geometry': {'type': 'MultiLineString', 'coordinates': lines},
        })
    fc = {'type': 'FeatureCollection', 'features': feats}
    with open(args.out, 'w') as f:
        json.dump(fc, f, separators=(',', ':'))
    closure_features = []
    for wid, closure in closures.items():
        routes = [meta[rid].get('r', '') for rid, members in way_members.items() if wid in members]
        coords = closure['coords']
        mid = coords[len(coords) // 2]
        props = {'name': closure['name'], 'reason': closure['reason'], 'routes': ', '.join(filter(None, routes))}
        closure_features.append({'type': 'Feature', 'properties': props,
                                 'geometry': {'type': 'LineString', 'coordinates': coords}})
        closure_features.append({'type': 'Feature', 'properties': props,
                                 'geometry': {'type': 'Point', 'coordinates': mid}})
    closure_out = args.out.replace('bikeroutes.geojson', 'route_closures.geojson')
    with open(closure_out, 'w') as f:
        json.dump({'type': 'FeatureCollection', 'features': closure_features}, f, separators=(',', ':'))
    ncn = sum(1 for f in feats if f['properties']['t'] == 'ncn')
    print(f"wrote {args.out}: {len(feats)} routes ({ncn} national, {len(feats) - ncn} regional), "
          f"{len(closures)} closures",
          flush=True)


if __name__ == '__main__':
    main()
