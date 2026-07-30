# Porting this to another state

Written for whoever — or whatever — does Oregon next. It is a **method**, not a
list of Washington URLs. The specific services will differ; the shape of the
problem does not.

Read `docs/SAFETY-MODEL.md` first for what the app decides and why. This file is
only about getting a new state's data into it.

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

---

## 8. Operating notes

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
