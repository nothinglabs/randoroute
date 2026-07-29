# Current plan: the CRAB county road log

**Status: agreed direction, not started.** This is the live plan; when it is
implemented the mechanics move into `docs/SAFETY-MODEL.md` and this file
becomes history.

## What it is

One ArcGIS endpoint, published by the County Road Administration Board:

```
https://services9.arcgis.com/bwkxJJr72Wf3t8dm/arcgis/rest/services/
  CRAB_County_Road_Log_Certified_2023/FeatureServer/0
```

**115,582 segments. All 39 counties. One schema — identical field names
statewide.** Counties are required to certify this to CRAB annually, which is
why it is uniform where their own open-data portals are not.

This is the answer to the problem that killed the Island and Clallam imports:
those needed a hand-written field mapping per county and did not generalise.
This needs one adapter for the state.

Do not confuse it with WSDOT's re-publication of the same layer, which strips
every attribute. See `docs/data-sources-found.md`.

## Why we want it

The app currently has good measurements for state routes (WSDOT BLTS: shoulder
width, lane count, legal speed) and thin, largely estimated data for county
roads. That asymmetry produces a specific bad outcome on the ground: the router
sends a rider down SR 525 — 8,000–14,000 vehicles/day — because SR 525 is the
road we have evidence about, while the quiet parallel county roads look worse
than they are.

The road log carries the evidence that settles it.

## Field coverage, measured

Counted against the live service, not assumed:

| field | populated |
|---|---|
| `OperationalWidth` | 115,582 / 115,582 — **100%** |
| `ThruLanes`, `ThruLaneWidth`, `ThruLaneSurface` | **100%** |
| `ADTVolume` | 113,293 — **98%** |
| `RightPavedShoulderWidth` | 16,801 — **15%** |
| `RightUnpavedShoulderWidth` | 40,863 — **35%** |

As on Island, a blank shoulder width means "not separately inventoried", not
"no shoulder": of 16,801 populated values, only 15 are zero.

## How much this expands what we know

Measured against the shipped graph, not estimated:

```
road miles in graph (excluding paths and ferries)   94,518
  KNOWN shoulder                                     8,721 mi    9.2%
  unknown shoulder                                  85,796 mi   90.8%
  WSDOT LTS present                                  7,969 mi    8.4%
  traffic volume, any road                               0 mi      0%
```

The 9.2% is BLTS, and it is essentially the state highway system: 55,271 BLTS
features and 15,897 directional miles collapse onto roughly 8,700 centerline
miles of graph. Everything else is estimated or unknown. That asymmetry is the
reason the router prefers SR 525 to the quiet roads beside it — the highway is
the only thing it has evidence about.

CRAB carries `OperationalWidth`, `ThruLanes` and `ThruLaneWidth` on 100% of
39,187 county road miles.

| | today | after CRAB (ceiling) |
|---|---|---|
| road with a space metric | 8,721 mi (9.2%) | ~48,000 mi (~50%) |
| road with traffic volume | 0 | ~46,000 mi (39k county + ~7k state) |

Roughly a fivefold expansion in road with a space measurement, and traffic
volume goes from nothing to about half the network.

Three deductions from that ceiling, all of them real:

- **Conflation loss.** Not every CRAB mile will match OSM geometry. Perhaps
  85-90% on named county roads; unknown until it is built.
- **It is bail-out space, not ridable shoulder.** The paved-only field stays at
  15% of CRAB rows, so ridable-shoulder coverage barely moves. The jump is in
  the "somewhere to go when a truck comes past" number.
- **21.8% carry the folded lane width**, and under-report until the clamp rule
  is written.

What remains uncovered afterwards is about 45,000 miles, overwhelmingly city
streets and local residential roads. Functional class fills part of that for
arterials; for the rest, calm-by-default is a fair assumption.

## The two quantities

These are different questions and the model must keep them apart.

**Ridable shoulder** — paved, wide enough to ride in. Only the explicit fields
answer this, so it stays at 15% coverage. Feeds the existing shoulder rule
exactly as WSDOT's does.

