#!/usr/bin/env python3
"""Read ordinary RandoRoute graphs and write deterministic partition payloads.

The production graph builder owns the BGRC layout. This module is the shared
reader/writer used by the partition builder and its executable tests; it does
not make routing or safety decisions.
"""

from __future__ import annotations

from dataclasses import dataclass
from array import array
import gzip
import json
import struct
import sys
from pathlib import Path
from typing import Mapping, Sequence


SUPPORTED_MAGICS = (b"BGR9", b"BGRA", b"BGRB", b"BGRC")
PARTITION_MAGIC = b"BGP1"
PARTITION_FORMAT = "bgp1-bgrc12"


@dataclass
class GraphData:
    magic: bytes
    node_lon: Sequence[float]
    node_lat: Sequence[float]
    node_ele: Sequence[int]
    edges: Mapping[str, Sequence]
    geom_lon: Sequence[float]
    geom_lat: Sequence[float]
    names: Sequence[str]

    @property
    def node_count(self) -> int:
        return len(self.node_lon)

    @property
    def edge_count(self) -> int:
        return len(self.edges["a"])


def _align(offset: int, boundary: int) -> int:
    return offset + ((boundary - offset % boundary) % boundary)


def _canonical_json(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True).encode("utf-8")


def deterministic_gzip(raw: bytes, level: int = 9) -> bytes:
    encoded = bytearray(gzip.compress(raw, compresslevel=level, mtime=0))
    # gzip's OS byte otherwise varies with the build host even when mtime is 0.
    encoded[9] = 255
    return bytes(encoded)


def read_graph_bytes(raw: bytes) -> GraphData:
    if sys.byteorder != "little":
        raise RuntimeError("graph_binary currently requires a little-endian build host")
    if len(raw) < 28 or raw[:4] not in SUPPORTED_MAGICS:
        got = raw[:4].decode("ascii", "replace") if raw else "empty"
        raise ValueError(f"unsupported graph magic {got!r}")
    magic = raw[:4]
    n, e, d, g, u, b = struct.unpack_from("<IIIIII", raw, 4)
    view = memoryview(raw)
    offset = 28

    def take(code: str, count: int):
        nonlocal offset
        size = struct.calcsize(code)
        end = offset + size * count
        if end > len(raw):
            raise ValueError(f"truncated graph while reading {code}[{count}]")
        result = view[offset:end].cast(code)
        offset = end
        return result

    node_lon = take("f", n)
    node_lat = take("f", n)
    node_ele = take("h", n)
    offset = _align(offset, 4)

    edges = {
        "a": take("I", e),
        "b": take("I", e),
        "length": take("f", e),
        "ascent": take("H", e),
        "descent": take("H", e),
        "speed": take("B", e),
        "speed_ba": take("B", e),
        "flags": take("B", e),
        "shoulder": take("b", e),
        "shoulder_ba": take("b", e),
        "limited_dir": take("B", e),
        "road_class": take("B", e),
        "facility": take("B", e),
        "official": take("B", e),
        "surface": take("B", e),
    }
    has_traffic = magic in (b"BGRA", b"BGRB", b"BGRC")
    has_measures = magic in (b"BGRB", b"BGRC")
    has_adt_source = magic == b"BGRC"
    if has_traffic:
        edges["lanes"] = take("B", e)
        edges["lts"] = take("B", e)
    if has_measures:
        edges["edge_space"] = take("B", e)
        edges["county_shoulder"] = take("B", e)
        edges["adt"] = take("H", e)
        edges["adt_meta"] = take("B", e)
        if has_adt_source:
            edges["adt_source"] = take("B", e)
        edges["class_owner"] = take("B", e)
    edges["hazard_ab"] = take("B", e)
    edges["hazard_ba"] = take("B", e)
    offset = _align(offset, 2)
    edges["hazard_start_ab"] = take("H", e)
    edges["hazard_end_ab"] = take("H", e)
    edges["hazard_start_ba"] = take("H", e)
    edges["hazard_end_ba"] = take("H", e)
    offset = _align(offset, 4)
    edges["geom_start"] = take("I", e)
    edges["geom_count"] = take("H", e)
    offset = _align(offset, 4)
    # Source adjacency is validated for bounds but rebuilt per partition.
    out_start = take("I", n + 1)
    out_target = take("I", d)
    out_edge = take("I", d)
    edges["name_id"] = take("I", e)
    name_offsets = take("I", u + 1)
    geom_lon = take("f", g)
    geom_lat = take("f", g)
    name_blob = bytes(take("B", b))
    if offset != len(raw):
        raise ValueError(f"graph has {len(raw) - offset} trailing bytes")
    if out_start[-1] != d:
        raise ValueError("graph adjacency count disagrees with header")
    for target in out_target:
        if target >= n:
            raise ValueError("graph adjacency contains an out-of-range node")
    for edge_index in out_edge:
        if edge_index >= e:
            raise ValueError("graph adjacency contains an out-of-range edge")
    if name_offsets[-1] != b:
        raise ValueError("graph name table disagrees with header")
    names = []
    for index in range(u):
        names.append(name_blob[name_offsets[index]:name_offsets[index + 1]].decode("utf-8"))
    for index in range(e):
        if edges["a"][index] >= n or edges["b"][index] >= n:
            raise ValueError(f"edge {index} has an out-of-range endpoint")
        start = edges["geom_start"][index]
        count = edges["geom_count"][index]
        if count < 2 or start + count > g:
            raise ValueError(f"edge {index} has invalid geometry")
        if edges["name_id"][index] >= u:
            raise ValueError(f"edge {index} has an out-of-range name")
    return GraphData(magic, node_lon, node_lat, node_ele, edges,
                     geom_lon, geom_lat, names)


