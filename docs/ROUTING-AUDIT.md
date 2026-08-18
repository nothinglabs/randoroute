# Routing audit

A survey of real trips across Seattle and Portland, looking for routes whose
shape a rider would call wrong — and, just as deliberately, for routes that
*look* wrong and are not. Both belong here. A route that detours two miles to
reach the only bike-legal bridge over a ship canal is correct, and writing down
*why* it is correct is what stops a future session from "fixing" it.

This is a findings document, not a specification. `docs/SAFETY-MODEL.md` is
where routing mechanics are defined; when a finding here changes a mechanic,
the mechanic's description moves there and this file keeps the evidence.

## How to reproduce anything in this file

```bash
# score the shape of every option the portfolio offers
node scripts/audit_route.mjs <spec.json> <outDir>

# draw the ones worth looking at
python3 scripts/audit_plot.py <outDir>/<id>.json
```

A spec names the state and the trips:

```json
{ "state": "washington",
  "routes": [
    { "id": "lfp-zoo", "name": "Lake Forest Park shore -> Woodland Park Zoo",
      "from": [-122.2835, 47.7491], "to": [-122.3543, 47.6685],
      "note": "field report: bizarre routing" }
  ] }
```

Rules and weights are **lifted from `app.js`**, not restated — `DEFAULT_RULES`
plus the two advanced options the app layers on, and both the default weights
and the direct-lens probe weights. That last part is not optional: without
`directProbeWeights` the worker returns two candidates instead of four or six,
and never the "Shorter" route the rider is actually looking at. Several early
probes in the investigation that produced this tooling were wrong for exactly
that reason, and reported "no problem" for a trip that had one.

## What the numbers mean

Judging a route by eye does not scale, and a bare polyline on white is close to
unreadable — without a destination, a scale bar and a straight-line reference
there is no way to separate a legitimate switchback from a wrong turn. So every
route is measured first; the measurements decide where to spend human attention.

| Metric | Meaning | Flagged at |
| --- | --- | --- |
| `backtrackM` | Largest ground the route gives back toward the destination | ≥ 150 m |
| `detourFactor` | Route length ÷ crow-flight distance | ≥ 1.6 |
| `selfTouchM` | Closest approach between parts more than 800 m apart *along* the route | < 60 m |
| `reversals` | Direction reversals over 150°, sampled every 120 m | ≥ 6 |

**`backtrackM` is the one to understand.** Let *progress(i)* be how much closer
to the destination the route has come by point *i*, as the crow flies. On a sane
route that curve only rises. Its largest drawdown — the most ground it ever
gives back — is exactly what a rider means by "it went the wrong way and came
back", and it is scale-free: a jog around a one-way block scores tens of metres,
a shore excursion hundreds, a wrong-side-of-the-lake blunder thousands.

`selfTouchM` is gated on distance *along* the path for a reason: an ordinary
switchback is close to itself in space **and** in path distance, so the gate is
what keeps a hairpin from being reported as a lollipop.

The thresholds decide where to look, not what is broken. A flag is an
invitation to explain, and roughly a third of flagged routes here turn out to be
correct.

## Verdicts

- **BUG** — the router does something a rider is right to call wrong, and there
  is evidence pointing at a mechanism.
- **EXPLAINABLE** — the shape is surprising and correct. The named constraint
  belongs in the finding, because that is the part worth tuning against later.
- **CLEAN** — nothing to see.
- **UNCLEAR** — flagged, not settled, with a note on what would settle it.

