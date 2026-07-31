#!/usr/bin/env node
// A failure and a caution must not read as two sizes of one effect. Motion has
// two axes -- across the line and along it -- and each verdict gets exactly one.
// One RADIATES: its line holds still and a blurred halo swells sideways. The
// other MARCHES: its ticks travel along the line at a steady width.
//
// WHICH verdict gets which is read from app.js (HALO_LAYER / TICK_LAYER) rather
// than restated here, so this test follows a swap instead of needing a rewrite
// for one. What it pins is the part that must never change: that the two are
// different in KIND, that neither borrows the other's motion, and that both
// stop cleanly. This drives the real timers against a stub map.
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
  'route-caution', 'route-caution-casing', 'route-caution-glow']);
const ctx = {
  Math,
  map: {
    getLayer: (id) => (LAYERS.has(id) ? { id } : null),
    setPaintProperty: (id, prop, value) => { paint.set(`${id}|${prop}`, value); },
  },
  // The halo asks before it animates. Report a rider who has NOT asked for
  // reduced motion, so the moving path is the one under test; the reduced
  // branch is checked separately at the end.
  window: { matchMedia: () => ({ matches: false }) },
  // A controllable clock: each callback is stepped by hand so the test does not
  // depend on wall time.
  setInterval: (fn, ms) => { ticks.push({ fn, ms }); return ticks.length; },
  clearInterval: (h) => { if (h) ticks[h - 1] = null; },
};
vm.createContext(ctx);
vm.runInContext([
  constOf('ROUTE_PULSE_STEP'),
  constOf('HALO_REST'),
  constOf('HALO_LAYER'), constOf('TICK_LAYER'),
  appSrc.match(/const TICK_FRAMES = \(\(\) => \{[\s\S]*?\}\)\(\);/)[0].replace('const ', 'var '),
  'var haloPulseTimer = null, detailSelectionPulseTimer = null, tickCrawlTimer = null;',
  'var haloRaised = false;',
  lift('stopHalo'),
  lift('setHaloPulse'), lift('setTickCrawl'), lift('setRoutePulses'),
].join('\n'), ctx);

// Read the verdict->effect wiring from app.js rather than restating it, so this
// test follows a future swap instead of having to be rewritten for one.
const HALO = ctx.HALO_LAYER;   // the verdict that radiates
const TICK = ctx.TICK_LAYER;   // the verdict that marches
const haloStyle = HALO.includes('caution') ? 'caution' : 'fail';
const tickStyle = TICK.includes('caution') ? 'caution' : 'fail';
assert.notEqual(haloStyle, tickStyle,
  'the two verdicts must not share one effect; that is the whole point');
console.log(`wiring: ${haloStyle} radiates (${HALO}), ${tickStyle} marches (${TICK})`);

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

// The halo verdict alone animates its own layer and leaves the other one be.
const haloLine = HALO.replace('-glow', '');
ctx.setRoutePulses(render('pass', haloStyle));
assert.equal(ticks.filter(Boolean).length, 1, `a ${haloStyle} alone starts one timer`);
const haloSample = sample([`${HALO}|line-width`, `${HALO}|line-opacity`,
  `${HALO}|line-blur`, `${haloLine}|line-width`, `${haloLine}|line-dasharray`], FULL_THROB);
assert.equal(paint.get(`${TICK}|line-dasharray`), undefined,
  `a route with no ${tickStyle} segment should not touch the ${tickStyle} layer`);

// The halo must SWELL, and the line under it must hold still -- a rider needs
// one crisp, unmoving thing to fix their eye on.
const haloAmp = spread(haloSample[`${HALO}|line-width`]);
assert.ok(haloAmp > 8, `the ${haloStyle} halo should swell, moved ${haloAmp.toFixed(2)} px`);
assert.ok(spread(haloSample[`${HALO}|line-opacity`]) > 0.15,
  'the halo should fade in and out as it swells');
assert.ok(spread(haloSample[`${HALO}|line-blur`]) > 1,
  'the halo should soften as it swells');
// Blur must grow more slowly than width, or the halo spreads thin enough at
// full swell to vanish into a busy basemap.
assert.ok(spread(haloSample[`${HALO}|line-blur`]) < haloAmp / 2,
  'halo blur should grow more slowly than its width');
assert.equal(new Set(haloSample[`${haloLine}|line-width`].map(String)).size, 1,
  `the ${haloStyle} LINE must hold still; only its halo moves`);
// Solid, never dashed. A broken warm line on a white casing is the other
// verdict's texture, and sharing it is what made the two look alike in the field.
assert.equal(paint.get(`${haloLine}|line-dasharray`), undefined,
  `the ${haloStyle} line must be solid, never dashed`);
console.log(`PASS  ${haloStyle} halo swells ${haloAmp.toFixed(1)} px while its line holds still`);

// Both together. The other verdict MARCHES: its ticks travel along the line at
// a steady width, which needs no amplitude comparison to tell from a swell.
ctx.setRoutePulses(render('fail', 'caution'));
const tickSample = sample([`${TICK}|line-dasharray`, `${TICK}|line-width`], FULL_THROB);
const distinct = new Set(tickSample[`${TICK}|line-dasharray`].map((p) => JSON.stringify(p)));
assert.ok(distinct.size >= 4,
  `${tickStyle} ticks should travel, saw ${distinct.size} distinct dash patterns`);
assert.equal(new Set(tickSample[`${TICK}|line-width`]).size, 1,
  `a ${tickStyle} must not also pulse its width; that is the other verdict's motion`);
console.log(`PASS  ${tickStyle} ticks travel through ${distinct.size} dash patterns, width steady`);

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
assert.equal(paint.get(`${HALO}|line-width`), ctx.HALO_REST.width,
  `the ${haloStyle} halo rests at its base width`);
assert.equal(paint.get(`${HALO}|line-opacity`), ctx.HALO_REST.opacity,
  `the ${haloStyle} halo rests at its base opacity`);
// The marching verdict at rest KEEPS its ticks. The texture carries the verdict
// whether or not anything is moving, so it still reads in a screenshot.
assert.deepEqual(JSON.parse(JSON.stringify(paint.get(`${TICK}|line-dasharray`))),
  JSON.parse(JSON.stringify(ctx.TICK_FRAMES[0])),
  `a stopped ${tickStyle} keeps its ticks rather than going solid`);
console.log('PASS  both layers stop at their resting size');

// Reduced motion must not mean "no verdict". The halo IS the verdict, so it
// holds wide and steady rather than disappearing -- and turning the route clean
// must still put it back, even though no timer ever ran.
ctx.window.matchMedia = () => ({ matches: true });
paint.clear();
ctx.setRoutePulses(render(haloStyle));
assert.equal(ticks.filter(Boolean).length, 0,
  'reduced motion should start no timer');
const restingWidth = Number(paint.get(`${HALO}|line-width`));
assert.ok(restingWidth >= ctx.HALO_REST.width,
  `a reduced-motion halo should hold at least its resting halo, got ${restingWidth}`);
assert.ok(Number(paint.get(`${HALO}|line-opacity`)) > ctx.HALO_REST.opacity,
  'a reduced-motion halo should be stronger than the moving one rests at');
ctx.setRoutePulses(render('pass'));
assert.equal(paint.get(`${HALO}|line-width`), ctx.HALO_REST.width,
  'clearing a reduced-motion halo must still return it to rest');
console.log(`PASS  reduced motion holds the halo at ${restingWidth} px and still resets`);

console.log('\n6 checks, 0 failed');
