# Building Nevada

Every command that produced every file in this folder, in order, from the repo
root. Run on 2026-08-21. `data/` holds the raw downloads and is git-ignored;
everything committed lives here.

Tools: `python3` with `shapely`, `osmium`, `Pillow`, `numpy`, `pyshp`; the
`osmium` and `tippecanoe` command-line tools; `node`.

**Every builder's defaults are Washington's.** Both shared builders take eight
or nine source paths and every default names a Washington file, so a forgotten
one silently conflates Washington's data onto Nevada geometry. Every path below
is passed explicitly, and `""` is passed for the two sources Nevada does not
have. Those empty strings are statements: see `STATUS.md`'s census for the
field-level reason behind each.

---

## 0. The extract and the national inputs

```bash
curl -L --fail --retry 3 -o data/nevada-latest.osm.pbf \
  https://download.geofabrik.de/north-america/us/nevada-latest.osm.pbf

python3 scripts/fetch_census_urban_areas.py nevada     # 62 urban areas
bash scripts/fetch_natural_earth.sh                    # shared land polygon
bash scripts/fetch_dem.sh nevada                       # 8,814 z12 tiles, ~970 MB
```

`fetch_dem.sh` reads the coverage box from `region.json` and pads a quarter
degree, so `region.json` has to exist before this runs.

## 1. Agency inputs

```bash
python3 maps/nevada/tools/build_ndot.py       # NDOT ALRS -> four normalized files
python3 maps/nevada/tools/build_rtcsnv.py     # Southern Nevada bike facilities
python3 scripts/build_hpms.py \
  --state Nevada --year 2018 \
  --out maps/nevada/hpms.geojson \
  --cache data/.cache/hpms-nevada-2018
```

**Probe the HPMS year.** 2015–2023 were all tried; only 2018 answers, and the
layer inside `Nevada_2018_PR` is named `NNevada_PR_2018` with a doubled N. A
wrong year is a 404, not a wrong number.

`build_ndot.py` writes `blts.geojson` (the normalized roadway inventory both
shared builders read as `--blts`), `ndot_speed.geojson`, `funcclass.geojson`
and `aadt.geojson`. `build_rtcsnv.py` writes `rtcsnv_facilities.geojson`. Both
cache their ArcGIS pages under `data/.cache/`, so an interrupted run resumes.

Commit the sources compressed — re-fetching NDOT's ownership and class layers
takes about twenty minutes, which is longer than the idle window that destroys
an uncommitted container (lesson G6):

```bash
gzip -c maps/nevada/blts.geojson       > maps/nevada/blts.geojson.gz
gzip -c maps/nevada/ndot_speed.geojson > maps/nevada/ndot_speed.geojson.gz
gzip -c maps/nevada/funcclass.geojson  > maps/nevada/funcclass.geojson.gz
gzip -c maps/nevada/aadt.geojson       > maps/nevada/aadt.geojson.gz
gzip -c maps/nevada/hpms.geojson       > maps/nevada/hpms.geojson.gz
gzip -c maps/nevada/rtcsnv_facilities.geojson \
                                       > maps/nevada/rtcsnv_facilities.geojson.gz
```

## 2. OSM-derived inputs

```bash
python3 scripts/build_osm.py \
  --src data/nevada-latest.osm.pbf --out maps/nevada/bikeinfra.geojson
python3 scripts/build_places.py \
  --src data/nevada-latest.osm.pbf --out maps/nevada/places.json
python3 scripts/build_routes.py \
  --src data/nevada-latest.osm.pbf \
  --bounds=-120.2,34.9,-113.9,42.1 \
  --out maps/nevada/bikeroutes.geojson

gzip -c maps/nevada/bikeinfra.geojson      > maps/nevada/bikeinfra.geojson.gz
gzip -c maps/nevada/bikeroutes.geojson     > maps/nevada/bikeroutes.geojson.gz
gzip -c maps/nevada/route_closures.geojson > maps/nevada/route_closures.geojson.gz
```

`build_routes.py` emits both the bicycle-route overlay and the route-closure
collection; `--bounds` is required, because its default is Washington's.

No `scripts/merge_route_sources.py` step: Nevada adds no reviewed non-OSM route
source, so OSM's relations are the whole route catalogue.

## 3. Road tiles

```bash
rm -f data/nevada-roads-*.geojson       # stale shards are baked in silently

python3 scripts/build_roads.py \
  --src data/nevada-latest.osm.pbf \
  --region maps/nevada/region.json \
  --out-prefix data/nevada-roads \
  --urban-areas data/census-urban-areas-2020-nevada.geojson \
  --blts maps/nevada/blts.geojson \
  --roadlog "" \
  --funcclass maps/nevada/funcclass.geojson \
  --aadt maps/nevada/aadt.geojson \
  --hpms maps/nevada/hpms.geojson \
  --facilities maps/nevada/rtcsnv_facilities.geojson

tippecanoe -o maps/nevada/roads.pmtiles -l roads --force -Z5 -z13 \
  --drop-densest-as-needed --coalesce --extend-zooms-if-still-dropping \
  --simplification=8 --simplify-only-low-zooms --read-parallel \
  data/nevada-roads-*.geojson
```

