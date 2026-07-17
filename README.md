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
- Five independent **data-source toggles**:
  - *Designated routes (USBR & regional)* — a dashed blue corridor beneath
    the scored road or facility verdict.
  - *WSDOT BLTS (state highways)* — one rating per state-highway segment.
  - *OSM bike infrastructure* — cycleways, bike lanes, shared paths/trails.
  - *Bikes prohibited (WSDOT)* — official permanent restrictions for
    inspection; these edges are excluded from routing.
  - *All roads (OSM, est. speeds)* — the full public drivable network
    (~324k ways). On by default and automatically decluttered when zoomed out.
    Missing speed limits are estimated from road class and labeled as estimates
    in the readout.
- One verdict system on the background network and planned route: yellow-lime
  = a physical bike facility that passes, dashed blue = a designated bicycle
  route that passes, solid blue = another road that passes, orange = bike-legal
  limited-access caution, red **dashed** = fails / unavailable, and gray =
  insufficient data. Off-street paths/trails use a lime line with a fine
  dotted center, while on-street bike accommodations are solid. A failing
  portion of a planned route pulses dark red.
- **Riding rules** — controls that re-score and re-color the map **live,
  client-side, with no refetch**. Each is a HARD gate: a road fails (avoid) if
  the data we have shows a criterion isn't met (missing data isn't held against
  a road):
  - *Allow freeway as last resort* — freeways always fail the rules and carry
    a very large routing penalty; turn this off to exclude them entirely.
  - *Treat designated bike routes as vetted* — by default, a USBR or regional
    designation satisfies the shoulder rule; turn this off to apply the same
    speed and shoulder limits as every other road.
  - *Min shoulder width* — a known shoulder under this fails a road.
  - *"Free" max speed* — at/below this, the road passes regardless of shoulder.
  - *Upper max speed* — above this a road fails (unless *No upper limit*).
  - *No upper limit* — don't fail roads on speed alone.
- Hover any segment for a **local readout** — the same color/verdict wording as
  the legend, a plain-language *why*, and the raw attributes. No lookups.
  On touch screens, tap a road instead; tap empty map to dismiss.
