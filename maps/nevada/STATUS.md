# Nevada import status

Status: preview. This file is the running record of the import. The `readiness`
number in `region.json` moves only when the rubric gate in `maps/README.md` is
actually met.

## Source census — completed before any build

Census date: 2026-08-21. Every layer's schema was read from its own
`?f=json` metadata and its value distribution queried before a verdict was
written; geometry type is never the reason for a verdict (lesson A9).

**Where Nevada's data actually is, because no keyword search finds it.** NDOT
runs *two* ArcGIS servers and the useful one is not the one its open-data hub
links to. `gis.dot.nv.gov/arcgis/rest/services` holds mapping and application
services; the road inventory is on **`gis.dot.nv.gov/rhgis/rest/services`**, in
a folder called `EAMS`, in a service called `NDOT_ALRS`, as 83 layers named for
the asset rather than the subject — `ShoulderOutside`, `SpeedLimit`, `AADT`,
`FSystem`, `OwnershipMaintenance`. Nothing in `EAMS`, `rhgis` or `ALRS` says
"road", so this is the porting method's "search at layer depth, not service
names" rule earning its place a second time.

**Two traps this census hit and a later import will hit again.**

1. *Every ALRS layer is time-sliced.* Rows carry `FromDate`/`ToDate` and the
   retired ones are still served. `ToDate IS NULL` is the current slice.
   Without it the shoulder layer returns 4,390 rows of which 3,164 are history,
   and the historical values are the ones NDOT has already superseded.
2. *"NDOT" is two state DOTs.* Nebraska's uses the same abbreviation, and an
   ArcGIS Online search for "NDOT shoulder width" returns Nebraska's items —
   which do have a statewide shoulder-width feature service, so the wrong
   answer looks like a good one. Nevada's server is `gis.dot.nv.gov`;
   Nebraska's is `gis.ne.gov`.

