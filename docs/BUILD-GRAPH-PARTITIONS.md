# Build and publish graph partitions

Graph partitions are generated from ordinary `maps/<state>/graph2.bin.gz`
files. Build and verify the ordinary state graphs first; partitioning does not
replace the state-import gates and does not change route scoring.

After a validated catalogue is in place, run `npm run maps:registry`.
`maps/index.json` then publishes one exact `routing-partitions` acquisition per
participating state and the client verifies it atomically. Do not publish an
unstamped index or a catalogue that has not passed the validator below.

## Before a production build

A full Washington/Oregon partition build reads 237,286,369 decompressed graph
bytes before writing its partition set. It can exceed the repository's
20-minute approval threshold depending on compression speed and storage. Name
the states, grid size, expected elapsed time and output cost, then get the
required approval before running it.

No source download or ordinary graph rebuild is part of this command.

Run the synthetic contract first:

```bash
npm test -- graph_partitions
```

It builds temporary ordinary graphs twice, proves byte reproducibility, checks
exact and rejected joins, validates every emitted byte, and removes its output.

## Build

From the repository root:

```bash
npm run maps:partitions
```

With no state arguments, the builder discovers every `maps/<state>/region.json`
that declares `datasets.graph`. To build an explicit release set:

```bash
python3 scripts/build_graph_partitions.py \
  --maps-root maps \
  --state <state-id> \
  --state <adjacent-state-id> \
  --cell-degrees 1 \
  --catalogue maps/partition-catalogue.json
```

The default one-degree global grid is part of the partition algorithm version,
not a rider-visible coverage region. Every edge belongs to the cell containing
the midpoint of its stored geometry. Edges are never clipped or duplicated.
Changing the grid size is a new measured build decision; record its effect on
partition sizes, corridor expansion and fetch count.

For reproducible provenance, set `SOURCE_DATE_EPOCH` or pass
`--source-date-epoch`. The default is zero. Wall-clock build time never enters
an artifact.

## Outputs

The builder writes:

```text
maps/
  partition-catalogue.json
  <state>/
    partitions/
      v<builder>-<source-sha>-g<cell-size>/
        grid-<cell-size>-<lon-cell>-<lat-cell>.bin.gz
```

Partition IDs use the owning state and global grid cell and remain stable while
the algorithm is unchanged. Artifact paths include a source/acquisition key so
a new build cannot overwrite bytes still named by the old catalogue.

Each compressed file contains:

1. a `BGP1` wrapper;
2. canonical metadata identifying partition, owner, source version/hash and
   format; and
3. a current `BGRC` ordinary graph containing the partition's nodes, edges,
   geometry, names and rebuilt directed adjacency.

Older BGR9/BGRA/BGRB ordinary graphs are accepted as inputs. Missing appended
fields are written with the same unknown/default semantics into BGRC, giving the
partition worker one uniform embedded format while preserving the ordinary
single-state compatibility path.

The catalogue records source compressed/raw sizes and hashes; partition owner,
bounds, node/edge/arc/geometry/name counts, embedded/compressed/raw sizes,
hashes and format; sorted adjacency; exact portals; and deterministic build
provenance. The complete counts let the runtime allocate one composite output
and copy partitions into it sequentially instead of retaining every
decompressed input at once.

## Portal rules

Within a state, partitions connect only when their edges shared the same source
graph node. Across states, current ordinary graphs no longer carry OSM node IDs,
so the builder accepts only identical Float32 longitude/latitude bit patterns.
There is no proximity tolerance.

If either state has two distinct source nodes at a candidate cross-state
coordinate, the build fails unless the source graph itself proves them to be a
single seam: equal elevation, fully connected by legal two-way edges no longer
than one metre, with every geometry point at the same exact Float32 coordinate.
The lowest source-node index is then the deterministic representative. This
narrow exception preserves an explicit source connection and handles graph
builder seams; it does not infer connectivity from distance. Any disconnected,
one-way, prohibited, longer, differently elevated or geometrically distinct
duplicate remains ambiguous and fails. If future ordinary graph inputs retain
OSM node identities, prefer those identities and keep the exact-coordinate
check as validation.