- **PWA / offline**: installable ("Add to Home Screen" on iOS). A service
  worker caches the app shell and data files after first use — the map works
  offline (basemap tiles are cached for areas you've already viewed). The
  shell is network-first, so deploys still update instantly when online.
- **Location aware**: a geolocate control centers the map on you and can
  follow along (blue dot + heading) — handy mid-ride.
- **Foreground turn-by-turn navigation**: Start navigation on a planned route
  for GPS progress, spoken approaching-turn prompts, and an on-route position
  marker. The app requests a Screen Wake Lock while active where the browser
  supports it. This keeps the screen awake; reliable background navigation is
  a native-app feature, not a PWA guarantee.
- **Mobile layout**: a hideable bottom sheet with three tabs (Route / Layers /
  Settings); the floating route-editing bar works without opening the sheet.

## Architecture

`app.js` is source-agnostic:

- **Sources** live in a registry (`SOURCES`). Each has its own toggle, layers,
  and **scorer** (`scoreBLTS`, `scoreOSM`).
- A **scorer** maps a source's raw properties to *normalized* props:
  `baseScore`, `shoulder_width`, `maxspeed_num`, `prohibited`, `freeway`,
  `limited_access`, `good_facility`, `infra`.
- **`effectiveLevel(normalized)`** is the single function that turns normalized
  props + the current riding rules into an internal effective level: **1**
  (lower-stress pass), **2** (other pass), **3** (limited-access caution that otherwise meets
  criteria), **4** (fails / avoid), or **0** (no data). Dedicated bike
  infrastructure (`infra: true`) is rated by its type (cycleway = 1, bike lane
  = 2); shared-with-traffic roads go through the hard speed/shoulder/freeway
  gates. Re-scoring runs over cached features and updates the map source in
  place — instant, no network.

Each scored source gets a solid verdict layer plus a red-dashed level-4
overlay. The two passing levels remain distinct for routing costs but share the
same blue map verdict unless the edge has a physical bike facility, which is
lime. Off-street bicycle paths and trails use a dotted-center lime line;
on-street accommodations remain solid. Designated routes get a dashed blue ribbon below
the verdict layer, so their useful corridor context remains recognizable
without implying that designation alone is infrastructure or masking caution
or failure.

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
is no-data. Limited-access segments (`AccessControlTypeCode` F/M/P) are shown
as an orange caution when their recorded speed and shoulder otherwise meet the
rider's rules. They are distinct from true OSM motorways/freeways, which drive
the freeway toggle and remain last-resort route failures.

### WSDOT Permanent Bike Restrictions → `data/bike_restrictions.geojson` (81 segments)

```bash
curl -o data/PermanentBikeRestrictions.zip \
  https://data.wsdot.wa.gov/geospatial/DOT_ActiveTransportation/PermanentBikeRestrictions.zip
unzip -d data/permbike data/PermanentBikeRestrictions.zip
python3 scripts/build_restrictions.py
```

Official State Traffic Engineer calendar actions prohibiting bicycles on
specific state-highway segments (route + milepost ranges + direction). Shown
as an always-on-top red-dashed overlay—the same verdict used for any failing
road—and joined into `blts.geojson` at
build time: `build_blts.py --restrictions`
flags BLTS segments whose milepost range overlaps a restriction as
`Prohibited` so they hard-fail scoring. The join matches mainline
RouteIdentifier and ignores direction (over-flags the opposite direction —
conservative for safety). The routing graph also matches this authoritative
restriction linework directly and excludes those edges in every routing mode;
it never treats a permanent prohibition as a cost tradeoff.

### WSDOT legal speeds and bicycle facilities → routing graph

```bash
python3 scripts/fetch_wsdot_graph_data.py
```

This reproducible fetch reads two official WSDOT ArcGIS FeatureServer layers:
Roadway Characteristic Data (legal speed limits) and Active Transportation
Data (existing shared lanes, bike lanes, buffered lanes, separated lanes, and
shared-use paths). The downloaded GeoJSON files are build inputs and are
git-ignored; their source URLs and fetch time are recorded in each file.

The graph builder spatially conflates those attributes onto OSM topology.
Legal speeds override OSM/class estimates on matched state-road edges. Bicycle
facility types remain distinct, so a shared-lane marking does not substitute
for a shoulder, a conventional/buffered lane does, and a separated lane or
shared-use path is treated as protected infrastructure. Matching uses several
points along each edge plus route-number checks where available to reject
nearby crossings and frontage roads. WSDOT linework enriches OSM edges rather
than creating duplicate graph edges, preserving OSM intersection connectivity.

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
`app.js`. Explicit mountain-bike paths (`mtb:*`, including IMBA scale tags)
and members of OSM `route=mtb` relations are retained with an MTB marker. The
app hides and excludes them by default, but can make them available through
the rider-controlled **Allow mountain bike trails** option.

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
Route tab's settlement/ferry search works fully offline, with online OSM place
search when connected. Start, destination, and intermediate stops all support
the same search-or-tap picker (A → B → C via the + button), and a route can
start at the rider's current location.

### Routing graph → `data/graph2.bin.gz` (elevation-aware)

```bash
# one-time: fetch the WA DEM (AWS Terrarium elevation tiles, z12 ≈ 38 m)
bash scripts/fetch_dem.sh
# refresh official WSDOT legal-speed and existing-facility build inputs
python3 scripts/fetch_wsdot_graph_data.py
python3 scripts/build_graph.py --src data/washington-latest.osm.pbf
# Conservative final passes over the authoritative WSDOT linework. They are
# idempotent and catch a few very-close matches that the build-time conflation
# deliberately leaves alone.
python3 scripts/patch_graph_limited_access.py --apply
python3 scripts/patch_graph_prohibited.py --apply
```

A compact BGR7 binary graph (nodes at intersections plus graph-only nodes at
roughly 120 m intervals on dedicated paths, so a point placed on a long trail
snaps to that trail; edges carry length,
climb/descent sampled every 60 m from the DEM, the original OSM road class,
speed — official WSDOT legal speed, OSM-posted, or class-estimated — typed
bicycle facility, authoritative-source bits, freeway/limited-access/
infrastructure flags, shoulder from WSDOT conflation or OSM, and directional
curve-warning severity/range). Pedestrian-only and `bicycle=dismount` ways are
not included in the riding graph. Short `highway=service` links are treated as
bike infrastructure only when they are explicitly `bicycle=designated` and
closed to public motor traffic; this preserves mapped trail links through
transit centers and maintenance plazas without admitting ordinary driveways.
A directional
possible limited-visibility uphill-curve warning is inferred from overlapping
curve geometry and uphill grade, then adjusted for speed, shoulder, and
facility; it is explicitly a proxy rather than measured sight distance.
WSDOT `LimitedAccess` is carried into
a separate caution flag, even when OSM does not classify the road as a
motorway; it is routable when its speed and shoulder meet the rules. OSM
motorways remain the graph's true freeway flag. One-way streets honored; `bicycle=no` and
WSDOT-restricted ways excluded entirely. **Ferries** (`route=ferry` with bikes
allowed) are included with their crossing duration plus a configurable typical
boarding wait. The builder does not invent pedestrian or straight-line dock
connections; a ferry is routable only where OSM supplies a bicycle-legal link
to the riding graph. At runtime, tertiary/secondary/primary/trunk classes without a
recorded bike facility receive increasing soft costs as a traffic-volume proxy;
they remain routable and do not become rule failures. The full set of soft
costs is exposed under Settings → Weights (adv.) and can be reset to defaults.
Explicitly mountain-bike-tagged paths remain in the graph with a separate
marker: they are unavailable by default, and when enabled carry a substantial
soft cost and are reported in Route Details.
Ferry speed derives from the OSM `duration` tag, a typical terminal wait is
charged when boarding from land, ferry legs never count against the riding
rules, and the route card calls out ferry mileage (the leg draws dashed on the
map).

The app routes **fully client-side**: A* in a web worker over estimated riding
TIME (a grade-aware speed model). Each request probes a matrix of direct,
balanced, and low-stress costs with and without bike-route and residential
preferences. Near-duplicates and dominated choices are removed, leaving up to
five useful alternatives labeled **Route A–E**. Route A is always selected by
default and is the safest candidate that stays within a practical per-leg
detour of the quickest result; the other letters are meaningfully different
options without implying a fixed fastest-to-safest scale. Each selected route
shows a compact ride mix: the share of riding distance on physical bike
trails and lanes (lime on the map, with matching legend swatches) and the
shares that pass, need caution, or fail the current rules. The trails/lanes
share overlaps those verdict shares. The letters identify alternatives and are not grades. On routes with stops, candidate
selection also checks detours leg by leg and keeps at most one extreme-detour
result. This keeps a small concern near one stop from filling the choices with
large local loops.
Limited-access roads that meet the rider's speed and shoulder rules remain
preferable to known rule violations. Among roads with a missing or zero
shoulder, those below the rider's “Max speed without shoulder” setting receive
a soft routing preference: modestly in Direct, more strongly in Balanced, and
strongest in Friendly mode. This bonus never changes a road’s safety verdict
or penalizes an otherwise acceptable road solely because its shoulder is
unknown. Settings can force the bike-route or residential preference across
every candidate.
Results include distance, duration, total climb/descent, and an elevation
profile. No routing server; works offline once cached.

## Vendored library

`vendor/maplibre-gl.{js,css}` is MapLibre GL JS v4.7.1, vendored locally so the
app is fully self-contained (the only third-party runtime request is the CARTO
basemap tiles).
