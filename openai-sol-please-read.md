# Unfinished work, as of `e49edb8` (v2026-08-11.675 / sw v651)

Everything below is *open*. Everything else from the session is on `main`,
pushed, and covered by tests.

Read `AGENTS.md` first — two rules were added today that bear directly on this
list: nothing here is "not yours", and a shrinking context budget is not a
reason to hand work back instead of doing it. Both were written because I did
those things in the session that produced this file.

---

## 1. Does the zoomed-out failing-road dash still read solid?

**Needs a phone. I could not verify it and did not pretend otherwise.**

A failing road is one dark red dash at every zoom (`FAIL_DASH` in `app.js`, a
legacy `{ stops }` function — *not* an expression; see the comment there, an
expression is accepted by `addLayer` and then silently drops the layer). The
rider reported it reading solid when zoomed out. I coarsened the low-zoom end
and could not confirm the effect.

`test_fail_road_style.mjs` walks rendered pixels and asserts the dash is even
across zooms, but **only at z12 and up**. Below that the map draws thousands of
level-4 features (9,754 on screen at z9), each a few pixels long, so a walk
along them measures feature fragments rather than dash marks — it reported a
"2 px dash" that did not move when the dasharray was doubled. Low zoom needs a
different instrument, not a looser threshold.

If it still reads solid on the phone, suspect **density** (how much red is on
screen) rather than dash geometry. That is a different fix.

## 2. Prove Route Details never decides a verdict itself

`test_route_details_agreement.mjs` pins the one copied setting it found
(`routeSummaryStats(minShoulderFt = 4)` vs `DEFAULT_RULES.minShoulder`). It does
**not** prove the stronger claim, that every verdict in `route-details.js` goes
through `SafetyModel`.

I tried, by pattern-matching the source for a local level/verdict function with
no `SafetyModel` call. It false-positived, and `AGENTS.md` forbids source-text
assertions for that reason. Removed, with a note in the file.

What would actually prove it: run the page against a fixture route and compare
its per-segment levels against `SafetyModel.evaluate()` over the same facts.
Inspection says it is currently clean — every verdict delegates — so this is
guarding a property, not chasing a known bug.

## 3. The surface audit, continued

Three tests now check that **what a rider reads matches the data behind it**,
rather than that the code contains a particular expression:

- `test_verdict_agreement.mjs` — the road card's verdict vs the painted road vs
  the router, per state, over sampled graph edges.
- `test_source_counts.mjs` + `test_source_counts.py` — the layer list's feature
  counts vs the shipped data.
- the card checks in `test_ribbon_never_hides_road.mjs`.

Surfaces **not** yet covered by that kind of test: the route summary
percentages, the turn instructions, the voice announcements, and the elevation
profile. Each states facts to the rider that are derived somewhere else.

This is the through-line worth keeping: the suite could prove the *model* agreed
with itself (`test_build_parity.py`, `test_fact_contract.mjs`), and nothing
checked the rider-facing end. That gap is what let a road card say "Passes your
rules" on a road the map drew red and the router detoured 45 miles around.

## 4. Oregon, at readiness 7

`maps/oregon/` ships. Two things in it are known-unresolved, both recorded in
`maps/oregon/VERIFICATION.md`:

- **Mitchell Point.** The Historic Columbia River Highway State Trail is severed
  in the data, so Portland → Hood River routes around Mount Hood. Diagnosed as
  an OSM gap. Needs someone to say whether it is a gap on the ground.
- **Forest roads got worse after conflation** — Aufderheide 100% → 76% corridor
  agreement, Corvallis to the Sea 86% → 11%. The suspicion is that the FHWA
  class proxy over-prices remote Forest Service collectors in a state that is
  60% federal land. Undiagnosed; lesson B6's blast-radius count was never run.

Also open from that import: nothing in the suite opens the app on Oregon's *real*
tiles. `test_region_portable` and `test_maps_states_screen` both invent states;
only the corridor and verdict tests read Oregon's real graph.

## 5. Housekeeping

- `issues.md` still lists the Oregon import as "awaiting your verdict". It has
  been merged; the rider verdict genuinely is still open, so the entry is not
  wrong, but it predates the merge. That file says items change only when a
  human directs it.
- The final full-suite run for `e49edb8` never completed — the container
  restarted mid-run. The previous run (`22031f0`) was **96/96, exit 0**, and
  every test touched since has been run individually. Re-run `npm test` to
  confirm the head commit.