def read_graph(path: Path | str) -> tuple[GraphData, bytes, bytes]:
    compressed = Path(path).read_bytes()
    try:
        raw = gzip.decompress(compressed)
    except (gzip.BadGzipFile, EOFError) as error:
        raise ValueError(f"{path}: graph is not valid gzip: {error}") from error
    return read_graph_bytes(raw), raw, compressed


_EDGE_BASE = (
    ("a", "I", 0), ("b", "I", 0), ("length", "f", 0),
    ("ascent", "H", 0), ("descent", "H", 0),
    ("speed", "B", 0), ("speed_ba", "B", 0), ("flags", "B", 0),
    ("shoulder", "b", -1), ("shoulder_ba", "b", -1),
    ("limited_dir", "B", 0), ("road_class", "B", 0),
    ("facility", "B", 0), ("official", "B", 0), ("surface", "B", 0),
)
_EDGE_TRAFFIC = (("lanes", "B", 0), ("lts", "B", 0))
_EDGE_MEASURE_BYTES = (("edge_space", "B", 255), ("county_shoulder", "B", 255))


def _pack_values(code: str, values: Sequence, count: int, default):
    if values is None:
        values = [default] * count
    if len(values) != count:
        raise ValueError(f"field length {len(values)} does not match edge count {count}")
    if not count:
        return b""
    packed = array(code, values)
    if sys.byteorder == "big":
        packed.byteswap()
    return packed.tobytes()


