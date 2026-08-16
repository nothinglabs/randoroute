# Washington Bike Safety Visualizer

A statewide bicycle-safety map for Washington State. It colors roads and bike
infrastructure by how stressful they are to ride, from three local data sources:
**WSDOT Bicycle Level of Traffic Stress (BLTS)** for state highways,
**OpenStreetMap** for dedicated bike infrastructure, and the **full OSM road
network** (every public drivable road, with speeds inferred from road class
where OSM has no `maxspeed` tag — the approach pioneered by PeopleForBikes'
Bicycle Network Analysis).

**Everything runs on the device** — visualization, vector basemap, labels, and
routing. All core map and routing data is baked into local static files at
build time; the runtime is any static file server or the self-contained
Capacitor iOS app. Online place search and Google Street View remain optional.

## Run it

Use the included local server—it supports the HTTP byte ranges required by the
local basemap and roads PMTiles archives:

```bash
python3 scripts/serve.py
# then open http://localhost:8000/
```

## Native iOS

```bash
npm install
npm run ios:sync
npm run ios:open
```

`ios:sync` assembles the complete web runtime and statewide data into
`mobile-shell/` before copying it into the Xcode project. The current payload
is about 151 MB uncompressed and has no GitHub Pages or online-basemap runtime
dependency. `mobile-shell/` is generated — never edit it by hand.

**Read `docs/IOS-HANDOFF.md` before touching the native code.** The only
native-only file is `ios/App/App/BridgeViewController.swift`; everything else is
the shared web app that `npm test` covers. The handoff lists changes that were
made without a Swift compiler available and still need a build, two known bugs
left deliberately unfixed, and the parts that only a device can judge.

## Features

- **MapLibre GL JS** map of Washington with a compact local vector basemap:
  land, water, parks, street geometry, street names, and place labels all work
  without a tile server.
- Five independent **data-source toggles**:
  - *Designated routes (USBR & regional)* — a dashed olive-green band beneath
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
  = a physical bike facility that passes, solid blue = another road that
  passes, amber = caution (limited access, dismount, sidewalk fallback, and
  other causes — the in-app help lists them, generated from the safety model),
  red **dashed** = fails / unavailable, and gray = insufficient data. A dashed
  olive-green band beneath a road marks a designated bicycle route — context,
  never a verdict. Off-street paths/trails use a lime line with a fine
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
  - *Speed limit is over* — above one statewide rider-selected speed, a road
    must offer a sufficiently wide shoulder or a bike lane. Census area context
    does not change the limit.
  - *Allow sidewalk fallback* — a mapped sidewalk can meet the shoulder rule
    as an amber, strongly-deprioritized fallback. It does not bypass bicycle
    restrictions, freeways, or the upper-speed limit.
  - *Upper max speed* — above this a road fails (unless *No upper limit*).
  - *No upper limit* — don't fail roads on speed alone.
- Hover any segment for a **local readout** — the same color/verdict wording as
  the legend, a plain-language *why*, and the raw attributes. No lookups.
  On touch screens, tap a road instead; tap empty map to dismiss.
- **PWA / offline**: installable ("Add to Home Screen" on iOS). A service
  worker precaches the app shell and complete statewide map/routing archives,
  then serves PMTiles byte ranges from that local cache. After installation
  finishes, the whole supported area works offline—not only places previously
  viewed. App releases remain internally consistent until an update is ready.
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
on-street accommodations remain solid. Designated routes get a dashed
olive-green band below the verdict layer, so their useful corridor context
remains recognizable without implying that designation alone is
infrastructure or masking caution or failure.

## Data (build-time)

All data files are baked from public sources and committed. The raw
downloads are git-ignored.

Everything a state ships lives in `maps/<state>/`, alongside a `region.json`
holding that state's whole configuration and a `STATUS.md` / `BUILD.md` pair
recording how good the data is and exactly how it was produced. No file outside
`maps/` names a state; `region.js` resolves whichever one the rider selected on
**Settings → Maps** and every data path in the app, the router worker and the
service worker is built from it. See **`maps/README.md`** for how the folder
works and **`docs/PORTING-TO-ANOTHER-STATE.md`** for adding one.

Washington is the only state that ships today. `maps/README.md` carries the
readiness rubric a new state is scored against, and the app degrades honestly
for a partial one: a state that ships only a place index says so rather than
404ing its way through a startup.

The sections below describe Washington's sources; `maps/washington/BUILD.md` is
the same thing as a runbook.

### WSDOT BLTS → `maps/washington/blts.geojson` (~55k segments)

