# Porting lessons

`PORTING-TO-ANOTHER-STATE.md` is the method: what to fetch, what to build, what
to configure. This file is the part that method cannot carry — **why the numbers
are the numbers, and what it looks like when a state is imported wrong.**

Almost none of it is guessable from the source. Code shows you a fix and never
the symptom, and a threshold in a constants block never says which of the two
obvious values was tried first and what it did to a real road. That is what got
mined out of this repository's commit history to build this file.

## How to use it

**This is not the entry point.** `docs/PORTING-TO-ANOTHER-STATE.md` is, and its
"Start here" section sequences the work and names the test that proves each
stage. This file is the companion you read alongside it.

Read it once before starting a state, and again when something looks wrong. The
failure descriptions are the point: most of these presented as something that
did not look like a data problem at all — a router detouring 45 miles, a card
disagreeing with the line under it, traffic circles rendering as arrowheads.

## Rules of this document

1. **Every current-fact claim is verified against the code as it stands**, not
   taken from the commit that introduced it. Several values in this project have
   moved two or three times; the commit that best explains a number is usually
   not the commit that set its current value.
2. **Anything that cannot be verified is labelled `[history]`** and is evidence
   about a decision, not a statement about the code today.
3. **Every lesson carries its evidence** — a commit hash and, where one exists,
   the measurement that settled it. A lesson with no measurement behind it says
   so.
4. **Lessons have stable IDs.** They are referenced from `region.json` notes,
   from `STATUS.md` files and from each other. Never renumber; retire an ID
   rather than reuse it.

## Lesson format

Each lesson is an addressable unit:

> **ID — one-line rule.**
> *What happened* — the failure as it presented.
> *Why* — the mechanism.
> *Evidence* — commit, measurements.
> *Travelled* — a per-state ledger. This is the whole reason lessons have IDs:
> the next state either confirms a lesson generalises or discovers it was an
> artefact of one agency's data. Both outcomes are worth recording.

`Travelled` carried `no second state yet` throughout until **Oregon was imported
in August 2026** by an agent working from these documents alone. Every lesson
now has an Oregon line: held, did not apply, or was not exercised. Three did not
travel and those are the valuable ones — **C2** (a severance is not always an
unmissable ratio), **D7** (the shoulder inference has no input in a state with
no county road log) and **B4**'s population (650 shoulder-tagged ways in the
whole of Oregon). Read those first.

---

# A. Sources, and what a source is claiming

### A1 — A DOT is not one publisher. Classify every layer before deciding what may read it.

*What happened.* Two agency layers appeared to confirm each other about the same
road's bike facility. They were not two sources: one was a derived analysis
product that had photocopied the other's facility field on the date it was
built.

*Why.* A derived product ships **copies of its inputs**, and a copy is
indistinguishable from a second, independent source unless you have classified
the layers first. Treating it as corroboration doubles the apparent confidence
in a number that has exactly one origin — and freezes it at the analysis date.

*The rule.* Sort every layer into **inventory / registry / derived analysis /
counts** before wiring it to anything. Precedence, once classified:

- OSM tags beat agency inventories (a tag is a mapper who looked at that road)
- registries beat analysis copies
- derived ratings may only **caution**, never pass or fail on their own
- measured counts beat modelled ones

*Evidence.* `038d771`, `820bf70`. The case in hand was WSDOT BLTS's facility
field versus the Active Transportation registry.

*Travelled.* Washington is the origin.

**Oregon: held, and measurably.** ODOT's Bicycle Level of Traffic Stress layer
is the same shape as WSDOT's -- a derived analysis carrying copies of the
shoulder, speed, lane-count and facility inventories it was built from.
`scripts/build_odot.py` reads the rating from it and every other fact from the
inventory that owns it, joined by linear reference, and prints the drift:
**7.1% of 73,575 segments disagree with the shoulder inventory by more than
1 ft, 3.3% with the speed inventory by more than 5 mph, and 12.0% of 35,890
disagree about the facility type.** Reading the photocopy would have shipped
stale data on roughly one state-highway segment in ten.

### A2 — State agency traffic layers stop at the state route system and at the city line.

*What happened.* W Pioneer Ave in Puyallup had no traffic count. Chasing it
found zero WSDOT AADT sections within 100 m; the two nearby hits were SR 512 and
SR 162 *crossing* it, correctly rejected by the matcher's bearing test.

*Why.* Both WSDOT traffic layers are keyed to a StateRouteNumber. The county
road log stops at the city line. Between them, city streets — most of where
people actually ride — have nothing.

*Evidence.* `9a83c7b`.

*Travelled.* Washington is the origin. **Expect this to generalise**; it is a

**Oregon: held, and worse than Washington.** ODOT's AADT layers are keyed to its
highway linear reference, and there is no county road log at all -- Oregon has
no CRAB equivalent. Measured on the shipped graph: **95.2% of principal-arterial
miles carry a count and 0.1% of local-street miles do** (Washington: 76.5% and
23.4%). The prediction that this generalises is confirmed; the *size* of the
hole is a per-state fact and Oregon's is much bigger.
consequence of how state DOTs are funded and scoped, not of Washington.

### A3 — FHWA HPMS is the one nationally uniform volume source, and it exists for every state.

*What happened.* It was the only source found anywhere with traffic volume for
city streets.

*Evidence.* `9a83c7b`, `3e56c1c`, `a66388f`. Washington: 129,911 sections, 99.4%
with AADT, **23,413 city-owned sections every one of which carries a count**.
Sampled along the road that started the search it returns 10,925 for W Pioneer
Ave and 13,222 for E Pioneer Ave.

*Three caveats that must travel with the numbers, not be discovered later:*

- The hosted release is a **specific year** (2018 for Washington) and says so.
- Non-state AADT in HPMS is frequently **modelled rather than counted**. It is an
  official estimate and cannot be pooled with a tube count under one label.
- HPMS sections carry **no route name and are short**, so they must be matched
  geometrically against chunked ways — see B1.

HPMS also carries speed limits. They are deliberately **not** used here, for the
same reason county speed layers were rejected.

*Travelled.* Washington is the origin. The service URL pattern is per-state and

**Oregon: held.** `https://geo.dot.gov/.../Oregon_2018_PR/FeatureServer/0` exists
and returns **67,861 sections with a count**. The caveat about the year travelled
too and needed stating rather than assuming: Oregon's hosted release is also
2018, but 2016, 2017 and 2019-2022 all return "Service not found", so the year
has to be probed per state. `scripts/build_hpms.py` now takes `--state` and
`--year`; before this import it had them as a module constant, despite
`PORTING-TO-ANOTHER-STATE.md` saying it "needs only the state name and year
changed".
documented in `PORTING-TO-ANOTHER-STATE.md`.

