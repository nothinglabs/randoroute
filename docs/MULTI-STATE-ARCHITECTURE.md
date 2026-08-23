# Multi-state routing architecture

Status: the generic contract, deterministic partition build, incremental
composite runtime, state-chain controller and end-to-end jurisdiction path are
implemented on `codex/multistate-routing`, with executable synthetic and browser
gates. Existing single-state routing remains the production compatibility path
until acquisition and cross-border tests described here are complete.

## Product boundary

Version 1 routes through at most three contiguous installed states. The limit
is `MultiStateRouting.MAX_ROUTE_STATES`, not a pair-specific branch. Riders may
install more states than one route needs; installed map count does not determine
worker memory use.

The rider chooses states. Partitions, portals and search frontiers are internal
implementation details and appear only in diagnostics.

The implementation does not provide coast-to-coast routing, a national street
graph, or a fixed western Washington/Oregon coverage box. It does not import a
new state's underlying data. A future state enters through its ordinary
`maps/<state>/` contract and generated catalogues; shared application code does
not name it.

## Six independent kinds of state

These values must not be collapsed into one active-region variable:

| Concept | Runtime representation | Meaning |
| --- | --- | --- |
| Available maps | `availableStateIds` | Listed by trusted stores or the orientation catalogue |
| Installed maps | `installedStateIds` | Complete acquisition units available offline |
| Home/current map | `homeStateId`, `currentStateId` | Initial camera/defaults and locally resolved location |
| Required route maps | `routeStateIds` | Ordered contiguous state chain for the pending trip |
| Loaded routing data | `loadedPartitionIds` | Detailed graph inputs resident in the worker |
| Visible detailed maps | `visibleSourceIds` | Tile sources required by the current viewport |

`createRoutingRuntimeState()` enforces the basic separation and the detailed
input budget. The page will own available, installed, home/current, route and
visible-source state. The worker will own loaded partitions and report a
snapshot to the page for diagnostics.

## Compatibility path

An ordinary state graph remains readable and routable internally. A state with
no partition metadata loads through the current `graph` worker message and is
treated as one implicit jurisdiction. Existing saved routes continue to restore
through their current state dependency. New saved routes add an explicit array
of state and partition-catalogue versions; missing dependencies make a saved
route unavailable offline but never silently delete it.

Partition support is additive:

1. A state import still produces and validates `graph2.bin.gz` first.
2. The partition builder reads ordinary graphs without changing route scoring.
3. Stores may publish the ordinary graph, partitions, or both during migration.
4. The client selects partition routing only when every required state has a
   compatible, complete catalogue.
5. A catalogue or partition failure falls back only when a complete compatible
   ordinary graph can satisfy the same route. It does not reinterpret an
   unloaded boundary as a disconnected road.

## State-chain planning

`planRouteStates()` accepts available and installed state IDs plus symmetric
state adjacency derived from validated cross-state portals. It returns:

- the ordered route-state chain;
- all equally short credible state-chain candidates, capped at a named limit;
- missing endpoint or transit states;
- an unavailable/disconnected verdict; or
- `route-state-limit` with “Routes may cross up to three states in this
  version.”

Among equally short chains it prefers the one requiring the fewest downloads,
then applies a stable lexical tie-break. Partition-level coarse planning may
retain several corridors inside that state chain; choosing a state chain does
not choose a fixed sub-state coverage region.

The state adjacency graph is generated from exact cross-state portals. Bounds
overlap or geographic proximity never creates routable adjacency.

## Partition artefacts

The generated catalogue format is
`MultiStateRouting.PARTITION_CATALOGUE_FORMAT`. Its v1 top-level fields are:

| Field | Contract |
| --- | --- |
| `partitionCatalogueFormat` | Strict reader version |
| `graphFormat` | Detailed partition binary compatibility |
| `build` | Builder/version, deterministic algorithm, source epoch and exact source graph hashes |
| `states` | Source graph path, version/hash, compressed/raw bytes and owned partition IDs |
| `partitions` | Stable ID, owner, path, bounds, counts, sizes, hash, source version, format and adjacency |
| `portals` | Exact two-ended node joins that justify every adjacency relation |

Arrays and adjacency lists are sorted. The build provenance uses a supplied
source epoch instead of wall-clock time. Partition and catalogue bytes must be
identical when inputs, tool version and options are identical.

