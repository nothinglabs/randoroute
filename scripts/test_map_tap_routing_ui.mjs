#!/usr/bin/env node
// A map tap is primarily a routing action. Road/source diagnostics remain
// available, but only after the rider explicitly expands Details.
import { appPage, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};

const compact = await page.evaluate(() => {
  clearRoute();
  routing.worker?.terminate?.();
  routing.worker = { postMessage: () => {} };
  routing.ready = true;
  routing.loading = false;
  getFreshDevicePosition = () => new Promise(() => {});
  const source = SOURCES.find((item) => item.id === 'roads');
  HIT_SRC['test-road-hit'] = source;
  const feature = {
    layer: { id: 'test-road-hit' },
    properties: { n: 'Interurban Trail', s: 25, w: 0, ft: 5, h: 'path', u: 1 },
    geometry: { type: 'LineString', coordinates: [[-122.34, 47.61], [-122.33, 47.62]] },
  };
  renderReadout(feature, { lng: -122.335, lat: 47.615 }, { x: 215, y: 420 });
  const details = document.getElementById('mapTapDetails');
  const readout = document.getElementById('readout');
  return {
    heading: readout.querySelector('.rt-title')?.textContent,
    summary: readout.querySelector('.readout-summary')?.textContent,
    actions: [...readout.querySelectorAll('.readout-route-actions button')]
      .map((button) => button.textContent),
    detailsHidden: details?.hidden,
    tableHiddenInsideDetails: !!details?.querySelector('table'),
    stopPresent: Boolean(readout.querySelector('.map-point-stop')),
    locationOnlyCard: readout.classList.contains('place-action-card'),
    compactHeight: Math.round(readout.getBoundingClientRect().height),
  };
});
check('a road tap shows only a short name and safety summary',
  compact.heading === 'Interurban Trail'
    && /Passes your rules|Bike network/.test(compact.summary), JSON.stringify(compact));
check('the common Destination action leads, with an explicit Start alternative',
  compact.actions.join('|') === 'Destination|Start', JSON.stringify(compact.actions));
check('technical rows exist but begin hidden behind Details',
  compact.detailsHidden && compact.tableHiddenInsideDetails, JSON.stringify(compact));
check('a road tap remains a road-details card, not a searched-place card',
  compact.locationOnlyCard === false);
check('Add stop stays out of the way until the trip has both endpoints',
  compact.stopPresent === false);
check('the collapsed phone card stays compact', compact.compactHeight < 155,
  `${compact.compactHeight}px`);

await page.locator('#readout .readout-details-toggle').click();
const originalDetails = await page.evaluate(() => ({
  heading: document.querySelector('#readout .rt-title')?.textContent,
  text: document.getElementById('mapTapDetails')?.textContent,
}));
check('road Details restores the original source-oriented heading verbatim',
  originalDetails.heading === 'Road (OSM)', JSON.stringify(originalDetails));
check('road Details retains the former safety rows without GPS coordinates',
  ['Name', 'Verdict', 'Why', 'Speed limit', 'Shoulder', 'Area', 'Bike facility', 'Surface (OSM)']
    .every((label) => originalDetails.text.includes(label))
    && !/47\.61500|-122\.33500|Location/.test(originalDetails.text), originalDetails.text);
await page.locator('#readout .readout-details-toggle').click();
check('collapsing Details returns to the friendly road name', await page.evaluate(() =>
  document.querySelector('#readout .rt-title')?.textContent === 'Interurban Trail'));

await page.locator('#readout .map-point-end').click();
check('Destination uses the tapped coordinate and reveals the Current location start', await page.evaluate(() =>
  routing.endName === 'Interurban Trail'
    && routing.end[0] === -122.335 && routing.end[1] === 47.615
    && routing.startDefaultsToDevice
    && !document.querySelector('.route-endpoint-start-row').hidden
    && !document.getElementById('readout').classList.contains('show')));

await page.evaluate(() => renderReadout(null,
  { lng: -122.76, lat: 48.12 }, { x: 260, y: 300 }));
const blank = await page.evaluate(() => ({
  heading: document.querySelector('#readout .rt-title')?.textContent,
  summary: document.querySelector('#readout .readout-summary')?.textContent,
  detailsHidden: document.getElementById('mapTapDetails')?.hidden,
}));
check('a programmatically selected location can still use the routing card',
  blank.heading === 'Point on map' && blank.detailsHidden, JSON.stringify(blank));
await page.locator('#readout .map-point-start').click();
check('Start completes the route directly from the map', await page.evaluate(() =>
  routing.startName === 'Point on map'
    && routing.start[0] === -122.76 && routing.start[1] === 48.12));

await page.evaluate(() => renderReadout(null,
  { lng: -122.305, lat: 47.95 }, { x: 180, y: 360 }));
check('Add stop is always available once the itinerary has endpoints', await page.evaluate(() =>
  document.querySelector('#readout .map-point-stop')?.disabled === false));
check('Options no longer contains an Add stop visibility setting', await page.evaluate(() =>
  !document.getElementById('r-showStopActions')));
await page.locator('#readout .readout-details-toggle').click();
const expanded = await page.evaluate(() => ({
  expanded: document.querySelector('.readout-details-toggle')?.getAttribute('aria-expanded'),
  hidden: document.getElementById('mapTapDetails')?.hidden,
  heading: document.querySelector('#readout .rt-title')?.textContent,
  detailsText: document.getElementById('mapTapDetails')?.textContent,
  links: [...document.querySelectorAll('#mapTapDetails .road-map-actions > *')]
    .map((element) => element.textContent),
}));
check('Details restores the original source heading and external map tools',
  expanded.expanded === 'true' && expanded.hidden === false
    && expanded.heading === 'Point on map'
    && expanded.links.join('|') === 'Google Street View|Google Maps ↗', JSON.stringify(expanded));
check('Details does not add GPS coordinates',
  !/47\.95000|-122\.30500|Location/.test(expanded.detailsText), expanded.detailsText);
await page.locator('#readout .map-point-stop').click();
check('Add stop commits the tapped map point to the visible itinerary', await page.evaluate(() =>
  routing.vias.length === 1 && routing.vias[0].name === 'Point on map'
    && document.querySelector('.route-stop-edit strong')?.textContent === 'Point on map'));

const blankTap = await page.evaluate(() => {
  roadInfoSuppressedUntil = 0;
  dismissRoadInfo();
  const original = featureAt;
  featureAt = () => null;
  const opened = inspectRoadAt({ x: 120, y: 240 }, { lng: -122.4, lat: 47.7 });
  featureAt = original;
  return { opened, shown: document.getElementById('readout').classList.contains('show') };
});
check('a blank map tap does not invent a details card', !blankTap.opened && !blankTap.shown,
  JSON.stringify(blankTap));
const edgeTap = await page.evaluate(() => {
  roadInfoSuppressedUntil = 0;
  dismissRoadInfo();
  const original = featureAt;
  featureAt = () => ({
    layer: { id: 'test-road-hit' },
    properties: { n: 'Edge road', s: 25, w: 2, h: 'residential' },
    geometry: { type: 'LineString', coordinates: [[-122.4, 47.7], [-122.39, 47.7]] },
  });
  const opened = inspectRoadAt({ x: 3, y: 240 }, { lng: -122.4, lat: 47.7 });
  featureAt = original;
  return { opened, shown: document.getElementById('readout').classList.contains('show') };
});
check('a near-edge tap is ignored even when road geometry lies beneath it',
  !edgeTap.opened && !edgeTap.shown, JSON.stringify(edgeTap));
check('no page errors', page.pageErrors.length === 0, page.pageErrors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
