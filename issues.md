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

### 3. Oregon import — re-imported August 2026, awaiting your verdict
`maps/oregon/` is the SECOND import, done cold under the improved porting
docs (the first, "Oregon Opus 1", was kept as a baseline for the comparison
and then removed on 2026-08-16; it lives in git history). The re-import ships
at readiness 7: routing, tiles, place search, ODOT stress / speed / shoulder /
facility conflation, FHWA HPMS volume, **and ODOT's current 2024 state-system
AADT** (the signal the first import parked). Its `VERIFICATION.md` checks 30
published route relations; the review found it equal or more direct than the
baseline on every compared trip (Corvallis→Newport 64 vs 107 mi, coast
Astoria→Newport 164 vs 231 mi) and its census/ledger discipline clean.

What to check against your own predictions:

- **The Historic Columbia River Highway trail gap near Mitchell Point.** The
  first import diagnosed a genuine ODOT construction gap (0.7 mi, work
  expected through late 2026); the re-import independently found the OSM
  bicycle relation broken in the same area. Recheck ODOT's status and rebuild
  after the connection opens.
- **The coast.** The re-import routes Astoria→Newport at 164 mi with 6.0
  failing miles (the baseline demanded 231). Does the failing mileage match
  how US 101 rides?
- **`OR`-prefix conflation gate — code fixed in .721, data heals on next
  regenerate.** The prefixes now live in `region.json` as
  `stateRoutePrefixes`; both builders take `--region`, the gate derives from
  it (`scripts/test_state_ref_gate.py` guards this), and the app's
  highway-name test reads `Region.stateRoutePrefixes`. Washington's default
  is byte-identical to the historical gate, so no WA rebuild. The shipped
  Oregon data predates the fix (OR-numbered non-trunk highways
  under-conflated — stale, not broken) and is fixed by the next regeneration,
  which now passes `--region` per `maps/oregon/BUILD.md`.
- **Roads tile count question.** The re-import's `roads.pmtiles` carries
  215,485 features where the baseline carried 308,347. Live rendering looks
  healthy; understand which count is right before the next tile rebuild.

Lessons ledger: the re-import appended an "Oregon re-import (2026-08-16)"
Travelled line to every lesson; C2/D7/B4 remain the ones worth reading first.

### 4. Downloadable map packs — machinery shipped, deployment pending
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

### 5. Multi-state routing — implementation in progress
Work is on `codex/multistate-routing`. Version 1 is capped at three contiguous
installed states and partitions detailed graphs under the released Washington
raw-input ceiling; it does not ship a fixed western coverage box. The contract
and synthetic state-chain gate are complete. The deterministic partition
builder, versioned catalogue, exact-portal validation, atomic publication and
synthetic build gate are complete; the production Washington/Oregon artifact
build remains approval-gated and has not run. The incremental loader, exact
composite graph, real A* frontier reporting, cancellation, active-route pinning,
eviction, budget enforcement and typed-array memory diagnostics pass their
synthetic executable gate. Remaining gates are page/state-chain retry
integration, per-edge state attribution through results and UI, store/offline
dependencies, national discovery and first-run, search continuation,
Washington/Oregon crossing comparisons, preview, full suite, and the owner's
physical-iPhone verdict.
