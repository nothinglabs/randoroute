#!/usr/bin/env node
// The major-road cost reads measured traffic before it reads OSM's tag.
//
// This is the first thing that lets the statewide AADT/functional-class import
// change where a rider is SENT rather than only what a card says, so the
// properties worth pinning are the ones that make that trustworthy:
//
//   1. `measuredTraffic: 0` reproduces the old OSM-only behaviour exactly. That
//      is what makes the change falsifiable on a real ride instead of an
//      unfalsifiable improvement.
//   2. A measurement can move a road DOWN as well as up. The reason the import
//      happened is that quiet county roads had no evidence beside state
//      highways that did; a rule that could only add cost would not fix that.
//   3. Cost never drops below 1. Every arterial weight is >= 1, and the A*
//      heuristic's admissibility argument assumes these are penalties, not
//      bonuses -- a blend that undershot 1 would silently break optimality.
//   4. The tier thresholds are the BUSY_LEVELS numbers from safety-model.js.
//      The verdict and the cost must not disagree about what "busy" means.
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({
  console, Date, Math, Map, Set, TextDecoder,
  ArrayBuffer, DataView, Float32Array, Float64Array, Int8Array, Int16Array,
  Int32Array, Uint8Array, Uint16Array, Uint32Array,
  postMessage: () => {},
});
context.importScripts = (...names) => {
  for (const n of names) {
    vm.runInContext(fs.readFileSync(new URL(`../${n}`, import.meta.url), 'utf8'), context);
  }
};
context.self = context;
vm.runInContext(fs.readFileSync(new URL('../router-worker.js', import.meta.url), 'utf8'), context);

// Stand up just enough graph state for majorRoadMult. One edge, dialled per case.
function setEdge({ cls = 0, adt = 0, fc = 0, facility = 0 }) {
  vm.runInContext(`
    eClass = new Uint8Array([${cls}]);
    eFacility = new Uint8Array([${facility}]);
    eFlags = new Uint8Array([0]);
    eAdt = new Uint16Array([${adt}]);
    eClassOwner = new Uint8Array([${fc}]);
    eLimitedDir = new Uint8Array([0]);
  `, context);
}
function mult(mode, weights) {
  vm.runInContext(`useWeights(${JSON.stringify(weights || {})})`, context);
  return vm.runInContext(`majorRoadMult(0, '${mode}', true)`, context);
}

const W = vm.runInContext('DEFAULT_WEIGHTS', context);

/* ------------------------------------------- 1. zero reproduces OSM-only */
// A residential-tagged road (class 1) carrying 20,000 vehicles a day: the
// measurement says primary arterial, the tag says nothing at all.
setEdge({ cls: 1, adt: 20000 });
assert.strictEqual(mult('balanced', { measuredTraffic: 0 }), 1,
  'measuredTraffic 0 must ignore the count entirely and price off the OSM tag');
assert.strictEqual(mult('balanced', { measuredTraffic: 1 }), W.arterialPrimaryBalanced,
  'measuredTraffic 1 must price a 20,000/day road as a primary arterial');

// Same edge, every mode, against the pure-OSM baseline.
for (const mode of ['direct', 'balanced', 'low']) {
  setEdge({ cls: 8, adt: 0, fc: 0 });          // primary tag, no measurement
  const tagged = mult(mode, { measuredTraffic: 1 });
  const off = mult(mode, { measuredTraffic: 0 });
  assert.strictEqual(tagged, off,
    `${mode}: an edge with no measurement must price identically either way`);
}

/* ------------------------------------- 2. a measurement can lower the cost */
// The case the import exists for: OSM calls it secondary, the county counted
// 900 vehicles a day on it. It should stop being priced as an arterial.
setEdge({ cls: 6, adt: 900 });
const quietMeasured = mult('low', { measuredTraffic: 1 });
const quietTagOnly = mult('low', { measuredTraffic: 0 });
assert.strictEqual(quietTagOnly, W.arterialSecondaryLow, 'baseline: tag says secondary');
assert.strictEqual(quietMeasured, 1,
  'a counted-quiet road must shed the arterial cost its OSM tag implied');
assert.ok(quietMeasured < quietTagOnly, 'measurement must be able to move cost DOWN');

/* ------------------------------------------------- functional-class fallback */
// No count, but the agency classes it a minor arterial (FHWA 4).
setEdge({ cls: 1, adt: 0, fc: 4 });
assert.strictEqual(mult('balanced', { measuredTraffic: 1 }), W.arterialSecondaryBalanced,
  'with no count, the official functional class stands in');
// A count always beats the class when both exist.
setEdge({ cls: 1, adt: 500, fc: 3 });
assert.strictEqual(mult('balanced', { measuredTraffic: 1 }), 1,
  'a measured count outranks the functional class');

/* ------------------------------------------------------ 3. never below 1 */
// Blend across the full range on an edge where measurement and tag disagree in
// both directions, and confirm the result stays a penalty.
for (const [cls, adt] of [[8, 100], [1, 20000], [6, 900], [4, 30000]]) {
  setEdge({ cls, adt });
  for (let b = 0; b <= 1.0001; b += 0.05) {
    for (const mode of ['direct', 'balanced', 'low']) {
      const m = mult(mode, { measuredTraffic: Number(b.toFixed(2)) });
      assert.ok(m >= 1, `cls=${cls} adt=${adt} blend=${b.toFixed(2)} ${mode}: ${m} < 1`);
      assert.ok(Number.isFinite(m), `cls=${cls} adt=${adt} blend=${b.toFixed(2)}: not finite`);
    }
  }
}

/* ------------------------------------------ blend is monotone and continuous */
setEdge({ cls: 1, adt: 20000 });
let prev = -Infinity;
for (let b = 0; b <= 1.0001; b += 0.1) {
  const m = mult('low', { measuredTraffic: Number(b.toFixed(2)) });
  assert.ok(m >= prev, 'blending toward the measurement must move cost monotonically');
  prev = m;
}
assert.ok(Math.abs(mult('low', { measuredTraffic: 0.5 })
  - (1 + W.arterialPrimaryLow) / 2) < 1e-9, 'half blend must be the midpoint');

/* ------------------------------- 4. thresholds agree with the safety model */
const model = fs.readFileSync(new URL('../safety-model.js', import.meta.url), 'utf8');
for (const adt of [500, 2000, 6000, 15000]) {
  assert.ok(model.includes(`adt: ${adt}`),
    `BUSY_LEVELS must still carry ${adt}; the cost tiers are pinned to it`);
}
const router = fs.readFileSync(new URL('../router-worker.js', import.meta.url), 'utf8');
for (const adt of [2000, 6000, 15000]) {
  assert.ok(router.includes(`> ${adt}`),
    `the cost tier at ${adt} must match BUSY_LEVELS, not drift from it`);
}

/* ---------------------------------------------- a bike facility still exempts */
setEdge({ cls: 8, adt: 30000, facility: 1 });
assert.strictEqual(mult('low', { measuredTraffic: 1 }), 1,
  'any recorded facility must still clear the no-facility proxy penalty');

console.log('ok - measured traffic drives the major-road cost, and zeroes out cleanly');
