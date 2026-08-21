# Routing audit

A survey of real trips across Seattle and Portland, looking for routes whose
shape a rider would call wrong — and, just as deliberately, for routes that
*look* wrong and are not. Both belong here. A route that detours two miles to
reach the only bike-legal bridge over a ship canal is correct, and writing down
*why* it is correct is what stops a future session from "fixing" it.

This is a findings document, not a specification. `docs/SAFETY-MODEL.md` is
where routing mechanics are defined; when a finding here changes a mechanic,
the mechanic's description moves there and this file keeps the evidence.

## Known non-findings — read this before chasing a "no route"

**"No route exists on the rideable network between these points" is almost
never a router defect.** It was reported as one twice, at multi-day cost, before
anyone asked what was actually at the coordinate. Do not repeat that. Nearly
every occurrence is a point the network can be LEFT from but not ENTERED, and
`scripts/audit_route.mjs` now prints which of three kinds it is on every
failure. Read that line first.

| kind | what it is | finding? |
| --- | --- | --- |
| **island** | not in the giant component at all — a real island, a hamlet up a track | **No.** Correct. |
| **one-way area** | in the giant component, bounded entirely by one-way arcs | **No.** Correct data. |
| **pinprick** | a one- or two-node pocket at the head of a one-way segment | Maybe — the only kind that ever is. |

**Why the one-way areas are correct, measured.** Every stranded node in both
states, grouped into connected pockets: **all 470 Washington pockets and all 157
Oregon pockets have ZERO two-way exits.** Reading the street names inside them
says what they are — Galbraith Mountain and Capitol Forest downhill trails
(*Wonderland*, *Huff and Puff*, *Snake Charmer*, *The Grunt*), freeway ramps on
I-90, WA 16, the Valley Freeway and the West Seattle Bridge, Joint Base
Lewis-McChord, and in Oregon the Beaverton-Tigard Freeway, Delta Highway ramps
and the Post Canyon and Black Rock trail networks. A downhill-only trail cannot
be ridden up. A freeway off-ramp is one-way. You cannot ride onto a military
base — `build_graph.py:1020` drops its gates as `access=private`, which is the
point.

**The two worked examples, so the shapes are recognisable:**

- `Tacoma → North Fort Lewis` — a 110-node one-way area, the base's street grid,
  two one-way arcs out and none in. The only one of Washington's 2,604 offline
  places that behaves this way. **Correct. Not a finding.**
- `[-122.4443,47.2529] → [-122.5150,47.3060]` (Point Defiance) — a **1-node**
  pinprick at the head of a one-way North Waterfront Drive segment. Two-way
  cycleways run metres away (Trolley Lane, Promenade Lane, the `oneway=no`
  North Waterfront Drive cycleway), which is why tapping nearby routes fine.
  This is the shape worth looking at, and it is still only a snap-choice and a
  wrong message — not the router failing to find a path that exists.

**What is actually defective**, and it is small: the message blames a missing
connection when the cause is an unenterable point, and the destination snap
takes the nearest edge without asking whether it can be arrived at. Both are
open by decision, not by oversight.

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
| `.762` fail-share guard | **UNTESTED here** — the star came back with basis `lowest-score`, so the floor alone moved it. The guard did not fire on this trip or the other 29 of that round; it was later measured firing on Tillamook → Pacific City in round 5, see P2 |
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

---

# Round 3 — 2026-08-19

14 new trips, Washington and Oregon, on the rebuilt graphs. The full round-3
write-up lives in the published report; what follows is the disposition record
for findings whose status changed after review.

## F2 — The unbounded safety escape is intended behaviour (CLOSED — WORKS AS DESIGNED)

**What was reported.** Portfolio admission (`reasonable`, `router-worker.js`) is
an OR chain. One disjunct — `failM + 80 < fastest.failM` — asks only for 80 m
less failing road and carries no distance or time ceiling, so a candidate that
avoids failing road qualifies at any length. Marblemount → Winthrop (59 mi crow,
quickest 88.3 mi / 565 min, bound 1253 min) offers Routes E and F at 411.5 mi /
2194 min and 414.9 mi / 2212 min. Both blow the 2.2× time bound; both are
readmitted by the fail escape, on 3.6 mi less failing road for 323 extra miles.
Also reproduces on Skykomish → Leavenworth (237 mi for a 33 mi crow) and more
mildly on Sisters → McKenzie Bridge and Roseburg → Grants Pass.

**Disposition: not a defect.** The escape is meant to be unbounded. A route that
removes failing road is offered however far around it goes, and the rider decides
whether the trade is worth taking; bounding it would mean the app silently
withholding the only safe line because it judged the detour excessive. The star
is unaffected — it is chosen from the practical window, which these options are
nowhere near, and it was correct on all 14 round-3 trips. This is portfolio
membership only.

The behaviour is now specified in `docs/SAFETY-MODEL.md` ("The 'More' screen")
and carries a comment at the filter in `router-worker.js`. **Do not add a length
or time ceiling to the escapes.**

## B1 — Oregon shoulder data lands in one direction only (BUG, DATA, Oregon)

Supersedes what round 3 first reported as two findings: a directional defect and
a set of ODOT records "present in source, absent from the graph". They are one
defect, in Oregon's own adapter.

**Mechanism.** `maps/oregon/tools/build_odot.py:194-210` — `best_record` falls
back to the physical-key bucket only `if not candidates`, meaning only when the
exact route key has *no rows at all*, rather than when no row overlaps the span
being asked about. US 101 has 35 decreasing-direction rows covering 13 of its
363 miles, so `exact['00900D00']` is non-empty for the whole highway, the
fallback never fires, and the decreasing carrier is emitted with no
`ShoulderWidth` and no `SpeedLimit`.

Nothing is missing at source: ODOT layer 127 carries both `LS_PVMT_WD` and
`RS_PVMT_WD` on 20,407 of 20,407 rows. Separate direction rows exist only where
a highway is physically divided.

`scripts/build_graph.py` is correct — it writes both slots properly at
1665-1670. The fault is entirely upstream, which is the right shape: a
state-specific defect in the state's own tool.

**Measured.** Carrier records with `ShoulderWidth`: Oregon increasing 90.2%,
decreasing 29.2%; Washington 100% and 100%. Split the Oregon decreasing figure
by whether the exact key exists and the mechanism is visible — 14.0% where it
exists and suppresses the fallback, 79.7% where it is absent and the fallback
fires. On roads ≥45 mph: both slots 14.5%, AB only 18.7%, BA only 23.0%,
neither 43.8%. That is 8,473 km rated one way only.

**Repro.** Graph edge 172452, US 101 at -124.0726,44.5487 → -124.0720,44.5533
(A→B runs north): `eSh = -1`, `eShBA = 6`, speed 55/55. The `00900d` BLTS
feature carries the LTS rating but no shoulder and no speed; `00900i` carries
`ShoulderWidth 6.0`. The 6 ft that arrived is the southbound rider's shoulder
and is correct. The northbound slot is simply empty.

**Ground truth, Newport → Florence.** Levels recomputed with each empty slot
filled from the opposite side of the same ODOT row, percentage of length at
level 4:

| stretch | shipped | fixed |
| --- | --- | --- |
| Southbound (B→A) | 27.7% | 24.7% |
| Northbound (A→B) | 94.4% | 34.1% |
| Newport → Yachats, 38.0 km | 98.7% | 8.3% |
| Yachats → Florence, 42.5 km | 91.7% | 58.2% |
| Heceta Head, 10.7 km | 98.1% | 91.1% |

So the coast is not uniformly libelled. Heceta Head is correctly red — ODOT
records 2 ft of shoulder for 7.3 of 10.7 km at 55 mph, and it stays 91% failing
under any correct data. Newport → Yachats is the opposite: 98.7% red today
against 8.3% true, on 5–6 ft recorded both sides for 97–99.7% of it.

**What was refuted.** The join-key hypothesis is false. Keys are identically
formatted on both sides (`00900I00`, `03300I00`, `28100I00`) and the join is an
exact string match. "OR 281 source 49% → graph 0%" was measuring the AB slot
alone; `eShBA` is 97.4% populated and either-direction coverage is 97–99% on
every corridor flagged. AB fill tracks whichever way OSM happens to draw the
road: US 26 "kept" its data only because OSM draws it 51.7% aligned.

**Latent, not currently biting.** `_route_number` (`build_graph.py:606`) reads
ODOT highway numbers (`00900i` → 900) while OSM refs give signed route numbers
(`US 101` → 101), so `same_route` is never true in Oregon and the relaxed 30 m
tolerance at 733-735 is dead code. Every Oregon match runs at the strict
tolerance. It still succeeds on 99.6–100% of corridor length, but a future ODOT
re-survey would drop conflation with no fallback.

