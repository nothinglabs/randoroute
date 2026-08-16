# Building Washington

Every file in this folder, in the order it has to be built. Run from the repo
root. Raw downloads land in `data/` and are git-ignored; everything committed
lives here.

Tools: `python3` with `osmium`, `shapely`, `pyshp`, `geopandas`, `pyogrio`,
`pyproj`; the `osmium` and `tippecanoe` command-line tools; `node`.

The narrative explanation of *why* each source is used, and what the app does
with it, is in the repo `README.md` under "Data (build-time)". This file is the
runbook.

---

## 0. The OSM extract

```bash
curl -o data/washington-latest.osm.pbf \
  https://download.geofabrik.de/north-america/us/washington-latest.osm.pbf
```

Geofabrik's Washington extract, EPSG:4326. Input to almost everything below.

## 1. Agency inputs

```bash
# WSDOT Bicycle and Pedestrian Level of Traffic Stress (File Geodatabase)
curl -o data/BikePedLTS.zip \
  https://data.wsdot.wa.gov/geospatial/DOT_ActiveTransportation/BikePedLTS.zip
unzip -d data data/BikePedLTS.zip

# WSDOT Permanent Bike Restrictions
curl -o data/PermanentBikeRestrictions.zip \
  https://data.wsdot.wa.gov/geospatial/DOT_ActiveTransportation/PermanentBikeRestrictions.zip
unzip -d data/permbike data/PermanentBikeRestrictions.zip

# WSDOT legal speeds + existing bicycle facilities (ArcGIS FeatureServer)
python3 scripts/fetch_wsdot_graph_data.py

# 2020 Census urban areas (build input, not committed)
python3 scripts/fetch_census_urban_areas.py

# Elevation: AWS Terrarium tiles, z12 (~38 m). One-time, ~6,900 tiles.
# Reads the box from maps/washington/region.json; fetches into
# maps/washington/dem/, which is where build_graph.py looks.
bash scripts/fetch_dem.sh washington
```

## 2. Road measurements

Each of these pages an ArcGIS service and caches pages under `data/.cache`, so
an interrupted run resumes rather than restarting.

```bash
python3 maps/washington/tools/build_roadlog.py     # CRAB certified county road log
python3 maps/washington/tools/build_funcclass.py   # WSDOT non-state functional class
python3 maps/washington/tools/build_aadt.py        # WSDOT traffic counts, state routes
python3 scripts/build_hpms.py        # FHWA HPMS public release
```

The compressed results are committed here as `roadlog.geojson.gz`,
`funcclass.geojson.gz`, `aadt.geojson.gz` and `hpms.geojson.gz`, so a rebuild
does not have to re-page the services.

## 3. Safety linework

```bash
python3 maps/washington/tools/build_restrictions.py            # -> bike_restrictions.geojson
python3 maps/washington/tools/build_blts.py \
  --src data/BikePedLTS.gdb --out maps/washington/blts.geojson
python3 scripts/build_osm.py \
  --src data/washington-latest.osm.pbf --out maps/washington/bikeinfra.geojson
python3 scripts/build_routes.py --src data/washington-latest.osm.pbf
python3 scripts/build_places.py --src data/washington-latest.osm.pbf \
  --out maps/washington/places.json
```

`build_blts.py` joins the restrictions in, flagging any BLTS segment whose
milepost range overlaps a prohibition as `Prohibited` so it hard-fails scoring.
The join matches mainline `RouteIdentifier` and ignores direction, which
over-flags the opposite direction — deliberately conservative.

## 4. Tiles

```bash
python3 scripts/build_roads.py --src data/washington-latest.osm.pbf \
                               --out-prefix data/roads \
                               --urban-areas data/census-urban-areas-2020-washington.geojson \
                               --blts maps/washington/blts.geojson \
                               --roadlog data/roadlog.geojson \
                               --funcclass data/funcclass.geojson \
                               --aadt data/aadt.geojson
tippecanoe -o maps/washington/roads.pmtiles -l roads --force -Z5 -z13 \
  --drop-densest-as-needed --coalesce --extend-zooms-if-still-dropping \
  --simplification=8 --simplify-only-low-zooms \
  --read-parallel data/roads-1.geojson data/roads-2.geojson
rm data/roads-*.geojson

npm run data:compress-overlays          # the .geojson.gz runtime overlays
python3 scripts/build_overlay_tiles.py  # -> overlays.pmtiles

bash scripts/fetch_natural_earth.sh   # world land polygon, shared by every state
python3 scripts/build_basemap.py \
  --src data/washington-latest.osm.pbf \
  --places maps/washington/places.json \
  --out maps/washington/basemap.pmtiles

node scripts/stamp_tiles_version.mjs washington
```

`--simplify-only-low-zooms` is required, not a preference: the app draws these
tiles far past z13, so whatever z13 keeps is what a rider sees at full zoom.
Without it, `--simplification=8` erases anything under ~26 m and Washington's
traffic circles come back as spikes.

`build_basemap.py`'s `--bounds` defaults to Washington's clip box
(`-125.5,45.2,-116.7,50.0`), so it is omitted above.

## 5. Routing graph

```bash
python3 scripts/build_graph.py --src data/washington-latest.osm.pbf
```

Defaults already point at this folder. The builder hashes the artefact and
writes `versions.graph` into `region.json`, then regenerates `maps/states.js`.
`scripts/test_graph_version_stamp.mjs` fails the suite if the two disagree.

Optional patches, each rewriting the graph in place:

```bash
python3 scripts/patch_graph_prohibited.py
python3 scripts/patch_graph_limited_access.py
python3 scripts/patch_graph_ferry_access.py
```

## 6. Check

```bash
npm test                 # the suite reads these files directly
python3 -c "import gzip;print(gzip.open('maps/washington/graph2.bin.gz','rb').read(4))"
tippecanoe-decode maps/washington/roads.pmtiles 13 1311 2858 | grep -c '"ln"'
```

---

## Provenance

| File | Source | Built by |
| --- | --- | --- |
| `graph2.bin.gz` | OSM + WSDOT + CRAB + FHWA + AWS Terrarium DEM | `build_graph.py` |
| `roads.pmtiles` | OSM + WSDOT BLTS + roadlog + funcclass + AADT | `build_roads.py` + tippecanoe |
| `basemap.pmtiles` | OSM + Natural Earth 1:10m land + `places.json` | `build_basemap.py` |
| `overlays.pmtiles` | `bikeinfra.geojson.gz` + `blts.geojson.gz` | `build_overlay_tiles.py` |
| `blts.geojson[.gz]` | WSDOT BikePedLTS geodatabase (EPSG:2927 → 4326) | `build_blts.py` |
| `bikeinfra.geojson[.gz]` | OSM cycleways, paths, on-street lanes | `build_osm.py` |
| `bike_restrictions.geojson[.gz]` | WSDOT Permanent Bike Restrictions | `build_restrictions.py` |
| `bikeroutes.geojson[.gz]` | OSM `route=bicycle` relations (`ncn`/`rcn`) | `build_routes.py` |
| `route_closures.geojson[.gz]` | Hand-maintained; long-term closures | — |
| `places.json` | OSM settlements + ferry terminals | `build_places.py` |
| `roadlog/funcclass/aadt/hpms.geojson.gz` | CRAB, WSDOT, FHWA services | the matching `build_*.py` |

Licences: OpenStreetMap contributors (ODbL); WSDOT, CRAB and FHWA data are
public records; Natural Earth is public domain.
