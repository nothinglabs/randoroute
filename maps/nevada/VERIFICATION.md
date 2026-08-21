# Nevada verification

The level-5 and level-7 gate. The method is `maps/README.md`'s: take routes
that are already known to be good and see whether the router agrees, then
diagnose **every** disagreement — data gap, severed link, legitimate safety
disagreement, or unknown.

Run 2026-08-21 against `maps/nevada` graph `sha-63fd4ab49fd0`.

```bash
node scripts/verify_against_routes.mjs nevada | python3 scripts/verify_against_routes.py
node scripts/verify_corridor_chain.mjs nevada 5
node scripts/test_corridor_severance.mjs
node scripts/audit_route.mjs maps/nevada/audit/routes.json maps/nevada/audit
```

## The constraint that shapes this report

**Nevada has twelve `route=bicycle` relations in the entire state**, eleven
corridors after overlapping members are reconciled, and none of
them is in Clark County. Oregon has forty-one. So the highest-value source in
`maps/README.md`'s list — published long-distance routes already in the data —
covers Lake Tahoe, the Truckee River and one national route across the middle,
and does not touch the metro where three quarters of Nevadans live.

That is a fact about Nevada, not a shortcut taken here, and it is why this
report has three parts rather than one: the route relations, a corridor chain
walk, and twenty named trips whose known-good answer comes from the road network
and from named local rides rather than from a mapped corridor.

## Part 1 — the published route relations

`verify_against_routes.mjs` routes between the two ends of each corridor and
measures how much of each returned option runs within tolerance of the published
line.

| route | source | published | router's best | on corridor | shortest | on corridor | failing mi |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **U.S. Bicycle Route 50** | AASHTO-designated USBR, OSM `ncn` ref 50 | 441.3 mi | 417.2 mi | **79%** | 416.6 mi | 78% | 112.8 |
| Stateline to Stateline Bikeway | Tahoe Regional Planning Agency, OSM `rcn` ref STS | 5.1 mi | 3.5 mi | **95%** | 3.0 mi | 78% | 0.00 |
| Wadsworth–Pyramid Lake section, Tahoe-Pyramid Trail | OSM `rcn` | 19.7 mi | 20.3 mi | 18% | 19.0 mi | 2% | 4.52 |
| Tahoe-Pyramid Bikeway | OSM `rcn` ref TPB | 37.9 mi | 110.4 mi | 14% | 100.6 mi | 8% | 9.93 |

### Resemblance: two agreements

**U.S. Bicycle Route 50 — 79% on corridor over 441 miles.** This is the
strongest result in the import. The router, told only the two endpoints of a
corridor that crosses the entire state — Stateline on Lake Tahoe to the Utah
line at Baker — returns a 417-mile route that spends four fifths of itself on
the designated national route. The 21% that differs is mostly urban: it leaves
the signed line through Carson City and Fallon, where a signed route follows the
main street and the router prefers a parallel residential grid. That is the
router optimising for the rider's rules over a designation, which lesson D1 says
is correct behaviour rather than a defect.

**Stateline to Stateline Bikeway — 95% on corridor.** A 5-mile Tahoe Regional
Planning Agency corridor, followed almost exactly, with **zero failing miles**.

### Disagreement 1 — Tahoe-Pyramid Bikeway, 110.4 mi against a published 37.9

**Diagnosis: severed link, and the severance is legal rather than physical.**

Localised by halving the corridor:

| hop | crow | shortest offered | ratio |
| --- | ---: | ---: | ---: |
| Verdi → Sparks (west half, the river through Reno) | 12.5 mi | 14.4 mi | 1.15× |
| **Sparks → Wadsworth (the Truckee Canyon)** | 25.8 mi | **58.2 mi** | **2.25×** |

The west half is healthy. The canyon is the break, and the router's 58-mile
answer goes north out of Sparks on Pyramid Way to Nixon on Pyramid Lake and back
south on SR 447, around the Pah Rah Range.

The Truckee Canyon carries the river, the railroad and I-80, and nothing else.
In this extract I-80 through the canyon is **72 ways tagged `bicycle=yes` and 34
tagged `bicycle=no`**: the metro-adjacent section is closed to bicycles, and 34
ways of prohibition in the middle of the only line severs it. So there is no
legal bicycle route east out of Reno and Sparks through the canyon, and the
router's loop is the honest answer for the network as mapped and regulated.

The Tahoe-Pyramid Trail is being built through this canyon for exactly this
reason. Its OSM relation covers the intended corridor rather than a continuously
rideable one, which is why the published mileage and the routable mileage
disagree by 3×.

**Nothing was patched.** No synthetic geometry, no supplemental route source —
the porting method is explicit that discovery by an importing agent is a finding
for human review. What a rider should check: whether the canyon's `bicycle=no`
tagging matches the posted signs, and whether the completed sections of the
Tahoe-Pyramid Trail are mapped.

