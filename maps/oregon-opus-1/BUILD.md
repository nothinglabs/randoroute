# Building Oregon

Every file in this folder, in the order it has to be built. Run from the repo
root. Raw downloads land in `data/` and are git-ignored; everything committed
lives here.

Tools: `python3` with `osmium`, `shapely`, `pyshp`, `Pillow`, `numpy`; the
`osmium` and `tippecanoe` command-line tools; `node`.

On a bare container that is:

```bash
pip install shapely osmium Pillow numpy pyshp
apt-get install -y tippecanoe osmium-tool
```

The method behind these commands is `docs/PORTING-TO-ANOTHER-STATE.md`; the
reasoning behind the source choices is `maps/oregon/STATUS.md` and
`scripts/build_odot.py`'s module docstring. This file is the runbook.

---

## 0. The OSM extract

```bash
curl -sSL -o data/oregon-latest.osm.pbf \
  https://download.geofabrik.de/north-america/us/oregon-latest.osm.pbf
```

Geofabrik's Oregon extract, EPSG:4326 (241 MiB on 2026-08-10). Input to almost
everything below.

## 1. Build inputs that are not agency data

```bash
# 2020 Census urban areas, over this state's declared coverage box.
python3 scripts/fetch_census_urban_areas.py oregon

# Elevation: AWS Terrarium tiles, z12 (~38 m). One-time, 8,446 tiles / 889 MiB.
# Reads the box from maps/oregon/region.json; fetches into maps/oregon/dem/,
# which is where build_graph.py then looks. Git-ignored, never shipped.
bash scripts/fetch_dem.sh oregon

# World land polygon for the basemap's low zooms. Shared by every state.
bash scripts/fetch_natural_earth.sh
```

## 2. ODOT agency data

```bash
python3 scripts/build_odot.py                 # all four outputs
python3 scripts/build_hpms.py --state Oregon --year 2018 \
                              --out data/hpms-oregon.geojson
```

`build_odot.py` reads ODOT's TransGIS data catalogue and writes:

| output | from |
| --- | --- |
| `maps/oregon/blts.geojson` | layer 390 geometry + rating, joined by linear reference to the shoulder (127), posted speed (158), lane count (126), facility (136), signed route (166) and expressway (175) layers |
| `data/odot_legal_speeds.geojson` | layer 158 |
| `data/odot_bike_facilities.geojson` | layer 136, `BL` and `SL` rows only |
| `data/funcclass-oregon.geojson` | layers 171 + 173 |

It pages each layer and caches pages under `data/.cache/odot`, so an
interrupted run resumes rather than restarting. A cold run is roughly 25
minutes, most of it layer 173 (83,114 non-state functional-class segments).

`blts.geojson` is committed here (32 MiB, 8.3 MiB gzipped) because re-fetching
it takes longer than the idle window that reclaims the container.

## 3. Safety linework and place search

```bash
python3 scripts/build_osm.py --src data/oregon-latest.osm.pbf \
  --out maps/oregon/bikeinfra.geojson
python3 scripts/build_routes.py --src data/oregon-latest.osm.pbf \
  --out maps/oregon/bikeroutes.geojson --bounds="-125.5,41.7,-116.2,46.5"
python3 scripts/build_places.py --src data/oregon-latest.osm.pbf \
  --out maps/oregon/places.json
```

`--bounds` on `build_routes.py` is required, not optional: its default is
Washington's rectangle and an Oregon relation clipped to it comes out empty.

There is no `build_restrictions.py` step. ODOT publishes no bicycle-prohibition
layer — see `STATUS.md`.

## 4. Tiles