### A4 — A measurement, a derived figure and a proxy are three different claims. Never flatten them.

*The rule.* They get different labels in the UI and different precedence in the
model. A card reads `10,925/day (HPMS est 2018)` where a county figure reads
`2,357/day (county 2016)`.

*Why it matters.* Letting those two read alike repeats the mistake that once made
a signed bike route look like a safety guarantee (see D1).

*Evidence.* `035606e`, `a66388f`.

*Travelled.* Washington is the origin.

**Oregon: not exercised by this import.**

### A5 — When several sources describe one road, write down which wins. Do not leave it to evaluation order.

*The rule as shipped.* Most recent wins. Where years tie, a measured count beats
a modelled one. **A count with no recorded year never displaces a dated one**,
because it cannot be shown to be newer.

*Why recency and not quality.* Neither source is systematically better. On the
27,279 edges where the county log and HPMS both land, the median ratio between
them is **exactly 1.00**.

*Evidence.* `a66388f`, `a9aa0c6`.

*Travelled.* Washington is the origin.

**Oregon: did not apply.** Only one source of traffic volume conflates onto
linework here (HPMS), so there is never a second count to prefer. ODOT's own
AADT layers are published as **points**, not lines, and `roadmeasure.py` matches
lines -- so the precedence rule has nothing to arbitrate and was never
exercised. A state can have this lesson be a no-op.

### A6 — Agreeing medians do not mean agreeing roads.

*What happened.* Having established the median ratio is 1.00, it would be easy to
conclude the source choice does not matter.

*The measurement.* Half the edges differ by **more than 25%**, and **8.3% by more
than 3×**. On a given road the source choice can move the number twofold.

*And a negative result worth keeping.* Age does **not** explain the scatter.
CRAB counts from before 2010 sit at the same median ratio against 2018 HPMS as
counts from 2015 onward. Either those roads are not growing, or HPMS partly
derives from the same counts — this measurement cannot tell which, and neither
can you.

*Evidence.* `a9aa0c6`.

*Travelled.* Washington is the origin.

**Oregon: not exercised** -- see A5. There is only one count source, so there
are no medians to compare.

### A7 — Withdraw a claim that does not survive its own measurement.

*What happened.* A note in this repo asserted HPMS and CRAB contradict each other
on a specific road. They do not. The comparison behind the claim set **one** HPMS
value covering a 2.7-mile stretch against a spread of CRAB values from several
different segments — different places, different lengths.

*The rule.* Before recording that two sources disagree, check you compared the
same piece of road.

*Evidence.* `a9aa0c6`.

*Travelled.* Washington is the origin.

**Oregon: held, on this import's own work.** The hop-by-hop corridor checker
first reported the Aufderheide Scenic Bikeway at **7.2x** and Crooked River
Canyon at 4.5x. Both were artefacts of the measure: it compared the routed
distance against the *straight line* between two sample points, and both
corridors double back on themselves -- Aufderheide loops around Box Canyon, so
two points 4.2 miles apart as the crow flies are 30 miles apart on the road. The
tool now measures against distance **along the corridor** and the same hops read
5.9x and 4.0x. The claim was withdrawn before it reached the report.

### A8 — Audit for fields you fetched and never consumed.

*What happened.* The county road log's certified surface type was fetched from
the very beginning and never read by anything.

*The rule.* At the end of an import, diff what the fetchers pull against what the
builders consume. A fetched-but-unused field is either a missed signal or dead
weight in the build, and you cannot tell which without looking.

*And what to do with it.* When the surface type was finally wired up it went to
the road card **display-only, with provenance**, decoded from CRAB's codes (BST,
GRV…) into words. It earns model influence only after field testing — see G1.

*Evidence.* `2912d86`, `820bf70`.

*Travelled.* Washington is the origin.

**Oregon: held, and caught something.** The audit found ODOT publishes current
AADT for 6,544 state and 5,028 non-state count sites -- newer than the 2018 HPMS
release this state actually uses -- as **point** geometry that
`scripts/roadmeasure.py` cannot conflate. That is a fetched-and-unused signal
found *before* it was fetched rather than months after, which is the cheap
version. It is recorded as known backlog in `maps/oregon/STATUS.md`.

---

# B. Conflation — getting agency data onto OSM geometry

### B1 — An all-samples matcher silently discards data it has already found. This is the single most expensive bug in this category.

*What happened.* Pioneer Way East showed no traffic count on 4.13 of its 5.83
miles, while the nearest source line touched the graph edge at **zero distance**.

*Why.* The matcher required **every** sample point of a graph edge to fall within
18 m of **one** source segment. Inventories store a road as a run of short
consecutive records, so no single record spans a graph edge, and the match failed
even though the data was right there:

```
samples 1/0/56 m      nearest source 0 m away, rejected
samples 1/3/261 m     nearest source 0 m away, rejected
samples 0/162/620 m   nearest source 0 m away, rejected
```

*The rule.* A way matches when the source layer's **aligned segments together**
cover a majority of five sample points, and reports the values of whichever
single segment covers most of it. Every contributing segment is still
individually distance- and bearing-checked, so a crossing street or a parallel
road contributes nothing. This is *stricter* than the rule it replaced in one
respect: the old one checked alignment only at the midpoint.

*Measured.* County road log coverage 26.9% → **38.1%** of road miles — 35,993
miles statewide, a 42% relative gain. Worth more than adding an entire new
source.

*Evidence.* `0a9a6be`, corrected in `3c74e1a` (the original commit quoted 34.2%
from an intermediate version that matched on the best single segment).

*Travelled.* Washington is the origin. **Expect this to generalise** — segmented

**Oregon: not exercised by this import.**
inventories are how road logs are kept everywhere.

### B2 — Test a geometric matcher with true perpendicular offsets, in metres.

*What happened.* A guard meant to prove the matcher rejects a parallel road was
verified against a much weaker condition than its name implied. Deer Lake Road
runs diagonally, so shifting it 40 m north is only about **13 m** of true
separation.

*The rule.* Synthetic geometry for a matcher test must offset perpendicular to
the way, and the test must reject a parallel road at a stated true distance and a
street crossing at a stated angle, while accepting a way split across several
short records.

*Evidence.* `0a9a6be`. The rewritten test immediately caught a real defect in the
first version of the B1 fix.

*Travelled.* Washington is the origin.

**Oregon: not exercised by this import.**

### B3 — Measure coverage against the routing graph, not against the source's own extent.

