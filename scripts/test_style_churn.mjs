#!/usr/bin/env node
// The map must not be told things it already knows.
//
// applyDisplayMode() rebuilds every paint expression, filter and layout
// property for every source from scratch. Each of those writes marks the layer
// dirty and makes MapLibre re-parse the expression and redraw, whether or not
// the value differs -- and 90 of the 94 writes a single layer toggle produced
// were identical to what was already there. The blink preview then repeats the
// whole thing four more times.
//
// So app.js remembers what it last wrote and skips the rest. That is a cache
// sitting between the app and the renderer, which is exactly the kind of thing
// that silently stops a toggle from working, so this pins both halves:
//
//   1. the churn stays gone, and
//   2. the resulting style is byte-identical to writing everything through.
//
// The second is the one that matters. A cache that makes the map wrong is worse
// than the churn it saved.
import assert from 'node:assert';
import { playwright, chromiumPath, serveRepo } from './testlib/harness.mjs';

const { chromium } = await playwright();
const site = await serveRepo();
const browser = await chromium.launch({
  executablePath: chromiumPath(), args: ['--use-gl=swiftshader'],
});
const context = await browser.newContext({
  viewport: { width: 1100, height: 850 }, serviceWorkers: 'block',
});
const page = await context.newPage();
page.setDefaultTimeout(180000);
await page.goto(site.url, { waitUntil: 'load' });
await page.evaluate(() => {
  document.body.classList.remove('panel-open');
  map.jumpTo({ center: [-122.3321, 47.6062], zoom: 13 });
});
await page.waitForFunction(() => window.map && map.loaded && map.loaded(), { timeout: 180000 })
  .catch(() => {});
await page.evaluate(() => Promise.race([
  new Promise((resolve) => map.once('idle', resolve)),
  new Promise((resolve) => setTimeout(resolve, 30000)),
]));

let pass = 0;
const check = (name, ok, detail = '') => {
  if (!ok) { console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`); process.exitCode = 1; }
  else { pass++; console.log(`PASS  ${name}${detail ? `  -- ${detail}` : ''}`); }
};

/* ------------------------------------- every toggle still reaches the map */
// Compared against the same style produced with the memo emptied, which forces
// every property to be written -- the behaviour this replaced.
const KEYS = ['offstreetTrails', 'bikeFacilities', 'meetRules', 'failRules', 'caution',
  'designated', 'bikesProhibited', 'unpavedBackground'];
const toggles = await page.evaluate((keys) => {
  const snapshot = () => JSON.stringify(map.getStyle().layers);
  endSoloPreview();
  return keys.map((key) => {
    const original = display[key];
    display[key] = true; applyDisplayModeAll();
    const on = snapshot();
    display[key] = false; applyDisplayModeAll();
    const off = snapshot();
    display[key] = true; applyDisplayModeAll();
    const restored = snapshot();
    forgetStyleValues(); applyDisplayModeAll();      // write everything through
    const unmemoised = snapshot();
    display[key] = original; applyDisplayModeAll();
    return { key, changes: on !== off, restores: on === restored, matches: on === unmemoised };
  });
}, KEYS);
for (const t of toggles) {
  check(`toggling ${t.key} still changes the map`, t.changes);
  check(`toggling ${t.key} back restores it exactly`, t.restores);
  check(`${t.key} matches an unmemoised style`, t.matches);
}

/* ------------------------------------------------ and the churn stays gone */
await page.evaluate(() => {
  window.__writes = 0;
  for (const name of ['setPaintProperty', 'setFilter', 'setLayoutProperty']) {
    const original = map[name].bind(map);
    map[name] = (...args) => { window.__writes++; return original(...args); };
  }
  window.__count = (fn) => { window.__writes = 0; fn(); return window.__writes; };
});
const idle = await page.evaluate(() => {
  applyDisplayModeAll();                       // settle first
  return window.__count(() => applyDisplayModeAll());
});
check('refreshing an unchanged display writes nothing', idle === 0, `${idle} writes`);

// A whole layer gesture: the toggle plus the four passes the blink preview
// makes. This was 94 writes each, 470 for the gesture.
const gesture = await page.evaluate(() => window.__count(() => {
  setMapLayerVisible('bikeFacilities', false);
  for (let i = 0; i < 4; i++) paintLayerKey('bikeFacilities', i % 2 === 0);
  endSoloPreview();
  setMapLayerVisible('bikeFacilities', true);
  endSoloPreview();
}));
check('a layer toggle stays well under the old 470 writes', gesture < 200, `${gesture} writes`);

/* ----------------------------- a rules change re-uploads NOTHING at all */
// rescore() used to call setData() on every GeoJSON source whichever rule
// moved, re-uploading and re-tiling 55k WSDOT and 38k OSM features to redraw
// them exactly as they already were. The sources that remain fc-scored all
// carry rules-INDEPENDENT verdicts (an OSM path is judged by its type, a
// restriction is always prohibited), and WSDOT BLTS -- the one source whose
// levels do move with the rules -- paints nothing and is expression-flagged.
// A rules change therefore recolors purely by rebuilding expressions: style
// writes yes, data uploads no. An upload appearing here means a scored source
// regressed into the setData path and slider drags are re-tiling statewide
// collections again -- the memory spike that used to get the tab killed on
// iOS during a drag.
const uploads = await page.evaluate(() => {
  const counted = {};
  for (const src of SOURCES) {
    const mapSource = map.getSource(src.id);
    if (!mapSource || typeof mapSource.setData !== 'function') continue;
    const original = mapSource.setData.bind(mapSource);
    mapSource.setData = (data) => { counted[src.id] = (counted[src.id] || 0) + 1; return original(data); };
  }
  const run = (fn) => {
    for (const k of Object.keys(counted)) delete counted[k];
    window.__writes = 0; fn();
    return { uploads: { ...counted }, writes: window.__writes };
  };
  const changed = run(() => { rules.minShoulder = rules.minShoulder === 4 ? 6 : 4; rescoreAll(false); });
  const unchanged = run(() => rescoreAll(false));
  return { changed, unchanged };
});
/* ------------------- a trail is never NOTHING: the neutral ghost stays -- */
// The basemap draws every road's casing regardless of toggles, but paths
// live only in the bike-infrastructure overlay -- switching "Off-street
// trails" off used to leave a trail as a floating name over blank ground.
// The toggle controls the lime network treatment; the neutral ghost stays.
const ghost = await page.evaluate(() => {
  setMapLayerVisible('offstreetTrails', false);
  const off = map.getLayoutProperty('osm__trail-base', 'visibility');
  const limeOff = map.getLayoutProperty('osm__trail', 'visibility');
  setMapLayerVisible('offstreetTrails', true);
  const on = map.getLayoutProperty('osm__trail-base', 'visibility');
  return { exists: !!map.getLayer('osm__trail-base'), off, limeOff, on };
});
check('the neutral trail ghost survives the trails toggle',
  ghost.exists && ghost.off === 'visible' && ghost.on === 'visible' && ghost.limeOff === 'none',
  JSON.stringify(ghost));

check('re-running an unchanged rules pass re-uploads nothing',
  Object.keys(uploads.unchanged.uploads).length === 0, JSON.stringify(uploads.unchanged.uploads));
check('a real rule change uploads no data either -- recoloring is all expressions',
  Object.keys(uploads.changed.uploads).length === 0, JSON.stringify(uploads.changed.uploads));
check('but it does rewrite the style expressions', uploads.changed.writes > 0,
  `${uploads.changed.writes} writes`);

await browser.close();
site.close();
console.log(`\n${pass} checks passed`);
