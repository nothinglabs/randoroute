/* Incremental partition admission and deterministic BGRC composition.
 *
 * The existing router remains a single flat-array engine. This module keeps
 * its scoring code untouched: it admits a bounded set of detailed partitions,
 * merges declared portal nodes, writes one ordinary BGRC snapshot, and reports
 * unloaded frontier nodes for a later widening retry.
 *
 * Loaded as a classic script in a worker/browser. In Node the IIFE's `this` is
 * module.exports, so executable tests use the same implementation.
 */
(function (root) {
  'use strict';

  let contract = root.MultiStateRouting;
  if (!contract && typeof require === 'function') {
    try { contract = require('./multi-state-routing.js').MultiStateRouting; } catch (e) { /* browser */ }
  }
  if (!contract) throw new Error('partition-runtime.js: multi-state-routing.js has not been loaded');

  const BGP_MAGIC = 0x42475031; // BGP1
  const BGRC_MAGIC = 0x42475243;
  const textDecoder = new TextDecoder();

  class PartitionRuntimeError extends Error {
    constructor(code, message, detail = {}) {
      super(message);
      this.name = 'PartitionRuntimeError';
      this.code = code;
      this.detail = detail;
    }
  }

  function abortError() {
    if (typeof DOMException === 'function') return new DOMException('Partition request was cancelled.', 'AbortError');
    const error = new Error('Partition request was cancelled.');
    error.name = 'AbortError';
    return error;
  }

  function checkAbort(signal) {
    if (signal?.aborted) throw abortError();
  }

  function align(offset, boundary) { return offset + ((boundary - offset % boundary) % boundary); }

  function exactArrayBuffer(value) {
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    throw new PartitionRuntimeError('bad-partition-bytes', 'A partition loader returned unreadable bytes.');
  }

  function parseBgrc(buffer, byteOffset = 0, byteLength = buffer.byteLength - byteOffset) {
    if (byteLength < 28) throw new PartitionRuntimeError('bad-partition-graph', 'A partition graph is truncated.');
    const dv = new DataView(buffer, byteOffset, byteLength);
    if (dv.getUint32(0, false) !== BGRC_MAGIC) {
      throw new PartitionRuntimeError('bad-partition-graph', 'A partition does not contain a BGRC graph.');
    }
    const N = dv.getUint32(4, true), E = dv.getUint32(8, true), D = dv.getUint32(12, true);
    const G = dv.getUint32(16, true), U = dv.getUint32(20, true), B = dv.getUint32(24, true);
    let o = 28;
    const take = (Type, count) => {
      const bytes = Type.BYTES_PER_ELEMENT * count;
      if (o + bytes > byteLength) {
        throw new PartitionRuntimeError('bad-partition-graph', 'A partition graph field is truncated.');
      }
      const result = new Type(buffer, byteOffset + o, count);
      o += bytes;
      return result;
    };
    const graph = { N, E, D, G, U, B };
    graph.nodeLon = take(Float32Array, N);
    graph.nodeLat = take(Float32Array, N);
    graph.nodeEle = take(Int16Array, N);
    o = align(o, 4);
    graph.eA = take(Uint32Array, E); graph.eB = take(Uint32Array, E);
    graph.eLen = take(Float32Array, E);
    graph.eAsc = take(Uint16Array, E); graph.eDes = take(Uint16Array, E);
    graph.eSpeed = take(Uint8Array, E); graph.eSpeedBA = take(Uint8Array, E);
    graph.eFlags = take(Uint8Array, E);
    graph.eSh = take(Int8Array, E); graph.eShBA = take(Int8Array, E);
    graph.eLimitedDir = take(Uint8Array, E); graph.eClass = take(Uint8Array, E);
    graph.eFacility = take(Uint8Array, E); graph.eOfficial = take(Uint8Array, E);
    graph.eSurface = take(Uint8Array, E); graph.eLanes = take(Uint8Array, E);
    graph.eLts = take(Uint8Array, E); graph.eEdgeSpace = take(Uint8Array, E);
    graph.eCountyShoulder = take(Uint8Array, E); graph.eAdt = take(Uint16Array, E);
    graph.eAdtMeta = take(Uint8Array, E); graph.eAdtSource = take(Uint8Array, E);
    graph.eClassOwner = take(Uint8Array, E); graph.eHazAB = take(Uint8Array, E);
    graph.eHazBA = take(Uint8Array, E);
    o = align(o, 2);
    graph.eHazStartAB = take(Uint16Array, E); graph.eHazEndAB = take(Uint16Array, E);
    graph.eHazStartBA = take(Uint16Array, E); graph.eHazEndBA = take(Uint16Array, E);
    o = align(o, 4);
    graph.eOff = take(Uint32Array, E); graph.eCnt = take(Uint16Array, E);
    o = align(o, 4);
    graph.outStart = take(Uint32Array, N + 1);
    graph.outTarget = take(Uint32Array, D); graph.outEdge = take(Uint32Array, D);
    graph.eName = take(Uint32Array, E); graph.nameOff = take(Uint32Array, U + 1);
    graph.gLon = take(Float32Array, G); graph.gLat = take(Float32Array, G);
    graph.nameBytes = take(Uint8Array, B);
    if (o !== byteLength) {
      throw new PartitionRuntimeError('bad-partition-graph',
        `A partition graph has ${byteLength - o} unexpected trailing bytes.`);
    }
    graph.nodeLonBits = new Uint32Array(buffer, graph.nodeLon.byteOffset, N);
    graph.nodeLatBits = new Uint32Array(buffer, graph.nodeLat.byteOffset, N);
    return graph;
  }

  function parsePartition(rawValue, partition, state) {
    const buffer = exactArrayBuffer(rawValue);
    if (buffer.byteLength !== partition.rawBytes) {
      throw new PartitionRuntimeError('partition-size-mismatch',
        `${partition.path} decompressed to ${buffer.byteLength} bytes; expected ${partition.rawBytes}.`);
    }
    if (buffer.byteLength < 12) throw new PartitionRuntimeError('bad-partition-wrapper', `${partition.path} is truncated.`);
    const dv = new DataView(buffer);
    if (dv.getUint32(0, false) !== BGP_MAGIC) {
      throw new PartitionRuntimeError('bad-partition-wrapper', `${partition.path} has bad BGP1 magic.`);
    }
    const metadataBytes = dv.getUint32(4, true);
    const graphBytes = dv.getUint32(8, true);
    const graphOffset = align(12 + metadataBytes, 4);
    if (graphOffset + graphBytes !== buffer.byteLength || graphBytes !== partition.embeddedGraphBytes) {
      throw new PartitionRuntimeError('bad-partition-wrapper', `${partition.path} has inconsistent wrapper lengths.`);
    }
    let metadata;
    try { metadata = JSON.parse(textDecoder.decode(new Uint8Array(buffer, 12, metadataBytes))); }
    catch (error) {
      throw new PartitionRuntimeError('bad-partition-wrapper', `${partition.path} has invalid metadata.`);
    }
    if (metadata.partitionFormat !== partition.graphFormat
        || metadata.partitionId !== partition.id || metadata.stateId !== partition.stateId
        || metadata.sourceGraphVersion !== partition.sourceGraphVersion
        || metadata.sourceGraphSha256 !== state.sourceSha256
        || metadata.embeddedGraphMagic !== 'BGRC') {
      throw new PartitionRuntimeError('partition-version-mismatch',
        `${partition.path} metadata does not match its catalogue entry.`);
    }
    const graph = parseBgrc(buffer, graphOffset, graphBytes);
    const expected = [partition.nodeCount, partition.edgeCount, partition.directedArcCount,
      partition.geometryPointCount, partition.nameCount, partition.nameBytes];
    const actual = [graph.N, graph.E, graph.D, graph.G, graph.U, graph.B];
    if (actual.some((value, index) => value !== expected[index])) {
      throw new PartitionRuntimeError('partition-count-mismatch',
        `${partition.path} graph counts do not match its catalogue entry.`);
    }
    return { buffer, metadata, graph };
  }

  function graphByteLength({ N, E, D, G, U, B }) {
    let o = 28 + N * 4 + N * 4 + N * 2;
    o = align(o, 4);
    o += E * 4 + E * 4 + E * 4;
    o += E * 2 + E * 2;
    o += E * 14; // speed..county shoulder (all byte fields before ADT)
    o += E * 2;  // ADT
    o += E * 5;  // ADT meta/source, class owner, two hazard bytes
    o = align(o, 2);
    o += E * 2 * 4;
    o = align(o, 4);
    o += E * 4 + E * 2;
    o = align(o, 4);
    o += (N + 1) * 4 + D * 4 + D * 4 + E * 4 + (U + 1) * 4;
    o += G * 4 + G * 4 + B;
    return o;
  }

  function createBgrc({ N, E, D, G, U, B }) {
    const buffer = new ArrayBuffer(graphByteLength({ N, E, D, G, U, B }));
    const dv = new DataView(buffer);
    dv.setUint32(0, BGRC_MAGIC, false);
    for (const [index, value] of [N, E, D, G, U, B].entries()) dv.setUint32(4 + index * 4, value, true);
    // The parser constructs all aligned views and proves the allocated length.
    return { buffer, graph: parseBgrc(buffer) };
  }

  function sparseUnion() {
    const parent = new Map();
    const find = (value) => {
      let rootValue = value;
      while (parent.has(rootValue) && parent.get(rootValue) !== rootValue) rootValue = parent.get(rootValue);
      let current = value;
      while (parent.has(current) && parent.get(current) !== rootValue) {
        const next = parent.get(current); parent.set(current, rootValue); current = next;
      }
      return rootValue;
    };
    return {
      union(left, right) {
        if (!parent.has(left)) parent.set(left, left);
        if (!parent.has(right)) parent.set(right, right);
        const a = find(left), b = find(right);
        if (a === b) return;
        // Stable regardless of catalogue portal order.
        if (a.localeCompare(b) < 0) parent.set(b, a); else parent.set(a, b);
      },
      has: (value) => parent.has(value),
      find,
    };
  }

  function prepareComposite(catalogue, requestedIds, routeStateIds, budgetBytes) {
    contract.validatePartitionCatalogue(catalogue);
    const partitionById = new Map(catalogue.partitions.map((partition) => [partition.id, partition]));
    const stateById = new Map(catalogue.states.map((state) => [state.id, state]));
    const selectedIds = [...new Set(requestedIds || [])].sort((a, b) => a.localeCompare(b));
    if (!selectedIds.length) throw new PartitionRuntimeError('no-partitions', 'No detailed routing maps were selected.');
    const partitions = selectedIds.map((id) => {
      const partition = partitionById.get(id);
      if (!partition) throw new PartitionRuntimeError('unknown-partition', `The routing catalogue does not list "${id}".`);
      return partition;
    });
    if (partitions.length > 0xffff) {
      throw new PartitionRuntimeError('partition-index-capacity',
        'The selected routing corridor contains too many detailed partitions.');
    }
    const selectedStateCount = new Set(partitions.map((partition) => partition.stateId)).size;
    if (selectedStateCount > 0xffff) {
      throw new PartitionRuntimeError('state-index-capacity',
        'The selected routing corridor contains too many jurisdictions.');
    }
    const rawInputBytes = partitions.reduce((sum, partition) => sum + partition.rawBytes, 0);
    if (rawInputBytes > budgetBytes) {
      throw new PartitionRuntimeError('graph-input-budget',
        'The detailed routing maps required for this trip do not fit this device’s routing-memory limit.',
        { rawInputBytes, budgetBytes, partitionIds: selectedIds });
    }
    const selected = new Set(selectedIds);
    const union = sparseUnion();
    const endpointKey = (endpoint) => `${endpoint.partitionId}\0${endpoint.nodeIndex}`;
    for (const portal of catalogue.portals) {
      if (portal.endpoints.every((endpoint) => selected.has(endpoint.partitionId))) {
        union.union(endpointKey(portal.endpoints[0]), endpointKey(portal.endpoints[1]));
      }
    }
    const maps = new Map();
    const rootGlobal = new Map();
    let N = 0;
    for (const partition of partitions) {
      const map = new Uint32Array(partition.nodeCount);
      for (let node = 0; node < partition.nodeCount; node++) {
        const key = `${partition.id}\0${node}`;
        if (!union.has(key)) map[node] = N++;
        else {
          const rootKey = union.find(key);
          if (!rootGlobal.has(rootKey)) rootGlobal.set(rootKey, N++);
          map[node] = rootGlobal.get(rootKey);
        }
      }
      maps.set(partition.id, map);
    }
    const routeStates = routeStateIds?.length ? new Set(routeStateIds) : null;
    const frontiers = [];
    const frontierSeen = new Set();
    for (const portal of catalogue.portals) {
      const loaded = portal.endpoints.filter((endpoint) => selected.has(endpoint.partitionId));
      if (loaded.length !== 1) continue;
      const unloaded = portal.endpoints.find((endpoint) => !selected.has(endpoint.partitionId));
      const adjacent = partitionById.get(unloaded.partitionId);
      if (routeStates && !routeStates.has(adjacent.stateId)) continue;
      const loadedEndpoint = loaded[0];
      const node = maps.get(loadedEndpoint.partitionId)[loadedEndpoint.nodeIndex];
      const key = `${node}\0${unloaded.partitionId}`;
      if (frontierSeen.has(key)) continue;
      frontierSeen.add(key);
      frontiers.push({ node, portalId: portal.id, loadedPartitionId: loadedEndpoint.partitionId,
        adjacentPartitionId: unloaded.partitionId, adjacentStateId: adjacent.stateId });
    }
    frontiers.sort((a, b) => a.node - b.node
      || a.adjacentPartitionId.localeCompare(b.adjacentPartitionId));
    const counts = {
      N,
      E: partitions.reduce((sum, partition) => sum + partition.edgeCount, 0),
      D: partitions.reduce((sum, partition) => sum + partition.directedArcCount, 0),
      G: partitions.reduce((sum, partition) => sum + partition.geometryPointCount, 0),
      U: partitions.reduce((sum, partition) => sum + partition.nameCount, 0),
      B: partitions.reduce((sum, partition) => sum + partition.nameBytes, 0),
    };
    const compositeGraphBytes = graphByteLength(counts);
    if (compositeGraphBytes > budgetBytes) {
      throw new PartitionRuntimeError('graph-input-budget',
        'The composed routing map required for this trip does not fit this device’s routing-memory limit.',
        { compositeGraphBytes, budgetBytes, partitionIds: selectedIds });
    }
    return { partitions, partitionById, stateById, maps, counts, frontiers,
      rawInputBytes, compositeGraphBytes };
  }

  const COPY_EDGE_FIELDS = ['eLen', 'eAsc', 'eDes', 'eSpeed', 'eSpeedBA', 'eFlags',
    'eSh', 'eShBA', 'eLimitedDir', 'eClass', 'eFacility', 'eOfficial', 'eSurface',
    'eLanes', 'eLts', 'eEdgeSpace', 'eCountyShoulder', 'eAdt', 'eAdtMeta',
    'eAdtSource', 'eClassOwner', 'eHazAB', 'eHazBA', 'eHazStartAB', 'eHazEndAB',
    'eHazStartBA', 'eHazEndBA', 'eCnt'];

  async function composePartitions(options) {
    const input = options || {};
    const budgetBytes = input.budgetBytes || contract.MAX_DETAILED_GRAPH_INPUT_BYTES;
    const plan = prepareComposite(input.catalogue, input.partitionIds,
      input.routeStateIds || [], budgetBytes);
    const { buffer, graph: output } = createBgrc(plan.counts);
    const nodeWritten = new Uint8Array(plan.counts.N);
    const elevationTotal = new Int32Array(plan.counts.N);
    const elevationCount = new Uint16Array(plan.counts.N);
    const degree = new Uint32Array(plan.counts.N);
    const stateIds = [...new Set(plan.partitions.map((partition) => partition.stateId))]
      .sort((a, b) => a.localeCompare(b));
    const stateIndex = new Map(stateIds.map((id, index) => [id, index]));
    const edgeStateIndexes = new Uint16Array(plan.counts.E);
    const edgePartitionIndexes = new Uint16Array(plan.counts.E);
    const partitionRanges = [];
    const portalsByPartition = new Map(plan.partitions.map((partition) => [partition.id, []]));
    for (const portal of input.catalogue.portals) {
      for (const endpoint of portal.endpoints) {
        if (portalsByPartition.has(endpoint.partitionId)) {
          portalsByPartition.get(endpoint.partitionId).push({ portal, endpoint });
        }
      }
    }
    let edgeBase = 0, geomBase = 0, nameBase = 0, nameByteBase = 0;
    let largestPartitionRawBytes = 0;
    for (let partitionIndex = 0; partitionIndex < plan.partitions.length; partitionIndex++) {
      checkAbort(input.signal);
      const partition = plan.partitions[partitionIndex];
      input.onProgress?.({ phase: 'partition', partitionId: partition.id,
        loaded: partitionIndex, total: plan.partitions.length });
      const raw = exactArrayBuffer(await input.loadPartition(partition, { signal: input.signal }));
      checkAbort(input.signal);
      largestPartitionRawBytes = Math.max(largestPartitionRawBytes, raw.byteLength);
      const parsed = parsePartition(raw, partition, plan.stateById.get(partition.stateId));
      const graph = parsed.graph;
      const nodeMap = plan.maps.get(partition.id);
      for (const { portal, endpoint } of portalsByPartition.get(partition.id)) {
        if (graph.nodeLonBits[endpoint.nodeIndex] !== endpoint.lonBits
            || graph.nodeLatBits[endpoint.nodeIndex] !== endpoint.latBits) {
          throw new PartitionRuntimeError('portal-coordinate-mismatch',
            `${portal.id} does not match the encoded node in ${partition.id}.`);
        }
      }
      for (let local = 0; local < graph.N; local++) {
        const global = nodeMap[local];
        if (!nodeWritten[global]) {
          output.nodeLon[global] = graph.nodeLon[local];
          output.nodeLat[global] = graph.nodeLat[local];
          nodeWritten[global] = 1;
        } else if (output.nodeLon[global] !== graph.nodeLon[local]
                   || output.nodeLat[global] !== graph.nodeLat[local]) {
          throw new PartitionRuntimeError('portal-coordinate-mismatch',
            `Merged portal node ${global} has non-identical coordinates.`);
        }
        elevationTotal[global] += graph.nodeEle[local];
        elevationCount[global]++;
      }
      for (const field of COPY_EDGE_FIELDS) output[field].set(graph[field], edgeBase);
      for (let edge = 0; edge < graph.E; edge++) {
        const globalEdge = edgeBase + edge;
        output.eA[globalEdge] = nodeMap[graph.eA[edge]];
        output.eB[globalEdge] = nodeMap[graph.eB[edge]];
        output.eOff[globalEdge] = geomBase + graph.eOff[edge];
        output.eName[globalEdge] = nameBase + graph.eName[edge];
        edgeStateIndexes[globalEdge] = stateIndex.get(partition.stateId);
        edgePartitionIndexes[globalEdge] = partitionIndex;
        degree[output.eA[globalEdge]]++;
        if (!(output.eFlags[globalEdge] & 16)) degree[output.eB[globalEdge]]++;
      }
      output.gLon.set(graph.gLon, geomBase); output.gLat.set(graph.gLat, geomBase);
      for (let name = 0; name < graph.U; name++) {
        output.nameOff[nameBase + name] = nameByteBase + graph.nameOff[name];
      }
      output.nameBytes.set(graph.nameBytes, nameByteBase);
      partitionRanges.push({ partitionId: partition.id, stateId: partition.stateId,
        edgeStart: edgeBase, edgeCount: graph.E, rawBytes: partition.rawBytes,
        sourceGraphVersion: partition.sourceGraphVersion,
        partitionSha256: partition.sha256 });
      edgeBase += graph.E; geomBase += graph.G; nameBase += graph.U; nameByteBase += graph.B;
      // No parsed graph or raw partition is retained past this iteration.
      input.onProgress?.({ phase: 'partition', partitionId: partition.id,
        loaded: partitionIndex + 1, total: plan.partitions.length });
    }
    for (let node = 0; node < plan.counts.N; node++) {
      if (!nodeWritten[node] || !elevationCount[node]) {
        throw new PartitionRuntimeError('composite-node-missing', `Composite node ${node} was not populated.`);
      }
      output.nodeEle[node] = Math.round(elevationTotal[node] / elevationCount[node]);
    }
    output.nameOff[plan.counts.U] = plan.counts.B;
    let arcs = 0;
    for (let node = 0; node < plan.counts.N; node++) {
      output.outStart[node] = arcs;
      arcs += degree[node];
    }
    output.outStart[plan.counts.N] = arcs;
    if (arcs !== plan.counts.D) {
      throw new PartitionRuntimeError('composite-arc-mismatch',
        `Composite adjacency expected ${plan.counts.D} arcs and rebuilt ${arcs}.`);
    }
    const cursor = output.outStart.slice(0, plan.counts.N);
    for (let edge = 0; edge < plan.counts.E; edge++) {
      let at = cursor[output.eA[edge]]++;
      output.outTarget[at] = output.eB[edge]; output.outEdge[at] = edge;
      if (!(output.eFlags[edge] & 16)) {
        at = cursor[output.eB[edge]]++;
        output.outTarget[at] = output.eA[edge]; output.outEdge[at] = edge;
      }
    }
    checkAbort(input.signal);
    const nodeMappingBytes = [...plan.maps.values()]
      .reduce((sum, map) => sum + map.byteLength, 0);
    const compositionWorkingBytes = nodeMappingBytes
      + nodeWritten.byteLength + elevationTotal.byteLength + elevationCount.byteLength
      + degree.byteLength + cursor.byteLength
      + edgeStateIndexes.byteLength + edgePartitionIndexes.byteLength;
    const largestCompressedPartitionBytes = Math.max(...plan.partitions
      .map((partition) => partition.compressedBytes));
    return {
      buffer,
      loadedPartitionIds: plan.partitions.map((partition) => partition.id),
      stateIds,
      edgeStateIndexes,
      edgePartitionIndexes,
      partitionRanges,
      frontiers: plan.frontiers,
      diagnostics: {
        rawInputBytes: plan.rawInputBytes,
        compositeGraphBytes: buffer.byteLength,
        graphInputBudgetBytes: budgetBytes,
        largestPartitionRawBytes,
        largestCompressedPartitionBytes,
        nodeMappingBytes,
        compositionWorkingBytes,
        estimatedCompositionPeakBytes: buffer.byteLength + largestPartitionRawBytes
          + largestCompressedPartitionBytes + compositionWorkingBytes,
        residentSidecarBytes: edgeStateIndexes.byteLength + edgePartitionIndexes.byteLength,
        nodeCount: plan.counts.N,
        edgeCount: plan.counts.E,
        directedArcCount: plan.counts.D,
        frontierCount: plan.frontiers.length,
      },
    };
  }

  function selectFrontierExpansion(options) {
    const input = options || {};
    const loaded = new Set(input.loadedPartitionIds || []);
    const byNode = new Map();
    for (const frontier of input.frontiers || []) {
      if (!byNode.has(frontier.node)) byNode.set(frontier.node, []);
      byNode.get(frontier.node).push(frontier);
    }
    const routeFound = !!input.routeFound;
    const ceiling = Number.isFinite(input.worstCompetitiveCost)
      ? input.worstCompetitiveCost : Infinity;
    const observations = [...(input.frontierHits || [])]
      .filter((hit) => Number.isFinite(hit.lowerBound)
        && (!routeFound || hit.lowerBound <= ceiling))
      .sort((a, b) => a.lowerBound - b.lowerBound || a.node - b.node);
    const chosen = [];
    const seen = new Set();
    const maxAdditions = Math.max(1, input.maxAdditions || 2);
    for (const hit of observations) {
      for (const frontier of byNode.get(hit.node) || []) {
        if (loaded.has(frontier.adjacentPartitionId) || seen.has(frontier.adjacentPartitionId)) continue;
        seen.add(frontier.adjacentPartitionId);
        chosen.push({ ...frontier, lowerBound: hit.lowerBound });
        if (chosen.length >= maxAdditions) return chosen;
      }
    }
    return chosen;
  }

  async function defaultLoadPartition(baseUrl, partition, { signal } = {}) {
    const response = await fetch(new URL(partition.path, baseUrl), { signal, cache: 'no-cache' });
    if (!response.ok) throw new PartitionRuntimeError('partition-fetch',
      `${partition.path}: HTTP ${response.status}`);
    const compressed = await response.arrayBuffer();
    if (compressed.byteLength !== partition.compressedBytes) {
      throw new PartitionRuntimeError('partition-size-mismatch',
        `${partition.path} downloaded ${compressed.byteLength} bytes; expected ${partition.compressedBytes}.`);
    }
    if (!root.crypto?.subtle) throw new PartitionRuntimeError('partition-hash-unavailable',
      'This browser cannot verify downloaded routing data.');
    const digest = await root.crypto.subtle.digest('SHA-256', compressed);
    const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (actual !== partition.sha256) throw new PartitionRuntimeError('partition-hash-mismatch',
      `${partition.path} does not match its catalogue hash.`);
    if (typeof DecompressionStream !== 'function') {
      // WebKit before 16.4: fall back to the bundled fflate, as the router
      // worker's graph path does. Available only where importScripts exists;
      // elsewhere the original verdict stands.
      if (typeof root.fflate === 'undefined' && typeof root.importScripts === 'function') {
        try { root.importScripts('vendor/fflate.js'); } catch (error) { /* keep verdict */ }
      }
      if (typeof root.fflate === 'undefined') {
        throw new PartitionRuntimeError('partition-decompression', 'This browser cannot decompress routing partitions.');
      }
      const raw = root.fflate.gunzipSync(new Uint8Array(compressed));
      return raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength
        ? raw.buffer : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    }
    return new Response(new Blob([compressed]).stream()
      .pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }

  class PartitionGraphRuntime {
    constructor(options) {
      const input = options || {};
      contract.validatePartitionCatalogue(input.catalogue);
      this.catalogue = input.catalogue;
      this.baseUrl = input.baseUrl || root.location?.href || 'http://localhost/';
      this.budgetBytes = input.budgetBytes || contract.MAX_DETAILED_GRAPH_INPUT_BYTES;
      this.loader = input.loadPartition || ((partition, request) =>
        defaultLoadPartition(this.baseUrl, partition, request));
      this.onProgress = input.onProgress || (() => {});
      this.loadedPartitionIds = [];
      this.pinnedPartitionIds = [];
      this.generation = 0;
      this.controller = null;
      this.lastDiagnostics = null;
    }

    pinActiveRoute(partitionIds) { this.pinnedPartitionIds = [...new Set(partitionIds || [])]; }
    clearActiveRoute() { this.pinnedPartitionIds = []; }
    cancel() {
      this.generation++;
      this.controller?.abort();
      this.controller = null;
    }

    async load(request) {
      this.controller?.abort();
      const generation = ++this.generation;
      const controller = new AbortController();
      this.controller = controller;
      const requested = [...new Set(request.partitionIds || [])];
      const admitted = [...new Set([...requested, ...this.pinnedPartitionIds])];
      const before = this.loadedPartitionIds;
      try {
        const result = await composePartitions({
          catalogue: this.catalogue,
          partitionIds: admitted,
          routeStateIds: request.routeStateIds || [],
          budgetBytes: request.budgetBytes || this.budgetBytes,
          signal: controller.signal,
          loadPartition: async (partition, context) => {
            const raw = await this.loader(partition, context);
            if (generation !== this.generation) throw abortError();
            return raw;
          },
          onProgress: (progress) => {
            if (generation === this.generation) this.onProgress({ generation, ...progress });
          },
        });
        if (generation !== this.generation) throw abortError();
        this.loadedPartitionIds = result.loadedPartitionIds;
        this.lastDiagnostics = { generation,
          loadedPartitionIds: [...result.loadedPartitionIds],
          evictedPartitionIds: before.filter((id) => !result.loadedPartitionIds.includes(id)),
          pinnedPartitionIds: [...this.pinnedPartitionIds], ...result.diagnostics };
        return { generation, ...result, diagnostics: this.lastDiagnostics };
      } finally {
        if (generation === this.generation) this.controller = null;
      }
    }

    diagnostics() { return this.lastDiagnostics ? { ...this.lastDiagnostics } : null; }
  }

  class PartitionLoaderController {
    constructor(options = {}) {
      if (typeof options.postMessage !== 'function') {
        throw new Error('PartitionLoaderController needs postMessage');
      }
      this.post = options.postMessage;
      this.loadPartition = options.loadPartition;
      this.runtime = null;
    }

    async handle(message) {
      const m = message || {};
      try {
        if (m.type === 'init') {
          this.runtime?.cancel();
          this.runtime = new PartitionGraphRuntime({
            catalogue: m.catalogue, baseUrl: m.baseUrl,
            budgetBytes: m.budgetBytes,
            loadPartition: this.loadPartition,
            onProgress: (progress) => this.post({ type: 'partition-progress', ...progress }),
          });
          this.post({ type: 'partition-runtime-ready', id: m.id,
            budgetBytes: this.runtime.budgetBytes });
        } else if (m.type === 'load') {
          if (!this.runtime) throw new PartitionRuntimeError('not-initialized',
            'The partition runtime has not received its catalogue.');
          if (Array.isArray(m.pinnedPartitionIds)) this.runtime.pinActiveRoute(m.pinnedPartitionIds);
          const result = await this.runtime.load(m);
          this.post({ type: 'partition-graph', id: m.id, generation: result.generation,
            buffer: result.buffer,
            edgeStateIndexes: result.edgeStateIndexes,
            edgePartitionIndexes: result.edgePartitionIndexes,
            stateIds: result.stateIds,
            loadedPartitionIds: result.loadedPartitionIds,
            partitionRanges: result.partitionRanges,
            frontiers: result.frontiers,
            diagnostics: result.diagnostics,
          }, [result.buffer, result.edgeStateIndexes.buffer, result.edgePartitionIndexes.buffer]);
        } else if (m.type === 'cancel') {
          this.runtime?.cancel();
          this.post({ type: 'partition-cancelled', id: m.id });
        } else if (m.type === 'active-route') {
          if (!this.runtime) throw new PartitionRuntimeError('not-initialized',
            'The partition runtime has not received its catalogue.');
          this.runtime.pinActiveRoute(m.partitionIds || []);
          this.post({ type: 'partition-active-route-ready', id: m.id,
            partitionIds: [...this.runtime.pinnedPartitionIds] });
        } else if (m.type === 'clear-active-route') {
          this.runtime?.clearActiveRoute();
          this.post({ type: 'partition-active-route-ready', id: m.id, partitionIds: [] });
        } else if (m.type === 'diagnostics') {
          this.post({ type: 'partition-diagnostics', id: m.id,
            diagnostics: this.runtime?.diagnostics() || null });
        }
      } catch (error) {
        if (error?.name === 'AbortError') {
          this.post({ type: 'partition-cancelled', id: m.id });
        } else {
          this.post({ type: 'partition-error', id: m.id,
            code: error?.code || 'partition-runtime', message: String(error?.message || error),
            detail: error?.detail || null });
        }
      }
    }
  }

  root.PartitionRouting = Object.freeze({
    PartitionRuntimeError,
    parseBgrc,
    parsePartition,
    composePartitions,
    selectFrontierExpansion,
    PartitionGraphRuntime,
    PartitionLoaderController,
  });
}(typeof self !== 'undefined' ? self : this));