*What happened.* An early estimate in this project put a source near 50%
coverage by treating every published row as conflatable. A third of them were
gravel roads that are not in the routing graph at all.

*The rule.* Only conflated mileage reaches a rider. `scripts/measure_coverage.py`
reads the shipped graph and reports what fraction of the network carries each
measurement, broken down by road class.

*The baseline it established.* 35.4% of road miles had a count — ranging from
76.5% on principal arterials down to **23.4% on local streets**. That spread is
the number that matters: it tells you which half of your model is running on
inference.

*Evidence.* `3e56c1c`.

*Travelled.* Washington is the origin.

**Oregon: held.** `measure_coverage.py` against the shipped graph: **25.2% of
74,481 road miles carry a traffic count**, ranging 95.2% on principal arterials
to 0.1% on local streets. Measuring against the graph rather than the sources'
row counts mattered here for the same reason it did in Washington -- HPMS's
67,861 sections look like they cover the state until you ask which of them land
on ways a bicycle can use.

### B4 — An explicit tag beats an inventory, and an explicit zero is knowledge.

*What happened.* A field report on WA-14: the inventory booked a 4 ft shoulder
where the road has about 1 ft.

*The rule.* OSM shoulder tags beat the agency inventory in **both** builds. An
explicit tag is a mapper who looked at that road; the inventory fills gaps. And
`shoulder=no` is an explicit tag — it is the majority of tagged ways here — so it
must win like any other, not be treated as absence of data.

*Also.* The tile marks inventory-sourced shoulders (`wsh`) so the card can name
the source. A rider should be able to tell a survey from a tag.

*Evidence.* `820bf70`, `e7068fe`.

*Travelled.* Washington is the origin.

**Oregon: the precedence held; the population did not.** The rule is right and
is applied unchanged, but it almost never fires: **650 ways in the whole of
Oregon carry any `shoulder*` tag, out of 850,087 highway ways.** (Washington had
2,186 tagged ways -- the same order of magnitude, and also tiny.) The practical
consequence is that in Oregon the shoulder signal is the ODOT inventory or
nothing: off the state highway system, an absent shoulder tag is not evidence of
absence, it is evidence that nobody has ever looked.

### B5 — Inventories are directional. The display collapse must be labelled.

*What happened.* A road read `Shoulder 0 ft` directly above `Passes your rules`,
because the router was using 6 ft for the direction the rider was actually going.

*Why.* WSDOT surveys each direction of a state highway separately and the two
disagree. SR 104 at Kingston carries 0 ft one way and 5–6 ft the other at the
same point; over 56 segments there the values are 0 ft ×20, 6 ft ×21, 5 ft ×9.

*Statewide.* 58,995 edges have a direction-dependent shoulder, 10,656 **change
verdict** with direction, and 2,564 **pass one way while failing the other** —
45 miles of road with two different answers.

*The rule.* The router scores per direction (it always did here — `edgeFacts(edge,
forward)`, with `esh` and `esh_ba` stored separately). The **card** is where this
goes wrong: it must name both values when they disagree. The background road
layer draws one line per road and stays **worst-case**, because it cannot show
two answers and the safe reading is the one that never makes a road look better
than it might be.

*Evidence.* `8d3e3bc`, `820bf70`.

*Travelled.* Washington is the origin. Whether an agency surveys directionally is a

**Oregon: held, and required work to honour.** ODOT books shoulder width per
side against *increasing* mileposts, and books a divided highway as separate
increasing and decreasing keys but an undivided one as increasing only. So a
decreasing-direction segment usually has no same-direction record and must read
the increasing one **with the sides swapped** -- the left side of a road
measured up-milepost is the right side of the rider coming down it. That applies
to **33,941 of 73,575 segments**, so getting it wrong would have given a third
of Oregon's state highways the shoulder across the centre line.
per-agency fact — check before assuming either way.

### B6 — A precedence change deserves a blast-radius count before it ships.

*The rule.* When you change which source wins, run one pass over the whole
network and count how many edges move, in which direction, and how many change
verdict. Ship the number with the change.

*Why.* See D6 — the direction of the change is routinely the opposite of what the
change *sounds* like.

*Evidence.* `e7068fe`.

*Travelled.* Washington is the origin.

**Oregon: measured after the initial import.**
`scripts/audit_functional_class_blast_radius.mjs oregon` reads all 516,278
directional edge readings carrying class. Class changes 5,612 verdicts (1.09%,
342.2 directional miles), all toward a worse verdict; 3,817 are pass → fail.
For owner unknown/federal/other the verdict effect is only 74 readings and 60.8
miles. Route pricing is the larger effect: class changes the traffic tier on
194,819 readings (37.74%). In the unknown/federal/other group it changes 3,386,
lowering 3,380 and raising only six. That direction matters: on Aufderheide the
proxy does not over-price the signed road; it under-prices an 18-mile
forest-road/trail alternative. Removing only owner-unknown class restores the
57.6-mile, 100%-overlap option. Corvallis to the Sea is unchanged when class is
removed, so the original report's common-cause diagnosis was false.

---

# C. The graph, and topology

### C1 — One severed link can cost forty-five miles, and nothing will fail.

*What happened.* Tacoma → Olympia routed 53.9 miles against a 26.1-mile straight
line. DuPont → Nisqually routed 46.4 miles against 4.3.

*Why.* `highway=service` was the only infrastructure category still demanding
`bicycle=designated`; path, footway, bridleway and track all accepted `yes`. That
dropped an 89 m emergency-access way (OSM w12189384, tagged `access=no
bicycle=yes foot=yes motor_vehicle=no` — explicitly open to bikes, closed to
cars). With that hole, the only link out of DuPont was 1.3 miles of I-5, and at a
freeway weight of 60 the router walked 45 extra miles around through Spanaway and
Yelm.

*How it was found.* Not by a test. By comparing against a route a cyclist posted
to Reddit, which named the exact chain: *"Center Dr to McNeil to Hoffman Hill Rd
to Mounts Rd. Take that over 5."* Every junction in that chain was in the graph
except one.

*Measured after the fix.* Tacoma → Olympia 53.9 → **38.8** mi. DuPont →
Nisqually 46.4 → **6.6** mi. Statewide the rule change admits 227 ways / 87 miles
— all bike-permitted ways that exclude motor traffic, the same narrow combination
the rule already trusted, just not spelled `designated`.

*The rule.* Accept `designated` and `yes` identically in **every** infrastructure
category. Keep the narrowness that excludes car-open service ways — that is what
keeps every parking aisle in the state out.

*Evidence.* `a15944b`, `5303e3b`.

*Travelled.* Washington is the origin.

**Oregon: not exercised by this import.**

