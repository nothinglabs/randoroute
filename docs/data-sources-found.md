# Transportation data sources found

A record of what exists and where, so it does not have to be rediscovered. This
is a catalogue of **sources**, not extracted data — nothing here is shipped.

Two of these were imported and then removed. That is not a verdict on the data;
it is recorded below alongside what was actually learned from it.

## Statewide (Washington)

| source | what it has | status |
|---|---|---|
| **WSDOT BLTS** (`BikePedLTS` geodatabase) | Level of Traffic Stress 1–4, shoulder width, speed limit, lane count, limited-access and prohibition flags, for **state routes only** | **in use** — `data/blts.geojson`, built by `scripts/build_blts.py` |
| **WSDOT legal speeds** | posted speed limits, state routes | **in use** |
| **WSDOT bike facilities** (Active Transportation Data) | mapped on-street facilities, state routes | **in use** |
| **WSDOT bicycle restrictions** | permanent bans by traffic action | **in use** |
| **WSDOT functional class, non-state routes** — `data.wsdot.wa.gov/arcgis/rest/services/FunctionalClass/WSDOTFunctionalClassData/MapServer/1` | 16,811 features: FHWA functional class and roadway owner for city and county arterials and collectors. Codes 92–96 are *Proposed* and must be dropped. | **in use** — `data/funcclass.geojson`, built by `scripts/build_funcclass.py` |
| WSDOT functional class, **state** routes — same service, `MapServer/0` | 4,290 rows, the state-highway half of the same layer | **not used.** State highways currently take their class from OSM alone; this would fill that. Same adapter. |
| **OSM `route=bicycle` relations** | national (`ncn`) and regional (`rcn`) signed routes — USBR, Burke-Gilman, Palouse to Cascades, Olympic Discovery Trail | **in use** — `data/bikeroutes.geojson`, built by `scripts/build_routes.py`. WSDOT publishes these only as PDFs, which is why OSM is the source. |
| **WSDOT Traffic Counts (AADT)** — `data.wsdot.wa.gov/arcgis/rest/services/Shared/TrafficData/MapServer/1` | annual average daily traffic per section, **4,815 sections, state routes only**, all 2025 | **in use** — `data/aadt.geojson`, built by `scripts/build_aadt.py`. Sample: US 101 south of Forks 1,700/day; SR 112 west of Port Angeles 4,200–4,600/day. A sibling layer `MapServer/0` holds 6,615 point counts with truck percentages, also state routes only; not used. |
| **FHWA HPMS Public Release (Washington)** — `geo.dot.gov/server/rest/services/Hosted/Washington_2018_PR/FeatureServer/0` | 129,911 sections, **99.4% with AADT**, plus speed limit, through lanes, functional class, ownership, surface, IRI. **39,442 non-state sections carry a count, of which 23,413 are city-owned — every one with AADT.** | **not used.** The only source found that has traffic volume for city streets. Every state DOT must submit HPMS to FHWA annually and FHWA republishes it, so the same service exists for all 50 states. |
| **CRAB certified county road log** — `services9.arcgis.com/bwkxJJr72Wf3t8dm/arcgis/rest/services/CRAB_County_Road_Log_Certified_2023/FeatureServer/0` | **115,582 segments, all 39 counties, one schema.** Lane count and width, surface, operational (total pavement) width, paved and unpaved shoulder widths, `ADTVolume` + `ADTYear`, functional class, truck route | **in use** — `data/roadlog.geojson`, built by `scripts/build_roadlog.py`. See `docs/plan-county-road-log.md`. |
| WSDOT's re-publication of CRAB (*CRAB Routes* / *County Road (CRAB)*) | geometry and linear referencing only — `RoadNumber`, `RouteIdentifier`, `LRSDate` | **not used.** Attribute-free. Do not mistake this for the row above: CRAB's own ArcGIS org publishes the full certified log, WSDOT's copy drops every attribute. |

## The city-street traffic gap, and the one source that closes it

Washington roads fall in three buckets and the state publishes counts for only
one of them. WSDOT's traffic layers — both `MapServer/0` (6,615 point counts)
and `MapServer/1` (4,815 sections) — are keyed to a `StateRouteNumber` and cover
state routes only. The CRAB road log stops at the city line; its Pierce County
rows literally end `at CITY LIMITS: PUYALLUP`.

