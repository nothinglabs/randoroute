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

### 2. Downloadable map packs — machinery shipped, deployment pending
The release plan: ship the app with no bundled map data; download states from
a map store (ours on GitHub Releases; third parties can host their own).
Shipped in v.717: the store contract (`maps/index.json`, "Map stores" in
`maps/README.md`), the installer (`map-store.js` → same offline cache the
service worker serves), the Maps-screen manager (add store / download with
progress / sizes / remove), the slim iOS build (`JRA_SLIM_SHELL=1`), and the
publish stage in `docs/IMPORT-A-STATE.md`. The web installer also resumes a
stable short response through a validated byte-range tail before its normal
size/hash commit. Remaining, in order:

- **Host the store**: upload WA + OR packs and `index.json` to GitHub
  Releases (or equivalent), then verify the by-hand flow in
  `docs/IMPORT-A-STATE.md` from a clean profile.
- **First-run field verification**: the resident national map, explicit local
  location suggestion, confirmation card, exact-size download, cancellation,
  reload and persisted dismissal are implemented. Verify the configured live
  store and permission/download behavior in a slim WKWebView before shipping.
- **Slim iOS on a phone**: the slim shell has no service worker, so
  downloaded packs need verifying inside the Capacitor WKWebView (cache
  storage durability, range reads) before any App Store submission.
- **Decide the web deployment**: keep serving maps same-origin (works today,
  nothing changes) or move the web app to store downloads too.

### 3. Multi-state routing — implementation in progress
Work is on `codex/multistate-routing`. Version 1 is capped at three contiguous
installed states and partitions detailed graphs under the released Washington
raw-input ceiling; it does not ship a fixed western coverage box. The contract
and synthetic three-state policy, deterministic builder, exact-portal
validator, incremental loader, real-A* frontier retry, cancellation, eviction,
budget enforcement, jurisdiction propagation, atomic store/offline lifecycle,
national orientation, first-run acquisition, state-aware search and pending
download continuation are complete.

The production Washington/Oregon release contains 89 partitions and 7,620
exact portals. Its largest partition is 60,481,818 raw bytes, below the
145,828,781-byte detailed-input ceiling. Executable gates route
Seattle–Portland, Seattle–Eugene, Astoria–Megler and The Dalles–Dallesport,
retain the important Washington ferry and an Oregon full-graph portfolio,
route a boundary waypoint, and expand beyond deliberately disconnected endpoint
partitions. Version 1 presents one active-profile route for a cross-state trip;
single-state trips retain their ordinary portfolio. Installed non-home map
sources now attach only for the visible viewport, and the full iOS shell is
bounded to two starter states rather than every future import.

Remaining gates:

- run the full executable suite and record its passes/skips/runtime; and
- prepare the iOS build/handoff, then get the owner's physical-iPhone verdict
  for Cache Storage durability, memory pressure, navigation and real timings.

### 4. Import and test all states
Import every U.S. state under the documented state-import process and verify
each state's data, routing, map rendering, place search, and cross-state
behavior.

### 5. Data-completeness approach for all states
Define a repeatable way to measure source coverage, freshness, and quality for
every state against Washington's level. Establish evidence-based acceptance
criteria and make gaps visible before a state is considered comparable.

### 6. Release / go-to-market plan
Define the release sequence, deployment channels, target riders, positioning,
launch validation, and post-launch support plan.

### 7. Stability issues / random crashing — possibly zoom-related
Reproduce and diagnose the random crashes, determine whether zoom behavior is
the cause, and fix the underlying stability issue.

### 8. Data licensing and Google Maps key usage
Verify OSM and every other data source's licensing and attribution requirements.
Audit Google Maps API-key usage, restrictions, and compliance with its terms.

### 9. Finalize app name
Choose and approve the final public name for the app before release.
