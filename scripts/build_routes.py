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

from shapely.geometry import LineString, box

KEEP_NETWORKS = {'ncn', 'rcn'}
# Match the buffered Washington coverage used by the local basemap. The
# Geofabrik extract can include complete route-relation members far outside
# Washington (notably Alaska USBR super-relations), even though ordinary ways
# are geographically clipped. Keep useful border/ferry context without
# allowing those remote members to distort the rendered map.
ROUTE_BOUNDS = (-125.5, 45.2, -116.7, 50.0)
ROUTE_CLIP = box(*ROUTE_BOUNDS)


def route_line_key(coords):
    """Direction-independent key for one physical route member."""
    forward = tuple(tuple(point) for point in coords)
    reverse = tuple(reversed(forward))
    return min(forward, reverse)


def merged_route_features(features):
    """Collapse overlapping relation members into one rendered corridor.

    A physical OSM way can belong to a regional route, a national route, and
    one or more super-relations. Rendering each relation as a translucent line
    compounds opacity and makes the same corridor look darker or beadier than
    its neighbors. Merge exact member geometry while retaining every route
    name/ref represented by that member.
    """
    corridors = {}
    for feature in features:
        geometry = feature.get('geometry') or {}
        geometry_type = geometry.get('type')
        lines = geometry.get('coordinates', [])
        if geometry_type == 'LineString':
            lines = [lines]
        elif geometry_type != 'MultiLineString':
            continue
        properties = feature.get('properties') or {}
        for coords in lines:
            if len(coords) < 2:
                continue
            key = route_line_key(coords)
            corridor = corridors.setdefault(key, {
                'coordinates': coords,
                'networks': set(),
                'refs': set(),
                'names': set(),
            })
            if properties.get('t'):
                corridor['networks'].add(properties['t'])
            if properties.get('r'):
                corridor['refs'].add(properties['r'])
            if properties.get('n'):
                corridor['names'].add(properties['n'])

    # Group corridors with identical merged metadata back into MultiLineString
    # features. This keeps the GeoJSON compact without allowing a physical
    # line to appear more than once.
    groups = {}
    for corridor in corridors.values():
        properties = {
            # A shared national/regional corridor keeps the stronger national
            # rendering width while listing all names and references.
            't': 'ncn' if 'ncn' in corridor['networks'] else 'rcn',
            'r': ', '.join(sorted(corridor['refs'])),
            'n': ' / '.join(sorted(corridor['names'])),
        }
        signature = (properties['t'], properties['r'], properties['n'])
        group = groups.setdefault(signature, {
            'type': 'Feature',
            'properties': properties,
            'geometry': {'type': 'MultiLineString', 'coordinates': []},
        })
        group['geometry']['coordinates'].append(corridor['coordinates'])
    return list(groups.values())


def clipped_line_parts(lines):
    """Return LineString coordinate parts clipped to app coverage."""
    parts = []
    for coords in lines:
        if len(coords) < 2:
            continue
        clipped = LineString(coords).intersection(ROUTE_CLIP)
        if clipped.is_empty:
            continue
        candidates = [clipped] if clipped.geom_type == 'LineString' else [
            geom for geom in getattr(clipped, 'geoms', ())
            if geom.geom_type == 'LineString'
        ]
        for line in candidates:
            points = [[round(x, 6), round(y, 6)] for x, y in line.coords]
            if len(points) >= 2:
                parts.append(points)
    return parts


def clip_existing_routes(path, route_count_override=None):
    """Clip an already-built overlay without refreshing its OSM snapshot."""
    with open(path) as handle:
        collection = json.load(handle)
    route_count = route_count_override or collection.get(
        'routeCount', len(collection.get('features', [])))
    features = []
    for feature in collection.get('features', []):
        geometry = feature.get('geometry') or {}
        geometry_type = geometry.get('type')
        source_lines = geometry.get('coordinates', [])
        if geometry_type == 'LineString':
            source_lines = [source_lines]
        elif geometry_type != 'MultiLineString':
            continue
        lines = clipped_line_parts(source_lines)
        if not lines:
            continue
        features.append({
            **feature,
            'geometry': {'type': 'MultiLineString', 'coordinates': lines},
        })
    merged = merged_route_features(features)
    with open(path, 'w') as handle:
        json.dump({'type': 'FeatureCollection', 'routeCount': route_count,
                   'features': merged},
                  handle, separators=(',', ':'))
    return len(merged)


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
    import osmium

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
    import osmium

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
    ap.add_argument('--clip-existing', action='store_true',
                    help='clip the existing output without refreshing OSM data')
    ap.add_argument('--route-count', type=int,
                    help='preserve this informational relation count when transforming existing data')
    args = ap.parse_args()

    if args.clip_existing:
        count = clip_existing_routes(args.out, args.route_count)
        print(f'clipped {args.out}: {count} routes inside app coverage')
        return

    meta, way_members = collect_relations(args.src)
    needed = set().union(*way_members.values()) if way_members else set()
    print(f'{len(meta)} route relations, {len(needed):,} member ways', flush=True)
    geom, closures = collect_geometry(args.src, needed)
    print(f'geometry resolved for {len(geom):,} ways', flush=True)

    feats = []
    for rid, m in sorted(meta.items()):
        lines = clipped_line_parts([geom[w] for w in sorted(way_members[rid]) if w in geom])
        if not lines:
            continue  # e.g. members entirely outside the extract
        feats.append({
            'type': 'Feature',
            'properties': {'t': m['t'], 'r': m['r'], 'n': m['n']},
            'geometry': {'type': 'MultiLineString', 'coordinates': lines},
        })
    feats = merged_route_features(feats)
    fc = {'type': 'FeatureCollection', 'routeCount': len(meta),
          'features': feats}
    with open(args.out, 'w') as f:
        json.dump(fc, f, separators=(',', ':'))
    closure_features = []
    for wid, closure in closures.items():
        routes = [meta[rid].get('r', '') for rid, members in way_members.items() if wid in members]
        props = {'name': closure['name'], 'reason': closure['reason'], 'routes': ', '.join(filter(None, routes))}
        for coords in clipped_line_parts([closure['coords']]):
            mid = coords[len(coords) // 2]
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
