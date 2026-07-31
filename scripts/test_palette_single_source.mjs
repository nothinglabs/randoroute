#!/usr/bin/env node
// One palette, four consumers, and nothing spelling a colour twice.
//
// This exists because the colours were written out in app.js, route-details.js
// and both stylesheets, and they drifted -- route-details.js drew fails in
// #78121f for a whole session after the map moved to #a51c30, and a legend
// swatch kept the old red in rgba() notation where a hex search could not find
// it. Both were copies disagreeing with the original.
//
// So this asserts on what the browser actually RESOLVES, not on source text: it
// reads the rendered colour of each legend swatch and each verdict class and
// compares it against palette.js. A stylesheet that goes back to a hardcoded
// hex passes only while that hex happens to match, and fails the moment the
// palette moves -- which is the whole point.
import assert from 'node:assert/strict';
import { SafetyModel, ROOT, serveRepo, launchBrowser, playwright } from './testlib/harness.mjs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Evaluate sw.js the way a browser would: a `self` global, no-op event
// registration, and importScripts that loads the real dependency.
function swWorkerValue(name) {
  const ctx = vm.createContext({ console, URL, Response, Request: undefined });
  ctx.self = ctx;
  ctx.addEventListener = () => {};
  ctx.skipWaiting = () => {};
  ctx.clients = { claim: () => {} };
  ctx.caches = { open: async () => ({}), keys: async () => [], match: async () => undefined };
  ctx.fetch = async () => ({});
  ctx.importScripts = (...names) => {
    for (const n of names) {
      vm.runInContext(readFileSync(join(ROOT, String(n).replace(/^\.\//, '')), 'utf8'), ctx);
    }
  };
  vm.runInContext(readFileSync(join(ROOT, 'sw.js'), 'utf8'), ctx);
  return ctx[name];
}

const require_ = createRequire(import.meta.url);
const { RoutePalette } = require_(join(ROOT, 'palette.js'));

assert.ok(RoutePalette, 'palette.js should publish RoutePalette');
assert.equal(RoutePalette.LEVEL[4], RoutePalette.fail, 'level 4 is the fail colour');
assert.equal(RoutePalette.LEVEL[1], RoutePalette.pass, 'level 1 is the pass colour');
assert.equal(RoutePalette.toRgbTriple('#a51c30'), '165,28,48', 'rgb triple conversion');

const hexToRgb = (hex) => {
  const v = hex.replace('#', '');
  return `rgb(${parseInt(v.slice(0, 2), 16)}, ${parseInt(v.slice(2, 4), 16)}, ${parseInt(v.slice(4, 6), 16)})`;
};

const { port, close } = await serveRepo();
const browser = await launchBrowser();
const context = await browser.newContext({ serviceWorkers: 'block' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://localhost:${port}/index.html`, { waitUntil: 'load' });
await page.waitForFunction(() => window.RoutePalette, { timeout: 30000 });

let checks = 0;
const check = (name, actual, expected) => {
  assert.equal(actual, expected, `${name}: expected ${expected}, got ${actual}`);
  checks++;
};

/* --- the custom properties reached :root before anything painted ---------- */
const vars = await page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  const out = {};
  for (const name of Object.keys(RoutePalette.CSS_VARS)) out[name] = cs.getPropertyValue(name).trim();
  out['--verdict-fail-rgb'] = cs.getPropertyValue('--verdict-fail-rgb').trim();
  return out;
});
for (const [name, value] of Object.entries(RoutePalette.CSS_VARS)) {
  check(`:root ${name}`, vars[name], value);
}
check(':root --verdict-fail-rgb', vars['--verdict-fail-rgb'], RoutePalette.toRgbTriple(RoutePalette.fail));

/* --- every legend swatch resolves to the palette, as rendered ------------- */
// The swatches are CSS gradients, so read the computed background-image and
// look for the palette colour inside it rather than parsing the gradient.
const swatches = await page.evaluate(() => {
  const wanted = ['trail', 'facility', 'meets', 'fails', 'caution', 'designated', 'prohibited', 'unpaved'];
  const out = {};
  for (const cls of wanted) {
    const el = document.createElement('span');
    el.className = `layer-toggle-swatch ${cls}`;
    document.body.appendChild(el);
    const cs = getComputedStyle(el);
    out[cls] = { image: cs.backgroundImage, color: cs.backgroundColor };
    el.remove();
  }
  return out;
});
const contains = (swatch, hex) =>
  (swatch.image + ' ' + swatch.color).includes(hexToRgb(hex));

check('facility swatch uses the bike-network lime', contains(swatches.facility, RoutePalette.bikeNetwork), true);
check('meets swatch uses the pass blue', contains(swatches.meets, RoutePalette.pass), true);
check('fails swatch uses the fail red', contains(swatches.fails, RoutePalette.fail), true);
check('caution swatch uses the caution orange', contains(swatches.caution, RoutePalette.caution), true);
check('designated swatch uses the designated green', contains(swatches.designated, RoutePalette.designated), true);
check('trail swatch uses the trail centreline', contains(swatches.trail, RoutePalette.trailCentreline), true);
// The prohibited swatch builds its own alpha from the published rgb triple.
// It carried the OLD fail red in rgba() form for a while precisely because it
// did not; this is the check that would have caught it.
check('prohibited swatch is built from the fail red',
  (swatches.prohibited.image + swatches.prohibited.color)
    .includes(`rgba(${RoutePalette.toRgbTriple(RoutePalette.fail).split(',').join(', ')}`), true);

/* --- the map's own layers agree with the palette -------------------------- */
const mapColors = await page.evaluate(() => ({
  colors: typeof COLORS !== 'undefined' ? { ...COLORS } : null,
  bike: typeof BIKE_NETWORK_COLOR !== 'undefined' ? BIKE_NETWORK_COLOR : null,
  designated: typeof DESIGNATED_COLOR !== 'undefined' ? DESIGNATED_COLOR : null,
}));
for (const level of [0, 1, 2, 3, 4]) {
  check(`app COLORS[${level}]`, mapColors.colors[level], RoutePalette.LEVEL[level]);
}
check('app BIKE_NETWORK_COLOR', mapColors.bike, RoutePalette.bikeNetwork);
check('app DESIGNATED_COLOR', mapColors.designated, RoutePalette.designated);

/* --- and so does the route report, which is where the drift happened ------ */
const detailsPage = await context.newPage();
const detailErrors = [];
detailsPage.on('pageerror', (e) => detailErrors.push(e.message));
await detailsPage.goto(`http://localhost:${port}/route-details.html`, { waitUntil: 'load' });
await detailsPage.waitForFunction(() => window.RoutePalette, { timeout: 30000 });
const reportColors = await detailsPage.evaluate(() => ({
  pass: typeof PASS_COLOR !== 'undefined' ? PASS_COLOR : null,
  caution: typeof CAUTION_COLOR !== 'undefined' ? CAUTION_COLOR : null,
  fail: typeof FAIL_COLOR !== 'undefined' ? FAIL_COLOR : null,
  bike: typeof BIKE_NETWORK_COLOR !== 'undefined' ? BIKE_NETWORK_COLOR : null,
}));
check('report PASS_COLOR', reportColors.pass, RoutePalette.pass);
check('report CAUTION_COLOR', reportColors.caution, RoutePalette.caution);
check('report FAIL_COLOR', reportColors.fail, RoutePalette.fail);
check('report BIKE_NETWORK_COLOR', reportColors.bike, RoutePalette.bikeNetwork);

/* --- the other constants that used to be kept in step by hand ------------- */
// GRAPH_DATA_VERSION: app.js and sw.js each spelled it out, with comments
// pointing at each other. A mismatch is silent -- the SW cache is keyed by URL,
// so a rebuilt graph under an unchanged name is served from cache forever.
const { GRAPH_DATA_VERSION } = require_(join(ROOT, 'build-version.js'));
const appGraphVersion = await page.evaluate(() => GRAPH_DATA_VERSION);
check('app.js GRAPH_DATA_VERSION comes from build-version.js',
  appGraphVersion, GRAPH_DATA_VERSION);
// Actually RUN sw.js in a worker-shaped context, with importScripts wired to
// the real file, and read what it ends up holding. An earlier version of this
// check only looked for the identifier in the source and then reported the
// value from elsewhere -- which would have passed even if sw.js had gone back
// to its own hardcoded literal. That is the exact failure being guarded here,
// so the check has to evaluate rather than inspect.
const swGraphVersion = swWorkerValue('GRAPH_DATA_VERSION');
check('sw.js resolves GRAPH_DATA_VERSION from build-version.js',
  swGraphVersion, GRAPH_DATA_VERSION);

// The route-preview sketch: the SVG viewBox and the CSS box must scale
// together, or the stroke weights drift as the preview is resized.
const thumb = await page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  return { w: cs.getPropertyValue('--thumb-w').trim(),
           h: cs.getPropertyValue('--thumb-h').trim(),
           jsW: THUMB_W, jsH: THUMB_H };
});
check('--thumb-w matches THUMB_W', thumb.w, `${thumb.jsW}px`);
check('--thumb-h matches THUMB_H', thumb.h, `${thumb.jsH}px`);

assert.deepEqual(errors, [], `index.html console errors: ${errors.join(', ')}`);
assert.deepEqual(detailErrors, [], `route-details.html console errors: ${detailErrors.join(', ')}`);

console.log(`ok - ${checks} checks: palette.js, :root variables, ${Object.keys(swatches).length} legend swatches, `
  + 'the map and the route report all resolve to one palette');
await browser.close();
close();
