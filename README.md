# Washington Bike Safety Visualizer

A statewide bicycle-safety map for Washington State. It colors roads and bike
infrastructure by how stressful they are to ride, from three local data sources:
**WSDOT Bicycle Level of Traffic Stress (BLTS)** for state highways,
**OpenStreetMap** for dedicated bike infrastructure, and the **full OSM road
network** (every public drivable road, with speeds inferred from road class
where OSM has no `maxspeed` tag — the approach pioneered by PeopleForBikes'
Bicycle Network Analysis).

**Everything runs in the browser** — visualization *and* routing, with no
servers and no live network queries beyond basemap tiles. All data is baked
into local static files at build time; the runtime is any static file server.

## Run it

Use the included local server — it supports the HTTP byte ranges required by
the optional all-roads PMTiles layer:

```bash
python3 scripts/serve.py
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
  - *Allow freeway as last resort* — freeways always fail the rules and carry
    a very large routing penalty; turn this off to exclude them entirely.
  - *Min shoulder width* — a known shoulder under this fails a road.
  - *"Free" max speed* — at/below this, comfortable regardless of shoulder.
  - *Upper max speed* — above this a road fails (unless *No upper limit*).
  - *No upper limit* — don't fail roads on speed alone.
- **Pass/fail mode** — an accessibility view that drops color discrimination:
  only roads meeting your criteria show (green); roads with data that fail show
  gray-dashed; no-data roads are hidden.
- Hover any segment for a **local readout** — the verdict (Pass/Fail), the
  stress level, a plain-language *why*, and the raw attributes. No lookups.
  On touch screens, tap a road instead; tap empty map to dismiss.
- **PWA / offline**: installable ("Add to Home Screen" on iOS). A service
  worker caches the app shell and data files after first use — the map works
  offline (basemap tiles are cached for areas you've already viewed). The
  shell is network-first, so deploys still update instantly when online.
- **Location aware**: a geolocate control centers the map on you and can
  follow along (blue dot + heading) — handy mid-ride.
- **Mobile layout**: a bottom sheet with three tabs (Route / Layers /
  Settings) — peek, half, and full heights; the floating A/B bar routes
  without opening the sheet at all.

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

All data files are baked from public sources and committed. The raw
downloads are git-ignored.

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

### WSDOT Permanent Bike Restrictions → `data/bike_restrictions.geojson` (81 segments)

```bash
curl -o data/PermanentBikeRestrictions.zip \
  https://data.wsdot.wa.gov/geospatial/DOT_ActiveTransportation/PermanentBikeRestrictions.zip
unzip -d data/permbike data/PermanentBikeRestrictions.zip
python3 scripts/build_restrictions.py
```

Official State Traffic Engineer calendar actions prohibiting bicycles on
specific state-highway segments (route + milepost ranges + direction). Shown
as an always-on-top overlay drawn with the same color coding as any failing
road (red dashed in ramp view, gray dashed in pass/fail — the readout
identifies it as a WSDOT restriction), and joined into `blts.geojson` at
build time: `build_blts.py --restrictions`
flags BLTS segments whose milepost range overlaps a restriction as
`Prohibited` so they hard-fail scoring. The join matches mainline
RouteIdentifier and ignores direction (over-flags the opposite direction —
conservative for safety).

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

### Full road network → `data/roads.pmtiles` (~324k ways, vector tiles)

```bash
python3 scripts/build_roads.py --src data/washington-latest.osm.pbf \
                               --out-prefix data/roads
tippecanoe -o data/roads.pmtiles -l roads --force -Z5 -z13 \
  --drop-densest-as-needed --coalesce --extend-zooms-if-still-dropping \
  --simplification=8 --read-parallel data/roads-1.geojson data/roads-2.geojson
rm data/roads-*.geojson  # intermediate
```

Same Geofabrik extract. Keeps `motorway`..`tertiary` (+links), `unclassified`,
`residential`, `living_street`; excludes `service`/`track` and
`access=private/no`. Where OSM has no usable `maxspeed`, a class-based default
is baked in (e.g. residential → 25 mph) and flagged `e=1` so the UI shows
"(estimated from class)".

Served as **PMTiles** — a single static vector-tile file read via HTTP range
requests (no tile server). The browser fetches only the small tiles in view,
so this layer no longer parses ~78 MB of GeoJSON in the page (which crashed
iOS Safari). It is scored with **MapLibre expressions** (`roadLevelExpr` in
`app.js`): a rule change just swaps paint/filter expressions — instant at any
data size, GeoJSON or tiles.

### Designated bike routes → `data/bikeroutes.geojson` (114 routes)

```bash
python3 scripts/build_routes.py --src data/washington-latest.osm.pbf
```

U.S. Bicycle Routes (USBR 10, 20, 87, 95, 97, …) and regional rail-trails
(Burke-Gilman, Centennial, Palouse to Cascades, …), extracted from OSM
`route=bicycle` relations (`network=ncn`/`rcn`; local greenways are skipped
as noise at state scale). Drawn as an orange ribbon *under* the scoring
layers — the designation is information, not a safety verdict. The readout
adds a "Bike route" line to any road a designated route follows. WSDOT
publishes these only as PDF maps; OSM carries the same designations as data.

### Offline place search → `data/places.json` (2,602 places)

```bash
python3 scripts/build_places.py --src data/washington-latest.osm.pbf
```

Settlements and ferry terminals from OSM, population-ranked, 122 KB — the
Route tab's search works fully offline. Routes support intermediate stops
(A → B → C via the + button) and can start at the rider's current location.

### Routing graph → `data/graph2.bin.gz` (elevation-aware)

```bash
# one-time: fetch the WA DEM (AWS Terrarium elevation tiles, z12 ≈ 38 m)
bash scripts/fetch_dem.sh
python3 scripts/build_graph.py --src data/washington-latest.osm.pbf
```

A compact binary graph (nodes at intersections; edges carry length, climb/
descent sampled every 60 m from the DEM, speed — posted, WSDOT-measured, or
class-estimated — facility/limited-access/infrastructure flags, and shoulder
from WSDOT conflation or OSM). One-way streets honored; `bicycle=no` and
WSDOT-restricted ways excluded entirely. **Ferries** (`route=ferry` with bikes
allowed — all WSF runs plus county and passenger-only ferries) are routable
crossings: speed derives from the OSM `duration` tag, a ~15-minute typical
terminal wait is charged when boarding from land, ferry legs never count
against the riding rules, and the route card calls out ferry mileage (the
leg draws dashed on the map).

The app routes **fully client-side**: A* in a web worker over estimated riding
TIME (a grade-aware speed model), in three modes — **Direct** (fastest, failing
roads allowed with a nudge), **Balanced** (failing roads cost 3× their time),
**Low-stress** (failing roads cost 30× — any reasonable detour wins, and when
some failing pavement is truly unavoidable the route still comes back with
those segments pulsing red instead of a refusal). A **"Strongly prefer bike
routes & trails"** option prices designated routes and dedicated trails at
half cost — worth riding up to ~2× the distance to stay on a Burke-Gilman
instead of parallel streets. Results include distance, duration, total
climb/descent, and an elevation profile. No routing server; works offline
once cached.

## Vendored library

`vendor/maplibre-gl.{js,css}` is MapLibre GL JS v4.7.1, vendored locally so the
app is fully self-contained (the only third-party runtime request is the CARTO
basemap tiles).
