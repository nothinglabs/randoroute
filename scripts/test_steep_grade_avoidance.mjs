#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { routerWorker } from './testlib/harness.mjs';

const worker = fs.readFileSync(new URL('../router-worker.js', import.meta.url), 'utf8');
const start = worker.indexOf('const GRADUAL_UPHILL_AVOID_PCT');
const end = worker.indexOf('// Fixed intersection friction', start);
assert.ok(start >= 0 && end > start, 'steep-grade avoidance helper source was not found');

const context = {
  eFlags: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 32]),
  // 9%, 10%, 12%, 13%, 14%, 15%, downhill 15%, and a ferry respectively.
  eAsc: new Float32Array([9, 10, 12, 13, 14, 15, 0, 20]),
  eDes: new Float32Array([0, 0, 0, 0, 0, 0, 15, 0]),
  eLen: new Float32Array([100, 100, 100, 100, 100, 100, 100, 100]),
};
vm.createContext(context);
vm.runInContext(worker.slice(start, end), context);

assert.equal(context.steepUphillAvoidanceS(0, true, 'balanced'), 0,
  'an ordinary 9% uphill should not receive the extra route-choice cost');
const at10 = context.steepUphillAvoidanceS(1, true, 'balanced');
const at12 = context.steepUphillAvoidanceS(2, true, 'balanced');
const at13 = context.steepUphillAvoidanceS(3, true, 'balanced');
const at14 = context.steepUphillAvoidanceS(4, true, 'balanced');
const at15 = context.steepUphillAvoidanceS(5, true, 'balanced');
assert.ok(at10 > 0 && at12 > at10,
  'a 9–12% climb should receive a light but growing route-choice cost');
assert.ok(at13 > at12 * 9,
  'an uphill above 12% should receive a materially stronger cost');
assert.ok(at14 > at13 * 3,
  'the penalty should rise sharply through 14%');
assert.equal(at15, 2400, 'very steep uphill penalties should cap instead of becoming a de facto ban');
assert.equal(context.steepUphillAvoidanceS(6, true, 'balanced'), 0,
  'downhill riding should not receive an uphill steepness penalty');
assert.equal(context.steepUphillAvoidanceS(7, true, 'balanced'), 0,
  'ferries should never receive a grade penalty');
assert.ok(context.steepUphillAvoidanceS(4, true, 'low') > at14,
  'friendly routes should be more steep-grade averse than balanced routes');
assert.equal(context.steepUphillAvoidanceS(4, true, 'direct'), at14,
  'direct routes should not discount a physically unbikeable steep grade');
// The grade penalty is ADDED after the facility bonus is applied, never
// multiplied by it -- a path bonus must not shrink the cost of a genuinely
// steep climb. This used to be checked by searching router-worker.js for the
// literal `cost += steepUphillAvoidanceS(ei, forward, mode);` and comparing
// string offsets. That pins a spelling rather than a behaviour: it broke the
// moment the cost moved into edgeCost(), and it would have passed just as
// happily if the term had been folded into the multiply on the same line.
//
// Ask edgeCost() on the real graph instead. On an edge carrying both a bike
// facility and a steep grade the total must still be at least the full
// penalty; folded into the multiply it would land near a fifth of it.
const w = routerWorker();
const additive = w.run(`(() => {
  const rules = { minShoulder: 4, maxSpeedNoShoulder: 25, upperMaxSpeed: 45,
    noUpperLimit: true, lanesNoShoulderOver: 4, busyNoShoulder: 2,
    allowSidewalkFallback: true, allowFreeways: true, allowMtbTrails: false,
    inferShoulderFromEdge: false, requireSafe: false };
  const ctx = { mode: 'balanced', modeW: modeWeights('balanced'), rules,
    searchRules: rules, prefDesig: false, prefResidential: false };
  for (let e = 0; e < E; e++) {
    if (eFacility[e] < 2) continue;
    const penalty = steepUphillAvoidanceS(e, true, 'balanced');
    if (!(penalty > 0)) continue;
    const total = edgeCost(e, true, ctx);
    if (!(total < Infinity)) continue;
    return { edge: e, total, penalty, bonus: facilityPrefMult(eFacility[e]) };
  }
  return null;
})()`);
assert.ok(additive, 'the graph should carry a steep edge with a bike facility');
assert.ok(additive.total >= additive.penalty,
  'the facility bonus must not shrink the steep-grade penalty '
  + `(cost ${additive.total.toFixed(1)} < penalty ${additive.penalty.toFixed(1)}, `
  + `bonus ${additive.bonus})`);

// Turn friction is a TRANSITION cost: it belongs to the pair of edges, not to
// the edge, so it appears only when edgeCost is given the arrival state.
const turn = w.run(`(() => {
  const rules = { minShoulder: 4, maxSpeedNoShoulder: 25, upperMaxSpeed: 45,
    noUpperLimit: true, lanesNoShoulderOver: 4, busyNoShoulder: 2,
    allowSidewalkFallback: true, allowFreeways: true, allowMtbTrails: false,
    inferShoulderFromEdge: false, requireSafe: false };
  const base = { mode: 'balanced', modeW: modeWeights('balanced'), rules,
    searchRules: rules, prefDesig: false, prefResidential: false };
  for (let n = 0; n < N; n++) {
    if (outStart[n + 1] - outStart[n] < 2) continue;
    const into = outEdge[outStart[n]], out = outEdge[outStart[n] + 1];
    if (into === out) continue;
    const plain = edgeCost(out, eA[out] === n, base);
    const turned = edgeCost(out, eA[out] === n, { ...base, fromNode: n, incomingEdge: into });
    if (!(plain < Infinity) || !(turned < Infinity)) continue;
    const expected = turnPreferenceS(into, n, out, 'balanced');
    if (!(expected > 0)) continue;
    return { plain, turned, expected };
  }
  return null;
})()`);
assert.ok(turn, 'the graph should offer a node with two outgoing edges that turn');
assert.ok(Math.abs((turn.turned - turn.plain) - turn.expected) < 1e-6,
  `turn friction should be added once, whole: ${turn.turned - turn.plain} vs ${turn.expected}`);