Partition IDs are derived from the owning state and a stable spatial cell, not
from array order. Partition edges retain the ordinary graph's fields and add a
jurisdiction index. Boundary nodes are duplicated only through declared portal
records. Each portal names two partition-local node indices and their exact
Float32 longitude/latitude bit patterns.

Where build inputs retain an OSM node identity, the portal records it. Where an
ordinary graph no longer retains that identity, the builder uses
`encoded-coordinate` identity and requires identical encoded coordinate bits.
It never joins nodes within a distance tolerance. The validator rejects:

- non-identical endpoint bits;
- a node index outside its partition;
- asymmetric partition adjacency;
- adjacency with no portal;
- a portal with no two distinct partitions;
- source/hash/version disagreement; and
- unsorted or unsafe generated identities and paths.

An adjacency relation is routable topology, not merely a shared cell boundary.

## Detailed loading and routing

Coarse planning chooses an initial connected set of partitions around the
endpoints and credible portal sequences. The detailed worker then follows this
lifecycle:

1. Receive a request generation, route-state chain and initial partition set.
2. Cancel fetches and searches belonging to older generations.
3. Stream, decompress and validate partitions before admitting them.
4. Refuse admission if the declared raw input would exceed the hard budget;
   evict non-participating, non-retained partitions and retry admission.
5. Run the existing scoring and portfolio algorithms over the loaded composite
   graph without changing safety rules or edge weights.
6. Record competitive search frontiers that terminate at portals into unloaded
   adjacent partitions.
7. Load the best frontier's adjacent partition set and retry. Continue until a
   stable portfolio is found, no credible frontier remains, cancellation wins,
   or the supported budget cannot contain the required connected working set.
8. Retain partitions intersecting the selected route and navigation window.
   Evict other detailed data independently of installed state count and map
   tile visibility.

The retry decision compares the frontier's admissible lower bound with the
worst retained competitive candidate. An unloaded frontier is “not searched
yet,” never “no road exists.” Corridor expansion is bounded by route-state IDs,
partition compatibility and input budget rather than a geographic product box.

Diagnostics report request generation, route-state IDs, loaded partition IDs,
compressed/raw bytes, derived-array bytes, retained partitions, frontier lower
bounds, retries, cancellations and evictions.

`partition-loader-worker.js` owns admission, cancellation, sequential
decompression, composition and retained-partition policy. It posts a standard
`BGRC` snapshot plus compact per-edge state and partition sidecars to the
existing routing worker. Only one decompressed source partition is copied at a
time. Exact catalogue portals merge duplicate local nodes, adjacency is rebuilt
from the copied edges, and all ordinary edge fields, geometry, names and
directions remain unchanged.

The routing worker accepts the snapshot through its existing graph path and
runs the existing scoring and portfolio code. Partition mode permits endpoint
snaps in initially disconnected loaded components, then reports only reached
portal nodes with admissible lower bounds that can compete with the current
result.

`multi-state-route-coordinator.js` is the page-side controller. It derives
state adjacency only from exact cross-state portals, plans all ordered route
points, identifies missing transit maps, enforces the three-state limit, chooses
equal-short coarse partition corridors that fit the input budget, and resumes a
held request after its required maps become installed. Its browser bridge owns
the loader and routing workers, transfers each replacement composite, retries
the same route request while the real A* reports competitive frontiers, and
cancels both workers when a newer endpoint generation wins. The store contract
supplies installed catalogue acquisitions to this controller; ordinary packs
without them continue through the single-state graph path.

## Memory contract

The v1 detailed graph input ceiling is 145,828,781 bytes, the measured raw size
of the released Washington `BGRC` graph on 2026-08-22. It is exposed as
`MAX_DETAILED_GRAPH_INPUT_BYTES` and can be lowered for constrained-device and
test configurations. Catalogue/coarse-planner memory is measured separately.

This ceiling covers decompressed detailed graph inputs admitted at one time. It
does not claim that a phone uses only that amount: graph views, composite
indices, bearings, A* arrays, portfolio caches, geometry, decompression overlap
and the JavaScript runtime add memory. The loader reports declared raw input,
composite bytes, largest raw/compressed partition, mapping/working arrays and a
composition peak estimate. The router reports graph bytes, permanent typed
arrays, per-edge sidecars and reusable cache arrays. These figures omit engine
and JavaScript-object overhead, so they are diagnostics rather than a heap
limit. The physical-iPhone sheet in the verification guide owns the final
memory-pressure verdict.

## Jurisdiction

