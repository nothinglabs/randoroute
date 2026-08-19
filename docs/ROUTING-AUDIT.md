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
| R1 | `highway=steps` stays out of the graph, so a junction is 299 m around | CLOSED — won't fix | owner's call |
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

### R1 — Steps are the only link, so the router rides 299 m around 19 m (CLOSED — WON'T FIX)

> **Closed by the project owner, 2026-08-19.** The Wahkiakum steps were
> inspected on Street View and judged not something to send a rider over
> (they are tagged `ramp=no`: no wheel gutter, so the bike is carried).
> `highway=steps` stays out of the graph as a class. The detour below is
> therefore CORRECT — the two sides of that junction genuinely are 299 m
> apart by bike-legal ways, and the router is reporting the network
> honestly. Kept here because the measurements are sound and the next
> person to see a 900 m loop at this junction should find this rather than
> re-investigate it.

The original finding, now read as explanation rather than defect:

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

---

# Round 2 — 2026-08-19, after the Oregon rebuild

30 routes: 15 Washington (12 on ground round 1 never touched, 3 verifying the
fixes round 1 produced) and 15 Oregon, run for the first time against a graph
whose OR-signed highways actually carry ODOT data. Washington
`sha-c043f268453b`; Oregon rebuilt to `sha-89519d129241`.

## Did round 1's fixes work?

| fix | verdict |
| --- | --- |
| `.762` practical-window floor | **WORKED** — Kirkland → Redmond now stars a 6.87 mi route with 90 m failing (0.8%), against the 4.35 mi / 2,759 m (39%) route it used to star |
| `.762` fail-share guard | **UNTESTED** — the star came back with basis `lowest-score`, so the floor alone moved it. The guard never fired, on this or any of the other 29 trips |
| `.763` trail credit 0.12 → 0.08 | **FAILED** — neither motivating trip changed its star |
| `.764` Oregon rebuild | **WORKED at the data layer** — Barbur Blvd went from null stress to 57% shoulder-known, and Portland → Beaverton now produces a low-stress Fanno Creek route it could not have justified before |

### R11 — Why the trail-credit change could not have worked (my error)

**Repro:** `[-122.2835,47.7491] -> [-122.3543,47.6685]` still stars Route D at
13.11 mi / 66 min over Route A at 9.46 mi / 49 min with **zero** failing
metres. `[-122.2010,47.6150] -> [-122.3321,47.6062]` still stars Route F at
14.00 mi over an 11.49 mi I-90 route.

The score gap between a metre of ordinary road and a metre of trail is
**0.28 s/m**, and only 0.08 of that is `TRAIL_BONUS_S_PER_M`. The other 0.2 is
`NETWORK_GAP_PRICE_S_PER_M`, the charge on ordinary road, which the change
never touched. From the router's own breakdown on Lake Forest Park:

```
A: 3497 = travel 2958 + dismount 19 + ordinary  818 - trail  298
D: 2521 = travel 3930 + dismount 19 + ordinary   13 - trail 1442
```

Solving for the trail rate at which A wins gives **c < 0.0117** — a further
7× cut, not the 1.5× that shipped. Bellevue needs **c < 0.0436**. No single
value satisfies both, which is the real finding: the exchange rate is set by
a *pair* of constants and tuning one of them cannot express "prefer trail,
but not at any distance". Even at trail credit **zero** the exchange is still
2:1 and Lake Forest Park flips by only 167 s.

The lever that matches the intent is a price on *excess distance over the
shortest practical candidate* — the rider declined a hard cap, and this is the
soft form of the same idea.

## Washington — new findings

### R12 — Bellevue → Seattle computes the I-90 route and shows it to nobody (BUG, ROUTER)

**Repro:** `[-122.2010,47.6150] -> [-122.3321,47.6062]`.

All six offered routes cross on SR 520. The I-90 Trail route — 11.49 mi,
62 min, 138 m failing — survives every filter, is lettered as an extra, and is
never presented. Offered Route B is the same 11.45 mi length with **1,825 m**
failing, thirteen times as much.

**Probable mechanism** (read, not proven): the six slots go to `selected` plus
the `required` roles, and the I-90 family holds none of them. It misses
`safestOverall` because `compareSafety` prices dismount ×3: I-90 scores
`138 + 3×439 = 1455` against the star's `165 + 3×365 = 1260`. A 74 m
difference in walked distance, tripled, is what costs it the one slot that
would have guaranteed it a place.

**Open:** whether 439 m of dismount on a route through the Mount Baker Ridge
*bicycle* tunnel is real or a tagging artefact. If artefact, this is also DATA.

### R13 — The strict escape route takes two slots (BUG, ROUTER, minor)

Bainbridge → Poulsbo is 12.1 mi across the Agate Pass Bridge. Routes E
(44.5 mi, `fully-matching`) and F (47.0 mi, `friendly`) are both the same
Bainbridge → Seattle → Edmonds → Kingston double-ferry loop. Two of six slots,
one shape. Same at Bellingham → Ferndale, where Route F is 36.6 mi for a
9.6 mi trip. The availability guarantee is right; showing it twice is not.

### R14 — Washington explainables (EXPLAINABLE)