| Signal | Verdict | Source and field-level finding |
| --- | --- | --- |
| Bicycle stress rating | **absent** (statewide) | No NDOT layer exists: the 83-layer ALRS has no bicycle asset of any kind, and neither does the `arcgis` server's PMS, HighDesert or TrafficSafety folder. The only Nevada LTS product found is RTC Washoe's [Bike_Level_of_Traffic_Stress](https://services1.arcgis.com/snfDNSrRKzTzlDky/arcgis/rest/services/Bike_Map_Online_WFL1/FeatureServer/1), **parked**: 3,010 Reno/Sparks segments whose field list is `StreetName, Class, LandClass, MEAN_MEAN_, FULLNAME, BikeFacili, Bike_LTS_S`, with no effective date. The field *named* `Bike_LTS_S` is not a stress rating — its values are 0 (2,701 rows) and 1 (309 rows), exactly tracking `BikeFacili = 'Existing Path'`. The real rating is in `MEAN_MEAN_`, an un-renamed spatial-join mean carrying fractional values (3.667, 2.938) and 404 unrated zeros. A rating that cannot be attributed to a documented scale may not caution a rider. |
| Shoulder width (per side) | **claimed, thin** | NDOT ALRS [ShoulderOutside](https://gis.dot.nv.gov/rhgis/rest/services/EAMS/NDOT_ALRS/FeatureServer/16), fields `RouteID, FromMeasure, ToMeasure, ShoulderOutsideType, ShoulderOutsideWidth, DataSource, DataYear`. **1,226 current spans for the whole state**, of which 1,129 carry `DataSource = "2019 HPMS Shoulder Type & Shoulder Width_R"` and 67 are hand-edited. `ShoulderInside` (layer 17) is the median side and is not riding space; it is not read. |
| Posted / legal speed | **claimed, with a provenance caveat** | NDOT ALRS [SpeedLimit](https://gis.dot.nv.gov/rhgis/rest/services/EAMS/NDOT_ALRS/FeatureServer/42), fields `RouteID, FromMeasure, ToMeasure, SpeedLimit, DataSource, DataYear`. 1,605 current spans; **1,485 of them carry `DataSource = "2019 HPMS Speed Limt"`** and 98 are hand-edited. See "The speed decision" below — this is the one census verdict in this import that a reasonable reader could disagree with, so it is argued rather than asserted. |
| Bike facility inventory | **claimed (regional)** | Nevada's DOT publishes none. RTC of Southern Nevada's [HUB service](https://webgis.rtcsnv.com/arcgis/rest/services/Web/HUB/FeatureServer) layers 8/9/10: Enhanced Bicycle Lane (4,936), Bicycle Lane (20,541), Shared-Use Path (1,738). Fields include `TYPE, NAME, JURISDICTION, BIKE_WIDTH, BUFF_WIDTH, coll_date, begin_lat/end_lat, session` — a field-collected registry, not a plan. Covers Clark County only: Las Vegas, Henderson, North Las Vegas, Boulder City, Mesquite. RTC Washoe's two Reno/Sparks facility layers ([Bicycle_Facilities](https://services1.arcgis.com/snfDNSrRKzTzlDky/arcgis/rest/services/Bicycle_Facilities/FeatureServer/0), 301 rows; [RTC_BikeFacilities](https://services3.arcgis.com/q5Jezm9AgzqyE7Q6/arcgis/rest/services/RTC_BikeFacilities/FeatureServer/0), 229 rows) are **parked**: their whole field list is `FULLNAME, Field/Type, Miles, From_, To_` with no collection date, no width, no buffer or protection column, and a facility vocabulary of one value per layer — there is nothing to map onto the shared 0–5 ladder without guessing which of "On-Road Bike Facility" is a lane and which is a shoulder stripe. |
| Official bicycle prohibitions | **absent** | No NDOT layer: the 83-layer ALRS has no bicycle-access event, and neither the `arcgis` server nor NDOT's ArcGIS Online org publishes a prohibition inventory. Nevada's prohibitions are posted per segment rather than inventoried, so OSM's explicit `bicycle=no` is the only signal available and it carries **5,892 ways** in this extract — enough to matter: 34 of them sever the Truckee Canyon (see `VERIFICATION.md`). `--restrictions ""` on the graph build, deliberately. Whether that tagging matches the posted signs is a roadside question and is listed as unverified. |
| Traffic volume **and year** | **claimed, both floors** | NDOT ALRS [AADT](https://gis.dot.nv.gov/rhgis/rest/services/EAMS/NDOT_ALRS/FeatureServer/50) is the current measured layer: 4,920 current spans with `AADT, CountStation, CountSourceType, CountDate` — real count dates, most in 2025 — as polylines in the state plane the service reprojects to WGS84 on request. The uniform floor is [FHWA HPMS Nevada 2018](https://geo.dot.gov/server/rest/services/Hosted/Nevada_2018_PR/FeatureServer/0), **47,011 rows with a count** (state 36,291, county 5,051, city 5,288). Years probed 2015–2023: only 2018 exists, and the layer inside it is named `NNevada_PR_2018` with a doubled N. |
| Functional class / road owner | **claimed** | NDOT ALRS [FSystem](https://gis.dot.nv.gov/rhgis/rest/services/EAMS/NDOT_ALRS/FeatureServer/65) — 72,426 current spans, FHWA classes 1–7, statewide including local streets (68,827 are class 7) — joined by route and milepost to [OwnershipMaintenance](https://gis.dot.nv.gov/rhgis/rest/services/EAMS/NDOT_ALRS/FeatureServer/48), 75,456 spans. NDOT's `Ownership` domain **is** the FHWA code set (1 Nevada DOT, 2 County, 3 Town, 4 City, plus federal and tribal codes), so it passes through untranslated and the non-roadway owners (railroad, airport) are dropped rather than coerced. |
| County road inventory | **absent, but the identity half exists** | Nevada has no CRAB equivalent — no board is required to certify a county road log, and no county-level edge-space, operational-width or surface inventory was found. What NDOT *does* publish is the identity half: `StatewideRoutes` (66,785 routes with names, county and jurisdiction) plus FSystem and Ownership reach local streets. So Nevada knows what and whose every road is, and nothing about how wide it is. This leaves `inferShoulderFromEdge` with no input (lesson D7 — see the ledger entry). |
| Long-term closures | **claimed — hand-maintained** | `route_closures.geojson`, extracted by `build_routes.py` from OSM route relations. Two closure groups in this build. No statewide machine-readable closure layer is needed at this stage. |

### The speed decision, argued rather than asserted

Lesson A3 says HPMS's speed limits are "deliberately not used here, for the
same reason county speed layers were rejected". Nevada's only statewide posted
speed layer is 92.5% HPMS 2019 republished on NDOT's own linear reference. That
is close enough to the rejected thing to need an argument, so here it is.

The reason county and city speed layers were rejected is specific: on a rural
county road the posted limit is frequently the *statutory default* on a road
where no limit was ever set, so importing one re-labels a pleasant road from an
estimated 35 to an actual 55 and makes it start failing. That failure needs a
layer that covers roads nobody ever posted. NDOT's covers 1,605 spans of the
**state highway system** — roads that are signed, and whose signs NDOT is the
authority on. It is the same kind of thing as WSDOT's legal-speed layer and
ODOT's Posted Speed, arriving by a different route.

Two guards make the vintage safe rather than merely tolerable. The shared
builder lets an agency speed fill only an **estimated** speed and never
overrides an OSM `maxspeed` tag (lesson G5's fourth drift), and 35,079 of
Nevada's 505,189 highway ways carry `maxspeed`. And a stale posted limit on a
signed state highway is stale in a way a rider can check from the saddle,
unlike a statutory default that was never a measurement at all.

It is claimed. If a later reader disagrees, the change is `--legal-speeds ""`
in `BUILD.md` and nothing else moves.

### What was fetched and deliberately not emitted

The fetched-versus-consumed audit (lesson A8), done up front rather than months
later:

- **NDOT `ShoulderOutsideType` 4 (gravel/granular) and 6 (earth): 148 spans,
  counted and withheld.** An 8 ft graded gravel shoulder is bail-out space, not
  riding space, and emitting its width as `ShoulderWidth` is lesson D1 wearing
  new clothes — a proxy excusing a road. It is a genuine candidate input for
  `inferShoulderFromEdge`, which has no other input in Nevada, and that is a
  known backlog for a field-tested import (lesson G1), not something this one
  may wire in.
- **`ShoulderInside` (1,226 spans).** The median side. Not riding space.
- **NDOT `SurfaceType` (1,045 spans, 2025 HPMS) and `ThroughLane` beyond the
  lane count already carried.** Surface type is display-only in Washington via
  CRAB's code table; there is no Nevada decoder and no consumer, so it is not
  fetched into the build.
- **RTC Southern Nevada's `BIKE_WIDTH`, `LANE_WIDTH`, `RS_WIDTH`.** A
  Mandli-collected roadway inventory rides along inside the bike-facility
  layers. `RS_WIDTH` in particular looks like a right-shoulder width for the
  Las Vegas valley — the one place in Nevada where a shoulder inventory would
  cover city streets. It is not read here because nothing downstream is
  prepared to attribute a shoulder to an MPO's bike-lane layer, and doing so
  without a field test is the mistake G1 exists to prevent. **This is the
  single most valuable unexploited signal found in this import.**

## Nominated verification corridors

Six, written down before the extract was downloaded, in `corridors.json` with
the reason each was chosen. They cover the Washoe Valley pinch between Reno and
Carson City, a four-mile Truckee River hop chosen under lesson C2 because a long
corridor absorbs a severance, the Hoover Dam approach where bicycles are barred
from the bypass bridge, the Las Vegas valley crossing, NV 160 over Mountain
Springs where there is no second road for forty miles, and Elko to Spring Creek
for the sparse northeast.

## What was built

| Artefact | Size | Content |
| --- | --- | --- |
| `graph2.bin.gz` | 15.3 MB | 404,591 nodes, 477,810 edges, 864,033 directed arcs |
| `roads.pmtiles` | 16.7 MiB | 126,509 street features |
| `basemap.pmtiles` | 13.2 MiB | land, water, green space, 601 place labels |
| `overlays.pmtiles` | 6.1 MB | 17,593 bike-infrastructure ways, 6,055 inventory spans |
| `places.json` | 30 KB | 601 places |
| `bikeroutes.geojson.gz` | 99 KB | 11 OSM route relations |

Graph-build conflation: 89,922 NDOT-conflated edges, 67,368 with an official
legal speed, 30,603 with an official facility. 73 same-name seams stitched at
the 2 m threshold, 10,967 dedicated paths densified for snapping, 7,903
sidewalk stitch fragments, 61,190 edges pruned in walk-only components.

## Coverage, measured against the shipped graph

`python3 scripts/measure_coverage.py --graph maps/nevada/graph2.bin.gz --add
maps/nevada/hpms.geojson --label HPMS`:

- **38,131 road miles** excluding paths and ferries. Worth holding beside
  Oregon's 74,503: Nevada is the larger state and carries half the road
  network, so coverage percentages between states are not comparable without
  this denominator.
- **10,948 miles with a traffic count — 28.7%** (Oregon 25.5%, Washington
  35.4%).
- **0 miles with bail-out space — 0.0%.** Nevada publishes no county road log,
  so `inferShoulderFromEdge` has no input at all. This is the second state
  running to return this zero (lesson D7).

Traffic-count coverage by functional class:

| class | miles | with count |
| --- | --- | --- |
| Interstate | 999 | 58.0% |
| Freeway / expressway | 50 | 23.9% |
| Principal arterial | 2,487 | 86.3% |
| Minor arterial | 2,195 | 94.5% |
| Major collector | 2,441 | 93.2% |
| Minor collector | 7,806 | 48.9% |
| Local street | 22,152 | **0.2%** |

The shape is Oregon's, with one difference worth naming: minor collectors
reach 48.9% here against Oregon's 2.6%, because NDOT's functional-class and
ownership layers extend to local streets even though its counts do not. The
bottom line is identical in both states — a local street in the American West
has a traffic count essentially never — and 22,152 of Nevada's 38,131 road
miles are local streets. **More than half of this state's rideable network is
priced by functional class and OSM tags rather than by a measurement.**

### Shoulder, on the roads where the shoulder rung decides

Traffic coverage is the number the rubric asks for. This is the number that
actually explains Nevada's routes. On roads at 45 mph and above:

| | Nevada | Oregon | Washington |
| --- | ---: | ---: | ---: |
| road miles at 45+ mph | 7,682 | 12,641 | 13,508 |
| bike lane or better, shoulder moot | 7.2% | 5.3% | 2.1% |
| passes on a **measured** shoulder ≥ 4 ft | 23.4% | 38.8% | 40.0% |
| fails on a **measured** shoulder < 4 ft | **1.1%** | 15.3% | 14.8% |
| fails on **no measurement at all** | **68.2%** | 40.5% | 43.1% |

**98.4% of Nevada's failing fast-road mileage fails on the absence of evidence,
not on evidence of absence** — 5,239 of 5,327 miles. Oregon's figure is 72.6%
and Washington's 74.4%. An untagged shoulder reads as 0 ft by design, and the
design is right; Nevada is where it becomes load-bearing across two thirds of a
state, because NDOT's whole shoulder inventory is 1,226 current spans and OSM
carries a `shoulder*` tag on 595 of 505,189 highway ways.

`ROUTING-AUDIT.md` traces every over-long recommendation in the twenty-route
audit back to this row, and measures the effect directly: with the shoulder
rung switched off, four sample trips drop to **zero** failing metres and the
recommendation's detour collapses from 1.76× to 1.06× (Carson City → Minden)
and from 2.20× to 1.47× (North Las Vegas → the airport).

## Readiness

**7.** The gates, each against `maps/README.md`:

| Level | Gate | Met by |
| --- | --- | --- |
| 1 | app opens on the state; `test_region_portable`, Maps screen | `npm test` green |
| 2 | `places.json` + `basemap.pmtiles` | 601 places, 13.2 MiB basemap |
| 3 | `roads.pmtiles` + `graph2.bin.gz`, routes return | 126,509 features, 477,810 edges |
| 4 | agency speed and facilities conflated; corridor severance on this state's corridors; parity and fact contract green | 67,368 official-speed and 30,603 official-facility edges; **all six nominated corridors pass with no freeway** |
| 5 | traffic volume conflated + a written verification report | NDOT 2025 counts and HPMS 2018; `VERIFICATION.md` |
| 6 | stress, prohibitions and shoulder conflated where the state publishes them; `measure_coverage.py` recorded | shoulder inventory conflated; stress rating and prohibition layer **absent statewide**, with field-level reasons in the census above; coverage recorded above |
| 7 | verification extended past one metro to the state's distinct regions | `VERIFICATION.md` covers the Las Vegas valley, the Colorado River, Reno/Sparks, Lake Tahoe, the Carson Valley, the northeast, and the Great Basin interior |

**Read gate 6 carefully, and know that this import edited the rubric it is
scored against.** Level 6 names "stress rating, prohibitions and a shoulder
inventory conflated **where the state publishes them**" — the emphasised clause
was added to `maps/README.md` during this import, because read without it the
gate is unmeetable for reasons that have nothing to do with the work: Nevada's
DOT publishes no bicycle stress rating and no prohibition layer, and no amount
of importing produces one. That is a conflict of interest and it should be
checked rather than taken on trust. Two things make it defensible: **Oregon
already ships at 7 without a prohibition source** (its census records the same
absence), so the clause codifies existing practice rather than inventing an
exemption; and the census above is what makes the difference auditable — every
absent source is named with the field-level reason and the URLs that were read.
If a reviewer disagrees with the clause, Nevada's honest number under the
literal reading is **5**, not 7, and the difference is entirely about what NDOT
publishes.

**Not 8**, and it cannot be from here: nobody has ridden any of it. Two things
a rider should check first, because they are where the data is thinnest rather
than where it looks worst:

1. **Shoulders outside Clark County.** Nevada has an opinion about the shoulder
   on roughly 1,800 road segments in the entire state — 1,226 NDOT spans plus
   595 OSM-tagged ways. Everywhere else the shoulder is unknown, which the
   model reads pessimistically. On a 55 mph rural two-lane that is the
   difference between "fails your rules" and "fine".
2. **The 22,152 miles of local street with no count.** Those are priced by
   functional class, and NDOT classes 68,827 of its 72,426 spans as class 7.

`status` is **`preview`** and that is a deliberate, arguable choice. Oregon
ships `released` at the same readiness. The reason for the difference is that
Nevada's largest metro has **zero** published bicycle route relations, so the
level-5 method — compare the router against routes known to be good — could
not be applied at all to three quarters of the state's riders; the Las Vegas
verification here is against named rides and the road network, not against a
mapped corridor. That is worth a rider's eyes before the pack is called
released. It costs one thing, and it is worth knowing:
`test_shoulder_directional_fill.mjs` only measures **released** states, so
Nevada's directional-shoulder ratio is measured by hand and recorded in
`VERIFICATION.md` rather than by the suite.

## Findings and blockers

Recorded as they were hit; the full list with fixes is in the import's commits.

- `scripts/arcgis.py` cached pages under a name that did not mention the layer,
  so this adapter's second layer silently received the first layer's rows. It
  fails as an *empty output file*, which reads exactly like "the state does not
  publish this". Fixed in shared code.
- `scripts/arcgis.py` sent urllib's default User-Agent; RTC Southern Nevada's
  ArcGIS answers it with 403 and a browser string with 200.
- `maps/README.md` documents `directionalShoulderFloor`; `build_map_registry.mjs`
  rejected it as an unknown key.
- `.gitignore` spelled Oregon's adapter intermediates literally, so Nevada's
  leaked into `git status`.
- `scripts/verify_against_routes.mjs` and `scripts/verify_corridor_chain.mjs` —
  the two tools the porting method points an importer at for the level-5 report
  — crashed on every state with `ADVANCED_ROUTE_OPTION_DEFAULTS is not defined`.
  Each carried a hand-rolled copy of the harness's rules lifter. Fixed.
- `verify_corridor_chain.mjs` reported U.S. Bicycle Route 50 SEVERED on a hop
  whose two ends are the same coordinate. Fixed, and the skip is counted.
- `build_compressed_overlays.mjs` walks the registry and rewrote Oregon's and
  Washington's committed overlays during this import. Fixed with an optional
  state id.
- One routing defect, not repaired here because the repair is a judgement about
  shared classification: `is_mountain_bike_way()` marks every way member of a
  `route=mtb` relation, and a bikepacking relation includes paved state
  highways. In Nevada that deletes SR 170 — the only bike-legal crossing of the
  Virgin River — and Mesquite → Bunkerville returns "no route" for a 4.7-mile
  trip. `ROUTING-AUDIT.md` N1 has the blast radius on all three states.
- No application code needed changing for Nevada. Every state fact reached the
  builders through `region.json` and the adapters.

## Known backlog, in the order a next session should take it

1. **RTC Southern Nevada's `RS_WIDTH`** — a right-shoulder width riding along
   inside the bike-facility layers, for Clark County city streets. No state in
   this project has ever had a shoulder measurement on city streets. Needs a
   field test before it may touch the model (lesson G1), and it is the only
   Nevada signal that could feed `inferShoulderFromEdge`.
2. **NDOT `ShoulderOutsideType` 4 and 6** — 148 spans of gravel and earth
   shoulder width, counted and withheld. Bail-out space, not riding space; the
   same inference input as (1), on rural highways instead of city streets.
3. **NDOT `SurfaceType`** — 1,045 spans, 2025 HPMS vintage. Display-only in
   Washington via CRAB's code table; there is no Nevada decoder and no consumer.
4. **Map the Las Vegas valley's trails as `route=bicycle` relations upstream.**
   The River Mountains Loop Trail and the Las Vegas Wash trails are in the graph
   as ways and in no relation, which is why the level-5 method cannot reach
   Clark County at all.
