/* State-chain planning and partition-catalogue contracts for multi-state routing.
 *
 * This file contains no state names and no browser UI. It is the small shared
 * decision layer used by the page, worker, build tooling and executable tests:
 * which installed states a trip needs, what a partition catalogue is allowed
 * to claim, and which kinds of runtime state must remain independent.
 *
 * Loaded as a classic script in browsers. In Node the IIFE's `this` is
 * module.exports, so tests and builders can require() it without a second
 * implementation.
 */
(function (root) {
  'use strict';

  const MULTI_STATE_CONTRACT_VERSION = 1;
  const PARTITION_CATALOGUE_FORMAT = 1;
  const MAX_ROUTE_STATES = 3;
  const MAX_STATE_CHAIN_CANDIDATES = 8;
  // Baseline measured from the largest released BGRC graph (Washington,
  // 2026-08-26 rebuild). This is an input-byte ceiling, not a claim about
  // peak process memory. A Washington rebuild that grows the graph must move
  // this with it, or homeGraphExceedsDeviceBudget() silently switches the
  // whole state off the monolithic home worker — routing.ready never turns
  // true on web, and every in-state trip pays the partition session.
  const MAX_DETAILED_GRAPH_INPUT_BYTES = 149082781;
  const ROUTE_STATE_LIMIT_MESSAGE = 'Routes may cross up to three states in this version.';

  const SAFE_ID = /^[a-z0-9][a-z0-9._/-]{0,191}$/;
  const SAFE_STATE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
  const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
  const SHA256 = /^[a-f0-9]{64}$/;

  function fail(message) { throw new Error(`multi-state contract: ${message}`); }

  function assertObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is not an object`);
    return value;
  }

  function assertKnownKeys(value, known, label) {
    for (const key of Object.keys(value)) {
      if (!known.includes(key)) fail(`${label} has unknown key "${key}"`);
    }
  }

  function assertRequiredKeys(value, required, label) {
    for (const key of required) {
      if (value[key] === undefined) fail(`${label} omits "${key}"`);
    }
  }

  function stateId(value, label = 'state id') {
    const id = String(value || '');
    if (!SAFE_STATE_ID.test(id)) fail(`${label} "${id}" is unsafe`);
    return id;
  }

  function idList(values, label, pattern = SAFE_STATE_ID) {
    if (!Array.isArray(values)) fail(`${label} is not an array`);
    const out = [];
    const seen = new Set();
    for (const raw of values) {
      const value = String(raw || '');
      if (!pattern.test(value)) fail(`${label} contains unsafe id "${value}"`);
      if (seen.has(value)) fail(`${label} repeats "${value}"`);
      seen.add(value);
      out.push(value);
    }
    return out;
  }

  function sortedUnique(values) {
    return [...new Set(values)].sort((a, b) => a.localeCompare(b));
  }

  function assertSorted(values, label) {
    const sorted = [...values].sort((a, b) => a.localeCompare(b));
    if (values.some((value, i) => value !== sorted[i])) fail(`${label} is not sorted`);
  }

  function positiveInteger(value, label, { allowZero = false } = {}) {
    if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
      fail(`${label} is not a ${allowZero ? 'non-negative' : 'positive'} integer`);
    }
    return value;
  }

  function normalizeAdjacency(adjacency, availableStateIds) {
    assertObject(adjacency, 'state adjacency');
    const available = new Set(idList(availableStateIds, 'availableStateIds'));
    const result = new Map();
    for (const id of available) result.set(id, []);
    for (const [rawId, rawNeighbors] of Object.entries(adjacency)) {
      const id = stateId(rawId, 'state adjacency key');
      if (!available.has(id)) fail(`state adjacency names unavailable state "${id}"`);
      const neighbors = idList(rawNeighbors, `state adjacency for "${id}"`);
      for (const neighbor of neighbors) {
        if (!available.has(neighbor)) fail(`state adjacency names unavailable state "${neighbor}"`);
        if (neighbor === id) fail(`state adjacency for "${id}" contains itself`);
      }
      result.set(id, [...neighbors].sort((a, b) => a.localeCompare(b)));
    }
    for (const [id, neighbors] of result) {
      for (const neighbor of neighbors) {
        if (!(result.get(neighbor) || []).includes(id)) {
          fail(`state adjacency is not symmetric between "${id}" and "${neighbor}"`);
        }
      }
    }
    return result;
  }

  function shortestStateChains(start, end, adjacency, cap) {
    if (start === end) return [[start]];
    const distance = new Map([[start, 0]]);
    const queue = [start];
    let cursor = 0;
    while (cursor < queue.length) {
      const id = queue[cursor++];
      const nextDistance = distance.get(id) + 1;
      if (distance.has(end) && nextDistance > distance.get(end)) continue;
      for (const neighbor of adjacency.get(id) || []) {
        if (!distance.has(neighbor)) {
          distance.set(neighbor, nextDistance);
          queue.push(neighbor);
        }
      }
    }
    if (!distance.has(end)) return [];
    const paths = [];
    // Build forward paths explicitly; the recursive accumulator above stays
    // bounded by the number of states and the product-level candidate cap.
    function forward(id, path) {
      if (paths.length >= cap) return;
      if (id === end) { paths.push(path); return; }
      const d = distance.get(id);
      for (const neighbor of adjacency.get(id) || []) {
        if (distance.get(neighbor) === d + 1 && distance.get(neighbor) <= distance.get(end)) {
          forward(neighbor, [...path, neighbor]);
        }
      }
    }
    paths.length = 0;
    forward(start, [start]);
    return paths;
  }

  function planRouteStates(options) {
    const input = assertObject(options, 'route-state request');
    const availableStateIds = idList(input.availableStateIds, 'availableStateIds');
    const installedStateIds = idList(input.installedStateIds, 'installedStateIds');
    const available = new Set(availableStateIds);
    for (const id of installedStateIds) {
      if (!available.has(id)) fail(`installed state "${id}" is not available`);
    }
    const startStateId = stateId(input.startStateId, 'startStateId');
    const endStateId = stateId(input.endStateId, 'endStateId');
    const maxRouteStates = input.maxRouteStates === undefined
      ? MAX_ROUTE_STATES : positiveInteger(input.maxRouteStates, 'maxRouteStates');
    if (maxRouteStates > MAX_ROUTE_STATES) {
      fail(`maxRouteStates cannot exceed the version limit of ${MAX_ROUTE_STATES}`);
    }
    if (!available.has(startStateId) || !available.has(endStateId)) {
      const unavailableStateIds = [startStateId, endStateId].filter((id) => !available.has(id));
      return Object.freeze({
        status: 'unavailable', routeStateIds: Object.freeze([]),
        candidateStateChains: Object.freeze([]), requiredStateIds: Object.freeze([]),
        unavailableStateIds: Object.freeze(sortedUnique(unavailableStateIds)),
        minimumStateCount: null,
        message: 'A map required for this trip is not currently offered.',
      });
    }
    const adjacency = normalizeAdjacency(input.stateAdjacency || {}, availableStateIds);
    const chains = shortestStateChains(startStateId, endStateId, adjacency,
      input.maxCandidateChains === undefined ? MAX_STATE_CHAIN_CANDIDATES
        : positiveInteger(input.maxCandidateChains, 'maxCandidateChains'));
    if (!chains.length) {
      return Object.freeze({
        status: 'not-connected', routeStateIds: Object.freeze([]),
        candidateStateChains: Object.freeze([]), requiredStateIds: Object.freeze([]),
        unavailableStateIds: Object.freeze([]), minimumStateCount: null,
        message: 'These available maps do not provide a contiguous route between the endpoints.',
      });
    }
    const minimumStateCount = chains[0].length;
    const frozenChains = Object.freeze(chains.map((chain) => Object.freeze([...chain])));
    if (minimumStateCount > maxRouteStates) {
      return Object.freeze({
        status: 'route-state-limit', routeStateIds: Object.freeze([]),
        candidateStateChains: frozenChains, requiredStateIds: Object.freeze([]),
        unavailableStateIds: Object.freeze([]), minimumStateCount,
        message: ROUTE_STATE_LIMIT_MESSAGE,
      });
    }
    const installed = new Set(installedStateIds);
    chains.sort((a, b) => {
      const missingA = a.filter((id) => !installed.has(id)).length;
      const missingB = b.filter((id) => !installed.has(id)).length;
      return missingA - missingB || a.join('\0').localeCompare(b.join('\0'));
    });
    const routeStateIds = Object.freeze([...chains[0]]);
    const requiredStateIds = Object.freeze(routeStateIds.filter((id) => !installed.has(id)));
    return Object.freeze({
      status: requiredStateIds.length ? 'requires-install' : 'ready',
      routeStateIds,
      candidateStateChains: Object.freeze(chains.map((chain) => Object.freeze([...chain]))),
      requiredStateIds,
      unavailableStateIds: Object.freeze([]), minimumStateCount,
      message: requiredStateIds.length ? 'One or more maps are required for this trip.' : '',
    });
  }

  function createRoutingRuntimeState(options) {
    const input = assertObject(options, 'routing runtime state');
    const availableStateIds = idList(input.availableStateIds || [], 'availableStateIds');
    const installedStateIds = idList(input.installedStateIds || [], 'installedStateIds');
    const routeStateIds = idList(input.routeStateIds || [], 'routeStateIds');
    const visibleSourceIds = idList(input.visibleSourceIds || [], 'visibleSourceIds', SAFE_ID);
    const available = new Set(availableStateIds);
    const installed = new Set(installedStateIds);
    for (const id of installedStateIds) if (!available.has(id)) fail(`installed state "${id}" is not available`);
    for (const id of routeStateIds) if (!available.has(id)) fail(`route state "${id}" is not available`);
    if (routeStateIds.length > MAX_ROUTE_STATES) fail(ROUTE_STATE_LIMIT_MESSAGE);
    const homeStateId = input.homeStateId == null ? null : stateId(input.homeStateId, 'homeStateId');
    const currentStateId = input.currentStateId == null ? null : stateId(input.currentStateId, 'currentStateId');
    if (homeStateId && !installed.has(homeStateId)) fail(`home state "${homeStateId}" is not installed`);
    const missingRouteStateIds = routeStateIds.filter((id) => !installed.has(id));

    if (!Array.isArray(input.loadedPartitions)) fail('loadedPartitions is not an array');
    const partitionIds = new Set();
    let loadedGraphInputBytes = 0;
    const loadedPartitions = input.loadedPartitions.map((raw, index) => {
      const partition = assertObject(raw, `loadedPartitions[${index}]`);
      assertKnownKeys(partition, ['id', 'stateId', 'rawBytes', 'retainedForActiveRoute'],
        `loadedPartitions[${index}]`);
      assertRequiredKeys(partition, ['id', 'stateId', 'rawBytes'], `loadedPartitions[${index}]`);
      const id = String(partition.id || '');
      if (!SAFE_ID.test(id)) fail(`loaded partition id "${id}" is unsafe`);
      if (partitionIds.has(id)) fail(`loadedPartitions repeats "${id}"`);
      partitionIds.add(id);
      const ownerStateId = stateId(partition.stateId, `loaded partition "${id}" stateId`);
      if (!installed.has(ownerStateId)) fail(`loaded partition "${id}" belongs to uninstalled state "${ownerStateId}"`);
      const rawBytes = positiveInteger(partition.rawBytes, `loaded partition "${id}" rawBytes`);
      loadedGraphInputBytes += rawBytes;
      return Object.freeze({ id, stateId: ownerStateId, rawBytes,
        retainedForActiveRoute: !!partition.retainedForActiveRoute });
    });
    const graphInputBudgetBytes = input.graphInputBudgetBytes === undefined
      ? MAX_DETAILED_GRAPH_INPUT_BYTES
      : positiveInteger(input.graphInputBudgetBytes, 'graphInputBudgetBytes');
    if (loadedGraphInputBytes > graphInputBudgetBytes) {
      fail(`loaded detailed graph input ${loadedGraphInputBytes} exceeds budget ${graphInputBudgetBytes}`);
    }
    return Object.freeze({
      availableStateIds: Object.freeze([...availableStateIds]),
      installedStateIds: Object.freeze([...installedStateIds]),
      homeStateId, currentStateId,
      routeStateIds: Object.freeze([...routeStateIds]),
      missingRouteStateIds: Object.freeze(missingRouteStateIds),
      loadedPartitionIds: Object.freeze(loadedPartitions.map((partition) => partition.id)),
      loadedPartitions: Object.freeze(loadedPartitions),
      loadedGraphInputBytes, graphInputBudgetBytes,
      visibleSourceIds: Object.freeze([...visibleSourceIds]),
    });
  }

  function validateBounds(bounds, label) {
    assertObject(bounds, label);
    assertKnownKeys(bounds, ['minLon', 'minLat', 'maxLon', 'maxLat'], label);
    assertRequiredKeys(bounds, ['minLon', 'minLat', 'maxLon', 'maxLat'], label);
    for (const key of ['minLon', 'minLat', 'maxLon', 'maxLat']) {
      if (!Number.isFinite(bounds[key])) fail(`${label}.${key} is not finite`);
    }
    if (bounds.minLon < -180 || bounds.maxLon > 180
        || bounds.minLat < -90 || bounds.maxLat > 90) fail(`${label} is outside WGS84 longitude/latitude ranges`);
    if (bounds.minLon > bounds.maxLon || bounds.minLat > bounds.maxLat) fail(`${label} is inverted`);
  }

  function validatePartitionCatalogue(value) {
    const catalogue = assertObject(value, 'partition catalogue');
    const topKeys = ['partitionCatalogueFormat', 'graphFormat', 'build', 'states', 'partitions', 'portals'];
    assertKnownKeys(catalogue, topKeys, 'partition catalogue');
    assertRequiredKeys(catalogue, topKeys, 'partition catalogue');
    if (catalogue.partitionCatalogueFormat !== PARTITION_CATALOGUE_FORMAT) {
      fail(`unsupported partition catalogue format "${catalogue.partitionCatalogueFormat}"`);
    }
    if (typeof catalogue.graphFormat !== 'string' || !catalogue.graphFormat) fail('graphFormat is empty');
    const build = assertObject(catalogue.build, 'partition catalogue build');
    assertKnownKeys(build, ['builder', 'builderVersion', 'algorithm', 'sourceDateEpoch', 'sourceGraphs'],
      'partition catalogue build');
    assertRequiredKeys(build, ['builder', 'builderVersion', 'algorithm', 'sourceDateEpoch', 'sourceGraphs'],
      'partition catalogue build');
    if (typeof build.builder !== 'string' || !build.builder) fail('build.builder is empty');
    positiveInteger(build.builderVersion, 'build.builderVersion');
    if (typeof build.algorithm !== 'string' || !build.algorithm) fail('build.algorithm is empty');
    positiveInteger(build.sourceDateEpoch, 'build.sourceDateEpoch', { allowZero: true });
    if (!Array.isArray(build.sourceGraphs)) fail('build.sourceGraphs is not an array');

    if (!Array.isArray(catalogue.states) || !catalogue.states.length) fail('states is empty');
    if (!Array.isArray(catalogue.partitions) || !catalogue.partitions.length) fail('partitions is empty');
    if (!Array.isArray(catalogue.portals)) fail('portals is not an array');

    const states = new Map();
    const stateOrder = [];
    for (const raw of catalogue.states) {
      const state = assertObject(raw, 'catalogue state');
      const keys = ['id', 'graphVersion', 'sourcePath', 'sourceSha256', 'sourceCompressedBytes',
        'sourceRawBytes', 'partitionIds'];
      assertKnownKeys(state, keys, `catalogue state "${state.id}"`);
      assertRequiredKeys(state, keys, `catalogue state "${state.id}"`);
      const id = stateId(state.id, 'catalogue state id');
      if (states.has(id)) fail(`states repeats "${id}"`);
      if (typeof state.graphVersion !== 'string' || !state.graphVersion) fail(`state "${id}" graphVersion is empty`);
      if (!SAFE_PATH.test(String(state.sourcePath || '')) || String(state.sourcePath).includes('..')) {
        fail(`state "${id}" sourcePath is unsafe`);
      }
      if (!SHA256.test(String(state.sourceSha256 || ''))) fail(`state "${id}" sourceSha256 is invalid`);
      positiveInteger(state.sourceCompressedBytes, `state "${id}" sourceCompressedBytes`);
      positiveInteger(state.sourceRawBytes, `state "${id}" sourceRawBytes`);
      const partitionIds = idList(state.partitionIds, `state "${id}" partitionIds`, SAFE_ID);
      assertSorted(partitionIds, `state "${id}" partitionIds`);
      states.set(id, { ...state, partitionIds });
      stateOrder.push(id);
    }
    assertSorted(stateOrder, 'states');

    const sourceGraphStates = [];
    for (const raw of build.sourceGraphs) {
      const source = assertObject(raw, 'build source graph');
      assertKnownKeys(source, ['stateId', 'graphVersion', 'sha256'], 'build source graph');
      assertRequiredKeys(source, ['stateId', 'graphVersion', 'sha256'], 'build source graph');
      const id = stateId(source.stateId, 'build source graph stateId');
      const state = states.get(id);
      if (!state) fail(`build source graph names unknown state "${id}"`);
      if (source.graphVersion !== state.graphVersion || source.sha256 !== state.sourceSha256) {
        fail(`build source graph for "${id}" disagrees with its state entry`);
      }
      sourceGraphStates.push(id);
    }
    assertSorted(sourceGraphStates, 'build.sourceGraphs');
    if (sourceGraphStates.join('\0') !== stateOrder.join('\0')) fail('build.sourceGraphs does not cover states exactly');

    const partitions = new Map();
    const partitionOrder = [];
    for (const raw of catalogue.partitions) {
      const partition = assertObject(raw, 'partition');
      const keys = ['id', 'stateId', 'path', 'bounds', 'nodeCount', 'edgeCount', 'compressedBytes',
        'directedArcCount', 'geometryPointCount', 'nameCount', 'nameBytes',
        'embeddedGraphBytes', 'rawBytes', 'sha256', 'sourceGraphVersion', 'graphFormat',
        'adjacentPartitionIds'];
      assertKnownKeys(partition, keys, `partition "${partition.id}"`);
      assertRequiredKeys(partition, keys, `partition "${partition.id}"`);
      const id = String(partition.id || '');
      if (!SAFE_ID.test(id) || id.includes('..')) fail(`partition id "${id}" is unsafe`);
      if (partitions.has(id)) fail(`partitions repeats "${id}"`);
      const owner = states.get(stateId(partition.stateId, `partition "${id}" stateId`));
      if (!owner) fail(`partition "${id}" names unknown state "${partition.stateId}"`);
      if (!SAFE_PATH.test(String(partition.path || '')) || String(partition.path).includes('..')) {
        fail(`partition "${id}" path is unsafe`);
      }
      validateBounds(partition.bounds, `partition "${id}" bounds`);
      positiveInteger(partition.nodeCount, `partition "${id}" nodeCount`);
      positiveInteger(partition.edgeCount, `partition "${id}" edgeCount`, { allowZero: true });
      positiveInteger(partition.directedArcCount, `partition "${id}" directedArcCount`, { allowZero: true });
      positiveInteger(partition.geometryPointCount, `partition "${id}" geometryPointCount`);
      positiveInteger(partition.nameCount, `partition "${id}" nameCount`);
      positiveInteger(partition.nameBytes, `partition "${id}" nameBytes`, { allowZero: true });
      positiveInteger(partition.embeddedGraphBytes, `partition "${id}" embeddedGraphBytes`);
      positiveInteger(partition.compressedBytes, `partition "${id}" compressedBytes`);
      positiveInteger(partition.rawBytes, `partition "${id}" rawBytes`);
      if (!SHA256.test(String(partition.sha256 || ''))) fail(`partition "${id}" sha256 is invalid`);
      if (partition.sourceGraphVersion !== owner.graphVersion) {
        fail(`partition "${id}" sourceGraphVersion disagrees with state "${owner.id}"`);
      }
      if (partition.graphFormat !== catalogue.graphFormat) fail(`partition "${id}" graphFormat disagrees with catalogue`);
      const adjacentPartitionIds = idList(partition.adjacentPartitionIds,
        `partition "${id}" adjacentPartitionIds`, SAFE_ID);
      assertSorted(adjacentPartitionIds, `partition "${id}" adjacentPartitionIds`);
      if (adjacentPartitionIds.includes(id)) fail(`partition "${id}" is adjacent to itself`);
      partitions.set(id, { ...partition, adjacentPartitionIds });
      partitionOrder.push(id);
    }
    assertSorted(partitionOrder, 'partitions');

    for (const [id, partition] of partitions) {
      for (const neighbor of partition.adjacentPartitionIds) {
        const adjacent = partitions.get(neighbor);
        if (!adjacent) fail(`partition "${id}" names unknown adjacent partition "${neighbor}"`);
        if (!adjacent.adjacentPartitionIds.includes(id)) {
          fail(`partition adjacency is not symmetric between "${id}" and "${neighbor}"`);
        }
      }
    }
    for (const [id, state] of states) {
      const owned = partitionOrder.filter((partitionId) => partitions.get(partitionId).stateId === id);
      if (state.partitionIds.join('\0') !== owned.join('\0')) fail(`state "${id}" partitionIds does not match owned partitions`);
    }

    const portalOrder = [];
    const portalIds = new Set();
    const portalPairs = new Set();
    for (const raw of catalogue.portals) {
      const portal = assertObject(raw, 'portal');
      assertKnownKeys(portal, ['id', 'identity', 'endpoints'], `portal "${portal.id}"`);
      assertRequiredKeys(portal, ['id', 'identity', 'endpoints'], `portal "${portal.id}"`);
      const id = String(portal.id || '');
      if (!SAFE_ID.test(id) || id.includes('..')) fail(`portal id "${id}" is unsafe`);
      if (portalIds.has(id)) fail(`portals repeats "${id}"`);
      portalIds.add(id); portalOrder.push(id);
      const identity = assertObject(portal.identity, `portal "${id}" identity`);
      assertKnownKeys(identity, ['kind', 'value'], `portal "${id}" identity`);
      assertRequiredKeys(identity, ['kind', 'value'], `portal "${id}" identity`);
      if (!['osm-node', 'encoded-coordinate'].includes(identity.kind)) {
        fail(`portal "${id}" identity kind is unsupported`);
      }
      if (typeof identity.value !== 'string' || !identity.value) fail(`portal "${id}" identity value is empty`);
      if (identity.kind === 'osm-node' && !/^\d+$/.test(identity.value)) fail(`portal "${id}" OSM node identity is invalid`);
      if (!Array.isArray(portal.endpoints) || portal.endpoints.length !== 2) fail(`portal "${id}" must have two endpoints`);
      const endpoints = portal.endpoints.map((rawEndpoint, index) => {
        const endpoint = assertObject(rawEndpoint, `portal "${id}" endpoint ${index}`);
        assertKnownKeys(endpoint, ['partitionId', 'nodeIndex', 'lonBits', 'latBits'],
          `portal "${id}" endpoint ${index}`);
        assertRequiredKeys(endpoint, ['partitionId', 'nodeIndex', 'lonBits', 'latBits'],
          `portal "${id}" endpoint ${index}`);
        const partition = partitions.get(String(endpoint.partitionId || ''));
        if (!partition) fail(`portal "${id}" endpoint names unknown partition "${endpoint.partitionId}"`);
        positiveInteger(endpoint.nodeIndex, `portal "${id}" nodeIndex`, { allowZero: true });
        if (endpoint.nodeIndex >= partition.nodeCount) fail(`portal "${id}" nodeIndex is outside partition "${partition.id}"`);
        positiveInteger(endpoint.lonBits, `portal "${id}" lonBits`, { allowZero: true });
        positiveInteger(endpoint.latBits, `portal "${id}" latBits`, { allowZero: true });
        if (endpoint.lonBits > 0xffffffff || endpoint.latBits > 0xffffffff) fail(`portal "${id}" coordinate bits exceed uint32`);
        return { ...endpoint, partition };
      });
      if (endpoints[0].partition.id === endpoints[1].partition.id) fail(`portal "${id}" joins one partition to itself`);
      if (endpoints[0].lonBits !== endpoints[1].lonBits || endpoints[0].latBits !== endpoints[1].latBits) {
        fail(`portal "${id}" endpoint coordinates are not exact`);
      }
      if (identity.kind === 'encoded-coordinate') {
        const expected = `f32:${endpoints[0].lonBits}:${endpoints[0].latBits}`;
        if (identity.value !== expected) fail(`portal "${id}" encoded identity does not match its exact coordinates`);
      }
      const pair = [endpoints[0].partition.id, endpoints[1].partition.id]
        .sort((a, b) => a.localeCompare(b)).join('\0');
      if (!endpoints[0].partition.adjacentPartitionIds.includes(endpoints[1].partition.id)) {
        fail(`portal "${id}" is not declared by partition adjacency`);
      }
      portalPairs.add(pair);
    }
    assertSorted(portalOrder, 'portals');
    for (const [id, partition] of partitions) {
      for (const neighbor of partition.adjacentPartitionIds) {
        const pair = [id, neighbor].sort((a, b) => a.localeCompare(b)).join('\0');
        if (!portalPairs.has(pair)) fail(`adjacent partitions "${id}" and "${neighbor}" have no validated portal`);
      }
    }

    return catalogue;
  }

  root.MultiStateRouting = Object.freeze({
    MULTI_STATE_CONTRACT_VERSION,
    PARTITION_CATALOGUE_FORMAT,
    MAX_ROUTE_STATES,
    MAX_STATE_CHAIN_CANDIDATES,
    MAX_DETAILED_GRAPH_INPUT_BYTES,
    ROUTE_STATE_LIMIT_MESSAGE,
    planRouteStates,
    createRoutingRuntimeState,
    validatePartitionCatalogue,
  });
}(typeof self !== 'undefined' ? self : this));
