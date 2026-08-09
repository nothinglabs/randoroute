#!/usr/bin/env node
// One card answers every map tap: a bare point, a chosen search result, and a
// road segment. It leads with identity (segment, place, region), then the
// safety verdict, then bike accommodation -- and surface ONLY when it is not
// paved. Route diagnostics stay behind the Details flip-down, which is built
// by subtraction so nothing the app knows can be dropped from it.
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
    identity: [...readout.querySelectorAll('.readout-identity-line')]
      .filter((line) => !line.hidden && line.textContent)
      .map((line) => line.textContent),
    detailsHidden: details?.hidden,
    detailsText: details?.textContent || '',
    tableHiddenInsideDetails: !!details?.querySelector('table'),
    locationOnlyCard: readout.classList.contains('place-action-card'),
    compactHeight: Math.round(readout.getBoundingClientRect().height),
    roadBlockPresent: Boolean(readout.querySelector('.readout-road-block')),
  };
});
check('a road tap leads with the segment name and its safety verdict',
  compact.heading === 'Interurban Trail'
    && compact.identity[0] === 'Interurban Trail'
    && /Passes your rules|Bike network/.test(compact.safety),
  JSON.stringify(compact));
check('and names the bike accommodation above the fold',
  compact.facts.some((fact) => fact.startsWith('Bike accommodation')),
  JSON.stringify(compact.facts));
// A paved road is the expected case; saying so every time trains riders to
// skip the line, and then they skip it when it says gravel.
check('but says nothing about surface when the road is paved',
  !compact.facts.some((fact) => fact.startsWith('Surface')),
  JSON.stringify(compact.facts));
check('the action row is Navigate, Street View and the details flip-down',
  compact.primaryActions.join('|') === 'Navigate|Street View|Details',
  JSON.stringify(compact.primaryActions));
check('technical rows exist but begin hidden behind Details',
  compact.detailsHidden && compact.tableHiddenInsideDetails, JSON.stringify(compact));
// Built by subtraction: what is above the fold is NOT repeated below it.
check('Details does not repeat what is already above the fold',
  !/Bike facility/.test(compact.detailsText) && !/Verdict/.test(compact.detailsText),
  compact.detailsText);
check('an ordinary road does not offer a route roadblock',
  !compact.roadBlockPresent, JSON.stringify(compact));
check('a road tap remains a road-details card, not a searched-place card',
  compact.locationOnlyCard === false);
check('the richer collapsed phone card remains compact enough to leave the map visible',
  compact.compactHeight < 300,
  `${compact.compactHeight}px`);

check('there is no Google Maps button left on the card', await page.evaluate(() =>
  !document.querySelector('#readout .readout-primary-google')
    && !document.querySelector('#readout .road-map-link')));
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
check('road Details keeps every technical row not already shown above',
  ['Speed limit', 'Shoulder', 'Area', 'Sidewalk (OSM)']
    .every((label) => originalDetails.text.includes(label))
    && !/47\.61500|-122\.33500|Location/.test(originalDetails.text), originalDetails.text);
// Suppressed above the fold is not the same as discarded: a paved surface is
// uninteresting at a glance and still a fact the rider can go and look up.
check('including a paved surface, which is only suppressed above the fold',
  /Surface/.test(originalDetails.text), originalDetails.text);
await page.locator('#readout .readout-details-toggle').click();
check('collapsing Details returns to the friendly road name', await page.evaluate(() =>
  document.querySelector('#readout .rt-title')?.textContent === 'Interurban Trail'));

await page.locator('#readout .readout-primary-route').click();
check('Navigate opens its own popup rather than an inline menu', await page.evaluate(() =>
  document.getElementById('mapPointNavigateDialog').open
    && [...document.querySelectorAll('#mapPointNavigateChoices button')]
      .map((button) => button.textContent).join('|') === 'Start|New stop|Destination'));
await page.locator('#mapPointNavigateChoices .map-point-end').click();
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
await page.locator('#mapPointNavigateChoices .map-point-start').click();
check('Start completes the route directly from the map', await page.evaluate(() =>
  routing.startName === 'Point on map'
    && routing.start[0] === -122.76 && routing.start[1] === 48.12));

await page.evaluate(() => renderReadout(null,
  { lng: -122.305, lat: 47.95 }, { x: 180, y: 360 }));
await page.locator('#readout .readout-primary-route').click();
check('Add stop is available once the itinerary has endpoints', await page.evaluate(() =>
  document.querySelector('#mapPointNavigateChoices .map-point-stop')?.disabled === false));
await page.evaluate(() => document.getElementById('mapPointNavigateDialog').close());
check('Options no longer contains an Add stop visibility setting', await page.evaluate(() =>
  !document.getElementById('r-showStopActions')));
