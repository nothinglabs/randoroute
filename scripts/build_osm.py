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
]
CANDIDATE_HW = {"cycleway", "path", "footway", "bridleway", "track"}
CYCLEWAY_KEYS = ("cycleway", "cycleway:both", "cycleway:right", "cycleway:left")
PROTECTED = {"track", "separated", "opposite_track"}
LANE = {"lane", "shared_lane"}
COORD_DECIMALS = 5


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
    bikeish = hw in ("cycleway", "path", "bridleway", "track") or cw is not None

    if hw == "cycleway" and bike not in ("no", "dismount"):
        return 1, False
    if hw == "path" and bike in ("designated", "yes"):
        return 1, False
    if hw == "footway" and bike == "designated":
        return 2, False
    if hw == "bridleway" and bike in ("designated", "yes"):
        return 2, False
    if hw == "track" and bike in ("designated", "yes"):
        return 2, False
    if cw in PROTECTED:
        return 1, False
    if cw in LANE:
        return 2, False
    # Genuine bike-ish infra but cycling prohibited / must dismount.
    if bike in ("no", "dismount") and bikeish:
        return 4, True
    return None, False


def is_candidate(tags):
    return tags.get("highway") in CANDIDATE_HW or cycleway_value(tags) is not None


def build(src, out):
    feats = []
    kept = dropped = 0
    for obj in osmium.FileProcessor(src).with_locations():
        if not obj.is_way():
            continue
        tags = {t.k: t.v for t in obj.tags}
        if not is_candidate(tags):
            continue
        base, prohibited = classify(tags)
        if base is None:
            dropped += 1
            continue
        coords = []
        for nd in obj.nodes:
            if nd.location.valid():
                coords.append([round(nd.location.lon, COORD_DECIMALS), round(nd.location.lat, COORD_DECIMALS)])
        if len(coords) < 2:
            continue
        props = {k: tags[k] for k in KEEP_TAGS if k in tags}
        props["osm_id"] = obj.id
        feats.append({
            "type": "Feature",
            "properties": props,
            "geometry": {"type": "LineString", "coordinates": coords},
        })
        kept += 1

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
