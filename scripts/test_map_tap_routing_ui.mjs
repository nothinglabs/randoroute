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
    safety: readout.querySelector('.readout-safety-summary')?.textContent,
    facts: [...readout.querySelectorAll('.readout-core-fact')]
      .map((fact) => fact.textContent.replace(/\s+/g, ' ').trim()),
    primaryActions: [...readout.querySelectorAll('.readout-primary-actions > button')]
      .map((button) => button.textContent),
    routeChoices: [...readout.querySelectorAll('.readout-route-menu .readout-route-actions button')]
      .map((button) => button.textContent),
    routeMenuHidden: readout.querySelector('.readout-route-menu')?.hidden,
    mapActions: [...readout.querySelectorAll('.readout-google-menu .road-map-actions > *')]
      .map((action) => action.textContent),
    mapMenuHidden: readout.querySelector('.readout-google-menu')?.hidden,
    detailsHidden: details?.hidden,
    tableHiddenInsideDetails: !!details?.querySelector('table'),
    stopDisabled: readout.querySelector('.map-point-stop')?.disabled,
    locationOnlyCard: readout.classList.contains('place-action-card'),
    compactHeight: Math.round(readout.getBoundingClientRect().height),
    roadBlockPresent: Boolean(readout.querySelector('.readout-road-block')),
  };
});
check('a road tap leads with safety and useful bike/road facts',
  compact.heading === 'Interurban Trail'
    && /Passes your rules|Bike network/.test(compact.safety)
    && compact.facts.some((fact) => fact.startsWith('Bike accommodation'))
    && compact.facts.some((fact) => fact.startsWith('Speed')),
  JSON.stringify(compact));
check('the compact action row clearly groups route, Google, and detail tools',
  compact.primaryActions.join('|') === 'Navigate|Google Maps|Details',
  JSON.stringify(compact.primaryActions));
check('Navigate discloses Start, New stop, and Destination choices in trip order',
  compact.routeMenuHidden && compact.routeChoices.join('|') === 'Start|New stop|Destination',
  JSON.stringify(compact));
check('technical rows exist but begin hidden behind Details',
  compact.detailsHidden && compact.tableHiddenInsideDetails, JSON.stringify(compact));
check('Google Maps discloses Street View and Maps without leaving button clutter',
  compact.mapMenuHidden && compact.mapActions.join('|') === 'Street View|Maps',
  JSON.stringify(compact));
check('an ordinary road does not offer a route roadblock',
  !compact.roadBlockPresent, JSON.stringify(compact));
check('a road tap remains a road-details card, not a searched-place card',
  compact.locationOnlyCard === false);
check('New stop is visible but unavailable until the trip has both endpoints',
  compact.stopDisabled === true);
check('the richer collapsed phone card remains compact enough to leave the map visible',
  compact.compactHeight < 300,
  `${compact.compactHeight}px`);

await page.locator('#readout .readout-primary-google').click();
check('the Google disclosure opens in place', await page.evaluate(() =>
  !document.querySelector('#readout .readout-google-menu').hidden
    && document.querySelector('#readout .readout-primary-google').getAttribute('aria-expanded') === 'true'));
await page.locator('#readout .streetview-launch').click();
check('Street View stays in the app while MapLibre is hidden underneath on iOS-safe compositing',
  await page.evaluate(() => document.getElementById('streetViewDialog').open
    && document.body.classList.contains('street-view-open')
    && document.getElementById('streetViewFrame').src.includes('/maps/embed/v1/streetview')));
await page.evaluate(() => document.getElementById('streetViewDialog').close());
await page.waitForFunction(() => !document.body.classList.contains('street-view-open'));
check('closing Street View restores the live map', await page.evaluate(() =>
  !document.body.classList.contains('street-view-open')));

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

await page.locator('#readout .readout-primary-route').click();
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
  safety: document.querySelector('#readout .readout-safety-summary')?.textContent,
  detailsHidden: document.getElementById('mapTapDetails')?.hidden,
}));
check('a programmatically selected location can still use the routing card',
  blank.heading === 'Point on map' && /Use this point/.test(blank.safety)
    && blank.detailsHidden, JSON.stringify(blank));
await page.locator('#readout .readout-primary-route').click();
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
  links: [...document.querySelectorAll('#readout .readout-google-menu .road-map-actions > *')]
    .map((element) => element.textContent),
}));
check('Details restores the original source heading while map tools remain available',
  expanded.expanded === 'true' && expanded.hidden === false
    && expanded.heading === 'Point on map'
    && expanded.links.join('|') === 'Street View|Maps', JSON.stringify(expanded));
check('Details does not add GPS coordinates',
  !/47\.95000|-122\.30500|Location/.test(expanded.detailsText), expanded.detailsText);
await page.locator('#readout .readout-primary-route').click();
await page.locator('#readout .map-point-stop').click();
check('Add stop commits the tapped map point to the visible itinerary', await page.evaluate(() =>
  routing.vias.length === 1 && routing.vias[0].name === 'Point on map'
    && document.querySelector('.route-stop-edit strong')?.textContent === 'Point on map'));

const routeSegmentBlock = await page.evaluate(() => {
  document.getElementById('readout').querySelector('.readout-details-toggle')?.click();
  HIT_SRC['test-active-route-hit'] = ROUTESEG_SRC;
  renderReadout({
    layer: { id: 'test-active-route-hit' },
    properties: {
      name: 'Example active route road', level: 1, mph: 25, sh: 4, shBack: 2,
      lanes: 2, facility: 2, lenM: 420, surface: 1, gradePct: 2.4,
    },
    geometry: { type: 'LineString', coordinates: [[-122.31, 47.94], [-122.30, 47.95]] },
  }, { lng: -122.305, lat: 47.945 }, { x: 180, y: 360 });
  const readout = document.getElementById('readout');
  return {
    button: readout.querySelector('.readout-road-block')?.textContent,
    detailsHidden: document.getElementById('mapTapDetails').hidden,
    actionRow: [...readout.querySelectorAll('.readout-primary-actions > button')]
      .map((button) => ({ text: button.textContent, top: Math.round(button.getBoundingClientRect().top) })),
  };
});
check('Avoid appears in the single compact action row only for a selected-route segment',
  routeSegmentBlock.button === 'Avoid' && routeSegmentBlock.detailsHidden
    && routeSegmentBlock.actionRow.map((item) => item.text).join('|') === 'Navigate|Google Maps|Avoid|Details'
    && new Set(routeSegmentBlock.actionRow.map((item) => item.top)).size === 1,
  JSON.stringify(routeSegmentBlock));

const blankTap = await page.evaluate(() => {
  roadInfoSuppressedUntil = 0;
  dismissRoadInfo();
  const original = featureAt;
  featureAt = () => null;
  const opened = inspectRoadAt({ x: 120, y: 240 }, { lng: -122.4, lat: 47.7 });
  featureAt = original;
  return {
    opened,
    shown: document.getElementById('readout').classList.contains('show'),
    heading: document.querySelector('#readout .rt-title')?.textContent,
    actions: [...document.querySelectorAll('#readout .readout-route-menu .readout-route-actions button')]
      .map((button) => button.textContent),
  };
});
check('a blank map tap opens a useful generic point card',
  blankTap.opened && blankTap.shown && blankTap.heading === 'Point on map'
    && blankTap.actions.join('|') === 'Start|New stop|Destination',
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
