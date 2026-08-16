#!/usr/bin/env python3
"""Fetch and normalize ODOT's state and non-state line inventories.

The app never calls ODOT. This build-time adapter pages the public ArcGIS
layers, caches each page, and translates ODOT's vocabulary into the generic
fields consumed by the shared builders.

Important source ownership rules:

* BLTS contributes only its derived bicycle stress rating. Its copied speed,
  shoulder, lane and facility fields are not treated as independent evidence.
  The normalized stream does include a posted speed only when it is matched
  from ODOT's separate posted-speed inventory, so the shared road builder and
  graph builder consume the same owning source.
* Shoulder, posted speed and bicycle facilities come from their own ODOT
  inventories.
* ODOT's state AADT layer is point-rendered but carries route and milepost
  spans. Its values are projected onto the ODOT route linework so the shared
  line matcher can consume the section data.
* SH (shoulder bikeway) and NO (no facility) are deliberately not facilities;
  a designation cannot excuse a road (lesson D1).

Outputs in maps/oregon/:
  blts.geojson             BLTS rating plus normalized directional shoulder
  odot_speed.geojson       posted speed linework
  odot_facilities.geojson  existing bike-lane/shared-lane registry linework
  funcclass.geojson        non-state FHWA class and owner
  aadt.geojson             current ODOT state-system AADT sections

Usage:
  python3 maps/oregon/tools/build_odot.py
  python3 maps/oregon/tools/build_odot.py --limit 100
"""
import argparse
import json
import os
import re
import sys
from collections import defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                '..', '..', '..', 'scripts'))
import arcgis  # noqa: E402


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
OUT_DIR = os.path.join(ROOT, 'maps', 'oregon')
CACHE_DIR = os.path.join(ROOT, 'data', '.cache', 'oregon-odot')

CATALOG = 'https://gis.odot.state.or.us/arcgis1006/rest/services/facs_stip/data_catalog/MapServer'
LAYERS = {
    'blts': f'{CATALOG}/390',
    'shoulder': f'{CATALOG}/127',
    'speed': f'{CATALOG}/158',
    'facility': f'{CATALOG}/136',
    'aadt_state': f'{CATALOG}/155',
    'funcclass': f'{CATALOG}/173',
}

FIELDS = {
    'blts': ['OBJECTID', 'LRM_KEY', 'BEGMP', 'ENDMP', 'MPDir',
             'SegmentBLT', 'GIS_PRC_DT', 'EFFECTV_DT'],
    'shoulder': ['OBJECTID', 'LRM_KEY', 'BEGMP', 'ENDMP',
                 'LS_PVMT_WD', 'LS_GRAV_WD', 'RS_PVMT_WD', 'RS_GRAV_WD',
                 'EFFECTV_DT'],
    'speed': ['OBJECTID', 'LRM_KEY', 'BEGMP', 'ENDMP', 'SPEED',
              'EFFECTV_DT'],
    'facility': ['OBJECTID', 'LRM_KEY', 'BEGMP', 'ENDMP', 'ROADSIDE',
                 'TYP_CD', 'WD_MEAS', 'COND_CD', 'NEED_IND', 'INSP_YR',
                 'NOTE', 'EFFECTV_DT'],
    'aadt_state': ['OBJECTID', 'LRM_KEY', 'BEGMP', 'ENDMP', 'MP', 'AADT',
                   'EFFECTV_DT'],
    'funcclass': ['OBJECTID', 'LRM_KEY', 'BEGMP', 'ENDMP',
                  'NEW_FC_CD', 'NEW_FC_TYP',
                  'JRSDCT', 'FC_CD', 'URBAN', 'EFFECTV_DT'],
}


def num(value):
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return None if value != value else value


def text(value):
    value = '' if value is None else str(value).strip()
    return value or None


def interval(props):
    a = num(props.get('BEGMP'))
    b = num(props.get('ENDMP'))
    if a is None or b is None:
        return None
    return min(a, b), max(a, b)


def direction(key, props=None):
    key = text(key) or ''
    match = re.search(r'([ID])00$', key, re.I)
    if match:
        return match.group(1).lower()
    raw = str((props or {}).get('MPDir') or '').lower()
    if raw.startswith('inc'):
        return 'i'
    if raw.startswith('dec'):
        return 'd'
    return None


def route_identifier(key, props=None):
    key = text(key) or ''
    route = re.match(r'\d+', key)
    base = route.group(0) if route else key
    suffix = direction(key, props)
    return base + suffix if suffix else base


def physical_key(key):
    key = text(key) or ''
    return re.sub(r'[ID]00$', 'X00', key, flags=re.I)


def paths(feature):
    return arcgis.paths_of(feature.get('geometry'))


