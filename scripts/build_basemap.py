#!/usr/bin/env python3
"""Build the compact offline geographic-context PMTiles archive.

The routable street geometry and street names remain in ``roads.pmtiles``.
This archive adds only the visual context the routing graph does not carry:
land, water, green space, waterways, and settlement label points.

Inputs:
  * Geofabrik Washington OSM PBF (detailed coastline, water, and green space)
  * Natural Earth 1:10m land shapefile (low-zoom land fallback)
  * The app's existing compact places.json search index

Requires the ``osmium`` and ``tippecanoe`` command-line tools, plus the
project virtual environment's ``shapely`` and ``pyshp`` packages.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import shapefile
from shapely.geometry import LinearRing, Polygon, box, mapping, shape
from shapely.ops import linemerge, unary_union


# The clip box, a little wider than the state so the coastline and the land
# backdrop run past the edge instead of stopping at it. Washington's is the
# default; main() replaces it from --bounds when another state is built, which
# is why every user reads the module global rather than closing over a constant.
BOUNDS = (-125.5, 45.2, -116.7, 50.0)
AREA_FILTERS = {
    "natural": {"water", "wood", "wetland"},
    "landuse": {"forest", "recreation_ground", "grass", "meadow", "reservoir"},
    "leisure": {"park", "nature_reserve", "recreation_ground", "golf_course"},
    "boundary": {"national_park", "protected_area"},
}


def run(*args: str) -> None:
    print("+", " ".join(args), flush=True)
    subprocess.run(args, check=True)


def write_record(handle, feature: dict) -> None:
    handle.write("\x1e")
    json.dump(feature, handle, ensure_ascii=False, separators=(",", ":"))
    handle.write("\n")


def is_area(props: dict) -> bool:
    return any(props.get(key) in values for key, values in AREA_FILTERS.items())


def context_kind(props: dict) -> tuple[str | None, str | None]:
    natural = props.get("natural")
    landuse = props.get("landuse")
    leisure = props.get("leisure")
    boundary = props.get("boundary")
    waterway = props.get("waterway")
    if natural == "water" or landuse == "reservoir":
        return "water", "water"
    if waterway in {"river", "canal"}:
        return "waterway", waterway
    if waterway == "stream" and props.get("name"):
        return "waterway", "stream"
    if natural == "wetland":
        return "green", "wetland"
    if natural == "wood" or landuse == "forest":
        return "green", "forest"
    if boundary == "national_park":
        return "green", "national_park"
    if boundary == "protected_area" or leisure == "nature_reserve":
        return "green", "protected"
    if leisure == "golf_course":
        return "green", "golf"
    if leisure in {"park", "recreation_ground"} or landuse in {
        "recreation_ground", "grass", "meadow"
    }:
        return "green", "park"
    return None, None


def export_osm_context(source: Path, work: Path) -> dict[str, Path]:
    filtered = work / "context.osm.pbf"
    exported = work / "context.geojsonseq"
    config = work / "export-config.json"
    filters = [
        "a/natural=water,wood,wetland",
        "a/leisure=park,nature_reserve,recreation_ground,golf_course",
        "a/landuse=forest,recreation_ground,grass,meadow,reservoir",
        "a/boundary=national_park,protected_area",
        "w/waterway=river,canal,stream",
    ]
    run("osmium", "tags-filter", "-t", "-O", "-o", str(filtered), str(source), *filters)
    config.write_text(json.dumps({
        "attributes": {
            "type": False, "id": False, "version": False, "changeset": False,
            "timestamp": False, "uid": False, "user": False, "way_nodes": False,
        },
        "format_options": {},
        "linear_tags": ["waterway"],
        "area_tags": [
            "natural=water,wood,wetland",
            "leisure=park,nature_reserve,recreation_ground,golf_course",
            "landuse=forest,recreation_ground,grass,meadow,reservoir",
            "boundary=national_park,protected_area",
        ],
        "include_tags": [
            "name", "natural", "landuse", "leisure", "waterway", "boundary",
        ],
    }, indent=2))
    run(
        "osmium", "export", "-c", str(config), "-f", "geojsonseq", "-O",
        "-o", str(exported), str(filtered),
    )

    outputs = {"water": work / "water.geojsonseq",
               "waterway": work / "waterway.geojsonseq",
               "green": work / "green.geojsonseq"}
    handles = {key: path.open("w", encoding="utf-8") for key, path in outputs.items()}
    counts = {key: 0 for key in outputs}
    try:
        with exported.open(encoding="utf-8") as source_file:
            for line in source_file:
                feature = json.loads(line.lstrip("\x1e"))
                props = feature.get("properties") or {}
                layer, kind = context_kind(props)
                if not layer:
                    continue
                geometry = feature.get("geometry") or {}
                if layer != "waterway" and geometry.get("type") == "LineString":
                    coordinates = geometry.get("coordinates") or []
                    if len(coordinates) >= 4 and coordinates[0] == coordinates[-1] and is_area(props):
                        geometry = {"type": "Polygon", "coordinates": [coordinates]}
                    else:
                        continue
                name = props.get("name")
                compact = {"k": kind}
                if name:
                    compact["n"] = name
                out_feature = {
                    "type": "Feature",
                    "properties": compact,
                    "geometry": geometry,
                }
                write_record(handles[layer], out_feature)
                counts[layer] += 1
    finally:
        for handle in handles.values():
            handle.close()
    print("OSM context:", ", ".join(f"{key}={counts[key]:,}" for key in counts))
    return outputs


def export_land(source: Path, output: Path) -> None:
    """Clip the generalized Natural Earth land used at regional zooms."""
    clip = box(*BOUNDS)
    reader = shapefile.Reader(str(source))
    count = 0
    with output.open("w", encoding="utf-8") as handle:
        for item in reader.iterShapeRecords():
            geometry = shape(item.shape.__geo_interface__)
            if not geometry.intersects(clip):
                continue
            geometry = geometry.intersection(clip)
            if geometry.is_empty:
                continue
            write_record(handle, {
                "type": "Feature",
                "properties": {},
                "geometry": mapping(geometry),
            })
            count += 1
    print(f"Natural Earth land: {count:,} clipped feature(s)")


def export_detailed_land(source: Path, output: Path, work: Path) -> None:
    """Build accurate close-zoom land polygons from directed OSM coastlines.

    Natural Earth is intentionally generalized and can put island streets in
    the ocean when overzoomed. OSM coastline ways keep land on their left.
    Merging those ways produces closed island rings plus one long mainland
    coastline. Natural Earth remains underneath as a regional fallback; these
    polygons replace its shoreline only from zoom 8 onward.
    """
    coast_pbf = work / "coastline.osm.pbf"
    coast_seq = work / "coastline.geojsonseq"
    export_config = work / "coastline-export-config.json"
    run(
        "osmium", "tags-filter", "-t", "-O", "-o", str(coast_pbf),
        str(source), "w/natural=coastline",
    )
    export_config.write_text(json.dumps({
        "attributes": {
            "type": False, "id": False, "version": False, "changeset": False,
            "timestamp": False, "uid": False, "user": False, "way_nodes": False,
        },
        "format_options": {},
        # The input PBF was already filtered to coastline ways. Force every
        # closed island way to remain a directed line so land-on-the-left
        # orientation is preserved for polygon assembly below.
        "linear_tags": True,
        "area_tags": False,
        "include_tags": ["natural"],
    }, indent=2))
    run(
        "osmium", "export", "-c", str(export_config), "-f", "geojsonseq",
        "-O", "-o", str(coast_seq), str(coast_pbf),
    )

    lines = []
    with coast_seq.open(encoding="utf-8") as source_file:
        for line in source_file:
            feature = json.loads(line.lstrip("\x1e"))
            geometry = feature.get("geometry")
            if not geometry:
                continue
            item = shape(geometry)
            if item.geom_type == "LineString":
                lines.append(item)
            elif item.geom_type == "MultiLineString":
                lines.extend(item.geoms)
    merged = linemerge(unary_union(lines))
    parts = list(merged.geoms) if merged.geom_type == "MultiLineString" else [merged]
    closed = [line for line in parts if line.is_ring]
    open_lines = [line for line in parts if not line.is_ring]
    if not closed or not open_lines:
        raise RuntimeError("OSM coastline did not produce island and mainland geometry")

    clip = box(*BOUNDS)
    polygons = []
    for ring in closed:
        # OSM coastlines are directed with land on the left. Closed island
        # rings must therefore be counter-clockwise.
        if not LinearRing(ring.coords).is_ccw:
            continue
        polygon = Polygon(ring.coords)
        if not polygon.is_valid:
            polygon = polygon.buffer(0)
        polygon = polygon.intersection(clip)
        if not polygon.is_empty:
            polygons.append(polygon)

    # The longest open coastline is the Pacific-facing mainland. It runs from
    # north to south in the Washington extract, with mainland on its left.
    mainland_coast = max(open_lines, key=lambda line: line.length)
    coast_coords = list(mainland_coast.coords)
    if coast_coords[0][1] < coast_coords[-1][1]:
        coast_coords.reverse()
    minx, miny, maxx, maxy = BOUNDS
    mainland = Polygon([
        *coast_coords,
        (maxx, miny),
        (maxx, maxy),
        coast_coords[0],
    ]).buffer(0).intersection(clip)
    if mainland.is_empty:
        raise RuntimeError("OSM mainland coastline did not produce land geometry")
    polygons.append(mainland)

    count = 0
    with output.open("w", encoding="utf-8") as handle:
        for polygon in polygons:
            write_record(handle, {
                "type": "Feature",
                "tippecanoe": {"minzoom": 8},
                "properties": {},
                "geometry": mapping(polygon),
            })
            count += 1
    print(
        f"OSM detailed land: {count:,} polygons "
        f"({len(closed):,} closed rings, {len(open_lines):,} open coastlines)"
    )


def place_minzoom(kind: str, population: int) -> int:
    if population >= 100_000:
        return 5
    if kind == "city" or population >= 25_000:
        return 7
    if kind in {"town", "ferry"} or population >= 5_000:
        return 9
    if kind in {"village", "suburb"}:
        return 11
    return 13


def export_places(source: Path, output: Path) -> None:
    rows = json.loads(source.read_text())
    with output.open("w", encoding="utf-8") as handle:
        for name, lon, lat, kind, population in rows:
            write_record(handle, {
                "type": "Feature",
                "tippecanoe": {"minzoom": place_minzoom(kind, population)},
                "properties": {"n": name, "k": kind, "p": population},
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
            })
    print(f"Places: {len(rows):,} label points")


def main() -> None:
    global BOUNDS
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", default="data/washington-latest.osm.pbf")
    parser.add_argument("--places", default="maps/washington/places.json")
    parser.add_argument("--natural-earth-land",
                        default="data/natural-earth/ne_10m_land.shp",
                        help="Path to ne_10m_land.shp "
                             "(scripts/fetch_natural_earth.sh puts it here)")
    parser.add_argument("--out", default="maps/washington/basemap.pmtiles")
    parser.add_argument("--bounds", default=None,
                        help="clip box as minLon,minLat,maxLon,maxLat "
                             f"(default {','.join(str(v) for v in BOUNDS)})")
    parser.add_argument("--coastline", choices=("osm", "natural-earth"), default="osm",
                        help="'osm' traces the detailed coastline from the extract; "
                             "'natural-earth' ships only the generalized land polygon, "
                             "for a landlocked state or a first pass at a new one")
    parser.add_argument("--maxzoom", type=int, default=13,
                        help="highest stored context zoom (higher zooms overzoom these tiles)")
    parser.add_argument("--simplification", type=float, default=8,
                        help="tippecanoe low-zoom simplification factor")
    args = parser.parse_args()

    if args.bounds:
        parts = tuple(float(value) for value in args.bounds.split(","))
        if len(parts) != 4:
            raise SystemExit("--bounds wants minLon,minLat,maxLon,maxLat")
        BOUNDS = parts
    print(f"Clip box: {BOUNDS}")

    for command in ("osmium", "tippecanoe"):
        if not shutil.which(command):
            raise SystemExit(f"Required command not found: {command}")

    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="randoroute-basemap-") as tmp:
        work = Path(tmp)
        layers = export_osm_context(Path(args.src), work)
        land = work / "land.geojsonseq"
        detailed_land = work / "land-detail.geojsonseq"
        places = work / "places.geojsonseq"
        export_land(Path(args.natural_earth_land), land)
        if args.coastline == "osm":
            export_detailed_land(Path(args.src), detailed_land, work)
        else:
            # Still hand tippecanoe an empty layer: dropping the -L would
            # change the archive's layer list, and basemap-style.js draws
            # land_detail above land in every state.
            detailed_land.write_text("", encoding="utf-8")
            print("Detailed land: skipped (--coastline natural-earth)")
        export_places(Path(args.places), places)
        run(
            "tippecanoe", "-o", str(output), "--force", "-Z4", f"-z{args.maxzoom}",
            "--drop-densest-as-needed", "--drop-smallest-as-needed",
            "--extend-zooms-if-still-dropping", f"--simplification={args.simplification}",
            "--simplify-only-low-zooms", "--read-parallel",
            "-L", f"land:{land}",
            "-L", f"land_detail:{detailed_land}",
            "-L", f"water:{layers['water']}",
            "-L", f"waterway:{layers['waterway']}",
            "-L", f"green:{layers['green']}",
            "-L", f"places:{places}",
        )
    print(f"Wrote {output} ({output.stat().st_size / 1024 / 1024:.1f} MiB)")


if __name__ == "__main__":
    main()
