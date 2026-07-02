# Washington Bike Safety Visualizer

A statewide bicycle-safety map for Washington State. It colors roads and bike
infrastructure by how stressful they are to ride, from three local data sources:
**WSDOT Bicycle Level of Traffic Stress (BLTS)** for state highways,
**OpenStreetMap** for dedicated bike infrastructure, and the **full OSM road
network** (every public drivable road, with speeds inferred from road class
where OSM has no `maxspeed` tag — the approach pioneered by PeopleForBikes'
Bicycle Network Analysis).

**Visualization only** — no routing, no route planning, no live network queries
at runtime. Everything renders from local static data files prepared ahead of
time. The whole runtime is a static file server handing out `index.html` +
the two GeoJSON files.

## Run it

Any static file server works — no build server, no tiling server:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/
```

## Features

- **MapLibre GL JS** map of Washington on a **CARTO Positron** raster basemap.
- Three independent **data-source toggles**:
  - *WSDOT BLTS (state highways)* — one rating per state-highway segment.
  - *OSM bike infrastructure* — cycleways, bike lanes, shared paths/trails.
  - *All roads (OSM, est. speeds)* — the full public drivable network
    (~324k ways). Off by default (large download). Missing speed limits are
    estimated from road class and labeled as estimates in the readout.
- Colorblind-friendly **blue → red** ramp (ColorBrewer RdYlBu): blue = meets
  your criteria, red **dashed** = fails / avoid.
- **Riding rules** — controls that re-score and re-color the map **live,
  client-side, with no refetch**. Each is a HARD gate: a road fails (avoid) if
  the data we have shows a criterion isn't met (missing data isn't held against
  a road):
  - *Allow freeways* — include limited-access highways or not.
  - *Min shoulder width* — a known shoulder under this fails a road.
  - *"Free" max speed* — at/below this, comfortable regardless of shoulder.
  - *Upper max speed* — above this a road fails (unless *No upper limit*).
  - *No upper limit* — don't fail roads on speed alone.
- **Pass/fail mode** — an accessibility view that drops color discrimination:
  only roads meeting your criteria show (green); roads with data that fail show
  gray-dashed; no-data roads are hidden.
- Hover any segment for a **local readout** — the verdict (Pass/Fail), the
  stress level, a plain-language *why*, and the raw attributes. No lookups.

## Architecture

`app.js` is source-agnostic:

- **Sources** live in a registry (`SOURCES`). Each has its own toggle, layers,
  and **scorer** (`scoreBLTS`, `scoreOSM`).
- A **scorer** maps a source's raw properties to *normalized* props:
  `baseScore`, `shoulder_width`, `maxspeed_num`, `prohibited`, `limited_access`,
  `good_facility`, `infra`.
- **`effectiveLevel(normalized)`** is the single function that turns normalized
  props + the current riding rules into an effective level: **1** (comfortable),
  **2** (meets criteria), **4** (fails / avoid), or **0** (no data). There is no
  "3". Dedicated bike infrastructure (`infra: true`) is rated by its type
  (cycleway = 1, bike lane = 2); shared-with-traffic roads go through the hard
  speed/shoulder/freeway gates. Re-scoring runs over cached features and updates
  the map source in place — instant, no network.

Each source gets three MapLibre line layers: the solid main layer, a red-dashed
`__vh` overlay (level 4 in ramp view), and a gray-dashed `__fail` overlay
(pass/fail view).

## Data (build-time)

Both GeoJSON files are baked from public sources and committed. Neither is
fetched at runtime. The raw downloads are git-ignored.

### WSDOT BLTS → `data/blts.geojson` (~55k segments)

```bash
curl -o data/BikePedLTS.zip \
  https://data.wsdot.wa.gov/geospatial/DOT_ActiveTransportation/BikePedLTS.zip
unzip -d data data/BikePedLTS.zip
pip install geopandas pyogrio pyproj shapely
python3 scripts/build_blts.py --src data/BikePedLTS.gdb --out data/blts.geojson
```

Source: WSDOT "Bicycle and Pedestrian Level of Traffic Stress (LTS)" (File
Geodatabase, EPSG:2927 → reprojected to 4326). `LTS_Bicycle` (1–4); `999`/missing
is no-data. Limited-access segments (`AccessControlTypeCode` F/M/P) drive the
freeway toggle.

### OSM bike infrastructure → `data/bikeinfra.geojson` (~40k ways)

```bash
curl -o data/washington-latest.osm.pbf \
  https://download.geofabrik.de/north-america/us/washington-latest.osm.pbf
pip install osmium
python3 scripts/build_osm.py --src data/washington-latest.osm.pbf \
                             --out data/bikeinfra.geojson
```

Source: Geofabrik Washington extract (already EPSG:4326). `build_osm.py` keeps
only ways that classify as real bike infrastructure — dedicated cycleways
(`highway=cycleway`), bike/shared paths (`highway=path/footway/bridleway` with
`bicycle=designated/yes`), and on-street lanes (`cycleway*` = `track/separated/
lane/shared_lane`). Plain sidewalks/footpaths with no bicycle acceptance are
dropped so we don't color noise. The keep/drop logic mirrors `scoreOSM` in
`app.js`.

### Full road network → `data/roads-*.geojson` (~324k ways)

```bash
python3 scripts/build_roads.py --src data/washington-latest.osm.pbf \
                               --out-prefix data/roads
```

Same Geofabrik extract. Keeps `motorway`..`tertiary` (+links), `unclassified`,
`residential`, `living_street`; excludes `service`/`track` (driveways, parking
aisles, logging roads) and `access=private/no`. Where OSM has no usable
`maxspeed`, a class-based default is baked in (e.g. residential → 25 mph) and
flagged `e=1` so the UI shows "(estimated from class)". Geometry is simplified
(~5 m) and properties use short keys; output is split into parts under
GitHub's 100 MB file limit — the app fetches `roads-1`, `roads-2`, … until a
part is missing.

Because this source has ~324k features, it is scored with **MapLibre
expressions** (`roadLevelExpr` in `app.js`) instead of the setData path — a
rule change just swaps paint/filter expressions, which is instant at any data
size.

## Vendored library

`vendor/maplibre-gl.{js,css}` is MapLibre GL JS v4.7.1, vendored locally so the
app is fully self-contained (the only third-party runtime request is the CARTO
basemap tiles).
