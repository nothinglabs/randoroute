# Verify multi-state routing

This guide exercises the rider-visible Washington/Oregon release and the
synthetic three-state product limit. The physical-iPhone observations are the
owner's verdict; automated and desktop checks do not replace them.

## Setup

Verification target:

| Item | Expected value |
| --- | --- |
| Branch | `codex/multistate-routing` |
| Production-artifact baseline | `468765a` |
| Review commit | Updated beside the milestone-12 preview record |
| App / worker | `2026-08-22.793` / `v793` |
| Partition catalogue | format 1, SHA-256 `3cafdd58116a7124b2b419d77d7cff83dc417f26ee45c285e594ebc724e4a4e4` |
| Oregon graph | `sha-8ae4d0b5e2d3` |
| Washington graph | `sha-c043f268453b` |
| Detailed-input ceiling | 145,828,781 raw bytes |
| Preview | Added in milestone 12; do not use the production Pages URL for branch review |

Run locally from the repository root:

```sh
git switch codex/multistate-routing
python3 scripts/serve.py --port 8765
```

Open `http://127.0.0.1:8765/`. Use a new browser profile for first-launch and
download checks. To reset an existing Chromium profile, open DevTools,
Application, Service Workers, click **Unregister**, then use **Storage → Clear
site data**. In Safari, remove the localhost or preview site's website data in
Settings before reopening it. This deletes downloaded maps and saved local
state for that origin.

The released acquisition totals are exact manifest bytes:

| Map | State map | Routing data | Confirmation total |
| --- | ---: | ---: | ---: |
| Oregon | 126,677,669 | 32,733,741 | 159,411,410 bytes (152.0 MiB) |
| Washington | 166,926,742 | 50,075,126 | 217,001,868 bytes (207.0 MiB) |

The shared 3,629,687-byte catalogue appears in both acquisition manifests but
is stored once when both states are installed. Browser quota reporting may be
an estimate; the confirmation-card byte totals must match the manifest.

## First launch

Build a no-data shell in a temporary directory when testing the acquisition
flow locally:

```sh
JRA_SLIM_SHELL=1 JRA_SHELL_OUTPUT=/tmp/randoroute-slim-shell \
  JRA_MAP_STORE_URL=https://nothinglabs.github.io/randoroute/maps/ \
  node scripts/build_mobile_shell.mjs
python3 -m http.server 8766 --directory /tmp/randoroute-slim-shell
```

Use a live preview/store URL once milestone 12 records it; production Pages is
shown above only as the current default-store contract, not as the branch
preview.

- Allow location. The app should resolve the state locally and ask, for
  example, **Download Washington? This appears to be your current state.** It
  must not start a download before confirmation.
- Clear site data, deny location, and choose a state manually from the resident
  national map. The app remains usable after denial.
- Cancel the confirmation, reopen the state card, then confirm. A dismissal
  should not loop immediately; a deliberate later tap is the retry trigger.
- Stop a download or go offline part way through. No partially installed state
  should appear under Installed maps. Restore connectivity and retry; the
  complete map should initialize after its byte/hash checks finish.

## National map

- Zoom out until the state outlines and names replace detailed local map
  context. Installed, available and unavailable states must have distinct
  status text; the layer is orientation, not nationwide routing.
- Tap Oregon. Before downloading, confirm the card says Oregon, lists mapping,
  routing and offline use, and shows **159,411,410 bytes**.
- Cancel once and confirm on a second attempt. The first state tap must never
  begin downloading.
- At national zoom, inspect Network in DevTools. `national-states.geojson` may
  load; `oregon/*.pmtiles` and `washington/*.pmtiles` must not be fetched merely
  because the states are installed. At zoom 5 or higher, a detailed installed
  state source may attach only while its bounds intersect the viewport, and it
  must detach after panning away.
- Tap a state not offered by the configured stores. It should explain that the
  map is unavailable, not offer national street routing.

## Maps screen

Open **Settings → Maps**.

- Install Oregon and verify it moves from Available maps to Installed maps
  only after the complete state-map and routing acquisitions finish.
- Set Oregon as home, reload, and confirm the opening camera/defaults use
  Oregon. Home state and installed states are separate values.
- Inspect storage. With current manifests, Washington plus Oregon consumes
  372,783,591 unique declared bytes because the routing catalogue is shared.
- Keep both maps installed while calculating an Oregon-only route. Installed
  map count must stay two while route diagnostics name only Oregon's loaded
  detail.
- Remove a non-home state, confirm the destructive action, and verify its card
  moves back to Available maps. Reinstall it before the two-state check.

## Two-state route

Use point-on-map if search does not preserve these exact points:

- Seattle: longitude `-122.33006`, latitude `47.60383`
- Eugene: longitude `-123.09505`, latitude `44.05051`

Expected behavior:

- The required route states are Washington then Oregon. The rider sees state
  names, never partition IDs or a fixed western coverage region.
- A route exists, uses no unintended freeway, and reports both Washington and
  Oregon in route/details attribution. State-border summaries must not label
  Oregon segments with Washington agencies.