// A bare point genuinely has nothing behind the fold -- the card refuses to
// offer an empty panel rather than opening one that says nothing. (Coordinates
// were deliberately never listed: they are not something a rider acts on.)
const expanded = await page.evaluate(() => ({
  disabled: document.querySelector('#readout .readout-details-toggle')?.disabled,
  detailsText: document.getElementById('mapTapDetails')?.textContent,
  streetView: !!document.querySelector('#readout .streetview-launch'),
}));
check('a bare point offers no empty Details panel, and still offers Street View',
  expanded.disabled === true && expanded.streetView, JSON.stringify(expanded));
check('and never invents GPS coordinates to fill it',
  !/47\.95000|-122\.30500|Location/.test(expanded.detailsText), expanded.detailsText);
await page.locator('#readout .readout-primary-route').click();
await page.locator('#mapPointNavigateChoices .map-point-stop').click();
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
check('the road block button appears only for a segment of the active route',
  routeSegmentBlock.button === 'Add road block' && routeSegmentBlock.detailsHidden
    && routeSegmentBlock.actionRow.map((item) => item.text).join('|')
      === 'Navigate|Street View|Add road block|Details'
    && new Set(routeSegmentBlock.actionRow.map((item) => item.top)).size === 1,
  JSON.stringify(routeSegmentBlock));

const blankTap = await page.evaluate(() => {
  roadInfoSuppressedUntil = 0;
  dismissRoadInfo();
  const original = featureAt;
  featureAt = () => null;
  const point = { x: 120, y: 240 };
  const opened = inspectRoadAt(point, map.unproject([point.x, point.y]));
  featureAt = original;
  const card = document.getElementById('readout').getBoundingClientRect();
  const marker = document.querySelector('.search-result-marker')?.getBoundingClientRect();
  const canvas = map.getCanvas().getBoundingClientRect();
  return {
    opened,
    shown: document.getElementById('readout').classList.contains('show'),
    heading: document.querySelector('#readout .rt-title')?.textContent,
    markerCount: document.querySelectorAll('.search-result-marker').length,
    markerSize: marker ? Math.max(marker.width, marker.height) : 0,
    markerOffset: marker ? Math.hypot(
      marker.left + marker.width / 2 - (canvas.left + point.x),
      marker.bottom - (canvas.top + point.y)) : Infinity,
    placement: document.getElementById('readout').dataset.pinPlacement,
    overlapsMarker: marker ? !(card.bottom <= marker.top || marker.bottom <= card.top
      || card.right <= marker.left || marker.right <= card.left) : true,
    navigate: !!document.querySelector('#readout .readout-primary-route'),
  };
});
check('a blank map tap opens a useful generic point card beside a temporary marker',
  blankTap.opened && blankTap.shown && blankTap.heading === 'Point on map'
    && blankTap.navigate
    && blankTap.markerCount === 1 && blankTap.markerSize <= 32 && blankTap.markerOffset <= 2
    && ['above', 'below', 'left', 'right'].includes(blankTap.placement)
    && !blankTap.overlapsMarker,
  JSON.stringify(blankTap));
await page.locator('#readout .readout-close').click();
check('closing map details also removes its temporary marker', await page.evaluate(() =>
  document.querySelectorAll('.search-result-marker').length === 0));

await page.evaluate(() => {
  const original = featureAt;
  featureAt = () => ({
    layer: { id: 'test-road-hit' },
    properties: { n: 'Marker Test Road', s: 30, w: 2, ft: 2, h: 'residential', u: 1 },
    geometry: { type: 'LineString', coordinates: [[-122.34, 47.61], [-122.33, 47.62]] },
  });
  const point = { x: 250, y: 360 };
  inspectRoadAt(point, map.unproject([point.x, point.y]));
  featureAt = original;
});
await page.locator('#readout .readout-details-toggle').click();
await page.waitForTimeout(50);
const expandedMarkerPlacement = await page.evaluate(() => {
  const card = document.getElementById('readout').getBoundingClientRect();
  const marker = document.querySelector('.search-result-marker').getBoundingClientRect();
  return {
    placement: document.getElementById('readout').dataset.pinPlacement,
    overlaps: !(card.bottom <= marker.top || marker.bottom <= card.top
      || card.right <= marker.left || marker.right <= card.left),
  };
});
check('expanded road Details repositions without covering the tapped marker',
  !expandedMarkerPlacement.overlaps
    && ['above', 'below', 'left', 'right'].includes(expandedMarkerPlacement.placement),
  JSON.stringify(expandedMarkerPlacement));
await page.locator('#readout .readout-close').click();

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