Findings are additionally classed **ROUTER** (logic) or **DATA** (an import or
conflation gap in the state's own data). The distinction matters most in Oregon,
which ships at readiness 7 against Washington's 8.

## Summary

40 routes, 2026-08-17, against `maps/washington` `sha-c043f268453b` and
`maps/oregon` `sha-5ab12bfaafb0`.

| # | Finding | Verdict | Class |
| --- | --- | --- | --- |
| R7 | Kirkland → Redmond starred onto 3,304 m of failing arterial when 58 m alternatives exist | **BUG** | ROUTER |
| R1 | `highway=steps` never enters the graph, so a `bicycle=yes` stairway leaves two nodes 18.7 m apart with 299 m between them | **BUG** | ROUTER (build) |
| O2 | The Gorge has no legal non-freeway link; 18.5 mi becomes 97 mi with no "no reasonable route" signal | **BUG** | ROUTER + DATA |
| O1 | The shipped Oregon graph predates the route-prefix fix; `OR` highways carry no ODOT conflation | **BLOCKING** | DATA |
| R8 | Lake Forest Park: the reported trip's real faults are the recommendation and a grid gap, not snapping | **BUG** | ROUTER + DATA |
| R5 | The adaptive-ferry test's fixture no longer boards a ferry, so it asserts nothing | **BUG** | TEST |
| R9 | Trail credit buys ~5.6 m of trail per 1 m of road avoided, unbounded | UNCLEAR | tuning |
| O4 / R3 | `recommended` lands on longer, backtracking options; dominated near-duplicates crowd short trips | UNCLEAR | tuning |
| R6 | `PORTING-LESSONS.md` E6 quotes pre-`.735` dismount pricing | DOC | — |
| R2, R10, O3 | Water barriers, peninsulas, island access, bluffs — flagged and correct | EXPLAINABLE | — |
| R4 | Every previously-fixed routing failure still holds | no regression | — |

Roughly a third of flagged routes were correct, which is the point of writing
the explainable ones down.

## Findings

### R1 — Steps are the only link, so the router rides 299 m around 19 m (BUG, ROUTER)

**Where:** NE Wahkiakum Lane at the Burke-Gilman Trail, University District.
**Repro:** `washington`, `[-122.3035,47.6570] -> [-122.3830,47.6660]` (UW → Ballard),
Route C `quick-friendly` — *the recommended option*. Also
`[-122.3430,47.7560] -> [-122.3035,47.6570]` (Shoreline → UW), Route D
`combined-corridor`, again the recommended option.

**What happens.** UW → Ballard's recommended route reaches the Mason Rd NE /
Wahkiakum junction 111 m in, climbs 219 m north at 7.1 % and 12.1 %, drops
241 m down Pend Oreille Rd NE to the Burke-Gilman, then rides 443 m *back
south* — passing 19 m from where it stood 900 m earlier. Zero net progress for
900 m and a 12 % climb. On Shoreline → UW the same gap bites at the
destination: the route is 123 m from its endpoint, rides 900 m more, and
arrives having moved 19 m.

**The mechanism, confirmed by probe.** Graph nodes `4214` (`-122.30262,47.65622`,
Mason Rd) and `562759` (`-122.30238,47.65619`, Burke-Gilman) are **18.7 m
apart with no edge between them**. The shortest unconstrained path — ignoring
every cost, rule and legality — is **299 m**. Node `774277` is a degree-1 stub
hanging off a 1.6 m edge, pointing at the gap from the west.

In OSM the link is there and is one way: `way 243832208`, `highway=steps`,
`name=Northeast Wahkiakum Lane`, **`bicycle=yes` `foot=yes`**. It carries both
node `32271049` (the trail end) and `4059008863` (the stub end).

`classify_way()` in `scripts/build_graph.py` never admits `highway=steps`.
Cycleways, and paths/footways/bridleways/tracks with bike permission, are
infrastructure; untagged footways and paths join as walk-your-bike links; a
short sidewalk fragment between two kept ways joins as a stitch. Steps are the
one pedestrian way type with no route in at all — so a flight of steps a mapper
has explicitly marked `bicycle=yes` is dropped, and the two halves of a named
lane end up 299 m apart.

**Scope.** Statewide there are 8,884 `highway=steps` ways; **65** carry
`bicycle=yes`/`designated`, and 92 more carry a bike ramp or runnel tag. So the
conservative repair — admit steps as a dismount-priced walk link *only* where a
mapper has said bikes may use them — touches ~65 ways and needs no new pricing
concept, because dismount cost (60 s entry, ×3/×8/×32 by length) already
guarantees a walked link can never become a shortcut. Admitting all 8,884 is
the larger question and is not what this finding asks for.

**Not yet checked:** how many *other* junctions statewide are severed this way.
The Wahkiakum case was found by two unrelated trips in a ten-route sample,
which is weak evidence that it is not rare.

### R2 — Ship canal, Duwamish, Lake Washington detours (EXPLAINABLE)

Repeatedly flagged, repeatedly correct. Seattle's water barriers have very few
bike-legal crossings, so a route that runs kilometres the "wrong" way to reach
one is doing the only thing available.

| Route | Metric | The constraint |
| --- | --- | --- |
| Downtown → Alki | x1.91 | Duwamish crossings force a 4 km drop south to the Spokane St low bridge, then around Duwamish Head |
| Downtown → Mercer Island | x1.36 | Every option uses the I-90 Trail — the only bike crossing of Lake Washington here |
| Magnolia → Capitol Hill | 181 m backtrack | Magnolia is a peninsula; all three exits lie north or east of a west-side start |
| Ballard → Rainier Beach | x1.18, 538–875 m backtracks | Ballard Bridge approach, then the graded S Columbian Way climb back onto Beacon Hill |
| Sea-Tac → Downtown | 165 m backtrack | The airport landside has two bike-legal exits; declining Des Moines Memorial Dr means looping east |

Tuning note, not a defect: on Sea-Tac → Downtown the recommended option is 25 %
longer than the shortest offered, and on Capitol Hill → Fremont the *only*
direct descent (3.8 mi) is not recommended because it is 804 m of level-4 road
— Belmont Ave E, Lakeview Blvd E and Fairview Ave N, all sub-25 mph but
unsheltered. Both are the safety model working as specified.

### R3 — Dominated near-duplicates crowd the portfolio (EXPLAINABLE, worth tuning)

**Repro:** `washington`, `[-122.3120,47.6230] -> [-122.3499,47.6510]`
(Capitol Hill → Fremont), crow 2.6 mi.

Four of six offered options (C–F: `quick-friendly`, `section-frontier`,
`bike-residential`, `alt-balanced`) come back at 6.3 mi, x2.39–2.41, with
**1769–1969 m backtracks** — all of them descending 2.4 km south-west to
Pioneer Square before turning north. Each is individually explicable and all
four are dominated by option B at 5.6 mi. Meanwhile option A, at 3.8 mi, is not
recommended.

The safety model explains why they avoid Belmont/Lakeview. It does not explain
why a rider is shown four near-identical dominated routes on a 2.6-mile trip.
This is the portfolio-diversity knob, and it belongs with issue 2 in
`issues.md` rather than being a routing defect.

### R4 — Known concerns: no regressions (regression sweep)

Every previously-fixed routing failure still holds on the shipped graph.

| Concern | Status | Evidence |
| --- | --- | --- |
| Pier 50 land access | HOLDS | 725 m walk-in, no ferry |
| Seattle → Southworth by fast ferry, not Fauntleroy | HOLDS | 17.6 km, 16.8 km of it afloat; it is the recommendation |
| Palouse to Cascades, North Bend → Hyak | HOLDS | 27.0 mi shortest, trail and tunnel in the segments |
| Spokane Riverfront footbridge | HOLDS | 222 m crossing |
| Interurban join beside Alderwood Mall Blvd (`.737`) | HOLDS | 159 m |
| Start snaps to edge, not stub node (`.737`) | HOLDS | 0.31 m |
| 196th St SW gate pricing (`.735`) | HOLDS | 60 s entry, ×3/×8/×32; no backtrack |
| Tacoma → Olympia corridor (C1) | HOLDS | 36.3 mi shortest, 1.39× |
| DuPont → Nisqually (C1) | HOLDS | 6.8 mi |

### R5 — A ferry test that no longer boards a ferry (BUG, TEST)

`scripts/test_adaptive_corridor_ferries.mjs` exists to prove an adaptive
corridor never boards the same boat twice. Its fixture trip now returns six
options containing **zero ferry segments**, so every assertion in it passes
vacuously. The property itself is fine — re-anchored on Seattle → Port
Townsend it holds, with three `adaptive-corridor*` candidates taking two boats
each and no repeat.

This is the failure mode `AGENTS.md` names directly: a test that looks like
coverage and is not. It costs ~275 s per suite run to assert nothing.

### O1 — The shipped Oregon graph predates the route-prefix fix (DATA, blocking)

**Verdict: STALE**, established by comparison rather than inference. Loading
the pre-fix blob from `ac4d21e` beside the shipped graph gives *identical*
conflation counts — E 730,560; `OFFICIAL_SPEED` 104,791; `OFFICIAL_FACILITY`
11,372; `eLts > 0` 102,941; `eSh >= 0` 55,662. The commit that last touched
`maps/oregon/graph2.bin.gz` (`5789ae7`) added 447 bytes: the supplemental-route
stamp, not a rebuild.

So `.721`'s fix — `stateRoutePrefixes` in `region.json`, giving Oregon its `OR`
prefix — is in the code and **not in the data**. Per corridor:

| Corridor | edges | `eLts > 0` | `eSh >= 0` |
| --- | --- | --- | --- |
| Barbur Blvd (OR 99W) | 258 | **0** | **0** |
| Beaverton-Hillsdale Hwy (OR 10) | 15 | **0** | **0** |
| Macadam (OR 43) | 121 | **0** | **0** |
| 82nd Ave (OR 213) | 747 | **0** | 1 |
| Alsea Hwy (OR 34) | 34 | **0** | **0** |
| *Aurora Ave N (SR 99, WA)* | 1184 | 1128 | 1170 |
| *Bothell Way (SR 522, WA)* | 599 | 557 | 557 |

Statewide shoulder coverage is 7.62 % in Oregon against 15.14 % in Washington.

**The bias has a direction, and it is the dangerous one.** `edgeFacts` returns
`stressRating: 4, shoulder: 12` for US 20 but `stressRating: null,
shoulder: null` for OR 34 and Barbur Blvd. Because an unmeasured road carries
no measured penalty, **US-signed highways are scored as more hostile than the
OR-signed highways beside them** — not because they are, but because only one
of the two was matched. Every Oregon finding about road choice is downstream of
that, which is why the Portland findings below are classed DATA unless the
mechanism is clearly in the router.

**Consequence:** Oregon routing cannot be fairly audited until the graph is
rebuilt with `--region maps/oregon/region.json`. That needs the Oregon OSM
extract, Oregon census urban areas and Oregon DEM tiles, none of which are in
this container.

### O2 — The Gorge has no legal non-freeway link, and the router does not say so (BUG, ROUTER + DATA)

**Repro:** `oregon`, Cascade Locks `[-121.8940,45.6790]` → Hood River
`[-121.5150,45.7054]`. Crow 18.5 mi; every offered option is **86.6–109 mi**,
with backtracks up to 35 km — around the south side of Mount Hood.

**Confirmed by component analysis.** Excluding freeway edges (`eFlags & 4`),
Hood River is **not reachable** from Cascade Locks at all; including them, it
is. The two components come within **162 m** of each other, at Mitchell Point
(`-121.68565,45.66106` and `-121.68442,45.65988`) — a break in the Historic
Columbia River Highway State Trail. Raw topology crosses the Gorge in 31.9 km
via I-84.

Two separate defects stacked:

1. **DATA** — the 162 m break severs the only non-freeway corridor. This is an
   extract or import gap, and unlike O1 a conflation rebuild will not repair it.
2. **ROUTER** — with the trail severed, `weights.freeway = 60` prices roughly
   20 miles of legal I-84 shoulder *above a 97-mile detour around a volcano*.
   Worse, the portfolio then serves six such routes as ordinary options with no
   signal that no reasonable route exists. A rider asked to ride 97 miles
   instead of 18 is better served by "no reasonable bike route found" than by
   six confident wrong answers.

The freeway weight is doing its job on ordinary trips; what is missing is any
ceiling past which the detour is judged worse than the thing it avoids.

### O3 — Portland proper is largely healthy (mixed)

| Route | Verdict | Note |
| --- | --- | --- |
| Downtown → Hillsboro | CLEAN | x1.09 |
| Downtown → St Johns | CLEAN | x1.26; flagged backtrack is the Broadway/Weidler couplet |
| Downtown → Lake Oswego | CLEAN | Terwilliger / Boones Ferry |
| Downtown → Sellwood | EXPLAINABLE | Springwater Corridor exits 800 m south of the destination |
| Downtown → Forest Park | EXPLAINABLE | one-block NW 33rd/Vaughn jog on a 0.8 mi trip |
| Downtown → Beaverton | EXPLAINABLE (DATA) | the only bike-legal I-405/Barbur ramp; Barbur and OR 10 both scored with null stress |
| Downtown → Salem | EXPLAINABLE (DATA) | 2.2 km swing at Dayton/Amity avoiding OR 99W |
| Corvallis → Newport | BUG (DATA) | recommends ~50 km of gravel over Marys Peak (62.6 mi) against 53.6 mi on US 20 — the gravel is unmeasured, US 20 carries LTS 4, and the unpaved penalty is only 0.065 s/m |

The Corvallis case is O1 in miniature: the paved highway is penalised on
measured evidence, the gravel alternative escapes because nobody measured it,
and a 0.065 s/m surface penalty is not enough to close the gap. Re-audit after
a rebuild before treating it as a scoring defect.

### O4 — `recommended` can land on a longer, backtracking option (UNCLEAR, both states)

Seen in Oregon (Gresham 18.4 mi recommended against an unflagged 13.3 mi in the
same portfolio; Corvallis 62.6 mi of gravel against 53.6 mi paved) and in
Washington (Tacoma → Olympia stars at 53.1 mi against a 36.3 mi shortest;
Sea-Tac → Downtown recommends 25 % longer than the shortest offered).

Each individual case has a safety-model explanation, so this is not filed as a
defect. But the pattern recurs across both states and belongs with issue 2 in
`issues.md`: the recommendation is priced on `time + 1 s/m × (fail + dismount) +
0.2 s/m × ordinary riding`, and these are the trips where that pricing and a
rider's judgement part company. Re-check the Oregon half after a rebuild.

### R7 — Kirkland → Redmond is recommended onto two miles of failing arterial (BUG, ROUTER)

**Repro:** `washington`, `[-122.2070,47.6770] -> [-122.1215,47.6740]`, crow 4.0 mi.
The starred option is Route A, `direct-lens`.

Measured directly, and the numbers are the whole finding:

| | distance | time | failing metres |
| --- | --- | --- | --- |
| **A — recommended** | **4.35 mi** | **23 min** | **3,304 m (47 % of the route)** |
| B `quick-friendly` | 8.32 mi | 42 min | 119 m |
| C `alt-safer` | 8.33 mi | 42 min | 131 m |
| D `section-frontier` | 8.38 mi | 42 min | 70 m |
| E `combined-corridor` | 9.33 mi | 47 min | 80 m |
| F `friendly` | 9.33 mi | 47 min | **58 m** |

The rider is pointed at Lake St → Kirkland Ave → Kirkland Way → NE 80th →
**Redmond Way**: 2,378 m of Redmond Way at 30–40 mph with no shoulder and no
facility, 445 m of Kirkland Way at 30, 241 m of Kirkland Avenue at 45. Two
miles of level-4 road on a four-mile recommendation, while five alternatives
carry 58–131 m.

**Why this is a defect and not a bold choice.** The recommendation is priced at
`time + 1 s/m × (fail + dismount) + 0.2 s/m × ordinary riding`
(`docs/SAFETY-MODEL.md`). A's failing metres alone are worth **3,304 s** of
penalty — 55 minutes — against the **19 minutes** it saves over option B. By
the app's own stated pricing A should lose heavily, and it is starred anyway.
That contradiction is the finding.

**Traced mechanism** (found in code by the regional sweep; the route numbers
above are independently confirmed, this part is not): `practicalChoices` keeps
candidates within `1.5 × fastest + 800 m` and `1.4 × fastest + 300 s` — and the
fastest candidate *is* the lens route. Its own window admits nothing else
(every alternative is ≥ 13.4 km against an 11.3 km bound), so the pool
collapses to one member and "lowest score" is the lowest of a set of size one.
The zero-fail override that exists for exactly this case cannot fire either: it
requires an alternative with `failM ≤ 0.5`, and the best available misses by
58 m.

**A fix is already drafted** in `issues.md` §2 — anchor the practical window on
the fastest **non-lens** candidate. With B as the anchor the window admits A
through F and the star moves to B.

### R8 — What is actually wrong with the Lake Forest Park trip (BUG + DATA, revised)

**Repro:** `washington`, `[-122.2835,47.7491] -> [-122.3543,47.6685]`, crow 6.45 mi.

This is the field report that started the audit, and the first diagnosis in
this session was **wrong**. There is no start-snapping failure. The tap snaps
41 m to node `335757` on 41st Avenue Northeast; measured to edge geometry the
neighbours are Bothell Way NE at 54 m, 41st Ave NE at 58 m and the Burke-Gilman
at 85 m, and `nearestNode`'s local-network preference correctly prefers the
residential street over the arterial. The `.737` snapping defect does not
reproduce here. Two separate things are wrong instead:

**The recommendation (ROUTER/tuning).** The star is C `quick-friendly`, 13.11 mi
and 66 min at ×2.03, riding the whole Burke-Gilman down to the ship canal at
Fremont and then **1.7 km back north** up Phinney to the zoo. Option A does the
same trip in **9.46 mi / 49 min with zero failing metres**. C wins on price by
1,556 s, almost all of it trail credit. Its own 525 m backtrack is not a
decision at all — it is the trail's bulge around Sand Point.

**Option A's 376 m backtrack (DATA).** A runs NE 158th → 26th Ave NE → NE 150th
St west 912 m → 15th Ave NE north 407 m → NE 155th west. Probing edges named
"155th" in that box returns geometry only west of 25th Ave NE and east of
15th Ave NE: **NE 155th St has no edges between roughly 25th and 15th Ave NE**,
so the route drops a block south and climbs back to the street that crosses
I-5. A genuine grid gap, in the same family as R1.

### R9 — Trail credit is an unbounded per-metre subsidy (UNCLEAR, tuning)

An ordinary metre is priced `time + 0.2 s`; a trail metre `time − 0.12 s`. At
the model's own speeds (~0.19 s/m) that is 0.389 against 0.069 s/m — so the
recommendation will accept roughly **5.6 m of trail to avoid 1 m of ordinary
road**, bounded only by the practical window.

Two starred routes in this audit are that ratio in action: Lake Forest Park
above, and Bellevue → Downtown, where the star goes *north* to the SR 520 trail,
crosses, runs the Burke-Gilman to Fremont and comes **3.5 km back south** down
Westlake — 14.63 mi and 74 min for a 6.1 mi crow flight, against 12.07 mi and
65 min for the obvious I-90 crossing. Both crossings are legitimate; only the
credit ratio decides between them, and re-anchoring the practical window does
**not** change this one.

Filed UNCLEAR rather than BUG: the ratio is deliberate and documented, and it
is one of the knobs `issues.md` §2 is holding for a field verdict. But "5.6 m
of trail per 1 m of road avoided" is the number to judge, and these two trips
are what it buys.

### R10 — Explainable regional shapes, with their constraints (EXPLAINABLE)

| Route | Flagged | The constraint |
| --- | --- | --- |
| Renton → Mercer Island | 808 m backtrack, *identical on all six options* | Mercer Island's only bike access is the I-90 trail, landing 2 km north of the destination. Six options agreeing exactly is the signature of a hard constraint |
| Snoqualmie Falls → Issaquah | 10 m self-touch, 679–691 m dismount, all six | The falls overlook is footpath-only in the data; the nearest node is 231 m away with a single dismount stub. The walk out is honest |
| Kent → Downtown | 862 m backtrack | Leaves the Interurban early via Oakesdale Ave SW to buy the rider off 1,723 m of Interurban Avenue South |
| Redmond → Ballard | 471 m backtrack | The SR 520 trail's own alignment runs south-west to Overlake before turning west |
| Edmonds → Ballard | 246 m backtrack | The climb east off the Edmonds waterfront bluff; the Interurban corridor is inland |
| Mukilteo → Downtown | 1,344–2,474 m backtracks | *The spec's "Everett" start is actually Mukilteo.* The Interurban's north end is in Everett proper, so options climb the bluff to reach it. Re-run from `[-122.2021,47.9790]` before drawing conclusions about Everett |

Bothell → UW is clean end to end (0 failing metres, 94 % trail) and usefully
**does not** reproduce R1: arriving from the north-east and turning off at Pend
Oreille Rd lands on the correct side of the severed steps link. R1 needs an
approach from the west along the Burke-Gilman.

### R6 — `PORTING-LESSONS.md` E6 describes pricing that no longer ships (DOC)

Lesson E6 records dismount pricing as ×4/×8 with a six-minute entry penalty.
The shipped model is ×3/×8/×32 with a **60-second** entry penalty (`.735`,
after the entry fee at six minutes priced an Interurban crossing gate near ten
minutes and pushed routes onto failing streets). The lesson's `Travelled`
ledger should record the correction rather than the superseded numbers.
