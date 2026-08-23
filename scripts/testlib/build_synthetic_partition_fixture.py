#!/usr/bin/env python3
"""Generate tiny ordinary state graphs for executable partition tests."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from graph_binary import GraphData, deterministic_gzip, serialize_bgrc  # noqa: E402


def make_graph(coordinates, edges, one_way_edge=None):
    count = len(edges)
    fields = {
        "a": [edge[0] for edge in edges],
        "b": [edge[1] for edge in edges],
        "length": [1000.0] * count,
        "ascent": [0] * count,
        "descent": [0] * count,
        "speed": [25] * count,
        "speed_ba": [25] * count,
        "flags": [16 if index == one_way_edge else 0 for index in range(count)],
        "shoulder": [4] * count,
        "shoulder_ba": [4] * count,
        "limited_dir": [0] * count,
        "road_class": [5] * count,
        "facility": [2] * count,
        "official": [1] * count,
        "surface": [1] * count,
        "geom_start": [2 * index for index in range(count)],
        "geom_count": [2] * count,
        "name_id": [0] * count,
    }
    geom_lon, geom_lat = [], []
    for left, right in edges:
        geom_lon.extend((coordinates[left][0], coordinates[right][0]))
        geom_lat.extend((coordinates[left][1], coordinates[right][1]))
    return GraphData(
        b"BGRC",
        [point[0] for point in coordinates],
        [point[1] for point in coordinates],
        [0] * len(coordinates),
        fields, geom_lon, geom_lat, ["Fixture Road"],
    )


def write_state(root: Path, state_id: str, graph: GraphData, *, magic=b"BGRC"):
    folder = root / state_id
    folder.mkdir(parents=True)
    graph_raw = serialize_bgrc(graph, magic=magic)
    graph_gzip = deterministic_gzip(graph_raw)
    (folder / "graph2.bin.gz").write_bytes(graph_gzip)
    region = {
        "id": state_id,
        "name": state_id.replace("-", " ").title(),
        "status": "preview",
        "bounds": {
            "minLon": min(graph.node_lon), "maxLon": max(graph.node_lon),
            "minLat": min(graph.node_lat) - 0.1, "maxLat": max(graph.node_lat) + 0.1,
        },
        "defaultCenter": [sum(graph.node_lon) / len(graph.node_lon),
                          sum(graph.node_lat) / len(graph.node_lat)],
        "defaultZoom": 8,
        "datasets": {"graph": True},
        "versions": {"graph": f"fixture-{state_id}-v1"},
    }
    (folder / "region.json").write_text(
        json.dumps(region, sort_keys=True, indent=1) + "\n", "utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("output")
    parser.add_argument("--nearby", action="store_true",
                        help="move the second state's border node by one Float32-scale step")
    parser.add_argument("--ambiguous", action="store_true",
                        help="give the second state two disconnected nodes at the exact border coordinate")
    parser.add_argument("--chain-length", type=int, choices=range(2, 5), default=2,
                        help="emit two to four exact-connected synthetic states")
    args = parser.parse_args()
    root = Path(args.output)
    root.mkdir(parents=True, exist_ok=True)

    write_state(root, "state-a", make_graph(
        [(-2.0, 0.0), (-1.2, 0.0), (-0.2, 0.0)], [(0, 1), (1, 2)]), magic=b"BGR9")
    border = -0.1999999 if args.nearby else -0.2
    if args.ambiguous:
        graph_b = make_graph(
            [(border, 0.0), (border, 0.0), (0.8, 0.0), (1.8, 0.0)],
            [(0, 2), (1, 3)], one_way_edge=1)
    else:
        graph_b = make_graph(
            [(border, 0.0), (0.8, 0.0), (1.8, 0.0)],
            [(0, 1), (1, 2)], one_way_edge=1)
    write_state(root, "state-b", graph_b)
    for index in range(2, args.chain_length):
        start = 1.8 + (index - 2) * 2.0
        state_id = f"state-{chr(ord('a') + index)}"
        write_state(root, state_id, make_graph(
            [(start, 0.0), (start + 1.0, 0.0), (start + 2.0, 0.0)],
            [(0, 1), (1, 2)]))


if __name__ == "__main__":
    main()
