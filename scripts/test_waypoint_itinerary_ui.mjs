#!/usr/bin/env node
// Destination is chosen first. Start appears afterwards, while generic search
// previews a place and endpoint-triggered search assigns it immediately.
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
  const blank = {
    startHidden: document.querySelector('.route-endpoint-start-row').hidden,
    destinationVisible: !document.querySelector('.route-endpoint-end-row').hidden,
    reorderGone: !document.getElementById('rb-reorder')
      && !document.getElementById('reorderRouteDialog'),
  };
  setRoutePoint('start', { lng: -122.335, lat: 47.61 }, 'Seattle');
  setRoutePoint('end', { lng: -122.76, lat: 48.12 }, 'Port Townsend');
  addVia({ lng: -122.305, lat: 47.95 }, { name: 'Mukilteo' });
  addVia({ lng: -122.48, lat: 48.03 }, { name: 'Point on map' });
  const card = document.querySelector('.route-endpoints').getBoundingClientRect();
  const search = document.getElementById('rb-search').getBoundingClientRect();
  return {
    blank,
    itinerary: [...document.querySelectorAll('.route-endpoint, .route-stop-edit')]
      .map((element) => `${element.querySelector('.endpoint-label')?.textContent} ${element.querySelector('.endpoint-copy strong')?.textContent}`),
    oldControlsGone: !document.getElementById('rb-via') && !document.getElementById('rb-more')
      && !document.getElementById('routeActionsMenu'),
    endpointControls: document.querySelectorAll('.route-endpoint-row .route-stop-action').length,
    inlineArrows: document.querySelectorAll('#routeBar .route-stop-up, #routeBar .route-stop-down, [data-endpoint-move]').length,
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
    searchBox: { width: Math.round(search.width), height: Math.round(search.height) },
  };
});
check('a blank planner shows Destination first and hides Start and all reordering UI',
  initial.blank.startHidden && initial.blank.destinationVisible && initial.blank.reorderGone,
  JSON.stringify(initial.blank));
check('the main card shows start, named stops, and destination in trip order',
  initial.itinerary.join(' | ') === 'From Seattle | Stop 1 Mukilteo | Stop 2 Point on map | To Port Townsend',
  JSON.stringify(initial.itinerary));
check('inline arrows and old route menus are gone while delete and search remain available',
  initial.oldControlsGone && initial.endpointControls === 2
    && initial.inlineArrows === 0, JSON.stringify(initial));
check('map stop pins use the same itinerary numbers',
  initial.markerNumbers.join(',') === '1,2', JSON.stringify(initial.markerNumbers));
check('the itinerary and search button fit the phone viewport',
  initial.cardInsidePhone && initial.searchInsidePhone, JSON.stringify(initial));
check('Search remains a finger-sized standalone control',
  initial.searchBox.width >= 40 && initial.searchBox.height >= 40, JSON.stringify(initial));
check('the itinerary spans the phone and its delete targets are finger-sized',
  initial.endpointWidth >= initial.viewportWidth * .78
    && initial.actionBoxes.every((box) => box.width >= 36 && box.height >= 40),
  JSON.stringify(initial));

await page.locator('[data-via-edit="0"]').focus();
check('routine route UI refreshes do not steal focus from a stop control', await page.evaluate(() => {
  updateArmButtons();
  return document.activeElement?.dataset?.viaEdit === '0';
}));

const shared = await page.evaluate(() => readSharedRoute(shareRouteUrl())?.route?.vn);
check('shared routes preserve stop order', shared?.join('|') === 'Mukilteo|Point on map',
  JSON.stringify(shared));

await page.locator('[data-via-edit="0"]').click();
await page.waitForSelector('#readout.show');
const stopCard = await page.evaluate(() => ({
  title: document.querySelector('#readout .rt-title')?.textContent.trim(),
  pickerHidden: document.getElementById('placePicker').hidden,
}));
check('tapping an itinerary place shows it on the map instead of opening a targeted picker',
  stopCard.title === 'Mukilteo' && stopCard.pickerHidden, JSON.stringify(stopCard));

await page.locator('#rb-start').click();
await page.locator('#placeSearch').fill('Seattle Heights');
await page.waitForSelector('#placeResults .place-hit:not(.place-internet-search)');
const targetedStart = await page.evaluate(() => ({
  title: document.getElementById('placePickerTitle').textContent,
  hint: document.getElementById('placePickerHint').textContent,
}));
await page.locator('#placeResults .place-hit:not(.place-internet-search)').first().click();
check('Start-triggered search assigns its result immediately without a prompt card',
  await page.evaluate(() => routing.startName.includes('Seattle Heights')
    && document.getElementById('placePicker').hidden
    && !document.getElementById('readout').classList.contains('show')
    && document.querySelectorAll('.search-result-marker').length === 0)
    && targetedStart.title === 'Choose start' && /search for your start/i.test(targetedStart.hint),
  JSON.stringify(targetedStart));

await page.locator('#rb-end').click();
await page.locator('#placeSearch').fill('Port Townsend');
await page.waitForSelector('#placeResults .place-hit:not(.place-internet-search)');
await page.locator('#placeResults .place-hit:not(.place-internet-search)').first().click();
check('Destination-triggered search also assigns directly', await page.evaluate(() =>
  routing.endName.includes('Port Townsend') && document.getElementById('placePicker').hidden
    && !document.getElementById('readout').classList.contains('show')));

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
    && document.querySelector('.route-stop-edit strong')?.textContent === 'Point on map'));

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
    && document.querySelector('.route-endpoint-start-row').hidden));

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
