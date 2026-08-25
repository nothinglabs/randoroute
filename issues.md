# Human TODO List

**AGENTS: STOP WRITING TO THIS FILE.** It is edited on explicit human
request only. It is not your notepad, not a changelog, and not a place to
record releases, gates, or session findings — put those in commit messages.

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
normal size/hash commit. Since `.808` it judges completion by decoded stored
bytes, never the wire Content-Length: CDNs gzip some transfers, the encoded
size differs from the manifest's raw size, and Content-Encoding is not
CORS-readable, so the header pair cannot be trusted cross-origin. Remaining, in order:

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

### 3. Multi-state routing — remaining to-dos
- Physical-iPhone verdict on cross-state trips: Cache Storage durability,
  memory pressure, navigation behavior, and real timings.
- Field verdict: ambient street safety coloring in steady state (reported
  white once right after an install; did not reproduce in the harness).
- Parked: a composite regional build could reopen the narrow Admiralty
  Inlet throat at z6, which the generalized coastline closes (as desktop
  has always drawn it). Trigger: a rider finds it objectionable.
- Deflake `test_saved_routes_ui` (intermittent 6.5 px navigation-position
  assertion under load).

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

### 10. Rebuild the Washington and Oregon graphs
The released graphs predate two shipped fixes that only take effect at
build time: directional bike lanes (a lane on one side of a two-way street
is stored and judged per direction of travel, but shipped graphs still
claim both directions) and the DEM water clamp (pier nodes sampled the sea
floor, inventing thousands of feet of climb; the routing engines repair it
at load, the build now samples it correctly at the source). One rebuild
session with `build_graph.py` plus the partition build activates both.

