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
Release `.807` replaces the constrained renderer's administrative-polygon
ground at zooms 4–8 with deterministic per-state `regional.pmtiles` archives.
The two archives add 1,599,289 bytes; Washington's largest decoded regional
tile is 450,298 bytes. Browser probes keep Whidbey dry, Admiralty Inlet,
Saratoga Passage and Deception Pass open, Green Lake water-filled through the
zoom-9 detailed handoff, and tested tile seams filled. Existing store-installed
maps expose the changed acquisition as **Update** and reload after the atomic
install so the new geography becomes active.

Release `.808` fixes two `.807` field failures. Washington installs failed
with "expected 915501 bytes, received 915593": GitHub Pages served the file
gzip-encoded, the installer compared the encoded wire size against the
manifest's raw size, and Content-Encoding is invisible cross-origin. The
installer now judges decoded stored bytes only (retrying one mismatch);
`test_map_store_install` serves a gzip-encoded archive cross-origin to pin
the field case, `test_store_manifest_integrity` checks all 129 declared
store files against disk bytes and sha256, and
`scripts/verify_store_deploy.mjs <url>` audits a deployed store. Second,
`.807`'s Whidbey verification measured the wrong thing: its probes asserted
which layers claimed a point, not the rendered color, and pixel sampling on
a constrained renderer showed 36 of 81 probe cells wrong -- Saratoga
Passage and the sea south of Whidbey painted the exact land fill from z6
through z9.4, because the Census state polygon includes marine water and
nothing above it painted the sea (the regional water layer carries lakes).
`.808` excludes any state whose coastline-true regional archive is attached
from the Census ground fill and removes the regional layers' z9 cap so
overzoomed z8 tiles stay the permanent backdrop under the detailed layers;
a state without a regional pack keeps its Census ground.
`test_whidbey_stays_an_island` asserts rendered pixel color at
pixel-verified sea, land and lake coordinates: with the detailed archive
blocked, z6-z11.5 all hold; through the z9 handoff with detail serving,
z8.9-z10 all hold. `test_road_safety_reveal_alignment` pins base road
casings and the safety overlay to identical per-class reveal zooms, home
state and cloned neighbors alike.

Release `.809` fixes the `.808` field boot failure on the slim PWA: a
resurrected iOS launch can answer localStorage reads with nothing for the
first moments, region.js decides localDataAvailable synchronously in that
window, and a device with its home state installed booted to the national
map with no prompt while Settings called Washington ready to use. The app
now re-checks the registry after a dataless boot and reloads once (a
location-hash marker prevents looping without needing storage), and
downloadStoreState reloads when the state it installed is the data-less
home region instead of reporting ready-to-use over the national map.
`test_storage_blind_boot` drives blind-then-recovered, truly-empty and
install-recovery worlds. The remaining field report -- ambient streets
white while a route shows its colors -- did not reproduce: masks are
aligned and ambient verdict blue renders in both normal and route-dimmed
modes at z13; the symptom matches the roads safety source still streaming
tiles right after the 208 MB re-install and forced restart. Needs a field
verdict on whether it persists in steady state.

Release `.810` fixes the `.809` field report of southern Washington
rendering as open sea between Longview and The Dalles on a phone without
Oregon installed. Root cause: `land_detail` is the coastline band only --
inland ground far from the coast exists solely in the generalized `land`
layer at every zoom of the detailed archive -- and the `.807` regional
build re-tiled only land_detail and water. The Census-fill exclusion that
fixed sea-as-land exposed the gap (an attached Oregon regional clone
papers over it, which is why container probes missed it). The regional
archive is now a verbatim tile-join copy of the detailed archive's z4-z8
tiles restricted to land, land_detail and water: the per-zoom
generalizations desktop has always rendered, with no re-simplification.
Washington 542,103 bytes, Oregon 398,245 -- smaller than both prior
builds. Known limit, accepted: the narrow throat of Admiralty Inlet
(about 5 km, two pixels at z6) generalizes closed below z7 in the
archive's own low-zoom cartography, as it always has on desktop; the wide
reach of Admiralty, Saratoga Passage, Possession Sound and the south
channel stay open at every zoom (pixel-gated). A composite build (pushed-
down z8 coastline unioned with inland-only generalized land) could
restore the throat; parked, trigger: a rider judging the z6 closure
objectionable in the field. `test_regional_ground_inland` pins the field
world in pixels (Washington only, detailed archive blocked, wedge land,
Saratoga water, z6-z10.5). A route that fails because a state's maps are
not installed now offers an "Open the Maps screen" button on the failure
card (`test_route_unavailable_maps_action`).

Remaining gates:

- `.808` focused gates recorded 2026-08-24 on
  `claude/multi-state-routing-review-3khslx`: island pixel test 2/2, regional
  bands 3/3, multistate rendering 10/10, reveal alignment 3/3, store install
  8/8, manifest integrity, live deploy verified 129/129 at the preview URL.
  The full-suite run for `.808` has not happened yet.
- merged `.807` gate recorded 2026-08-24 on `codex/multistate-routing`: all
  required focused gates passed; the complete run passed 152 of 154 files in
  1650.5 s with no skips. `device_start_follows` and `saved_routes_ui` failed
  only under suite load and then passed standalone in 22.3 s and 16.7 s.
  `fail_road_style`, the previously recorded suite-load flake, passed in this
  run.
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

### 10. Field rendering failures — self-healing shipped in .806
Screenshots on .805 showed lake labels without lake polygons and Portland
with base roads but no green or safety overlays. The first harness run to
exercise the real serving path (service worker + store-installed archives)
found: (a) .805's store rejected its own index at install time (unknown
`graphRawBytes` key — fixed, pinned by test); (b) in a healthy browser the
full path renders everything, so the field holes are device cache/WebKit
state — now self-healing twice over: a torn or unreadable SW chunk answers
from a bounded slice of the cached full archive instead of failing the
range, and an error burst on a loaded source reloads that source (once per
45 s) since MapLibre never re-asks for a failed tile; (c) Mac desktop
Safari was classed as a constrained RENDERER (Apple vendor), hiding lakes,
green and land detail below z9 on a desktop — it now gets the desktop map
while keeping the WebKit worker budgets. Phones keep the z9 detailed-context
floor, while `.807` supplies coastline-correct land and water at z4–8 from the
small regional archives instead of oversized context tiles. Needs a field
verdict on .807.

### 11. Directional bike lanes — code shipped, graph rebuild pending
A lane on one side of a two-way street (OSM `cycleway:right`/`:left`) is now
stored, priced, judged and described per direction of travel (field: 37th
Avenue NE claimed "Bike lane" on the unlaned side; "A bike lane can also
depend on which way you ride" in `docs/SAFETY-MODEL.md`). The encoding is
backward-compatible, so shipped graphs behave exactly as before until the
Washington and Oregon graphs (and their partitions) are rebuilt with
`build_graph.py` on a machine with the OSM extracts — this container has no
build inputs. WSDOT's `BikeFacilitySides` attribute is recorded but not yet
used for direction; a later refinement.
