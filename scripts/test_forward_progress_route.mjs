#!/usr/bin/env node
import assert from 'node:assert/strict';
import { routerWorker } from './testlib/harness.mjs';

const worker = routerWorker({ fresh: true });
const points = [[-122.31758, 47.65756], [-122.3507, 47.6685]];
const rules = {
  allowFreeways: true,
  allowMtbTrails: false,
  preferPaved: true,
  minShoulder: 4,
  inferShoulderFromEdge: true,
  maxSpeedNoShoulder: 35,
  lanesNoShoulderOver: 3,
  busyNoShoulder: 2,
  allowSidewalkFallback: true,
  upperMaxSpeed: 45,
  noUpperLimit: true,
  requireSafe: false,
};

const result = worker.run(`(() => {
  const points = ${JSON.stringify(points)};
  const rules = ${JSON.stringify(rules)};
  const main = { ...activeWeights };
  // Production also runs an aggressive direct lens. It owns the shortest
  // endpoint in the six-route picker; .753 generated the forward-progress
  // route but then let this lens crowd it back out.
  const lens = { ...main,
    failRoadDirect: 1.093, failRoadBalanced: 1.621, failRoadLowStress: 2.114,
    facilityShared: 0.957, facilityLane: 0.817, facilityBuffered: 0.799,
    facilitySeparated: 0.762, facilityPath: 0.668 };
  const portfolio = routeOptions(points, rules, false, false, null, true, null,
    'forward-progress-production-regression', main, lens);
  // Offered first, then the full generated pool. What this file is about is
  // whether a forward-progress route EXISTS and removes the seed's retreat --
  // not which six candidates win letters. Reading only the offered board made
  // it a selection test by accident, and .780's diversity sweep duly swapped
  // 'quick' off this trip's board and turned the whole file into a crash
  // reading failM off undefined. lastCandidates holds every candidate built, with
  // geometry; publicCandidate gives it the shape the assertions below expect.
  const offered = new Map(portfolio.options.map((o) => [o.optimization.profileId, o]));
  const built = (id) => offered.get(id)
    || (lastCandidates.has(id) ? publicCandidate(lastCandidates.get(id)) : undefined);
  const seed = built('quick');
  const aggressive = built('direct-lens');
  const alternative = built('forward-progress');
  return {
    seedWasOffered: offered.has('quick'),
    seedWasBuilt: !!seed,
    optionIds: portfolio.options.map((option) => option.optimization.profileId),
    builtIds: [...lastCandidates.keys()],
    hasAggressiveLens: !!aggressive,
    seedRetreatM: routeMaxRetreatM(seed, points[1]),
    alternativeRetreatM: alternative && routeMaxRetreatM(alternative, points[1]),
    alternativeId: alternative && alternative.optimization.profileId,
    alternativeDistanceM: alternative && alternative.distM,
    seedFailM: seed.failM,
    alternativeFailM: alternative && alternative.failM,
  };
})()`);

// Being crowded off the six-letter board is allowed -- that is the portfolio's
// job. Never being BUILT is not: the whole comparison below is against this
// route's retreat, and without it there is nothing to prove.
assert.ok(result.seedWasBuilt,
  'the quick profile was never generated for this trip, so there is no reference '
  + `route to measure the forward-progress alternative against. Built: ${result.builtIds?.join(', ')}`);
assert.ok(result.seedRetreatM > 300,
  `field route should expose its bridge backtrack, got ${result.seedRetreatM.toFixed(0)} m`);
assert.ok(result.hasAggressiveLens,
  `regression setup must include the competing direct lens (${result.optionIds.join(', ')})`);
assert.equal(result.alternativeId, 'forward-progress');
assert.ok(result.alternativeRetreatM < result.seedRetreatM - 150,
  `alternative should remove the large retreat (${result.seedRetreatM.toFixed(0)} -> ${result.alternativeRetreatM.toFixed(0)} m)`);
assert.ok(result.alternativeDistanceM < 7000,
  `alternative should remain practical, got ${result.alternativeDistanceM.toFixed(0)} m`);
assert.ok(result.alternativeFailM <= result.seedFailM + 1,
  `alternative must not buy directness with more failing road (${result.seedFailM.toFixed(0)} -> ${result.alternativeFailM.toFixed(0)} m)`);

console.log('PASS forward-progress route candidate');
