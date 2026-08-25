#!/usr/bin/env node
// Long cross-state route-options over the released Washington/Oregon
// partitions. The direct-route crossings in test_production_partition_routes
// never popped a portal, so the portfolio path's frontier behavior on a long
// trip was unexercised: optimistic straight-line frontier bounds kept every
// portal "competitive" against a 17-hour worst option, and Seattle→Buckman
// re-ran its six-option portfolio five more times, loading Kitsap and
// Bellingham cells until 99.7% of the input budget was pinned. These gates
// hold the converged behavior: a useful portfolio, sane endpoint snaps, and
// at most one widening retry that did not pay off.
import { appDefaultRules, check, done, ROOT } from './testlib/harness.mjs';
import { productionPartitionRoute, productionCatalogue }
  from './testlib/partition_session.mjs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { MultiStateRouting } = require(join(ROOT, 'multi-state-routing.js'));
const { MultiStateRouteCoordinator } = require(join(ROOT, 'multi-state-route-coordinator.js'));
const rules = appDefaultRules();
const MI = 1609.344;

// The router snaps up to 2 km, so corridor planning must include every
// same-state partition whose data could hold the snapped street. A point on
// the Columbia shore just north of the 46.002° data boundary sits strictly
// inside the 873-node oregon/0057-136 sliver; without the snap margin the
// dense 0057-135 cell 900 m south is never loaded and the snap can fail
// point-too-far with no frontier hit to widen the corridor.
const sliverPoint = [-122.95, 46.010];
const sliverCorridor = MultiStateRouteCoordinator.selectInitialPartitionCorridor({
  catalogue: productionCatalogue, points: [sliverPoint, [-122.33006, 47.60383]],
  pointStateIds: ['oregon', 'washington'],
  routeStateIds: ['oregon', 'washington'],
  budgetBytes: MultiStateRouting.MAX_DETAILED_GRAPH_INPUT_BYTES,
});
check('a point near a sparse cell boundary loads every snap-range partition',
  sliverCorridor.pointPartitionIds[0].includes('oregon/grid-1000000/0057-136')
    && sliverCorridor.pointPartitionIds[0].includes('oregon/grid-1000000/0057-135'),
  JSON.stringify(sliverCorridor.pointPartitionIds));

const SEATTLE = [-122.33006, 47.60383];

// Buckman (inner east side) and St. Johns (north peninsula) are far apart
// inside Portland and snap into dense local streets; Sellwood rides from
// Vancouver keep a short cross-border portfolio in the same gate.
const cases = [
  { name: 'Seattle to Buckman', start: SEATTLE, end: [-122.65195, 45.51738],
    startState: 'washington', minStraightKm: 200 },
  // Seattle -> St. Johns rode here too: a third 200 km portfolio over the
  // same corridor and partitions as Buckman, differing only in which dense
  // Portland neighborhood it snapped into. One long portfolio plus the short
  // cross-border one hold the same convergence and budget gates at two
  // thirds of this file's cost.
  { name: 'Vancouver to Sellwood', start: [-122.671, 45.638], end: [-122.6647, 45.4640],
    startState: 'washington', minStraightKm: 15 },
];

function straightMetres(a, b) {
  const lat = (a[1] + b[1]) * Math.PI / 360;
  const dx = (b[0] - a[0]) * Math.cos(lat) * 111_195;
  const dy = (b[1] - a[1]) * 111_195;
  return Math.hypot(dx, dy);
}

for (const routeCase of cases) {
  const request = { type: 'route-options', id: routeCase.name,
    points: [routeCase.start, routeCase.end],
    pointStateIds: [routeCase.startState, 'oregon'], rules,
    forceDesignated: true, forceResidential: true };
  const { result } = await productionPartitionRoute(request);
  const options = result.options || [];
  const best = options.reduce((fastest, option) =>
    (option.timeS < fastest.timeS ? option : fastest), options[0] || null);
  const attempts = result.routingDiagnostics?.attempts || [];
  const detail = JSON.stringify({ ok: result.ok, reason: result.reason,
    options: options.length, attempts: attempts.map((a) =>
      ({ retry: a.retry, partitions: a.loadedPartitionIds.length,
        hits: a.frontierHitCount, ok: a.ok })),
    best: best && { distMi: +(best.distM / MI).toFixed(1),
      snapStartM: Math.round(best.snapStartM), snapEndM: Math.round(best.snapEndM),
      freewayMi: +(best.freewayM / MI).toFixed(2), stateIds: best.stateIds } });

  check(`${routeCase.name} route-options returns a useful cross-state portfolio`,
    result.ok && options.length >= 3
      && options.every((option) => option.stateIds.includes('washington')
        && option.stateIds.includes('oregon')), detail);
  check(`${routeCase.name} snaps both endpoints onto nearby local streets`,
    !!best && best.snapStartM <= 150 && best.snapEndM <= 150, detail);
  check(`${routeCase.name} is sane and avoids freeways`,
    !!best && best.distM <= straightMetres(routeCase.start, routeCase.end) * 2.2
      && best.distM >= routeCase.minStraightKm * 1000 && best.freewayM <= 80, detail);
  check(`${routeCase.name} converges instead of re-searching to budget exhaustion`,
    attempts.length <= 2 && attempts.every((a) => a.ok)
      && result.routingDiagnostics.partitionInput.rawInputBytes
        <= MultiStateRouting.MAX_DETAILED_GRAPH_INPUT_BYTES, detail);
}

done();
