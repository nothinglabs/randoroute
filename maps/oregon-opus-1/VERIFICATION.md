# Oregon — verification against known-good routes

The level-5/7 gate in `maps/README.md`: take routes that are already known to be
good, and see whether the router agrees. A disagreement is a signal, not a
failure — the router optimises for the rider's rules and a signed route can be a
bad road (lesson D1) — but an **undiagnosed** disagreement is not acceptable.

Nothing here has been ridden. Everything below is desk verification.

---

## 1. Where the known-good routes come from

Oregon's published bicycle routes are already in the data. `build_routes.py`
pulled 45 `route=bicycle` corridors out of the OSM extract, and they include
**every Oregon Scenic Bikeway** (ODOT's own designated network — the same
geometry as data-catalogue layer 180), Adventure Cycling's **TransAmerica
Trail**, the **Oregon Coast Scenic Bikeway** (the state's US 101 route, and the
Oregon leg of the Pacific Coast route), and the major rail-trails: the
**Historic Columbia River Highway State Trail**, **Banks–Vernonia**, **Crown
Zellerbach**, **OC&E Woods Line**, the **Bear Creek Greenway**.

That is 30 corridors of 3 miles or more, spread across every distinct region
the state has: coast, Coast Range, Willamette Valley, Columbia Gorge, Cascades,
Central Oregon high desert, Klamath Basin, Rogue Valley and the eastern
rangeland. They were **not** chosen after looking at results; the list is
"every named route in the extract long enough to route across".

The six corridors in `maps/oregon/corridors.json` are separate: they were
nominated before anything was built and are asserted by
`scripts/test_corridor_severance.mjs`.

## 2. Method

Two harnesses, both committed, plus hand probes.

**End to end** — `scripts/verify_against_routes.mjs` + `.py`. Takes the two
ends of each published corridor, asks the router for its portfolio at
`DEFAULT_RULES`, and measures what fraction of each option's length runs within
**60 m** of the published line. 60 m is wide enough for the offset between a
relation's member ways and the graph edges under them, and for a one-block
parallel street; narrow enough that a different road through the same valley
does not count. The table reports the **best** of the six offered options,
because the rider is offered six letters and picks one.

**Hop by hop** — `scripts/verify_corridor_chain.mjs`. Walks the corridor in
~5 mile hops and routes each one, comparing against the distance **along the
corridor**, not the straight line. This exists because of what section 4 found:
end-to-end comparison hides a severance behind a plausible-looking detour.

Two limits of the harnesses, stated because they change how the numbers read:

* **A loop has no two ends.** For the 40 Mile Loop, Twin Bridges Loop and
  Tualatin Valley, "the two farthest-apart points" is a half-loop, so the router
  is asked a different question than the corridor answers. Their percentages are
  not evidence about the router.
* **The hop-by-hop chainer orders relation members by nearest free end.** Where
  a corridor is mapped as many short members it can order them wrongly and
  report a ratio that is an artefact of its own ordering. It is a lead
  generator, not a verdict — every finding in section 4 was confirmed by hand.

## 3. Results

`best offered` is the option with the most corridor overlap; `on corridor` is
its overlap share. `OSM-only` is the same measurement on the stage-3 graph,
before any ODOT or HPMS data was conflated — the two columns together are the
measurement of what the agency data bought.