So a city arterial has no count from any state source. Verified on W Pioneer
Ave in Puyallup: zero WSDOT AADT sections within 100 m of its real geometry (the
two hits nearby are SR 512 and SR 162 crossing it, correctly rejected by the
conflation's bearing test).

**FHWA's HPMS Public Release is the exception.** Sampled along the Pioneer
corridor it returns:

```
W Pioneer Ave  1.57 mi   AADT   444-10,588   City,   principal arterial, 4 lanes
W Pioneer Ave  0.46 mi   AADT      10,925    City,   principal arterial, 4 lanes
E Pioneer Ave  0.52 mi   AADT      13,222    City,   principal arterial, 2 lanes
Pioneer Way E  2.72 mi   AADT      13,425    County, minor arterial
```

Three caveats travel with it:

- **The hosted Washington release is 2018.** Older than WSDOT's 2025 state
  counts, newer than most of the county road log.
- **Non-state AADT in HPMS is frequently modelled rather than counted.** FHWA
  lets states estimate volumes on lower functional classes, so a city-street
  figure is an official estimate. It needs its own provenance tag; it is not the
  same kind of claim as a WSDOT tube count.
- **It does NOT systematically disagree with CRAB**, which an earlier draft of
  this file claimed. That claim came from setting one HPMS value for a 2.7 mile
  stretch against a spread of CRAB values across several different segments —
  different places, different lengths, and 13,425 sits inside 7,925–15,175
  anyway. Measured properly, on the **27,279 graph edges where both sources land
  on the same place**, the median HPMS/CRAB ratio is **1.00**: no bias either
  way.

  The per-segment scatter is nonetheless wide — 49.4% agree within 1.25x, 83.9%
  within 2x, and 8.3% differ by more than 3x — so on any particular road the
  choice of source can swing the number by a factor of two. That is noise, not
  disagreement, and it needs a tiebreak rule rather than an adjudication.
  Recency is the only tiebreaker with a reason behind it, since neither source
  is systematically off.

  Age does not explain the scatter, which is worth knowing: CRAB counts from
  before 2010 have the same median ratio against 2018 HPMS (1.00) as counts from
  2015 onward (0.97). Either those roads are not growing, or HPMS partly derives
  from the same underlying counts. This measurement cannot distinguish the two.

Sections carry no `route_name` — they are keyed by LRS `route_id` — so matching
is geometric, and the sections are short. A whole-way match against them fails
by construction; chunk the way first, as `scripts/roadmeasure.py` already does.

**WSDOT Traffic Volume (MS2 TCDS)** — `wsdot.public.ms2soft.com/tcds/` — is
WSDOT's public count database and may hold local-agency counts. It sits behind
an AWS WAF JavaScript challenge, so it needs a real browser; it could not be
evaluated from the build environment. HPMS looks the better source regardless:
TCDS is a search interface, HPMS is a bulk service with a published schema.

## Island County (Whidbey and Camano)

ArcGIS org `services6.arcgis.com/Q2crTJYujvn27IJC`, 60 services. Open data hub at
`data-islandcountygis.opendata.arcgis.com`.

| layer | what it has |
|---|---|
| `Bridge_to_Boat_v2` layer 0 **`BikeRoutes`** | 14 features, 82.5 mi. South Whidbey (21.9 mi) and North Whidbey (11.6 mi) are built; Central Whidbey (49 mi, 12 segments) is marked `(Planned)` in the name. Only field is `Route`. |
| `Average_Daily_Trips` / `RoadLog_Mobility` | the CRAB road log: 4,346 segments with ADT, `ADTYear`, `NumThruLanes`, `ThruLaneWidth`, `LeftPavedShoulderWidth` / `RightPavedShoulderWidth`, `PavementWidth`, `SpeedLimit`, `AvgPSC`, `TotalCollisions` |
| `Trails` | 837 features; **58** say `BICYCLE = Yes` (13.5 mi), 117 `Unknown`, 16 `No`, 646 blank |
| `Speed_Limit_Study` | current and proposed speed limits |

**Found nowhere in the bike layer:** any per-feature bike attribute. Bikeability
is asserted by the layer's name; the service is named after the route (Deception
Pass bridge to the Clinton ferry boat), not its contents, so no keyword search
over service names finds it. Crawl to *layer* depth.