| trip | flagged | the constraint |
| --- | --- | --- |
| Olympia → Tacoma | 8,947 m backtrack | Joint Base Lewis-McChord severs the direct corridor. The dip south is the Chehalis Western Trail to Yelm — the actual regional route. The coastal alternative carries 12,841 m of failing arterial |
| Yakima → Ellensburg | star 49.7 mi vs 37.3 direct | SR 821 Canyon Road is **32,030 m of level 4**. Correct under the rules — but this is the best-known road ride in the state, and 60% of it scoring red deserves a field verdict on shoulder/speed scoring |
| Bellingham → Anacortes | ×2.61 | Chuckanut Drive costs 7.3 km failing; the star goes inland via Old Samish with zero failing metres, on `fully-matching-override` |
| Bainbridge → Poulsbo | ×4.56 | Agate Pass Bridge is the only land link off the island |
| Spokane → Coeur d'Alene | 35 m self-touch | Centennial Trail passing itself at the Don Kardong Bridge — a known false positive of the self-touch metric on riverside loops |
| Tri-Cities | 1,154 m backtrack | Kennewick and Richland sit across a confluence; crossings are only at the bridges |

## Oregon — first honest audit

### O5 — The freeway weight makes `allowFreeways: true` inert (BUG, ROUTER)

**Repro:** Cascade Locks `[-121.8940,45.6790]` → Hood River `[-121.5150,45.7054]`,
29.6 km crow. All six options come back **159–191 km** around Mount Hood;
the recommendation is 167 km at ×5.65.

A legal, admissible route exists at **31.4 km**: local streets → Forest Lane →
**17.0 km of I-84** → Wyeth Road → Frontage Road. Zero prohibited arcs in
67.7 km of I-84 checked; 10.1 km of it carries a 10 ft shoulder in the gap
that matters.

**Mechanism, verified in source.** `router-worker.js` applies
`cost *= activeWeights.freeway` *on top of* `modeMult`, which returns the
level-4 multiplier. A stress-rated interstate is level 4, so the combined
multiplier is:

| lens | freeway × failRoad | effective |
| --- | --- | --- |
| direct | 60 × 1.5 | **90×** |
| balanced | 60 × 9 | **540×** |
| low-stress | 60 × 30 | **1800×** |

17 km at 90× prices as 1,530 km-equivalent against a 167 km detour on level-1
road. **`allowFreeways: true` is arithmetically indistinguishable from `false`
on any stress-rated interstate.** In Washington that is harmless; in the Gorge
it turns Cascade Locks into a routing island.

Underneath sits a real constraint: excluding freeways, a flood-fill from
Cascade Locks reaches **1,013 nodes** against 685,865 from Hood River. The
Historic Columbia River Highway State Trail is now **six** disconnected pieces
(the rebuild fragmented it slightly further, 4 → 6). Whether each gap is
unbuilt trail or an OSM severance is still undetermined — but the ~9.6 km
Mitchell Point → Hood River gap is probably genuine, which is exactly what
makes the freeway weight the deciding factor.

### O6 — ODOT shoulder data is not reaching the graph (BUG, DATA)

**Repro:** Corvallis `[-123.2620,44.5646]` → Newport `[-124.0534,44.6368]`
still recommends 100.3 km over Marys Peak against 85.4 km on US 20.

| road | shoulder known in graph | rule level |
| --- | --- | --- |
| US 20 Corvallis–Newport | **1%** | level 4 on 66.6 of 67.6 km |
| Marys Peak Rd / FR 30 / 1000 Line | 0% | level 1 throughout |
| *US 20 Albany–Corvallis (control)* | **77%** | level 2 on 16.2 of 18.7 km |

The source has the data: `blts.geojson.gz` route `033` carries `ShoulderWidth`
on **50%** of its length, evenly spread. `LTS_Bicycle` from the *same records*
reaches 99% of graph edges; `ShoulderWidth` reaches 1%. Route `281` (Dee Hwy)
is 49% in source → **0%** in graph. Route `026` is 51% → 51%, so the pipeline
works in general.

Unknown shoulder at 55 mph fails `maxSpeedNoShoulder`, so the measured highway
scores 4 and the unmeasured gravel scores 1 — the same inversion the route-prefix
fix was meant to end, one layer down. The 0.065 s/m unpaved penalty cannot
close a 4-vs-1 gap. **Why 033 and 281 lose shoulder while 026 keeps it is not
yet traced.**

### O7 — Oregon explainables (EXPLAINABLE)

| trip | the constraint |
| --- | --- |
| Portland → Gresham | Springwater Corridor is car-free and level 1 for all 28.1 km; the 1.15 km dogleg to Sellwood is the cost of reaching it |
| Portland → Beaverton / Hillsboro | the West Hills. Every direct line is a steep level-2/4 climb; the recommendation trades ~8 km for the Fanno Creek Trail |
| Eugene → Coburg | no low-stress river crossing exists — Coburg Rd is level 4 for 22.6 of 30.3 km and the next crossing is 25 km north. Three of six slots spent on the same 65–72 km detour is waste, though each is honest |
| Astoria → Seaside, The Dalles → Hood River | single-corridor geography |

Clean with no flags worth chasing: Albany → Corvallis, Medford → Ashland
(Bear Creek Greenway), Bend → Sisters, Portland → Sellwood, Portland →
Vancouver, Eugene → Springfield, Salem → Keizer.
