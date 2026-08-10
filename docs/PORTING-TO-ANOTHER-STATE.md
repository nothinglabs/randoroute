# Porting this to another state

Written for whoever — or whatever — finishes Oregon, and does the state after
that. It is a **method**, not a list of Washington URLs. The specific services
will differ; the shape of the problem does not.

Read `docs/SAFETY-MODEL.md` first for what the app decides and why. This file is
only about getting a new state's data into it.

---

## 0. The one folder to add

Everything about a state -- its data and its configuration -- lives in
**`maps/<state>/`**. Nothing outside that folder names a state. Adding one is:

```
maps/oregon/
  region.json     the whole configuration (see maps/README.md for every key)
  STATUS.md       what works, what does not, readiness out of 10
  BUILD.md        the exact commands that produced each file
  <the data>
```

then `npm run maps:registry`, which regenerates `maps/states.js` -- the index
the browser reads, because it cannot list a directory. The rider picks the
state on **Settings > Maps**; `region.js` resolves the choice into the global
`Region`, and every data path in the app, the router worker and the service
worker is built from `Region.dataUrl(...)`.

The configuration is the bounding box a place search filters against, where the
map opens, the agency name printed on every road card, the agency's own spelling
of its route ids and facility types, and -- importantly -- **which files you
actually built**:

```json
"bounds": { "minLon": -124.9, "maxLon": -116.8, "minLat": 45.5, "maxLat": 49.1 },
"defaultCenter": [-122.3321, 47.6062],
"stressAgency": "WSDOT",        // publishes the 1-4 Level of Traffic Stress
"restrictionAgency": "WSDOT",   // publishes permanent bicycle prohibitions
"speedAgency": "WSDOT",         // publishes legal speed limits
"interstateRoutePrefixes": [],  // if the agency hides the fact in its ids
"facilityLevels": {},           // the agency's vocabulary -> the shared 0-5
"routeDirectionSuffixes": {},   // how the agency spells a directional route
"datasets": { "graph": true, "places": true, ... }
```

`datasets` is what makes a partial port usable rather than broken. A state that
ships only `places.json` gets place search and says plainly that it cannot
route; no missing tile archive is added to the map style (a source whose URL
404s never finishes loading, and the app would hang on its launch screen), no
layer appears for data that is not there, and the service worker precaches only
what exists. Build what you can, declare exactly that, ship it as
`"status": "preview"`, and finish it later. `maps/oregon/` is a worked example
of exactly this.

`scripts/test_region_portable.mjs` serves the app a *different* state and checks
it follows: the map opens on the new centre, the coverage filter moves, the
cards name the new agency, and the new facility vocabulary is the one that
scores. `scripts/test_maps_states_screen.mjs` goes further and actually switches
states in a live browser. Run both and they will tell you whether anything is
still reaching around the config.

Note the bounding box is a rectangle and a state border usually is not.
Washington's reaches over the Columbia into Portland, deliberately: a few
unroutable Oregon search results are better than clipping Vancouver and
Longview. Size yours the same way.

What is NOT in `region.json`, because it is not state-specific: the safety
ladder, the routing cost model, the map styling, the weights. Those are in
`safety-model.js`, `router-worker.js` and `app.js` and should need no edits at
all. If a port finds itself changing one of them, that is worth a second look --
it usually means a state fact leaked into shared logic.

---

## 1. What already works everywhere

Do not re-solve these. They are national and Washington-agnostic:

| signal | source | note |
|---|---|---|
| road geometry and topology | **OSM** | the universal base; everything else enriches it |
| road class | **OSM `highway`** | present on 100% of ways |
| speed limit | **OSM `maxspeed`**, else a class default | flagged as estimated when inferred |
| urban / rural | **US Census urban areas** | a polygon test, already national |
| bicycle prohibition | **OSM `bicycle=no`** | a state authority may add more |
| traffic volume, arterials | **FHWA HPMS public release** | see below — this is the big one |

**FHWA HPMS is the single most portable source there is.** Every state DOT must
submit it annually and FHWA republishes it openly, one hosted feature service
per state:

```
https://geo.dot.gov/server/rest/services/Hosted/<State>_<year>_PR/FeatureServer/0
```

Same schema in every state: `aadt`, `f_system`, `ownership`, `through_lanes`,
`speed_limit`, `iri`, `surface_type`. For Washington that is 129,168 sections
with a count, including **23,413 city-owned ones** — the only source found
anywhere with traffic volume for city streets.

Its limits are also the same everywhere: it is federal-aid roads, so arterials
and major collectors only. In Washington it holds 1,355 minor-collector and 25
local-street sections for the entire state. Do not expect it to cover
residential roads, and do not treat its absence there as a data gap you can fix.

