#!/usr/bin/env node
// Run released Washington and Oregon partitions through the production router.
// Synthetic tests prove malformed-boundary behavior. This file proves the
// published-scale artifacts retain useful routes, ferries, portfolios, and
// state attribution on real roads on both sides of the Columbia.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { appDefaultRules, check, checkEqual, done, ROOT, routerWorker,
  routerWorkerFromBuffer } from './testlib/harness.mjs';

const require = createRequire(import.meta.url);
const { MultiStateRouteCoordinator: Coordinator } =
  require(join(ROOT, 'multi-state-route-coordinator.js'));
const { MultiStateRouting } = require(join(ROOT, 'multi-state-routing.js'));
const { PartitionRouting } = require(join(ROOT, 'partition-runtime.js'));
const catalogue = require(join(ROOT, 'maps/partition-catalogue.json'));
const rules = appDefaultRules();
const MI = 1609.344;

function straightMetres(a, b) {
  const lat = (a[1] + b[1]) * Math.PI / 360;
  const dx = (b[0] - a[0]) * Math.cos(lat) * 111_195;
  const dy = (b[1] - a[1]) * 111_195;
  return Math.hypot(dx, dy);
}

function compact(result) {
  return {
    ok: result?.ok,
    reason: result?.reason,
    distMi: result?.distM == null ? null : +(result.distM / MI).toFixed(1),
    failMi: result?.failM == null ? null : +(result.failM / MI).toFixed(1),
    freewayMi: result?.freewayM == null ? null : +(result.freewayM / MI).toFixed(1),
    ferryMi: result?.ferryM == null ? null : +(result.ferryM / MI).toFixed(1),
    stateIds: result?.stateIds,
    partitionCount: result?.partitionIds?.length,
    loadedCount: result?.loadedPartitionIds?.length,
    attempts: result?.routingDiagnostics?.attempts?.length,
  };
}

function directRequest(id, points, pointStateIds) {
  return { type: 'route', id, start: points[0], end: points.at(-1), points,
    pointStateIds, rules, mode: 'balanced', prefDesignated: false,
    prefResidential: false };
}

function portfolioRequest(id, points, pointStateIds) {
  return { type: 'route-options', id, points, pointStateIds, rules,
    forceDesignated: true, forceResidential: true };
}

function fullRoute(stateId, request) {
  return routerWorker({ state: stateId, fresh: true }).post(request);
}

function rawPartition(partition) {
  return zlib.gunzipSync(readFileSync(join(ROOT, 'maps', partition.path)));
}