### Disagreement 2 — Wadsworth–Pyramid Lake, 20.3 mi against a published 19.7, but only 18% on corridor

**Diagnosis: legitimate safety disagreement, with a data component.**

The distances agree almost exactly; the *line* does not. The router runs SR 447
and Sutcliffe Highway — paved state highways — where the published corridor
follows the Tahoe-Pyramid Trail's riverside alignment on the Pyramid Lake Paiute
Reservation. The trail alignment is partly unpaved and partly unbuilt, and the
default rules prefer paved. Choosing a paved highway of the same length over an
unbuilt trail is the model working as specified, not a defect.

The data component: 4.52 failing miles on the router's answer, all of it SR 447
with no shoulder measurement (see the shoulder table below). A rider who knows
SR 447 should say whether that reads true.

### What Part 1 could not check

The eight remaining relations are Lake Tahoe fragments and duplicate
super-relation entries of the two Tahoe-Pyramid records; none adds an
independent corridor. **There is no published route relation anywhere in Clark
County, Elko, Winnemucca, Ely or Pahrump**, so Part 1 verifies the Tahoe basin,
the Truckee corridor and one line across the middle of the state, and nothing
else.

## Part 2 — the corridor chain walk

Lesson C2: a long corridor absorbs a severance, so walk it in short hops and
route each one against the distance *along* the corridor.

```
U.S. Bicycle Route 50   (25 hops of ~5 mi, 1 skipped as degenerate)  worst 1.0x
50 (California)                                  (1 hop)             worst 0.7x
Tahoe-Pyramid Bikeway                            (1 hop)             worst 0.8x
Stateline to Stateline Bikeway                   (1 hop)             worst 0.8x
South Tahoe Bikeway                              (1 hop)             worst 0.0x
Tahoe-Pyramid Trail                              (1 hop)             worst 0.0x
Wadsworth-Pyramid Lake Section                   (2 hops)            worst 0.6x
```

**USBR 50's worst five-mile hop across the whole state is 1.0×.** Twenty-four
hops from Lake Tahoe to the Utah line, and not one of them detours. That is the
result the end-to-end 79% figure could not give: the corridor is continuous,
hop by hop, for 400 miles.

**One hop was skipped and the skip is reported rather than swallowed.** The
chain walker first reported USBR 50 **SEVERED**, on a hop whose two endpoints
are the same coordinate — `-117.8543,39.2736 → -117.8543,39.2736`, five miles
apart *along* a ribbon stitched out of 497 disconnected parts. That is a defect
of the spine, not of the graph, and reporting it as a severance is the mistake
lesson A7 exists to prevent. `verify_corridor_chain.mjs` now skips and counts
hops under 25 m, and says how many, because "checked and fine" and "could not be
checked" are different answers.

**The other corridors are single hops** because they are short, so the chain
walk adds nothing beyond Part 1 for them.

## Part 3 — twenty named trips across the state's distinct regions

Part 1 reaches three regions. The state has more, so twenty trips were routed
against what is known about them from the road network and from named local
rides. The full report is `ROUTING-AUDIT.md`; this section records what each
region's result verifies.

| region | trips | what it verifies |
| --- | --- | --- |
| Las Vegas valley | 6 | The metro routes. The River Mountains Loop Trail, the Las Vegas Wash trails and RTC's bike-lane registry are all in the graph and used: Henderson → Boulder City stars at 1.05× the shortest with **zero failing metres**. |
| Colorado River / Hoover Dam | 2 | Boulder City → Hoover Dam stars at 10.2 mi with zero failing metres and 150 m of dismount — the Historic Railroad Trail through the tunnels. Bicycles are barred from the bypass bridge and the router never offers it. |
| Reno / Sparks | 2 | The Truckee River path is continuous: the 4-mile hop stars at 4.2 mi with zero failing metres. No same-name seam. |
| Lake Tahoe | 2 | Carson City → Spooner Summit stars at **1.01×** the shortest with zero failing metres, on 2,200 ft of climbing in 12 miles. |
| Carson Valley | 1 | Carson City → Minden routes at 1.04× the crow — the flattest, cleanest geometry in the state. |
| Northeast (Elko) | 1 | Elko → Spring Creek routes; the sparse northeast is connected. |
| North-central (Winnemucca) | 1 | Winnemucca → Golconda has no parallel road to I-80 in OSM; with freeways off the answer is 59 miles. Verified rather than assumed. |
| Great Basin interior (Ely) | 2 | Ely → McGill at 1.05×; Ely → Baker at 1.41× over two 7,000 ft summits. |
| Virgin River (Mesquite) | 1 | **The one failure.** See below. |
| Long inter-city | 3 | Las Vegas → Pahrump (64.6 mi, no freeway), Reno → Fallon (92.7 mi), Ely → Baker (62.4 mi). |