### C2 — Assert corridor connectivity as an invariant, and it will catch the next one.

*The rule.* For a handful of real corridors, assert: **a route exists**, it needs
**no freeway**, and it is **not absurd against the straight line**. Not a
distance window — see G2.

*Why it works.* The severance in C1 showed up as **10.7×** the straight line
while three control corridors passed. That ratio is unmissable and survives every
tuning change.

*Evidence.* `a15944b`, `dd66fbc`, `scripts/test_corridor_severance.mjs`.

*Travelled.* Washington is the origin. This is the single highest-value test to port

**Oregon: DID NOT TRAVEL, and this is the most important line in this file.**
The premise -- that a severance shows up as a ratio nobody could miss -- depends
on the corridor being short enough for the detour to dominate. Oregon's
nominated Portland -> Hood River corridor **passed at 1.6x** the straight line
with no freeway, while a 5.8-mile hop inside it (Viento -> Hood River, on a
completed and signed state trail) has **no rideable route at all**. The router's
90-mile answer goes around the south side of Mount Hood, and at a 2.5x bound
that is indistinguishable from a good ride.

A long corridor absorbs a severance. `scripts/verify_corridor_chain.mjs` was
written for this: walk the corridor in ~5-mile hops and route each one against
the distance *along the corridor*. The severance that is invisible at 1.6x over
90 miles is unmissable when the hop is 6. **Nominate short corridors across the
pinch points as well as long ones** -- and the pinch points are where the map
shows one line between two walls.
first, because it is the one that catches a broken import rather than a broken
opinion.

### C3 — Shoreline DEM smears terrain onto flat ground at the water's edge.

*What happened.* Clinton's flat ferry terminal road booked an 11.2% grade over
116 m of pier, and the map put a mountain icon on it. The real climb out of
Clinton — Berg Road at 7.6% — never qualified.

*Why.* A DEM samples the bluff behind the slip and smears it onto the flats.
A steep reading at a pier is an artefact, not a climb.

*The rule as shipped.* No grade marker within 250 m of a ferry leg.

*Evidence.* `15d494f`, `2912d86`.

*Travelled.* Washington is the origin. Any state with a coastline and ferries should

**Oregon: did not apply.** Oregon has no bicycle-carrying ferry in the routing
network, so neither the shoreline DEM smear nor the 250 m grade-marker
suppression was exercised. A coastal state can still not have this problem.
expect this to recur.

### C4 — Other terrain and topology traps, recorded together.

From `2912d86`, which wrote these up as the graph-build lessons that generalise:

- **Deck, not terrain, on structures.** A bridge or overpass takes its grade from
  the deck; sampling the DEM under it gives you the valley.
- **`incline=` is authority**, and rail-trails need a cap — a converted railway
  grade has a physical ceiling, and a DEM that says otherwise is wrong.
- **Same-name seam stitching**, and why the skip must be **direct-edge, not
  same-component**: a component test will happily bridge two ends of a road that
  are genuinely not connected.
- **Walk-link connectivity** — the links that make a route possible on foot must
  be present or corridors sever (C1).
- **Terminals hide behind dismount tags.** A ferry terminal approach is often
  tagged `bicycle=dismount`, and a build that treats dismount as impassable loses
  the terminal.

*Travelled.* Washington is the origin.

**Oregon: partially exercised.** Same-name seam stitching fired **129 times**
at the 2 m threshold (Washington: the rule exists because of one seam). Walk-link
connectivity held: the largest component holds **97.6%** of nodes, above the 96%
floor. Deck grades, `incline=` authority and the dismount-terminal case were not
separately tested here.

---

# D. The safety model, and where the thresholds came from

> Current values verified against `safety-model.js`. Where a value has moved, the
> superseded ones are marked `[history]` and kept because the *reasoning* is
> still the useful part.

### D1 — A designation cannot excuse a road. This killed a whole rung.

*What happened.* A signed route was excusing US 101 at 60 mph with no shoulder.

*Why.* Clallam County's Olympic Discovery Trail runs **58.8 miles along ordinary
road**. A designation says a corridor is recommended; it says nothing about the
road under your wheels.

*The rule.* Designation is context, never a verdict, and it can never satisfy the
shoulder rule. The "route trust" setting was removed outright, and the tests were
rewritten to assert the **opposite** so it cannot quietly return.

*Evidence.* `4cb9a04`, `dd66fbc`, `451cdd8`.

*Travelled.* Washington is the origin. **Expect this to generalise** — long

**Oregon: held, and it was a live temptation.** ODOT's bicycle facility
inventory has four codes, and the **largest** of them is `SH`, "Shoulder
Bikeway" -- 2,637 of 6,955 rows, more than bike lanes (1,800) and shared lanes
(266) combined. Importing it as bike infrastructure would have let a designation
painted over a shoulder satisfy the shoulder rule on the busiest rural highways
in the state. It is dropped, and so is `NO` (2,252 rows), which records the
*absence* of a facility and would otherwise have read as one.
road-running signed routes are the norm, not a Washington quirk.

### D2 — Sequencing separate rungs hides a real case. Merge questions that are one question.

*What happened.* A five-lane arterial signed at 25 mph reached the speed rung and
**passed** there — after the lane rung had already been consulted.

*Why.* Speed, lane count and traffic volume are three ways of asking one thing:
*how much of this lane is actually available to a rider?* Asked in sequence, an
answer at one rung stops the others being asked.

*The rule.* One `needs-space` rung, three triggers, ORed. And
`spaceReasons()` reports **every** trigger that fired, not the first — reporting
only one invites the rider to go and change the wrong setting.

*Evidence.* `d095a3c`, `fac8d24`, `778b1c3`.

*Travelled.* Washington is the origin.

**Oregon: not exercised by this import.**

### D3 — Express a threshold in road types, not numbers, and give it two paths.

*The rule.* Nobody has an intuition for "3,000 vehicles a day"; everyone knows
what a neighbourhood street feels like. Each level carries **both** a count
threshold and an equivalent functional class. The count decides when there is
one; the class covers the half of the network that has none (B3).

*Current values* (`BUSY_LEVELS`, `safety-model.js`):

| level | label | AADT | FHWA class |
|---|---|---|---|
| 0 | don't use traffic | — | — |
| 1 | a quiet lane | 500 | 6 |
| 2 | a neighborhood street | 2,000 | 5 |
| 3 | a busy through road | 6,000 | 4 |
| 4 | a main highway | 15,000 | 3 |

*The constraint that makes it honest.* `facts.fc` must be the **official** class
only. A mapper's `tertiary` must not be able to fail a road for being busy.

*Evidence.* `d095a3c`, `fac8d24`, `778b1c3`.

