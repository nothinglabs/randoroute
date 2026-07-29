#!/usr/bin/env node
// The route pulses are wired through three functions and two call sites, and a
// mistake in any of them is invisible in code review and obvious on a phone.
// This drives the real timers against a stub map and checks that both layers
// actually animate, at the intended rate, and stop cleanly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appSrc = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

function lift(name) {
  const re = new RegExp(`\\nfunction ${name}\\s*\\([^)]*\\)\\s*\\{`);
  const at = appSrc.search(re);
  assert.notEqual(at, -1, `app.js should define ${name}`);
  let depth = 0;
  for (let j = appSrc.indexOf('{', at); j < appSrc.length; j++) {
    if (appSrc[j] === '{') depth++;
    else if (appSrc[j] === '}' && --depth === 0) return appSrc.slice(at + 1, j + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function constOf(name) {
  const m = new RegExp(`const ${name} = ([^;]+);`).exec(appSrc);
  assert.ok(m, `expected const ${name}`);
  return `var ${name} = ${m[1]};`;
}

/* ------------------------------------------- a stub map that records paint */
const paint = new Map();
const ticks = [];
const LAYERS = new Set(['route-fail', 'route-fail-casing', 'route-caution']);
const ctx = {
  Math,
  map: {
    getLayer: (id) => (LAYERS.has(id) ? { id } : null),
    setPaintProperty: (id, prop, value) => { paint.set(`${id}|${prop}`, value); },
  },
  // A controllable clock: each callback is stepped by hand so the test does not
  // depend on wall time.
  setInterval: (fn, ms) => { ticks.push({ fn, ms }); return ticks.length; },
  clearInterval: (h) => { if (h) ticks[h - 1] = null; },
};
vm.createContext(ctx);
vm.runInContext([
  constOf('ROUTE_PULSE_STEP'), constOf('CAUTION_PULSE_PHASE'),
  'var failPulseTimer = null, detailSelectionPulseTimer = null, cautionPulseTimer = null;',
  lift('setFailPulse'), lift('setCautionPulse'), lift('setRoutePulses'),
].join('\n'), ctx);

const step = (n = 1) => {
  for (let i = 0; i < n; i++) for (const t of ticks) if (t) t.fn();
};
const seen = (key, n) => {
  const values = new Set();
  for (let i = 0; i < n; i++) { step(); values.add(paint.get(key)); }
  return values;
};

/* ------------------------------------------------------------ the checks */
const render = (...styles) => ({ features: styles.map((style) => ({ properties: { style } })) });

// Nothing on a clean route.
ctx.setRoutePulses(render('pass', 'bike'));
assert.equal(ticks.filter(Boolean).length, 0,
  'a route with no failures or cautions should animate nothing');

// A caution alone animates the caution layer and leaves the failure layer be.
ctx.setRoutePulses(render('pass', 'caution'));
assert.equal(ticks.filter(Boolean).length, 1, 'a caution alone starts one timer');
const cautionWidths = seen('route-caution|line-width', 12);
assert.ok(cautionWidths.size > 4,
  `caution width should flicker, saw ${cautionWidths.size} distinct values`);
assert.equal(paint.get('route-fail|line-width'), undefined,
  'a route with no failing segment should not touch the failure layer');

const widths = [...cautionWidths].map(Number);
assert.ok(Math.min(...widths) >= 6.5, 'caution never shrinks below its resting width');
assert.ok(Math.max(...widths) <= 7.6, 'the caution flicker stays subtle');
console.log(`PASS  caution flickers ${Math.min(...widths)}-${Math.max(...widths).toFixed(2)} px`);

// Both together: the failure throb must be wider than the caution flicker, or
// the two verdicts stop being distinguishable at a glance.
ctx.setRoutePulses(render('fail', 'caution'));
const failWidths = [...seen('route-fail|line-width', 12)].map(Number);
const failAmp = Math.max(...failWidths) - Math.min(...failWidths);
const cautionAmp = Math.max(...widths) - Math.min(...widths);
assert.ok(failAmp > cautionAmp * 2,
  `a failure should throb harder than a caution (${failAmp.toFixed(2)} vs ${cautionAmp.toFixed(2)} px)`);
console.log(`PASS  failure throbs ${failAmp.toFixed(2)} px against caution's ${cautionAmp.toFixed(2)} px`);

// The two must not breathe in step, or they read as one animation.
assert.ok(Math.abs(ctx.CAUTION_PULSE_PHASE) > 0.5,
  'the caution flicker should be offset from the failure throb');

// Rate: a full throb is half a sine period. 80 ms ticks at the current step.
const periodMs = (Math.PI / ctx.ROUTE_PULSE_STEP) * 80;
assert.ok(periodMs > 1200 && periodMs < 2000,
  `a throb should take about 1.6 s, got ${Math.round(periodMs)} ms`);
// The previous step was 0.11; this must be meaningfully faster.
assert.ok(ctx.ROUTE_PULSE_STEP > 0.11 * 1.4,
  'the pulse should be substantially faster than the 0.11 it replaced');
// Rate, not period: 0.165 / 0.11 is a 50% faster pulse, which is a 33% shorter
// throb. Reporting the period shrinkage as "faster" understates it.
console.log(`PASS  a full throb takes ${Math.round(periodMs)} ms `
  + `(${(ctx.ROUTE_PULSE_STEP / 0.11 * 100 - 100).toFixed(0)}% faster than before)`);

// Turning them off stops the timers and leaves resting values, not whatever
// the last tick happened to paint.
ctx.setRoutePulses(render('pass'));
assert.equal(ticks.filter(Boolean).length, 0, 'a clean route stops every timer');
assert.equal(paint.get('route-caution|line-width'), 6.5, 'caution rests at its base width');
assert.equal(paint.get('route-fail|line-width'), 6.5, 'failure rests at its base width');
assert.equal(paint.get('route-caution|line-opacity'), 1, 'caution rests fully opaque');
console.log('PASS  both layers stop at their resting size');

console.log('\n5 checks, 0 failed');