### The failure — Mesquite → Bunkerville

**Diagnosis: a severed link, severed by a rule rather than by geometry.**

The router returns "no route exists" for a trip of 4.7 miles. An unconstrained
breadth-first search over the directed arcs finds a path in 69 edges and 7.8 km,
and both endpoints are in the giant component. The blocking run is 2.3 km of
Riverside Road — **SR 170**, a paved two-lane state highway with a concrete
bridge, the only bike-legal crossing of the Virgin River — marked as a
mountain-bike trail because OSM relation **8643414**, the long-distance "Plateau
Passage" bikepacking route, lists three of its ways among 104 members. With
`allowMtbTrails: true` the trip is 4.7 miles.

This is `ROUTING-AUDIT.md`'s finding N1, with its blast radius measured on all
three shipped graphs. It is not repaired here because the repair is a judgement
about shared classification.

## The corridor-severance gate

All six corridors nominated in `corridors.json` **before anything was built**
connect on ordinary roads with no freeway:

```
PASS  Reno to Carson City — Washoe Valley                    35.9 mi, 1.4x straight
PASS  Reno to Sparks — Truckee River Path                     3.6 mi, 1.2x straight
PASS  Boulder City to Hoover Dam — US 93 and the Railroad Trail 7.9 mi, 1.3x straight
PASS  Las Vegas to Henderson — the valley crossing            15.5 mi, 1.2x straight
PASS  Las Vegas to Pahrump — NV 160 over Mountain Springs     68.8 mi, 1.5x straight
PASS  Elko to Spring Creek — rural northeast                  16.6 mi, 1.4x straight
```

Oregon's five and Washington's four still pass, so nothing shared moved.

## The directional-shoulder check, run by hand

`test_shoulder_directional_fill.mjs` only measures states whose `status` is
`released`, and Nevada ships `preview` (`STATUS.md` says why). Measured directly
against the shipped graph instead:

**both/either = 0.999** — 1,997 of 1,998 shoulder-carrying road miles have a
value in **both** directions, against a default floor of 0.6. Washington
measures 0.873 and Oregon 0.762.

Nevada is near-perfect here for a reason that is a fact about NDOT rather than
about this adapter: NDOT records one outside-shoulder value per route section
and books each direction of a divided highway as its own RouteID with its own
geometry, so the directional split that cost Oregon a third of its state
highways is handled by the source's own structure. Lesson B5 did not travel.

## The shoulder table, because it explains most of the disagreements above

On roads at 45 mph and above, where the shoulder rung decides a verdict:

| | Nevada | Oregon | Washington |
| --- | ---: | ---: | ---: |
| road miles at 45+ mph | 7,682 | 12,641 | 13,508 |
| bike lane or better, shoulder moot | 7.2% | 5.3% | 2.1% |
| passes on a **measured** shoulder ≥ 4 ft | 23.4% | 38.8% | 40.0% |
| fails on a **measured** shoulder < 4 ft | 1.1% | 15.3% | 14.8% |
| fails on **no measurement at all** | **68.2%** | 40.5% | 43.1% |

98.4% of Nevada's failing fast-road mileage fails on absence of evidence. Every
"failing miles" number in Part 1, and every over-long recommendation in
`ROUTING-AUDIT.md`, is downstream of that row.

## What could not be verified, and what it would take

1. **Whether any of these routes is pleasant to ride.** Nothing here is a field
   test. Readiness stops at 7 for this reason.
2. **The Las Vegas valley against a published corridor.** There is no
   `route=bicycle` relation in Clark County. Part 3's six metro trips are the
   substitute and they are weaker evidence: they verify that the network
   connects and that RTC's facilities reach the graph, not that the router's
   answer resembles what a local rides. Mapping the River Mountains Loop Trail
   and the Las Vegas Wash trails as route relations would fix this for the next
   import.
3. **Whether I-80's `bicycle=no` tagging in the Truckee Canyon matches the
   posted signs.** The whole Tahoe-Pyramid diagnosis rests on it, and it is one
   roadside observation away from being confirmed or overturned.
4. **Whether NDOT's 2019-vintage posted speeds still hold.** 1,485 of 1,605
   spans carry `DataSource = "2019 HPMS Speed Limt"`. The shared builder lets
   agency speed fill only an *estimated* value and never overrides an OSM
   `maxspeed` tag, which bounds the damage, but a stale limit on a signed
   highway is checkable from the saddle.
5. **The 5,239 miles of fast road with no shoulder answer.** The single most
   valuable thing a rider could bring back is a dozen spot readings on rural
   two-lane highways — enough to say whether the pessimistic reading is
   describing Nevada or libelling it.
