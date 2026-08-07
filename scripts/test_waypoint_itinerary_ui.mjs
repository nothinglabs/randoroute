#!/usr/bin/env node
// Start, stops, and destination are one ordered itinerary. Reordering is
// drafted in one dialog and applied once, while location search stays separate.
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

const initial = await page.evaluate(() => {
  clearRoute();
  routing.worker?.terminate?.();
  routing.worker = { postMessage: () => {} };
  routing.ready = true;
  routing.loading = false;
  setRoutePoint('start', { lng: -122.335, lat: 47.61 }, 'Seattle');
  setRoutePoint('end', { lng: -122.76, lat: 48.12 }, 'Port Townsend');
  addVia({ lng: -122.305, lat: 47.95 }, { name: 'Mukilteo' });
  addVia({ lng: -122.48, lat: 48.03 }, { name: 'Point on map' });
  const card = document.querySelector('.route-endpoints').getBoundingClientRect();
  const search = document.getElementById('rb-search').getBoundingClientRect();
  const reorder = document.getElementById('rb-reorder').getBoundingClientRect();
  return {
    itinerary: [...document.querySelectorAll('.route-endpoint, .route-stop-edit')]
      .map((element) => `${element.querySelector('.endpoint-label')?.textContent} ${element.querySelector('.endpoint-copy strong')?.textContent}`),
    oldControlsGone: !document.getElementById('rb-via') && !document.getElementById('rb-more')
      && !document.getElementById('routeActionsMenu'),
    endpointControls: document.querySelectorAll('.route-endpoint-row .route-stop-action').length,
    inlineArrows: document.querySelectorAll('#routeBar .route-stop-up, #routeBar .route-stop-down, [data-endpoint-move]').length,
    reorderEnabled: !document.getElementById('rb-reorder').disabled,
    endpointWidth: Math.round(card.width),
    viewportWidth: innerWidth,
    actionBoxes: [...document.querySelectorAll('.route-stop-action')].slice(0, 3).map((button) => {
      const box = button.getBoundingClientRect();
      return { width: Math.round(box.width), height: Math.round(box.height) };
    }),
    markerNumbers: routing.vias.map((via) =>
      via.marker.getElement().querySelector('.waypoint-marker-number')?.textContent),
    cardInsidePhone: card.left >= 0 && card.right <= innerWidth,
    searchInsidePhone: search.left >= 0 && search.right <= innerWidth,
    reorderAboveSearch: reorder.bottom <= search.top,
    toolBoxes: [reorder, search].map((box) => ({
      width: Math.round(box.width), height: Math.round(box.height),
    })),
  };
});
check('the main card shows start, named stops, and destination in trip order',
  initial.itinerary.join(' | ') === 'From Seattle | Stop 1 Mukilteo | Stop 2 Point on map | To Port Townsend',
  JSON.stringify(initial.itinerary));
check('inline reorder arrows are gone while delete, reorder, and search remain available',
  initial.oldControlsGone && initial.endpointControls === 2
    && initial.inlineArrows === 0 && initial.reorderEnabled, JSON.stringify(initial));
check('map stop pins use the same itinerary numbers',
  initial.markerNumbers.join(',') === '1,2', JSON.stringify(initial.markerNumbers));
check('the itinerary and search button fit the phone viewport',
  initial.cardInsidePhone && initial.searchInsidePhone, JSON.stringify(initial));
check('the single reorder control sits above Search and both are finger-sized',
  initial.reorderAboveSearch
    && initial.toolBoxes.every((box) => box.width >= 40 && box.height >= 40),
  JSON.stringify(initial));
check('the itinerary spans the phone and its delete targets are finger-sized',
  initial.endpointWidth >= initial.viewportWidth * .78
    && initial.actionBoxes.every((box) => box.width >= 36 && box.height >= 40),
  JSON.stringify(initial));

await page.locator('[data-via-edit="0"]').focus();
check('routine route UI refreshes do not steal focus from a stop control', await page.evaluate(() => {
  updateArmButtons();
  return document.activeElement?.dataset?.viaEdit === '0';
}));

await page.evaluate(() => {
  window.__originalComputeRoute = computeRoute;
  window.__orderComputeCalls = 0;
  computeRoute = () => { window.__orderComputeCalls++; };
});
await page.locator('#rb-reorder').click();
const reorderDialog = await page.evaluate(() => ({
  open: document.getElementById('reorderRouteDialog').open,
  names: [...document.querySelectorAll('.reorder-route-copy strong')].map((element) => element.textContent),
  roles: [...document.querySelectorAll('.reorder-route-copy span')].map((element) => element.textContent),
}));
check('the reorder button opens one complete itinerary in a dialog when multiple stops exist',
  reorderDialog.open
    && reorderDialog.names.join('|') === 'Seattle|Mukilteo|Point on map|Port Townsend'
    && reorderDialog.roles.join('|') === 'Start|Stop 1|Stop 2|Destination',
  JSON.stringify(reorderDialog));

