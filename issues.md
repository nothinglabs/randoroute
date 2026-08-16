# Human TODO List

This is a short, human-focused list of project TODOs. It is not an LLM
notepad, brainstorming log, or automatic issue tracker. Add, remove, reorder,
or rewrite items only when directed by a human, and keep the list concise.

Some items block on a **field verdict**: the project owner riding or browsing
real routes and reporting back. Do not simulate rides to close them.

## Open

### 1. Shoulder safety
Improve how road shoulders factor into safety verdicts. Not yet scoped —
waiting on examples from the field (specific roads scored wrong, and in which
direction). The shoulder model today: per-direction shoulder widths from the
WSDOT inventory, `minShoulder` rule, optional inference
(`inferShoulderFromEdge`), sidewalk fallback as last resort. See
`docs/SAFETY-MODEL.md` ("A shoulder can depend on which way you ride" and
rung 6).

### 2. Route selection & search UI — field verdict pending
The machinery shipped in v.601/.602; what remains is judging it on real trips
and reacting. Shipped and awaiting verdict:

- **Six letters (A–F)** with direct-lens candidates in every portfolio
  (`direct-lens`, `direct-lens-friendly` profiles).
- **Priced star**: recommendation minimizes
  `time + 1 s/m × (fail + dismount) + 0.2 s/m × ordinary-riding meters`,
  practical window 1.5× distance + 800 m / 1.4× time + 5 min per leg,
  fully-matching override priced at 600 s.
- **Adaptive ferry hybrids**: three refine seeds, two representatives per
  boat plan, plus cross-bred candidates (practical base × safest donor,
  spliced at ferry-group boundaries — `adaptive-corridor[-N]` profiles).
  Test trips: Seattle→Port Townsend, Duck Pond→Kenmore, Phinney→Mukilteo.

Follow-ups that hang on the verdict:
- **Remove the ⚙︎ remix dialog's mode choices?** If the six-letter mix
  reliably covers "more direct" wishes, the remix modes may be redundant.
  (The dialog also now hosts the ferry toggle, so the button stays either way.)
- **Practical-window anchor**: the window currently anchors on the absolute
  fastest candidate, which is often a bold lens route; anchoring on the
  fastest NON-lens candidate is the drafted alternative. Deliberately not
  done yet — one knob at a time.
- **Caution pricing in the star**: adding a small per-meter price for
  caution-level riding was step 3 of the ferry plan, deferred to avoid
  over-fitting before field data.

### 3. Oregon import — done by an agent, awaiting your verdict
`maps/oregon-opus-1/` (renamed from `maps/oregon/` in August 2026; the first
import, by an Opus-class agent, kept as the baseline for a fresh import
attempt under the improved porting docs) ships at readiness 7: routing, tiles,
place search, ODOT stress / speed / shoulder / facility conflation on the
state highway system, and FHWA HPMS volume.
`maps/oregon-opus-1/VERIFICATION.md` checks 30 published corridors and
`docs/PORTING-LESSONS.md` now carries an Oregon line on every lesson.

What to check against your own predictions:

- **The Historic Columbia River Highway State Trail is severed at Mitchell
  Point**, so Portland → Hood River routes around Mount Hood. ODOT confirms a
  real 0.7-mile bicycle gap; construction is expected through late 2026. Recheck
  ODOT's status and rebuild after the connection opens.
- **US 101 on the coast** — the router offers 455 mi against the 364 mi signed
  route, down from 481 mi with 134 failing miles before the ODOT shoulder data.
  Does the remaining 27.5 failing miles match how it rides?
- **Field-check the Aufderheide alternative.** The B6 audit is complete:
  owner-unknown functional class makes an 18-mile forest-road/trail detour cheap
  enough to enter the portfolio; it does not make the signed road fail. Removing
  that class restores a 57.6-mile, 100%-overlap option. Decide after riding
  whether the alternative is useful or a route-cost mistake.
- **Rebuild a current OSM-only Corvallis-to-the-Sea graph.** Functional class,
  AADT and hill-effort A/B runs do not explain its 86% → 11% overlap change. The
  old and current comparison used graphs with 634,000 versus 728,842 edges, so
  it did not isolate agency conflation.

Three lessons did not travel — C2, D7, and B4's population — and those are the
part of this worth reading first.

### 4. Bike routes and safety
Figure out the best way to handle defined bike routes in relation to safety,
including whether to import county-level bike routes.

### 5. Downloadable map packs — machinery shipped, deployment pending
The release plan: ship the app with no bundled map data; download states from
a map store (ours on GitHub Releases; third parties can host their own).
Shipped in v.717: the store contract (`maps/index.json`, "Map stores" in
`maps/README.md`), the installer (`map-store.js` → same offline cache the
service worker serves), the Maps-screen manager (add store / download with
progress / sizes / remove), the slim iOS build (`JRA_SLIM_SHELL=1`), and the
publish stage in `docs/IMPORT-A-STATE.md`. Remaining, in order:

- **Host the store**: upload WA + OR packs and `index.json` to GitHub
  Releases (or equivalent), then verify the by-hand flow in
  `docs/IMPORT-A-STATE.md` from a clean profile.
- **First-run picker**: with a slim deployment there is no map on first
  launch — suggest by location or ask, then download. Not built; needs the
  store live first.
- **Slim iOS on a phone**: the slim shell has no service worker, so
  downloaded packs need verifying inside the Capacitor WKWebView (cache
  storage durability, range reads) before any App Store submission.
- **Decide the web deployment**: keep serving maps same-origin (works today,
  nothing changes) or move the web app to store downloads too.