*Travelled.* Washington is the origin. FHWA classes are federal, so the class
column should port unchanged; the AADT thresholds are a judgement about riding,
not about Washington.

**Oregon: the class column ported, and its two effects had to be measured
separately.** FHWA
classes are federal and ODOT publishes them statewide (86,569 segments, classes
1-7), so the table needed no change. The B6 audit found that class changes only
1.09% of classified-edge verdicts, but changes the route-pricing traffic tier on
37.74%. On owner-unknown/federal/other edges the pricing change is almost always
a discount, not a penalty. See B6: verdict and cost blast radii, plus owner
provenance, are separate questions.

### D4 — Do not fork a rule on urban/rural. The obvious direction is backwards.

*What happened.* Two settings, 30 mph in town and 35 outside it.

*Why that is wrong.* It makes the rule **stricter where speeds are better
enforced and there is somewhere to turn off**, and **looser where a rider is most
exposed**. A 35 mph lane with no shoulder is the same lane whether or not a
Census polygon contains it.

*The rule.* One `maxSpeedNoShoulder`. The urban flag is still built into the
graph and still shown on the card as context — it simply no longer forks this
rule.

*Evidence.* `02d943b`.

*Travelled.* Washington is the origin.

**Oregon: not exercised by this import.**

### D5 — A recorded 15 mph limit shares the lane.

*The rule.* A **recorded** speed limit at or under `SLOW_STREET_MAX_MPH` (15)
passes at the quiet-lane level whatever the shoulder, lane count, traffic count,
stress rating or sidewalk say. Nobody needs riding space of their own at
parking-lot speeds. Only a recorded limit earns it — an unknown speed never does
— the absolute speed ceiling still outranks it, and limited-access keeps its
caution.

*Evidence.* `ade6a2d`. Held by a 45-million-combination agreement sweep (D9).

*Travelled.* Washington is the origin.

**Oregon: not exercised by this import.**

### D6 — Pricing off a measurement mostly moves roads *down*. Say so before someone discovers it.

*What happened.* Replacing an OSM-tag proxy with measured traffic sounds like it
should find more busy roads. It does the opposite.

*Measured over all 635,995 eligible edges.* The measurement disagrees with the
tag on 171,466 — and **150,079 of those move down**, only 21,387 up. The dominant
case is a road OSM calls secondary that FHWA classes a minor collector, or that
counted under 2,000/day; it sheds its arterial penalty. Only **4,728** edges are
OSM-class gaps that the measurement fills.

*The rule.* Ship a change like this **behind a zeroable weight** so it can be
switched off and ridden against, rather than being an unfalsifiable improvement.
And keep the evidence ladder explicit — measured count, then FHWA class, then OSM
tag — with all three landing on the same tiers, so the change moves the
*evidence* and not the *price*.

*Evidence.* `04e0520`.

*Travelled.* Washington is the origin.

**Oregon: not exercised by this import.**

### D7 — Inferring a shoulder from edge space: three constraints, and why it defaults on.

*The problem it solves.* Only about **7%** of road features carry a shoulder tag.
Without inference the map calls most of the network failing on *absence of data*
rather than on evidence.

*The rule.* Where the county log records edge space and OSM records no shoulder,
the space **less 1 ft** counts as shoulder. Edge space is already per side
(`build_roadlog.py` halves it once at derivation), so it compares directly
against `minShoulder`. The 1 ft margin is what converts "space exists" into
"space you would ride on".

*The three constraints, each of which prevents a real failure mode:*

1. **It only fills a gap.** A recorded shoulder wins — *including a recorded
   0 ft*, which is evidence of absence.
2. **A zero infers nothing.** A negative edge-space figure means the recorded
   lanes exceed the recorded operational width: a paperwork error. Inferring a
   hard 0 ft from that would turn bad data into a failing road.
3. **It is consulted before the pessimistic unknown-shoulder reading**, or it
   could never fire for the riders it exists to help.

*Measured on the shipped graph at Randonneur defaults.* 20,892 miles have edge
space and no tag; 9,548 edges / 1,696 miles changed verdict, **none worse**; failing
mileage 14,906 → 13,220 miles (−11%).