await page.locator('[data-reorder-index="1"][data-reorder-direction="1"]').click();
const whileEditing = await page.evaluate(() => ({
  draft: [...document.querySelectorAll('.reorder-route-copy strong')].map((element) => element.textContent),
  route: [routing.startName, ...routing.vias.map((via) => via.name), routing.endName],
  computes: window.__orderComputeCalls,
}));
check('dialog edits stay in a draft and do not recalculate the route',
  whileEditing.draft.join('|') === 'Seattle|Point on map|Mukilteo|Port Townsend'
    && whileEditing.route.join('|') === 'Seattle|Mukilteo|Point on map|Port Townsend'
    && whileEditing.computes === 0, JSON.stringify(whileEditing));

await page.locator('#reorderRouteDone').click();
await page.waitForFunction(() => window.__orderComputeCalls === 1);
const reordered = await page.evaluate(() => {
  const result = {
    open: document.getElementById('reorderRouteDialog').open,
    computes: window.__orderComputeCalls,
    start: routing.startName,
    names: routing.vias.map((via) => via.name),
    end: routing.endName,
    labels: [...document.querySelectorAll('.route-stop-edit strong')].map((element) => element.textContent),
    markerNumbers: routing.vias.map((via) =>
      via.marker.getElement().querySelector('.waypoint-marker-number')?.textContent),
  };
  computeRoute = window.__originalComputeRoute;
  return result;
});
check('closing applies the final order and recalculates exactly once',
  !reordered.open && reordered.computes === 1
    && reordered.start === 'Seattle' && reordered.end === 'Port Townsend'
    && reordered.names.join('|') === 'Point on map|Mukilteo'
    && reordered.labels.join('|') === 'Point on map|Mukilteo', JSON.stringify(reordered));
check('map pin numbering follows the applied stop order',
  reordered.markerNumbers.join(',') === '1,2', JSON.stringify(reordered));

const shared = await page.evaluate(() => readSharedRoute(shareRouteUrl())?.route?.vn);
check('shared routes preserve the applied stop order', shared?.join('|') === 'Point on map|Mukilteo',
  JSON.stringify(shared));

/* The main itinerary remains stable after a routine refresh. */
const refreshed = await page.evaluate(() => ({
  names: routing.vias.map((via) => via.name),
  labels: [...document.querySelectorAll('.route-stop-edit strong')].map((element) => element.textContent),
}));
check('routine refreshes preserve the applied itinerary',
  refreshed.names.join('|') === 'Point on map|Mukilteo'
    && refreshed.labels.join('|') === 'Point on map|Mukilteo', JSON.stringify(refreshed));

await page.locator('[data-via-edit="1"]').click();
await page.waitForSelector('#readout.show');
const stopCard = await page.evaluate(() => ({
  title: document.querySelector('#readout .rt-title')?.textContent.trim(),
  pickerHidden: document.getElementById('placePicker').hidden,
}));
check('tapping an itinerary place shows it on the map instead of opening a targeted picker',
  stopCard.title === 'Mukilteo' && stopCard.pickerHidden, JSON.stringify(stopCard));

await page.locator('#rb-search').click();
await page.locator('#placeSearch').fill('Seattle');
await page.waitForSelector('#placeResults .place-internet-search');
const genericSearch = await page.evaluate(() => ({
  title: document.getElementById('placePickerTitle').textContent,
  last: document.querySelector('#placeResults .place-hit:last-child')?.textContent.trim(),
  focused: document.activeElement?.id,
}));
check('search is generic and offers internet search as the final result',
  genericSearch.title === 'Search map'
    && genericSearch.last.startsWith('Search with internet')
    && genericSearch.focused === 'placeSearch', JSON.stringify(genericSearch));

const routeBeforeSearchChoice = await page.evaluate(() => JSON.stringify({
  start: routing.start, end: routing.end, vias: routing.vias.map((via) => via.pt),
}));
await page.locator('#placeResults .place-hit:not(.place-internet-search)').first().click();
await page.waitForSelector('#readout.show');
const searchChoice = await page.evaluate(() => ({
  indicator: document.querySelectorAll('.search-result-marker').length,
  route: JSON.stringify({ start: routing.start, end: routing.end, vias: routing.vias.map((via) => via.pt) }),
  actions: [...document.querySelectorAll('#readout .readout-route-actions button')]
    .map((button) => button.textContent),
  hasDetails: Boolean(document.querySelector('#readout .readout-details-toggle')),
  compact: document.getElementById('readout').classList.contains('place-action-card'),
  cardHeight: Math.round(document.getElementById('readout').getBoundingClientRect().height),
  overlapsPin: (() => {
    const card = document.getElementById('readout').getBoundingClientRect();
    const pin = document.querySelector('.search-result-marker').getBoundingClientRect();
    return !(card.bottom <= pin.top || pin.bottom <= card.top
      || card.right <= pin.left || pin.right <= card.left);
  })(),
}));
check('a search result is indicated on the map without silently changing the trip',
  searchChoice.indicator === 1 && searchChoice.route === routeBeforeSearchChoice,
  JSON.stringify(searchChoice));