def serialize_bgrc(graph: GraphData, *, magic: bytes = b"BGRC") -> bytes:
    """Serialize an ordinary graph; partitions use the default current BGRC."""
    if magic not in SUPPORTED_MAGICS:
        raise ValueError(f"unsupported output graph magic {magic!r}")
    n, e = graph.node_count, graph.edge_count
    if not n or not e:
        raise ValueError("a partition graph needs at least one node and one edge")
    if len(graph.node_lat) != n or len(graph.node_ele) != n:
        raise ValueError("node field lengths disagree")
    if len(graph.geom_lon) != len(graph.geom_lat):
        raise ValueError("geometry field lengths disagree")
    g = len(graph.geom_lon)
    names = list(graph.names)
    if not names:
        names = [""]
    u = len(names)
    edge = graph.edges

    degree = [0] * n
    for index in range(e):
        a, b = edge["a"][index], edge["b"][index]
        if a >= n or b >= n:
            raise ValueError(f"edge {index} has an out-of-range endpoint")
        degree[a] += 1
        if not edge["flags"][index] & 16:
            degree[b] += 1
    out_start = [0] * (n + 1)
    for index in range(n):
        out_start[index + 1] = out_start[index] + degree[index]
    d = out_start[-1]
    out_target = [0] * d
    out_edge = [0] * d
    cursor = out_start[:-1].copy()
    for index in range(e):
        a, b = edge["a"][index], edge["b"][index]
        at = cursor[a]
        out_target[at], out_edge[at], cursor[a] = b, index, at + 1
        if not edge["flags"][index] & 16:
            at = cursor[b]
            out_target[at], out_edge[at], cursor[b] = a, index, at + 1

    name_blob = b""
    name_offsets = [0]
    chunks = []
    total = 0
    for name in names:
        encoded = str(name).encode("utf-8")
        chunks.append(encoded)
        total += len(encoded)
        name_offsets.append(total)
    name_blob = b"".join(chunks)
    b = len(name_blob)

    parts = [magic, struct.pack("<IIIIII", n, e, d, g, u, b),
             _pack_values("f", graph.node_lon, n, 0),
             _pack_values("f", graph.node_lat, n, 0),
             _pack_values("h", graph.node_ele, n, 0)]
    parts.append(b"\0" * ((_align(sum(map(len, parts)), 4) - sum(map(len, parts)))))
    for field, code, default in _EDGE_BASE:
        parts.append(_pack_values(code, edge.get(field), e, default))
    if magic in (b"BGRA", b"BGRB", b"BGRC"):
        for field, code, default in _EDGE_TRAFFIC:
            parts.append(_pack_values(code, edge.get(field), e, default))
    if magic in (b"BGRB", b"BGRC"):
        for field, code, default in _EDGE_MEASURE_BYTES:
            parts.append(_pack_values(code, edge.get(field), e, default))
        # edge_space/county_shoulder leave the stream 2-byte aligned.
        if sum(map(len, parts)) % 2:
            raise ValueError("edge ADT field is not 2-byte aligned")
        parts.append(_pack_values("H", edge.get("adt"), e, 0))
        parts.append(_pack_values("B", edge.get("adt_meta"), e, 0))
        if magic == b"BGRC":
            parts.append(_pack_values("B", edge.get("adt_source"), e, 0))
        parts.append(_pack_values("B", edge.get("class_owner"), e, 0))
    for field in ("hazard_ab", "hazard_ba"):
        parts.append(_pack_values("B", edge.get(field), e, 0))
    offset = sum(map(len, parts))
    parts.append(b"\0" * (_align(offset, 2) - offset))
    for field in ("hazard_start_ab", "hazard_end_ab", "hazard_start_ba", "hazard_end_ba"):
        parts.append(_pack_values("H", edge.get(field), e, 0))
    offset = sum(map(len, parts))
    parts.append(b"\0" * (_align(offset, 4) - offset))
    parts.append(_pack_values("I", edge.get("geom_start"), e, 0))
    parts.append(_pack_values("H", edge.get("geom_count"), e, 0))
    offset = sum(map(len, parts))
    parts.append(b"\0" * (_align(offset, 4) - offset))
    parts.extend((
        _pack_values("I", out_start, n + 1, 0),
        _pack_values("I", out_target, d, 0),
        _pack_values("I", out_edge, d, 0),
        _pack_values("I", edge.get("name_id"), e, 0),
        _pack_values("I", name_offsets, u + 1, 0),
        _pack_values("f", graph.geom_lon, g, 0),
        _pack_values("f", graph.geom_lat, g, 0),
        name_blob,
    ))
    raw = b"".join(parts)
    # The reader is a cheap structural proof and catches alignment drift here,
    # before a generated partition reaches the catalogue.
    read_graph_bytes(raw)
    return raw


def wrap_partition(metadata: Mapping, graph_raw: bytes) -> bytes:
    meta = _canonical_json(metadata)
    header = PARTITION_MAGIC + struct.pack("<II", len(meta), len(graph_raw)) + meta
    header += b"\0" * (_align(len(header), 4) - len(header))
    return header + graph_raw


def unwrap_partition(raw: bytes) -> tuple[dict, bytes]:
    if len(raw) < 12 or raw[:4] != PARTITION_MAGIC:
        raise ValueError("bad partition magic (want BGP1)")
    meta_size, graph_size = struct.unpack_from("<II", raw, 4)
    meta_end = 12 + meta_size
    graph_start = _align(meta_end, 4)
    graph_end = graph_start + graph_size
    if graph_end != len(raw):
        raise ValueError("partition payload length disagrees with header")
    try:
        metadata = json.loads(raw[12:meta_end])
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"partition metadata is invalid: {error}") from error
    read_graph_bytes(raw[graph_start:graph_end])
    return metadata, raw[graph_start:graph_end]