`scripts/build_hpms.py` needs only the state name and year changed.

---

## 2. Finding the state-specific sources

Three things worth knowing before starting, each of which cost real time here.

**Search at layer depth, not service names.** Island County's bike network lives
inside a service called `Bridge_to_Boat_v2` — named for the route it describes,
not its contents. No keyword search over service names finds it. Enumerate an
agency's ArcGIS org and read the *layers*.

Useful entry points:

```
https://www.arcgis.com/sharing/rest/search?q=<terms>&f=json&bbox=<state bbox>
https://www.arcgis.com/sharing/rest/search?q=owner:<org>&f=json&num=50
<server>/arcgis/rest/services?f=json          then walk the folders
```

**A re-publication may have been stripped.** WSDOT republishes the county road
log as geometry and linear referencing with *every attribute removed*. The
custodian's own org had the full certified table. If a layer looks like it
should have data and does not, find who actually maintains it.

**The custodian is often not the DOT.** Washington's county road inventory is
held by CRAB, a separate board, not by WSDOT. Ask who is legally required to
collect the thing, then find their org.

### What to look for, in rough order of value

1. **A statewide county road inventory.** In Washington this is the CRAB
   certified road log: 115,582 segments, all 39 counties, one schema, because
   counties must certify it annually. Other states will have an equivalent under
   another name. This is worth far more than any single county's open data
   portal, because per-county imports need hand-written field mappings each and
   do not generalise.
2. **State-route traffic counts.** Current, but state routes only.
3. **Functional class for non-state routes.** Gives roadway owner and FHWA class
   on city and county roads.
4. **A bicycle level-of-traffic-stress rating**, if the state publishes one.

### Classify each source before trusting it

A DOT is not one publisher. The same fact will appear in several of its
products, so sort every layer you find into one of four kinds before deciding
what reads it:

| kind | Washington example | what it is | trust it for |
|---|---|---|---|
| **inventory** | BLTS roadway attributes (shoulder, lanes, speed) | measured conditions, often directional | its own measurements |
| **registry** | Active Transportation bike facilities | the maintained system of record for one asset class, status-carrying, snapshot-dated | that asset class, nothing else |
| **derived analysis** | the BLTS 1–4 stress rating | a computed product, frozen at its analysis date, bundling COPIES of its inputs | the derived value only |
| **counts** | state AADT service, HPMS | periodic measurements with a year | volume, with provenance |

The trap this taxonomy exists to prevent: **a derived product ships copies of
its inputs, and a copy looks exactly like a second, confirming source.**
WSDOT's BLTS carries a `BikeFacilityType` field — it is the facilities
registry photocopied on the analysis date, equal or staler, never independent
evidence. For a long while the road card read facilities from the photocopy
while the router read the registry, and the two disagreed about the same road.
When two layers from one agency overlap, find which is the original and read
that fact from it alone; the copy corroborates nothing.

Precedence, once classified:

1. **An explicit OSM tag beats an agency inventory — including an explicit
   zero.** A mapper who wrote `shoulder:width` looked at that spot; the
   inventory interpolated a route segment (we have a documented case of a
   booked 4 ft shoulder that Street View shows as 1–2 ft). `shoulder=no` is
   knowledge, not absence: an inventory overwriting a mapper's "there is no
   shoulder" with a booked width is the most dangerous direction this
   precedence can fail in, and in Washington explicit zeros were the
   MAJORITY of the tagged ways (1,325 of 2,186). Agency data fills OSM's
   gaps; it does not overrule people on the ground. Speed already works this
   way — WSDOT fills only OSM-estimated values.
1b. **Measure a precedence change's blast radius before shipping it.** One
   pass over the extract counting the ways where the two sources both speak
   (for the shoulder flip: 813 WSDOT-candidate ways statewide, out of 1.15M)
   tells you whether you are about to re-score a corridor or the whole
   network — and gives the field tester a number to check the change
   against.
2. **Registry beats analysis-copy** for the registry's own domain, always.
3. **A derived rating may only ever caution.** See `docs/SAFETY-MODEL.md` on
   why the stress rating is a modifier, not a rung of its own.
4. **Measured counts beat modelled ones** (county and state counts before
   HPMS), and the provenance ships with the number so the card can say which
   inventory answered.

---

## 3. Conflating a source onto OSM

`scripts/roadmeasure.py` is the matcher. Two rules, both required, both learned
by getting them wrong:

**Match against the way's own span, not a midpoint.** Graph edges average ~190 m.
A midpoint test says nothing about whether a source accompanies an edge or
merely touches it. An early import matched by nearest midpoint and turned 33.5
miles of source into 72 miles of "matched" graph by bleeding onto every crossing
side street.

