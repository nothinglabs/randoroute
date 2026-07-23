#!/usr/bin/env python3
"""
Phase 2 build step: prepare data/bikeinfra.geojson from an OSM extract.

BUILD-TIME step. The app makes no runtime Overpass/OSM calls — it renders only
from the static data/bikeinfra.geojson this script produces.

Source: Geofabrik Washington extract (washington-latest.osm.pbf), EPSG:4326.
Output: data/bikeinfra.geojson  (dedicated cycleways, bike lanes, shared paths)

We keep only ways that classify as real bike infrastructure (the scorer's
keep/drop logic below, mirrored in app.js's scoreOSM). Everything else — plain
sidewalks/footpaths with no bicycle acceptance and no cycleway tag — is dropped
so we don't color noise.

Requires: osmium (pyosmium).  pip install osmium
Usage: python3 scripts/build_osm.py --src data/washington-latest.osm.pbf \
                                     --out data/bikeinfra.geojson
"""
import argparse
import json
import os

import osmium

# Tags we keep for the scorer + readout (mirrors the export include_tags list).
KEEP_TAGS = [
    "highway", "cycleway", "cycleway:both", "cycleway:left", "cycleway:right",
    "bicycle", "surface", "foot", "name", "oneway", "segregated", "width",
    "access", "motor_vehicle",
]
CANDIDATE_HW = {"cycleway", "path", "footway", "bridleway", "track", "service"}
CYCLEWAY_KEYS = ("cycleway", "cycleway:both", "cycleway:right", "cycleway:left")
PROTECTED = {"track", "separated", "opposite_track"}
LANE = {"lane", "shared_lane"}
COORD_DECIMALS = 5


def collect_mtb_route_members(src):
    """Return ways belonging to OSM ``route=mtb`` relations.

    A technical trail is not always tagged on every individual way.  Relation
    membership is a useful second signal alongside a direct ``mtb:*`` tag.
    We retain the feature in the export (the app has an opt-in toggle), but
    mark it so it is hidden and unavailable by default.
    """
    relations, way_members, sub_members = set(), {}, {}
    for obj in osmium.FileProcessor(src, osmium.osm.RELATION):
        if obj.tags.get("route") != "mtb":
            continue
        relations.add(obj.id)
        way_members[obj.id] = {member.ref for member in obj.members if member.type == "w"}
        sub_members[obj.id] = {member.ref for member in obj.members if member.type == "r"}

    ways = set()
    for relation_id in relations:
        ways |= way_members[relation_id]
        stack, seen = list(sub_members[relation_id]), set()
        while stack:
            nested = stack.pop()
            if nested in seen or nested not in relations:
                continue
            seen.add(nested)
            ways |= way_members[nested]
            stack.extend(sub_members[nested])
    return ways


def is_mountain_bike_way(tags, way_id, mtb_route_members):
    """True for explicitly technical/MTB OSM paths and MTB route members."""
    return (way_id in mtb_route_members
            or "mtb" in tags
            or any(key.startswith("mtb:") for key in tags))


def cycleway_value(tags):
    for k in CYCLEWAY_KEYS:
        v = tags.get(k)
        if v:
            return v
    return None


def classify(tags):
    """Return (baseScore, prohibited) or (None, False) to drop. Mirrors scoreOSM()."""
    bike = tags.get("bicycle")
    hw = tags.get("highway")
    cw = cycleway_value(tags)
    bikeish = hw in ("cycleway", "path", "bridleway", "track", "service") or cw is not None

    if hw == "cycleway" and bike != "no":
        return 1, False
    if hw == "path" and bike in ("designated", "yes"):
        return 1, False
    if hw == "footway" and bike == "designated":
        return 2, False
    if hw == "bridleway" and bike in ("designated", "yes"):
        return 2, False
    if hw == "track" and bike in ("designated", "yes"):
        return 2, False
    if (hw == "service" and bike == "designated"
            and (tags.get("motor_vehicle") in ("no", "private")
                 or tags.get("access") in ("no", "private"))):
        return 1, False
    if cw in PROTECTED:
        return 1, False
    if cw in LANE:
        return 2, False
    # ``bicycle=no`` is prohibited.  ``bicycle=dismount`` remains visible as
    # a legal walk-bike link and is retained by build_graph.py with a strong
    # route penalty.
    if bike == "no" and bikeish:
        return 4, True
    return None, False


def is_candidate(tags):
    return tags.get("highway") in CANDIDATE_HW or cycleway_value(tags) is not None


def build(src, out):
    feats = []
    kept = dropped = 0
    print("scanning mountain-bike route relations")
    mtb_route_members = collect_mtb_route_members(src)
    print(f"  {len(mtb_route_members):,} MTB route-member ways")
    class InfraHandler(osmium.SimpleHandler):
        def way(self, obj):
            nonlocal kept, dropped
            tags = {t.k: t.v for t in obj.tags}
            if not is_candidate(tags):
                return
            base, prohibited = classify(tags)
            if base is None:
                dropped += 1
                return
            coords = []
            for nd in obj.nodes:
                if nd.location.valid():
                    coords.append([round(nd.location.lon, COORD_DECIMALS), round(nd.location.lat, COORD_DECIMALS)])
            if len(coords) < 2:
                return
            props = {k: tags[k] for k in KEEP_TAGS if k in tags}
            if is_mountain_bike_way(tags, obj.id, mtb_route_members):
                # Keep a compact flag rather than exposing a grab bag of MTB
                # values.  The app defaults to hiding/routing around these paths,
                # but can include them when the rider explicitly opts in.
                props["mtb"] = 1
            props["osm_id"] = obj.id
            feats.append({
                "type": "Feature",
                "properties": props,
                "geometry": {"type": "LineString", "coordinates": coords},
            })
            kept += 1

    InfraHandler().apply_file(src, locations=True)

    fc = {"type": "FeatureCollection", "features": feats}
    with open(out, "w") as f:
        json.dump(fc, f, separators=(",", ":"))
    print(f"kept {kept} bike-infra ways, dropped {dropped} non-infra candidates")
    print(f"wrote {out} ({os.path.getsize(out):,} bytes)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="data/washington-latest.osm.pbf")
    ap.add_argument("--out", default="data/bikeinfra.geojson")
    args = ap.parse_args()
    build(args.src, args.out)
