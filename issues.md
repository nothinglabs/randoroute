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
stable short response through a validated byte-range tail, caps each stream at
that validated interval when WebKit over-delivers the body, then performs its
normal size/hash commit. Remaining, in order:

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
partitions. Installed partition trips retain the ordinary route portfolio;
a widening retry that does not improve the portfolio finalizes the result, so
a long cross-state calculation converges after at most one extra search
instead of re-running the portfolio toward the graph-input ceiling (Seattle to
Buckman formerly ran six). Installed non-home map sources attach only for the
visible viewport and now include safety overlays. Regional zooms use the small
resident state polygons instead of oversized context tiles, while detailed
land and water take over at closer zooms. The full iOS shell is bounded to two
starter states rather than every future import.
The Maps screen distinguishes the one startup Home map from every map On
device and states the three-contiguous-state routing limit.
Release `.806` keeps each visible neighboring state's land below water and
neutral roads below safety paint, and a failed optional overlay source now
retries without removing that state's working land and road sources. Focused
constrained-iPhone browser gates cover the Washington/Oregon layer stack and
partial-source recovery.

Remaining gates:

- suite gate recorded 2026-08-24 on `claude/multi-state-routing-review-3khslx`
  at `.805`: 146 of 151 files passed, 2 skipped (missing `tippecanoe-decode` /
  build inputs), 2195 s wall. Of the three failures, two were in-suite timing
  flakes that pass standalone (`fail_road_style`, `saved_routes_ui`) and one
  was a test defect now fixed (`multistate_place_search`'s wait predicate
  spans the continue-trip reload and threw during the new document's boot
  window instead of retrying).
- get the owner's physical-iPhone verdict for Cache Storage durability, memory
  pressure, navigation and real timings.

### 4. Import and test all states
Import every U.S. state under the documented state-import process and verify
each state's data, routing, map rendering, place search, and cross-state
behavior. Feasibility study 2026-08-24 (PORTING-LESSONS G8,
`test_partition_catalogue_budget.mjs`): corridor memory is bounded by metro
partition size, not corridor length, so a large-metro state (California)
must be built with a finer partition grid; a state whose full graph exceeds
the device budget now routes its own trips through the partition session
automatically (`graphRawBytes` in region.json). The native iOS shell still
cannot serve store-installed states (no service worker) — that gap blocks
any store-delivered state on native and is the biggest open item for a
California release.

### 5. Data-completeness approach for all states
Define a repeatable way to measure source coverage, freshness, and quality for
every state against Washington's level. Establish evidence-based acceptance
criteria and make gaps visible before a state is considered comparable.

### 6. Release / go-to-market plan
Define the release sequence, deployment channels, target riders, positioning,
launch validation, and post-launch support plan.

### 7. Stability issues / random crashing — possibly zoom-related
Reproduce and diagnose the random crashes, determine whether zoom behavior is
the cause, and fix the underlying stability issue. Four specific
ride-length-scaling mechanisms were fixed in `.803`: elevation-canvas
reallocation on every draw, full route-profile re-upload on every GPS fix,
the render pipeline running while backgrounded, and a launch-window race
loading the graph during map warm-up. Needs a field verdict on whether the
random restarts persist; if they do, the remaining suspects are listed under
"crash audit" in the session findings.

### 8. Data licensing and Google Maps key usage
Verify OSM and every other data source's licensing and attribution requirements.
The tracked Google Maps Embed key was removed in `.797` after GitHub detected
it in the public preview; Street View now hands off to Google Maps without a
repository credential. The owner still needs to rotate/revoke that exposed key
in Google Cloud and verify API restrictions and terms before any in-app embed is
re-enabled.

### 9. Finalize app name
Choose and approve the final public name for the app before release.

### 10. Directional bike lanes — code shipped, graph rebuild pending
A lane on one side of a two-way street (OSM `cycleway:right`/`:left`) is now
stored, priced, judged and described per direction of travel (field: 37th
Avenue NE claimed "Bike lane" on the unlaned side; "A bike lane can also
depend on which way you ride" in `docs/SAFETY-MODEL.md`). The encoding is
backward-compatible, so shipped graphs behave exactly as before until the
Washington and Oregon graphs (and their partitions) are rebuilt with
`build_graph.py` on a machine with the OSM extracts — this container has no
build inputs. WSDOT's `BikeFacilitySides` attribute is recorded but not yet
used for direction; a later refinement.
