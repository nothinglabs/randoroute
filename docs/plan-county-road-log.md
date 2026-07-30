# Current plan: statewide road measurements

**Status: phase 1 built.** The three sources are imported, conflated and shown
on the road and route cards; nothing yet feeds a verdict, a colour or a route.
The mechanics now live in `docs/SAFETY-MODEL.md`; what remains here is the
reasoning and the measured outcome. Phase 2 is field testing, phase 3 an
undecided question.

## Three sources, one build step

| # | source | what it gives us | coverage |
|---|---|---|---|
| 1 | **CRAB certified county road log** | derived bail-out space, `ADTVolume` + `ADTYear` | 39,187 mi |
| 2 | **WSDOT Non-State Highway Functional Class** | `FHWARoadwayOwnerCode` (city vs county), FHWA functional class | ~19,000 mi |
| 3 | **WSDOT Traffic Counts (AADT)** | current counts on state routes | ~7,000 mi |

Together they took the app from measuring 9.2% of its road network to 35.4%.
Source 1 is the bulk of it and most of this document; sources 2 and 3 are
smaller adapters covering what 1 cannot reach. Measured results are below.

## Source 1: the CRAB county road log

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

### A matching defect, and what fixing it recovered

The first build's conflation rule required **every** sample point of a graph
edge to fall within 18 m of **one** source segment. The road log stores a road
as a run of short consecutive records, so no single record spans a graph edge,
and the match failed outright — with the nearest road-log line touching the edge
at zero distance:

```
samples 1/0/56 m      nearest source 0 m away, rejected
samples 1/3/261 m     nearest source 0 m away, rejected
samples 0/162/620 m   nearest source 0 m away, rejected
```

On Pioneer Way East that discarded 4.13 of 5.83 miles. Data already on disk.

A way now matches when the source layer's aligned segments **together** cover a
majority of five sample points, reporting the values of whichever single segment
covers most of it. Every contributing segment is still checked individually for
distance and bearing — stricter than the rule it replaces, which checked
alignment only at the midpoint.

Built and measured, not sampled: the network's traffic-count coverage rises from
**35.4% to 45.8%** and its bail-out-space coverage from **28.3% to 38.8%** —
**+9,847 and +9,908 miles** respectively. Larger than adding a whole new source
would give, out of data already fetched. (A 40,000-edge sample had projected
25,403 → 35,993 miles for the road log alone; the built graph reached 34,631,
and the fix also recovered functional-class and state-AADT matches the sample
did not account for.)

An intermediate version of the fix matched on the best *single* segment and
reached only 34.2%. It still rejected the fragmented case — five consecutive
records each covering one sample — which is precisely the case that prompted the
work. `scripts/test_road_match.py` caught that, and guards both directions:
a parallel road 25 m away and a 45° crossing must be refused, a way split across
five short records must be accepted.

The figures below predate this fix and describe the shipped graph.

### What it actually delivered

Measured on the built graph, not projected:

| | before | first build | after the matcher fix |
|---|---|---|---|
| road with a space metric | 8,721 mi (9.2%) | 26,745 mi (28.3%) | **36,653 mi (38.8%)** |
| road with traffic volume | 0 | 33,452 mi (35.4%) | **43,299 mi (45.8%)** |
| road with a functional class | 0 | 18,980 mi (20.1%) | 19,359 mi (20.5%) |
| county-reported paved shoulder | 0 | 3,489 mi (3.7%) | 4,600 mi (4.9%) |

An earlier estimate in this document put the space metric near 50% and volume
near half the network. That was wrong, and the reason is worth keeping.

**A third of the county road log is gravel.** Of its 38,778 miles: 28.4% GRV,
3.7% GRD and 1.9% UNI -- about 13,200 miles of unpaved county road, most of
which is not in our routing graph at all, because it is tagged as track or
falls outside the drivable classes we keep. The projection treated all 39,187
miles as conflatable.

Against the mileage that *can* match -- 25,599 miles of paved county road (BST,
ACP, HMA, PCC and the rest) -- the conflation returned 26,745 miles. Slightly
more, because some gravel roads are mapped in OSM as ordinary unclassified
roads. So the matcher did not underperform: it captured essentially all of the
paved county network, and the shortfall against the projection is entirely
roads we do not route on.

Functional class matched 18,980 of its ~19,000 source miles, and WSDOT AADT
7,146 of ~7,000. Both effectively complete.

Two other things stayed true as predicted:

- **It is bail-out space, not ridable shoulder.** The county's explicit paved
  shoulder reaches only 3.7% of the network, so ridable-shoulder coverage barely
  moves. The jump is entirely in the "somewhere to go when a truck comes past"
  number.
