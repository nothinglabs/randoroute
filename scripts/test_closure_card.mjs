#!/usr/bin/env node
// The route-closure overlay is the one layer a rider cannot switch off, so it
// must be able to explain itself: tapping a closure marker (or the closed
// stretch) opens a card naming the closure and why it is there. It used to be
// the only mark on the map a tap ignored -- a rider had to screenshot a bus
// loop in Everett and ask what it was.
//
// Also holds the build-side line: transit infrastructure (bus-only service
// ways) must not appear as closures at all. That bus loop is the regression
// case.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { appPage, launchBrowser, serveRepo } from './testlib/harness.mjs';

const closures = JSON.parse(gunzipSync(readFileSync(
  new URL('../data/route_closures.geojson.gz', import.meta.url))));
assert.ok(closures.features.length > 0, 'there should be closures to test against');

// The Everett Station bus loop (access=no + bus=yes service ways on a route
// relation) must stay filtered out of the build.
const everettStation = closures.features.filter((f) => {
  const pts = f.geometry.type === 'Point' ? [f.geometry.coordinates] : f.geometry.coordinates;
  return pts.some(([lng, lat]) => lat > 47.94 && lat < 48.02 && lng > -122.24 && lng < -122.15);
});

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};

check('the Everett Station bus loop is not a closure',
  everettStation.length === 0, `${everettStation.length} features linger`);

// Jump to a real closure point and tap it the way inspectRoadAt would.
const marker = closures.features.find((f) => f.geometry.type === 'Point');
check('closures include tappable point markers', !!marker);
const [lng, lat] = marker.geometry.coordinates;
await page.evaluate(([x, y]) => map.jumpTo({ center: [x, y], zoom: 15 }), [lng, lat]);
await page.waitForFunction(() => map.areTilesLoaded(), { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1500);

const tap = await page.evaluate(([x, y]) => {
  const out = { hitLayers: HIT_LAYERS.filter((id) => id.startsWith('closures')) };
  const pt = map.project([x, y]);
  const feature = featureAt(pt);
  out.hitLayer = feature?.layer?.id || null;
  out.opened = feature ? inspectRoadAt(pt) : false;
  out.title = document.querySelector('#readout .rt-title')?.textContent || '';
  out.text = document.getElementById('readout').textContent;
  out.shown = document.getElementById('readout').classList.contains('show');
  return out;
}, [lng, lat]);

check('closure layers are registered as tap targets',
  tap.hitLayers.length === 2, JSON.stringify(tap.hitLayers));
check('tapping the marker answers with the closure, not the road beneath',
  tap.hitLayer === 'closures' || tap.hitLayer === 'closures__line', String(tap.hitLayer));
check('and opens the closure card', tap.opened === true && tap.shown === true);
check('the card names it a route closure', /Route closure/.test(tap.title), tap.title);
check('and says why', /closed|not permitted|construction|destroyed/i.test(tap.text),
  tap.text.slice(0, 160));
check('no page errors', page.pageErrors.length === 0, page.pageErrors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