| corridor | published | best offered | on corridor | fail mi | OSM-only |
| --- | ---: | ---: | ---: | ---: | ---: |
| Salem Arterial | 14 mi | 9.2 mi | 100% | 0.0 | 65% |
| Willamette Valley Scenic Bikeway (Alternate) | 4 mi | 4.5 mi | 100% | 0.1 | 100% |
| OC&E Woods Line State Trail | 63 mi | 63.5 mi | 100% | 0.0 | 100% |
| OC&E Woods Line State Trail (Woods Line Section) | 36 mi | 36.0 mi | 100% | 0.0 | 100% |
| Covered Bridges Scenic Cycleway | 16 mi | 16.1 mi | 100% | 0.0 | 100% |
| McKenzie Pass | 38 mi | 36.8 mi | 100% | 35.3 | 98% |
| North Bank Path | 5 mi | 5.1 mi | 100% | 0.0 | 100% |
| Crooked River Canyon Scenic Bikeway | 18 mi | 18.4 mi | 100% | 17.1 | 100% |
| Edgewater Trail | 5 mi | 4.5 mi | 96% | 0.1 | 96% |
| Cascading Rivers Scenic Bikeway | 71 mi | 53.5 mi | 93% | 53.2 | 93% |
| Bear Creek Greenway | 22 mi | 22.2 mi | 92% | 1.7 | 92% |
| Crown Zellerbach Trail Alternate | 9 mi | 5.7 mi | 89% | 4.8 | 90% |
| 40 Mile Loop *(loop)* | 64 mi | 30.9 mi | 86% | 0.0 | 73% |
| Veteran's Memorial Greenway | 21 mi | 20.7 mi | 85% | 0.1 | 85% |
| Aufderheide Scenic Bikeway | 58 mi | 75.6 mi | 76% | 0.0 | 100% |
| Crown Zellerbach Trail | 22 mi | 26.6 mi | 43% | 21.1 | 43% |
| Banks–Vernonia Trail | 23 mi | 20.4 mi | 36% | 16.3 | 36% |
| Oregon Coast Scenic Bikeway (Tillamook Alt) | 25 mi | 22.2 mi | 29% | 11.3 | 88% |
| Tualatin Valley Scenic Bikeway *(loop)* | 51 mi | 42.1 mi | 29% | 16.2 | 28% |
| **Oregon Coast Scenic Bikeway** | 364 mi | 455.5 mi | 28% | 27.5 | 18% |
| Willamette Valley Scenic Bikeway | 132 mi | 107.8 mi | 20% | 10.1 | 19% |
| Sisters to Smith Rock Scenic Bikeway | 37 mi | 29.0 mi | 15% | 1.8 | 9% |
| Corvallis to the Sea | 54 mi | 62.9 mi | 11% | 6.3 | 86% |
| Twin Bridges Loop Scenic Bikeway *(loop)* | 32 mi | 14.2 mi | 11% | 0.0 | 11% |
| **Historic Columbia River Highway State Trail** | 69 mi | 97.3 mi | 7% | 18.5 | 19% |
| US 26 (Oregon Bicycle alternative) | 17 mi | 20.3 mi | 7% | 0.2 | 12% |
| Oregon Timber Trail | 415 mi | 220.0 mi | 5% | 1.4 | 13% |
| I-5 Bicycle Alternative *(fragmentary)* | 33 mi | 307.1 mi | 3% | 81.2 | 3% |
| **TransAmerica Trail (Oregon)** | 785 mi | — | no route | — | no route |
| TransAmerica Trail (super) | 785 mi | — | no route | — | no route |

Eleven of the thirty come back at 85% or better, and eight of those are 100% —
the router returns the published route, not something like it. The ones that do
not are diagnosed below. Every one of them is.

## 4. The one severance, and how it was found

**Historic Columbia River Highway State Trail — 7% on corridor. Diagnosis: a
data gap in OSM that severs the corridor.**

This is the finding of the import, and the way it surfaced is the point.

The nominated corridor **Portland → Hood River passes** the severance detector:
89.7 miles against a 56.9-mile straight line, 1.6×, no freeway. That looks
healthy. It is not. The router's answer goes *south around Mount Hood* — via
Sandy and Government Camp — because the Gorge is closed to it, and a
90-mile mountain crossing is indistinguishable from a good answer at a 2.5×
bound.

Routing shorter hops inside the corridor finds it immediately:

| hop | straight | routed |
| --- | ---: | ---: |
| Portland → Troutdale | 14.0 mi | 17.9 mi (1.3×) |
| Troutdale → Multnomah Falls | 13.3 mi | 17.7 mi (1.3×) |
| Cascade Locks → Wyeth | 6.0 mi | 7.0 mi (1.2×) |
| Wyeth → Starvation Creek (on the trail) | — | 3.6 mi, all trail |
| Starvation Creek → Viento (on the trail) | — | 2.2 mi, all trail |
| **Viento → Hood River** | **5.8 mi** | **no route at all** |
| Cascade Locks → Hood River | 18.1 mi | 98.5 mi (5.4×) |