**Fix.** Rank exact ∪ physical rows together in `best_record`, preferring exact.
No application-code change. Requires an Oregon graph rebuild.

## B2 — A better route is computed, wins a slot, and is evicted (BUG, ROUTER)

Round 2's R12 recorded that Bellevue → Seattle computes an I-90 route and shows
it to nobody, and guessed the six slots go to fixed roles and the I-90 family
holds none. The guess was right about the role and wrong about the removal: the
candidate does not lose every slot, it **wins one and is spliced out of it**.

**Mechanism.** `router-worker.js:4636` gives the last diversity seat to
`friendly`, the I-90 candidate. The `required` back-fill at 4649-4658 then needs
seats; `replaceAt` walks backwards for any non-required entry, lands on index 4,
and 4657 splices `friendly` out. The rule evicts by array position, not by
redundancy — the evicted seat was the most distinct in the set (max edgeOverlap
0.024 against the rest) while two survivors overlap each other 0.696. Confirmed
by replaying 4608-4658 against the live portfolio and reproducing the shipped
selection exactly.

**Why it holds no protected role.** `compareSafety:2913` ranks by
`failM + dismountM * 3`. I-90 candidate 137.9 + 3×146.2 = 576.6; the star
164.5 + 3×121.7 = 529.7. It loses `safestOverall` by 46.9 despite carrying the
lowest failing distance of all twelve choices. Break-even multiplier is ×1.087.
Proven by construction: with the `3` changed to `1` in a throwaway worker the
I-90 route is presented as Route B and nothing else moves.

The dismount gap is not the Mount Baker Ridge tunnel, which routes as ordinary
rideable road with zero dismount metres. It is two unnamed ~8 m connectors at
5th Ave / Spring St downtown. Sixteen metres of sidewalk, tripled, hides an
11.5-mile route carrying 138 m of failing road against an offered route of the
same length carrying 1,825 m.

**Corrections.** R12's arithmetic — `138 + 3×439` against `165 + 3×365` —
tripled an already-tripled figure; 438.7 and 365.2 are priced seconds from
`recommendationScoreBreakdown`, not metres. Actual dismount is 146.2 m against
121.7 m. And the Fremont excursion is a detour, not a backtrack: max crow-flight
retreat is 0.77 km, apex 5.5 km north of the destination at 14.0 km along, with
an 8.5 km southbound tail.

**Fix.** Evict the most redundant seat rather than the last one — among
non-required seats, drop the one with the highest max `edgeOverlap` against the
rest of the selection. `edgeOverlap` is already computed two lines above. About
four lines. It does not address the root cause, which is the dismount weighting.

**Found while tracing.** `router-worker.js:4690` still says "five slots were
filled" though `MAX_OFFERED` has been 6; `presentAsLetters:2963` re-sorts by
distance, so the rider's A–F letters bear no relation to the slot positions the
selection algorithm reasons about.

## B3 — The freeway weight is a flat surcharge, not the intended rule (BUG, ROUTER)

**The intent** is to refuse a short opportunistic hop onto a bicycle-legal
freeway while preserving freeway use where it is genuinely the only link — a
bridge, a gorge, a river crossing. **The code has no notion of "short" or
"opportunistic."** `router-worker.js:1730` is a flat per-metre surcharge with no
length term, no trip-length term and no test for whether an alternative exists.

**Mechanism.** The freeway flag is set for OSM `motorway` and `motorway_link`
only (`build_graph.py:124, 1120, 1587`). `safety-model.js:526` grades any freeway
level 4 unconditionally, shoulder irrelevant — sampled 48,666/48,666 edges in
Washington and 31,553/31,553 in Oregon. `router-worker.js:1709` applies the
level-4 mode multiplier and `:1730` then applies ×60 on top of it, in the same
branch. Repeated in the A* bound at `:1943`/`:1947`.

Measured cost ÷ time on real edges: I-84 Gorge 91× / 739× / 3,148× for direct /
balanced / low-stress; I-90 Vantage 95× / 984× / 5,355×. The 90/540/1800 figures
are the floor — traffic, speed-stress and `limitedAccess` push the real number
higher.

**Break-even.** Ordinary road ridden to avoid one metre of freeway: 95–99 m
direct, 884–1,259 m balanced, 4,007–8,500 m low-stress. In balanced mode one
kilometre of interstate shoulder costs about 900 km of ordinary road. No real
detour is ever long enough.

**Consequence, measured.** Vantage → Quincy accepts +156.7 km of extra riding
rather than 2.756 km of legal, 10 ft-shouldered I-90 across the only Columbia
crossing for ~40 miles (205.4 km offered against 48.6 km available). Cascade
Locks → Hood River: 159.3 km offered against 32.4 km available, needing 17.8 km
of I-84 shoulder. Both alternatives exist and are admissible — refused purely on
price, and a weight sweep recovers each at `freeway: 20`. So the weight is not
merely past "forbid short hops"; it forbids essentially all freeway use,
including the case the rule was meant to preserve.

**Correction to round 2's O5.** "`allowFreeways: true` is arithmetically
indistinguishable from `false`" is right about the arithmetic and wrong at the
route level. `allowFreeways: false` is a hard admission gate
(`router-worker.js:2232`, mirrored at `:1912` and `:2042`) — the edge does not
exist to the search. On the Gorge, `true` returns six routes carrying 10,006 m
of I-84 each and `false` returns no route at all. The toggle is decisive there.

**Prohibited riding is separate and hard, and survives `allowFreeways: true`.**
Two independent exclusions upstream of the toggle: `bicycle=no` never enters the
graph (`build_graph.py:1006-1007`), and a WSDOT `Prohibited` record stores
shoulder as `PROHIBITED_SHOULDER = -128` (`:182`, `:1647-1651`) which the router
skips at `router-worker.js:2225` before any cost or rules logic. Freeways are
also excluded from the terminal-access carve-out at `:2135-2137`.

**Fix.** Replace the flat multiplier with a large fixed *entry* cost per freeway
run plus a modest per-metre rate. An entry cost refuses the short hop by
construction — the shorter the hop, the worse its cost per metre — while a long
unavoidable crossing amortises it. The current shape has the opposite gradient.

**Unproven.** That the weight refuses short hops *where one is available*. On all
three short-hop trips tested, `freeway: 1` also produced zero freeway metres, so
the hop was not in the routable graph at all — Portland's I-5 links there are
dropped at build as `bicycle=no`. A trip where a short hop is demonstrably
available and refused by price was not obtained.

## P2 — The fail-share guard fires about once in thirty trips (CORRECTED; was "never runs")

`router-worker.js:4569-4590`. If the star fails the rules across ≥15% of its own
length, and another candidate carries ≤40% as many failing metres within 1.8×
the star's distance and 1.85× its time, that candidate takes the star.

**Zero fires across 86 real trips** — 48 urban, 38 rural, 18 re-run with the
practical-window floor disabled. The share test passed 7 times; on every one all
alternatives carried comparable failing distance.

**CORRECTED 2026-08-20, and this heading is wrong.** Instrumenting the live
worker across the 30-trip round-5 corpus caught the guard firing on **Tillamook
→ Pacific City**, where it moves the star from Route C (45.9 km, 154 min, 19.8%
failing) to Route D (51.2 km, 186 min, **6.4%** failing) — 5.4 km and 32 minutes
bought for 13 points less failing road. So it is neither unreachable nor a
no-op; it fires about once in thirty trips and does exactly what it was built to
do. A first pass at this measurement reported no change, because the trip was
probed with hand-typed coordinates ~130 m off the corpus's; the endpoints matter
and the corpus spec is the source of truth for them.

The same instrumentation found the **practical-window widening** (the other half
of `.762`) firing **zero** times in 31 trips, including Kirkland → Redmond, the
trip it was written for, which no longer reproduces a one-member pool.

**Disposition (v.770):** the window widening stays removed as dead weight — 0
fires in 31 trips. The guard is **restored**. It was deleted in v.769 alongside
the window, on a decision taken while the "never fires" claim above still
stood; once the Tillamook firing was measured, the basis for deleting it was
gone. It is the only rule in the recommendation that overrides price rather
than expressing it, and it earns that by turning a 19.8%-failing star into a
6.4% one for 5.4 km and 32 minutes — the same trade Baker City → Halfway is
praised for in round 5.

**It is not dead code.** Lifted verbatim into a synthetic harness it fires
correctly on two cases and correctly declines on four boundary cases, including
deferring to a Preferred-route anchor. The predicate is satisfiable; the
conditions do not occur.

