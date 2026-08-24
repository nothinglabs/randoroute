#!/usr/bin/env node
// The router's eFacility decoder mirrors the builder's packing
// (test_directional_facility.py owns the tag->pair mapping): low nibble is
// the A->B rung, high nibble 0 means the same rung both ways — which is what
// every previously built graph contains, so legacy bytes must decode
// symmetrically — and any other high nibble is the B->A rung + 1. The two
// functions are LIFTED from router-worker.js and driven against a stub
// eFacility array, so this asserts what the shipped decoder does.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const workerSrc = fs.readFileSync(new URL('../router-worker.js', import.meta.url), 'utf8');

function lift(name) {
  const re = new RegExp(`\\nfunction ${name}\\s*\\([^)]*\\)\\s*\\{`);
  const at = workerSrc.search(re);
  assert.notEqual(at, -1, `router-worker.js should define ${name}`);
  let depth = 0;
  for (let j = workerSrc.indexOf('{', at); j < workerSrc.length; j++) {
    if (workerSrc[j] === '{') depth++;
    else if (workerSrc[j] === '}' && --depth === 0) return workerSrc.slice(at + 1, j + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const context = { eFacility: null };
vm.createContext(context);
vm.runInContext(`${lift('edgeFacility')}\n${lift('edgeFacilityBest')}`, context);
const decode = (packed) => {
  context.eFacility = [packed];
  return {
    forward: vm.runInContext('edgeFacility(0, true)', context),
    reverse: vm.runInContext('edgeFacility(0, false)', context),
    best: vm.runInContext('edgeFacilityBest(0)', context),
  };
};

// Every legacy byte (a bare rung) decodes symmetrically.
for (let rung = 0; rung <= 5; rung++) {
  assert.deepEqual(decode(rung), { forward: rung, reverse: rung, best: rung },
    `legacy byte ${rung} must stay symmetric`);
}

// The field case: a right-side lane on a two-way street (packed 0x12) is a
// lane ahead and a bare road back.
assert.deepEqual(decode(2 | (1 << 4)), { forward: 2, reverse: 0, best: 2 });
// A left-side lane (packed 0x30) is the mirror.
assert.deepEqual(decode(3 << 4), { forward: 0, reverse: 2, best: 2 });
// Mixed rungs: lane ahead, sharrow back.
assert.deepEqual(decode(2 | (2 << 4)), { forward: 2, reverse: 1, best: 2 });
// Exhaustive round-trip against the builder's packing formula.
for (let forward = 0; forward <= 5; forward++) {
  for (let reverse = 0; reverse <= 5; reverse++) {
    const packed = forward | (reverse === forward ? 0 : (reverse + 1) << 4);
    assert.deepEqual(decode(packed),
      { forward, reverse, best: Math.max(forward, reverse) },
      `pair ${forward}/${reverse}`);
  }
}

console.log('directional facility decode: all checks passed');
