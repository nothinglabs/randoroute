#!/usr/bin/env node
// Compose real BGP1 partition artifacts incrementally, then route the emitted
// ordinary BGRC through the production worker.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { appDefaultRules, check, checkEqual, done, ROOT,
  routerWorkerFromBuffer } from './testlib/harness.mjs';

const require = createRequire(import.meta.url);
const { PartitionRouting: P } = require(join(ROOT, 'partition-runtime.js'));
const python = process.env.PYTHON || 'python3';
const fixture = join(ROOT, 'scripts/testlib/build_synthetic_partition_fixture.py');
const builder = join(ROOT, 'scripts/build_graph_partitions.py');
const temp = mkdtempSync(join(tmpdir(), 'randoroute-runtime-'));
const maps = join(temp, 'maps'), output = join(temp, 'output');

try {
  execFileSync(python, [fixture, maps], { cwd: ROOT });
  execFileSync(python, [builder, '--maps-root', maps, '--output-root', output,
    '--catalogue', join(output, 'partition-catalogue.json'),
    '--state', 'state-a', '--state', 'state-b'], { cwd: ROOT, stdio: 'pipe' });
  const catalogue = JSON.parse(readFileSync(join(output, 'partition-catalogue.json'), 'utf8'));
  const ids = catalogue.partitions.map((partition) => partition.id);
  const rawById = new Map(catalogue.partitions.map((partition) => [partition.id,
    zlib.gunzipSync(readFileSync(join(output, partition.path)))]));
  let activeLoads = 0, maxActiveLoads = 0;
  const loadPartition = async (partition, { signal } = {}) => {
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    activeLoads++;
    maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
    await Promise.resolve();
    activeLoads--;
    return rawById.get(partition.id);
  };

  const totalRaw = catalogue.partitions.reduce((sum, partition) => sum + partition.rawBytes, 0);
  const composed = await P.composePartitions({ catalogue, partitionIds: ids,
    routeStateIds: ['state-a', 'state-b'], budgetBytes: totalRaw, loadPartition });
  const graph = P.parseBgrc(composed.buffer);
  check('all four partition edges compose into one ordinary BGRC graph',
    graph.E === 4 && graph.D === 7, JSON.stringify({ nodes: graph.N, edges: graph.E, arcs: graph.D }));
  checkEqual('three exact portals merge eight local nodes into five graph nodes', graph.N, 5);
  checkEqual('no unloaded frontier remains after every route partition loads', composed.frontiers.length, 0);
  checkEqual('partitions are decompressed and copied one at a time', maxActiveLoads, 1);
  check('edge jurisdiction follows the owning state across the composite',
    [...composed.edgeStateIndexes].map((index) => composed.stateIds[index]).join('|')
      === 'state-a|state-a|state-b|state-b',
    JSON.stringify([...composed.edgeStateIndexes]));

  const worker = routerWorkerFromBuffer(composed.buffer, {
    partitioned: true, stateIds: composed.stateIds,
    loadedPartitionIds: composed.loadedPartitionIds,
    edgeStateIndexes: composed.edgeStateIndexes,
    edgePartitionIndexes: composed.edgePartitionIndexes,
    partitionRanges: composed.partitionRanges,
    diagnostics: composed.diagnostics,
  });
  check('the production router accepts the composed graph', worker.ready);
  const ready = worker.messages.find((message) => message.type === 'ready');
  check('worker startup measures graph input, permanent arrays, sidecars, and loaded IDs',
    ready.memory.graphInputBytes === composed.buffer.byteLength
      && ready.memory.derivedPermanentBytes > 0 && ready.memory.sidecarBytes > 0
      && ready.loadedPartitionIds.length === 4,
    JSON.stringify(ready));
  const rules = appDefaultRules();
  const forward = worker.post({ type: 'route', id: 1, start: [-2, 0], end: [1.8, 0],
    rules, mode: 'balanced', prefDesignated: false, prefResidential: false });
  check('a route crosses both internal portals and the exact state portal',
    forward.type === 'route' && forward.ok && forward.coords.length >= 5,
    JSON.stringify({ type: forward.type, ok: forward.ok, reason: forward.reason }));
  check('route segments retain state, partition, and partition-local edge identity',
    forward.segs.map((segment) => segment.stateId).join('|')
      === 'state-a|state-a|state-b|state-b'
      && forward.segs.every((segment) => segment.partitionId
        && Number.isInteger(segment.localEdgeIndex) && segment.localEdgeIndex >= 0),
    JSON.stringify(forward.segs.map(({ stateId, partitionId, localEdgeIndex }) =>
      ({ stateId, partitionId, localEdgeIndex }))));
  check('route jurisdiction aggregation splits at the exact state border',
    forward.jurisdictions.length === 2
      && forward.jurisdictions.map((entry) => entry.stateId).join('|') === 'state-a|state-b'
      && forward.stateIds.join('|') === 'state-a|state-b'
      && forward.partitionIds.length === 4,
    JSON.stringify(forward.jurisdictions));
  const reverse = worker.post({ type: 'route', id: 2, start: [1.8, 0], end: [-2, 0],
    rules, mode: 'balanced', prefDesignated: false, prefResidential: false });
  check('the composed route still respects the source graph one-way edge',
    reverse.type === 'route' && reverse.ok === false, JSON.stringify(reverse));
  const restrictedReverse = worker.post({ type: 'route', id: 'restricted-reverse',
    start: [0.8, 0], end: [-2, 0], rules, mode: 'balanced',
    prefDesignated: false, prefResidential: false });
  check('a directional bicycle restriction remains impassable across the state boundary',
    restrictedReverse.type === 'route' && restrictedReverse.ok === false,
    JSON.stringify(restrictedReverse));

  const initialIds = [ids[0], ids.at(-1)];
  const initial = await P.composePartitions({ catalogue, partitionIds: initialIds,
    routeStateIds: ['state-a', 'state-b'], budgetBytes: totalRaw, loadPartition });
  checkEqual('endpoint partitions expose two unloaded search frontiers', initial.frontiers.length, 2);
  const initialWorker = routerWorkerFromBuffer(initial.buffer, { partitioned: true });
  const frontierAck = initialWorker.post({ type: 'partition-frontiers', id: 'initial',
    frontiers: initial.frontiers });
  checkEqual('the router accepts composite frontier-node configuration',
    frontierAck.type, 'partition-frontiers-ready');
  const initialRoute = initialWorker.post({ type: 'route', id: 3,
    start: [-2, 0], end: [1.8, 0], rules, mode: 'balanced',
    prefDesignated: false, prefResidential: false });
  check('a disconnected initial corridor reports the competitive reached frontier',
    initialRoute.ok === false && initialRoute.frontierHits.length === 1
      && initialRoute.frontierHits[0].exits[0].adjacentPartitionId === ids[1],
    JSON.stringify(initialRoute.frontierHits));
  const firstRetry = P.selectFrontierExpansion({
    loadedPartitionIds: initial.loadedPartitionIds, frontiers: initial.frontiers,
    frontierHits: initialRoute.frontierHits, routeFound: false, maxAdditions: 1,
  });
  const middle = await P.composePartitions({ catalogue,
    partitionIds: [...initialIds, firstRetry[0].adjacentPartitionId],
    routeStateIds: ['state-a', 'state-b'], budgetBytes: totalRaw, loadPartition });
  const middleWorker = routerWorkerFromBuffer(middle.buffer, { partitioned: true });
  middleWorker.post({ type: 'partition-frontiers', id: 'middle', frontiers: middle.frontiers });
  const middleRoute = middleWorker.post({ type: 'route', id: 4,
    start: [-2, 0], end: [1.8, 0], rules, mode: 'balanced',
    prefDesignated: false, prefResidential: false });
  check('the first retry reaches the next unloaded state-side frontier',
    middleRoute.ok === false && middleRoute.frontierHits.some((hit) =>
      hit.exits.some((exit) => exit.adjacentPartitionId === ids[2])),
    JSON.stringify(middleRoute.frontierHits));
  check('loading the reported adjacent partition stabilizes the successful route',
    forward.ok && composed.frontiers.length === 0);
  const expansion = P.selectFrontierExpansion({
    loadedPartitionIds: initial.loadedPartitionIds,
    frontiers: initial.frontiers,
    frontierHits: initial.frontiers.map((frontier, index) =>
      ({ node: frontier.node, lowerBound: 100 + index })),
    routeFound: false, maxAdditions: 2,
  });
  check('a failed initial search widens through both credible adjacent corridors',
    expansion.length === 2
      && expansion.every((frontier) => !initialIds.includes(frontier.adjacentPartitionId)),
    JSON.stringify(expansion));
  check('a found route ignores a frontier whose lower bound cannot compete',
    P.selectFrontierExpansion({ loadedPartitionIds: initialIds, frontiers: initial.frontiers,
      frontierHits: [{ node: initial.frontiers[0].node, lowerBound: 500 }],
      routeFound: true, worstCompetitiveCost: 400 }).length === 0);

  let budgetError = null;
  try {
    await P.composePartitions({ catalogue, partitionIds: ids,
      budgetBytes: totalRaw - 1, loadPartition });
  } catch (error) { budgetError = error; }
  check('admission fails clearly before loading when raw input exceeds the hard budget',
    budgetError?.code === 'graph-input-budget' && activeLoads === 0,
    `${budgetError?.code}: ${budgetError?.message}`);

  const runtime = new P.PartitionGraphRuntime({ catalogue, budgetBytes: totalRaw, loadPartition });
  await runtime.load({ partitionIds: ids, routeStateIds: ['state-a', 'state-b'] });
  runtime.pinActiveRoute([ids[0]]);
  const reduced = await runtime.load({ partitionIds: [ids.at(-1)],
    routeStateIds: ['state-a', 'state-b'] });
  check('eviction retains the active-route partition and drops unrelated detail',
    reduced.loadedPartitionIds.join('|') === [ids[0], ids.at(-1)].sort().join('|')
      && reduced.diagnostics.evictedPartitionIds.length === 2,
    JSON.stringify(reduced.diagnostics));

  let releaseSlowLoad;
  const slowLoader = (partition, { signal }) => new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    releaseSlowLoad = () => {
      signal.removeEventListener('abort', abort);
      resolve(rawById.get(partition.id));
    };
  });
  const cancelling = new P.PartitionGraphRuntime({ catalogue, budgetBytes: totalRaw,
    loadPartition: slowLoader });
  const obsolete = cancelling.load({ partitionIds: ids, routeStateIds: ['state-a', 'state-b'] })
    .then(() => null, (error) => error);
  await Promise.resolve();
  const current = cancelling.load({ partitionIds: [ids[0]], routeStateIds: ['state-a'] });
  await Promise.resolve();
  releaseSlowLoad();
  const obsoleteError = await obsolete;
  const currentResult = await current;
  check('changing endpoints aborts the obsolete partition generation',
    obsoleteError?.name === 'AbortError' && currentResult.loadedPartitionIds.join() === ids[0],
    `${obsoleteError?.name}; ${currentResult.loadedPartitionIds}`);
  check('runtime diagnostics expose loaded IDs, bytes, generation, eviction, and pinning',
    Number.isInteger(runtime.diagnostics().generation)
      && runtime.diagnostics().rawInputBytes > 0
      && Array.isArray(runtime.diagnostics().loadedPartitionIds)
      && Array.isArray(runtime.diagnostics().pinnedPartitionIds),
    JSON.stringify(runtime.diagnostics()));
  const memoryAfterRoute = worker.post({ type: 'routing-memory', id: 'after-route' });
  check('worker memory diagnostics include reusable arrays allocated by a route',
    memoryAfterRoute.type === 'routing-memory'
      && memoryAfterRoute.measuredBytes >= memoryAfterRoute.graphInputBytes
      && memoryAfterRoute.reusableBytes > 0,
    JSON.stringify(memoryAfterRoute));
  const replaced = worker.post({ type: 'graph', buffer: initial.buffer,
    partitioned: true, stateIds: initial.stateIds,
    loadedPartitionIds: initial.loadedPartitionIds,
    edgeStateIndexes: initial.edgeStateIndexes,
    edgePartitionIndexes: initial.edgePartitionIndexes,
    diagnostics: initial.diagnostics });
  check('widening can replace a composite without retaining graph-indexed caches',
    replaced.type === 'ready' && replaced.edges === 2
      && replaced.memory.reusableBytes === 0
      && replaced.memory.loadedPartitionIds.length === 2,
    JSON.stringify(replaced));

  const protocolMessages = [];
  const controller = new P.PartitionLoaderController({
    loadPartition,
    postMessage: (message) => protocolMessages.push(message),
  });
  await controller.handle({ type: 'init', id: 'init', catalogue, budgetBytes: totalRaw });
  await controller.handle({ type: 'load', id: 'load', partitionIds: initialIds,
    routeStateIds: ['state-a', 'state-b'] });
  const protocolGraph = protocolMessages.find((message) => message.type === 'partition-graph');
  check('the loader-worker protocol initializes, reports progress, and returns transferable graph state',
    protocolMessages[0].type === 'partition-runtime-ready'
      && protocolMessages.some((message) => message.type === 'partition-progress')
      && protocolGraph?.buffer instanceof ArrayBuffer
      && protocolGraph.frontiers.length === 2,
    protocolMessages.map((message) => message.type).join(', '));
  await controller.handle({ type: 'diagnostics', id: 'diagnostics' });
  check('the loader-worker protocol exposes IDs, byte totals, peak estimate, and generation',
    protocolMessages.at(-1).type === 'partition-diagnostics'
      && protocolMessages.at(-1).diagnostics.estimatedCompositionPeakBytes > 0
      && protocolMessages.at(-1).diagnostics.loadedPartitionIds.length === 2,
    JSON.stringify(protocolMessages.at(-1)));
} finally {
  rmSync(temp, { recursive: true, force: true });
}

done();
