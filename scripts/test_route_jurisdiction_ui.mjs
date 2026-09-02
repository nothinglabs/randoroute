#!/usr/bin/env node
// A route can cross state lines while the map remains on one active state.
// Exercise the real tap card so segment facts are attributed to the segment's
// jurisdiction, never to whichever state happened to launch the page.
import { chromiumPath, playwright, serveRepo } from './testlib/harness.mjs';

const { chromium } = await playwright();
const site = await serveRepo();
const browser = await chromium.launch({
  executablePath: chromiumPath(), args: ['--use-gl=swiftshader'],
});
const page = await (await browser.newContext({
  serviceWorkers: 'block', viewport: { width: 430, height: 900 },
})).newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(site.url, { waitUntil: 'load' });
await page.waitForFunction(() => document.documentElement.classList.contains('app-ready'),
  null, { timeout: 120000 });

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};

const cardFor = async (stateId) => page.evaluate((jurisdiction) => {
  const segment = {
    name: 'Border Road', stateId: jurisdiction, lenM: 150, mph: 45, sh: 8,
    lanes: 2, lts: 4, facility: 2, official: 3, flags: 0,
  };
  const properties = routeSegProps(segment, 0);
  HIT_SRC['route-seg-hit'] = ROUTESEG_SRC;
  renderReadout({
    layer: { id: 'route-seg-hit' }, properties,
    geometry: { type: 'LineString', coordinates: [[-122.34, 47.60], [-122.33, 47.61]] },
  }, { lng: -122.335, lat: 47.605 });
  document.querySelector('.readout-details-toggle')?.click();
  return {
    activeState: Region.id,
    propertyState: properties.stateId,
    text: document.getElementById('readout').textContent.replace(/\s+/g, ' ').trim(),
  };
}, stateId);

const otherState = await cardFor('oregon');
check('route GeoJSON retains the segment state',
  otherState.activeState === 'washington' && otherState.propertyState === 'oregon',
  JSON.stringify(otherState));
check('a route card uses the segment state agencies while another state is active',
  /Speed sourceODOT legal speed/.test(otherState.text)
    && /Traffic stressODOT rates it 4 of 4/.test(otherState.text)
    && /Facility sourceODOT Bicycle Facilities/.test(otherState.text), otherState.text);

const activeState = await cardFor('washington');
check('the same card still attributes active-state facts correctly',
  /Speed sourceWSDOT legal speed/.test(activeState.text)
    && /Traffic stressWSDOT rates it 4 of 4/.test(activeState.text)
    && /Facility sourceWSDOT Active Transportation Data/.test(activeState.text), activeState.text);
check('the jurisdiction card has no JavaScript errors', errors.length === 0, errors.join(' | '));

await browser.close();
await site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
