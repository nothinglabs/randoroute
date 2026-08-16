# Oregon build

This run was performed on 2026-08-15/16 with the Oregon Geofabrik extract and
the public ODOT ArcGIS inventories. The commands below assume the repository
root is the working directory. The agency adapter and its cache live under
`maps/oregon/tools/` and `data/.cache/oregon-odot/` respectively.

## Build environment and source downloads

```bash
python3 -m venv /private/tmp/randoroute-venv
/private/tmp/randoroute-venv/bin/pip install shapely osmium Pillow numpy pyshp

curl -L --fail --retry 3 -o data/oregon-latest.osm.pbf \
  https://download.geofabrik.de/north-america/us/oregon-latest.osm.pbf
/private/tmp/randoroute-venv/bin/python scripts/fetch_census_urban_areas.py Oregon
bash scripts/fetch_natural_earth.sh
bash scripts/fetch_dem.sh oregon
```

The required source census and the agency field decisions are recorded in
[`STATUS.md`](./STATUS.md). No county road log or statewide bicycle-prohibition
dataset was available, so those inputs are intentionally empty in both shared
builder commands below.

## Agency and federal inputs

```bash
/private/tmp/randoroute-venv/bin/python maps/oregon/tools/build_odot.py
/private/tmp/randoroute-venv/bin/python scripts/build_hpms.py \
  --state Oregon --year 2018 --out maps/oregon/hpms.geojson \
  --cache data/.cache/hpms-oregon-2018

gzip -c maps/oregon/blts.geojson > maps/oregon/blts.geojson.gz
gzip -c maps/oregon/odot_speed.geojson > maps/oregon/odot_speed.geojson.gz
gzip -c maps/oregon/odot_facilities.geojson > maps/oregon/odot_facilities.geojson.gz
gzip -c maps/oregon/funcclass.geojson > maps/oregon/funcclass.geojson.gz
gzip -c maps/oregon/aadt.geojson > maps/oregon/aadt.geojson.gz
gzip -c maps/oregon/hpms.geojson > maps/oregon/hpms.geojson.gz
```

The adapter keeps ODOT's stress, shoulder, posted-speed, facility,
functional-class, and state-system AADT inventories separate by ownership. It
also joins only the matched ODOT posted-speed inventory into `blts.geojson`,
because the shared road builder reads speed from that normalized stream while
the graph builder reads the dedicated speed layer.

## OSM-derived inputs

```bash
/private/tmp/randoroute-venv/bin/python scripts/build_osm.py \
  --src data/oregon-latest.osm.pbf --out maps/oregon/bikeinfra.geojson
/private/tmp/randoroute-venv/bin/python scripts/build_places.py \
  --src data/oregon-latest.osm.pbf --out maps/oregon/places.json
/private/tmp/randoroute-venv/bin/python scripts/build_routes.py \
  --src data/oregon-latest.osm.pbf \
  --bounds=-124.8,41.8,-116.3,46.4 \
  --out maps/oregon/bikeroutes.geojson

gzip -c maps/oregon/bikeinfra.geojson > maps/oregon/bikeinfra.geojson.gz
gzip -c maps/oregon/bikeroutes.geojson > maps/oregon/bikeroutes.geojson.gz
gzip -c maps/oregon/route_closures.geojson > maps/oregon/route_closures.geojson.gz
```

`build_routes.py` produces the OSM bicycle-route overlay and the extracted
route-closure collection. The corridor specification was written before these
builds in [`corridors.json`](./corridors.json).

## Tiles and routing graph

Inflate the compressed agency inputs before invoking the shared builders. This
avoids silently using a different state's file and makes the rebuild use the
same committed inputs as the shipped compressed copies.

```bash
gzip -dc maps/oregon/blts.geojson.gz > maps/oregon/blts.geojson
gzip -dc maps/oregon/odot_speed.geojson.gz > maps/oregon/odot_speed.geojson
gzip -dc maps/oregon/odot_facilities.geojson.gz > maps/oregon/odot_facilities.geojson
gzip -dc maps/oregon/funcclass.geojson.gz > maps/oregon/funcclass.geojson
gzip -dc maps/oregon/aadt.geojson.gz > maps/oregon/aadt.geojson
gzip -dc maps/oregon/hpms.geojson.gz > maps/oregon/hpms.geojson

/private/tmp/randoroute-venv/bin/python scripts/build_overlay_tiles.py --state oregon

/private/tmp/randoroute-venv/bin/python scripts/build_roads.py \
  --src data/oregon-latest.osm.pbf \
  --out-prefix data/oregon-roads \
  --urban-areas data/census-urban-areas-2020-oregon.geojson \
  --blts maps/oregon/blts.geojson \
  --roadlog "" \
  --funcclass maps/oregon/funcclass.geojson \
  --aadt maps/oregon/aadt.geojson \
  --hpms maps/oregon/hpms.geojson \
  --facilities maps/oregon/odot_facilities.geojson

tippecanoe -o maps/oregon/roads.pmtiles -l roads --force -Z5 -z13 \
  --drop-densest-as-needed --coalesce --extend-zooms-if-still-dropping \
  --simplification=8 --simplify-only-low-zooms --read-parallel \
  data/oregon-roads-*.geojson

/private/tmp/randoroute-venv/bin/python scripts/build_basemap.py \
  --src data/oregon-latest.osm.pbf \
  --places maps/oregon/places.json \
  --natural-earth-land data/natural-earth/ne_10m_land.shp \
  --bounds=-124.8,41.8,-116.3,46.4 \
  --out maps/oregon/basemap.pmtiles

/private/tmp/randoroute-venv/bin/python scripts/build_graph.py \
  --src data/oregon-latest.osm.pbf \
  --out maps/oregon/graph2.bin.gz \
  --blts maps/oregon/blts.geojson \
  --restrictions "" \
  --legal-speeds maps/oregon/odot_speed.geojson \
  --facilities maps/oregon/odot_facilities.geojson \
  --urban-areas data/census-urban-areas-2020-oregon.geojson \
  --roadlog "" \
  --funcclass maps/oregon/funcclass.geojson \
  --aadt maps/oregon/aadt.geojson \
  --hpms maps/oregon/hpms.geojson

node scripts/stamp_tiles_version.mjs oregon
npm run maps:registry
```

The graph builder stamps `graph`; the tile stamper stamps `roads`, `basemap`,
and `overlays`. The generated registry files are
`maps/states.js` and `maps/index.json`.

## Verification

Run the commands in [`VERIFICATION.md`](./VERIFICATION.md). The final build
must leave the plain GeoJSON inputs available for local rebuilds, with the
compressed copies committed for the map pack. The `data/oregon-roads-*.geojson`
files are build intermediates and are not part of the state pack.
