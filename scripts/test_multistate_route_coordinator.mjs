#!/usr/bin/env node
// Exercise state-chain planning and frontier retries through the exported
// coordinator. Synthetic state names live only in this temporary test fixture.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, checkEqual, done, ROOT } from './testlib/harness.mjs';

const require = createRequire(import.meta.url);
const { MultiStateRouteCoordinator: C } = require(join(ROOT, 'multi-state-route-coordinator.js'));
const python = process.env.PYTHON || 'python3';
const fixture = join(ROOT, 'scripts/testlib/build_synthetic_partition_fixture.py');
const builder = join(ROOT, 'scripts/build_graph_partitions.py');
const temp = mkdtempSync(join(tmpdir(), 'randoroute-route-coordinator-'));

try {
  const maps = join(temp, 'maps'), output = join(temp, 'output');
  execFileSync(python, [fixture, maps, '--chain-length', '4'], { cwd: ROOT });
  const cataloguePath = join(output, 'partition-catalogue.json');
  const args = [builder, '--maps-root', maps, '--output-root', output,
    '--catalogue', cataloguePath];
  for (const id of ['state-a', 'state-b', 'state-c', 'state-d']) args.push('--state', id);
  execFileSync(python, args, { cwd: ROOT, stdio: 'pipe' });
  const catalogue = JSON.parse(readFileSync(cataloguePath, 'utf8'));
  const adjacency = C.stateAdjacencyFromCatalogue(catalogue);
  check('exact cross-state portals produce a generic symmetric state chain',
    JSON.stringify(adjacency) === JSON.stringify({
      'state-a': ['state-b'], 'state-b': ['state-a', 'state-c'],
      'state-c': ['state-b', 'state-d'], 'state-d': ['state-c'],
    }), JSON.stringify(adjacency));

  const missingTransit = C.planRoutePointStates({
    availableStateIds: Object.keys(adjacency), installedStateIds: ['state-a', 'state-c'],
    stateAdjacency: adjacency, pointStateIds: ['state-a', 'state-c'],
  });
  check('a three-state request identifies its uninstalled transit state',
    missingTransit.status === 'requires-install'
      && missingTransit.routeStateIds.join('|') === 'state-a|state-b|state-c'
      && missingTransit.requiredStateIds.join() === 'state-b',
    JSON.stringify(missingTransit));
  const waypointReturn = C.planRoutePointStates({
    availableStateIds: Object.keys(adjacency), installedStateIds: Object.keys(adjacency),
    stateAdjacency: adjacency, pointStateIds: ['state-a', 'state-b', 'state-a'],
  });
  check('ordered waypoint legs may revisit a state without inventing duplicate route-state IDs',
    waypointReturn.status === 'ready' && waypointReturn.routeStateIds.join('|') === 'state-a|state-b',
    JSON.stringify(waypointReturn));
  const fourthState = C.planRoutePointStates({
    availableStateIds: Object.keys(adjacency), installedStateIds: Object.keys(adjacency),
    stateAdjacency: adjacency, pointStateIds: ['state-a', 'state-d'],
  });
  check('a request involving a fourth contiguous state returns the product-limit copy',
    fourthState.status === 'route-state-limit'
      && fourthState.message === 'Routes may cross up to three states in this version.',
    JSON.stringify(fourthState));

  const pointState = ([lon]) => lon < -0.2 ? 'state-a'
    : lon < 1.8 ? 'state-b' : lon < 3.8 ? 'state-c' : 'state-d';
  const points = [[-1.9, 0], [3.7, 0]];
  const initial = C.selectInitialPartitionCorridor({ catalogue, points,
    pointStateIds: ['state-a', 'state-c'],
    routeStateIds: ['state-a', 'state-b', 'state-c'] });
  check('coarse planning selects a connected cross-state partition corridor',
    initial.partitionIds.length === 6 && initial.rawInputBytes > 0
      && initial.candidatePaths[0][0].length === 6,
    JSON.stringify(initial));

  const partitionById = new Map(catalogue.partitions.map((partition) => [partition.id, partition]));
  const endpointOnly = ({ points: routePoints, pointStateIds, budgetBytes }) => {
    const ids = routePoints.map((point, index) => catalogue.partitions.find((partition) =>
      partition.stateId === pointStateIds[index]
        && point[0] >= partition.bounds.minLon && point[0] <= partition.bounds.maxLon
        && point[1] >= partition.bounds.minLat && point[1] <= partition.bounds.maxLat).id);
    return { partitionIds: [...new Set(ids)].sort(), rawInputBytes: ids
      .reduce((sum, id) => sum + partitionById.get(id).rawBytes, 0),
      candidatePaths: [], pointPartitionIds: ids.map((id) => [id]), budgetBytes };
  };
  const portalsFor = (selectedIds, routeStateIds) => {
    const selected = new Set(selectedIds), routeStates = new Set(routeStateIds);
    let node = 0;
    return catalogue.portals.flatMap((portal) => {
      const loaded = portal.endpoints.filter((endpoint) => selected.has(endpoint.partitionId));
      if (loaded.length !== 1) return [];
      const adjacent = portal.endpoints.find((endpoint) => !selected.has(endpoint.partitionId));
      const partition = partitionById.get(adjacent.partitionId);
      if (!routeStates.has(partition.stateId)) return [];
      return [{ node: node++, portalId: portal.id,
        loadedPartitionId: loaded[0].partitionId,
        adjacentPartitionId: adjacent.partitionId,
        adjacentStateId: partition.stateId }];
    });
  };
  const isConnected = (selectedIds) => {
    const selected = new Set(selectedIds);
    const start = selectedIds.find((id) => partitionById.get(id).stateId === 'state-a');
    const target = selectedIds.find((id) => partitionById.get(id).stateId === 'state-c'
      && partitionById.get(id).bounds.maxLon > 3.7);
    const queue = start ? [start] : [], seen = new Set(queue);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      for (const next of partitionById.get(queue[cursor]).adjacentPartitionIds) {
        if (selected.has(next) && !seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    return !!target && seen.has(target);
  };
  const loads = [];
  const loadComposite = async ({ partitionIds, routeStateIds, signal }) => {
    if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
    loads.push([...partitionIds]);
    return { loadedPartitionIds: [...partitionIds], stateIds: routeStateIds,
      partitionRanges: [], diagnostics: { rawInputBytes: partitionIds.length },
      frontiers: portalsFor(partitionIds, routeStateIds) };
  };
  const search = async ({ request, composite }) => {
    const ok = isConnected(composite.loadedPartitionIds);
    return { type: request.type, id: request.id, ok,
      reason: ok ? '' : 'The loaded corridor is not connected yet.',
      partitionIds: ok ? [...composite.loadedPartitionIds] : [],
      frontierHits: ok ? [] : composite.frontiers.map((frontier, index) =>
        ({ node: frontier.node, lowerBound: 100 + index, exits: [frontier] })) };
  };
  const session = new C.MultiStateRouteSession({ catalogue,
    installedStateIds: ['state-a', 'state-c'], resolveStateId: pointState,
    selectInitialCorridor: endpointOnly, loadComposite, search });
  const request = { type: 'route-options', id: 17, points };
  const required = await session.route(request);
  check('the live session pauses the original request before loading when a transit map is missing',
    required.code === 'required-states' && required.requiredStateIds.join() === 'state-b'
      && loads.length === 0, JSON.stringify(required));
  session.setInstalledStateIds(['state-a', 'state-b', 'state-c']);
  const resumed = await session.resumePending();
  check('installing the transit map resumes the same request and widens to a stable route',
    resumed.ok && resumed.id === request.id && resumed.routeStateIds.join('|') === 'state-a|state-b|state-c'
      && resumed.routingDiagnostics.attempts.length > 1,
    JSON.stringify(resumed));
  check('frontier retries add detail without exceeding the route-state chain',
    resumed.loadedPartitionIds.every((id) =>
      ['state-a', 'state-b', 'state-c'].includes(partitionById.get(id).stateId))
      && loads.some((ids, index) => index && ids.length > loads[index - 1].length),
    JSON.stringify(loads));
  check('a stable result records every state and used partition version as saved-route dependencies',
    resumed.routeDependencies.states.map((entry) => entry.stateId).join('|')
      === 'state-a|state-b|state-c'
      && resumed.routeDependencies.states.every((entry) => entry.graphVersion && entry.sourceSha256)
      && resumed.routeDependencies.partitions.length === resumed.partitionIds.length,
    JSON.stringify(resumed.routeDependencies));

  const boundedLoads = [];
  const boundedSession = new C.MultiStateRouteSession({ catalogue,
    installedStateIds: ['state-a', 'state-b', 'state-c'], resolveStateId: pointState,
    selectInitialCorridor: endpointOnly,
    loadComposite: async ({ partitionIds, routeStateIds }) => {
      boundedLoads.push([...partitionIds]);
      return { loadedPartitionIds: [...partitionIds], stateIds: routeStateIds,
        partitionRanges: [], diagnostics: {}, frontiers: portalsFor(partitionIds, routeStateIds) };
    },
    search: async ({ request: active, composite }) => ({ type: active.type, id: active.id,
      ok: true, options: [{ ok: true, timeS: 45 }, { ok: true, timeS: 60 }],
      partitionIds: [...composite.loadedPartitionIds],
      frontierHits: composite.frontiers.map((frontier) =>
        ({ node: frontier.node, lowerBound: 90, exits: [frontier] })) }),
  });
  const bounded = await boundedSession.route({ type: 'route-options', id: 18, points,
    pointStateIds: ['state-a', 'state-c'] });
  check('a working portfolio does not load frontiers too costly to improve its choices',
    bounded.ok && bounded.options.length === 2 && boundedLoads.length === 1
      && bounded.routingDiagnostics.attempts.length === 1,
    JSON.stringify({ bounded, boundedLoads }));

  // Optimistic straight-line lower bounds keep every frontier formally
  // competitive on a long trip, so hit filtering alone cannot end the loop.
  // A widening retry that returns the same portfolio must finalize instead of
  // expanding again; only a materially better attempt keeps the retries going.
  const stallLoads = [];
  const stallSession = new C.MultiStateRouteSession({ catalogue,
    installedStateIds: ['state-a', 'state-b', 'state-c'], resolveStateId: pointState,
    selectInitialCorridor: endpointOnly,
    loadComposite: async ({ partitionIds, routeStateIds }) => {
      stallLoads.push([...partitionIds]);
      return { loadedPartitionIds: [...partitionIds], stateIds: routeStateIds,
        partitionRanges: [], diagnostics: {}, frontiers: portalsFor(partitionIds, routeStateIds) };
    },
    search: async ({ request: active, composite }) => ({ type: active.type, id: active.id,
      ok: true, options: [{ ok: true, timeS: 45 }, { ok: true, timeS: 60 }],
      partitionIds: [...composite.loadedPartitionIds],
      frontierHits: composite.frontiers.map((frontier) =>
        ({ node: frontier.node, lowerBound: 5, exits: [frontier] })) }),
  });
  const stalled = await stallSession.route({ type: 'route-options', id: 19, points,
    pointStateIds: ['state-a', 'state-c'] });
  check('an expansion that does not improve the portfolio finalizes instead of widening again',
    stalled.ok && stalled.options.length === 2 && stallLoads.length === 2
      && stallLoads[1].length > stallLoads[0].length
      && stalled.routingDiagnostics.attempts.length === 2,
    JSON.stringify({ attempts: stalled.routingDiagnostics.attempts, stallLoads }));

  const improveLoads = [];
  const improveSession = new C.MultiStateRouteSession({ catalogue,
    installedStateIds: ['state-a', 'state-b', 'state-c'], resolveStateId: pointState,
    selectInitialCorridor: endpointOnly,
    loadComposite: async ({ partitionIds, routeStateIds }) => {
      improveLoads.push([...partitionIds]);
      return { loadedPartitionIds: [...partitionIds], stateIds: routeStateIds,
        partitionRanges: [], diagnostics: {}, frontiers: portalsFor(partitionIds, routeStateIds) };
    },
    search: async ({ request: active, composite }) => ({ type: active.type, id: active.id,
      ok: true,
      options: [{ ok: true, timeS: improveLoads.length === 1 ? 45 : 30 }],
      partitionIds: [...composite.loadedPartitionIds],
      frontierHits: composite.frontiers.map((frontier) =>
        ({ node: frontier.node, lowerBound: 5, exits: [frontier] })) }),
  });
  const improved = await improveSession.route({ type: 'route-options', id: 20, points,
    pointStateIds: ['state-a', 'state-c'] });
  check('a materially better widened portfolio keeps expanding until it stabilizes',
    improved.ok && improved.routingDiagnostics.attempts.length === 3
      && improveLoads.length === 3,
    JSON.stringify({ attempts: improved.routingDiagnostics.attempts }));

  let slowStarted;
  const slowReady = new Promise((resolve) => { slowStarted = resolve; });
  const cancelledSession = new C.MultiStateRouteSession({ catalogue,
    installedStateIds: ['state-a', 'state-b'], resolveStateId: pointState,
    selectInitialCorridor: endpointOnly,
    loadComposite: ({ generation, partitionIds, routeStateIds, signal }) => {
      if (generation !== 1) return Promise.resolve({ loadedPartitionIds: partitionIds,
        stateIds: routeStateIds, partitionRanges: [], diagnostics: {}, frontiers: [] });
      slowStarted();
      return new Promise((resolve, reject) => signal.addEventListener('abort',
        () => reject(new DOMException('cancelled', 'AbortError')), { once: true }));
    },
    search: ({ request: active }) => Promise.resolve({ type: active.type, id: active.id,
      ok: true, frontierHits: [] }),
  });
  const obsolete = cancelledSession.route({ type: 'route', id: 1,
    points: [[-1.9, 0], [1.7, 0]] }).then(() => null, (error) => error);
  await slowReady;
  const current = cancelledSession.route({ type: 'route', id: 2,
    points: [[-1.8, 0], [1.6, 0]] });
  const obsoleteError = await obsolete;
  const currentResult = await current;
  check('changing endpoints cancels the obsolete loading generation',
    obsoleteError?.name === 'AbortError' && currentResult.ok && currentResult.id === 2,
    `${obsoleteError?.name}; ${JSON.stringify(currentResult)}`);

  class FakeWorker {
    constructor(kind) { this.kind = kind; this.listeners = { message: new Set(), error: new Set() }; }
    addEventListener(type, listener) { this.listeners[type].add(listener); }
    removeEventListener(type, listener) { this.listeners[type].delete(listener); }
    emit(data) { queueMicrotask(() => {
      for (const listener of this.listeners.message) listener({ data });
    }); }
    postMessage(message, transfer = []) {
      if (this.kind === 'loader' && message.type === 'init') {
        this.emit({ type: 'partition-runtime-ready', id: message.id });
      } else if (this.kind === 'loader' && message.type === 'load') {
        this.emit({ type: 'partition-graph', id: message.id,
          buffer: new ArrayBuffer(32), edgeStateIndexes: new Uint16Array(2),
          edgePartitionIndexes: new Uint16Array(2), stateIds: ['state-a', 'state-b'],
          loadedPartitionIds: ['left', 'right'], partitionRanges: [], frontiers: [],
          diagnostics: { rawInputBytes: 32 } });
      } else if (this.kind === 'router' && message.type === 'graph') {
        this.graphTransferCount = transfer.length;
        this.emit({ type: 'ready', nodes: 3, edges: 2, memory: { measuredBytes: 64 } });
      } else if (this.kind === 'router' && message.type === 'partition-frontiers') {
        this.emit({ type: 'partition-frontiers-ready', id: message.id, nodes: 0 });
      } else if (this.kind === 'router' && message.type === 'route') {
        this.emit({ type: 'route', id: message.id, ok: true, frontierHits: [] });
      }
      this.lastTransferCount = transfer.length;
    }
    terminate() { this.terminated = true; }
  }
  const workers = [];
  const bridge = new C.BrowserPartitionRouteBridge({ catalogue,
    createWorker: (url) => {
      const worker = new FakeWorker(url.includes('loader') ? 'loader' : 'router');
      workers.push(worker);
      return worker;
    } });
  const bridgedGraph = await bridge.loadComposite({ generation: 1,
    partitionIds: catalogue.states[0].partitionIds,
    routeStateIds: ['state-a'], signal: new AbortController().signal });
  const bridgedRoute = await bridge.search({ request: { type: 'route', id: 44 },
    signal: new AbortController().signal });
  check('the browser bridge initializes both workers and transfers a composite before routing',
    bridgedGraph.loadedPartitionIds.join('|') === 'left|right' && bridgedRoute.ok
      && workers.length === 2 && workers[1].graphTransferCount === 3,
    JSON.stringify({ bridgedGraph, bridgedRoute, workers: workers.length }));

  // An identical request set reuses the resident composite: no new workers,
  // no second compose. A different set replaces the router worker outright so
  // the retiring composite never sits beside the one being composed.
  const reused = await bridge.loadComposite({ generation: 2,
    partitionIds: catalogue.states[0].partitionIds,
    routeStateIds: ['state-a'], signal: new AbortController().signal });
  const reusedWorkerCount = workers.length;
  const widened = await bridge.loadComposite({ generation: 3,
    partitionIds: [...catalogue.states[0].partitionIds,
      ...catalogue.states[1].partitionIds],
    routeStateIds: ['state-a', 'state-b'], signal: new AbortController().signal });
  check('an unchanged corridor reuses the resident composite without recomposing',
    reused === bridgedGraph && reusedWorkerCount === 2,
    JSON.stringify({ reusedWorkerCount, same: reused === bridgedGraph }));
  check('a widened corridor replaces the router worker before composing',
    widened.loadedPartitionIds.length >= 2 && workers.length === 3
      && workers[1].terminated === true,
    JSON.stringify({ workers: workers.length, retired: workers[1].terminated }));
} finally {
  rmSync(temp, { recursive: true, force: true });
}

done();
