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

Filled in per wave; see the sections below.
