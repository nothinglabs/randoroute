#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const worker = fs.readFileSync(new URL('../router-worker.js', import.meta.url), 'utf8');
const start = worker.indexOf('const STEEP_UPHILL_AVOID_PCT');
const end = worker.indexOf('// Fixed intersection friction', start);
assert.ok(start >= 0 && end > start, 'steep-grade avoidance helper source was not found');

const context = {
  eFlags: new Uint8Array([0, 0, 0, 0, 0, 0, 32]),
  // 9%, 12%, 13%, 14%, 15%, downhill 15%, and a ferry respectively.
  eAsc: new Float32Array([9, 12, 13, 14, 15, 0, 20]),
  eDes: new Float32Array([0, 0, 0, 0, 0, 15, 0]),
  eLen: new Float32Array([100, 100, 100, 100, 100, 100, 100]),
};
vm.createContext(context);
vm.runInContext(worker.slice(start, end), context);

assert.equal(context.steepUphillAvoidanceS(0, true, 'balanced'), 0,
  'an ordinary 9% uphill should not receive the steep-grade avoidance cost');
assert.equal(context.steepUphillAvoidanceS(1, true, 'balanced'), 0,
  'an uphill at exactly 12% should not receive the extra avoidance cost');
const at13 = context.steepUphillAvoidanceS(2, true, 'balanced');
const at14 = context.steepUphillAvoidanceS(3, true, 'balanced');
const at15 = context.steepUphillAvoidanceS(4, true, 'balanced');
assert.ok(at13 > 0, 'an uphill above 12% should receive a route-choice penalty');
assert.ok(at14 > at13 * 3, 'the penalty should rise sharply through 14%');
assert.equal(at15, 180, 'very steep uphill penalties should cap instead of becoming a de facto ban');
assert.equal(context.steepUphillAvoidanceS(5, true, 'balanced'), 0,
  'downhill riding should not receive an uphill steepness penalty');
assert.equal(context.steepUphillAvoidanceS(6, true, 'balanced'), 0,
  'ferries should never receive a grade penalty');
assert.ok(context.steepUphillAvoidanceS(3, true, 'low') > at14,
  'friendly routes should be more steep-grade averse than balanced routes');
assert.ok(context.steepUphillAvoidanceS(3, true, 'direct') < at14,
  'direct routes should retain the least, but still meaningful, steep-grade penalty');
const routeLoop = worker.indexOf('let cost = step * mult;');
const facilityBonus = worker.indexOf('const facilityBonus =', routeLoop);
const steepCost = worker.indexOf('cost += steepUphillAvoidanceS(ei, forward, mode);', routeLoop);
const turnCost = worker.indexOf('cost += turnPreferenceS(', routeLoop);
assert.ok(facilityBonus > routeLoop && steepCost > facilityBonus && turnCost > steepCost,
  'A* should apply steep-grade cost after facility and route-preference multipliers');

console.log('Steep grade avoidance tests passed.');