**Bail-out space** — somewhere to get to when a truck comes past, paved or not.
Derived, and therefore available on 100% of segments:

```
edge space = OperationalWidth - (ThruLanes x ThruLaneWidth)
                              - (OtherLanes x OtherLaneWidth)
```

### The derivation is validated

Checked against the 16,786 segments where the county *also* reported explicit
shoulder widths:

- **median error 0.00 ft**; 86.2% agree within 1 ft
- the 13.8% that disagree are not errors. **99% of them also report an unpaved
  shoulder**, and adding that in explains **98%** of the gap.

So the derived number is total edge space, paved plus unpaved — which is
precisely the bail-out question, not the ridable-shoulder question.

It discriminates rather than smearing. On segments with no reported shoulder:
**60.7% derive to exactly 0 ft** and **29.3% derive to 4 ft or more**.

### Known failure mode: shoulder folded into the lane

**25,162 segments (21.8%) record `ThruLaneWidth` > 13 ft.** No lane is 16 ft
wide; the county has entered half the pavement width as the lane. Deer Lake
Road on Whidbey is one: 2 lanes x 16 ft = 32 ft of 34 ft pavement, deriving
2 ft of edge where the reality is nearer 11-12 ft lanes plus 5 ft of edge.

The error direction is safe — folding the shoulder into the lane makes the road
look *worse*, never better. A correction (clamp the lane at ~12 ft, treat the
remainder as edge space) is possible but must be a written, reviewed rule, not
an inference applied silently.

## Traffic volume

`ADTVolume` on 98% of segments. What it buys, on Whidbey:

| road | AADT |
|---|---|
| SR 525 | 8,000 - 14,000 |
| Bayview Rd | 2,800 - 4,048 |
| Deer Lake Rd | 1,264 - 2,357 |
| French Rd | 721 |

Four to seventeen times fewer vehicles. That is an objective, per-segment,
statewide measurement showing the side roads are safer — arrived at without any
appeal to a route line. The bike routes were right about these roads; they were
just never evidence. This is.

WSDOT's own AADT layer covers state routes with current counts and is the
matching half of the picture:
`data.wsdot.wa.gov/arcgis/rest/services/Shared/TrafficData/MapServer/1`
(4,815 sections, `AADT` + `ReportingYear`, 2025).

**Age is the weakness and must be shown.** County `ADTYear` runs 1940-2023:
54% are 2010 or newer, only 24% are 2018 or newer, and 12.6% are from 1977-78.
A count is not usable without its year next to it.

## The city-street gap, and what closes it

The road log covers **county-maintained** roads: 39,187 miles. Every Pierce
County row for the Puyallup corridor terminates at `at CITY LIMITS: PUYALLUP`,
and there is no row named `W PIONEER` anywhere in the state. City streets are
not in it, and no equivalent statewide city log exists — cities publish
individually (Marysville, Kent, Newcastle each with their own schema) or not at
all. Washington roads fall in three buckets and the road log covers one.

What partially closes the gap is a second WSDOT layer:

```
data.wsdot.wa.gov/arcgis/rest/services/FunctionalClass/
  WSDOTFunctionalClassData/MapServer/1     (Non-State Highway Functional Class)
```

16,811 features covering non-state roads, city and county alike, with two
fields worth having:

**`FHWARoadwayOwnerCode`** — who maintains it. Owner 4 (city/municipal) 4,924
mi; owner 2 (county) 14,434 mi. This is jurisdiction as an explicit attribute
rather than an inference from presence in the road log.

**`FederalFunctionalClassDesc`** — the FHWA classification. Nationally
standardised, which is the property that makes it generalise beyond
Washington. Measured against the CRAB counts, it tracks volume monotonically
across a 60x spread:

| federal class | mean ADT |
|---|---|
| Principal Arterial | 18,300 |
| Minor Arterial | 7,830 |
| Major Collector | 2,361 |
| Minor Collector | 725 |
| Local | 297 |