```bash
curl -o data/BikePedLTS.zip \
  https://data.wsdot.wa.gov/geospatial/DOT_ActiveTransportation/BikePedLTS.zip
unzip -d data data/BikePedLTS.zip
pip install geopandas pyogrio pyproj shapely
python3 scripts/fetch_census_urban_areas.py
python3 maps/washington/tools/build_blts.py --src data/BikePedLTS.gdb --out maps/washington/blts.geojson
```

Source: WSDOT "Bicycle and Pedestrian Level of Traffic Stress (LTS)" (File
Geodatabase, EPSG:2927 → reprojected to 4326). `LTS_Bicycle` (1–4); `999`/missing
is no-data. Limited-access segments (`AccessControlTypeCode` F/M/P) are shown
as an amber caution when their recorded speed and shoulder otherwise meet the
rider's rules. They are distinct from true OSM motorways/freeways, which drive
the freeway toggle and remain last-resort route failures.

The build also assigns `Urban=1` when a segment midpoint lies in a 2020 Census
urban-area polygon. This is retained as descriptive context on road cards; it
does not select a different shoulder or speed rule.

### WSDOT Permanent Bike Restrictions → `maps/washington/bike_restrictions.geojson` (81 segments)

```bash
curl -o data/PermanentBikeRestrictions.zip \
  https://data.wsdot.wa.gov/geospatial/DOT_ActiveTransportation/PermanentBikeRestrictions.zip
unzip -d data/permbike data/PermanentBikeRestrictions.zip
python3 maps/washington/tools/build_restrictions.py
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

### OSM bike infrastructure → `maps/washington/bikeinfra.geojson` (~40k ways)

```bash
curl -o data/washington-latest.osm.pbf \
  https://download.geofabrik.de/north-america/us/washington-latest.osm.pbf
pip install osmium
python3 scripts/build_osm.py --src data/washington-latest.osm.pbf \
                             --out maps/washington/bikeinfra.geojson
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

### Full road network → `maps/washington/roads.pmtiles` (~339k ways, vector tiles)

```bash
python3 scripts/fetch_census_urban_areas.py
# Statewide road measurements. Each pages an ArcGIS service and caches pages
# under data/.cache, so an interrupted run resumes rather than restarting.
python3 maps/washington/tools/build_roadlog.py     # CRAB county road log, 115,582 segments
python3 maps/washington/tools/build_funcclass.py   # WSDOT non-state functional class
python3 maps/washington/tools/build_aadt.py        # WSDOT traffic counts, state routes
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
rm data/roads-*.geojson  # intermediate
python3 scripts/build_overlay_tiles.py  # bike-infrastructure + WSDOT BLTS overlay tiles
node scripts/stamp_tiles_version.mjs  # so installed PWAs refresh their offline copy
```