**Require alignment.** Within 40°. Without it, a source running along an
arterial claims every residential street that crosses it. With it, the same
import matched 42 miles instead of 72.

**And a source may legitimately cover only part of a way.** The first version
demanded that *every* sample point fall within tolerance of *one* source
segment. Inventories store a road as a run of short consecutive records, so no
single record spans a graph edge and the match fails outright — with the nearest
source line touching the edge at zero distance. On one corridor that discarded
4.13 of 5.83 miles. The fix: a way matches when the aligned segments **together**
cover a majority of five sample points, each checked individually for distance
and bearing. Statewide that recovered 25,403 → 35,993 miles, a 42% gain out of
data already fetched.

**When reporting how much matched, credit the matched portion**, never the whole
way. A way runs far past the stretch a source follows, so counting all of it
roughly doubles the number and makes any over-match check fire on healthy data.

**Inventories are directional; carry it all the way through.** A state route
inventory usually records each direction separately (Washington spells it in
the route id suffix), and the two sides genuinely differ — one direction of a
highway can have a 6 ft shoulder while the other has 1 ft. The graph stores
both directions per edge, the router scores the direction of travel, and the
tiles collapse to the *worst* of the two for display — and the card must label
that collapse, or the road card and the route card show different numbers for
one road with no explanation. Note OSM's shoulder tags are effectively
non-directional (`shoulder:width` describes the road), so an explicit OSM tag
sets both directions when it wins.

---

## 4. Measure before adopting, always

`scripts/measure_coverage.py` reports what fraction of the road network carries
each measurement, by road class, and what a candidate source would add to the
part that has nothing.

```
python3 scripts/measure_coverage.py --add data/candidate.geojson --label NAME
```

Use it. An estimate in this project once put a source near 50% coverage by
treating every published row as conflatable; a third of them were gravel roads
absent from the routing graph entirely, and the real figure was 28%. A source's
own row count tells you nothing about what it will add to *your* network.

Watch for the inverse too. HPMS looked like it would transform coverage based on
one corridor — Pioneer Way in Puyallup went 17% → 77%. Statewide it was 35.4% →
42.4%, because that corridor is a city principal arterial, which is precisely
HPMS's sweet spot and not representative. **One road is never a measurement.**

**And audit fetched-versus-consumed once the imports settle.** Every field a
fetcher pulls should either have a consumer or a line in a known-backlog list.
This project fetched the county road log's certified surface type (paved vs
gravel, statewide — exactly where OSM's `surface` tagging is thinnest) and then
forgot it for months, because nothing tracked the difference between "on disk"
and "used". The audit is one grep per fetcher's field list.

---

## 5. The discipline that matters most

Everything shown to a rider is one of three kinds of claim, and they must never
be flattened together. This is the hardest-won rule in the project.

| kind | example | how it is shown |
|---|---|---|
| **measurement** | a traffic count | with who counted it and when |
| **derived** | bail-out space from widths | tagged `(derived)`, never called a shoulder |
| **proxy** | functional class | shown as a class, never converted to a number |

The reason is a specific failure. Designated bike routes were once trusted to
satisfy the shoulder rule, on the theory that an agency had vetted them. Then
the data showed Clallam County's Olympic Discovery Trail runs **58.8 miles along
ordinary road**, including US 101 at 60 mph with no shoulder. A published route
line is a recommendation, not a measurement of the road, and treating it as one
made 44 miles of genuinely dangerous highway read as "passes your rules".

So: **a proxy may inform, and must never excuse.** If a new state's data tempts
you to let a designation, a classification, or an agency's endorsement satisfy a
physical rule, it is the same mistake wearing new clothes.

### Things deliberately not imported, and why

- **County and city speed limit layers.** On a rural county road the posted
  limit is frequently the statutory default on a road where no limit was ever
  set — it records the absence of a decision, not a measured hazard. Importing
  one re-labelled a pleasant road from an estimated 35 mph to an actual 55 and
  made it start failing. Traffic volume is the better axis.
- **"Planned" or "proposed" features.** Island County's bike layer marks planned
  segments only in the route *name*; WSDOT's functional class encodes proposed
  classifications as codes 92–96. Both caused real bugs. Filter them explicitly
  and expect every source to have some version of this.
- **A second definition of "urban".** WSDOT's urban/rural descends from the FHWA
  *adjusted* urban boundary, which is the Census line smoothed and extended.
  Keep one definition — ours is the Census polygon test — and carry any other as
  a visible cross-check rather than silently resolving the disagreement.

---

## 6. Order of operations

