#!/usr/bin/env node
// The major-road cost reads measured traffic before it reads OSM's tag.
//
// This is the first thing that lets the statewide AADT/functional-class import
// change where a rider is SENT rather than only what a card says, so the
// properties worth pinning are the ones that make that trustworthy:
//
//   1. `useMeasuredTraffic: 0` reproduces the old OSM-only behaviour exactly. That
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
  // The cost functions take the mode's resolved weight record rather than the
  // mode name: building 'busyHeavy' + suffix per edge relaxation was costing
  // real time in the router's innermost loop.
  return vm.runInContext(`majorRoadMult(0, modeWeights('${mode}'), true)`, context);
}

const W = vm.runInContext('DEFAULT_WEIGHTS', context);

/* ------------------------------------------- 1. zero reproduces OSM-only */
// A residential-tagged road (class 1) carrying 20,000 vehicles a day: the
// measurement says primary arterial, the tag says nothing at all.
setEdge({ cls: 1, adt: 20000 });
assert.strictEqual(mult('balanced', { useMeasuredTraffic: 0 }), 1,
  'useMeasuredTraffic 0 must ignore the count entirely and price off the OSM tag');
assert.strictEqual(mult('balanced', { useMeasuredTraffic: 1 }), W.busyHeavyBalanced,
  'useMeasuredTraffic 1 must price a 20,000/day road as a primary arterial');

// Same edge, every mode, against the pure-OSM baseline.
for (const mode of ['direct', 'balanced', 'low']) {
  setEdge({ cls: 8, adt: 0, fc: 0 });          // primary tag, no measurement
  const tagged = mult(mode, { useMeasuredTraffic: 1 });
  const off = mult(mode, { useMeasuredTraffic: 0 });
  assert.strictEqual(tagged, off,
    `${mode}: an edge with no measurement must price identically either way`);
}

/* ------------------------------------- 2. a measurement can lower the cost */
// The case the import exists for: OSM calls it secondary, the county counted
// 900 vehicles a day on it. It should stop being priced as an arterial.
setEdge({ cls: 6, adt: 900 });
const quietMeasured = mult('low', { useMeasuredTraffic: 1 });
const quietTagOnly = mult('low', { useMeasuredTraffic: 0 });
assert.strictEqual(quietTagOnly, W.busyMediumLowStress, 'baseline: tag says secondary');
assert.strictEqual(quietMeasured, 1,
  'a counted-quiet road must shed the arterial cost its OSM tag implied');
assert.ok(quietMeasured < quietTagOnly, 'measurement must be able to move cost DOWN');

/* ------------------------------------------------- functional-class fallback */
// No count, but the agency classes it a minor arterial (FHWA 4).
setEdge({ cls: 1, adt: 0, fc: 4 });
assert.strictEqual(mult('balanced', { useMeasuredTraffic: 1 }), W.busyMediumBalanced,
  'with no count, the official functional class stands in');
// A count always beats the class when both exist.
setEdge({ cls: 1, adt: 500, fc: 3 });
assert.strictEqual(mult('balanced', { useMeasuredTraffic: 1 }), 1,
  'a measured count outranks the functional class');

/* ------------------------------------------------------ 3. never below 1 */
// Blend across the full range on an edge where measurement and tag disagree in
// both directions, and confirm the result stays a penalty.
for (const [cls, adt] of [[8, 100], [1, 20000], [6, 900], [4, 30000]]) {
  setEdge({ cls, adt });
  for (let b = 0; b <= 1.0001; b += 0.05) {
    for (const mode of ['direct', 'balanced', 'low']) {
      const m = mult(mode, { useMeasuredTraffic: Number(b.toFixed(2)) });
      assert.ok(m >= 1, `cls=${cls} adt=${adt} blend=${b.toFixed(2)} ${mode}: ${m} < 1`);
      assert.ok(Number.isFinite(m), `cls=${cls} adt=${adt} blend=${b.toFixed(2)}: not finite`);
    }
  }
}

/* ------------------------------------------ blend is monotone and continuous */
setEdge({ cls: 1, adt: 20000 });
let prev = -Infinity;
for (let b = 0; b <= 1.0001; b += 0.1) {
  const m = mult('low', { useMeasuredTraffic: Number(b.toFixed(2)) });
  assert.ok(m >= prev, 'blending toward the measurement must move cost monotonically');
  prev = m;
}
assert.ok(Math.abs(mult('low', { useMeasuredTraffic: 0.5 })
  - (1 + W.busyHeavyLowStress) / 2) < 1e-9, 'half blend must be the midpoint');