`build_overlay_tiles.py` turns `bikeinfra.geojson.gz` and `blts.geojson.gz`
into `maps/washington/overlays.pmtiles` (two layers, every attribute preserved -- the tap
cards re-score a tapped feature's raw properties). It applies the sharrow-only
drop at build time and prints the per-layer feature counts, which are baked
into `SOURCES` in app.js. The two `.geojson.gz` files stay in the repo as this
build's inputs; the app itself no longer fetches them.

`--simplify-only-low-zooms` is required, not a preference. The app draws these
tiles far past their z13 maximum, so whatever z13 keeps is what a rider sees at
full zoom; simplifying there is simplifying the final picture. Without it,
`--simplification=8` works out to a tolerance of roughly 26 m at z13 and erases
anything smaller, which put Washington's traffic circles back on the map as
spikes even after the vertex reduction above was fixed — measured at 8.0 x 2.3 m
instead of 8.0 x 8.0 m for the Dayton Avenue North circle. Keeping maxzoom
unsimplified cost 1.2% (+0.4 MB) of archive size.

Same Geofabrik extract. Keeps `motorway`..`tertiary` (+links), `unclassified`,
`residential`, `living_street`; excludes `service`/`track` and
`access=private/no`. Where OSM has no usable `maxspeed`, a class-based default
is baked in (e.g. residential → 25 mph) and flagged `e=1` so the UI shows
it as estimated. State-highway shoulder, speed, facility, restriction, and
limited-access facts are conflated onto the matching OSM road centerline.
WSDOT's two inventory directions are combined conservatively for this neutral
background display, avoiding overlapping pass/fail lines; the routing graph
below retains each direction separately.

Vertex reduction never applies to a closed ring, and never exceeds an eighth of
an open way's own extent. A fixed ~5 m tolerance used to be applied to
everything, which erased any feature smaller than the tolerance itself:
Washington's traffic circles collapsed to triangles and there-and-back spikes
(3,125 of 4,486 rings kept four or fewer distinct points) and drew on the map as
arrowheads sitting in the intersection. `scripts/test_road_geometry.py` guards
this with the surveyed Dayton Avenue North circle. Both this stage and the
tippecanoe flags above have to be right: either one alone still loses the
circles, so a rebuild needs the current `build_roads.py` *and* the current
tiling command.

The build also records compact OSM sidewalk state (`k`) and 2020 Census urban
area context (`u`). Sidewalk state participates in the optional sidewalk
fallback; Census area is descriptive context and does not change the rider's
single no-shoulder speed limit.

Served as **PMTiles** — a single static vector-tile file read via HTTP range
requests (no tile server). The browser fetches only the small tiles in view,
so this layer no longer parses ~78 MB of GeoJSON in the page (which crashed
iOS Safari). It is scored with **MapLibre expressions** (`roadLevelExpr` in
`app.js`): a rule change just swaps paint/filter expressions — instant at any
data size, GeoJSON or tiles.

### Offline vector basemap → `maps/washington/basemap.pmtiles`

```bash
python3 scripts/build_basemap.py \
  --src data/washington-latest.osm.pbf \
  --natural-earth-land data/natural-earth/ne_10m_land.shp
```

The 43 MB context archive contains clipped Natural Earth land plus OSM water,
waterways, parks/forests/wetlands, and the existing offline place index.
Street geometry and street names come from `roads.pmtiles`, so the basemap and
safety overlay share one decoded MapLibre source instead of loading duplicate
road tiles. The locally bundled Noto Sans glyph ranges render labels in both
the web/PWA and native iOS builds.

### Designated bike routes → `maps/washington/bikeroutes.geojson` (114 routes)

```bash
python3 scripts/build_routes.py --src data/washington-latest.osm.pbf
```

U.S. Bicycle Routes (USBR 10, 20, 87, 95, 97, …) and regional rail-trails
(Burke-Gilman, Centennial, Palouse to Cascades, …), extracted from OSM
`route=bicycle` relations (`network=ncn`/`rcn`; local greenways are skipped
as noise at state scale). Drawn as a dashed olive-green band *under* the
scoring layers — the designation is information, not a safety verdict. The readout
adds a "Bike route" line to any road a designated route follows. WSDOT
publishes these only as PDF maps; OSM carries the same designations as data.

### Offline place search → `maps/washington/places.json` (2,602 places)

```bash
python3 scripts/build_places.py --src data/washington-latest.osm.pbf
```

Settlements and ferry terminals from OSM, population-ranked, 122 KB — the
Route tab's settlement/ferry search works fully offline, with online OSM place
search when connected. Start, destination, and intermediate stops all support
the same search-or-tap picker (A → B → C via the + button), and a route can
start at the rider's current location.

### Routing graph → `maps/washington/graph2.bin.gz` (elevation-aware)

```bash
# one-time: fetch the WA DEM (AWS Terrarium elevation tiles, z12 ≈ 38 m)
bash scripts/fetch_dem.sh washington
# refresh official WSDOT legal-speed and existing-facility build inputs
python3 scripts/fetch_wsdot_graph_data.py
# fetch 2020 Census urban-area polygons (build input; not committed)
python3 scripts/fetch_census_urban_areas.py
python3 scripts/build_graph.py --src data/washington-latest.osm.pbf
```

A compact BGR9 binary graph (nodes at intersections plus graph-only nodes at
roughly 120 m intervals on dedicated paths, so a point placed on a long trail
snaps to that trail; edges carry length,
climb/descent sampled every 60 m from the DEM, the original OSM road class,
speed — official WSDOT legal speed, OSM-posted, or class-estimated — compact
OSM surface category (paved, gravel/compacted, rough unpaved, or unknown), typed
bicycle facility, authoritative-source bits, freeway/limited-access/
infrastructure flags, shoulder from WSDOT conflation or OSM, compact OSM
sidewalk state, Census urban-area context, and directional
curve-warning severity/range). WSDOT increasing/decreasing inventory records
are stored as directional speed, shoulder, prohibition, and limited-access
attributes, so opposite sides of a state highway can correctly receive
different routing verdicts without being painted as two physical roads.
Pedestrian-only and `bicycle=no` ways are not
included in the riding graph. `bicycle=dismount` ways are retained as
walk-bike connectors: the router charges walking time plus a strong per-entry
cost and reports them as dismount points. Short `highway=service` links are treated as
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
six useful alternatives labeled **Route A–F**, ordered from shortest to
longest. One candidate is searched under a "more direct" lens (the same
flattening the route-mix menu applies), so a quicker-but-bolder corridor
reaches the lineup without the rider asking for it. Among practical candidates the app stars the one with the best
priced balance — riding time plus a heavy price on rule-failing and dismount
meters and a light price on ordinary riding without a bike facility — so the
recommended route may have any letter. For the life of a trip each letter
stays bound to the same kind of route: adjusting waypoints or road blocks
keeps the lineup, while changing start or destination (reversing included) or
picking a different mix from the ⚙︎ route-options menu deals a new one (the
same menu can turn off routes that use ferries); loading a discarded
candidate from the Considered-routes screen can add letters past E. Each selected route
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
profile. No routing server; the native app works immediately offline and the
installed PWA works offline after its initial data installation completes.

## Rebuilding the traffic-stress data

**Status: shipped, data included.** Lane counts and WSDOT traffic-stress
ratings are live end to end — the shipped `maps/washington/graph2.bin.gz` (format
`BGRC`) carries populated `edgeLanes`/`edgeLts` arrays (376k edges with lane
counts, 180k with an LTS rating), and `maps/washington/roads.pmtiles` carries the
`ln`/`adt`/`ctl` properties behind the road card. This section stays as the
recipe for the NEXT data refresh.

Background for the design: Seattle signed every arterial at 25 mph in 2020,
so speed no longer separates a five-lane arterial from the side street beside
it. Lane count still does, and OSM tags it on ~100% of `secondary` against
3-5% of `residential` — present exactly where it matters. WSDOT separately
publishes a finished `LTS_Bicycle` rating (1-4) in `maps/washington/blts.geojson`.

### What to run

Both archives, from the same extract, in this order:

```bash
# 1. Routing graph -- writes the current format (magic 'BGRC', format 12)
python3 scripts/build_graph.py --src data/washington-latest.osm.pbf

# 2. Road tiles -- adds the `ln`/`ctl` properties behind the road card
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
```

`--simplify-only-low-zooms` is mandatory — see the road-network section above
for what happens without it.

### Then bump every version, or riders keep the old data

```
app.js            APP_VERSION; GRAPH_FORMAT_VERSION only if the LAYOUT changed
app.js            roads.pmtiles?v=          <- and the SAME number in
basemap-style.js  roads.pmtiles?v=             both files
sw.js             VERSION, DATA_CACHE, route-details.{js,css}?v=
route-details.html  route-details.{js,css}?v=
version.json      version
```

`GRAPH_FORMAT_VERSION` is what stops a just-updated worker from being handed a
graph cached by an older service worker; bumping it is not optional.

### Verify before committing

```bash
python3 scripts/test_graph_format10.py   # layout + reader-offset contract
node scripts/test_road_measures.mjs      # Python packs, JavaScript unpacks
node scripts/test_card_model_shared.mjs  # both cards read one adapter
python3 -c "import gzip;print(gzip.open('maps/washington/graph2.bin.gz','rb').read(4))"
#   -> b'BGRC'   (an older magic means build_graph.py did not pick up the change)
tippecanoe-decode maps/washington/roads.pmtiles 13 1311 2858 | grep -c '"ln"'
#   -> non-zero  (lane counts reached the tiles)
tippecanoe-decode maps/washington/roads.pmtiles 13 1311 2858 | grep -c '"adt"'
#   -> non-zero  (traffic counts reached the tiles)
```

Then run `npm test` — the whole suite, concurrently, in about sixteen
minutes. `test_route_portfolio.mjs` is the one that matters most: it catches
a scoring change that severs a corridor. `npm test <substring>` runs a subset.

Tests that need a build tool the machine lacks report `SKIP`, not `PASS`; on a
checkout without tippecanoe that is `test_basemap_coastline.py` and
`test_directional_road_tiles.py`. The data tests need `pip install shapely
osmium Pillow`, and the forty-two browser tests need Playwright.

Expect `graph2.bin.gz` to grow by roughly 6 bytes per edge before compression
for the format-11 measurement arrays; measured, that was 556 KB compressed
(31.34 -> 31.89 MB over 856k edges).

### Notes for whoever does this

- **Old graphs keep working.** `router-worker.js` accepts `BGR9`, `BGRA`,
  `BGRB` and `BGRC`; each format only ever appends, so on an older graph the newer arrays
  read as null, every value reports as "not known", and scoring is what it was.
  A rider is never stranded on the copy already cached on their phone.
- **The scoring is a soft cost, never a rule failure.** Four lanes with a
  protected bike lane is genuinely fine, and hard gates risk severing corridors
  the way earlier bugs did. A missing `lanes` tag means "small road", not
  "unproven", and must leave scoring untouched.
- `scripts/patch_graph_*.py` are stale migration tools that only understand up
  to BGR8. They already reject the shipped graph and are not part of any
  rebuild — leave them alone.
- After deploying, tap a segment of 15th Ave NE in Lake City: the road card
  should show **Lanes** and, on state highways, **Traffic stress**.

## Vendored library

`vendor/maplibre-gl.{js,css}` is MapLibre GL JS v4.7.1, vendored locally so the
app's core map and routing runtime is fully self-contained.