Every adjacency entry must be justified by at least one validated portal, and
every portal must appear in adjacency. `multi-state-routing.js` enforces both
directions.

## Validate

Before commit or upload:

```bash
node scripts/validate_partition_catalogue.mjs \
  maps/partition-catalogue.json \
  --artifact-root maps \
  --source-root maps
```

The validator reads every source graph and partition. It checks catalogue
shape, ordering and topology; source size/hash/raw size; partition
size/hash/raw size; BGP1 lengths; wrapper identity/version/hash; and embedded
BGRC magic.

Run the same command against a staged publication by pointing
`--artifact-root` at the partition tree and `--source-root` at the ordinary
graphs used to build it.

## Atomicity, retries and cleanup

The builder stages a complete set beneath the output root. A portal or wrapper
failure publishes neither catalogue nor partition acquisition. A successful
build publishes each new versioned acquisition directory, atomically replaces
the catalogue, then removes older generated acquisition directories.

Rebuilding an acquisition whose source hash and algorithm key already exist
compares every staged byte with the existing output. A difference fails the
build as a reproducibility defect instead of overwriting it.

An interruption may leave an unreferenced staging directory or newly published
versioned acquisition, but it cannot make the old catalogue name partially
overwritten files. A later successful build removes unreachable generated
acquisitions. Store-side retention and installed-client cleanup are specified
separately by the map-store acquisition contract.

## Publication record

Record with a published catalogue:

- branch and commit;
- builder and catalogue format versions;
- source state graph versions and SHA-256 values;
- grid algorithm and cell size;
- partition and portal counts;
- compressed total, raw total and largest-partition raw bytes;
- validator output;
- store CORS behavior;
- preview retention/expiration policy; and
- known route, expansion or device-memory limitations.

Never use portal count alone as cross-border proof. Executable crossing routes,
false-nearby cases, restrictions, one-way behavior, expansion and full-graph
comparisons remain separate acceptance gates.

## Released Washington/Oregon build

The 2026-08-22 production run used `global-grid-v1:1deg`, builder version 1,
catalogue format 1 and graph format `bgp1-bgrc12`. The generated catalogue is
3,629,687 bytes with SHA-256
`3cafdd58116a7124b2b419d77d7cff83dc417f26ee45c285e594ebc724e4a4e4`.

| Measurement | Result |
| --- | ---: |
| Partitions | 89 |
| Exact portals | 7,620 |
| Partition bytes, compressed | 75,549,493 |
| Partition bytes, raw | 237,886,441 |
| Embedded graph bytes | 237,862,617 |
| Largest partition raw | 60,481,818 |
| Largest partition compressed | 18,939,331 |

The largest partition is
`washington/grid-1000000/0057-137` with 503,235 nodes and 590,083 edges.
Oregon's source is `sha-8ae4d0b5e2d3` (SHA-256
`8ae4d0b5e2d32d82f22dfdfeb25cdd93b67964822936edcfeadcfbb4651f4329`);
Washington's is `sha-c043f268453b` (SHA-256
`c043f268453b0970afebb9dfdc5899d7d87eecf5fd0e7b04a0e86607fb6995d1`).

The validator reported `validated 2 states, 89 partitions, 7620 exact
portals`. The executable production gate routes Seattle–Eugene, Astoria–Megler
and The Dalles–Dallesport; retains a Washington ferry plan and an Oregon
portfolio against their full graphs; routes a boundary waypoint; and expands
from deliberately disconnected endpoint partitions before stabilizing. This
record is a desktop artifact/behavior result. Physical-iPhone peak-memory and
navigation verdicts remain in the handoff guide.