async function partitionRoute(request, { selectInitialCorridor } = {}) {
  const progress = [];
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

function endpointPartitionsOnly({ catalogue: available, points, pointStateIds }) {
  const ids = points.map((point, index) => available.partitions.find((partition) =>
    partition.stateId === pointStateIds[index]
      && point[0] >= partition.bounds.minLon && point[0] <= partition.bounds.maxLon
      && point[1] >= partition.bounds.minLat && point[1] <= partition.bounds.maxLat)?.id);
  if (ids.some((id) => !id)) throw new Error('production expansion fixture is outside a partition');
  const partitionIds = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  const byId = new Map(available.partitions.map((partition) => [partition.id, partition]));
  return { partitionIds,
    rawInputBytes: partitionIds.reduce((sum, id) => sum + byId.get(id).rawBytes, 0),
    candidatePaths: [], pointPartitionIds: ids.map((id) => [id]) };
}

function routeWithin(full, partitioned, distanceFactor = 1.2) {
  return full?.ok && partitioned?.ok
    && partitioned.distM <= full.distM * distanceFactor + 1000
    && partitioned.failM <= full.failM * 1.25 + 1609.344
    && partitioned.freewayM <= full.freewayM + 80;
}

checkEqual('the released catalogue covers both source graphs', catalogue.states.length, 2);
check('the production partition set stays below the ordinary Washington graph ceiling',
  catalogue.partitions.every((partition) =>
    partition.rawBytes <= MultiStateRouting.MAX_DETAILED_GRAPH_INPUT_BYTES));

// A small Oregon portfolio is quick enough to compare candidate behavior, not
// just one shortest path. It has several fully rule-matching alternatives in
// the ordinary graph, so the partition result must retain that useful choice.
const portlandPoints = [[-122.6765, 45.5231], [-122.641, 45.564]];
const portlandRequest = portfolioRequest('portland-portfolio', portlandPoints,
  ['oregon', 'oregon']);
const portlandFull = fullRoute('oregon', portlandRequest);
const portlandPartitioned = (await partitionRoute(portlandRequest)).result;
const fullPortlandMatching = (portlandFull.options || []).filter((option) => option.failM < 1);
const partitionPortlandMatching = (portlandPartitioned.options || [])
  .filter((option) => option.failM < 1);
check('an Oregon partition retains a useful route portfolio',
  portlandFull.ok && portlandPartitioned.ok && portlandPartitioned.options.length >= 3,
  JSON.stringify({ full: portlandFull.options?.length,
    partitioned: portlandPartitioned.options?.length }));
check('fully rule-matching Oregon alternatives remain available',
  fullPortlandMatching.length > 0 && partitionPortlandMatching.length > 0,
  JSON.stringify({ full: fullPortlandMatching.length,
    partitioned: partitionPortlandMatching.length }));
check('the partitioned Oregon portfolio does not introduce a distance or safety regression',
  routeWithin(portlandFull.options.reduce((best, option) =>
    option.distM < best.distM ? option : best),
  portlandPartitioned.options.reduce((best, option) =>
    option.distM < best.distM ? option : best)),
  JSON.stringify({ full: compact(portlandFull.options[0]),
    partitioned: compact(portlandPartitioned.options[0]) }));

// Seattle to Port Townsend is the repository's durable ferry tripwire. A
// direct route is sufficient here: the invariant is that partitioning does not
// sever the boat crossing or replace it with freeway mileage.
const ferryPoints = [[-122.33006, 47.60383], [-122.7604, 48.1170]];
const ferryRequest = directRequest('partition-ferry', ferryPoints,
  ['washington', 'washington']);
const ferryFull = fullRoute('washington', ferryRequest);
const ferryPartitioned = (await partitionRoute(ferryRequest)).result;
check('the important Washington ferry plan survives partitioning',
  routeWithin(ferryFull, ferryPartitioned)
    && ferryFull.ferryM > 1000 && ferryPartitioned.ferryM > 1000,
  JSON.stringify({ full: compact(ferryFull), partitioned: compact(ferryPartitioned) }));

const crossBorderCases = [
  {
    name: 'Seattle to Portland',
    points: [[-122.33006, 47.60383], [-122.67419, 45.52025]],
    pointStateIds: ['washington', 'oregon'],
    maxStraightFactor: 2.2,
  },
  {
    name: 'Seattle to Eugene',
    points: [[-122.33006, 47.60383], [-123.09505, 44.05051]],
    pointStateIds: ['washington', 'oregon'],
    maxStraightFactor: 2.2,
  },
  {
    name: 'Astoria to Megler Bridge',
    points: [[-123.8313, 46.1879], [-123.874, 46.251]],
    pointStateIds: ['oregon', 'washington'],
    maxStraightFactor: 3.5,
  },
  {
    name: 'The Dalles to Dallesport',
    points: [[-121.1787, 45.5946], [-121.18, 45.618]],
    pointStateIds: ['oregon', 'washington'],
    maxStraightFactor: 8,
  },
];

for (const routeCase of crossBorderCases) {
  const request = directRequest(routeCase.name, routeCase.points, routeCase.pointStateIds);
  const { result, progress } = await partitionRoute(request);
  const detail = JSON.stringify(compact(result));
  check(`${routeCase.name} crosses the released state graphs`,
    result.ok && routeCase.pointStateIds.every((stateId) => result.stateIds.includes(stateId))
      && result.jurisdictions.some((entry) => entry.stateId === 'washington')
      && result.jurisdictions.some((entry) => entry.stateId === 'oregon'), detail);
  check(`${routeCase.name} is sane and does not require a freeway`,
    result.ok && result.distM <= straightMetres(...routeCase.points) * routeCase.maxStraightFactor
      && result.freewayM <= 80, detail);
  check(`${routeCase.name} stays within the graph-input budget`,
    result.routingDiagnostics.partitionInput.rawInputBytes
      <= MultiStateRouting.MAX_DETAILED_GRAPH_INPUT_BYTES
      && progress.some((event) => event.phase === 'initial'), detail);
}

// Start with only disconnected endpoint cells. The real A* frontier report
// must identify and load the missing Oregon detail rather than interpreting
// the initial cell boundary as the end of the road network.
const expansionPoints = [[-123.8313, 46.1879], [-122.6765, 45.5231]];
const expansion = (await partitionRoute(directRequest('production-expansion',
  expansionPoints, ['oregon', 'oregon']),
{ selectInitialCorridor: endpointPartitionsOnly })).result;
check('a production route expands beyond disconnected endpoint partitions and then stabilizes',
  expansion.ok && expansion.routingDiagnostics.attempts.length > 1
    && expansion.routingDiagnostics.attempts[0].ok === false
    && expansion.routingDiagnostics.attempts.at(-1).ok === true
    && expansion.loadedPartitionIds.length > 2,
  JSON.stringify(compact(expansion)));

// Three ordered points cross the river twice. This exercises state-chain
// planning and worker leg stitching with a waypoint on each side.
const waypointPoints = [
  [-122.671, 45.638],
  [-122.6765, 45.5231],
  [-122.661, 45.62],
];
const waypointRequest = portfolioRequest('columbia-waypoint', waypointPoints,
  ['washington', 'oregon', 'washington']);
const waypoint = (await partitionRoute(waypointRequest)).result;
const waypointOption = waypoint.options?.[0];
check('a waypoint itinerary crosses both sides of the boundary in order',
  waypoint.ok && waypointOption?.legs?.length === 2
    && waypointOption.stateIds.includes('washington')
    && waypointOption.stateIds.includes('oregon')
    && waypointOption.jurisdictions.some((entry) => entry.stateId === 'washington')
    && waypointOption.jurisdictions.some((entry) => entry.stateId === 'oregon'),
  JSON.stringify({ reply: compact(waypoint), option: compact(waypointOption),
    legs: waypointOption?.legs?.length }));

done();
