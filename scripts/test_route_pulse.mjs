#!/usr/bin/env node
// A failure and a caution must not read as two sizes of one effect. A failure
// breathes in WIDTH; a caution's ticks TRAVEL along the line. This drives the
// real timers against a stub map and checks that each animates its own property,
// that neither borrows the other's, and that both stop cleanly.
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
const LAYERS = new Set(['route-fail', 'route-fail-casing',
  'route-caution', 'route-caution-casing']);
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
  constOf('ROUTE_PULSE_STEP'),
  appSrc.match(/const CAUTION_TICKS = \(\(\) => \{[\s\S]*?\}\)\(\);/)[0].replace('const ', 'var '),
  'var failPulseTimer = null, detailSelectionPulseTimer = null, cautionPulseTimer = null;',
  lift('setFailPulse'), lift('setCautionPulse'), lift('setRoutePulses'),
].join('\n'), ctx);

const step = (n = 1) => {
  for (let i = 0; i < n; i++) for (const t of ticks) if (t) t.fn();
};
// Sample several keys over ONE window. Sampling them in sequence walks the sine
// further each time, so a later key can be measured across a narrow slice of the
// cycle and look far stiffer than it is.
const sample = (keys, n) => {
  const values = Object.fromEntries(keys.map((k) => [k, []]));
  for (let i = 0; i < n; i++) {
    step();
    // Raw, not coerced: Number() on a dash array is NaN, which silently makes
    // every frame look identical and a travelling pattern look static.
    for (const k of keys) values[k].push(paint.get(k));
  }
  return values;
};
const spread = (xs) => {
  const ns = xs.map(Number);
  return Math.max(...ns) - Math.min(...ns);
};
// A full throb is half a sine period; sample a whole one so a min and a max are
// both actually visited.
const FULL_THROB = Math.ceil(Math.PI / 0.165) + 1;

/* ------------------------------------------------------------ the checks */
const render = (...styles) => ({ features: styles.map((style) => ({ properties: { style } })) });

// Nothing on a clean route.
ctx.setRoutePulses(render('pass', 'bike'));
assert.equal(ticks.filter(Boolean).length, 0,
  'a route with no failures or cautions should animate nothing');

// A caution alone animates the caution layer and leaves the failure layer be.
ctx.setRoutePulses(render('pass', 'caution'));
assert.equal(ticks.filter(Boolean).length, 1, 'a caution alone starts one timer');
const cautionSample = sample(
  ['route-caution|line-dasharray', 'route-caution|line-width'], FULL_THROB);
const patterns = cautionSample['route-caution|line-dasharray'];
assert.equal(paint.get('route-fail|line-width'), undefined,
  'a route with no failing segment should not touch the failure layer');

// The ticks must MOVE: several distinct dash patterns over one cycle.
const distinct = new Set(patterns.map((p) => JSON.stringify(p)));
assert.ok(distinct.size >= 4,
  `caution ticks should travel, saw ${distinct.size} distinct dash patterns`);
// And the line must NOT throb, or it is just the failure effect again.
assert.equal(new Set(cautionSample['route-caution|line-width']).size, 1,
  'a caution must not also pulse its width; that is the failure\'s motion');
console.log(`PASS  caution ticks travel through ${distinct.size} dash patterns, width steady`);

// Both together: the failure throbs in width and does NOT march, so the two
// verdicts are told apart by the kind of motion, not merely its size.
ctx.setRoutePulses(render('fail', 'caution'));
const failSample = sample(['route-fail|line-width', 'route-fail|line-dasharray'], FULL_THROB);
const failWidths = failSample['route-fail|line-width'].map(Number);
const failAmp = spread(failWidths);
assert.ok(failAmp > 2, `a failure should throb in width, moved ${failAmp.toFixed(2)} px`);
assert.equal(new Set(failSample['route-fail|line-dasharray'].map(String)).size, 1,
  'a failure must not also march; that is the caution\'s motion');
console.log(`PASS  failure throbs ${failAmp.toFixed(2)} px in width and does not march`);

// The two must not breathe in step, or they read as one animation.
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
assert.equal(paint.get('route-fail|line-width'), 6.5, 'failure rests at its base width');
// A caution at rest KEEPS its ticks. The texture carries the verdict whether or
// not anything is moving, so it still reads in a screenshot.
assert.deepEqual(JSON.parse(JSON.stringify(paint.get('route-caution|line-dasharray'))),
  JSON.parse(JSON.stringify(ctx.CAUTION_TICKS[0])),
  'a stopped caution keeps its ticks rather than going solid');
console.log('PASS  both layers stop at their resting size');

console.log('\n5 checks, 0 failed');
