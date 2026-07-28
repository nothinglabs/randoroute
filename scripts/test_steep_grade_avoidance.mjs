#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

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
const routeLoop = worker.indexOf('let cost = step * mult;');
// The bonus block: a facility if the edge has one, designation otherwise.
const facilityBonus = worker.indexOf('cost *= eFacility[ei]', routeLoop);
const steepCost = worker.indexOf('cost += steepUphillAvoidanceS(ei, forward, mode);', routeLoop);
const turnCost = worker.indexOf('cost += turnPreferenceS(', routeLoop);
assert.ok(facilityBonus > routeLoop && steepCost > facilityBonus && turnCost > steepCost,
  'A* should apply steep-grade cost after facility and route-preference multipliers');

console.log('Steep grade avoidance tests passed.');
