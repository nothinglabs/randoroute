# Nevada routing audit

Twenty real trips across Nevada, run through the real router and scored for the
shapes a rider calls wrong. The format and thresholds are
`docs/ROUTING-AUDIT.md`'s; read its "Known non-findings" section before calling
any failure a router defect.

This audit exists to answer one question the Nevada import was commissioned to
settle: **does a freshly imported state produce good routes with no manual
intervention?** So every finding carries a third class alongside BUG/EXPLAINABLE
and ROUTER/DATA — **NEVADA DATA** (this state's own sources), **IMPORT PROCESS**
(the pipeline or the documents), or **ROUTER** (shared logic).

Run against `maps/nevada` graph `sha-63fd4ab49fd0`, 2026-08-21, on app defaults
lifted from `app.js` including `directProbeWeights`.

```bash
node scripts/audit_route.mjs maps/nevada/audit/routes.json maps/nevada/audit
python3 scripts/audit_plot.py maps/nevada/audit/<id>.json
```

Raw JSON and 111 option plots are committed in `audit/`.

## The one number this audit is really about

On roads at 45 mph and above — the only place the shoulder rung decides a
verdict — Nevada's fast network splits like this, measured on the shipped
graphs of all three states:

| | Nevada | Oregon | Washington |
| --- | ---: | ---: | ---: |
| road miles at 45+ mph | 7,682 | 12,641 | 13,508 |
| bike lane or better, shoulder moot | 7.2% | 5.3% | 2.1% |
| passes on a **measured** shoulder ≥ 4 ft | 23.4% | 38.8% | 40.0% |
| fails on a **measured** shoulder < 4 ft | **1.1%** | 15.3% | 14.8% |
| fails on **no measurement at all** | **68.2%** | 40.5% | 43.1% |

**98.4% of Nevada's failing fast-road mileage fails on the absence of evidence,
not on evidence of absence** (5,239 of 5,327 miles). In Oregon that figure is
72.6% and in Washington 74.4%. An untagged shoulder reads as 0 ft by design —
`safety-model.js` says so in as many words, and it is the right default — and
Nevada is where that default meets a state with almost no shoulder data:
NDOT's whole inventory is 1,226 current spans and OSM carries a `shoulder*` tag
on 595 of 505,189 highway ways.

Everything in the ROUTER column below is downstream of that row.

## Summary

| # | Finding | Verdict | Class | Source |
| --- | --- | --- | --- | --- |
| N1 | Mesquite → Bunkerville returns "no route" for a 4.7-mile trip: a bikepacking relation marks SR 170 as an MTB trail, and it is the only Virgin River crossing | **BUG** | ROUTER | shared logic + NEVADA DATA |
| N2 | The recommendation is 1.0–2.2× the shortest option offered, and on four probes every failing metre it is paying to avoid comes from the needs-space rung, which 68% of the state fails for want of a shoulder measurement | **EXPLAINABLE, worth tuning** | ROUTER | NEVADA DATA |
| N3 | The Tahoe-Pyramid Bikeway routes at 100.6 mi against a published 37.9 mi, 14% on corridor | **BUG** | DATA | NEVADA DATA |
| N4 | `verify_against_routes.mjs` and `verify_corridor_chain.mjs` — the two tools the porting method points an importer at — crashed on every state before printing a line | **BUG** | TOOLING | IMPORT PROCESS |
| N5 | `verify_corridor_chain.mjs` reported U.S. Bicycle Route 50 SEVERED on a hop whose two ends are the same place | **BUG** | TOOLING | IMPORT PROCESS |
| N6 | `scripts/arcgis.py` served one layer's rows to another layer, silently, and it looks exactly like "the state does not publish this" | **BUG** | TOOLING | IMPORT PROCESS |
| N7 | `build_compressed_overlays.mjs` rewrote two other states' committed artefacts during this import | **BUG** | TOOLING | IMPORT PROCESS |
| N8 | Winnemucca → Golconda rides 16.8 mi of Interstate because there is no parallel road in OSM; without freeways the answer is 59 mi | EXPLAINABLE | DATA | NEVADA DATA |
| N9 | Incline Village → Stateline is 51.5% failing on the only road there is, and the alternatives are 75+ miles around the lake | EXPLAINABLE | DATA | NEVADA DATA |
| N10 | Red Rock, Reno → Fallon, Ely → Baker: large detour factors on the sparsest network in the country, all correct | EXPLAINABLE | — | NEVADA DATA |
| N11 | Las Vegas → Pahrump, Elko → Spring Creek, Boulder City → Hoover Dam, Reno → Sparks: the corridors that were supposed to be hard, all clean | CLEAN | — | — |

Counts, by the three-way class the commission asked for:

- **NEVADA DATA — 5** (N2 root cause, N3, N8, N9, N10)
- **IMPORT PROCESS — 4** (N4, N5, N6, N7)
- **ROUTER — 2** (N1, and the pricing half of N2)

The split is the product of this exercise and it is worth stating plainly:
**every defect that belongs to the router or the pipeline was in the
scaffolding around the import, not in the routing.** The routing itself was
wrong once, on a mechanism (MTB relation membership) that is right for
singletrack and wrong for a state highway. Everything else the audit flagged is
Nevada being Nevada.

## The 20 routes

`x` is `detourFactor`; `back` is `backtrackM`; `fail%` is the failing share of
the shortest option offered; `star` is how many times the shortest the
recommended option is.

| id | trip | crow | shortest | fail% | star | x | back | verdict |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| lv-strip-fremont | Bellagio → Fremont St | 4.3 | 4.8 | 61.6% | 1.45× | 1.11 | 68 | N2 |
| lv-unlv-summerlin | UNLV → Downtown Summerlin | 11.1 | 14.4 | 23.8% | 1.27× | 1.30 | 148 | N2 |
| lv-henderson | Las Vegas → Henderson | 13.2 | 14.5 | — | 1.17× | 1.10 | 69 | CLEAN |
| lv-airport-nlv | N Las Vegas → the airport | 8.1 | 8.9 | 67.0% | **2.20×** | 1.10 | 43 | N2 |
| lv-wetlands | Downtown → Wetlands Park | 8.3 | 10.0 | 5.5% | 1.28× | 1.20 | 153 | CLEAN |
| lv-redrock | Summerlin S → Red Rock | 5.5 | 7.1 | 39.0% | 1.24× | 1.29 | 224 | N10 |
| henderson-boulder | Henderson → Boulder City | 9.1 | 11.3 | 1.8% | 1.05× | 1.24 | 66 | **CLEAN** |
| boulder-hooverdam | Boulder City → Hoover Dam | 5.9 | 8.0 | 5.3% | 1.27× | 1.35 | 190 | **CLEAN** |
| reno-sparks | Reno → Sparks | 3.1 | 3.5 | 5.1% | 1.21× | 1.11 | 35 | **CLEAN** |
| reno-carson | Reno → Carson City | 25.0 | 32.5 | 21.5% | 1.23× | 1.30 | 55 | N2 |
| carson-spooner | Carson City → Spooner Summit | 8.8 | 13.6 | 7.6% | 1.01× | 1.54 | 580 | CLEAN |
| incline-stateline | Incline Village → Stateline | 19.9 | 25.0 | 51.5% | 1.00× | 1.26 | 159 | N9 |
| carson-minden | Carson City → Minden | 14.7 | 15.3 | 29.7% | **1.76×** | 1.04 | 0 | N2 |
| elko-springcreek | Elko → Spring Creek | 10.9 | 14.0 | 22.4% | 1.17× | 1.29 | 254 | **CLEAN** |
| winnemucca-golconda | Winnemucca → Golconda | 12.9 | 16.8 | 40.9% | 1.00× | 1.30 | 8 | N8 |
| ely-mcgill | Ely → McGill | 12.4 | 13.1 | 12.6% | 1.16× | 1.05 | 4 | CLEAN |
| mesquite-bunkerville | Mesquite → Bunkerville | 4.0 | — | — | — | — | — | **N1 BUG** |
| lv-pahrump | Las Vegas → Pahrump | 46.1 | 64.6 | 36.6% | 1.26× | 1.40 | 1,253 | N2 |
| reno-fallon | Reno → Fallon | 55.2 | 92.7 | 10.7% | 1.12× | 1.68 | 10,898 | N10 |
| ely-baker | Ely → Baker | 44.2 | 62.4 | 15.7% | 1.01× | 1.41 | 1,084 | N10 |

18 of 20 had at least one flagged option; 1 returned nothing.

---

## Findings

### N1 — "No route exists" between two towns four miles apart, because a bikepacking relation marks a state highway as a mountain-bike trail (BUG — ROUTER)

**Repro:** `nevada`, `[-114.06714, 36.80356] → [-114.12677, 36.77177]`, Mesquite
to Bunkerville. Returns `No route exists on the rideable network between these
points.` The tool's own diagnosis prints *"both endpoints are reachable — the
failure is something else, look closer"*, which is the case
`docs/ROUTING-AUDIT.md` says is the only kind that ever is a finding.

**What is actually there.** An unconstrained breadth-first search over the
directed arcs, ignoring every cost and rule, finds a path in **69 edges and
7.8 km**. Both endpoints are in the giant component. So the network is not
severed; something declines to use it.

**The mechanism, confirmed by probe.** Re-run with `allowMtbTrails: true` and
the trip is **4.7 miles**. The blocking run is 2,307 m of `Riverside Road`
carrying `eOfficial & EDGE_MTB` — and Riverside Road here is **SR 170**, a
paved two-lane state highway with `cycleway:both=shoulder`, `smoothness=good`,
and a concrete bridge over the Virgin River. It carries no `mtb` tag of any
kind.

The MTB marking comes from relation membership.
`build_graph.collect_mtb_route_members()` marks every way member of any
`route=mtb` relation, and OSM relation **8643414 — "The Plateau Passage"**, a
long-distance IMBA / bikepacking.com route, includes three Riverside Road ways among
its 104 members. A bikepacking route follows paved highways for long stretches
by design. So a mapper documenting a long-distance ride deleted a state highway
from the routable network for every rider on default settings.

**Blast radius, measured on all three shipped graphs** (lesson B6):

| state | MTB-marked mileage on ordinary road | paved | FHWA class 1–4 |
| --- | ---: | ---: | ---: |
| Nevada | 18.1 mi | 9.5 mi | 9.9 mi |
| Oregon | 6.6 mi | 1.8 mi | 6.6 mi |
| Washington | 5.8 mi | 0.5 mi | 5.8 mi |

The mileage is trivial in every state and **the consequence is not**, because a
bikepacking relation follows a corridor precisely where the corridor is the only
option. 8.1 of Nevada's 18.1 miles are Riverside Road, and those 8.1 miles
disconnect Bunkerville (pop. 1,069) from Mesquite (pop. 24,001) entirely. The
same defect exists in Oregon and Washington today — "Mormon Grade Road, 4.3 mi"
appears in both, from one relation crossing the state line — and has simply not
yet landed on a road that was somebody's only way through.

**Not fixed here.** The repair is a judgement about shared classification, which
this import is not allowed to make. The narrow version: apply relation-derived
MTB marking only to ways whose `highway` is a path class, and require a
way-level `mtb*` tag before marking anything a car drives on. That is a
one-predicate change in `is_mountain_bike_way()` and it would touch 18.1 miles
in Nevada, 6.6 in Oregon and 5.8 in Washington.

**And a documentation defect it exposes.** `docs/ROUTING-AUDIT.md`'s known
non-findings table has three kinds — island, one-way area, pinprick — and this
is a fourth: **rule-excluded link**. It is the kind that is a finding, it is
invisible to the existing diagnosis (which only asks whether each endpoint is
reachable), and the message a rider sees says the network has no route when the
truth is that their settings exclude the only one. Recorded below as N1b.

### N1b — the "no route" diagnosis has no fourth kind (BUG — ROUTER, small)

`audit_route.mjs` classifies a failure as island / one-way area / pinprick and
otherwise prints "look closer". A rule exclusion on a cut edge produces exactly
that message, and finding the cause took an unconstrained BFS, a flag dump and
a tag lookup. A cheap fourth check — re-run the search with every optional
exclusion lifted, and if it succeeds, name the rule — would have said
"`allowMtbTrails` excludes the only link" in one line.

### N2 — the recommendation pays a large detour to avoid roads that fail for lack of a measurement (EXPLAINABLE, worth tuning — ROUTER, cause NEVADA DATA)

**What happens.** Across the 20 routes the starred option runs 1.00–2.20× the
shortest offered. The extremes:

| trip | shortest | star | extra time | failing metres avoided |
| --- | ---: | ---: | ---: | --- |
| N Las Vegas → the airport | 8.9 mi | 19.6 mi (**2.20×**) | +51 min | 9,607 → 1,196 m |
| Carson City → Minden | 15.3 mi | 27.0 mi (**1.76×**) | +61 min | 7,317 → 430 m |
| Las Vegas Strip → Fremont St | 4.8 mi | 7.0 mi (1.45×) | +10 min | 4,784 → 1,452 m |
| Las Vegas → Pahrump | 64.6 mi | 81.1 mi (1.26×) | **+108 min** | 38,026 → 7,360 m |

The priced star is behaving exactly as specified — `time + 1 s per failing
metre` — and in every case above it picks the lowest-priced option in the pool.
Nothing is broken. The input is what is extreme: **67.0% of the shortest route
from North Las Vegas to the airport is failing road**, and 36.6% of the direct
Las Vegas → Pahrump ride.

**The measurement that settles what that failing mileage is.** Re-running four
of these with `minShoulder: 0` — which removes the shoulder rung and nothing
else:

| trip | failing metres, default | with the shoulder rung off | star detour |
| --- | ---: | ---: | --- |
| Las Vegas → Pahrump | 38,026 m | **0 m** | 1.26× → 1.08× |
| Carson City → Minden | 7,317 m | **0 m** | 1.76× → 1.06× |
| N Las Vegas → the airport | 9,607 m | **0 m** | 2.20× → 1.47× |
| Incline Village → Stateline | 20,690 m | **0 m** | 1.00× → 1.00× |

**Every failing metre on all four routes is the `needs-space` rung**, and
turning off its shoulder half removes all of it. Nothing on these routes fails
for a reason the shoulder could not have answered — not the absolute speed
ceiling, not a prohibition, not a dismount. Be precise about what that does and
does not show: `minShoulder: 0` makes `shoulderFails` false everywhere, so it
disables the rung whichever of its three triggers fired (speed, lane count or
traffic volume). What it isolates is that the rung is the whole story, and the
statewide split says what the rung is running on — 23.4% of fast-road miles
pass on a measured shoulder, 1.1% fail on one, and 68.2% fail on no measurement
at all. So the overwhelming majority of what the router is paying an hour and
48 minutes to avoid on the Pahrump ride is road nobody has measured.

**Why this is EXPLAINABLE and not a bug.** The pessimistic reading is
deliberate and correct: `safety-model.js` says *"no data" and "no shoulder"
cannot be distinguished from the rider's seat*, and the optimistic reading once
let a 55 mph road with no recorded shoulder pass on an absence of evidence.
Nevada does not make that reasoning wrong. It makes it load-bearing across two
thirds of the state.

**What is worth tuning, and it is not the shoulder rule.** Lesson E3 priced the
recommendation at one second per failing metre — "avoiding a mile of failing
road is worth up to about 27 minutes of extra riding, and no more" — and that
number was calibrated in Washington, where 74.4% of failing fast mileage is
also unmeasured but the absolute quantity per route is far smaller. The
question Nevada raises is whether a failing metre whose failure rests on *no
measurement* should price the same as one that rests on a surveyed 0 ft. It is
a live question rather than an answer: pricing them differently would
re-introduce, through the back door, exactly the optimism the pessimistic
reading exists to prevent. It needs a rider, which is why readiness stops at 7.

### N3 — the Tahoe-Pyramid Bikeway routes at 100.6 miles against a published 37.9 (BUG — DATA)

**Repro:** `node scripts/verify_against_routes.mjs nevada` then
`scripts/verify_against_routes.py`. Endpoints `[-120.0086, 39.4518]` (Verdi, at
the California line) → `[-119.4917, 39.5661]` (west of Fernley), the two ends of
the relation's Nevada portion.

**What the router returns.** 100.6 miles with **14% of it on the published
corridor**, running *south* out of Reno on Carson–Reno Highway and Bowers
Mansion Road to Carson City, then east and north on USA Parkway and Lincoln
Highway — a detour of some forty miles around the Virginia Range, instead of
following the Truckee River east through the canyon.

**Localised by splitting the corridor in half.**

| hop | crow | shortest | x |
| --- | ---: | ---: | ---: |
| Verdi → Sparks (west half, along the river through Reno) | 12.5 mi | 14.4 mi | 1.15 |
| **Sparks → Wadsworth (the Truckee Canyon)** | 25.8 mi | **58.2 mi** | **2.25** |

The west half is fine. The canyon is where it breaks, and the router's
58-mile answer goes *north* out of Sparks on Pyramid Way to Nixon on Pyramid
Lake and back south on SR 447 — around the Pah Rah Range.

**Diagnosis: a legal severance in the source, correctly reported.** The Truckee
Canyon carries the river, the railroad and I-80, and nothing else. In the
extract, I-80 through the canyon is **72 ways tagged `bicycle=yes` and 34 tagged
`bicycle=no`** — the metro-adjacent section is closed to bicycles, and 34 ways
of prohibition in the middle of the only line severs it. So there is no legal
bicycle route east out of Reno/Sparks through the canyon at all, and the 58-mile
loop is the honest answer. The Tahoe-Pyramid Bikeway is being built through this
canyon for exactly this reason, and the OSM relation covers the intended
corridor rather than a continuously rideable one.

This is Nevada's version of Oregon's Columbia Gorge finding (O2 in
`docs/ROUTING-AUDIT.md`), and it fails the same way: the shape is correct and
the rider is given no signal that the corridor they named is not continuous.

**Not patched with synthetic geometry**, and no supplemental route source was
added: the porting method is explicit that discovery by an importing agent is a
finding for human review, not permission to import geometry.

### N4 — the two tools the porting method points an importer at crashed on every state (BUG — TOOLING, IMPORT PROCESS)

`maps/README.md` names the verification report as the level-5 gate and
`scripts/verify_against_routes.mjs` is what produces its evidence. It threw
`ReferenceError: ADVANCED_ROUTE_OPTION_DEFAULTS is not defined` before printing
a line — on Washington and Oregon as much as on Nevada. Both it and
`verify_corridor_chain.mjs` carried a hand-rolled copy of `app.js`'s
`DEFAULT_RULES` lifter that did not know `DEFAULT_RULES` had grown a reference
to another constant. `scripts/audit_route.mjs` lifts both, in order, and says in
a comment why; `scripts/testlib/harness.mjs` exports `appDefaultRules()` doing
the same. Three copies, one of them right, and AGENTS.md already says not to
rebuild what the harness owns.

**Fixed**: both now call `appDefaultRules()`.

### N5 — a false severance on the state's most important corridor (BUG — TOOLING, IMPORT PROCESS)

`verify_corridor_chain.mjs` reported **U.S. Bicycle Route 50 SEVERED**, on:

```
NO ROUTE  -117.8543,39.2736 -> -117.8543,39.2736 (5.3 mi along the corridor):
Start and destination snap to the same road point.
```

The two ends of that hop are the same place. `chain()` stitches a relation's
parts into one ribbon by nearest endpoint, and USBR 50 arrives as 497
disconnected parts across 400 miles, so the walk can leave a mark, follow a
branch and return to within metres of where it started while the along-corridor
counter reads five miles.

**Fixed**: a hop whose ends are under 25 m apart is skipped and *counted* in the
output, because "checked and fine" and "could not be checked" are different
answers. With the guard, USBR 50's worst hop over 24 tested hops across Nevada
is **1.0×** — the strongest verification result in this import, and it was
hidden behind a tool artefact. This is lesson A7 on the import's own work.

### N6 — an ArcGIS page cache that serves one layer's rows to another (BUG — TOOLING, IMPORT PROCESS)

`scripts/arcgis.py` cached a page as `0000000.json` with no reference to the
layer it came from. An adapter reading several layers of one service into one
cache directory — which is the natural way to write one — served every layer
after the first the **first layer's rows**. The `got < total` guard cannot see
it, because a big layer's pages overfill a small layer's total and `got` ends up
*larger* than `total`. The visible symptom is an empty output file, which reads
exactly like "this state does not publish that". Washington's fetchers each use
their own cache directory and Oregon's adapter builds a per-layer subdirectory
by hand, so the trap had never fired.

**Fixed**: cache names carry a digest of the layer URL, filter and field list.

### N7 — a state import rewrote two other states' committed artefacts (BUG — TOOLING, IMPORT PROCESS)

`build_compressed_overlays.mjs` walks the registry, so running it once during
this import left Oregon's and Washington's `.gz` overlays modified in
`git status` — byte-different, content identical. The porting method lists it
beside the tools that "take a state or a bounds now", which it did not.

**Fixed**: it takes an optional state id, and the document says which form to
use when.

### N8 — Winnemucca → Golconda rides the Interstate, correctly (EXPLAINABLE — DATA)

16.8 miles against a 12.9-mile crow, 40.9% failing, on
`Dwight D. Eisenhower Highway` — I-80. `allowFreeways` defaults on in the app,
so this is within the rider's rules.

**Checked, not assumed, twice.** Re-run with `allowFreeways: false` and the
shortest answer is **59.0 miles**, which proves the 16.8-mile answer really is
using the Interstate rather than a similarly-named frontage road. And OSM has no
mapped parallel route between the two towns: `Old Victory Highway`, old US 40,
exists in Pershing County to the west and not here. The network is genuinely one
line.

**What is not claimed:** whether riding I-80 there is legal. The extract tags
I-80 in this stretch as 25 ways `bicycle=no`, 17 `bicycle=yes` and 11 untagged,
and the router used the permitted ones — so the graph is following the tags
faithfully, and whether the tags follow the signs is a roadside question. A
rider should check it before this counts as verified.

### N9 — Incline Village → Stateline is half failing on the only road there is (EXPLAINABLE — DATA)

25.0 miles, 1.26× the crow, and **51.5% of it failing** — NV 28 and US 50 down
Lake Tahoe's east shore, with no shoulder measurement. The router stars it
anyway, correctly, because the five alternatives it offers are 75–78 miles
around the entire lake with a 19.8 km backtrack. This is the priced star
working: a 51.5%-failing 25-mile ride still prices below a zero-fail 76-mile
one. Note that the Tahoe East Shore Trail exists here as built infrastructure;
it is 3 miles of a 25-mile corridor.

### N10 — large detour factors on the sparsest network in the country, all correct (EXPLAINABLE)

| trip | x | the constraint |
| --- | ---: | --- |
| Reno → Fallon | 1.68 | The direct line is the Truckee Canyon, which is I-80 with no parallel road. Every option goes south through Washoe Valley to Carson City and east on US 50 — which is the ride locals do. The 10.9 km "backtrack" is that southward leg. |
| Ely → Baker | 1.41 | US 6/50 over two 7,000 ft summits with one junction in 62 miles. Nothing else exists. |
| Summerlin → Red Rock | 1.29 | NV 159 out of the valley; options E and F at 28.6 and 32.6 miles are the fully-matching profile going the long way round the entire escarpment, correctly not starred. |
| Carson City → Spooner Summit | 1.54 | 2,200 ft of climbing in 12 miles on US 50; the 580 m backtrack is the switchback out of Carson City. |

### N11 — the corridors that were supposed to be hard, all clean (CLEAN)

These were nominated as pinch points before anything was built, and they behave:

- **Boulder City → Hoover Dam**: 8.0 mi shortest, star at 10.2 mi with **zero**
  failing metres and 150 m of dismount, on the River Mountains Loop Trail into
  the Historic Railroad Trail, the Railroad Tunnel Trail and the Hoover Dam
  Access Road. No option offered uses the US 93 bypass bridge.
- **Henderson → Boulder City**: star at **1.05×** the shortest with zero failing
  metres. The River Mountains Loop Trail is fully in the graph.
- **Reno → Sparks**: star at 4.2 mi, zero failing metres, on the Truckee River
  path. No seam.
- **Elko → Spring Creek**: star at 16.4 mi against 14.0, failing 5,043 → 225 m.
  The sparse northeast routes.
- **Las Vegas → Pahrump**: 64.6 mi over Mountain Springs on NV 160, no freeway.

## What was not checked

- **No route was ridden.** Every verdict above is about the shape of a route
  and the provenance of a number, never about whether a road is pleasant.
- **The Las Vegas valley has no published bicycle route relation at all**, so
  the level-5 method — compare the router against a corridor known to be good —
  could not be applied to three quarters of the state's riders. Eight of these
  twenty trips are the substitute, and they are weaker evidence: they show the
  network connects and that RTC's facilities reach the graph, not that the
  router's answer resembles what a local rides.
- **The 0.2 s/m ride-quality term** in the recommendation price is not modelled
  in the price column above, which is `time + fail + dismount` only. The star is
  the router's, not this document's; where the two disagree the router is right
  and the column is incomplete.