**Why.** The two tests are anti-correlated in the real graph: a star reaches 15%
fail share essentially only when the corridor is severed, and a severed corridor
has no clean parallel. Urban star fail share is median 0.4%, max 13.2% — yet on
12 of 48 trips some candidate exceeded 15%, so the pricing consistently declines
to star them.

**Nearest miss.** McMinnville → Newberg: star 24,789 m with 3,264 m failing =
13.2%, 454 m short of the bar, with four qualifying alternatives already waiting
(212, 194, 485, 451 m failing), all outside the priced pool.

**The concern it raises.** Nothing bounds the detour the guard buys. Had it fired
on that near-miss it would have traded 24.8 km / 75 min for 34.7 km / 110 min —
a 35-minute automatic detour, unannounced. The share test bounds which stars it
touches, not what it buys. Its alternative is drawn from the full candidate list
rather than the priced pool, so it can select a route the pricing loop never
scored against the star.

**Ordering relative to `preferredRouteAnchor` is correct as shipped** —
confirmed synthetically. But see below: the test cited as evidence for that
ordering can no longer demonstrate it.

## Two defects found outside the routing questions

- **`scripts/test_preferred_routes.mjs` fails on HEAD.** The strong
  Preferred-route candidate returns `neutral`; `preferredRouteAnchor` is null on
  that trip and the star is `direct-lens-friendly`. It fails identically at
  `72604ba` (pre-.762), `a2895bc` (.762), `a16923a` (.763) and HEAD, so it is not
  a regression from the selection work — and it means the test cannot currently
  demonstrate anything about the guard's ordering.
- **Oregon has no bicycle-prohibition data at all.** Washington hard-excludes 254
  edges (19.5 km), 156 of them freeway (13.7 km). Oregon excludes zero —
  `maps/oregon/BUILD.md:22` records that no statewide dataset was available, so
  the only prohibition signal is OSM `bicycle=no`. The I-5 Marquam Bridge sits in
  the Oregon graph as a non-prohibited freeway edge (56 edges, 6 ft shoulder,
  level 4 by the freeway rung alone). Only B3's ×60 price keeps riders off it.
  **Any reduction of the freeway weight must not land in Oregon before a
  prohibition layer does.**

## Corrections to earlier rounds

- **R12 / F5's dismount arithmetic was wrong.** `138 + 3×439` against
  `165 + 3×365` tripled an already-tripled figure; those were priced seconds, not
  metres. Actual dismount is 146.2 m against 121.7 m.
- **The Fremont excursion is a detour, not a backtrack.** Max crow-flight retreat
  is 0.77 km.
- **The `.762` practical-window floor cannot be credited for Kirkland → Redmond.**
  With the floor disabled the trip still yields six practical candidates and the
  same 0.8%-fail star; the original regression does not reproduce at HEAD by
  either mechanism. Round 2 recorded this fix as "WORKED" — the outcome is real,
  the attribution is not.
- **Round 3's F4 is withdrawn**, folded into B1. See B1's "What was refuted".

---

# Round 4 — 2026-08-19, after the B1/B2/B3 fixes

## Reproducing any of this

All figures below were re-measured at `2026-08-19.767`, after every fix in this
round had landed, so they match what the shipped app produces. Three things
decide whether a repro works:

- **Paste coordinates rather than tapping the map.** `.767` added coordinate
  entry to the place picker — `[-122.4443, 47.2529]`, bare, space-separated, or
  lat-first. Two findings sit in dead zones tens of metres wide, and Point
  Defiance has no entry in the offline place index at all.
- **Check the settings each finding names.** `allowFerries` is a persisted rider
  toggle, default on. With it off, Puyallup → Orting's longest option is 17.8 km
  rather than 226.6 km.
- **Scroll to the letter named.** The star is not always the interesting route;
  two findings here are about Route F.

Coordinates are longitude first throughout.


30 trips: 16 around Tacoma (Washington, `sha-c043f268453b`) and 14 around
Eugene (Oregon, rebuilt to `sha-8ae4d0b5e2d3`). New ground in both states,
chosen to exercise the three fixes as well as fresh corridors.

## C1 — A destination you can only leave produces a refusal instead of a nearby answer (BUG, MESSAGE + SNAP)

**This finding was published twice in a wrong and much larger form**, as "a
destination inside the network can be unreachable", with 5,138 Washington nodes
offered as the scale of a routing defect. Field review asked what those places
actually are. They are almost entirely correct data, and the framing does not
survive. The router is telling the truth; the defect is what it does with that
truth and what it tells the rider.

**The classification that corrects it.** Grouping every stranded node into
connected pockets and reading the street names inside: **all 470 Washington
pockets and all 157 Oregon pockets have ZERO two-way exits** — every one is
bounded entirely by one-way arcs.

| nodes | streets inside | what it is |
| --- | --- | --- |
| 255 | Wonderland, Huff and Puff, Keystone | Galbraith Mountain, directional MTB |
| 182 | Telemark, Nexus, Oso Peligroso | MTB network |
| 116 | 41st Division Drive, D Street, 32nd Division Drive | Joint Base Lewis-McChord |
| 98 | Snake Charmer, Bipolar, Lazy Boy (The Couch) | MTB network |
| 92, 88, 80 | Valley Freeway, WA 16, North Spokane Corridor | freeway ramps |
| 67, 64, 55 | I 90 ×3 | freeway ramps |
| 66 | Divide Trail South, The Grunt, Capitol Peak | Capitol Forest MTB |
| 52 | West Seattle Bridge | ramps |

Oregon repeats it: I-5 and Delta Highway ramps, the Beaverton-Tigard Freeway,
and MTB networks named Basalt Rim, "Defibrulator / Passive Aggressive / Evil
Twin", "Return Policy / Chainbreak / Goat".

A downhill-only trail cannot be ridden up and a freeway off-ramp is one-way;
both are the data being right. Fort Lewis is access control:
`build_graph.py:1020` drops `access=private` ways, removing the gates, and what
survives connecting the base to the outside is two one-way arcs pointing out.

**What the defect actually is.**

- The message is wrong about the cause. "No route exists on the rideable network
  between these points" reads as *these places are not connected*. The truth is
  *you cannot enter that spot on a bike* — a different statement, and one a
  rider can act on.
- The destination snap ignores directed reachability. It takes the nearest edge
  geometrically; when that edge sits inside a one-way pocket the trip fails even
  though a reachable point is metres away. That is why tapping slightly
  differently works, and why this was hard to reproduce deliberately.
- It costs a full graph exploration to produce that wrong message.

**Repro without coordinates.** Washington pack, defaults, search `Tacoma` →
search `North Fort Lewis`: no route. Reverse it: 31.8 km, six options. Lakewood,
DuPont and Steilacoom also fail into it; DuPont is 4 km away. Of the 2,604
places in Washington's offline index this is the **only** one that behaves this
way, which is why coordinates were needed to show it at first.

**Fix, not applied.** Two independent parts. The message should say what is
true. The snap should prefer a reachable edge — it already ranks candidates by
distance, so this asks it to skip one it cannot arrive at. The second is worth
debating: routing to a point near the one requested is helpful on a one-way loop
and misleading at a military gate, where "near" is the wrong side of a fence.

### Superseded: the original C1 text

**Repro.** `[-122.4443,47.2529] -> [-122.5150,47.3060]`, downtown Tacoma to
Point Defiance — a major park about 6 km along Ruston Way, a signed waterfront
bike corridor. The router returns *"No route exists on the rideable network
between these points."*

**It is purely directional.** The reverse trip,
`[-122.5150,47.3060] -> [-122.4443,47.2529]`, returns **9.8 km and six
options**. Every origin tried fails to reach the point — Ruston waterfront and
the Zoo entrance included — so this is the destination, not the path.

**It is not an island.** The destination snaps at 29 m onto edge 695922, *North
Waterfront Drive*, `eFlags = 16` (one-way), and **both of that edge's endpoints
are in the undirected giant component** of 1,155,620 nodes.

**The dead zone is tens of metres wide.** Moving the destination 0.0001° east
(~7.5 m) routes in 9.8 km. Moving it west by 0.0001°, 0.0002° or 0.0005° all
fail; 0.001° west (~75 m) routes again.

**Scale, measured exactly.** A forward flood-fill over the directed arcs from a
central seed, compared against the undirected giant component:

| | nodes in giant | reachable | stranded | share |
| --- | --- | --- | --- | --- |
| Washington | 1,155,620 | 1,150,482 | **5,138** | 0.445% |
| Oregon | 718,282 | 716,769 | **1,513** | 0.211% |