*Evidence.* `e2dde6e` (shipped off), `c24e7da` (turned on by measurement),
`32277a8` (scoped to Randonneur, control reworded to "Guess shoulder width from
other data when it isn't documented").

*Travelled.* Washington is the origin. The 7%-tagged figure is an OSM coverage fact and

**Oregon: DID NOT TRAVEL. The inference has no input here.** ODOT publishes no
county road inventory and no equivalent of CRAB's edge space, so bail-out space
is **0.0% of 74,481 road miles** and `inferShoulderFromEdge` -- which recovers
1,696 miles of verdict in Washington -- can never fire. The re-measurement the
lesson asks for gives the answer directly: the inference is worth nothing in
Oregon, not because it is wrong but because the state does not publish the
number it reads.
should be re-measured per state — it is the number that decides whether this
inference is worth having at all.

### D8 — Give the model one facts contract, or omissions become invisible.

*What happened.* Three separate wrong verdicts, all the same shape:

- `scoreBLTS` never put AADT into the facts, so SR 104 at Kingston said *"nothing
  here demands space of its own"* on a card printing **4,122 vehicles/day two
  lines below the verdict**, while the map drew it failing.
- `factsOf` read `n.facility` and **no scorer set it**, so every card collapsed a
  separated path and a painted lane into the same road. Only the router ever saw
  the real 0–5 level.
- `scoreBLTS` assigned WSDOT's **stress rating** to a field the model reads as
  *"how good is this bike infrastructure"*. Two unrelated meanings in one field,
  inert only by luck.

*Why it is invisible.* A forgotten field is not an error in JavaScript. It is
`undefined`, which the model reads as "unknown", which is a perfectly valid
answer — so **an omission is indistinguishable from missing data**.

*The rule.* One declared vocabulary (`FACT_KEYS`), one supported builder
(`factsFrom`), a seal for builders that assemble directly (`sealFacts`), and a
table declaring **which facts each source can actually supply** — a written-down
gap rather than an accidental one.

*And the test that holds it.* `test_fact_contract.mjs` checks all five sources
against that declaration on real tile and graph data (46,840 samples): a fact
claimed but never populated is a broken adapter; a fact populated but not claimed
means the table is stale; shared facts must agree on **type and units**. Feet per
side, the 0–5 facility scale and FHWA classes are range-checked — *because a
source reporting metres would pass every other check in the suite.*

*Evidence.* `041505d`, `32277a8`.

*Travelled.* Washington is the origin. **Expect this to generalise** — it is a property

**Oregon: not exercised by this import.**
of having more than one scorer, not of Washington.

### D9 — The map expression is the one implementation that cannot share the model's code. Sweep them against each other.

*Why.* MapLibre evaluates paint expressions declaratively, so the map's copy of
the ladder is a genuine second implementation. Two implementations of one rule
drift, and the drift shows up as a card disagreeing with the line underneath it.

*The rule.* An exhaustive agreement sweep across every combination of facts and
rule settings. It is currently in the tens of millions of combinations and is the
suite's longest-running test — and it has earned it repeatedly.

*What it caught, immediately.* The merged `needs-space` rung used
`!hasRidingSpace` where the old one used `shoulderFails`. With the pessimistic
unknown-shoulder reading turned **off** those differ — an untagged shoulder is
then not evidence of absence and must not fail — so the substitution would have
quietly re-imposed the pessimistic reading on a rider who had switched it off.

*A trap inside the trap.* The sweep must vary **every** input a trigger can read,
or a trigger is compared on only one of its paths. When the busy trigger was
added, the sweep had to start varying AADT *and* functional class, or the count
path and the class path would never both be exercised. Similarly, a sweep whose
rule sets never enable an optional inference will silently never exercise the
branch that ships **on** by default.

*Evidence.* `42a7498`, `32277a8` (evaluator extended for `max`, `-`, `in`,
`literal`, `match`; combinations 6.5M → 18.1M), `ade6a2d` (45M).

*Travelled.* Washington is the origin.

**Oregon: not exercised by this import.**

---

# E. Routing cost calibration

### E1 — Facility multipliers are profile-independent, so tuning them moves every option, including the direct one.

*What happened.* Strengthening the facility bonuses moved the **shortest**
Olympia → Centralia option from 28.7 to 39.8 miles.

*Why.* The multipliers are not part of the low-stress profile; they price
facility everywhere. Making a trail cheaper makes it worth more detour on every
profile, and failing distance on the quickest options rises slightly because a
little more failing road becomes worth paying to reach a trail.

*Current values* (`app.js`): path **0.16**, separated **0.29**, buffered
**0.36**, lane **0.4**, shared-lane/sharrow **0.82**.

`[history]` These have moved at least twice — `0.38 / 0.46 / 0.58 / 0.68` before
`59fe15f`, and a field-tuned pass at `0.21 / 0.31 / 0.32 / 0.36` in `ac27511`.
The values are not the lesson; the **ordering** and the **method** are: a path
beats a separated lane beats buffered beats a plain lane, and sharrow stays high
because **paint in a traffic lane is not protection**.

*Evidence.* `59fe15f`, `ac27511`, `c86a52a`.

*Travelled.* Washington is the origin. These are riding judgements, not Washington

**Oregon: not exercised by this import.**
facts; port them as-is and re-tune from field reports.

### E2 — Recompute the A\* admissibility bound whenever a multiplier floor moves.

*The rule.* The heuristic must stay admissible across the **whole editable
range**, not just at the defaults — the weights are exposed in a slider editor,
so a rider can reach the floor.

*Worked example* `[history]`, from `59fe15f`: `V_MAX 12 / (0.30 path × 0.78
residential × 0.9 low-stress comfort) = 57.0 m/s` against `V_HEUR 160`, and the
slider floor of 0.20 gives 85.5 m/s — admissible at both ends.

*Currently* the search is weighted A\*: `SEARCH_OVERSHOOT = 1.15` scales the
admissible heuristic, mathematically bounding a found route at 1.15× optimal cost
while pruning lateral exploration. `1.0` restores exact A\*.

*How 1.15 was chosen.* Against benchmarks, not by feel. At 1.15 the
Seattle–Vancouver portfolio's five candidates are identical except one alternate
at +0.4% (1.2 km on 314). At 1.2 they drifted 1.3–3.6% — past what "minor" means.

*Evidence.* `59fe15f`, `874ef55`. `test_route_potential.mjs` asserts the bound
contract and its verification legs still come back exactly optimal.

*Travelled.* Washington is the origin.

**Oregon: not exercised by this import.**

### E3 — A lexicographic "safest wins" recommendation will pay any price for a rounding difference.

*What happened.* Seattle → Everett on defaults starred a 40.4 mi / 3h19 route
over a 33.0 mi / 2h43 one. It paid **7.4 miles and 36 minutes to avoid 651 m of
failing shoulder** — a difference that rounds to the same "1% fails" on both
route cards, on a route that also climbed more and carried the heavy-traffic
stretches.

*Why.* The comparison was lexicographic: any reduction in absolute failing metres
beat any amount of time or distance within the practical window.

*The rule.* Price it. The recommendation minimises `time + 1 s per failing metre`
across the practical pool: avoiding a mile of failing road is worth up to about
27 minutes of extra riding, **and no more**.

*Evidence.* `3146cc1`.

*Travelled.* Washington is the origin. Requires a routing graph, so it is not reachable

**Oregon: not exercised by this import.**
in a preview import.

### E4 — Every veto in the pipeline must pay the same price, or it undoes the pricing.

*What happened.* After E3, Phinney Ridge → Mukilteo still starred a 40.1 mi /
3h22 zero-fail loop over a 30.7 mi / 2h33 route whose ~1% failing distance prices
at about eight minutes — a **49-minute detour taken automatically**.

*Why.* The priced star chose correctly and then a *separate*, older override
vetoed it: any zero-fail route within 1.8× distance replaced a recommendation
carrying any failing metres at all. That veto predated the priced star and was
undoing it.

*The rule.* When you introduce a pricing model, audit every remaining hard rule
that can override it. The override now picks its candidate by the same score and
takes the star only when the switch costs at most ten minutes beyond what the
fail metres already charged.

*Evidence.* `58149f5`.

*Travelled.* Washington is the origin.

**Oregon: not exercised by this import.**

### E5 — Give ride quality a vote, below safety.

*What happened.* Seattle → Mukilteo starred 31.8 mi / 2h39 at 64% trails-and-lanes
over 36.1 mi / 3h00 at 90% with zero caution. It saved 21 minutes by spending 12
extra kilometres alongside traffic. The rider's verdict on the *other* route:
*"I'd rather be recommended routes like this."*

*Why.* Time, failing distance and dismount all had votes. The riding surface had
none.

*The rule.* Add a per-metre price for riding that is neither trail nor trusted
lane, at a **fifth** of the fail/dismount rate — so safety still outranks
comfort, but a mile of ordinary road is worth about five and a half minutes of
detour onto better ground.

*Evidence.* `73add9a`.

*Travelled.* Washington is the origin.

**Oregon: not exercised by this import.**

### E6 — Price a dismount proportionally, and let length decide severity.

*The rule as shipped.* Dismount stretches cost 4× their walked time (8× on an
edge over 100 m) on top of walking pace and an entry penalty. Proportional by
construction: **a gate stays a shrug; a fifth of a mile of unrideable trail
prices like something to route around.**

*And the display rule that goes with it.* A contiguous **tagged**
`bicycle=dismount` run over 100 m reports as *failing* — a signed stretch you
cannot ride is a route that failed to be a bike route. **Synthesised** walk links
stay amber whatever their length, because red at every park connector teaches
riders to ignore the red that matters. Short runs — dock approaches, gates — stay
caution, so ferry terminals keep working.

*Evidence.* `373191d`.

*Travelled.* Washington is the origin.

**Oregon: not exercised by this import.**

---

# F. Tiles and rendering

### F1 — The app overzooms past the tile maxzoom, so simplification at maxzoom is simplification of the final picture.

*What happened.* Washington's traffic circles rendered on the map as **arrowheads
sitting in the intersection**.

*Why, in two independent parts — and either one alone still loses them:*

1. **In the build.** A fixed ~5 m vertex tolerance was applied to everything,
   which erases any feature smaller than the tolerance itself. 3,125 of 4,486
   rings were reduced to four or fewer distinct points. The fix: vertex reduction
   never applies to a closed ring, and never exceeds an eighth of an open way's
   own extent.
2. **In tippecanoe.** `--simplification=8` works out to roughly **26 m** at z13.
   `--simplify-only-low-zooms` is therefore **mandatory, not a preference** — the
   app draws these tiles far past z13, so whatever z13 keeps is what a rider sees
   at full zoom. Keeping maxzoom unsimplified cost 1.2% (+0.4 MB) of archive size.

*Measured.* The Dayton Avenue North circle came out 8.0 × 2.3 m instead of
8.0 × 8.0 m.

*Evidence.* `README.md` build section; guarded by
`scripts/test_road_geometry.py` against that surveyed circle.

*Travelled.* Washington is the origin. **Expect this to generalise exactly** — it is a

**Oregon: held by construction.** `--simplification=8 --simplify-only-low-zooms`
was carried over unchanged; `test_road_geometry.py` still guards Washington's
surveyed traffic circle and no Oregon equivalent was surveyed, so this is
adoption of the rule rather than independent confirmation of it.
property of tippecanoe and of overzooming, not of Washington.

### F2 — Below the low-zoom threshold, a statewide tile carries the entire state.

*What happened.* A reliable crash on zoom-out on iPhone, and a Mac Safari tab
*"reloaded because it was using significant memory"*.

*Why.* Below z9 every overlay tile carried the **entire statewide dataset** —
about 93k features, rebucketed at every zoom level crossed and retained by the
tile cache, much of it for layers that draw nothing at that zoom.

*The rule, in layers.* Cut it in the **archive** (below z9 keep only what is
actually visible at that scale — here, off-street ways: 13.7k features at z6);
floor **invisible tap-target layers** at z9, since below that a tap is a mile
wide anyway; and bound the tile cache.

*Evidence.* `fbacf2b`.

*Travelled.* Washington is the origin. Expect it in any state of comparable size.

**Oregon: held.** The same below-z9 filter was applied unchanged and produced a
14.2 MB overlay archive from 81,210 BLTS segments and 37,256 bike-infrastructure
ways -- a comparable state, a comparable archive. Not independently re-measured
against a crash.

### F3 — Serve large overlays as tiles, not as GeoJSON collections.

*What happened.* Two overlays (38k + 55k features) held about **440 MB of a
~1 GB renderer** — the parsed copy MapLibre retains, the serialized copy in its
map worker, and the worker's tile index — for data the rider only ever sees a
viewport of.

*Measured after moving to PMTiles.* 16.8 MB archive; steady-state renderer
~520–650 MB; a rules change recolours in ~36 ms with zero data uploads. The same
move earlier took a roads layer from 78 MB and crashing iOS to a tiled archive.

*Evidence.* `df9e0dc`.

*Travelled.* Washington is the origin.

**Oregon: not exercised by this import.**

### F4 — An overlay drawn above the roads must not answer a tap.

*What happened.* Tapping the Olympic Discovery Trail returned the **ribbon's**
card — a name, a network, a map symbol — and showed nothing about the road: no
verdict, no speed, no shoulder, no traffic. On the one corridor that proves a
designation cannot excuse a road (D1), a rider got the designation and was denied
the verdict.

*The rule.* Hit-testing returns the topmost **scored** feature regardless of draw
order; a decorative overlay answers only when nothing scored is beneath it.

*Note the shape of the mistake.* This had already been fixed **once**, for a
different ribbon, by making that one layer non-hit-testable. Fixing an instance
rather than the class means the next overlay reintroduces it.

*Evidence.* `4cb9a04`.

*Travelled.* Washington is the origin.

**Oregon: not exercised by this import.**

### F5 — A right value that never reaches the rider is the same class of bug as a wrong one.

*What happened.* Tapping a street showed traffic and edge space; tapping **the
same street as part of a route** showed neither.

*Why.* The measurements were attached to the route feature as a nested object.
MapLibre **serialises GeoJSON feature properties**, so that object came back from
the tap layer as a *string* and every lookup on it read `undefined` — silently,
because an absent measurement is a legitimate state that renders as no row.

*The rule.* Flatten measurements onto the feature under the tile's own key names,
so one reader serves both. And assert that **every route feature property is a
scalar** — the existing test compared the two readers and passed throughout,
because both readers were correct; what was broken was the data never reaching
one of them.

*Evidence.* `0c5fad1`, `9e872e3`.

*Travelled.* Washington is the origin.

**Oregon: not exercised by this import.**

### F6 — Choose verdict colours by measured contrast under colour-blind vision, and choose motion by kind.

*Colour.* Values are chosen by maximising the smallest CIELAB distance between
any two roles under normal, deuteranope and protanope vision — they separate by
**lightness**, because hue is the axis red-green colour blindness flattens.
Darkening the caution orange from `#e8760a` to `#c25d05` (L\* 61.8 → 51.0) raised
the weakest pair from ΔE 14.9 to 18.3, *because* it pulls away from the
bike-network lime by lightness rather than hue.

Later field tuning moved the pass blue 15% darker (`#1375b2`) and the dashed
fail red 15% lighter (`#913847`). Those are application-wide palette changes;
the shapes and textures remain the authoritative non-colour cues.

*Motion.* Motion on a line has two axes — across it and along it. Give each
verdict **one and never the other**, so they are told apart by kind rather than
by comparing amplitudes. Two sizes of one effect read as "a bit less bad", not as
a different verdict.

*Evidence.* `6b579bc`, `364c27b`, `07254c8`, `e802eae`.

*Travelled.* Washington is the origin. Entirely state-independent — port as-is.

**Oregon: not exercised by this import.**

---

# G. Discipline

### G1 — A new signal is display-only until it has been field-tested.

*The rule.* A newly conflated field reaches the card with its provenance and
**does not touch the model** until someone has ridden against it. County surface
type (A8) is the worked example.

*Evidence.* `820bf70`, `2912d86`.

*Travelled.* Washington is the origin.

**Oregon: held.** Nothing newly conflated was given model influence beyond what
Washington already gave the same field. ODOT's surface codes, HPMS speed and
lane counts, and ODOT's point AADT are all carried or deliberately left
unfetched rather than wired in.

### G2 — Pin invariants, not measurements. A test that must be re-blessed after every deliberate change teaches the wrong reflex.

*What happened.* The route portfolio test pinned 70–80 miles with at least 22
miles of facility and a middle leg of 31–38. Its own comments recorded the
ratchet: *"it measures 29.97 mi on the 2026-07 WSDOT rebuild (was ~30), so the
first-leg floor is 29.5"*.

Removing the designation rung (D1) broke it purely by shifting a route from 72
to 66 miles — **a better route failing an assertion written when designations
could excuse roads**.

*What survives instead.* A fully rule-matching route exists between these points
(the corridor-severance detector, C2); no option takes a freeway or an MTB trail
when the rules exclude them; no option exceeds 2.5× the shortest offered.
Distances are still **printed for a human to read** — they are simply not
assertions.

*And one that looked like an invariant and was not.* A required list of ferry
names. Deception Pass bridge means Whidbey is reachable by land, so requiring two
specific ferries was another preference encoded as a requirement.

*Evidence.* `dd66fbc`.

*Travelled.* Washington is the origin.

**Oregon: not exercised by this import.**

### G3 — A test asserting *weaker* behaviour than the code implements is the worst kind of stale.

*Two examples, both found in one triage.* A service-worker test still required
`cache.addAll(SHELL)` long after that was replaced by per-file fetch with retry
(because `addAll` is all-or-nothing and one dropped request fails an entire
install). And a plain substring search **cannot see a template literal**, so a
test missed that the graph is precached under its data version — and that query
string is the entire mechanism by which a rebuilt graph reaches a rider.

*The related rule this project settled on.* A test never asserts on source text.
511 such assertions were deleted here; they break on a rename and pass through a
real regression, which is the worst ratio a test can have.

*Evidence.* `451cdd8`, `9a886df`, `39827e3`.

*Travelled.* Washington is the origin.

**Oregon: not exercised by this import.**

### G4 — Never let a missing build tool read as coverage.

*The rule.* A test that needs tooling the environment lacks exits **77** and
prints `SKIP: <reason>`; the runner reports SKIP, not PASS.

*Evidence.* `9a886df`.

*Travelled.* Washington is the origin.

**Oregon: not exercised by this import.**

### G5 — The tile build and the graph build must share one decision layer.

*What happened.* Four behaviours had drifted between two files that each kept
private copies of the same constants and parsers — about 120 near-duplicate
lines. The map card and the router could therefore answer differently about the
same road:

- `maxspeed=50 km` parsed as 50 mph in the tile, 31 mph in the graph
- `cycleway:buffer=yes` counted as buffered in the graph, plain in the tile
- agency speed overrode a real OSM `maxspeed` tag in the tile; the graph
  correctly let the agency fill only *estimated* speeds
- the limited-access caution ignored bike lanes in the tile; the graph gated it
  on facility

*The rule.* One build imports every shared symbol from the other — parsers, class
tables, the facility ladder, the conflation gate — and a parity test holds the
door shut with identity checks plus the specific ex-drift behaviours.

*Evidence.* `5d59c9e`, `038d771`, `scripts/test_build_parity.py`.

*Travelled.* Washington is the origin.

**Oregon: held.** `test_build_parity.py` passes with the Oregon inputs in place.
Worth noting what it does *not* cover: it checks that the two builds share their
decision layer, not that either one is right about Oregon, and every one of its
data assertions is still Washington's.

### G6 — Commit built artefacts the moment they build, and commit fetched sources compressed.

*What happened.* A build container was reclaimed **seven times**, taking
everything untracked with it. One reclaim cost four fetched source layers plus a
built and verified graph.

*The arithmetic.* Re-fetching those layers takes the better part of an hour,
which is **longer than the idle window that destroys them** — so a session can
lose the work before it finishes reproducing it. Compressed, all three were
17.7 MB.

*The rule.* Commit a graph or a tile archive on completion, not at the end of the
work. Commit fetched sources compressed, with the loader falling back to the
`.gz` so builders keep their existing default paths.

*Evidence.* `776bf11`, `94d9ca8`.

*Travelled.* Washington is the origin. The container behaviour is a property of

**Oregon: kept, untested.** The container was not reclaimed during this import,
so the discipline cost nothing and proved nothing. Each artefact was committed
as it built anyway -- the graph before the tiles, the tiles before the docs --
and `blts.geojson` is committed compressed because paging ODOT's catalogue takes
about 25 minutes, which is longer than the idle window that would destroy it.
this build environment, not of any state.

### G7 — A format reader must reject an unfamiliar magic rather than soldier on.

*What happened.* A coverage tool rejected a new graph format outright on the
unfamiliar magic. **That is the right failure** — silently misreading a shifted
layout would have produced confident wrong numbers rather than an error.

*Related.* When a new field needs provenance, give it its own byte rather than
squeezing it into a spare bit: a year needs seven bits of its own to span
1940–2035, and three sources do not fit in one bit.

*Evidence.* `fbeeb70`, `a66388f`.

*Travelled.* Washington is the origin.

**Oregon: not exercised by this import.**

---

## What is not yet mined

This file was built from the commits touching the data pipeline, the safety model
and the porting docs — roughly 90 of the repository's 281 commits, read
oldest-first. Two seams remain and are worth a second pass:

- **The turn-instruction work** (`a4ffe65`, `3b1890f`, and the dogleg series).
  Not state-specific on its face, but it is entirely about what OSM geometry does
  at junctions, which every state has.
- **The later routing-portfolio commits** (`12c377e`, `d3d4cb9`) on candidate
  diversity. Relevant to a state whose network shape differs from Washington's.

Add to this file as they are mined, and add a `Travelled` line to every lesson
above as each new state either confirms them or proves them local.
