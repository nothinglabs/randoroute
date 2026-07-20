#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const worker = fs.readFileSync(new URL('../router-worker.js', import.meta.url), 'utf8');
const start = worker.indexOf('function turnPreferenceS');
const end = worker.indexOf('function routeGradeStats', start);
assert.ok(start >= 0 && end > start, 'turn preference helper source was not found');

const context = {
  eA: new Uint32Array([0, 1, 1, 1, 1, 1]),
  eBearingA: new Float32Array([0, 90, 0, 40, 180, 40]),
  eBearingB: new Float32Array([180, 90, 0, 40, 180, 40]),
  eName: new Uint32Array([1, 2, 3, 1, 4, 0]),
  // Name 0 is empty; all other ids are non-empty.
  nameOff: new Uint32Array([0, 0, 1, 2, 3, 4]),
  activeWeights: { turnDirectSec: 6, turnBalancedSec: 11, turnLowSec: 15 },
};
vm.createContext(context);
vm.runInContext(worker.slice(start, end), context);

assert.equal(context.turnPreferenceS(-1, 1, 1, 'balanced'), 0,
  'the first road should not have a turn cost');
assert.equal(context.turnPreferenceS(0, 1, 2, 'balanced'), 0,
  'a straight continuation should not have a turn cost');
assert.equal(context.turnPreferenceS(0, 1, 3, 'balanced'), 0,
  'an ordinary bend on the same named road should not have a turn cost');
context.eName[0] = 0;
assert.equal(context.turnPreferenceS(0, 1, 5, 'balanced'), 11 * 0.65,
  'two unnamed edges should not be assumed to be the same road');
context.eName[0] = 1;
assert.equal(context.turnPreferenceS(0, 1, 1, 'direct'), 6,
  'a right turn should receive the direct-mode cost');
assert.equal(context.turnPreferenceS(0, 1, 1, 'balanced'), 11,
  'a right turn should receive the balanced-mode cost');
assert.equal(context.turnPreferenceS(0, 1, 1, 'low'), 15,
  'a right turn should receive the friendly-mode cost');
assert.equal(context.turnPreferenceS(0, 1, 4, 'balanced'), 22,
  'a reversal should cost twice an ordinary turn');
assert.match(worker, /cost \+= turnPreferenceS\(incomingEdge, u, ei, mode\)/,
  'A* should include turn friction as a transition cost');

console.log('Turn preference tests passed.');
