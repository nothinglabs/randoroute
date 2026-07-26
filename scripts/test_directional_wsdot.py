#!/usr/bin/env python3
"""Targeted regression for opposite-direction SR-525 shoulder records."""

from build_graph import blts_matches, load_blts_index


index = load_blts_index("data/blts.geojson")
# OSM WA-525 node interval nearest 48.001199,-122.447333. The OSM coordinate
# order follows WSDOT's increasing inventory direction at this location.
coords = [
    (-122.4466298, 48.0014530),
    (-122.4473243, 48.0011637),
]
increasing, decreasing = blts_matches(coords, {"ref": "WA 525"}, index)

assert increasing is not None and increasing["direction"] == "i"
assert decreasing is not None and decreasing["direction"] == "d"
assert increasing["spd"] == decreasing["spd"] == 55
assert increasing["sh"] == 0, increasing
assert decreasing["sh"] == 8, decreasing

print("Directional WSDOT matcher test passed.")
