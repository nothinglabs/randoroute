#!/usr/bin/env node
// The production contract is generic; these invented states prove the v1
// state-chain limit without adding another real maps/<state>/ folder.
import { createRequire } from 'node:module';
import { check, checkEqual, done, ROOT } from './testlib/harness.mjs';

const require = createRequire(import.meta.url);
const { MultiStateRouting: M } = require(`${ROOT}/multi-state-routing.js`);

const availableStateIds = ['state-a', 'state-b', 'state-c', 'state-d'];
const stateAdjacency = {
  'state-a': ['state-b'],
  'state-b': ['state-a', 'state-c'],
  'state-c': ['state-b', 'state-d'],
  'state-d': ['state-c'],
};
const plan = (startStateId, endStateId, installedStateIds) => M.planRouteStates({
  availableStateIds, installedStateIds, stateAdjacency, startStateId, endStateId,
});

const ab = plan('state-a', 'state-b', ['state-a', 'state-b']);
checkEqual('an installed adjacent A -> B trip is ready', ab.status, 'ready');
check('A -> B carries its ordered route states',
  ab.routeStateIds.join('|') === 'state-a|state-b', JSON.stringify(ab));

const bc = plan('state-b', 'state-c', ['state-b', 'state-c']);
checkEqual('an installed adjacent B -> C trip is ready', bc.status, 'ready');
check('B -> C carries its ordered route states',
  bc.routeStateIds.join('|') === 'state-b|state-c', JSON.stringify(bc));

const missingTransit = plan('state-a', 'state-c', ['state-a', 'state-c']);
checkEqual('A -> C identifies a missing transit map', missingTransit.status, 'requires-install');
check('the required map is B, not either endpoint',
  missingTransit.requiredStateIds.join() === 'state-b', JSON.stringify(missingTransit));
check('the pending request retains the complete ordered state chain',
  missingTransit.routeStateIds.join('|') === 'state-a|state-b|state-c',
  JSON.stringify(missingTransit.routeStateIds));

const resumed = plan('state-a', 'state-c', ['state-a', 'state-b', 'state-c']);
checkEqual('installing transit B makes the same A -> C request ready', resumed.status, 'ready');
check('the resumed request retains all three dependencies',
  resumed.routeStateIds.join('|') === 'state-a|state-b|state-c', JSON.stringify(resumed));

const overLimit = plan('state-a', 'state-d', availableStateIds);
checkEqual('a route requiring a fourth state is rejected', overLimit.status, 'route-state-limit');
checkEqual('the fourth-state response reports the minimum state count', overLimit.minimumStateCount, 4);
checkEqual('the rider gets the product-limit copy', overLimit.message,
  'Routes may cross up to three states in this version.');

const alternatives = M.planRouteStates({
  availableStateIds: ['end-east', 'end-west', 'middle-north', 'middle-south'],
  installedStateIds: ['end-east', 'end-west', 'middle-north', 'middle-south'],
  startStateId: 'end-west', endStateId: 'end-east',
  stateAdjacency: {
    'end-east': ['middle-north', 'middle-south'],
    'end-west': ['middle-north', 'middle-south'],
    'middle-north': ['end-east', 'end-west'],
    'middle-south': ['end-east', 'end-west'],
  },
});
check('equally short credible state corridors are retained',
  alternatives.candidateStateChains.length === 2
    && alternatives.candidateStateChains.every((chain) => chain.length === 3),
  JSON.stringify(alternatives.candidateStateChains));

const runtime = M.createRoutingRuntimeState({
  availableStateIds,
  installedStateIds: ['state-a', 'state-b', 'state-c'],
  homeStateId: 'state-a',
  currentStateId: 'state-c',
  routeStateIds: ['state-a', 'state-b', 'state-c'],
  loadedPartitions: [
    { id: 'state-a/000', stateId: 'state-a', rawBytes: 20 },
    { id: 'state-b/000', stateId: 'state-b', rawBytes: 30, retainedForActiveRoute: true },
  ],
  graphInputBudgetBytes: 60,
  visibleSourceIds: ['national-orientation', 'state-c/basemap'],
});
check('installed count is independent of loaded partition count',
  runtime.installedStateIds.length === 3 && runtime.loadedPartitionIds.length === 2,
  JSON.stringify(runtime));
check('route states, loaded partitions, and visible sources stay distinct',
  runtime.routeStateIds.join('|') === 'state-a|state-b|state-c'
    && runtime.loadedPartitionIds.join('|') === 'state-a/000|state-b/000'
    && runtime.visibleSourceIds.join('|') === 'national-orientation|state-c/basemap',
  JSON.stringify(runtime));
checkEqual('loaded raw bytes are measured against the configured budget', runtime.loadedGraphInputBytes, 50);