def fetch(kind, limit=None):
    label = f'ODOT {kind}'
    # The first census probe omitted BEGMP/ENDMP from the functional-class
    # field list; keep its old pages isolated so a resumed build cannot reuse
    # an incomplete schema while the other five layer caches remain valid.
    cache_name = 'funcclass-v2' if kind == 'funcclass' else kind
    cache = os.path.join(CACHE_DIR, cache_name)
    count = 0
    for feature in arcgis.fetch_all(
            LAYERS[kind], FIELDS[kind], cache_dir=cache,
            label=label, page=1000, order_by='OBJECTID'):
        yield feature
        count += 1
        if limit and count >= limit:
            break


def line_record(feature):
    props = feature.get('attributes') or {}
    geom = paths(feature)
    if not geom:
        return None
    span = interval(props)
    key = text(props.get('LRM_KEY'))
    if not key or not span:
        return None
    return props, geom, key, span


def overlap(a, b):
    return max(0.0, min(a[1], b[1]) - max(a[0], b[0]))


def write_fc(path, features):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as fh:
        json.dump({'type': 'FeatureCollection', 'features': features}, fh,
                  separators=(',', ':'))
    print(f'  -> {path} ({len(features):,} features; {os.path.getsize(path):,} bytes)')


def feature(properties, geometry):
    return {'type': 'Feature', 'properties': properties,
            'geometry': {'type': 'LineString', 'coordinates': geometry}}


def width(props, side):
    pavement = num(props.get(f'{side}_PVMT_WD'))
    gravel = num(props.get(f'{side}_GRAV_WD'))
    values = [v for v in (pavement, gravel) if v is not None and v >= 0]
    return round(sum(values), 1) if values else None


def index_records(records):
    exact = defaultdict(list)
    physical = defaultdict(list)
    for record in records:
        props, geometry, key, span = record
        item = (props, geometry, key, span)
        exact[key].append(item)
        physical[physical_key(key)].append(item)
    return exact, physical


def best_record(key, span, exact, physical, target_direction=None):
    candidates = list(exact.get(key, ()))
    if not candidates:
        candidates = list(physical.get(physical_key(key), ()))
    ranked = []
    for item in candidates:
        props, geometry, source_key, source_span = item
        amount = overlap(span, source_span)
        if amount <= 0:
            continue
        source_direction = direction(source_key, props)
        same_direction = source_direction == target_direction
        ranked.append((amount, same_direction, item))
    if not ranked:
        return None
    ranked.sort(key=lambda row: (row[0], row[1]), reverse=True)
    return ranked[0][2]