1. **Import and display only.** No routing weight, no verdict rung, no map
   colour. Every value on the card with its provenance tag.
2. **Field-test.** Someone who knows the roads checks whether the numbers
   describe them. This is the step that cannot be skipped or simulated.
3. **Only then** decide what the data earns in the model.

Step 3 is a separate decision every time. Data arriving in the app is not
consent for it to start changing routes.

---

## 7. Two structural rules

**Bake measurements into the tiles, never verdicts.** `roadLevelExpr` is
evaluated by MapLibre against vector-tile properties; nothing computed in
JavaScript can reach it. So a value that exists only in JS can change the card
and the router while leaving the map colour untouched — which is exactly the
"card says fail, map says pass" bug that took four releases to find. Tiles carry
facts; the phone applies the rider's rules.

**One adapter from data to verdict.** The road card and the route card once
reached the safety model down two hand-written paths that disagreed on three
inputs. If a new source is added, it goes through the same normaliser both cards
read. `scripts/test_card_model_shared.mjs` enforces this.

**And feature properties must be scalars.** MapLibre serialises them, so a
nested object on a route feature returns from the tap layer as a string and
reads as `undefined` everywhere. A shared reader is not enough on its own — the
data has to survive the trip to reach it. Flatten measurements onto the feature
under the same key names the tiles use.

**The tile build and the graph build are one decision layer.** They consume the
same sources to describe the same roads to the same rider, so every shared
constant, parser, and precedence decision lives in `build_graph.py` and is
IMPORTED by `build_roads.py`, never restated. When each kept its own copy, four
decisions drifted — km/h parsing, buffered-lane detection, whether WSDOT speed
beats a real OSM tag, whether a bike lane clears the limited-access caution —
and the card quietly disagreed with the router. `scripts/test_build_parity.py`
enforces the sharing; when a port adds a new source, its precedence decision
goes in `build_graph.py` once and the parity test grows a line.

---

## 8. Terrain and topology pitfalls that will recur in any state

None of these are Washington facts; they are what elevation rasters and OSM
topology do everywhere. Each cost a real bug here.

- **Shoreline DEM smear.** A z12 elevation mosaic (~26 m/pixel) blends a
  waterfront bluff onto the flats beside it: Clinton's dead-flat ferry pier
  booked an 11% grade over 116 m. Ferry edges themselves get zero grade, and
  the app additionally refuses to show a steep marker within 250 m of a ferry
  leg. Expect the same artifact at every waterline.
- **Structures need deck grades, not terrain.** The ground under a bridge is a
  ravine; sample the deck as a straight grade between the structure's ends
  (`structure_climb`), and below a few DEM samples' length there is no grade to
  measure at all — a 24 m bridge is one pixel.
- **`incline=` is authoritative where present.** The Burke-Gilman says 1.0%
  about itself while the terrain under it reads 16.9%. Rail-trails without the
  tag get capped: a corridor graded for trains never exceeded ~2%.
- **Same-name mapping seams sever corridors.** Two consecutive trail ways whose
  endpoints sit a metre apart without sharing a node read as connected on every
  map and are disconnected in every graph. Here that severed the state's main
  cross-mountain trail and turned a 20-mile ride into a 120-mile detour. The
  build stitches endpoint pairs of same-name ways within 2 m — and skips only
  pairs that already share a direct edge, *not* same-component pairs, because
  after the first seam stitches, the second seam's ends are "connected" via the
  detour and a component check defeats itself.
- **Untagged footways are connective tissue.** Excluding them shattered the
  graph into 5,417 components and orphaned 1,248 trail islands. They enter as
  walk-your-bike links. After any classifier change, check the largest
  component still holds >96% of nodes (`test_graph_connectivity.mjs`).
- **Terminals hide behind dismount tags.** A ferry terminal's only land access
  is often a chain of `bicycle=dismount` sidewalk hops; a walk-link exclusion
  quietly made Seattle's Pier 50 reachable only by arriving on another boat.
  Route to every terminal from land after a rebuild — the connectivity test
  does.

---

## 9. Operating notes

The dev container is reclaimed after a short idle period and takes everything
untracked with it — this happened seven times in one session. Consequences:

- **Commit an artifact the moment it is valid**, not at the end of the work. A
  built and verified graph was lost once purely because it sat uncommitted.
- **Fetchers cache pages to disk** (`scripts/arcgis.py`) so an interrupted run
  resumes rather than restarting.
- **The fetched sources are committed compressed** — 17.7 MB for three layers —
  because re-fetching takes longer than the idle window that destroys them.
- A running process does **not** keep the container alive. Only conversation
  does. A 45-minute build will not survive a quiet stretch.