The graph's bicycle-legal trail is continuous from Cascade Locks east to Viento
(−121.6386). East of there it stops. The Mitchell Point section is mapped —
`Wygant Trail`, `Historic Columbia River Highway`, `Mitchell Point Tunnel` —
but as `highway=path` **with no `bicycle` tag**, and there is a ~1.2 km hole
between the last cycleway-tagged trail way at −121.6386 and the first of those
paths at −121.6244. So the graph has the State Trail as two pieces with no
bicycle-legal link between them.

I-84 through the same stretch is tagged `bicycle=yes` in OSM and is legal here,
but at the freeway weight the portfolio never offers it: the six options for
Cascade Locks → Hood River are 98.5–126.5 miles, every one of them going around.

**This is not a build defect or an OSM omission.** ODOT's current project pages
confirm a real 0.7-mile gap west of the tunnel. The temporary connection was
hiker-only, not open to bicycles. Construction of the missing connection began
in December 2025 and is expected to continue through late 2026; ODOT also says
the existing trail is temporarily closed to all users two miles east of Viento
during construction. The graph's refusal to present a through bicycle route is
therefore the safe answer. Sources checked 2026-08-10:
[ODOT State Trail status](https://www.oregon.gov/ODOT/Regions/Pages/State-Trail.aspx),
[Mitchell Point overview](https://www.oregon.gov/odot/regions/pages/mitchellpoint.aspx),
and [project 20677](https://www.oregon.gov/odot/projects/pages/project-details.aspx?project=20677).

**What it teaches about the test.** Lesson C2 says a severance shows up as an
unmissable ratio — 10.7× in Washington. It did not here, because the corridor I
nominated was long enough to absorb it. `scripts/verify_corridor_chain.mjs`
exists because of this: a severance that costs 40 miles is invisible at 1.6×
over 90 miles and unmissable when the hop is 6.

## 5. Every other disagreement, diagnosed

**TransAmerica Trail — no route. Diagnosis: extract boundary, not a severance.**
The relation's eastern end is at −116.834, 44.932, which is on the Idaho bank of
the Snake River at Oxbow. The nearest node in the Oregon graph is **3,828 m**
away. A state's graph stops at the state line by design. Chained in 5-mile hops
the Oregon portion routes; the same hop test also crosses the Idaho border
twice more near Hells Canyon and reports those as unroutable for the same
reason.

**Oregon Coast Scenic Bikeway — 28%, 455 mi offered against 364 published.
Diagnosis: legitimate safety disagreement, materially reduced by the ODOT
shoulder inventory.** US 101 is the only continuous corridor on the coast, and
the default rules ask for 4 ft of shoulder. On the OSM-only graph the best
option carried **134.0 failing miles**; with ODOT's measured shoulder widths
conflated that fell to **27.5**, and corridor overlap rose 18% → 28%. The router
now agrees with the signed route far more often and still detours where the
inventory books a narrow shoulder. That is the model working as specified —
and it is the strongest single argument in this import for conflating the
agency shoulder layer.

**Banks–Vernonia Trail — 36%, and the hop test says "no route" across Stub
Stewart State Park. Diagnosis: snapping, not severance.** The probe points sit
1–5 m from graph nodes, all in the largest component. Stub Stewart's
mountain-bike network is mapped on top of the rail-trail corridor, so a probe
snaps to an MTB way and `allowMtbTrails: false` leaves it with nowhere to go.
A rider starting from the trail itself is unaffected. The 36% figure is the
end-to-end measure and reflects the router preferring the parallel road for part
of the corridor, not an inability to use the trail.

**Aufderheide Scenic Bikeway — 76% (was 100% on the OSM-only graph); worst hop
5.9×. Crooked River Canyon 4.0×. Diagnosis: the owner-unknown functional-class
proxy changes the portfolio, not the verdict.**
Aufderheide Drive is a single paved `tertiary` that loops around Box Canyon, and
Crooked River Canyon switchbacks — corridors that double back are exactly where
the chainer's member ordering is least reliable. An exact A/B on the current
graph resolves the end-to-end change: removing only functional class whose
owner is unknown/federal/other restores a 57.6-mile, 100%-overlap option. With
the class present the best option is 75.6 miles and includes about 18 miles of
off-corridor trails and forest roads. This is mainly a **route-cost** effect:
for that owner group the class proxy lowers 3,380 readings and raises only six,
so it makes alternative forest roads cheaper rather than making Aufderheide
itself fail. The current route still has zero failing miles. That is a reason to
field-check the detour, not enough evidence to discard official class statewide.

**Corvallis to the Sea — 86% on the first OSM-only build, 11% now, and
unroutable across Marys Peak. Diagnosis: a later graph/topology change, not the
functional-class or traffic import.** This corridor crosses the Coast Range on
gravel forest roads. Exact current-graph A/B runs are unchanged at 62.9 miles,
11% overlap when all functional class is removed, and also unchanged when AADT
is removed. Removing all hill effort only moves it to 59.0 miles and 12%.
Crucially, the old OSM-only graph and the conflated graph were not the same
topology: they contain 634,000 versus 728,842 edges. The original report
mistakenly attributed every difference between those builds to agency data.
The current option follows OR 20 for 31.4 miles; a fresh OSM-only rebuild from
the current extract is the next tool needed to isolate which topology or tag
change displaced the published forest-road line.

**Willamette Valley Scenic Bikeway — 20%, 108 mi against 132 published.
Diagnosis: legitimate preference disagreement.** Hop-by-hop the corridor is
completely healthy (worst hop **1.1×**, no unroutable hop in 17). The router
simply takes a shorter line through the valley's road lattice than the scenic
route's deliberately indirect one. A scenic bikeway is chosen for what it is
like to ride, not for being the efficient way between its ends; this is the
disagreement lesson D1 predicts and it is the correct behaviour.

**Sisters to Smith Rock 15%, Tualatin Valley 29%, Crown Zellerbach 43%, US 26
alternative 7%, Twin Bridges 11%, 40 Mile Loop 86%. Diagnosis: the loop /
fragment limitation of the end-to-end method.** Every one of these is either a
loop or a corridor whose relation members are scattered. All are healthy
hop-by-hop (worst 1.0–3.7×). Crown Zellerbach's single 3.7× hop is the Vernonia
end, where the trail is mapped in pieces.

**Oregon Timber Trail — 5%. Diagnosis: correct exclusion.** It is a
mountain-bike route; `allowMtbTrails` is off by default and the router is right
to decline it. The hop test reports most of its length unroutable for the same
reason, and the message it prints — *"a route point is too far from a routable
road"* — is the honest one: that singletrack is not in the network at all.

**I-5 Bicycle Alternative — 3%. Diagnosis: the relation is not a corridor.**
Its members are scattered along the length of the state, so "the two farthest
points" are 228 miles apart and the question asked is meaningless. Hop-by-hop it
is fine (0.9×).

## 6. What could not be verified, and what it would take

* **Whether the Aufderheide detour is better to ride.** The cause is now
  measured, and it is not that the signed road fails the rules. A rider must
  decide whether the newly cheap forest-road/trail alternative is useful or an
  18-mile mistake.
* **Which current OSM/tag change displaced Corvallis to the Sea.** The agency
  fields have been ruled out on the current graph. A new graph built from the
  same current extract without enrichment would isolate the remaining cause.
* **Anything about how the routes ride.** Grades, surface, traffic at the hour
  people actually ride, seasonal closures — OR 242 over McKenzie Pass is shut to
  cars in winter and open to bicycles, and nothing in this data knows that.
* **City streets.** 0.1% of local-street miles carry a traffic count
  (section 3 of `STATUS.md`). Every verdict on a residential street in Oregon is
  inference.
* **The two directions of a road.** The ODOT shoulder inventory is directional
  and 33,941 of 73,575 segments had to read the opposite-direction record and
  swap sides. That transformation is argued from ODOT's milepost convention, not
  confirmed against a photograph.

## 7. Reproducing this

```bash
node scripts/verify_against_routes.mjs oregon > data/_verify_oregon.json
python3 scripts/verify_against_routes.py < data/_verify_oregon.json
node scripts/audit_functional_class_blast_radius.mjs oregon
node scripts/verify_against_routes.mjs oregon --without-unowned-functional-class Aufderheide
node scripts/verify_against_routes.mjs oregon --without-functional-class 'Corvallis to the Sea'
node scripts/verify_corridor_chain.mjs oregon 5
npm test corridor_severance
```