/* --------------------------- malformed input is clamped before edge scoring */
// With a heavy OSM tag and a quiet measurement, extrapolating far beyond 1
// used to cross zero and produce a negative cost. Both ends now clamp to the
// same behavior as the corresponding valid endpoint.
setEdge({ cls: 8, adt: 100 });
assert.strictEqual(mult('low', { useMeasuredTraffic: 999 }),
  mult('low', { useMeasuredTraffic: 1 }), 'a blend above 1 must clamp to 1');
assert.strictEqual(mult('low', { useMeasuredTraffic: -999 }),
  mult('low', { useMeasuredTraffic: 0 }), 'a blend below 0 must clamp to 0');
assert.ok(mult('low', { useMeasuredTraffic: 999 }) >= 1,
  'malformed traffic blending must never create a negative edge multiplier');

/* ------------------------------- 4. thresholds agree with the safety model */
const busyLevels = JSON.parse(vm.runInContext('JSON.stringify(SafetyModel.BUSY_LEVELS)', context));
assert.deepStrictEqual(busyLevels.map((level) => level.adt),
  [null, 500, 2000, 6000, 15000, null],
  'traffic-cost thresholds must come from the same levels the safety model presents');

setEdge({ cls: 1, adt: 2000 });
assert.strictEqual(mult('low', { useMeasuredTraffic: 1 }), 1,
  '2,000/day remains below the first traffic-cost tier');
setEdge({ cls: 1, adt: 2001 });
assert.strictEqual(mult('low', { useMeasuredTraffic: 1 }), W.busyLightLowStress,
  'the through-street cost tier starts above 2,000/day');
setEdge({ cls: 1, adt: 6001 });
assert.strictEqual(mult('low', { useMeasuredTraffic: 1 }), W.busyMediumLowStress,
  'the busy-arterial cost tier starts above 6,000/day');
setEdge({ cls: 1, adt: 15001 });
assert.strictEqual(mult('low', { useMeasuredTraffic: 1 }), W.busyHeavyLowStress,
  'the heaviest traffic-cost tier starts above 15,000/day');

/* -------- paint pays a share of traffic; separation exempts; sharrows pay */
setEdge({ cls: 8, adt: 30000, facility: 1 });
assert.strictEqual(mult('low', { useMeasuredTraffic: 1 }), W.busyHeavyLowStress,
  'a sharrow must not erase the measured-traffic cost');
// A painted lane no longer clears traffic pricing (2026-08-29): it pays
// lanedTrafficShare of the excess -- 0.3 by default, 0 restoring the old
// exemption, 1 pricing it like bare road. Separation stays exempt.
setEdge({ cls: 8, adt: 30000, facility: 2 });
assert.strictEqual(mult('low', { useMeasuredTraffic: 1 }),
  +(1 + (W.busyHeavyLowStress - 1) * W.lanedTrafficShare).toFixed(4),
  'a painted lane pays the default share of the traffic cost');
assert.strictEqual(mult('low', { useMeasuredTraffic: 1, lanedTrafficShare: 0 }), 1,
  'share 0 restores the old full exemption for paint');
assert.strictEqual(mult('low', { useMeasuredTraffic: 1, lanedTrafficShare: 1 }),
  W.busyHeavyLowStress,
  'share 1 prices a painted lane like bare road');
setEdge({ cls: 8, adt: 30000, facility: 4 });
assert.strictEqual(mult('low', { useMeasuredTraffic: 1, lanedTrafficShare: 1 }), 1,
  'physical separation stays exempt at any share');

/* ---------------- a sharrow preference may apply without changing safety */
vm.runInContext('useWeights({ facilityShared: 0.75 })', context);
assert.strictEqual(vm.runInContext('facilityPrefMult(1)', context), 0.75,
  'the shipped sharrow preference should be modest but visible');
assert.strictEqual(vm.runInContext('facilityRouteBonusApplies(1, 4)', context), true,
  'a sharrow keeps its route-choice benefit on a failing edge');
assert.strictEqual(vm.runInContext('facilityRouteBonusApplies(0, 4)', context), false,
  'an ordinary failing road receives no facility benefit');
assert.strictEqual(vm.runInContext('facilityRouteBonusApplies(2, 4)', context), false,
  'the exception is specific to sharrows, not every facility record');

console.log('ok - measured traffic and sharrow routing preferences remain independent');
