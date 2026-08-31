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

### 7. Stability issues / random crashing — possibly zoom-related
Reproduce and diagnose the random crashes, determine whether zoom behavior is
the cause, and fix the underlying stability issue. The known
ride-length-scaling mechanisms are fixed; needs a field verdict on whether
the random restarts persist.

---

### 8. Data licensing and Google Maps key usage
Verify OSM and every other data source's licensing and attribution
requirements. Rotate/revoke the previously exposed Google Maps Embed key in
Google Cloud and verify API restrictions and terms before any in-app embed
is re-enabled.

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

### 12. A short trip routes as forty-nine miles
Jackson Avenue Southeast (Port Orchard) to Bremerton is a few miles across
Sinclair Inlet and roughly ten by road around it. Route F came back
**49.5 mi / 5 h 12 m**, swinging south to Gig Harbor and looping back up the
peninsula. It claims 0% fails rules, so the router is satisfied with it —
this looks like the direct way being refused rather than a scoring slip.
Screenshot from the field. First thing to check: whether routes A–E are also
~50 mi. If they are, the connection around the inlet is being refused for
everyone; if only F is, it is the lower-stress profile.

---

### 13. Show sidewalks on failing segments, and price them into routing
A failing segment never mentions a mapped sidewalk unless the rung-7 fallback
fires, and that fallback is narrow: `sidewalkFallbackApplies` in
`safety-model.js` wants the sidewalk `present`, no bike facility, and a known
speed over the no-shoulder limit — an untagged shoulder counts as 0 ft by
design, so a missing shoulder never blocks it. What gets nothing is a road
that fails on lanes or traffic while inside the speed limit, or at any rung
above 6 — such a road can fail, have a sidewalk, and never say so. Two
parts: surface the sidewalk on failing segments whether or not the fallback
fired, and let it count in routing cost in those cases too (today it prices
in only through rung 7, at ×1.9 / ×3.8 / ×8.0). Mechanics changes belong in
`docs/SAFETY-MODEL.md`.

---

### 14. Near-duplicate routes still reach the board
Phinney to Woodinville comes back with routes that read as the same ride.
Field report, 2026-08-31, after v950-v954 tightened this from several
directions: `distinctRideMi` now defaults to 1.0 mi with a 30% cap on short
routes, 95%-overlap near-twins fold, and the tri-lens domination pass drops a
near-twin whose consensus score is worse. Something still gets through. The
All Routes screen shows the deciding verdict per row (`duplicate`,
`dominated`, the fold line and the twin it folded against), so the first step
is to open that screen on this trip and read which rule let the pair stand,
rather than tightening a threshold again in the dark.

---

### 15. Get iPhone notifications working
The lock-screen Live Activity is written but has never been compiled: it
shows the maneuver arrow, "Left turn in 0.2 miles", the full instruction and
remaining distance, on the lock screen and in the Dynamic Island, driven by
the same background location stream that speaks while locked. The widget
extension target does not exist in the Xcode project
(`grep RandoRouteActivity ios/App/App.xcodeproj/project.pbxproj` finds
nothing), and it cannot be created from a text editor, so ActivityKit has
nothing to render and `Activity.request` fails silently behind its `try?`.
`docs/IOS-HANDOFF.md` section 3c has the one-time Xcode procedure and the
device checks. Two traps it names: the shared attributes file needs target
membership in BOTH targets or the widget renders blank, and the extension
needs a 16.2 deployment target while the app sits at 15.0. Nothing else
visual exists today — no local notifications, no web notifications, no badge.

---

### 16. Reduce redundant spoken guidance
The voice repeats itself more than it needs to. Today the only suppression is
in `speakNavigation` (`app.js`): an exact text match inside five seconds is
dropped, and a queued status line is discarded when a maneuver supersedes it.
That catches back-to-back GPS fixes re-speaking one phrase; it does not catch
the same maneuver announced at two distances, a status line that restates
what the last one said in different words, or guidance that arrives while the
rider is plainly still doing the previous thing. Needs a field list of what
actually got said, in order, before changing the rules.
