// A production partition-routing session over the released catalogue: the
// coordinator drives the real composition runtime and the real router worker
// in the harness's fake-browser context. Production tests share this instead
// of each rebuilding the loader/search adapters.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { ROOT, routerWorkerFromBuffer } from './harness.mjs';

const require = createRequire(import.meta.url);
const { MultiStateRouteCoordinator: Coordinator } =
  require(join(ROOT, 'multi-state-route-coordinator.js'));
const { MultiStateRouting } = require(join(ROOT, 'multi-state-routing.js'));
const { PartitionRouting } = require(join(ROOT, 'partition-runtime.js'));

export const productionCatalogue = require(join(ROOT, 'maps/partition-catalogue.json'));

function rawPartition(partition) {
  return zlib.gunzipSync(readFileSync(join(ROOT, 'maps', partition.path)));
}

/** Route one request through a fresh production partition session. */
export async function productionPartitionRoute(request, { selectInitialCorridor } = {}) {
  const progress = [];
  const catalogue = productionCatalogue;
  const session = new Coordinator.MultiStateRouteSession({
    catalogue,
    installedStateIds: catalogue.states.map((state) => state.id),
    resolveStateId: async () => null,
    budgetBytes: MultiStateRouting.MAX_DETAILED_GRAPH_INPUT_BYTES,
    selectInitialCorridor,
    onProgress: (event) => progress.push(event),
    loadComposite: ({ partitionIds, routeStateIds, budgetBytes, signal }) =>
      PartitionRouting.composePartitions({ catalogue, partitionIds, routeStateIds,
        budgetBytes, signal, loadPartition: rawPartition }),
    search: async ({ request: active, composite }) => {
      const worker = routerWorkerFromBuffer(composite.buffer, {
        partitioned: true,
        stateIds: composite.stateIds,
        loadedPartitionIds: composite.loadedPartitionIds,
        edgeStateIndexes: composite.edgeStateIndexes,
        edgePartitionIndexes: composite.edgePartitionIndexes,
        partitionRanges: composite.partitionRanges,
        diagnostics: composite.diagnostics,
      });
      if (!worker.ready) return { type: active.type, id: active.id, ok: false,
        reason: 'The composed production graph did not initialize.' };
      worker.post({ type: 'partition-frontiers', id: `${active.id}-frontiers`,
        frontiers: composite.frontiers });
      return worker.post(active);
    },
  });
  const result = await session.route(request);
  return { result, progress };
}
