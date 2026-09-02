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
direction). First example to look at: the route heading into Vancouver, WA
from the east. The shoulder model today: per-direction shoulder widths from the
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


### 17. Tweak the segment details page
Three asks from the field, 2026-08-30.

- **Information richness.** The per-segment rows lost content over time and now
  read thin; decide what belongs back. `route-details.js` renders them and has
  not changed since v894 (`f55b868`, 2026-08-27), which retired the shoulder
  line.
- **Easy to close.** `routeDetailsDialog` in `index.html` has no close control
  at all — its head is a title and a description, then the iframe. Every other
  full-screen dialog carries a `dialog-close` button.
- **Name the highway.** Segments say the generic word `highway`
  (`route-details.js:740`) where `stateHighwayName` could resolve the actual
  route number.