def build(limit=None):
    print('Fetching ODOT line inventories and building route-key indexes')
    raw_blts = [r for f in fetch('blts', limit) if (r := line_record(f))]
    raw_shoulder = [r for f in fetch('shoulder', limit) if (r := line_record(f))]
    raw_speed = [r for f in fetch('speed', limit) if (r := line_record(f))]
    raw_facility = [r for f in fetch('facility', limit) if (r := line_record(f))]
    raw_aadt = [
        (f.get('attributes') or {}, paths(f)) for f in fetch('aadt_state', limit)
    ]
    raw_funcclass = [r for f in fetch('funcclass', limit) if (r := line_record(f))]

    shoulder_exact, shoulder_physical = index_records(raw_shoulder)
    speed_exact, speed_physical = index_records(raw_speed)
    route_lines = defaultdict(list)
    route_lines_physical = defaultdict(list)
    for props, geometry, key, span in raw_blts:
        for line in geometry:
            item = (props, line, key, span)
            route_lines[key].append(item)
            route_lines_physical[physical_key(key)].append(item)

    blts_out = []
    shoulder_matches = 0
    speed_matches = 0
    for props, geometry, key, span in raw_blts:
        target_direction = direction(key, props)
        shoulder = best_record(key, span, shoulder_exact, shoulder_physical,
                               target_direction)
        if shoulder:
            shoulder_matches += 1
        shoulder_props = shoulder[0] if shoulder else None
        shoulder_direction = direction(shoulder[2], shoulder_props) if shoulder else None
        # ODOT's left/right widths are relative to the source record's travel
        # direction. A fallback from the opposite-direction record therefore
        # swaps the side used by the rider.
        side = 'RS' if shoulder_direction == target_direction else 'LS'
        shoulder_ft = width(shoulder_props, side) if shoulder_props else None
        speed_record = best_record(key, span, speed_exact, speed_physical,
                                   target_direction)
        posted_speed = num(speed_record[0].get('SPEED')) if speed_record else None
        if posted_speed is not None and posted_speed > 0:
            speed_matches += 1
        lts_match = re.search(r'([1-4])', text(props.get('SegmentBLT')) or '')
        normalized = {
            'RouteIdentifier': route_identifier(key, props),
            'RouteKey': key,
            'LTS_Bicycle': int(lts_match.group(1)) if lts_match else None,
            'ShoulderWidth': shoulder_ft,
            'ShoulderSource': 'ODOT Shoulder Width and Type' if shoulder_ft is not None else None,
            'SpeedLimit': int(posted_speed) if posted_speed is not None and posted_speed > 0 else None,
            'SpeedSource': 'ODOT Posted Speed Inventory' if posted_speed is not None and posted_speed > 0 else None,
            'StressEffectiveDate': text(props.get('EFFECTV_DT')),
        }
        normalized = {k: v for k, v in normalized.items()
                      if v is not None and v != ''}
        for line in geometry:
            blts_out.append(feature(normalized, line))
    write_fc(os.path.join(OUT_DIR, 'blts.geojson'), blts_out)
    print(f'  BLTS segments with a shoulder inventory match: {shoulder_matches:,} / {len(raw_blts):,}')
    print(f'  BLTS segments with a posted-speed inventory match: {speed_matches:,} / {len(raw_blts):,}')

    speed_out = []
    for props, geometry, key, span in raw_speed:
        speed = num(props.get('SPEED'))
        if speed is None or speed <= 0:
            continue
        normalized = {
            'RouteIdentifier': route_identifier(key, props),
            'SpeedLimit': int(speed),
            'SpeedEffectiveDate': text(props.get('EFFECTV_DT')),
        }
        for line in geometry:
            speed_out.append(feature(normalized, line))
    write_fc(os.path.join(OUT_DIR, 'odot_speed.geojson'), speed_out)

    facilities_out = []
    facility_counts = defaultdict(int)
    type_map = {'BL': 'Bike Lane', 'SL': 'Shared Lane'}
    for props, geometry, key, span in raw_facility:
        code = text(props.get('TYP_CD'))
        if code not in type_map:
            continue
        facility_counts[code] += 1
        normalized = {
            'RouteIdentifier': route_identifier(key, props),
            'BikeFacilityType': type_map[code],
            'BikeFacilityWidth': num(props.get('WD_MEAS')),
            'BikeFacilitySides': text(props.get('ROADSIDE')),
            'Status': 'Existing',
            'SourceTypeCode': code,
            'InspectionYear': text(props.get('INSP_YR')),
        }
        normalized = {k: v for k, v in normalized.items()
                      if v is not None and v != ''}
        for line in geometry:
            facilities_out.append(feature(normalized, line))
    write_fc(os.path.join(OUT_DIR, 'odot_facilities.geojson'), facilities_out)
    print(f'  existing facility records: {dict(facility_counts)}')

    funcclass_out = []
    owner_prefixes = {'COUNTY': 2, 'TOWN': 3, 'CITY': 4, 'STATE': 1}
    fc_counts = defaultdict(int)
    for props, geometry, key, span in raw_funcclass:
        fc = num(props.get('NEW_FC_CD'))
        if fc is None or int(fc) not in range(1, 8):
            continue
        jurisdiction = text(props.get('JRSDCT')) or ''
        owner = next((value for prefix, value in owner_prefixes.items()
                      if jurisdiction.upper().startswith(prefix)), None)
        normalized = {
            'fc': int(fc),
            'owner': owner,
            'ownerName': jurisdiction,
            'RouteKey': key,
            'EffectiveDate': text(props.get('EFFECTV_DT')),
        }
        normalized = {k: v for k, v in normalized.items()
                      if v is not None and v != ''}
        fc_counts[int(fc)] += 1
        for line in geometry:
            funcclass_out.append(feature(normalized, line))
    write_fc(os.path.join(OUT_DIR, 'funcclass.geojson'), funcclass_out)
    print(f'  functional classes: {dict(sorted(fc_counts.items()))}')

    aadt_out = []
    aadt_matched = 0
    aadt_sections = 0
    for props, point_paths in raw_aadt:
        aadt = num(props.get('AADT'))
        key = text(props.get('LRM_KEY'))
        span = interval(props)
        if aadt is None or aadt <= 0 or not key or not span:
            continue
        aadt_sections += 1
        target_direction = direction(key, props)
        candidates = list(route_lines.get(key, ()))
        if not candidates:
            candidates = list(route_lines_physical.get(physical_key(key), ()))
        seen = set()
        for route_props, line, source_key, source_span in candidates:
            if overlap(span, source_span) <= 0:
                continue
            signature = tuple(tuple(point) for point in line)
            if signature in seen:
                continue
            seen.add(signature)
            aadt_matched += 1
            date = text(props.get('EFFECTV_DT')) or ''
            year_match = re.search(r'(19|20)\d{2}', date)
            normalized = {
                'adt': int(aadt),
                'adty': int(year_match.group(0)) if year_match else None,
                'source': 'ODOT state AADT',
                'RouteIdentifier': route_identifier(key, props),
            }
            normalized = {k: v for k, v in normalized.items()
                          if v is not None and v != ''}
            aadt_out.append(feature(normalized, line))
    write_fc(os.path.join(OUT_DIR, 'aadt.geojson'), aadt_out)
    print(f'  current state AADT sections: {aadt_sections:,}; line parts emitted: {aadt_matched:,}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--limit', type=int, default=None,
                        help='limit each service for a small census/probe run')
    args = parser.parse_args()
    build(args.limit)


if __name__ == '__main__':
    main()
