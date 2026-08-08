#!/usr/bin/env node
// The per-arc cost cache is a pure memo: it must never change WHICH routes
// come back, only how fast. Three hazards are pinned here. Float32 storage --
// the filling search must price an arc exactly as every later cache hit will
// (the fill reads back through the store), or a cold and a warm run of the
// same request could disagree in the last float digit and flip a tie. The
// idle pre-warm -- a sweep-filled cache must be indistinguishable from an
// organically filled one. And requireSafe -- deliberately absent from the
// cache key, so a strict request shares slots with ordinary ones; its x30
// access surcharge must be applied live and never stored, or one strict
// search would bend every ordinary search that follows.
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

// Toggle "fully matching" on, route, toggle it off, route again: the
// ordinary answer must be exactly what a fresh worker gives. A stored
// surcharge would surface here as a warm-only detour around a short
// failing crossing the cold run accepted.
const toggled = routerWorker({ fresh: true });
toggled.post({ ...request('strict'), rules: { ...RULES, requireSafe: true } });
const afterStrict = toggled.post(request('after-strict'));
assert.equal(signature(afterStrict), signature(cold),
  'an ordinary run after a requireSafe run must match a fresh worker');

// Phones must not carry a portfolio's reusable search memory into MapLibre's
// next zoom. Configure after the parity checks (the production app does it
// before graph load), then verify the command releases every disposable cache
// while retaining the candidate portfolio used by the More screen.
toggled.post({ type: 'configure', constrained: true });
assert.deepEqual(Array.from(toggled.run('[costSlotCap, floorSlotCap, potentialCap]')), [2, 2, 3],
  'a constrained worker should use the strict phone cache budget');
const trimmed = toggled.post({ type: 'trim-caches', id: 'phone-zoom' });
assert.equal(trimmed.type, 'trimmed');
assert.ok(trimmed.before.costSlots > 0 || trimmed.before.floorSlots > 0
  || trimmed.before.potentialEntries > 0, 'the test route should have reusable caches to release');
assert.ok(trimmed.before.reusableMiB > 0,
  'the trim report should quantify the reusable memory it releases');
assert.deepEqual({
  costSlots: trimmed.after.costSlots,
  floorSlots: trimmed.after.floorSlots,
  potentialEntries: trimmed.after.potentialEntries,
  verdictSlots: trimmed.after.verdictSlots,
  incidence: trimmed.after.incidence,
  potentialWork: trimmed.after.potentialWork,
}, {
  costSlots: 0, floorSlots: 0, potentialEntries: 0, verdictSlots: 0,
  incidence: false, potentialWork: false,
}, 'trimming should release every disposable routing cache');
assert.equal(trimmed.after.reusableMiB, 0,
  'no measured reusable routing memory should remain after trimming');
assert.equal(trimmed.candidatesRetained, true,
  'trimming should retain the portfolio used by the More screen');

console.log(`Cache parity holds: cold, warm, pre-warmed and strict-toggled runs `
  + `agree on ${cold.options.length} routes (${done.filled.toLocaleString()} arcs swept).`);
