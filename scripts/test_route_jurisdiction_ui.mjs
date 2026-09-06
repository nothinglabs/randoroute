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

// A painted road (the tiles, not the route) carries no state of its own; the
// tap places it. With Washington selected, a road near Creswell must speak for
// ODOT throughout, including the Why line (field, 2026-09-06).
const paintedCardAt = async (lng, lat) => page.evaluate(({ lng, lat }) => {
  const properties = { n: 'North Pacific Highway', r: 'OR 99', s: 55, w: 6, ln: 2,
    lts: 4, d: 1, wsh: 1, rc: 3 };
  // The roads source registers its hit layer when its layers are added; find
  // that id rather than assume it, and register it when the layer set has not
  // reached the roads source yet (the route-segment case above does the same).
  const roadsSource = SOURCES.find((source) => source.id === 'roads');
  const hitLayerId = Object.keys(HIT_SRC).find((id) => HIT_SRC[id] === roadsSource)
    || (HIT_SRC['roads__hit'] = roadsSource, 'roads__hit');
  renderReadout({
    layer: { id: hitLayerId }, properties,
    geometry: { type: 'LineString', coordinates: [[lng - 0.002, lat - 0.002], [lng + 0.002, lat + 0.002]] },
  }, { lng, lat });
  document.querySelector('.readout-details-toggle')?.click();
  return {
    activeState: Region.id,
    placedState: placeStateIdAt(lng, lat),
    text: document.getElementById('readout').textContent.replace(/\s+/g, ' ').trim(),
  };
}, { lng, lat });
const paintedOregon = await paintedCardAt(-123.02, 43.92);
check('a painted road in the other state is attributed to that state\'s agency everywhere on the card',
  paintedOregon.activeState === 'washington' && paintedOregon.placedState === 'oregon'
    && /ODOT rates it 4 of 4 for traffic stress/.test(paintedOregon.text)
    && /Traffic stressODOT rates it 4 of 4/.test(paintedOregon.text)
    && !/WSDOT/.test(paintedOregon.text),
  JSON.stringify(paintedOregon));
const paintedHome = await paintedCardAt(-122.33, 47.60);
check('a painted road in the active state still names its own agency',
  paintedHome.placedState === 'washington'
    && /WSDOT rates it 4 of 4 for traffic stress/.test(paintedHome.text)
    && !/ODOT/.test(paintedHome.text),
  JSON.stringify(paintedHome));
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
await site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
