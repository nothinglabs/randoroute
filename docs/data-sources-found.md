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
| **OSM `route=bicycle` relations** | national (`ncn`) and regional (`rcn`) signed routes — USBR, Burke-Gilman, Palouse to Cascades, Olympic Discovery Trail | **in use** — `data/bikeroutes.geojson`, built by `scripts/build_routes.py`. WSDOT publishes these only as PDFs, which is why OSM is the source. |
| **WSDOT Traffic Counts (AADT)** — `data.wsdot.wa.gov/arcgis/rest/services/Shared/TrafficData/MapServer/1` | annual average daily traffic per section, **4,815 sections, state routes only** | **not used.** One adapter would give traffic volume for every state highway in Washington. Sample: US 101 south of Forks 1,700/day; SR 112 west of Port Angeles 4,200–4,600/day (both 2025). |
| **CRAB certified county road log** — `services9.arcgis.com/bwkxJJr72Wf3t8dm/arcgis/rest/services/CRAB_County_Road_Log_Certified_2023/FeatureServer/0` | **115,582 segments, all 39 counties, one schema.** Lane count and width, surface, operational (total pavement) width, paved and unpaved shoulder widths, `ADTVolume` + `ADTYear`, functional class, truck route | **not used — the current plan.** See `docs/plan-county-road-log.md`. |
| WSDOT's re-publication of CRAB (*CRAB Routes* / *County Road (CRAB)*) | geometry and linear referencing only — `RoadNumber`, `RouteIdentifier`, `LRSDate` | **not used.** Attribute-free. Do not mistake this for the row above: CRAB's own ArcGIS org publishes the full certified log, WSDOT's copy drops every attribute. |

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
