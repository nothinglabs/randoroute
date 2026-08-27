#!/usr/bin/env node
// The facility-neutral diversity round (rider direction, 2026-08-27): every
// portfolio runs one extra Balanced search with the facility discounts moved
// halfway to neutral, to surface near-tie corridors that lose only because
// trail miles are priced shorter. Everything here RUNS the worker on the
// real Washington graph: the halving math, the candidate reaching the
// portfolio on the field case that motivated it, and the weights being
// restored so nothing later prices under the lens.
import { appDefaultRules, check, done, routerWorker } from './testlib/harness.mjs';

const worker = routerWorker();
check('worker loads the graph', worker.ready);

// The halving is sqrt — halfway to neutral in log space — applied only to
// the facility keys, and a neutral weight stays neutral.
const math = worker.run(`(() => {
  const out = facilityNeutralWeights({ ...DEFAULT_WEIGHTS });
  return { path: out.facilityPath, lane: out.facilityLane,
    shared: out.facilityShared, desig: out.strongDesignated,
    residential: out.residential, failBalanced: out.failRoadBalanced,
    identity: facilityNeutralWeights({ ...DEFAULT_WEIGHTS, facilityPath: 1 }).facilityPath };
})()`);
check('facility discounts move halfway to neutral; nothing else moves',
  math.path === 0.5 && math.lane === +Math.sqrt(0.42).toFixed(4)
    && math.shared === +Math.sqrt(0.75).toFixed(4)
    && math.desig === +Math.sqrt(0.5).toFixed(4)
    && math.residential === 0.6 && math.failBalanced > 1 && math.identity === 1,
  JSON.stringify(math));

// Ravenna -> Phinney Ridge, the field case where every ordinary candidate
// collapsed onto one greenway corridor. The facility-neutral candidate must
// reach the portfolio (at first shipping it IS offered — a distinct, shorter
// corridor), price honestly under the rider's rules, and leave the weights
// exactly as it found them.
const trip = worker.post({ type: 'route-options', id: 811,
  start: [-122.3070, 47.6760], end: [-122.3543, 47.6684],
  rules: appDefaultRules() });
const row = (trip.allCandidates || []).find((c) => c.profileId === 'facility-neutral');
check('the facility-neutral candidate runs in every portfolio',
  !!row && Number.isFinite(row.distM) && row.distM > 1000,
  JSON.stringify(row));
check('on the motivating trip it survives to the offered portfolio',
  !!row?.presented && (trip.options || []).length >= 2,
  JSON.stringify({ presented: row?.presented, stage: row?.stage,
    options: (trip.options || []).length }));
check('its route is honestly priced under the rider\'s own rules',
  row && row.failM < 200, `failM ${row?.failM}`);
check('the routes-considered page can say why it exists',
  typeof row?.why === 'string' && row.why.includes('halved'), row?.why);

const restored = worker.run(`activeWeights.facilityPath === DEFAULT_WEIGHTS.facilityPath
  && activeWeights.facilityShared === DEFAULT_WEIGHTS.facilityShared
  && activeWeights.strongDesignated === DEFAULT_WEIGHTS.strongDesignated
  && weightsSignature === JSON.stringify(activeWeights)`);
check('the lens weights are fully restored after the request', restored === true,
  String(restored));

done();