Every partition edge carries the owning state/jurisdiction. Composite edge IDs
resolve to `(partitionId, localEdgeIndex, stateId)` and route results retain
that identity through geometry and segment aggregation. UI adapters resolve
agencies, route-number interpretation and facility vocabulary from the edge's
state configuration, never from the home state.

The routing worker emits ordered `jurisdictions`, distinct `stateIds` and
`partitionIds`, and carries all three edge identity fields on each segment.
The main map, Route Details, saved-route records and navigation instructions
preserve those fields. Route cards select stress, speed, restriction and
facility attribution from the segment state; same-named roads are not merged
across a border. Each route also records the exact source graph and partition
hash dependencies needed to decide later whether it can be restored offline.

The identity must survive:

- route geometry and diagnostics;
- road and route cards;
- stress, speed, restriction and facility attribution;
- state-border segment transitions;
- saved-route dependencies; and
- navigation reroutes.

An ordinary unpartitioned state graph implicitly assigns all edges to that
state, preserving current behavior.

## Store and offline acquisition

The store extension publishes state metadata and one or more atomic acquisition
units. A routing-capable unit includes its partition catalogue, every file the
catalogue declares necessary for offline use, source-state dependencies,
versions, sizes and hashes. Installation streams each file into the existing
data cache and records the unit only after every verification succeeds. Failure
or cancellation removes the partial unit.

Partition files use stable logical same-origin paths so web, service worker and
slim Capacitor shells share the contract. CORS is required for cross-origin
stores; byte-range behavior remains required for PMTiles. Partition downloads
do not require range support because each partition is independently fetchable.

Removing a state removes its owned partition bytes and invalidates dependent
catalogues. Saved routes remain listed with a clear missing-state dependency.
Updates replace an atomic acquisition unit and invalidate composites containing
an old constituent graph/catalogue version. Cache cleanup walks recorded
acquisition manifests rather than retaining unreachable URL variants.

Cache Storage remains the initial storage backend. Browser and WKWebView tests
must measure quota, durability and range behavior with expected pack sizes.
Native-only storage is justified only by a failed measurement and must sit
behind a small bridge.

## Orientation, acquisition and search

A small resident national layer contains state boundary polygons, label points,
availability identity and no street data. Styling distinguishes installed,
available and unavailable states. Detailed state tile sources are attached only
for states visible at an appropriate zoom; installed count never causes all
tile archives to load.

A state tap opens a confirmation/status card. The first tap never downloads.
Available-state cards show exact acquisition size, capabilities, route impact
and Download. Installed cards show storage, home-state and removal controls.
Unavailable cards explain that the map is not offered.

On a slim first launch, local point-in-polygon against the resident boundaries
may suggest the current state under existing location-permission patterns. The
app does not silently download. Denial, dismissal, cancellation and failure
leave manual national-map and Maps-screen selection available; an explicit
dismissal is persisted until a reasonable later trigger.

Search loads place indexes for installed states only. Every result carries a
state ID. Border duplicates use stable source identity when available and a
small display-only spatial/name deduplication that never affects graph
connectivity. Lightweight online/store results may identify an uninstalled
destination without fetching its complete place index. Selecting one stores a
pending route intent, installs endpoint and transit states after confirmation,
then resumes the same intent. Offline search reports the installed scope.

## Test boundary

Synthetic executable fixtures prove three-state behavior without adding real
state folders or naming fixtures in shared application code. They cover state
chains, missing-transit continuation, two border attribution changes, saved
dependencies and removal, exact portals, boundary expansion, cancellation,
budget enforcement and the fourth-state message.

Partition-vs-full comparisons then protect representative in-state Washington
and Oregon behavior. Cross-state tests cover several Columbia crossings,
partition boundaries, one-way and restriction handling, false-nearby joins,
waypoints, updates, removal and offline restoration. Comparisons assert route
behavior rather than exact coordinates or source text.

The full suite remains the final automated gate. Physical-device navigation and
memory pressure remain human verdicts.

## Delivery order

1. Contract and synthetic state-chain tests.
2. Deterministic partition builder/catalogue and exact-portal tests.
3. Incremental composite worker, frontiers, cancellation, eviction and budget.
4. State-chain integration and three-state route continuation.
5. Per-edge jurisdiction through route/UI/save layers.
6. Store acquisition, updates, removal and offline restoration.
7. National orientation map and first-run acquisition.
8. Multi-state search and pending-request continuation.
9. Full-graph comparisons, Washington/Oregon crossings and documentation.
10. Review preview, full suite and physical-iPhone handoff.
