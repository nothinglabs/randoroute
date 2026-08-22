#!/usr/bin/env python3
"""Split ordinary state graphs into deterministic, exactly joined partitions.

Edges are assigned to stable global grid cells. An edge is never cut or copied;
nodes shared by edges in different cells become explicit portals. Cross-state
portals require identical Float32 coordinate bits in both ordinary graphs. No
distance tolerance is used.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
import hashlib
import itertools
import json
import math
import os
from pathlib import Path
import shutil
import struct
import sys
import tempfile
from typing import Iterable

from graph_binary import (GraphData, PARTITION_FORMAT, deterministic_gzip,
                          read_graph, serialize_bgrc, unwrap_partition,
                          wrap_partition)


BUILDER_VERSION = 1
CATALOGUE_FORMAT = 1
DEFAULT_CELL_DEGREES = Decimal("1")


@dataclass(frozen=True)
class Placement:
    state_id: str
    source_node: int
    partition_id: str
    node_index: int
    lon_bits: int
    lat_bits: int


@dataclass
class BuiltState:
    catalogue_entry: dict
    partitions: list[dict]
    placements_by_node: dict[int, list[Placement]]
    nodes_by_coordinate: dict[tuple[int, int], dict[int, list[Placement]]]


def canonical_json(value, *, pretty=False) -> bytes:
    if pretty:
        return (json.dumps(value, sort_keys=True, indent=1,
                           ensure_ascii=True) + "\n").encode("utf-8")
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def float32_bits(value: float) -> int:
    return struct.unpack("<I", struct.pack("<f", value))[0]


def parse_cell_degrees(value: str | Decimal) -> Decimal:
    try:
        cell = value if isinstance(value, Decimal) else Decimal(str(value))
    except InvalidOperation as error:
        raise ValueError(f"invalid cell size {value!r}") from error
    if not cell.is_finite() or cell <= 0 or cell > 10:
        raise ValueError("cell size must be greater than 0 and no more than 10 degrees")
    micros = cell * 1_000_000
    if micros != micros.to_integral_value():
        raise ValueError("cell size supports at most six decimal places")
    return cell


def cell_key(lon: float, lat: float, cell: Decimal) -> tuple[int, int]:
    # Inputs are already Float32 values from the graph. Decimal(str(...)) keeps
    # the boundary decision stable across machines instead of depending on an
    # extended-precision float register.
    lon_index = int(((Decimal(str(lon)) + 180) / cell).to_integral_value(rounding="ROUND_FLOOR"))
    lat_index = int(((Decimal(str(lat)) + 90) / cell).to_integral_value(rounding="ROUND_FLOOR"))
    return lon_index, lat_index


def partition_id(state_id: str, cell: Decimal, key: tuple[int, int]) -> str:
    micros = int(cell * 1_000_000)
    lon_index, lat_index = key
    return f"{state_id}/grid-{micros:07d}/{lon_index:04d}-{lat_index:03d}"


def partition_filename(cell: Decimal, key: tuple[int, int]) -> str:
    micros = int(cell * 1_000_000)
    lon_index, lat_index = key
    return f"grid-{micros:07d}-{lon_index:04d}-{lat_index:03d}.bin.gz"


def assign_edges(graph: GraphData, cell: Decimal) -> dict[tuple[int, int], list[int]]:
    assigned = defaultdict(list)
    for edge_index in range(graph.edge_count):
        start = graph.edges["geom_start"][edge_index]
        count = graph.edges["geom_count"][edge_index]
        first = start
        last = start + count - 1
        lon = (float(graph.geom_lon[first]) + float(graph.geom_lon[last])) / 2
        lat = (float(graph.geom_lat[first]) + float(graph.geom_lat[last])) / 2
        assigned[cell_key(lon, lat, cell)].append(edge_index)
    return dict(assigned)


def subset_graph(graph: GraphData, edge_indices: list[int]):
    source_nodes = sorted({int(graph.edges[side][edge])
                           for edge in edge_indices for side in ("a", "b")})
    local_node = {source: local for local, source in enumerate(source_nodes)}
    used_name_ids = sorted({int(graph.edges["name_id"][edge]) for edge in edge_indices})
    name_remap = {source: local for local, source in enumerate(used_name_ids)}
    names = [graph.names[source] for source in used_name_ids]
    edges = {}
    copied_fields = [field for field in graph.edges
                     if field not in ("a", "b", "geom_start", "geom_count", "name_id")]
    for field in copied_fields:
        edges[field] = [graph.edges[field][edge] for edge in edge_indices]
    edges["a"] = [local_node[int(graph.edges["a"][edge])] for edge in edge_indices]
    edges["b"] = [local_node[int(graph.edges["b"][edge])] for edge in edge_indices]
    edges["name_id"] = [name_remap[int(graph.edges["name_id"][edge])] for edge in edge_indices]

    geom_lon, geom_lat, geom_start, geom_count = [], [], [], []
    for edge in edge_indices:
        start = int(graph.edges["geom_start"][edge])
        count = int(graph.edges["geom_count"][edge])
        geom_start.append(len(geom_lon))
        geom_count.append(count)
        geom_lon.extend(graph.geom_lon[start:start + count])
        geom_lat.extend(graph.geom_lat[start:start + count])
    edges["geom_start"], edges["geom_count"] = geom_start, geom_count

    subset = GraphData(
        b"BGRC",
        [graph.node_lon[node] for node in source_nodes],
        [graph.node_lat[node] for node in source_nodes],
        [graph.node_ele[node] for node in source_nodes],
        edges, geom_lon, geom_lat, names,
    )
    return subset, source_nodes, local_node


def graph_bounds(graph: GraphData) -> dict:
    lon = [float(value) for value in graph.node_lon]
    lat = [float(value) for value in graph.node_lat]
    lon.extend(float(value) for value in graph.geom_lon)
    lat.extend(float(value) for value in graph.geom_lat)
    return {"minLon": min(lon), "minLat": min(lat),
            "maxLon": max(lon), "maxLat": max(lat)}


def read_region(state_dir: Path) -> dict:
    try:
        region = json.loads((state_dir / "region.json").read_text("utf-8"))
    except FileNotFoundError as error:
        raise ValueError(f"{state_dir} has no region.json") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"{state_dir}/region.json is invalid: {error}") from error
    if region.get("id") != state_dir.name:
        raise ValueError(f"{state_dir}/region.json id does not match its folder")
    if not region.get("datasets", {}).get("graph"):
        raise ValueError(f"{state_dir}/region.json does not declare a graph")
    graph_version = region.get("versions", {}).get("graph")
    if not graph_version:
        raise ValueError(f"{state_dir}/region.json has no graph version")
    return region


def build_state(state_dir: Path, output_root: Path, cell: Decimal) -> BuiltState:
    region = read_region(state_dir)
    state_id = region["id"]
    source_path = state_dir / "graph2.bin.gz"
    graph, source_raw, source_compressed = read_graph(source_path)
    source_sha = sha256_bytes(source_compressed)
    by_cell = assign_edges(graph, cell)
    if not by_cell:
        raise ValueError(f"{state_id}: graph contains no edges")

    micros = int(cell * 1_000_000)
    acquisition_id = f"v{BUILDER_VERSION}-{source_sha[:16]}-g{micros:07d}"
    output_dir = output_root / state_id / "partitions" / acquisition_id
    output_dir.mkdir(parents=True, exist_ok=True)
    partitions = []
    placements_by_node = defaultdict(list)
    nodes_by_coordinate = defaultdict(lambda: defaultdict(list))
    for key in sorted(by_cell):
        edges = by_cell[key]
        part_id = partition_id(state_id, cell, key)
        filename = partition_filename(cell, key)
        subset, source_nodes, local_node = subset_graph(graph, edges)
        graph_raw = serialize_bgrc(subset)
        metadata = {
            "partitionFormat": PARTITION_FORMAT,
            "partitionId": part_id,
            "stateId": state_id,
            "sourceGraphVersion": region["versions"]["graph"],
            "sourceGraphSha256": source_sha,
            "embeddedGraphMagic": "BGRC",
        }
        partition_raw = wrap_partition(metadata, graph_raw)
        # Validate both wrapper and embedded graph before bytes reach disk.
        unpacked_metadata, unpacked_graph = unwrap_partition(partition_raw)
        if unpacked_metadata != metadata or unpacked_graph != graph_raw:
            raise AssertionError(f"{part_id}: partition wrapper did not round-trip")
        compressed = deterministic_gzip(partition_raw)
        path = output_dir / filename
        path.write_bytes(compressed)
        relative_path = f"{state_id}/partitions/{acquisition_id}/{filename}"
        partitions.append({
            "id": part_id,
            "stateId": state_id,
            "path": relative_path,
            "bounds": graph_bounds(subset),
            "nodeCount": subset.node_count,
            "edgeCount": subset.edge_count,
            "compressedBytes": len(compressed),
            "rawBytes": len(partition_raw),
            "sha256": sha256_bytes(compressed),
            "sourceGraphVersion": region["versions"]["graph"],
            "graphFormat": PARTITION_FORMAT,
            "adjacentPartitionIds": [],
        })
        for source_node in source_nodes:
            lon_bits = float32_bits(graph.node_lon[source_node])
            lat_bits = float32_bits(graph.node_lat[source_node])
            placement = Placement(state_id, source_node, part_id,
                                  local_node[source_node], lon_bits, lat_bits)
            placements_by_node[source_node].append(placement)
            nodes_by_coordinate[(lon_bits, lat_bits)][source_node].append(placement)

    partitions.sort(key=lambda partition: partition["id"])
    catalogue_entry = {
        "id": state_id,
        "graphVersion": region["versions"]["graph"],
        "sourcePath": f"{state_id}/graph2.bin.gz",
        "sourceSha256": source_sha,
        "sourceCompressedBytes": len(source_compressed),
        "sourceRawBytes": len(source_raw),
        "partitionIds": [partition["id"] for partition in partitions],
    }
    return BuiltState(catalogue_entry, partitions, dict(placements_by_node),
                      {key: dict(nodes) for key, nodes in nodes_by_coordinate.items()})


def endpoint_json(placement: Placement) -> dict:
    return {"partitionId": placement.partition_id,
            "nodeIndex": placement.node_index,
            "lonBits": placement.lon_bits,
            "latBits": placement.lat_bits}


def portal_record(left: Placement, right: Placement) -> dict:
    if (left.lon_bits, left.lat_bits) != (right.lon_bits, right.lat_bits):
        raise ValueError("a portal cannot join non-identical encoded coordinates")
    endpoints = sorted((left, right), key=lambda item: (item.partition_id, item.node_index))
    identity = f"f32:{left.lon_bits}:{left.lat_bits}"
    stable = canonical_json({"identity": identity,
                             "endpoints": [(item.partition_id, item.node_index)
                                           for item in endpoints]})
    portal_id = f"portal/{hashlib.sha256(stable).hexdigest()[:24]}"
    return {"id": portal_id,
            "identity": {"kind": "encoded-coordinate", "value": identity},
            "endpoints": [endpoint_json(item) for item in endpoints]}


def build_portals(states: list[BuiltState]) -> list[dict]:
    portals = {}

    def add(portal):
        existing = portals.get(portal["id"])
        if existing is not None and existing != portal:
            raise ValueError(f"portal id collision at {portal['id']}")
        portals[portal["id"]] = portal

    # Within a state, source node identity is authoritative even if two
    # disconnected graph nodes happen to share coordinates.
    for built in states:
        for placements in built.placements_by_node.values():
            ordered = sorted(placements, key=lambda item: (item.partition_id, item.node_index))
            for left, right in itertools.combinations(ordered, 2):
                if left.partition_id == right.partition_id:
                    continue
                portal = portal_record(left, right)
                add(portal)

    # Across states the ordinary graph no longer carries OSM node ids. Exact
    # Float32 identity is allowed only when each state has one source node at
    # that coordinate; multiplicity could be a grade-separated coincidence and
    # is rejected rather than inventing connectivity.
    by_coordinate = defaultdict(dict)
    for built in states:
        for coordinate, nodes in built.nodes_by_coordinate.items():
            by_coordinate[coordinate][built.catalogue_entry["id"]] = nodes
    for coordinate, by_state in sorted(by_coordinate.items()):
        if len(by_state) < 2:
            continue
        for state_id, nodes in by_state.items():
            if len(nodes) != 1:
                raise ValueError(
                    f"ambiguous exact cross-state node {coordinate}: {state_id} has "
                    f"{len(nodes)} source nodes at the same encoded coordinate")
        for left_state, right_state in itertools.combinations(sorted(by_state), 2):
            left_placements = next(iter(by_state[left_state].values()))
            right_placements = next(iter(by_state[right_state].values()))
            for left in left_placements:
                for right in right_placements:
                    portal = portal_record(left, right)
                    add(portal)
    return sorted(portals.values(), key=lambda portal: portal["id"])


def add_adjacency(partitions: list[dict], portals: list[dict]):
    adjacent = {partition["id"]: set() for partition in partitions}
    for portal in portals:
        left, right = [endpoint["partitionId"] for endpoint in portal["endpoints"]]
        if left not in adjacent or right not in adjacent:
            raise ValueError(f"{portal['id']}: endpoint names an unknown partition")
        if left == right:
            raise ValueError(f"{portal['id']}: endpoints are in one partition")
        adjacent[left].add(right)
        adjacent[right].add(left)
    for partition in partitions:
        partition["adjacentPartitionIds"] = sorted(adjacent[partition["id"]])


def discover_state_ids(maps_root: Path) -> list[str]:
    found = []
    for path in sorted(maps_root.iterdir(), key=lambda item: item.name):
        if not path.is_dir() or not (path / "region.json").is_file():
            continue
        try:
            region = json.loads((path / "region.json").read_text("utf-8"))
        except json.JSONDecodeError as error:
            raise ValueError(f"{path}/region.json is invalid: {error}") from error
        if region.get("datasets", {}).get("graph"):
            found.append(path.name)
    if not found:
        raise ValueError(f"{maps_root} contains no graph-enabled states")
    return found


def build_catalogue(maps_root: Path, output_root: Path, state_ids: Iterable[str],
                    catalogue_path: Path, cell_degrees: Decimal,
                    source_date_epoch: int = 0) -> dict:
    ids = sorted(set(state_ids))
    if not ids:
        ids = discover_state_ids(maps_root)
    output_root.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".partition-build-", dir=output_root))
    try:
        built_states = []
        for state_id in ids:
            if not state_id or any(char not in "abcdefghijklmnopqrstuvwxyz0123456789-" for char in state_id):
                raise ValueError(f"unsafe state id {state_id!r}")
            print(f"partitioning {state_id}...", flush=True)
            built_states.append(build_state(maps_root / state_id, staging, cell_degrees))
        partitions = sorted((partition for built in built_states for partition in built.partitions),
                            key=lambda partition: partition["id"])
        portals = build_portals(built_states)
        add_adjacency(partitions, portals)
        states = sorted((built.catalogue_entry for built in built_states), key=lambda state: state["id"])
        algorithm = f"global-grid-v1:{format(cell_degrees, 'f')}deg"
        catalogue = {
            "partitionCatalogueFormat": CATALOGUE_FORMAT,
            "graphFormat": PARTITION_FORMAT,
            "build": {
                "builder": "scripts/build_graph_partitions.py",
                "builderVersion": BUILDER_VERSION,
                "algorithm": algorithm,
                "sourceDateEpoch": source_date_epoch,
                "sourceGraphs": [
                    {"stateId": state["id"], "graphVersion": state["graphVersion"],
                     "sha256": state["sourceSha256"]}
                    for state in states
                ],
            },
            "states": states,
            "partitions": partitions,
            "portals": portals,
        }

        # Publish only after every graph, wrapper and portal validates. Each
        # artifact is replaced atomically, then stale files from an older grid
        # are removed from the explicit generated directory.
        active_acquisitions = {}
        for state in states:
            parent = output_root / state["id"] / "partitions"
            parent.mkdir(parents=True, exist_ok=True)
            staged_parent = staging / state["id"] / "partitions"
            staged_sets = [path for path in staged_parent.iterdir() if path.is_dir()]
            if len(staged_sets) != 1:
                raise AssertionError(f"{state['id']}: build did not produce one acquisition directory")
            source = staged_sets[0]
            target = parent / source.name
            active_acquisitions[state["id"]] = source.name
            if target.exists():
                source_files = sorted(path.name for path in source.iterdir() if path.is_file())
                target_files = sorted(path.name for path in target.iterdir() if path.is_file())
                if source_files != target_files or any(
                        (source / name).read_bytes() != (target / name).read_bytes()
                        for name in source_files):
                    raise ValueError(
                        f"{state['id']}: identical source/version produced different partition bytes")
            else:
                os.replace(source, target)
        catalogue_path.parent.mkdir(parents=True, exist_ok=True)
        catalogue_temp = catalogue_path.with_name(f".{catalogue_path.name}.tmp")
        catalogue_temp.write_bytes(canonical_json(catalogue, pretty=True))
        os.replace(catalogue_temp, catalogue_path)
        # Only after the new catalogue is durable are earlier generated
        # acquisition directories unreachable and safe to remove.
        for state in states:
            parent = output_root / state["id"] / "partitions"
            active = active_acquisitions[state["id"]]
            for old in sorted(path for path in parent.iterdir()
                              if path.is_dir() and path.name.startswith("v")):
                if old.name != active:
                    shutil.rmtree(old)
        print(f"wrote {len(partitions)} partitions, {len(portals)} exact portals -> {catalogue_path}",
              flush=True)
        return catalogue
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--maps-root", default="maps",
                        help="directory containing <state>/region.json and graph2.bin.gz")
    parser.add_argument("--output-root", default=None,
                        help="directory receiving <state>/partitions (default: maps root)")
    parser.add_argument("--state", action="append", default=[],
                        help="state id to partition; repeat, or omit to discover graph-enabled states")
    parser.add_argument("--catalogue", default=None,
                        help="catalogue output path (default: <output-root>/partition-catalogue.json)")
    parser.add_argument("--cell-degrees", default=str(DEFAULT_CELL_DEGREES),
                        help="stable global grid cell size, at most six decimals")
    parser.add_argument("--source-date-epoch", type=int,
                        default=int(os.environ.get("SOURCE_DATE_EPOCH", "0")),
                        help="reproducible provenance epoch; defaults to SOURCE_DATE_EPOCH or 0")
    args = parser.parse_args(argv)
    try:
        maps_root = Path(args.maps_root).resolve()
        output_root = Path(args.output_root).resolve() if args.output_root else maps_root
        catalogue = Path(args.catalogue).resolve() if args.catalogue \
            else output_root / "partition-catalogue.json"
        cell = parse_cell_degrees(args.cell_degrees)
        if args.source_date_epoch < 0:
            raise ValueError("source date epoch cannot be negative")
        build_catalogue(maps_root, output_root, args.state, catalogue, cell,
                        args.source_date_epoch)
    except (OSError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
