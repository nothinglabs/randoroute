/* Page-side state-chain planning and partition-frontier retry coordination.
 *
 * This module contains no state names and no UI copy beyond the shared product
 * verdicts. It turns an ordered set of route points into a state plan, a
 * bounded initial partition corridor, and repeated loader/router worker calls
 * until no competitive unloaded frontier remains.
 */
(function (root) {
  'use strict';

  let contract = root.MultiStateRouting;
  let partitionRuntime = root.PartitionRouting;
  if (typeof require === 'function') {
    try { if (!contract) contract = require('./multi-state-routing.js').MultiStateRouting; } catch (e) { /* browser */ }
    try { if (!partitionRuntime) partitionRuntime = require('./partition-runtime.js').PartitionRouting; } catch (e) { /* browser */ }
  }
  if (!contract || !partitionRuntime) {
    throw new Error('multi-state-route-coordinator.js requires the multi-state contract and partition runtime');
  }

  class RouteCoordinatorError extends Error {
    constructor(code, message, detail = {}) {
      super(message);
      this.name = 'RouteCoordinatorError';
      this.code = code;
      this.detail = detail;
    }
  }

  function abortError() {
    if (typeof DOMException === 'function') return new DOMException('Route request was cancelled.', 'AbortError');
    const error = new Error('Route request was cancelled.');
    error.name = 'AbortError';
    return error;
  }

  function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
  function unique(values) { return [...new Set(values)]; }

  function stateAdjacencyFromCatalogue(catalogue) {
    contract.validatePartitionCatalogue(catalogue);
    const partitionState = new Map(catalogue.partitions.map((partition) =>
      [partition.id, partition.stateId]));
    const adjacency = new Map(catalogue.states.map((state) => [state.id, new Set()]));
    for (const portal of catalogue.portals) {
      const left = partitionState.get(portal.endpoints[0].partitionId);
      const right = partitionState.get(portal.endpoints[1].partitionId);
      if (left === right) continue;
      adjacency.get(left).add(right);
      adjacency.get(right).add(left);
    }
    return Object.fromEntries([...adjacency]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, neighbors]) => [id, [...neighbors].sort((a, b) => a.localeCompare(b))]));
  }

  function combineStateChains(base, addition) {
    const combined = [...base];
    for (const id of addition) if (!combined.includes(id)) combined.push(id);
    return combined;
  }

  function planRoutePointStates(options) {
    const input = options || {};
    const pointStateIds = Array.isArray(input.pointStateIds)
      ? input.pointStateIds.map(String) : [];
    if (pointStateIds.length < 2) {
      throw new RouteCoordinatorError('route-points', 'A route needs at least two state-resolved points.');
    }
    const availableStateIds = input.availableStateIds || [];
    const installedStateIds = input.installedStateIds || [];
    const maxRouteStates = input.maxRouteStates || contract.MAX_ROUTE_STATES;
    const stateAdjacency = input.stateAdjacency || {};
    let candidates = [[]];
    for (let index = 1; index < pointStateIds.length; index++) {
      const leg = contract.planRouteStates({
        availableStateIds, installedStateIds, stateAdjacency,
        startStateId: pointStateIds[index - 1], endStateId: pointStateIds[index],
        maxRouteStates: contract.MAX_ROUTE_STATES,
      });
      if (['unavailable', 'not-connected'].includes(leg.status)) {
        return Object.freeze({ ...leg, pointStateIds: Object.freeze([...pointStateIds]) });
      }
      const legChains = leg.candidateStateChains.length
        ? leg.candidateStateChains : [leg.routeStateIds];
      const next = [];
      for (const base of candidates) {
        for (const chain of legChains) {
          const combined = combineStateChains(base, chain);
          const key = combined.join('\0');
          if (!next.some((candidate) => candidate.join('\0') === key)) next.push(combined);
        }
      }
      candidates = next
        .sort((a, b) => a.length - b.length || a.join('\0').localeCompare(b.join('\0')))
        .slice(0, contract.MAX_STATE_CHAIN_CANDIDATES);
    }
    if (!candidates.length) {
      return Object.freeze({ status: 'not-connected', routeStateIds: Object.freeze([]),
        candidateStateChains: Object.freeze([]), requiredStateIds: Object.freeze([]),
        unavailableStateIds: Object.freeze([]), minimumStateCount: null,
        pointStateIds: Object.freeze([...pointStateIds]),
        message: 'These available maps do not provide a contiguous route between the route points.' });
    }
    const minimumStateCount = candidates[0].length;
    const frozenCandidates = Object.freeze(candidates.map((chain) => Object.freeze([...chain])));
    if (minimumStateCount > maxRouteStates) {
      return Object.freeze({ status: 'route-state-limit', routeStateIds: Object.freeze([]),
        candidateStateChains: frozenCandidates, requiredStateIds: Object.freeze([]),
        unavailableStateIds: Object.freeze([]), minimumStateCount,
        pointStateIds: Object.freeze([...pointStateIds]),
        message: contract.ROUTE_STATE_LIMIT_MESSAGE });
    }
    const installed = new Set(installedStateIds);
    candidates.sort((a, b) => {
      const missingA = a.filter((id) => !installed.has(id)).length;
      const missingB = b.filter((id) => !installed.has(id)).length;
      return missingA - missingB || a.length - b.length
        || a.join('\0').localeCompare(b.join('\0'));
    });
    const routeStateIds = Object.freeze([...candidates[0]]);
    const requiredStateIds = Object.freeze(routeStateIds.filter((id) => !installed.has(id)));
    return Object.freeze({
      status: requiredStateIds.length ? 'requires-install' : 'ready',
      routeStateIds,
      candidateStateChains: Object.freeze(candidates.map((chain) => Object.freeze([...chain]))),
      requiredStateIds,
      unavailableStateIds: Object.freeze([]),
      minimumStateCount,
      pointStateIds: Object.freeze([...pointStateIds]),
      message: requiredStateIds.length ? 'One or more maps are required for this trip.' : '',
    });
  }

  // The router snaps a route point to streets up to 2 km away, so the corridor
  // must load every same-state partition whose data could hold that street. A
  // point inside a sparse cell's bounds — the 873-node Columbia-shore sliver —
  // can be over 2 km from that cell's own streets while a neighbouring cell
  // holds the nearest road; without the margin the snap fails point-too-far
  // with no frontier hit, and nothing can widen the corridor.
  const POINT_SNAP_MARGIN_M = 2000;

  function pointInBounds(point, bounds, marginLonDeg = 0, marginLatDeg = 0) {
    return point[0] >= bounds.minLon - marginLonDeg && point[0] <= bounds.maxLon + marginLonDeg
      && point[1] >= bounds.minLat - marginLatDeg && point[1] <= bounds.maxLat + marginLatDeg;
  }

  function shortestPartitionPaths(catalogue, startIds, endIds, allowedStateIds, cap) {
    const byId = new Map(catalogue.partitions.map((partition) => [partition.id, partition]));
    const allowed = new Set(allowedStateIds);
    const targets = new Set(endIds);
    const distance = new Map();
    const queue = [];
    for (const id of [...startIds].sort((a, b) => a.localeCompare(b))) {
      distance.set(id, 0);
      queue.push(id);
    }
    let cursor = 0, targetDistance = Infinity;
    while (cursor < queue.length) {
      const id = queue[cursor++], d = distance.get(id);
      if (d > targetDistance) break;
      if (targets.has(id)) { targetDistance = d; continue; }
      for (const neighbor of byId.get(id).adjacentPartitionIds) {
        const partition = byId.get(neighbor);
        if (!partition || !allowed.has(partition.stateId) || distance.has(neighbor)) continue;
        distance.set(neighbor, d + 1);
        queue.push(neighbor);
      }
    }
    if (!Number.isFinite(targetDistance)) return [];
    const paths = [];
    const startSet = new Set(startIds);
    function walk(id, path) {
      if (paths.length >= cap) return;
      if (targets.has(id) && distance.get(id) === targetDistance) {
        paths.push(path);
        return;
      }
      const d = distance.get(id);
      for (const neighbor of byId.get(id).adjacentPartitionIds) {
        if (distance.get(neighbor) === d + 1 && distance.get(neighbor) <= targetDistance) {
          walk(neighbor, [...path, neighbor]);
        }
      }
    }
    for (const start of [...startSet].sort((a, b) => a.localeCompare(b))) walk(start, [start]);
    return paths;
  }

  function selectInitialPartitionCorridor(options) {
    const input = options || {};
    const catalogue = input.catalogue;
    contract.validatePartitionCatalogue(catalogue);
    const points = input.points || [];
    const pointStateIds = input.pointStateIds || [];
    const routeStateIds = input.routeStateIds || [];
    if (points.length < 2 || points.length !== pointStateIds.length) {
      throw new RouteCoordinatorError('route-points', 'Route points and their state identities do not match.');
    }
    const budgetBytes = input.budgetBytes || contract.MAX_DETAILED_GRAPH_INPUT_BYTES;
    const strictPartitionsAtPoint = points.map((point, index) => catalogue.partitions
      .filter((partition) => partition.stateId === pointStateIds[index]
        && pointInBounds(point, partition.bounds))
      .map((partition) => partition.id)
      .sort((a, b) => a.localeCompare(b)));
    const partitionsAtPoint = points.map((point, index) => {
      const marginLatDeg = POINT_SNAP_MARGIN_M / 111320;
      const marginLonDeg = POINT_SNAP_MARGIN_M
        / (111320 * Math.max(0.2, Math.cos(point[1] * Math.PI / 180)));
      return catalogue.partitions
        .filter((partition) => partition.stateId === pointStateIds[index]
          && pointInBounds(point, partition.bounds, marginLonDeg, marginLatDeg))
        .map((partition) => partition.id)
        .sort((a, b) => a.localeCompare(b));
    });
    const missingPoint = partitionsAtPoint.findIndex((ids) => !ids.length);
    if (missingPoint >= 0) {
      throw new RouteCoordinatorError('point-outside-partitions',
        `Route point ${missingPoint + 1} is outside the available detailed routing maps.`,
        { pointIndex: missingPoint, stateId: pointStateIds[missingPoint] });
    }
    const candidatePaths = [];
    for (let index = 1; index < partitionsAtPoint.length; index++) {
      const paths = shortestPartitionPaths(catalogue, partitionsAtPoint[index - 1],
        partitionsAtPoint[index], routeStateIds,
        input.maxCandidatePaths || contract.MAX_STATE_CHAIN_CANDIDATES);
      if (!paths.length) {
        throw new RouteCoordinatorError('partition-corridor-disconnected',
          'The installed detailed maps do not contain a connected corridor between the route points.',
          { legIndex: index - 1 });
      }
      candidatePaths.push(paths);
    }
    const byId = new Map(catalogue.partitions.map((partition) => [partition.id, partition]));
    const selected = new Set();
    const addPath = (path) => { for (const id of path) selected.add(id); };
    // A cell strictly containing a route point is endpoint-critical: the
    // shortest cell path reaches only one cell per point.
    for (const ids of strictPartitionsAtPoint) for (const id of ids) selected.add(id);
    for (const paths of candidatePaths) addPath(paths[0]);
    const selectedBytes = () => [...selected]
      .reduce((sum, id) => sum + byId.get(id).rawBytes, 0);
    if (selectedBytes() > budgetBytes) {
      throw new RouteCoordinatorError('graph-input-budget',
        'The detailed routing maps required for this trip do not fit this device’s routing-memory limit.',
        { rawInputBytes: selectedBytes(), budgetBytes, partitionIds: [...selected].sort() });
    }
    // A margin-admitted neighbour may hold the street the router snaps to —
    // the sparse Columbia-shore sliver's nearest road sits in the dense cell
    // 900 m south of its data boundary. These load whenever they fit; they
    // never turn a routable request into a budget error.
    for (const ids of partitionsAtPoint) {
      for (const id of ids) {
        if (selected.has(id)) continue;
        if (selectedBytes() + byId.get(id).rawBytes <= budgetBytes) selected.add(id);
      }
    }
    // Preserve equal-short coarse corridors when they fit. A corridor that
    // does not fit remains discoverable through the real A* frontier retries.
    for (const paths of candidatePaths) {
      for (const path of paths.slice(1)) {
        const additions = path.filter((id) => !selected.has(id));
        const addedBytes = additions.reduce((sum, id) => sum + byId.get(id).rawBytes, 0);
        if (selectedBytes() + addedBytes <= budgetBytes) addPath(path);
      }
    }
    return Object.freeze({
      partitionIds: Object.freeze([...selected].sort((a, b) => a.localeCompare(b))),
      rawInputBytes: selectedBytes(),
      candidatePaths: Object.freeze(candidatePaths.map((paths) =>
        Object.freeze(paths.map((path) => Object.freeze([...path]))))),
      pointPartitionIds: Object.freeze(partitionsAtPoint.map((ids) => Object.freeze([...ids]))),
    });
  }

  function routeDependencies(catalogue, routeStateIds, partitionIds, catalogueIdentity = null) {
    const states = new Map(catalogue.states.map((state) => [state.id, state]));
    const partitions = new Map(catalogue.partitions.map((partition) => [partition.id, partition]));
    const usedPartitions = unique(partitionIds || []).filter((id) => partitions.has(id));
    return Object.freeze({
      partitionCatalogueFormat: catalogue.partitionCatalogueFormat,
      graphFormat: catalogue.graphFormat,
      catalogueSha256: catalogueIdentity?.sha256 || null,
      cataloguePath: catalogueIdentity?.path || null,
      build: Object.freeze({
        builder: catalogue.build.builder,
        builderVersion: catalogue.build.builderVersion,
        algorithm: catalogue.build.algorithm,
        sourceDateEpoch: catalogue.build.sourceDateEpoch,
      }),
      states: Object.freeze(routeStateIds.map((id) => {
        const state = states.get(id);
        return Object.freeze({ stateId: id, graphVersion: state.graphVersion,
          sourceSha256: state.sourceSha256 });
      })),
      partitions: Object.freeze(usedPartitions.sort((a, b) => a.localeCompare(b)).map((id) => {
        const partition = partitions.get(id);
        return Object.freeze({ partitionId: id, stateId: partition.stateId,
          sourceGraphVersion: partition.sourceGraphVersion,
          sha256: partition.sha256 });
      })),
    });
  }

  class MultiStateRouteSession {
    constructor(options = {}) {
      contract.validatePartitionCatalogue(options.catalogue);
      if (typeof options.resolveStateId !== 'function'
          || typeof options.loadComposite !== 'function'
          || typeof options.search !== 'function') {
        throw new RouteCoordinatorError('configuration',
          'The route coordinator needs state resolution, partition loading, and routing adapters.');
      }
      this.catalogue = options.catalogue;
      this.catalogueIdentity = options.catalogueIdentity || null;
      this.resolveStateId = options.resolveStateId;
      this.loadComposite = options.loadComposite;
      this.search = options.search;
      this.selectInitialCorridor = options.selectInitialCorridor || selectInitialPartitionCorridor;
      this.cancelAdapters = options.cancel || (() => {});
      this.retainActiveRoute = options.retainActiveRoute || (() => {});
      this.onProgress = options.onProgress || (() => {});
      this.budgetBytes = options.budgetBytes || contract.MAX_DETAILED_GRAPH_INPUT_BYTES;
      this.installedStateIds = unique(options.installedStateIds || []);
      this.stateAdjacency = stateAdjacencyFromCatalogue(this.catalogue);
      this.generation = 0;
      this.controller = null;
      this.pendingRequest = null;
      this.lastDiagnostics = null;
    }

    setInstalledStateIds(ids) { this.installedStateIds = unique(ids || []); }

    cancel() {
      this.generation++;
      this.controller?.abort();
      this.controller = null;
      this.cancelAdapters();
    }

    async resumePending() {
      if (!this.pendingRequest) return null;
      const request = this.pendingRequest;
      return this.route(request);
    }

    async route(request) {
      this.controller?.abort();
      this.cancelAdapters();
      const generation = ++this.generation;
      const controller = new AbortController();
      this.controller = controller;
      const points = request.points || [request.start, request.end];
      const pointStateIds = request.pointStateIds || await Promise.all(points.map((point) =>
        this.resolveStateId(point)));
      checkAbort(controller.signal);
      if (pointStateIds.some((id) => !id)) {
        const result = { type: request.type, id: request.id, ok: false,
          code: 'state-unresolved', reason: 'A route point is outside the available maps.' };
        this.pendingRequest = null;
        return result;
      }
      const plan = planRoutePointStates({
        availableStateIds: this.catalogue.states.map((state) => state.id),
        installedStateIds: this.installedStateIds,
        stateAdjacency: this.stateAdjacency,
        pointStateIds,
      });
      if (plan.status !== 'ready') {
        const result = { type: request.type, id: request.id, ok: false,
          code: plan.status === 'requires-install' ? 'required-states' : plan.status,
          reason: plan.message, routeStateIds: [...plan.routeStateIds],
          requiredStateIds: [...plan.requiredStateIds],
          unavailableStateIds: [...plan.unavailableStateIds] };
        this.pendingRequest = plan.status === 'requires-install' ? { ...request, points } : null;
        return result;
      }
      this.pendingRequest = null;
      const corridor = this.selectInitialCorridor({
        catalogue: this.catalogue, points, pointStateIds,
        routeStateIds: plan.routeStateIds, budgetBytes: this.budgetBytes,
      });
      let loadedIds = [...corridor.partitionIds];
      const partitionById = new Map(this.catalogue.partitions.map((partition) =>
        [partition.id, partition]));
      const attempts = [];
      let lastSuccess = null;
      for (let retry = 0; retry <= this.catalogue.partitions.length; retry++) {
        checkAbort(controller.signal);
        this.onProgress({ generation, phase: retry ? 'expanding' : 'initial', retry,
          routeStateIds: [...plan.routeStateIds], partitionCount: loadedIds.length });
        const composite = await this.loadComposite({ generation,
          partitionIds: loadedIds, routeStateIds: [...plan.routeStateIds],
          budgetBytes: this.budgetBytes, signal: controller.signal });
        checkAbort(controller.signal);
        const result = await this.search({ generation, request,
          composite, signal: controller.signal });
        checkAbort(controller.signal);
        const frontierHits = Array.isArray(result.frontierHits) ? result.frontierHits : [];
        attempts.push({ retry, loadedPartitionIds: [...composite.loadedPartitionIds],
          frontierHitCount: frontierHits.length, ok: !!result.ok });
        const competitiveTimes = (Array.isArray(result.options) ? result.options : [result])
          .map((option) => Number(option?.timeS)).filter(Number.isFinite);
        // A success-driven expansion must pay for itself. Frontier lower
        // bounds are straight lines at the search's most optimistic speed, so
        // on a long trip nearly every portal in the composite stays formally
        // "competitive" and the byte budget becomes the only stop — Seattle to
        // Buckman re-ran a six-option portfolio five more times and pinned
        // 99.7% of the input ceiling without changing the lineup. When a
        // widened composite returns no better best time and no extra option,
        // take the result. Failed attempts keep widening: a disconnected
        // endpoint cell must expand until the network connects.
        const bestTime = competitiveTimes.length ? Math.min(...competitiveTimes) : Infinity;
        const optionCount = Array.isArray(result.options)
          ? result.options.length : (result.ok ? 1 : 0);
        const stalled = !!result.ok && !!lastSuccess
          && bestTime >= lastSuccess.bestTime * 0.99
          && optionCount <= lastSuccess.optionCount;
        if (result.ok) lastSuccess = { bestTime, optionCount };
        const expansionCandidates = partitionRuntime.selectFrontierExpansion({
          loadedPartitionIds: composite.loadedPartitionIds,
          frontiers: composite.frontiers,
          frontierHits,
          routeFound: !!result.ok,
          worstCompetitiveCost: competitiveTimes.length
            ? Math.max(...competitiveTimes) : Infinity,
          maxAdditions: this.catalogue.partitions.length,
        });
        let selectedBytes = [...new Set(composite.loadedPartitionIds)]
          .reduce((sum, id) => sum + (partitionById.get(id)?.rawBytes || 0), 0);
        const expansion = [];
        for (const frontier of expansionCandidates) {
          const partition = partitionById.get(frontier.adjacentPartitionId);
          if (!partition || selectedBytes + partition.rawBytes > this.budgetBytes) continue;
          expansion.push(frontier);
          selectedBytes += partition.rawBytes;
          if (expansion.length >= 2) break;
        }
        if (!expansion.length || stalled) {
          if (!result.ok && expansionCandidates.length) {
            throw new RouteCoordinatorError('graph-input-budget',
              'The detailed routing maps required for this trip do not fit this device’s routing-memory limit.',
              { rawInputBytes: selectedBytes, budgetBytes: this.budgetBytes,
                partitionIds: [...composite.loadedPartitionIds].sort() });
          }
          const final = { ...result, routeStateIds: [...plan.routeStateIds],
            pointStateIds: [...pointStateIds],
            loadedPartitionIds: [...composite.loadedPartitionIds],
            routeDependencies: routeDependencies(this.catalogue, plan.routeStateIds,
              result.partitionIds || [], this.catalogueIdentity),
            routingDiagnostics: { generation, attempts,
              partitionInput: composite.diagnostics || null } };
          this.lastDiagnostics = final.routingDiagnostics;
          if (final.ok) this.retainActiveRoute({ result: final, composite });
          if (generation === this.generation) this.controller = null;
          return final;
        }
        loadedIds = unique([...loadedIds,
          ...expansion.map((frontier) => frontier.adjacentPartitionId)]);
      }
      throw new RouteCoordinatorError('frontier-retry-limit',
        'Routing-map expansion did not stabilize.', { generation, attempts });
    }
  }

  function waitForWorker(worker, send, expected, onProgress, signal = null) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortError()); return; }
      const receive = (event) => {
        const message = event.data || {};
        if (message.type === 'progress' || message.type === 'partition-progress') {
          onProgress(message);
          return;
        }
        if (!expected(message)) return;
        cleanup();
        if (message.type === 'error' || message.type === 'partition-error') {
          const error = new RouteCoordinatorError(message.code || 'worker',
            message.message || 'Routing worker failed.', message.detail || {});
          reject(error);
        } else if (message.type === 'partition-cancelled') reject(abortError());
        else resolve(message);
      };
      const failed = (event) => { cleanup(); reject(new RouteCoordinatorError('worker',
        event.message || 'Routing worker stopped.')); };
      const aborted = () => { cleanup(); reject(abortError()); };
      const cleanup = () => {
        worker.removeEventListener('message', receive);
        worker.removeEventListener('error', failed);
        signal?.removeEventListener('abort', aborted);
      };
      worker.addEventListener('message', receive);
      worker.addEventListener('error', failed);
      signal?.addEventListener('abort', aborted, { once: true });
      send();
    });
  }

  class BrowserPartitionRouteBridge {
    constructor(options = {}) {
      this.catalogue = options.catalogue;
      this.baseUrl = options.baseUrl || root.location?.href || 'http://localhost/';
      this.budgetBytes = options.budgetBytes || contract.MAX_DETAILED_GRAPH_INPUT_BYTES;
      this.createWorker = options.createWorker || ((url) => new Worker(url));
      this.loaderUrl = options.loaderUrl || 'partition-loader-worker.js';
      this.routerUrl = options.routerUrl || 'router-worker.js';
      this.onProgress = options.onProgress || (() => {});
      this.constrained = !!options.constrained;
      this.loader = null;
      this.router = null;
      this.routerHasGraph = false;
      this.initialized = false;
      this.sequence = 0;
    }

    ensureWorkers() {
      if (!this.loader) this.loader = this.createWorker(this.loaderUrl);
      if (!this.router) {
        this.router = this.createWorker(this.routerUrl);
        // A phone's router runs with capped caches; the composite router
        // holds the same full-size graph as the home worker and must not
        // additionally retain the desktop cache complement.
        if (this.constrained) this.router.postMessage({ type: 'configure', constrained: true });
      }
    }

    async ensureInitialized(signal = null) {
      this.ensureWorkers();
      if (this.initialized) return;
      const id = `partition-init-${++this.sequence}`;
      await waitForWorker(this.loader,
        () => this.loader.postMessage({ type: 'init', id, catalogue: this.catalogue,
          baseUrl: this.baseUrl, budgetBytes: this.budgetBytes }),
        (message) => (message.id === id && ['partition-runtime-ready', 'partition-error'].includes(message.type)),
        this.onProgress, signal);
      this.initialized = true;
    }

    async loadComposite(request) {
      await this.ensureInitialized(request.signal);
      checkAbort(request.signal);
      // A widening retry replaces the whole composite. The router's copy of
      // the previous one (graph plus derived arrays) must not sit beside the
      // new composite while the loader composes it — on a phone that pairing
      // is a second full-size graph at the exact peak. A fresh worker starts
      // empty; a reused one frees the old arrays only after the new buffer
      // has already been built and transferred in.
      if (this.routerHasGraph) {
        this.router?.terminate();
        this.router = null;
        this.routerHasGraph = false;
        this.ensureWorkers();
      }
      const id = `partition-load-${request.generation}-${++this.sequence}`;
      const graph = await waitForWorker(this.loader,
        () => this.loader.postMessage({ type: 'load', id,
          partitionIds: request.partitionIds, routeStateIds: request.routeStateIds,
          budgetBytes: request.budgetBytes }),
        (message) => message.id === id && ['partition-graph', 'partition-error',
          'partition-cancelled'].includes(message.type), this.onProgress, request.signal);
      checkAbort(request.signal);
      const ready = await waitForWorker(this.router,
        () => this.router.postMessage({ type: 'graph', buffer: graph.buffer, partitioned: true,
          edgeStateIndexes: graph.edgeStateIndexes,
          edgePartitionIndexes: graph.edgePartitionIndexes,
          stateIds: graph.stateIds, loadedPartitionIds: graph.loadedPartitionIds,
          partitionRanges: graph.partitionRanges,
          diagnostics: graph.diagnostics },
        [graph.buffer, graph.edgeStateIndexes.buffer, graph.edgePartitionIndexes.buffer]),
        (message) => ['ready', 'error'].includes(message.type), this.onProgress, request.signal);
      this.routerHasGraph = true;
      const frontierId = `partition-frontiers-${request.generation}-${++this.sequence}`;
      await waitForWorker(this.router,
        () => this.router.postMessage({ type: 'partition-frontiers', id: frontierId,
          frontiers: graph.frontiers }),
        (message) => (message.id === frontierId && message.type === 'partition-frontiers-ready')
          || message.type === 'error', this.onProgress, request.signal);
      return { loadedPartitionIds: graph.loadedPartitionIds,
        stateIds: graph.stateIds, partitionRanges: graph.partitionRanges,
        frontiers: graph.frontiers, diagnostics: graph.diagnostics,
        memory: ready.memory };
    }

    async search({ request, signal }) {
      checkAbort(signal);
      return waitForWorker(this.router,
        () => this.router.postMessage(request),
        (message) => (message.id === request.id && message.type === request.type)
          || (message.type === 'error' && (message.id == null || message.id === request.id)),
        this.onProgress, signal);
    }

    retainActiveRoute({ result, composite }) {
      const used = new Set(result.partitionIds || []);
      if (used.size && this.loader) this.loader.postMessage({ type: 'active-route',
        id: `active-route-${++this.sequence}`, partitionIds: [...used] });
    }

    cancel() {
      this.loader?.terminate();
      this.router?.terminate();
      this.loader = null;
      this.router = null;
      this.routerHasGraph = false;
      this.initialized = false;
    }
  }

  root.MultiStateRouteCoordinator = Object.freeze({
    RouteCoordinatorError,
    stateAdjacencyFromCatalogue,
    planRoutePointStates,
    selectInitialPartitionCorridor,
    routeDependencies,
    MultiStateRouteSession,
    BrowserPartitionRouteBridge,
  });
}(typeof self !== 'undefined' ? self : this));
