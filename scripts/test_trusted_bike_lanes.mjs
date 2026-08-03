#!/usr/bin/env node
// "Always trust bike lanes (even on very busy roads)."
//
// A painted lane is space the rider is entitled to, and for a confident rider
// that settles it however the agency rates the road around it. The setting has
// to be narrow or it becomes a way to paint over real failures, so what this
// pins is mostly what it must NOT do -- and the one thing it must: leave the
// route exactly where it was.
import assert from 'node:assert/strict';
import { SafetyModel, routerWorker } from './testlib/harness.mjs';

const RIDER = {
  minShoulder: 4, maxSpeedNoShoulder: 35, upperMaxSpeed: 45, noUpperLimit: true,
  allowFreeways: false, allowMtbTrails: false, requireSafe: false,
  allowSidewalkFallback: true, preferPaved: true, inferShoulderFromEdge: true,
  lanesNoShoulderOver: 4, busyNoShoulder: 2, trustBikeLanes: true,
};
const off = (extra) => ({ ...RIDER, trustBikeLanes: false, ...extra });
const on = (extra) => ({ ...RIDER, trustBikeLanes: true, ...extra });

// Bothell-Everett Highway, as the road card reported it.
const BUSY = {
  speed: 40, shoulder: 0, lanes: 5, urban: true, stressRating: 4, adt: 21000, fc: 3,
};
const road = (extra) => SafetyModel.sealFacts({ ...BUSY, ...extra });
const level = (facts, rules) => SafetyModel.evaluate(facts, rules).level;

/* ------------------------------------------------------- what it does do */
const paintedBusy = road({ facility: 2 });
assert.equal(level(paintedBusy, off()), 3, 'off, a painted lane on an LTS 4 road cautions');
assert.equal(level(paintedBusy, on()), 2, 'on, it passes');
assert.equal(SafetyModel.evaluate(paintedBusy, on()).caution, null,
  'and carries no caution cause');
assert.equal(level(road({ facility: 3 }), on()), 2, 'a buffered lane comes along too');

/* --------------------------------------------- and what it must never do */
assert.equal(level(road({ facility: 1 }), on()), 4,
  'a sharrow is paint in the traffic lane, not a lane: it stays failing');
assert.equal(level(road({ facility: 0 }), on()), 4,
  'a road with no facility at all is untouched');
assert.equal(level(road({ facility: 2, speed: 60 }), on({ noUpperLimit: false })), 4,
  'a bike lane cannot carry a road past the rider speed ceiling');
assert.equal(level(road({ facility: 2, freeway: true }), on()), 4, 'nor onto a freeway');
assert.equal(level(road({ facility: 2, prohibited: true }), on()), 4,
  'nor where bicycles are banned');
assert.equal(SafetyModel.evaluate(road({ facility: 2, limitedAccess: true }), on()).caution,
  'limited-access',
  'a stripe does not fix a ramp merging across the rider, so that caution stands');

// The rating is a fact about the road and is still reported, whatever colour
// the rider has chosen to see.
assert.equal(SafetyModel.evaluate(paintedBusy, on()).highStress, true,
  'the stress rating is still reported at every level -- the voice needs it');

/* ------------- separated lanes and paths: green for everyone, always */
for (const rules of [on(), off()]) {
  for (const facility of [4, 5]) {
    const separated = road({ facility, infra: true, infraScore: 1, speed: 60 });
    assert.equal(level(separated, { ...rules, noUpperLimit: false }), 1,
      `facility ${facility} is green on any road, trustBikeLanes=${rules.trustBikeLanes}`);
    assert.equal(level(road({ facility, infra: true, infraScore: 1, freeway: true }), rules), 4,
      'except a freeway');
    assert.equal(level(road({ facility, infra: true, infraScore: 1, prohibited: true }), rules), 4,
      'and except a prohibition');
  }
}

/* ------------------------------------- the whole point: no route moves */
// Levels 2 and 3 are priced identically, so promoting one to the other cannot
// change a routing decision. Ask the worker's own cost function rather than
// trusting the claim.
const worker = routerWorker();
const priced = worker.run(`(() => {
  useWeights(null);
  const out = {};
  for (const mode of ['direct', 'balanced', 'low']) {
    out[mode] = [1, 2, 3, 4].map((lvl) => modeMult(mode, lvl));
  }
  return out;
})()`);
for (const [mode, mults] of Object.entries(priced)) {
  assert.equal(mults[1], mults[2],
    `${mode}: levels 2 and 3 must cost the same, or this setting moves routes`
    + ` (got ${mults[1]} and ${mults[2]})`);
}

// Which presets switch it on is a question about the running app, so it is
// checked by applying them in test_settings_copy_and_bounds.mjs rather than by
// reading app.js here.
console.log('ok - trusted bike lanes promote painted lanes and nothing else, '
  + 'separated lanes are green for everyone, and no route moves');
