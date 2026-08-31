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

---

### 1. Shoulder safety
Improve how road shoulders factor into safety verdicts. Not yet scoped —
waiting on examples from the field (specific roads scored wrong, and in which
direction). The shoulder model today: per-direction shoulder widths from the
WSDOT inventory, `minShoulder` rule, optional inference
(`inferShoulderFromEdge`), sidewalk fallback as last resort. See
`docs/SAFETY-MODEL.md` ("A shoulder can depend on which way you ride" and
rung 6).

---

### 2. Downloadable map packs — machinery shipped, deployment pending
<style scoped>section { font-size: 24px }</style>

The release plan: ship the app with no bundled map data; download states from
a map store (ours on GitHub Releases; third parties can host their own).
The machinery is shipped and tested. Remaining, in order:

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

---

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

---

### 5. Data-completeness approach for all states
Define a repeatable way to measure source coverage, freshness, and quality for
every state against Washington's level. Establish evidence-based acceptance
criteria and make gaps visible before a state is considered comparable.

---

### 6. Release / go-to-market plan
Define the release sequence, deployment channels, target riders, positioning,
launch validation, and post-launch support plan.

---

### 8. Data licensing
Verify OSM and every other data source's licensing and attribution
requirements.

---

### 9. Finalize app name
Choose and approve the final public name for the app before release.

---

### 10. Rebuild the Washington and Oregon graphs
The released graphs predate two shipped fixes that only take effect at
build time: directional bike lanes (a lane on one side of a two-way street
is stored and judged per direction of travel, but shipped graphs still
claim both directions) and the DEM water clamp (pier nodes sampled the sea
floor, inventing thousands of feet of climb; the routing engines repair it
at load, the build now samples it correctly at the source). One rebuild
session with `build_graph.py` plus the partition build activates both.

---

### 11. Removing a road block does not correctly update the route
Adding a road block reroutes as expected; removing one does not put the
route back the way it should. Reported from the field — the exact wrong
behaviour is not pinned down yet. `removeRoadBlock` in `app.js` is the entry
point, and Help states the contract a removal has to keep: road blocks hold
the current route recipes and letters, so clearing one should re-deal that
same lineup without the block.

---

### 15. Get iPhone notifications working
Build side done 2026-08-30: the Live Activity compiles clean and the
`RandoRouteActivity` extension target now exists (hand-authored into the
pbxproj — the "needs the Xcode GUI" claim proved wrong). The Release device
build embeds a signed `RandoRouteActivity.appex`, WidgetKit extension point,
iOS 16.2 floor, attributes type in both binaries, deep codesign passing.
First render on a physical iPhone confirmed the same evening — card, headline,
instruction, and distance all correct, but white-on-white; fixed with explicit
ink colors (the lock screen is a dark environment, so adaptive styles come out
light). Remaining §3c device checks: arrow/headline turn tracking, Dynamic
Island views, off-route, arrival self-dismiss, Stop, Live-Activities-off
degradation — plus re-checking contrast on the rebuilt card.