Every stranded node is a destination that will report "no route exists" while a
point a few metres away routes normally. Sample Washington points:
`[-122.16093,47.75983]`, `[-122.3204,47.57227]`.

**A second cost.** A failing request explores the whole graph before giving up:
a six-probe script took ten minutes, nearly all of it in the four failures.

**Reproducing it.** From `[-122.4443,47.2529]` to `[-122.5150,47.3060]`,
longitude first. This could not be reproduced from the app at first, for two
reasons worth recording: `places.json` carries **no record matching "Point
Defiance"**, so name search cannot reach it, and the dead zone is far too narrow
to hit by tapping. `.767` added coordinate entry to the place picker for exactly
this.

**The method was challenged and checked.** The objection was reasonable: the
audit posts `route-options` to the worker directly while a rider taps the map,
so the app might resolve a tap to a nearby routable point and the audit be
testing something the app never does. It does not. A tap runs
`placeArmedPoint` → `setRoutePoint`, which stores `[lngLat.lng, lngLat.lat]`
unchanged, and `app.js:7841` builds the request as
`[routing.start, ...vias, routing.end]` with no rounding or snapping. Driving
the real app through its own click handler and intercepting the worker message
gives byte-identical points and the same failure.

Seven trips were then run both ways to check the harness against the app more
broadly: University Place 9.8 vs 9.78 km, Fife 9.4 vs 9.41, Gig Harbor 18.1 vs
18.1, Bellevue → Seattle 16.6 vs 16.64, Puyallup → Orting 15.5 vs 15.57, four
blocks 0.7 vs 0.69, and Point Defiance NO ROUTE in both. The harness reproduces
the app.

What a nearby tap does show is the dead zone: a destination a few tens of metres
away routes normally. That is the finding rather than a refutation of it.

**Fix, not yet applied.** When the destination's snap has no inbound directed
path, fall back to the next-nearest snap instead of declaring the trip
impossible. The snap already ranks candidate edges by distance; this asks it to
skip a candidate that cannot be arrived at. Needs a decision on whether to spend
the reachability check on every request or only on the failure path.

## P — Plausible, and needing a rider's verdict

- **A test that cannot tell "the app broke" from "the machine was busy".**
  `test_saved_routes_ui.mjs` failed three checks in the full suite and passes
  twice in isolation at the same commit. Its own comments record an earlier
  round of the same thing: "In isolation it always had; under a loaded suite it
  did not." Same species as the stale Interurban fixture — the cost is
  diagnosis, not correctness. It took a controlled re-run to clear this work of
  suspicion.
- **The strict escape can still buy a 226 km route.** Puyallup → Orting is an
  11.9 km crow with a car-free Foothills Trail answer at 15.6 km. The portfolio
  also offers a 226.3 km `fully-matching` option: ×18.99, 52 km of backtrack,
  25.3 km of ferry and 5.2 km of dismount. This is consistent with the closed
  decision that a fully-rule-matching route is always admitted; noted because a
  rider has six slots and this spends one on a two-ferry day trip.
  **Two preconditions for seeing it**, both of which defeated a field repro
  attempt: it needs `allowFerries` ON — with ferries off the longest option on
  this trip is 17.8 km, not 226.6 km — and it is Route F, the sixth and longest
  option rather than the star, so it is off-screen unless the list is scrolled.
- **Short urban trips buy large detours to shed failing road.** Tacoma →
  University Place stars 14.2 km against a 9.8 km direct option (×1.70) to take
  the failing share from 26.9% to 0.5%. Eugene → Alton Baker Park stars 3.6 km
  for a 0.8 km crow (×4.28) to take it from 67.6% to 3.9%. Both are the pricing
  working as specified. Whether the trade is right is a field call.

## Dismount weighting — researched, no action (P1 closed)

The question was whether `compareSafety`'s `failM + dismountM * 3` should apply
only to tagged `bicycle=dismount` runs rather than to every walk link.

- **The connectors that decided the Bellevue ranking are NOT tagged.** The links
  at 5th Ave / Spring St carry `official = 72` — `EDGE_DISMOUNT` plus
  designated, without `EDGE_DISMOUNT_TAG`. So the tagged-only fix would have
  moved that case.
- **But the ratio makes it the wrong fix.** Washington carries 398,467 dismount
  edges totalling 13,310 km, of which **398 edges and 12.4 km — 0.1% of the
  metres — are tagged**. Restricting the multiplier to tagged runs would remove
  it from 99.9% of the distance it currently touches, making 13,298 km of
  untagged walk links cheaper in the ranking and unrideable-trail routes
  correspondingly more likely. That is the opposite of what was asked for.
- **The symptom is already fixed.** B2's eviction change presents the Bellevue
  I-90 route as Route B without touching the weighting.
- **The genuine inconsistency stands, unfixed and recorded.** `edgeCostParts`
  already tiers dismount cost by edge length — under 25 m is "a shrug, not a
  detour-off-the-trail" — while `compareSafety`, in the same file, counts a 4 m
  kerb cut identically to 4 m of unrideable trail. Aligning the two is the
  coherent change if this is revisited. It was not made here: with the symptom
  gone, there is no measured defect left to justify moving `safestOverall` on
  every trip in both states.

## The three fixes, verified in the field

| fix | verdict |
| --- | --- |
| B1 — Oregon shoulder adapter | **WORKED.** Decreasing-direction carriers 29.2% → 90.7%; both-direction graph fill 0.26 → 0.759 against Washington's 0.862; one-way-only land 8,473 km → 2,749 km |
| B2 — evict the redundant seat | **WORKED.** Bellevue → Seattle now offers the I-90 route as Route B, 11.5 mi, 138 m failing, beside the unchanged star |
| B3 — freeway entry charge | **WORKED.** Cascade Locks → Hood River is 31.2 km on I-84 shoulder (was 159 km around Mount Hood), and five of six options now sit within 19–20 mi of a 18 mi crow |

## Suite status

115 of 119 pass. Three failures are pre-existing and unrelated to this work
(`test_missing_turn_guidance`, `test_forward_progress_route`,
`test_settings_panes_reachable` — the last is the iPhone SE Rules pane
overflowing by 67 px, a design decision). The fourth,
`test_saved_routes_ui`, is the load-sensitivity described above.

---

# Round 5 — 2026-08-19, scattered across both states

30 trips on ground no earlier round touched: the Palouse, the Columbia basin,
the Olympic peninsula, the north-east corner, the Oregon high desert, the far
south coast, the Snake River. Every trip was chosen from the app's own offline
place index, so **each one reproduces by typing two names** — no coordinates
anywhere. All 30 routed; no failures, so the new no-route classifier had nothing
to explain.

## D1 — Strictly dominated routes occupy slots (BUG, ROUTER)

**14 of the 30 trips offer at least one route that is no longer, no slower, and
carries less failing road than another route on the same screen.** 16 such
options in total; 6 of them are beaten by the starred route itself.

**The clearest case, Walla Walla → Dayton:**

| | distance | time | failing |
| --- | --- | --- | --- |
| Route A | 49.0 km | 156 min | 3.5% |
| Route D | 55.9 km | **188 min** | **19.5%** (10.9 km of Lower Waitsburg Road) |

Route D is 7 km longer, 32 minutes slower, and carries 5.6× the failing road.
It is offered anyway.

**Mechanism.** `router-worker.js:4491-4502` prunes a dominated candidate only
when `sameCorridor = edgeOverlap(other, candidate) >= 0.96`. The intent is sound
and the comment says so — "A route may be objectively slower and no safer yet
still give the rider a useful different corridor." But the test is geometry
only: a route sharing less than 96% of its edges is never pruned, however much
worse it is. Being a different corridor is treated as sufficient on its own,
with no floor on how bad the route may be.

**Confirmed on all three axes.** This was nearly published on distance and
failing share alone, which is not dominance — a longer route can be the quicker
one. `scripts/audit_route.mjs` did not record times, so it now persists `timeS`,
`distM` and `failM` per option; four cases were checked individually, then the
full corpus re-run.