So on a city street with no traffic count, functional class is a defensible
stand-in. W Pioneer Ave, Puyallup resolves to *Urban Other Principal Arterial*,
owner 4 — the busiest non-freeway class, which is real evidence about a road we
otherwise knew nothing official about.

**Two cautions, because this has the shape of the trap we just climbed out of.**

Jurisdiction alone is weak and must never become a verdict. "City street" does
not mean calm: W Pioneer is a city street *and* a principal arterial. Treat
owner code as context and as data provenance, not as safety.

Functional class is a **proxy for volume, not a measurement of it**. Where a
real count exists, use the count. Where none does, class is a reasonable
fallback — but the card must say which of the two it is showing. A proxy
presented as a measurement is exactly how a route line came to look like a
safety claim.

Coverage limit: the layer carries **federally classified roads only** —
arterials and collectors, roughly 19,000 miles against 39,187 miles of county
road. Local residential streets are absent, which is tolerable, since those are
the ones that are calm by default.

## Speed limits: deliberately not imported

**The road log has no speed limit field**, so taking it costs us nothing here.
That is a feature. Counties publish speed separately (Island's
`Speed_Limit_Study`), and importing that layer actively hurt us: a road known
to be pleasant to ride was re-labelled from an estimated 35 mph to an actual
55 mph and started failing.

The reason is that a posted limit on a rural county road is often the statutory
default — 50 mph outside cities, RCW 46.61.400 — on a road where no limit was
ever set. It records the absence of a decision, not a measured hazard.

Volume is the better axis and it is the one we lacked. Do not import county
speed layers.

## Cost

**Runtime: negligible.** Two extra per-edge values (edge space, ADT band) at
roughly 2 bytes across 856k edges. A* stays O(1) per edge. Perhaps +1 MB on a
31 MB graph.

**Map colour requires baking.** `roadLevelExpr` is evaluated by MapLibre
against vector-tile properties; nothing computed in JS can reach it. If a
setting is ever to colour the map by volume or edge space, those values must be
tile properties. Bake the *measurements*, never a colour or a verdict — the
verdict is recomputed on the phone from the rider's rules.

**The real cost is the build:** conflating 115,582 CRAB segments onto OSM
geometry. Offline, one-time, and the span+bearing matcher from the county work
already does this. Match within 18 m of the way's own span, aligned within 40
degrees, and measure the matched portion of the way rather than the whole way.

## The two cards must agree, structurally

**Requirement: the road popup and the route-segment popup always show the same
information about the same road, and neither is affected by which map layers
are switched on.**

Layer independence already holds. The invisible click targets are forced
`visibility: 'visible'` with a null filter regardless of the display toggles
(`app.js` in `updateVisibility` and the `hitId` block), so turning a layer off
changes what is drawn and never what a popup can read.

Agreement does *not* hold structurally. Two hand-written adapters feed the same
verdict ladder from two different data shapes:

- `factsOf(n)` — tile and GeoJSON properties (`n.maxspeed_num`, `n.shoulder_width`)
- `routeSegFacts(s)` — worker segment messages (`s.mph`, `s.sh`, bitfields)

They already disagree on three inputs:

| fact | road card | route card |
|---|---|---|
| `prohibited` | real value | hardcoded `false` |
| `infraScore` | `n.baseScore` | hardcoded `1` |
| `facility` | `good_facility` bumps to >= 2 | no bump |

This is the drift that produced the "card says fail, map says pass" bug: two
adapters maintained by hand, one of them quietly stale. Adding three fields to
both widens that surface by three.

**Part of phase 1:** one shared card-model function that both paths call, and a
test asserting that the same road yields identical rows through both. The
requirement has to be structural rather than a matter of remembering.

## Order of work

1. Import and conflate. Show **ADT with its year**, **derived edge space** and
   **functional class** on the road and route detail cards, each labelled with
   its provenance. Build the shared card model first, so both cards read one
   source. Read-only: no routing weight, no rung, no map colour.
2. Field-test whether the numbers agree with roads the rider knows.
3. Only then decide what these measurements earn in the ladder.

Step 3 is a separate decision and is not pre-approved by this document.