- **3,461 of the 26,745 miles carry the lane clamp**, and read conservatively
  until that rule is validated in the field.

The graph grew 31.34 MB to 31.89 MB -- 556 KB for all of it.

What remains uncovered is city streets and local residential roads, plus the
unpaved county network. Functional class fills part of the first for arterials;
for the rest, calm-by-default remains the assumption.

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

## Source 4 candidate: FHWA HPMS

Measured against the improved baseline, not the stale one. `scripts/build_hpms.py`
fetches it; `docs/PORTING-TO-ANOTHER-STATE.md` explains why it is the most
portable source in the project.

```
would gain                        5,699 mi   6.0%
network with a count afterwards  48,998 mi  51.8%
```

Only ~900 miles of its original 6,610 were absorbed by the matcher fix, so the
two really are complementary: HPMS contributes city arterials the county road
log structurally cannot reach.

| class | now | with HPMS |
|---|---|---|
| Principal arterial | 77.9% | **95.2%** |
| Minor arterial | 60.0% | **94.8%** |
| Major collector | 68.3% | 85.7% |
| Minor collector | 46.3% | 46.6% |
| Local street | 30.9% | 31.0% |

The case for it is the arterial rows, not the 6% headline. A busy arterial with
no shoulder is where traffic volume changes a cycling decision, and this takes
both arterial classes to roughly complete. What it leaves uncovered is local and
minor-collector road, where calm-by-default is already the assumption.

Two things must be settled before adopting it. It needs its own provenance tag —
`(HPMS 2018)` — because its non-state counts are modelled rather than measured,
and it needs a tiebreak against the county road log where both land. On the
27,279 edges where both already fall, the median HPMS/CRAB ratio is 1.00, so
neither is systematically better; recency is the only tiebreaker with a reason
behind it.

**Adopted.** Built and measured, the projection held exactly: 48,998 miles with
a count, 51.8%. Coverage by class afterwards, with HPMS also supplying the
functional class for state routes that WSDOT's non-state layer omits:

| class | miles | with count |
|---|---|---|
| Interstate | 973 | **100%** |
| Minor arterial | 5,302 | **94.7%** |
| Principal arterial | 3,346 | **92.1%** |
| Major collector | 14,668 | **87.1%** |
| Freeway/expressway | 2,239 | 58.0% |
| Minor collector | 30,809 | 46.6% |
| Local street | 37,182 | 30.9% |

Everything above minor collector is now between 87% and 100% covered. The 68,000
miles still without a count are local and minor-collector road, which no agency
counts and where calm-by-default remains the assumption.

### Which count wins

Four sources can describe one road, so the choice is a stated rule rather than
an accident of evaluation order:

> **The most recent count wins. Where the years tie, a measured count beats a
> modelled one. A count with no recorded year never displaces a dated one.**

Recency decides because neither source is systematically better. On the 27,279
edges where the county road log and HPMS both land, the median ratio between
them is exactly 1.00 — scatter, not bias. With nothing to separate them on
accuracy, the count taken closer to today describes the road today. An undated
count cannot be shown with a year, so it must not push aside one that can.

`scripts/test_count_tiebreak.py` pins all eleven cases.

## Source 2: the city-street gap, and what closes it

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

### Import rules for this layer

Decoded from the live service, not assumed.

**Drop `FederalFunctionalClassCode` 92-96 outright.** These are `Proposed`
classifications — "Proposed Urban Minor Arterial", "Proposed Rural Major
Collector" — roads not built, or not yet reclassified. This is Island County's
`(Planned)` bike routes in a new costume, and it caused a real bug last time.
Keep codes 1-7 only.

**`WSDOTUrbanRuralCode` is not a boolean.** It is an urban-area identifier:
1-67 name individual urbanized areas (1 is by far the largest), and **98 and 99
mean rural**. It therefore says *which* urban area, which is more than our own
flag knows.

**Our Census flag stays the sole driver of the urban speed rule.** WSDOT's
urban/rural distinction descends from the FHWA *adjusted* urban area boundary:
the Census line, smoothed to follow identifiable features and extended to
capture growth, then approved by FHWA — the boundary that federal-aid
eligibility keys off, and generally larger than the Census one. Ours is a
straight point-in-polygon against Census 2020 (`is_urban_edge`). Same ancestry,
different line, disagreeing at the fringes. Do not let a second definition of
"urban" in through the back door; take the class code and treat the
`Urban`/`Rural` prefix in the description as descriptive text.

`WSDOTUrbanRuralCode` is still worth carrying as a cross-check: where it says
rural and our Census polygon says urban, that disagreement should be visible
rather than silently resolved.

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