const pendingRuntime = M.createRoutingRuntimeState({
  availableStateIds: ['state-a', 'state-b', 'state-c'],
  installedStateIds: ['state-a', 'state-c'], currentStateId: 'state-not-offered',
  routeStateIds: ['state-a', 'state-b', 'state-c'], loadedPartitions: [],
  visibleSourceIds: ['national-orientation'],
});
check('a pending route retains an uninstalled transit state independently',
  pendingRuntime.routeStateIds.join('|') === 'state-a|state-b|state-c'
    && pendingRuntime.missingRouteStateIds.join() === 'state-b');
checkEqual('local boundary resolution may identify a state whose map is unavailable',
  pendingRuntime.currentStateId, 'state-not-offered');

let budgetError = '';
try {
  M.createRoutingRuntimeState({
    availableStateIds: ['state-a'], installedStateIds: ['state-a'],
    routeStateIds: ['state-a'], visibleSourceIds: [], graphInputBudgetBytes: 9,
    loadedPartitions: [{ id: 'state-a/000', stateId: 'state-a', rawBytes: 10 }],
  });
} catch (error) { budgetError = error.message; }
check('the detailed-input ceiling is enforced rather than diagnostic only',
  /exceeds budget/.test(budgetError), budgetError);

const hashA = 'a'.repeat(64), hashB = 'b'.repeat(64);
const catalogue = {
  partitionCatalogueFormat: 1,
  graphFormat: 'bgrp1',
  build: {
    builder: 'scripts/build_graph_partitions.py', builderVersion: 1,
    algorithm: 'synthetic-test-grid', sourceDateEpoch: 0,
    sourceGraphs: [
      { stateId: 'state-a', graphVersion: 'ga', sha256: hashA },
      { stateId: 'state-b', graphVersion: 'gb', sha256: hashB },
    ],
  },
  states: [
    { id: 'state-a', graphVersion: 'ga', sourcePath: 'state-a/graph2.bin.gz',
      sourceSha256: hashA, sourceCompressedBytes: 80, sourceRawBytes: 120,
      partitionIds: ['state-a/000'] },
    { id: 'state-b', graphVersion: 'gb', sourcePath: 'state-b/graph2.bin.gz',
      sourceSha256: hashB, sourceCompressedBytes: 90, sourceRawBytes: 140,
      partitionIds: ['state-b/000'] },
  ],
  partitions: [
    { id: 'state-a/000', stateId: 'state-a', path: 'state-a/partitions/000.bin.gz',
      bounds: { minLon: -2, minLat: 0, maxLon: 0, maxLat: 2 },
      nodeCount: 2, edgeCount: 1, directedArcCount: 2, geometryPointCount: 2,
      nameCount: 1, nameBytes: 4, embeddedGraphBytes: 48,
      compressedBytes: 40, rawBytes: 60,
      sha256: hashA, sourceGraphVersion: 'ga', graphFormat: 'bgrp1',
      adjacentPartitionIds: ['state-b/000'] },
    { id: 'state-b/000', stateId: 'state-b', path: 'state-b/partitions/000.bin.gz',
      bounds: { minLon: 0, minLat: 0, maxLon: 2, maxLat: 2 },
      nodeCount: 2, edgeCount: 1, directedArcCount: 2, geometryPointCount: 2,
      nameCount: 1, nameBytes: 4, embeddedGraphBytes: 48,
      compressedBytes: 45, rawBytes: 70,
      sha256: hashB, sourceGraphVersion: 'gb', graphFormat: 'bgrp1',
      adjacentPartitionIds: ['state-a/000'] },
  ],
  portals: [
    { id: 'portal/000', identity: { kind: 'encoded-coordinate', value: 'f32:0:1065353216' },
      endpoints: [
        { partitionId: 'state-a/000', nodeIndex: 1, lonBits: 0, latBits: 1065353216 },
        { partitionId: 'state-b/000', nodeIndex: 0, lonBits: 0, latBits: 1065353216 },
      ] },
  ],
};
check('a deterministic catalogue with an exact encoded-node portal validates',
  M.validatePartitionCatalogue(catalogue) === catalogue);

const nearbyOnly = structuredClone(catalogue);
nearbyOnly.portals[0].endpoints[1].latBits++;
let portalError = '';
try { M.validatePartitionCatalogue(nearbyOnly); } catch (error) { portalError = error.message; }
check('nearby coordinates cannot invent a portal', /coordinates are not exact/.test(portalError), portalError);

const noPortal = structuredClone(catalogue);
noPortal.portals = [];
let adjacencyError = '';
try { M.validatePartitionCatalogue(noPortal); } catch (error) { adjacencyError = error.message; }
check('partition adjacency requires a validated portal', /have no validated portal/.test(adjacencyError),
  adjacencyError);

const undeclaredPortal = structuredClone(catalogue);
undeclaredPortal.partitions[0].adjacentPartitionIds = [];
undeclaredPortal.partitions[1].adjacentPartitionIds = [];
let undeclaredPortalError = '';
try { M.validatePartitionCatalogue(undeclaredPortal); } catch (error) {
  undeclaredPortalError = error.message;
}
check('every portal must also be declared as partition adjacency',
  /not declared by partition adjacency/.test(undeclaredPortalError), undeclaredPortalError);

done();