check('the searched point offers all three trip roles when endpoints already exist',
  searchChoice.actions.join('|') === 'Start|End|Add stop', JSON.stringify(searchChoice.actions));
check('a search result uses a compact location card with no road Details and never covers its pin',
  searchChoice.compact && !searchChoice.hasDetails
    && searchChoice.cardHeight < 105 && !searchChoice.overlapsPin,
  JSON.stringify(searchChoice));

await page.locator('#readout .readout-close').click();
check('closing the searched point also removes its temporary indicator', await page.evaluate(() =>
  document.querySelectorAll('.search-result-marker').length === 0));

await page.locator('#rb-search').click();
await page.locator('#placeSearch').fill('coffee');
await page.waitForSelector('#placeResults .place-internet-search');
await page.evaluate(() => {
  searchOnlinePlaces = async () => [{
    name: 'Test Coffee, Seattle, Washington', lon: -122.332, lat: 47.61,
    source: 'online', distanceM: 250,
  }];
});
await page.locator('#placeResults .place-internet-search').click();
await page.waitForSelector('#placeResults .place-hit:not(.place-internet-search)');
const internetMode = await page.evaluate(() => ({
  hint: document.getElementById('placePickerHint').textContent,
  result: document.querySelector('#placeResults .place-hit:not(.place-internet-search)')?.textContent,
  internetChoiceGone: !document.querySelector('#placeResults .place-internet-search'),
}));
check('the final result switches the dialog into internet-search mode',
  internetMode.hint.startsWith('Internet search is on')
    && internetMode.result.includes('Test Coffee') && internetMode.internetChoiceGone,
  JSON.stringify(internetMode));
await page.locator('#placePickerClose').click();

await page.locator('[data-via-index="0"] .route-stop-remove').click();
check('a stop can be removed directly from the itinerary', await page.evaluate(() =>
  routing.vias.length === 1
    && document.querySelectorAll('.route-stop-row').length === 1
    && document.querySelector('.route-stop-edit strong')?.textContent === 'Mukilteo'));

await page.locator('[data-endpoint-remove="start"]').click();
check('Start can be deleted without deleting the remaining itinerary', await page.evaluate(() =>
  !routing.start && routing.endName === 'Port Townsend' && routing.vias.length === 1
    && routing.last === null && !routing.startMarker));
await page.locator('[data-via-index] .route-stop-remove').click();
await page.locator('[data-endpoint-remove="end"]').click();
check('endpoint and stop X buttons can delete every route item', await page.evaluate(() =>
  !routing.start && !routing.end && routing.vias.length === 0
    && document.querySelectorAll('.route-stop-row').length === 0
    && document.querySelectorAll('[data-endpoint-remove]:not([hidden])').length === 0
    && document.getElementById('rb-reorder').disabled));

await page.evaluate(() => {
  setRoutePoint('start', { lng: -122.335, lat: 47.61 }, 'Seattle');
  setRoutePoint('end', { lng: -122.76, lat: 48.12 }, 'Port Townsend');
  addVia({ lng: -122.305, lat: 47.95 }, { name: 'Mukilteo' });
});
await page.locator('#rb-reorder').click();
check('with only one stop, the same button reverses the trip immediately without a dialog',
  await page.evaluate(() => routing.startName === 'Port Townsend'
    && routing.vias[0]?.name === 'Mukilteo' && routing.endName === 'Seattle'
    && !document.getElementById('reorderRouteDialog').open));

check('no page errors', page.pageErrors.length === 0, page.pageErrors.join(' | '));

const desktop = await appPage(browser, site.port, { desktop: true });
const desktopLayout = await desktop.evaluate(() => {
  clearRoute();
  routing.worker?.terminate?.();
  routing.worker = { postMessage: () => {} };
  routing.ready = true;
  routing.loading = false;
  setRoutePoint('start', { lng: -122.335, lat: 47.61 }, 'Seattle');
  setRoutePoint('end', { lng: -122.76, lat: 48.12 }, 'Port Townsend');
  addVia({ lng: -122.305, lat: 47.95 }, { name: 'Mukilteo' });
  const toolbar = document.getElementById('topToolbar').getBoundingClientRect();
  const card = document.querySelector('.route-endpoints').getBoundingClientRect();
  return {
    toolbarInside: toolbar.left >= 0 && toolbar.right <= innerWidth,
    cardInside: card.left >= 0 && card.right <= innerWidth,
    stopVisible: document.querySelector('.route-stop-edit strong')?.textContent === 'Mukilteo',
  };
});
check('the itinerary also fits and stays visible beside the desktop map panel',
  desktopLayout.toolbarInside && desktopLayout.cardInside && desktopLayout.stopVisible,
  JSON.stringify(desktopLayout));
check('no desktop page errors', desktop.pageErrors.length === 0, desktop.pageErrors.join(' | '));

await browser.close();
site.close();
process.exitCode = failed ? 1 : 0;
console.log(`\n${passed} passed, ${failed} failed`);