```bash
python3 scripts/build_roads.py --src data/oregon-latest.osm.pbf \
                               --out-prefix data/roads-or \
                               --urban-areas data/census-urban-areas-2020-oregon.geojson \
                               --blts maps/oregon/blts.geojson \
                               --funcclass data/funcclass-oregon.geojson \
                               --hpms data/hpms-oregon.geojson \
                               --facilities data/odot_bike_facilities.geojson
tippecanoe -o maps/oregon/roads.pmtiles -l roads --force -Z5 -z13 \
  --drop-densest-as-needed --coalesce --extend-zooms-if-still-dropping \
  --simplification=8 --simplify-only-low-zooms \
  --read-parallel data/roads-or-1.geojson data/roads-or-2.geojson
rm data/roads-or-*.geojson

npm run data:compress-overlays          # the .geojson.gz runtime overlays
python3 scripts/build_overlay_tiles.py --state oregon

python3 scripts/build_basemap.py \
  --src data/oregon-latest.osm.pbf \
  --places maps/oregon/places.json \
  --out maps/oregon/basemap.pmtiles \
  --bounds="-125.5,41.7,-116.2,46.5"

node scripts/stamp_tiles_version.mjs oregon
```

`--simplify-only-low-zooms` is required, not a preference: the app draws these
tiles far past z13, so whatever z13 keeps is what a rider sees at full zoom.

`build_basemap.py` keeps its default `--coastline osm`. Oregon's Pacific
coastline assembles the same way Washington's does — the longest open coastline
way runs north to south with land on its left, and the mainland polygon is
closed against the east edge of the clip box.

## 5. Routing graph

```bash
python3 scripts/build_graph.py \
  --src data/oregon-latest.osm.pbf \
  --out maps/oregon/graph2.bin.gz \
  --blts maps/oregon/blts.geojson \
  --restrictions "" \
  --legal-speeds data/odot_legal_speeds.geojson \
  --facilities data/odot_bike_facilities.geojson \
  --urban-areas data/census-urban-areas-2020-oregon.geojson \
  --roadlog "" \
  --funcclass data/funcclass-oregon.geojson \
  --aadt "" \
  --hpms data/hpms-oregon.geojson
```

Every path has to be given: the defaults are Washington's. The two empty
strings are deliberate and are the state's two missing sources — Oregon has no
county road-log equivalent and no published bicycle prohibitions. An empty
string skips the source; a wrong path would silently conflate another state's.

The builder hashes the artefact and writes `versions.graph` into `region.json`,
then regenerates `maps/states.js`.

None of the three optional patches (`patch_graph_prohibited.py`,
`patch_graph_limited_access.py`, `patch_graph_ferry_access.py`) is run: the
first two read WSDOT files, and Oregon has no ferry in the routing network.

## 6. Check

```bash
npm test corridor_severance     # the stage-5 gate, on maps/oregon/corridors.json
npm test                        # the suite reads these files directly
python3 scripts/measure_coverage.py --graph maps/oregon/graph2.bin.gz
node scripts/verify_against_routes.mjs oregon > data/_verify_oregon.json
python3 scripts/verify_against_routes.py < data/_verify_oregon.json
```

---

## Provenance

| File | Source | Built by |
| --- | --- | --- |
| `graph2.bin.gz` | OSM + ODOT + FHWA HPMS + AWS Terrarium DEM | `build_graph.py` |
| `roads.pmtiles` | OSM + ODOT BLTS + funcclass + HPMS + facilities | `build_roads.py` + tippecanoe |
| `basemap.pmtiles` | OSM + Natural Earth 1:10m land + `places.json` | `build_basemap.py` |
| `overlays.pmtiles` | `bikeinfra.geojson.gz` + `blts.geojson.gz` | `build_overlay_tiles.py` |
| `blts.geojson[.gz]` | ODOT data catalogue layers 390/127/158/126/136/166/175 | `build_odot.py` |
| `bikeinfra.geojson[.gz]` | OSM cycleways, paths, on-street lanes | `build_osm.py` |
| `bikeroutes.geojson[.gz]` | OSM `route=bicycle` relations (`ncn`/`rcn`) | `build_routes.py` |
| `route_closures.geojson[.gz]` | Written by `build_routes.py`; hand-maintained after | — |
| `places.json` | OSM settlements | `build_places.py` |
| `corridors.json` | Hand-written before the build; the stage-5 spec | — |

Not shipped, rebuildable: `data/funcclass-oregon.geojson`,
`data/hpms-oregon.geojson`, `data/odot_legal_speeds.geojson`,
`data/odot_bike_facilities.geojson`, `maps/oregon/dem/`.

Licences: OpenStreetMap contributors (ODbL); ODOT and FHWA data are public
records; Natural Earth is public domain.
