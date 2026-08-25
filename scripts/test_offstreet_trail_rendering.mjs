#!/usr/bin/env node
// Standalone trails come from overlays.pmtiles, not from route geometry. A
// missing/empty overlay source therefore leaves them invisible while the same
// trail still appears inside an active route. Exercise a known Interurban
// Trail viewport and pin both display states: lime when enabled, neutral when
// disabled, and never absent.
import { appPage, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port, { desktop: true });

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};

await page.waitForFunction(() => map.getSource('overlays') && map.getLayer('osm__trail'),
  { timeout: 30000 });
await page.evaluate(async () => {
  // Interurban Trail, immediately west of Silver Lake near Everett.
  map.jumpTo({ center: [-122.2283, 47.8853], zoom: 14 });
  await Promise.race([
    new Promise((resolve) => map.once('idle', () => resolve())),
    new Promise((resolve) => setTimeout(resolve, 20000)),
  ]);
});

// queryRenderedFeatures answers from the last frame the map DREW, not from the
// style: after setMapLayerVisible the layer reads visibility 'none' straight
// away, while the query index still returns its features for about a second.
// A fixed short wait therefore reported a disabled layer as still rendering.
// Wait for the map to go idle, which is the point its query index matches the
// style it has been given.
async function counts(enabled) {
  await page.evaluate(async (on) => {
    setMapLayerVisible('offstreetTrails', on);
    await Promise.race([
      new Promise((resolve) => map.once('idle', () => resolve())),
      new Promise((resolve) => setTimeout(resolve, 10000)),
    ]);
  }, enabled);
  return page.evaluate(() => ({
    source: map.querySourceFeatures('overlays', { sourceLayer: 'bikeinfra' }).length,
    base: map.queryRenderedFeatures({ layers: ['osm__trail-base'] }).length,
    trail: map.queryRenderedFeatures({ layers: ['osm__trail'] }).length,
    dots: map.queryRenderedFeatures({ layers: ['osm__trail-dots'] }).length,
  }));
}

const on = await counts(true);
const off = await counts(false);
check('the bike-infrastructure tile source has features', on.source > 0, JSON.stringify(on));
check('enabled trails render their lime line and dashed center',
  on.trail > 0 && on.dots > 0, JSON.stringify(on));
check('disabled trails retain a visible neutral base', off.base > 0, JSON.stringify(off));
check('disabled trails hide only their colored treatment',
  off.trail === 0 && off.dots === 0, JSON.stringify(off));
check('no page errors', page.pageErrors.length === 0, page.pageErrors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
