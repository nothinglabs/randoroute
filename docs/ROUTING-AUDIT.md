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

### R6 — `PORTING-LESSONS.md` E6 describes pricing that no longer ships (DOC)

Lesson E6 records dismount pricing as ×4/×8 with a six-minute entry penalty.
The shipped model is ×3/×8/×32 with a **60-second** entry penalty (`.735`,
after the entry fee at six minutes priced an Interurban crossing gate near ten
minutes and pushed routes onto failing streets). The lesson's `Travelled`
ledger should record the correction rather than the superseded numbers.
