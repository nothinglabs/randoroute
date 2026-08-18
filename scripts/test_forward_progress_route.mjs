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
  const snaps = points.map((point) => nearestNode(point[0], point[1], rules));
  const seed = route(points, rules, 'direct', false, false, snaps);
  const raw = [seed];
  const alternative = addForwardProgressCandidate(raw, points, rules, false, false, snaps);
  return {
    seedRetreatM: routeMaxRetreatM(seed, points[1]),
    alternativeRetreatM: alternative && routeMaxRetreatM(alternative, points[1]),
    alternativeId: alternative && alternative._profile.id,
    alternativeDistanceM: alternative && alternative.distM,
    seedFailM: seed.failM,
    alternativeFailM: alternative && alternative.failM,
  };
})()`);

assert.ok(result.seedRetreatM > 300,
  `field route should expose its bridge backtrack, got ${result.seedRetreatM.toFixed(0)} m`);
assert.equal(result.alternativeId, 'forward-progress');
assert.ok(result.alternativeRetreatM < result.seedRetreatM - 150,
  `alternative should remove the large retreat (${result.seedRetreatM.toFixed(0)} -> ${result.alternativeRetreatM.toFixed(0)} m)`);
assert.ok(result.alternativeDistanceM < 7000,
  `alternative should remain practical, got ${result.alternativeDistanceM.toFixed(0)} m`);
assert.ok(result.alternativeFailM <= result.seedFailM + 1,
  `alternative must not buy directness with more failing road (${result.seedFailM.toFixed(0)} -> ${result.alternativeFailM.toFixed(0)} m)`);

console.log('PASS forward-progress route candidate');
