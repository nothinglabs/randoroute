#!/usr/bin/env node
// The per-arc cost cache is a pure memo: it must never change WHICH routes
// come back, only how fast. Two hazards are pinned here. Float32 storage --
// the filling search must price an arc exactly as every later cache hit will
// (the fill reads back through the store), or a cold and a warm run of the
// same request could disagree in the last float digit and flip a tie. And
// the idle pre-warm -- a sweep-filled cache must be indistinguishable from
// an organically filled one.
import assert from 'node:assert/strict';
import { routerWorker } from './testlib/harness.mjs';

const RULES = { allowFreeways: true, allowMtbTrails: false, preferPaved: true,
  minShoulder: 4, inferShoulderFromEdge: true, maxSpeedNoShoulder: 35,
  lanesNoShoulderOver: 3, busyNoShoulder: 2, allowSidewalkFallback: true,
  upperMaxSpeed: 45, noUpperLimit: true, requireSafe: false };
const TRIP = [[-122.335, 47.61], [-122.355, 47.668]];
const request = (id) => ({ type: 'route-options', id, rules: RULES, points: TRIP });
const signature = (reply) => reply.options.map((option) =>
  `${option.optimization.profileId}:${Math.round(option.distM)}:${Math.round(option.timeS)}`
  + `:${Math.round(option.failM)}`).join(' | ');

// Cold fill, then the same request answered from the warm cache.
const worker = routerWorker({ fresh: true });
const cold = worker.post(request('cold'));
assert.ok(cold.ok && cold.options.length, 'the cold request should answer');
const warm = worker.post(request('warm'));
assert.equal(signature(warm), signature(cold),
  'a cache-hit run must return exactly the cold run’s routes');

// A sweep-warmed worker must match the organically warmed one. One config
// keeps the sweep fast; the parity property is per-config.
const swept = routerWorker({ fresh: true });
swept.post({ type: 'prewarm', id: 'w', rules: RULES, weights: null,
  configs: [{ mode: 'direct', prefDesig: false, prefResidential: false }] });
const deadline = Date.now() + 300000;
while (!swept.messages.some((m) => m.type === 'prewarm-done')) {
  assert.ok(Date.now() < deadline, 'the pre-warm sweep should complete');
  await new Promise((resolve) => setTimeout(resolve, 200));
}
const done = swept.messages.find((m) => m.type === 'prewarm-done');
assert.ok(done.filled > 100000, `the sweep should fill real arcs (${done.filled})`);
const sweptReply = swept.post(request('swept'));
assert.equal(signature(sweptReply), signature(cold),
  'a pre-warmed run must return exactly the cold run’s routes');

console.log(`Cache parity holds: cold, warm and pre-warmed runs agree on `
  + `${cold.options.length} routes (${done.filled.toLocaleString()} arcs swept).`);