- In DevTools, these diagnostics are available without exposing internals in
  rider copy:

```js
({
  routeStates: document.body.dataset.routeStateIds,
  loadedDetailCount: Number(document.body.dataset.loadedPartitionCount),
  rawInputBytes: Number(document.body.dataset.routePartitionInputBytes),
  frontierRetries: Number(document.body.dataset.routePartitionRetries),
})
```

  `routeStates` should be `washington,oregon`, `loadedDetailCount` should be
  positive, and `rawInputBytes` must be at most 145,828,781. Retry count may be
  zero when the coarse selection already covers the winning route.
- Save the route, go offline, reload, and reopen it. It should remain available
  while both exact graph/catalogue dependencies are installed.
- While another cross-state route is preparing, change an endpoint. Only the
  newer request may render; the older partition fetch/search generation should
  abort without an error card.

The executable crossing set also covers Astoria to the Megler Bridge and The
Dalles to Dallesport, a cross-border waypoint, the Seattle–Port Townsend ferry,
one-way/restriction preservation and disconnected nearby roads.

## Three-state synthetic flow

Run the synthetic four-state chain; it creates its fixtures under a temporary
directory and removes them afterwards:

```sh
npm test -- multistate_contract
npm test -- multistate_route_coordinator
npm test -- multistate_store_offline
```

The coordinator test is the end-to-end synthetic flow:

- request state A `[-1.9, 0]` to state C `[3.7, 0]` with only A and C installed;
- expect B to be named as **Required for this trip** and no detail loaded yet;
- install B and resume request ID 17 automatically;
- expect attribution/dependencies for A, B and C and transitions at both
  borders;
- remove B and expect the saved A-to-C intent to remain but become unavailable
  offline;
- request A to D and expect **Routes may cross up to three states in this
  version.**

The synthetic state names occur only in fixtures and tests, not shared app
files.

## Boundary expansion

Production expansion uses Astoria `[-123.8313, 46.1879]` to Portland
`[-122.6765, 45.5231]`. The test deliberately starts with the two disconnected
endpoint partitions. The first detailed attempt must fail with a competitive
frontier, adjacent Oregon detail must load, and a later attempt must succeed
with more than two partitions while staying under 145,828,781 raw bytes:

```sh
npm test -- production_partition_routes
```

The smaller runtime fixture uses `[-2, 0]` to `[1.8, 0]`. It starts with the
first and last partitions, loads the adjacent partition reported by real A*,
retries, reaches the next state-side frontier, loads again and stabilizes:

```sh
npm test -- partition_runtime
```

An unloaded frontier is pending search area. It must never be reported as proof
that the road network ends there.

## Missing and removed data

- Save a cross-state route, remove Oregon in Settings → Maps, and reopen the
  saved route. It must name the missing state/routing dependency and preserve
  the saved item.
- Reinstall Oregon with the same catalogue and reopen the route. Offline use
  should recover without recreating the saved item.
- For deterministic corrupt/missing-file checks, run
  `npm test -- multistate_store_offline`. A missing or hash-mismatched
  partition must fail the acquisition atomically, remove staged bytes and keep
  the prior compatible install. It must not calculate over partial detail.
- The same test replaces a state's source version and verifies dependent
  routing data is invalidated explicitly rather than silently reused.

## Automated checks

Fast feature gates:

```sh
npm test -- graph_partitions
npm test -- partition_runtime
npm test -- multistate_route_coordinator
npm test -- multistate_store_offline
npm test -- multistate_route_page
npm test -- production_partition_routes
npm test -- visible_state_sources
npm test -- mobile_shell_assets
```

Run everything before merge:

```sh
npm test
```

Allow approximately 18–20 minutes in the cloud container; the runner executes
up to six files concurrently. Tests that need absent build inputs or
`tippecanoe-decode` exit 77 and print `SKIP: <reason>`; those are skips, never
passes. Any other nonzero exit fails the gate. The full-suite milestone records
the actual count, skips and elapsed time for this commit.

## Physical iPhone sheet

Record the device and OS before testing. Use `npm run ios:sync`, open
`ios/App/App.xcworkspace`, and install the milestone-14 build on the supported
iPhone. Do not substitute a simulated ride for this sheet.

| Check | Result / timing / failure |
| --- | --- |
| Device model, iOS version, free storage | |
| Cold start to usable national/home map | |
| First state confirmation and install | |
| Second state confirmation and install | |
| Seattle → Eugene calculation | |
| Washington and Oregon attribution | |
| Statewide pan/zoom and detailed-source attach/detach | |
| Background for 2 minutes, then foreground | |
| Start navigation while stationary | |
| Airplane-mode saved-route restoration | |
| Relaunch with both maps installed | |
| Memory warning, reload, crash or blank-map behavior | |
| Endpoint change during route preparation | |
| Map removal and reinstall recovery | |

For any failure, record the wall-clock time, screen, last action, whether iOS
reloaded the web view, and whether retrying from the same installed data worked.
