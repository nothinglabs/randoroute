#!/usr/bin/env python3
"""Build the compact offline geographic-context PMTiles archive.

The routable street geometry and street names remain in ``roads.pmtiles``.
This archive adds only the visual context the routing graph does not carry:
land, water, green space, waterways, and settlement label points.

Inputs:
  * Geofabrik Washington OSM PBF (water and green-space geometry)
  * Natural Earth 1:10m land shapefile (coastline/land backdrop)
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
from shapely.geometry import box, mapping, shape


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
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", default="data/washington-latest.osm.pbf")
    parser.add_argument("--places", default="data/places.json")
    parser.add_argument("--natural-earth-land", required=True,
                        help="Path to ne_10m_land.shp")
    parser.add_argument("--out", default="data/basemap.pmtiles")
    parser.add_argument("--maxzoom", type=int, default=10,
                        help="highest stored context zoom (higher zooms overzoom these tiles)")
    parser.add_argument("--simplification", type=float, default=8,
                        help="tippecanoe low-zoom simplification factor")
    args = parser.parse_args()

    for command in ("osmium", "tippecanoe"):
        if not shutil.which(command):
            raise SystemExit(f"Required command not found: {command}")

    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="clauding-basemap-") as tmp:
        work = Path(tmp)
        layers = export_osm_context(Path(args.src), work)
        land = work / "land.geojsonseq"
        places = work / "places.geojsonseq"
        export_land(Path(args.natural_earth_land), land)
        export_places(Path(args.places), places)
        run(
            "tippecanoe", "-o", str(output), "--force", "-Z4", f"-z{args.maxzoom}",
            "--drop-densest-as-needed", "--drop-smallest-as-needed",
            "--extend-zooms-if-still-dropping", f"--simplification={args.simplification}",
            "--simplify-only-low-zooms", "--read-parallel",
            "-L", f"land:{land}",
            "-L", f"water:{layers['water']}",
            "-L", f"waterway:{layers['waterway']}",
            "-L", f"green:{layers['green']}",
            "-L", f"places:{places}",
        )
    print(f"Wrote {output} ({output.stat().st_size / 1024 / 1024:.1f} MiB)")


if __name__ == "__main__":
    main()