Others: Vancouver → Battle Ground (C 29.6 km/90 min/10.9% against the starred B
at 29.3/90/**0.0%**), Port Angeles → Forks (C 98.0/322/11.6% against A
97.0/321/1.5%), Oak Harbor → Coupeville, Moses Lake → Ephrata, Coos Bay →
Bandon, Hood River → Parkdale, Anacortes → Mount Vernon.

**Repro.** Washington pack, defaults, search `Walla Walla` → `Dayton`, compare
Routes A and D. Or `Vancouver` → `Battle Ground` for the version where the star
itself is the winner.

**Fix, applied — but graded, and the first draft of it was wrong.** The obvious
change is to drop the `sameCorridor` requirement and prune whenever the winner
is also no longer. Measured over the same 30 trips that produced this finding,
that halves the dominated options (16 → 8, across 14 trips → 8) and keeps 29 of
30 trips at a full six letters. It also **collapsed `test_preferred_routes` to a
single option** — on a short trip where one route genuinely wins outright, strict
dominance eats the entire portfolio, and a chooser showing one letter is a worse
answer than one showing a redundant route. That is the exact failure the
`sameCorridor` clause was there to prevent, so it stays.

What ships instead is two-stage. Same-corridor dominance still prunes
unconditionally. Cross-corridor dominance then trims the losers **worst-first,
and stops once `useful.length` reaches `MAX_OFFERED`** — it only removes routes
while the slots are contested, never while they are merely full. `MAX_OFFERED`
moved up in `routeOptions` so the trim can see it.

Re-measured across all 30 trips with the graded version:

| | before | after |
| --- | --- | --- |
| Dominated options | 16 | **8** |
| Trips with one | 14 | **8** |
| Total routes offered | 179 | **179** |
| Routes absent from the old boards | — | **24** |

So it is not a subtraction: every slot freed is refilled, by a route the rider
was not previously shown. Two stars moved, both toward less failing road — Oak
Harbor → Coupeville 18.2 km/2.6% → 18.4 km/**0.0%**, and Issaquah → North Bend
37.0 km/4.8% → 41.0 km/1.7%. The first is a strict improvement: the old star was
itself beaten by a 17.3 km/1.5% route that the pruning surfaced.

**The residual 8 are a different rule, not a leftover of this one.** Every one of
them is profile `quick-friendly` — "Direct + both preferences" — which is
reserved by name in `protectedCandidates` and therefore exempt from every
dominance test by design. Whether that reservation should survive being beaten
on all three axes is a separate decision, and an open one.

Guarded by `scripts/test_dominated_options.mjs`, which audits three real trips
through the app's own defaults and fails at the previous commit.

## Plausible, needing a verdict

- **E1 — Routes at 80–87% failing beside a route at zero.** Lakeview → Paisley
  stars Route E at 84.1 km and 0.0% failing, and also offers Route B at **87.0%
  failing** (57.0 km of Fremont Highway) and Route C at 79.8%. Not dominated —
  they are genuinely quicker — so the question is whether a route failing the
  rules for seven eighths of its length should hold a slot. Three of six slots
  go to zero-failing routes within 1.2 km of each other.
- **E2 — The fully-matching admission fired six times in thirty**, against once
  in round 4. Issaquah → North Bend offers 166.6 km for a 19.9 km crow (×8.38,
  32.6 km backtrack) and Chehalis → Centralia 54.6 km for 6.7 km (×8.12). The
  other four are ×1.6–1.7 and read as reasonable. Same rule kept deliberately
  earlier; the new information is the frequency and the magnitude.
- **E3 — Brookings → Gold Beach returns five near-identical options**,
  45.1–47.1 km, all 23.2–24.5% failing, all on US 101. Honest — there is no
  parallel — but five versions of one answer.
- **E4 — Sequim → Port Townsend stars ×2.77 with a 10.1 km backtrack** to remove
  8.5 km of SR 20. Correct under the pricing; a field call.

## What went right

- No trip failed, in some very sparse networks. Burns → Hines returns six sane
  options over a 3.3 km crow; Ontario → Nyssa six between 19.1 and 20.5 km.
- Baker City → Halfway spends 10 km to drop from **43.7% failing** (38.2 km of
  the Baker-Copperfield Highway) **to 1.4%**. That is the trade the model exists
  to make.
- Clean with nothing worth chasing: Wenatchee → Leavenworth, Richland → Pasco,
  Moses Lake → Ephrata, Colville → Kettle Falls, Pullman → Colfax, Mount Vernon
  → La Conner, Anacortes → Mount Vernon, Chehalis → Centralia, Aberdeen →
  Westport, Burns → Hines, Ontario → Nyssa, Prineville → Madras, Silverton →
  Mount Angel, Klamath Falls → Chiloquin, Bend → Redmond.

---

# Round 6 — 15 routes, 2026-08-21

**A note on the number.** The brief for this round called it "round 2" and
described this file as holding 40 audited routes; it holds 144, in five rounds.
This is round 6, and for the same reason its findings are lettered `S1…` for
Washington and `Q1…` for Oregon — the brief asked for `S…`/`P…`, but `P1` and
`P2` are already taken by rounds 3 and 4, where `P` means *plausible* rather
than *Oregon*.

15 trips on ground no earlier round has touched: eight in Washington
(`maps/washington` `sha-c043f268453b`) and seven in Oregon (`maps/oregon`
`sha-8ae4d0b5e2d3`). Deliberately scattered away from Seattle and Portland —
Spokane, the Tri-Cities, north Whatcom County, the Olympic Peninsula, the
Wenatchee–Chelan corridor, the Washington side of the Gorge, Bend, Eugene, the
Rogue Valley, the north coast, and the Historic Columbia River Highway.

Every trip routed; nothing needed the no-route classifier. Raw scores, the
recommendation's own arithmetic for every candidate it considered, and ten plots
are committed under `docs/audit/round6/`.

## The trips, and why each one

**Washington** — `docs/audit/round6/washington.json`

| trip | coordinates (lng, lat) | why |
| --- | --- | --- |
| Gonzaga University → Manito Park, Spokane | `[-117.4013,47.6673] → [-117.4093,47.6316]` | Spokane has only ever been audited as a city-to-city endpoint. This crosses the river and climbs the South Hill |
| EWU Cheney → Riverfront Park, Spokane | `[-117.5830,47.4925] → [-117.4205,47.6605]` | The real student commute. The Fish Lake Trail parallels the SR 904 / I-90 corridor, so it is a trail-versus-distance test |
| Howard Amon Park, Richland → Sacajawea State Park, Pasco | `[-119.2725,46.2800] → [-119.0475,46.2100]` | Tri-Cities on new endpoints: a park at the Snake/Columbia confluence, reachable only across the bridges |
| WWU Bellingham → Birch Bay State Park | `[-122.4853,48.7346] → [-122.7660,48.9085]` | North Whatcom farm grid against the I-5 frontage corridor |
| Port Angeles waterfront → Hurricane Ridge Visitor Center | `[-123.4308,48.1207] → [-123.4977,47.9700]` | A 1,500 m climb on one road, to exercise the v.771 quadratic climb ramp where there is no alternative to price against |
| Memorial Park, Wenatchee → Riverwalk Park, Chelan | `[-120.3145,47.4235] → [-120.0166,47.8395]` | Long inter-city rural; US 97A on one bank, US 2/97 on the other |
| White Salmon → Columbia Gorge Interpretive Center, Stevenson | `[-121.4860,45.7280] → [-121.8890,45.6940]` | Every earlier Gorge finding is about the Oregon side. SR 14 has tunnels and long no-shoulder stretches |
| Downtown Yakima → Selah Civic Center | `[-120.5060,46.6020] → [-120.5320,46.6540]` | Short suburban trip across the Naches; Greenway trail against SR 823 |

**Oregon** — `docs/audit/round6/oregon.json`

| trip | coordinates (lng, lat) | why |
| --- | --- | --- |
| Kennedy School, NE Portland → Esther Short Park, Vancouver WA | `[-122.6476,45.5626] → [-122.6757,45.6262]` | The cross-river trip. Two bike crossings exist and the question was which one the router picks. It turned out to be a different question |
| Drake Park → Phil's Trailhead, Bend | `[-121.3157,44.0582] → [-121.3968,44.0432]` | The ride every Bend rider makes; an MTB network approached from a town centre |
| University of Oregon → Spencer Butte trailhead, Eugene | `[-123.0726,44.0448] → [-123.0860,43.9880]` | Willamette Street against the south-hills grid |
| SOU Ashland → Britt Gardens, Jacksonville | `[-122.6890,42.1875] → [-122.9692,42.3139]` | Rogue Valley rural, off the Bear Creek Greenway round 2 found clean |
| Cannon Beach → Manzanita | `[-123.9615,45.8918] → [-123.9345,45.7196]` | US 101 over Neahkahnie Mountain. Every coast finding so far is south of Tillamook |
| Troutdale → Multnomah Falls Lodge | `[-122.3874,45.5393] → [-122.1180,45.5775]` | The Historic Columbia River Highway — the intact half of the Gorge, where B3's freeway work was measured on the severed half |
| 5th Street Public Market, Eugene → OSU Memorial Union, Corvallis | `[-123.0900,44.0535] → [-123.2789,44.5646]` | Long inter-city with three genuinely different answers: OR 99W, Peoria Road, and the east bank |

Endpoints were probed against the graph before anything was routed, and
**thirteen of the thirty** were moved as a result — either more than 200 m from
any edge, or simply not where their name said. The worst were WSU Tri-Cities at
548 m and the Hurricane Ridge visitor centre at 2,310 m, both of which would
have produced a walk-in the metrics would have blamed on the router, and a
Southern Oregon University coordinate that snapped onto an I-5 ramp.

## Summary

| # | Finding | Verdict | Class |
| --- | --- | --- | --- |
| Q1 | Oregon has no riding-space source off the state system, so **two thirds of its level-4 road is red for want of a measurement** | **BUG** | DATA |
| S2 | A trip across the Columbia stops 602 m short at the state line and reports success; the same trip the other way is refused with a message about the road network | **BUG** | ROUTER |
| S1 | The star can be longer, slower **and** carry failing road an offered route does not — twice in fifteen trips | UNCLEAR | tuning |
| S3 | The fail-share guard's share test passed on three trips and fired on none; twice the qualifying alternative was outside the window | UNCLEAR | tuning |
| Q3 | Cannon Beach → Manzanita spends a slot on a route 2.4× longer, 2× slower and 8.7× more failing — and corrects round 5's D1 | UNCLEAR | tuning |
| Q2 | Troutdale → Multnomah Falls has no non-failing option: 17.0 of 33.3 km of the Historic Columbia River Highway is level 4, and the data says so honestly | EXPLAINABLE | DATA |
| S4 | Port Angeles → Hurricane Ridge fills two of six letters, correctly | EXPLAINABLE | — |
| S5 | Washington explainables: SR 14, the Sehome bluff, the Spokane river crossings, the confluence bridges, the fully-matching escape | EXPLAINABLE | — |
| Q4 | Oregon explainables: Skyliners Road, Fox Hollow Road, the Bear Creek Greenway, US 101 over Neahkahnie | EXPLAINABLE | — |

**Clean, with nothing worth chasing:** downtown Yakima → Selah, Howard Amon Park
→ Sacajawea State Park, WWU → Birch Bay, Wenatchee → Chelan, SOU Ashland →
Britt Gardens, and the Portland → Vancouver route's *shape* — its defect is
where it stops, not how it gets there. Only Yakima → Selah drew no metric flag
at all; the other five were flagged and are explained in S5 and Q4.

Two BUG, four EXPLAINABLE, three UNCLEAR; six of the fifteen trips clean.

## Findings

### Q1 — Two thirds of Oregon's red road is red because nobody measured it (BUG, DATA)

**Where:** statewide, both packs. **Repro:** one pass over each graph, grading
every non-freeway, non-ferry, non-trail edge under `DEFAULT_RULES`.

**What happens.** The shoulder rung fires above `maxSpeedNoShoulder` (35 mph),
and an unrecorded shoulder is unconditionally 0 ft. So the question that decides
how much of a state reads red is: **on road above 35 mph, is there any evidence
at all about the riding space?**

| | Washington | Oregon |
| --- | --- | --- |
| rideable road | 148,273 km | 117,119 km |
| level 4 | 14,326 km (9.7%) | 12,677 km (10.8%) |
| road above 35 mph | 20,066 km | 18,336 km |
| — carrying a bike facility ≥ 2 | 668 km (3.3%) | 1,320 km (7.2%) |
| — with a **recorded** shoulder | 9,137 km (45.5%) | 8,411 km (45.9%) |
| — with an **edge-space inference** | **8,476 km (42.2%)** | **0 km (0.0%)** |
| — with **no evidence either way** | 1,784 km (8.9%) | **8,605 km (46.9%)** |
| — and level 4 as a result | 1,575 km = **11.0%** of the state's level-4 road | 8,382 km = **66.1%** of the state's level-4 road |

The two states have nearly identical *recorded* shoulder coverage — 45.5% and
45.9%. The whole difference is the row between them. `inferShoulderFromEdge` is
on by default, reads county edge space from the WSDOT/CRAB road log, and reaches
8,476 km of Washington's fast road. **In Oregon it reaches nothing at all**,
because no equivalent inventory was imported: `maps/oregon/`'s ODOT layers —
BLTS shoulder, posted speed, facilities — all stop at the state highway system.
Every county road above 35 mph therefore fails by default.

This is neither a scoring defect nor a repeat of B1. B1 was a direction slot
left empty on roads ODOT *had* measured, and it was fixed. This is roads nobody
measured, and it is the single largest determinant of what Oregon looks like.

**It is visible on the ground in this round.** Both Oregon trips whose stars
carry a large failing share are unmeasured county roads:

| road | trip | in the graph |
| --- | --- | --- |
| Skyliners Road, Bend | Drake Park → Phil's Trailhead | 4.1 of 10.0 km level 4; speed 45, `shoulder: null`, `stressRating: null`, `fc: 5`, AADT 1,400 |
| Fox Hollow Road, Eugene | UO → Spencer Butte | 5.3 of 13.6 km level 4; speed 45, `shoulder: null`, `stressRating: null` |

Both make their trips look worse than a Bend or Eugene rider would call them,
and neither is a road the model got wrong — it is a road the model was told
nothing about.

**What I would change, not applied.** Two separable pieces. The honest one is a
data import: ODOT's non-state linework already supplies `funcclass` and owner
from the same catalogue `maps/oregon/tools/build_odot.py` pages, and whatever it
carries about lane and shoulder width is what `inferShoulderFromEdge` needs. The
cheaper one is presentational — a road with no evidence and a road measured at
0 ft are the same colour today, which `docs/SAFETY-MODEL.md` argues is right for
safety and is less obviously right across 8,382 km of one state. Either way the
fact belongs in Oregon's `region.json` and its readiness score, not in
application code.

### S2 — A route stops at the state line and says it arrived (BUG, ROUTER)

**Where:** the Columbia at Vancouver, in both packs.

**Repro, Oregon pack:** `oregon`, `[-122.6476,45.5626] → [-122.6757,45.6262]`
(Kennedy School, NE Portland → Esther Short Park, Vancouver WA), Routes A–F —
all six.

**Repro, Washington pack:** `washington`, the same trip reversed,
`[-122.6757,45.6262] → [-122.6476,45.5626]`.

**What happens.** On the Oregon pack: six options, 8.8–12.3 km, star Route C at
10.7 km / 32 min. **Every one of the six ends at exactly
`[-122.67381,45.62095]`** — the north end of the Interstate Bridge — which is
**602 m from the destination**. The last four segments of every option are
`Interstate Bridge`. Nothing in the reply says the route is short. On the
Washington pack the same trip returns *"A route point is too far from a routable
road or path."*

**Mechanism, read and measured.** `nearestNode` (`router-worker.js:413`) has no
distance cap; `routeLeg` (`:2240`) rejects a point only past **2,000 m**.
Neither pack contains the other state's streets and both carry the bridge, so
that one tolerance decides everything:

| point | Washington pack | Oregon pack |
| --- | --- | --- |
| Esther Short Park, Vancouver WA | 7 m (Esther Street) | **602 m — the Interstate Bridge** |
| Interstate Bridge, north end | 13 m (Columbia Riverfront Renaissance Trail) | 117 m (Interstate Bridge) |
| Hayden Island, Portland OR | **438 m — the Interstate Bridge** | 108 m (N Hayden Bay Drive) |
| Kenton, N Portland OR | 3,731 m | — |
| Kennedy School, NE Portland | **5,694 m** | 17 m |
| Camas, WA | — | 2,392 m |

So a Portland destination is 3.7–5.7 km from anything in the Washington pack and
fails the 2 km test honestly, if with the wrong words. A Vancouver destination
is 602 m from the Oregon pack — inside the tolerance — and the rider is handed a
route ending on a freeway bridge deck with a six-hundred-metre gap it never
mentions. `docs/audit/round6/plots/portland-vancouver-crossing_RouteC.png` shows
it: the polyline stops well short of the orange destination square.

The message is wrong in the way round 4's C1 message is wrong. Nothing is "too
far from a routable road" — Kennedy School is on NE 17th Avenue. It is outside
the installed map.

**What I would change, not applied.** The worker already computes both snap
distances and does not report them. Carry `snapM` per point into the
`route-options` reply and let the app say the true thing — *"this is as close as
the Oregon map reaches; Vancouver is in the Washington map"* — instead of either
drawing a silent 602 m gap or blaming the road network. With downloadable map
packs (`issues.md` §4) this stops being a curiosity and becomes a first-run
question: the two halves of a metro area are in different downloads.

### S1 — The star can be longer, slower and dirtier than a route beside it (UNCLEAR, tuning)

Twice in fifteen trips the recommended route is beaten by an option on the same
screen on **all three** of distance, time and failing metres. Both times the
basis is `lowest-score` and the arithmetic is exactly as specified.

**Repro A:** `washington`, `[-117.5830,47.4925] → [-117.4205,47.6605]`
(EWU Cheney → Riverfront Park, Spokane), crow 22.3 km. The star is **Route D**;
compare **Routes B and C**. **What happens:**

| | distance | time | failing | facility | trail |
| --- | --- | --- | --- | --- | --- |
| B `efficient` | 27.7 km | 85 min | **0 m** | 5,633 m | 588 m |
| C `alt-safer` | 28.4 km | 87 min | **0 m** | 5,061 m | 221 m |
| **D\* `combined-corridor`** | **30.0 km** | **94 min** | **969 m** | 15,980 m | 12,528 m |

```
D*  8567 = travel 5624 + fail  969 + dismount 177 + ordinary 2799 - trail 1002
B   9675 = travel 5124 + fail    0 + dismount 177 + ordinary 4421 - trail   47
```

D loses on travel by 500 s and on failing road by 969 s and wins anyway, because
it spends 10.3 km less on ordinary road — 1,622 s at `NETWORK_GAP_PRICE_S_PER_M`
— and earns 955 s more trail credit. Set `TRAIL_BONUS_S_PER_M` to zero and D
still wins by 153 s: as round 2's R11 said, the exchange rate is set by a *pair*
of constants, and the larger one is the charge on ordinary road.

**Repro B:** `oregon`, `[-123.0900,44.0535] → [-123.2789,44.5646]`
(Eugene → Corvallis), crow 58.8 km. The star is **Route B**; compare **Route A**.
**What happens:**

| | distance | time | failing | facility | ordinary |
| --- | --- | --- | --- | --- | --- |
| A `friendly` | 66.3 km | 199 min | **0 m** | 30,347 m | 35,966 m |
| **B\* `quick-friendly`** | **68.7 km** | **207 min** | **820 m** | 59,207 m | 9,481 m |

```
B* 14966 = travel 12402 + fail 820 + dismount 404 + ordinary 1896 - trail 556
A  19191 = travel 11946 + fail   0 + dismount 404 + ordinary 7193 - trail 353
```

B rides about 34 km of Peoria Road, which OSM tags `cycleway=lane` and ODOT
records as an 8 ft existing bike lane, so 26.5 km moves out of the ordinary-road
bucket and B wins by 4,225 s.

**Why this is UNCLEAR and not a bug.** Both stars are defensible rides. Route D
is the Fish Lake Trail — 12.5 km of car-free rail trail — and its 969 m of
failing road is four short connectors (S Cheney-Spokane Rd 498 m, S Grove Rd
365 m, W Sunset Blvd 70 m, S Government Way 32 m). Route B is the Willamette
Valley Scenic Bikeway. A rider may well want both, and the model says in so many
words that ride quality has a vote and that fail avoidance pays a price rather
than holding a veto.

What is new is the *direction* the vote runs. `NETWORK_GAP_PRICE_S_PER_M` was
sized on a field case about **time** — the star saved 21 minutes by spending 12
km off the bike network and the rider wanted the other route. Nothing in the
pricing distinguishes spending ordinary-road credit to buy time from spending it
to buy **failing road**, and on these two trips it buys failing road that a
shown alternative does not carry at all.

**What would settle it:** a rider verdict on those two trips specifically,
comparing the starred letter against the one named above. **What I would change
if the verdict goes the other way:** not another constant. A dominance guard on
the star alone — if a candidate in the practical pool is no longer, no slower
and carries strictly less failing road, it takes the star — expresses the intent
directly, is a few lines, and fires on exactly these two trips out of fifteen.

### S3 — Three trips passed the fail-share guard's share test; it fired on none (UNCLEAR, tuning)

`failShareGuardPick` (`router-worker.js:3456`) moves the star when it fails the
rules across ≥15% of its own length and another candidate within 1.8× distance
+ 1.6 km and 1.85× time + 10 min carries ≤40% as many failing metres. P2
recorded it firing about once in thirty trips.

**Where:** all three trips below. **Repro:** `oregon`
`[-121.3157,44.0582] → [-121.3968,44.0432]` (star Route A) and
`[-122.3874,45.5393] → [-122.1180,45.5775]` (star Route C); `washington`
`[-121.4860,45.7280] → [-121.8890,45.6940]` (star Route A).

**What happens.** The share test passed on **three of fifteen** trips and the
guard moved nothing — and the reason differs each time:

| trip | star | share | candidates at ≤40% failing | why none qualified |
| --- | --- | --- | --- | --- |
| Bend → Phil's Trailhead | 7.5 km / 28 min | **32.8%** | 2, at 20.2 and 20.3 km with 282–288 m failing | both outside a **15.2 km / 61 min** window |
| Troutdale → Multnomah Falls | 31.1 km / 121 min | **28.8%** | **0** | the whole corridor is failing; there is nothing to move to |
| White Salmon → Stevenson | 38.3 km / 139 min | **17.6%** | 4, at 72.0–74.5 km with 1,113–1,346 m failing | all outside a **70.6 km / 266 min** window, by 1.4–3.9 km and 15–24 min |

Troutdale is the guard behaving perfectly: no cleaner route exists, so there is
nothing to prefer. The other two are the shape P2 named as its "nearest miss",
now with two more instances and a measurement of *which* clause bites. It is the
window, not the fail ratio: on White Salmon four qualifying candidates miss a
70.6 km bound by as little as 1.4 km.

**What would settle it:** whether a rider looking at Bend → Phil's Trailhead —
7.5 km with a third of it failing, against 20.3 km at 1.4% — wants to be carried
onto the long one automatically. P2 already records the concern that nothing
bounds what the guard buys; these two trips are what widening the window would
buy, and they cost 13 and 34 extra kilometres. My own read is that the window is
right and the guard is correct to decline, but that is a judgement, not a
measurement.

### Q3 — A slot spent on 21 km of failing highway, and a correction (UNCLEAR, tuning)

**Where:** the Necanicum and Sunset Highways, inland from the north coast.
**Repro:** `oregon`, `[-123.9615,45.8918] → [-123.9345,45.7196]`
(Cannon Beach → Manzanita), crow 19.3 km, **Route F** — the sixth letter, so it
is off-screen unless the list is scrolled. **What happens:**

| | distance | time | failing |
| --- | --- | --- | --- |
| A\* `alt-quick` | 23.0 km | 92 min | 2,437 m (10.6%) |
| **F `direct-lens-friendly`** | **55.2 km** | **190 min** | **21,269 m (38.5%)** |

F is 2.4× longer, 2× slower and carries 8.7× the failing road — 20.0 km of the
Necanicum Highway alone, reached by way of 14.4 km of the Sunset Highway — and
it holds one of six letters. Its admission is legitimate: at 190 min it clears
the `2.2× + 10 min` time bound of 212 min, because the inland highway is fast
and the coast route is slow. It then survives because the dominance trim
requires `edgeOverlap >= 0.96` and F shares nothing with A.

**This is deliberate behaviour, restored by commit `b0b715b`** — "Revert the
dominance trim: it deleted a corridor, then became a no-op" — and the comment at
`router-worker.js:4614` argues the case well. I am not asking for the trim back.
Two things are worth recording anyway.

**A correction to round 5's D1.** D1 says the residual dominated options are
"every one of them profile `quick-friendly` — reserved by name in
`protectedCandidates` and therefore exempt from every dominance test by design".
That is no longer true. Across these fifteen trips, **35 options on 14 trips**
are beaten by another option on the same screen on distance, time and failing
metres together, and their profiles are spread across `direct-lens-friendly`
(4), `discover-alternative` (4), the `combined-corridor` family (6), `friendly`
(3), `alt-quick` (3), `discover-gentle` (3), `section-frontier` (3), `alt-safer`
(2) and five others with one each. `quick-friendly` accounts for three of the
35. The protection clause is not what is keeping them.

**The magnitude is what deserves a look, not the count.** Most of the 35 are
harmless — a route a kilometre longer with 200 m more failing road is a real
alternative. Cannon Beach's Route F is not that. A rider on a 19 km coastal trip
is offered a 55 km route with 21 km of failing highway on it, and the corridor
argument — that a different road is worth showing however it scores — is weakest
exactly when the different road is the kind the safety model exists to warn
about. If anything changes here, the narrow version is a ceiling on failing
*share* for the corridor exemption, not a general dominance trim.

### Q2 — The Historic Columbia River Highway is red for half its length, honestly (EXPLAINABLE, DATA)

**Where:** the Historic Columbia River Highway, Troutdale to Multnomah Falls.
**Repro:** `oregon`, `[-122.3874,45.5393] → [-122.1180,45.5775]`, Routes A–F —
all six.

**What happens.** All six options carry **23.8%–52.8%** failing road; the star is
Route C at 31.1 km / 121 min / 28.8%. Every option's failing metres are the same
road.

Measured over the 33.3 km of `Historic Columbia River Highway` inside
`[-122.42,45.50]`–`[-122.10,45.62]`:

| | km |
| --- | --- |
| level 1 / 2 / 3 / **4** | 7.6 / 4.4 / 4.3 / **17.0** |
| ODOT posted speed conflated onto the edge | 29.0 (86.9%) |
| level-4 km recorded at 40 mph | 15.7 |
| — of those, with a **recorded** shoulder under 4 ft | 7.63 |
| — of those, with **no** shoulder record at all | 7.10 |

So a little over half the red is a road ODOT measured, at a speed ODOT posted,
with less than the rider's 4 ft minimum: level 4 under `maxSpeedNoShoulder: 35`
and `minShoulder: 4`, correctly. The rest is Q1 in miniature — 7.1 km with no
shoulder record, red by the "unknown is zero" rule.

The road really is a 1915 alignment about twenty feet wide, so this is not a
libel. It is worth knowing that Oregon's best-loved cycling road reads as a
third to a half failing on the default rules, and that a rider who moves
`minShoulder` or `maxSpeedNoShoulder` by one class changes that picture
completely. The trip has no cleaner alternative: no option avoids the HCRH at
all, and the ones that ride less of it climb over Larch Mountain by way of East
Haines Road and Northeast Alex Barr Road and are still 24–27% failing.

**Not a repeat of O5 / B3.** I-84 runs alongside the whole way and no option
touched it. The freeway entry charge is doing its job here.

### S4 — Two letters, correctly (EXPLAINABLE)

**Where:** Hurricane Ridge Road, Olympic National Park. **Repro:** `washington`,
`[-123.4308,48.1207] → [-123.4977,47.9700]`, crow 17.5 km, **Routes A and B** —
there is no C.

**What happens.** The portfolio offers **two** options, not six.

| | distance | time | failing |
| --- | --- | --- | --- |
| A `alt-quick` | 31.6 km | 161 min | 5,229 m (16.5%), 4,901 m of it Hurricane Ridge Road |
| B\* `friendly` | 37.2 km | 181 min | **0 m** |

There is exactly one road to Hurricane Ridge, so the only decision available is
how to reach its foot: A rides the lower, 45 mph end of Hurricane Ridge Road out
of town; B loops west on Black Diamond Road (7.1 km) and Little River Road
(6.1 km) and joins above it. Twenty minutes for 5.2 km of failing road is the
trade the model exists to make. The portfolio built **22 candidates and marked
20 of them `duplicate`** — this is not a portfolio failure, it is a corridor
with two answers in it. Both options carry an identical 1,719 m backtrack, which
is the road's own alignment climbing east before switching back west; six
options agreeing exactly was round 2's signature of a hard constraint, and two
options agreeing is the same thing.

The climb pricing behaved: 1,500 m of ascent did not push the star onto anything
strange, and the two options differ by twenty minutes rather than by hours.

### S5 — Washington explainables, with their constraints (EXPLAINABLE)

| trip | flagged | the constraint |
| --- | --- | --- |
| White Salmon → Stevenson | star 17.6% failing | **SR 14, measured**: 33.6 km in the box, 81.4% level 3 and 18.2% level 4, shoulder recorded on 99.7% of it — 26.1 km at 4 ft, 6.1 km at 3 ft or less, 23.7 km posted 55, WSDOT stress 4 on 33.4 km. The star's 6.0 km of failing SR 14 is essentially all the level-4 SR 14 there is on that stretch; the alternatives are Forest Road 68 and the N-1000 line at 72–75 km |
| Gonzaga → Manito Park | ×2.03, 234 m backtrack on all six | The 234 m is leaving Gonzaga for the nearest bike-legal river crossing, identical on every option. The ×2.03 is the star buying off 1,973 m of failing arterial — S Grand Blvd 929 m, S Browne St 640 m — for 1.8 km and seven minutes. Route A is the 6.4 km, 31%-failing version of the same trip |
| WWU → Birch Bay State Park | 827–880 m backtrack, all six | WWU sits on Sehome Hill; every option drops north into Bellingham before turning out to the county. The star is the same 40.9 km and 125 minutes as Route A with 907 m less failing road |
| Howard Amon Park → Sacajawea SP | 404 m backtrack, up to 4 reversals | Richland and Pasco face each other across the confluence and the crossings are only at the bridges. The star spends 2.7 km and nine minutes to take failing road from 6.0% to 2.4%, on 21.2 km of trail — most of it the Sacagawea Heritage Trail |
| Wenatchee → Chelan | Route F at ×2.72, 6,707 m backtrack, 4,124 m dismount | The fully-matching escape, working exactly as F2 settled it. The star is the shortest option offered: 65.3 km at 1.1% failing on US 97A |
| Downtown Yakima → Selah | nothing flagged | Named because it is the model at its best: 400 m and one minute moves the rider off 1,491 m of North/South 1st Street, from 22.5% failing to 1.7% |

### Q4 — Oregon explainables, with their constraints (EXPLAINABLE)

| trip | flagged | the constraint |
| --- | --- | --- |
| Bend → Phil's Trailhead | star 32.8% failing, 306 m dismount | Skyliners Road is the only way west out of Bend and 4.1 km of it is unmeasured county road at 45 mph (Q1). The dismount is the trailhead itself: the destination snaps onto Ben's Trail, and with `allowMtbTrails` at its default the router walks the last stretch honestly |
| UO → Spencer Butte | ×1.51, 248 m backtrack | Fox Hollow Road carries 5.3 km of level 4 — again unmeasured county road at 45 mph — and every one of the six options rides 596–726 m of it, because there is no other way to the trailhead. The star spends 1.4 km avoiding the rest |
| SOU Ashland → Britt Gardens | star 4.2 km longer than Route A | The Bear Creek Greenway for 17.2 km, then a choice at the Medford end: South Stage Road (3,686 m failing on Route A), West Main Street (2,890 m on Route B), or the Madrona Lane residential grid. The star takes the grid — 13.5% failing down to 3.9% for twelve minutes |
| Cannon Beach → Manzanita | ×1.19 star, 10.6% failing | US 101 over Neahkahnie Mountain, measured: 30.3 km in the box, 8.8 km level 4, ODOT stress 4 on 14.9 km, shoulders recorded from 1 ft to 22 ft. There is no parallel road and the star rides the only one there is |
| Portland → Vancouver, as a shape | 676 m backtrack on E and F | The Columbia Slough Trail and N Vancouver Avenue, then the Interstate Bridge, on every option; the I-205 path 11 km east is never competitive. Nothing wrong with the route — see S2 for what is |

## What surprised me about the tooling

- **The endpoint-probe stage earns its cost.** Thirteen of my first thirty
  coordinates landed somewhere other than the place they were named after, twice
  by hundreds of metres and once by 2.3 km. Probing every endpoint against the
  graph before routing took four minutes and would otherwise have produced two
  invented findings about walk-ins. The audit tool has no equivalent step; it
  routes whatever it is given.
- **`audit_route.mjs` persists none of the recommendation's arithmetic.** It
  reads `reply.options[]`, which is `publicCandidate` — no `suggestionScore`, no
  `facilityM`, no `trailM`, no `recommendationBasis`. All of that is in
  `reply.allCandidates` (`candidateSummary`), along with every candidate the
  portfolio built and the stage each one died at. Every finding above that
  explains *why* the star is where it is came from a second pass written to read
  that field, and a second pass costs another graph load. Persisting
  `allCandidates` beside the options — about 5 KB per trip — would make the next
  round's diagnosis a query rather than a re-run.
- **`diagnoseNoRoute` does not know about `point-too-far`.** On the Vancouver →
  Portland failure it printed *"both endpoints are reachable — the failure is
  something else, look closer"*, which is true and unhelpful; the reply already
  carried the reason. The classifier tests island / one-way-area / pinprick and
  nothing else, so the one failure mode that is about the *map pack* rather than
  the network falls through to the catch-all.
- **The self-touch metric never fired.** Across all **86** options in this round,
  `selfTouchM` never fell below its 60 m threshold — not once. Backtrack flagged
  56 options and detour 32, and those were where the real questions were. The
  self-touch gate cost nothing, but on this sample it also found nothing.
