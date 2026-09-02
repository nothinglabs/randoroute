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

### 3. Import and test all states
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

### 4. Data-completeness approach for all states
Define a repeatable way to measure source coverage, freshness, and quality for
every state against Washington's level. Establish evidence-based acceptance
criteria and make gaps visible before a state is considered comparable.

---

### 5. Release / go-to-market plan
Define the release sequence, deployment channels, target riders, positioning,
launch validation, and post-launch support plan.

---

### 6. Data licensing
Verify OSM and every other data source's licensing and attribution
requirements.

---


### 7. Tweak the segment details page
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

---

### 8. Searching for Vancouver returns ferry terminals
Field, 2026-08-30. Typing "Vancouver" as a destination lists a bunch of ferry
terminals. Carried over from the former issue 18, whose other two items (the SR 522
corridor, both directions) were fixed in v959-v963; this one was never
touched. It is a destination-search problem, not a routing or scoring one --
the place index (`maps/<state>/places.json`) and the search that ranks it.

### Claude's Analysis
Reproduced against the shipped Washington index with the ranker's own rule.
Three causes compound; none is in routing.

- **The index holds ferry terminals outside Washington.** `build_places.py`
  admits every named `amenity=ferry_terminal` node in the OSM extract with no
  bounds test. The extract carries nodes referenced by ways that cross the
  border, so the BC Ferries and Alaska Marine Highway routes drag in
  Tsawwassen (Delta, BC), Salt Spring Island, Nanaimo and Ketchikan. 12 of the
  87 `ferry` rows in `maps/washington/places.json` lie outside the state.
- **Each Tsawwassen berth is its own row.** OSM maps the terminal as eight
  nodes ("Vancouver (Tsawwassen) Berth 1" … "Berth 5 (Foot Access)"). The
  builder dedups on (name, kind); the names differ, so all eight survive.
- **The local ranker is nearest-first with no weight for kind or size.**
  `localMatches()` in `app.js` puts every prefix match in one tier and sorts
  it by distance from the map centre. From Seattle the berths are 167 km away
  and Vancouver, WA (population 190,915) is 260 km, so the eight berths fill
  all eight result slots and the city never appears. Same from Bellingham.
  From Portland the list is right: city, Vancouver Heights, Vancouver Mall.

Fix, by leverage:

1. `build_places.py`: keep `ferry` rows only inside the state's bounds, and
   collapse `Berth N` / `(Foot Access)` suffixes to one terminal row. Re-run
   for WA and OR (the PBFs are in `data/`), `npm run maps:registry`, trio
   bump. A data release, about ten minutes. Not done here.
2. `localMatches()`: rank `city`/`town` rows ahead of hamlets and ferry
   terminals before distance, so a `ferry` row never outranks a `city` of the
   same name. App code only.

---

### 9. Finalize the help and onboarding experience
Review the first-run onboarding and the Help screen end to end under the
Safeish name and decide what a new rider needs to see before their first
route, and what belongs in Help versus on the map. Not yet scoped.

