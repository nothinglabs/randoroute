#!/usr/bin/env node
// Device-budget invariants of the RELEASED partition catalogue. The corridor
// study behind these (2026-08-24): rural spine cells are cheap — every
// corner-to-corner rural diagonal admits 19-76 MB — so the binding constraint
// on any trip is the metro cells its straight line crosses. Seattle's largest
// cell is 58 MB, which already puts the Seattle-Portland strict floor at
// 90 MB. A future import (California's Los Angeles above all) must keep its
// metro cells small enough that two metro endpoints plus a connecting spine
// fit one composite, or long trips start refusing at the ceiling.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { check, checkEqual, done, ROOT } from './testlib/harness.mjs';

const require = createRequire(import.meta.url);
const { MultiStateRouteCoordinator: Coordinator } =
  require(join(ROOT, 'multi-state-route-coordinator.js'));
const { MultiStateRouting } = require(join(ROOT, 'multi-state-routing.js'));
const catalogue = require(join(ROOT, 'maps/partition-catalogue.json'));

const ceiling = MultiStateRouting.MAX_DETAILED_GRAPH_INPUT_BYTES;
const largest = Math.max(...catalogue.partitions.map((partition) => partition.rawBytes));
check('the largest partition leaves room for a second metro and a spine (≤45% of the ceiling)',
  largest <= ceiling * 0.45, `largest ${largest} of ${ceiling}`);

for (const state of catalogue.states) {
  const config = require(join(ROOT, 'maps', state.id, 'region.json'));
  checkEqual(`${state.id} region.json graphRawBytes matches the catalogue source graph`,
    config.graphRawBytes, state.sourceRawBytes);
}

const corridors = [
  // The worst real diagonal: both metros sit on the straight line.
  ['Bellingham→Ashland through Seattle and Portland',
    [[-122.4787, 48.7519], [-122.7095, 42.1946]]],
  // Rural diagonals stay far under the ceiling.
  ['Forks→Ontario', [[-124.3854, 47.9502], [-116.9629, 44.0266]]],
  ['Metaline Falls→Brookings', [[-117.3735, 48.8624], [-124.2839, 42.0526]]],
];
for (const [name, points] of corridors) {
  const corridor = Coordinator.selectInitialPartitionCorridor({
    catalogue, points, pointStateIds: ['washington', 'oregon'],
    routeStateIds: ['oregon', 'washington'], budgetBytes: ceiling,
  });
  check(`${name} admits an initial corridor under the ceiling`,
    corridor.rawInputBytes <= ceiling,
    `${corridor.partitionIds.length} cells, ${corridor.rawInputBytes} bytes`);
}

done();
