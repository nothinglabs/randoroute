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
services; the road inventory is on `gis.dot.nv.gov/**rhgis**/rest/services`, in
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
| Official bicycle prohibitions | **absent** | No NDOT layer. Nevada's prohibitions live in NRS 484B.763 and in NDOT traffic orders posted per freeway segment, not in a published inventory. OSM's explicit `bicycle=no` is the only prohibition signal and carries **5,892 ways** in this extract. `--restrictions ""` on the graph build, deliberately. |
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
- No application code needed changing for Nevada. Every state fact reached the
  builders through `region.json` and the adapters.
