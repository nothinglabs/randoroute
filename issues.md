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

---

### 18. Routing problems
Three from the field, 2026-08-30. Not yet diagnosed.

- **Lake Forest Park to Phinney offers Bothell Way as Route C**, a dangerous
  arterial, while the safe backroad option is not offered at all. Route C is
  offered as **"Shorter", 8.8 mi / 45 min, and 21% Fails Rules** — a fifth of
  the ride failing, on the option the chooser presents as the short one.
- **Phinney Ridge to Lake Forest Park routes via Lake City Way.**
- **Routing to Vancouver lists a bunch of ferry terminals** as destinations.

The first two are the same corridor in both directions, and Bothell Way and
Lake City Way are both SR 522 — so this reads as one complaint: the arterial
is being offered where a quieter parallel route exists. Worth checking whether
the backroad is being built and then dropped in selection, or never built.

The third is a destination-search problem, not a scoring one, so it likely
lives somewhere else entirely.

---

**Issue 18** — Lake Forest Park to Phinney Ridge. Route C is the one offered as
"Shorter": 8.8 mi, 45 min, **21% Fails Rules**.

<style scoped>section img { display: block; margin: 0 auto; }</style>

![Route chooser with Route C selected, showing 21% Fails Rules h:530](issue-media/issue-18-lfp-phinney-route-c.png)

---

### Fable analysis of issue 18
Measured 2026-08-31 at v958, default rules, place-picker endpoints
(Lake Forest Park → Phinney Ridge).

**What the board does today.** Under default rules all twenty candidates ride
the Burke-Gilman — 11.5 mi of a 14.2 mi ride, every profile including `quick`
and `facility-neutral` — 18 of 20 fold as duplicates, and the board offers two
near-identical trail routes at 70–72 min. The direct corridor is never built
at all. The field board's Route C (8.8 mi / 45 min, 1.9 mi failing on SR 522)
appears under the rider's tuned weights, where the direct corridor IS built —
and rides the arterial, because nothing prices a direct-but-clean middle.

**Two defects, in order of importance.**
1. **The safe-direct middle candidate is missing.** Nothing in the grid
   searches "direct-ish, fails at full price, facility pull off". The
   backstreets parallel to SR 522 are never explored: the trail discount
   pulls every profile — alternative-corridor and facility-neutral probes
   included — onto the same Burke-Gilman spine.
2. **No fail ceiling on a seat.** A candidate with 21% failing mileage takes
   the "Shorter" seat beside clean options with no eligibility test.

**Suggested actions, for another agent.**
- Corridor-monoculture check in the diversity rounds: when nearly every
  built candidate shares one spine (here 20/20 on the Burke-Gilman), re-run
  one search with that spine's edges surcharged. The alternative-corridor
  machinery exists; measure why its penalty loses to the trail discount and
  scale it accordingly.
- Add a direct-clean probe to the grid: direct mode, facility/trail
  discounts neutralized, fail multipliers at full price. Its job is exactly
  the rider's ask — the quickest route that touches no failing road.
- Gate seats by fails: a candidate failing more than ~0.5 mi or ~5% of its
  riding may be offered only when every clean option costs at least ~1.35×
  its time (tune the ratio). Keep the inverse guarantee: when nothing clean
  is within the ratio, the failing route is offered, and says why.
- Honesty check on this very trip: the clean board is 70 min against the
  failing 45 — 1.56×, so the SR 522 route would legitimately survive a
  1.35× gate today. The gate only bites once an action above has put the
  safe-direct middle on the board; land those first.
- Re-measure this exact trip, both directions, after each step. The third
  bullet of issue 18 (ferry terminals in the Vancouver destination search)
  is a separate search problem and is untouched by all of this.