`--simplify-only-low-zooms` is required, not a preference: the app draws these
tiles far past z13, so whatever z13 keeps is what a rider sees at full zoom.

`--roadlog ""` because Nevada publishes no county road inventory. No board is
required to certify one and none was found; NDOT's `StatewideRoutes`,
`FSystem` and `OwnershipMaintenance` reach local streets with identity, class
and owner, and carry no width, edge space or surface.

## 4. Overlay tiles

```bash
python3 scripts/build_overlay_tiles.py --state nevada
node scripts/build_compressed_overlays.mjs nevada
```

**Pass the state.** Run bare, `build_compressed_overlays.mjs` walks the whole
registry and rewrites *every* state's committed `.gz` overlays — during this
import it left Oregon's and Washington's modified in `git status`, byte-different
with identical content. The bare form is for a change to the overlay format that
genuinely should touch every state.

## 5. Basemap

```bash
python3 scripts/build_basemap.py \
  --src data/nevada-latest.osm.pbf \
  --places maps/nevada/places.json \
  --natural-earth-land data/natural-earth/ne_10m_land.shp \
  --bounds=-120.2,34.9,-113.9,42.1 \
  --coastline natural-earth \
  --out maps/nevada/basemap.pmtiles
```

`--coastline natural-earth` because Nevada is landlocked. The `osm` default
assumes a west-coast state: it takes the longest open coastline as the
Pacific-facing mainland and closes the land polygon eastward, which has nothing
to work with here.

## 6. Routing graph

```bash
python3 scripts/build_graph.py \
  --src data/nevada-latest.osm.pbf \
  --region maps/nevada/region.json \
  --out maps/nevada/graph2.bin.gz \
  --blts maps/nevada/blts.geojson \
  --restrictions "" \
  --legal-speeds maps/nevada/ndot_speed.geojson \
  --facilities maps/nevada/rtcsnv_facilities.geojson \
  --urban-areas data/census-urban-areas-2020-nevada.geojson \
  --roadlog "" \
  --funcclass maps/nevada/funcclass.geojson \
  --aadt maps/nevada/aadt.geojson \
  --hpms maps/nevada/hpms.geojson
```

`--restrictions ""` because Nevada publishes no permanent bicycle-prohibition
inventory: its prohibitions are posted per segment rather than inventoried, and
neither NDOT ArcGIS server carries a bicycle-access layer. OSM's `bicycle=no`
carries 5,892 ways here and is the whole signal.

No `patch_graph_*.py` steps: those three read Washington-specific inputs.

## 7. Stamps and the registry

```bash
node scripts/stamp_tiles_version.mjs nevada
npm run maps:registry
```

`build_graph.py` stamps `versions.graph` itself. `versions` is what makes a
rider's service worker fetch a rebuilt file, so neither is optional.

## 8. Check

```bash
npm test corridor_severance      # the stage-5 gate, on Nevada's corridors
npm test                         # everything
python3 scripts/measure_coverage.py --add maps/nevada/hpms.geojson --label HPMS
node scripts/audit_route.mjs maps/nevada/audit/routes.json maps/nevada/audit
```

## Provenance

| File | Source | Built by |
| --- | --- | --- |
| `graph2.bin.gz` | OSM + NDOT ALRS + RTC Southern Nevada + FHWA HPMS + AWS Terrarium DEM | `build_graph.py` |
| `roads.pmtiles` | OSM + NDOT inventory + class/owner + AADT + HPMS + RTC facilities | `build_roads.py` + tippecanoe |
| `basemap.pmtiles` | OSM + Natural Earth 1:10m land + `places.json` | `build_basemap.py` |
| `overlays.pmtiles` | `bikeinfra.geojson.gz` + `blts.geojson.gz` | `build_overlay_tiles.py` |
| `blts.geojson[.gz]` | NDOT ALRS ShoulderOutside / SpeedLimit / AccessControl / ThroughLane | `tools/build_ndot.py` |
| `ndot_speed.geojson[.gz]` | NDOT ALRS SpeedLimit | `tools/build_ndot.py` |
| `funcclass.geojson[.gz]` | NDOT ALRS FSystem joined to OwnershipMaintenance | `tools/build_ndot.py` |
| `aadt.geojson[.gz]` | NDOT ALRS AADT (measured, with count dates) | `tools/build_ndot.py` |
| `hpms.geojson[.gz]` | FHWA HPMS public release, Nevada 2018 | `scripts/build_hpms.py` |
| `rtcsnv_facilities.geojson[.gz]` | RTC of Southern Nevada HUB layers 8/9/10 | `tools/build_rtcsnv.py` |
| `bikeinfra.geojson[.gz]` | OSM cycleways, paths, on-street lanes | `scripts/build_osm.py` |
| `bikeroutes.geojson[.gz]` | OSM `route=bicycle` relations | `scripts/build_routes.py` |
| `route_closures.geojson[.gz]` | OSM route relations, extracted | `scripts/build_routes.py` |
| `places.json` | OSM settlements | `scripts/build_places.py` |

Licences: OpenStreetMap contributors (ODbL); NDOT, RTC of Southern Nevada and
FHWA data are public records; Natural Earth is public domain.