**Worth remembering about the road log:**

- `LeftPavedShoulderWidth` is populated on **954 of 4,399** rows, and every
  populated value is > 0 — so blank means "not separately inventoried", not
  "no shoulder".
- `PavementWidth` is not an independent measurement: it equals
  `2 × ThruLaneWidth + shoulders` on 4,150 of 4,236 two-lane records.
- Deer Lake Road is recorded as **16 ft lanes, 32 ft pavement, no shoulder** —
  almost certainly 11–12 ft lanes plus 4–5 ft of usable edge, but that is an
  inference from one entered value, not something the county asserts.
- `ADTYear` spans **1977 to 2019**, with 2,865 of 4,346 counts predating 2010.

## Clallam County

ArcGIS org `services8.arcgis.com/noCZ2SM2C0rVag8y`, 160 services.

| layer | what it has |
|---|---|
| **`Olympic_Discovery_Trail`** | 111 segments, 157.9 mi, the whole Clallam stretch, **classified per segment** |
| `Main_Roads`, `Other_Roads` | names and road class only |
| `Speed_Limit_Study`, `IRTPO_Dashboard_Crashes` | speed study; RTPO crash dashboard |

The ODT layer is the most detailed route data found anywhere in the state, and
the reason is that it is honest about what the route is:

```
ROUTE_TYPE   Paved Road 60.0   Paved Trail 46.9   Unpaved Trail 32.7
             Bike Lane 8.1     Unpaved Road 7.1   Unpaved Access Road 2.7

STATUS       Existing Trail 63.3      Complete - On Road 55.8
             Adventure Route 22.8     Complete - Interim 12.2

TRAIL_TYPE   Separated Trail · Trail Route on Road · Connecting Road ·
             Trail on Existing Gravel Logging Road · Natural Tread 3 Foot

ODT_Use      Multi-use · Multi-Use > No Horses · Multi-use > No Road Bike
```

**Clallam publishes no traffic counts.** Checked its org and its road layers.

## What was learned, and why both imports were removed

Both counties were imported and then taken back out. The reason was not data
quality — it was that a published bike route is not a claim that the road is
safe, and treating it as one is dangerous:

- Clallam's ODT alignment runs **58.8 mi along ordinary road**, including
  **US 101 at 60 mph with no shoulder**, **SR 112 at 55 mph with 2 ft**, and
  **La Push Road at 50 mph with 0 ft**. A setting that let a designation satisfy
  the shoulder rule turned 44 miles of that into "passes your rules".
- The same applies to the OSM state relations. The Olympic Discovery Trail's
  relation flattens all of that into one line and cannot tell you any of it.
- Island's routes carry no per-segment classification at all, and 97% of their
  mileage has an unknown shoulder — so that county is the one we would have been
  trusting on the least evidence.

The verdict ladder no longer has a rung by which any designation can excuse a
road. See `docs/SAFETY-MODEL.md`.

**Field values are hand-typed and inconsistent even inside one layer** —
Clallam's `ODT_Use` contains `Multi-Use`, `Multi-use`, `Multi-Use > No Horses`,
`Multi-use >No Road Bike` and `Multi-use >no rd bike`. Any future import needs a
mapping written and reviewed by a person; it cannot be inferred.

## If a county is imported again

Two things that cost real time and are worth not rediscovering:

1. **Crawl to layer depth, not service names.** Island's bike network is inside a
   service called `Bridge_to_Boat_v2`.
2. **Match county geometry to OSM by span and bearing.** Within 18 m of the way's
   own span (not its midpoint — graph edges average ~190 m), and aligned within
   40°. Without the bearing test, Island's 33.5 mi of route matched 72 mi of
   graph by bleeding onto every crossing side street; with it, 42 mi.

And measure the matched *portion* of each OSM way, not the whole way — a way runs
far past the stretch a route follows, so counting all of it roughly doubles the
number and makes any over-match check fire on healthy data.
