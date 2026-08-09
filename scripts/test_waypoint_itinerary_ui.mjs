#!/usr/bin/env node
// Start and Destination are always visible. Generic search previews a place,
// endpoint-triggered search assigns it immediately, and stops have no manual
// ordering controls.
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
    startVisible: !document.querySelector('.route-endpoint-start-row').hidden,
    destinationVisible: !document.querySelector('.route-endpoint-end-row').hidden,
    reorderGone: !document.getElementById('rb-reorder')
      && !document.getElementById('reorderRouteDialog'),
    reverseDisabled: document.getElementById('rb-reverse').disabled,
    addStopDisabled: document.getElementById('rb-add-stop').disabled,
    moreVisible: !document.getElementById('rb-more').hidden,
    moreMenuHidden: document.getElementById('routeMoreMenu').hidden,
    moreText: document.getElementById('rb-more').textContent.trim(),
    moreLabel: document.getElementById('rb-more').getAttribute('aria-label'),
    routePaneHidden: document.getElementById('panel').classList.contains('route-pane-hidden'),
    navigateHidden: document.getElementById('navStartButton').hidden,
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
    oldControlsGone: !document.getElementById('rb-via')
      && !document.getElementById('routeActionsMenu'),
    endpointControls: document.querySelectorAll('.route-endpoint-row .route-stop-action').length,
    stopArrows: document.querySelectorAll('#routeBar .route-stop-up, #routeBar .route-stop-down').length,
    endpointArrows: document.querySelectorAll('[data-endpoint-move]').length,
    reverseEnabled: !document.getElementById('rb-reverse').disabled,
    utilityLabels: [...document.querySelectorAll('.route-utility-label')]
      .map((label) => label.textContent),
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
    endpointHeight: Math.round(document.getElementById('rb-start').getBoundingClientRect().height),
    routePaneVisible: !document.getElementById('panel').classList.contains('route-pane-hidden'),
  };
});
check('a blank planner always shows Start and Destination without legacy reordering UI',
  initial.blank.startVisible && initial.blank.destinationVisible && initial.blank.reorderGone
    && initial.blank.reverseDisabled && initial.blank.addStopDisabled
    && initial.blank.moreVisible && initial.blank.moreMenuHidden
    && initial.blank.routePaneHidden && initial.blank.navigateHidden,
  JSON.stringify(initial.blank));
check('the main card shows start, named stops, and destination in trip order',
  initial.routePaneVisible
    && initial.itinerary.join(' | ') === 'Start Seattle | Stop 1 Mukilteo | Stop 2 Point on map | Destination Port Townsend',
  JSON.stringify(initial.itinerary));
check('stops have no manual order controls while Reverse and delete remain available',
  initial.oldControlsGone && initial.endpointControls === 2
    && initial.stopArrows === 0 && initial.endpointArrows === 0
    && initial.reverseEnabled, JSON.stringify(initial));
check('the compact trip menu uses a vertical ellipsis while Find stays explicit',
  initial.blank.moreText === '⋮' && initial.blank.moreLabel === 'Trip options'
    && initial.utilityLabels.join('|') === 'Find',
  JSON.stringify({ blank: initial.blank, labels: initial.utilityLabels }));
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
check('the compact Start and Destination rows keep their full-size text',
  initial.endpointHeight <= 40, JSON.stringify({ endpointHeight: initial.endpointHeight }));

await page.locator('[data-via-edit="0"]').focus();
check('routine route UI refreshes do not steal focus from a stop control', await page.evaluate(() => {
  updateArmButtons();
  return document.activeElement?.dataset?.viaEdit === '0';
}));

const shared = await page.evaluate(() => readSharedRoute(shareRouteUrl())?.route?.vn);
check('shared routes preserve stop order', shared?.join('|') === 'Mukilteo|Point on map',
  JSON.stringify(shared));

const incompleteRemoval = await page.evaluate(() => {
  clearRoute();
  routing.end = [-122.4443, 47.2529];
  routing.endName = 'Tacoma';
  routing.startDefaultsToDevice = false;
  addVia({ lng: -122.36, lat: 47.16 }, { name: '104th Street East' });
  addVia({ lng: -122.41, lat: 47.10 }, { name: 'Gem Heights Drive East' });
  const toast = document.getElementById('routeActionToast');
  removeVia(routing.vias[0]);
  return {
    text: document.getElementById('routeActionText').textContent,
    busy: toast.classList.contains('busy'),
    hidden: toast.hidden,
    routeActive: routing.routeRequestActive,
  };
});
check('removing a stop before Start is set also avoids a permanent routing spinner',
  /choose a start to route/i.test(incompleteRemoval.text)
    && !incompleteRemoval.busy && !incompleteRemoval.hidden
    && !incompleteRemoval.routeActive,
  JSON.stringify(incompleteRemoval));

// Restore the ordinary complete itinerary for the remaining interaction tests.
await page.evaluate(() => {
  clearRoute();
  setRoutePoint('start', { lng: -122.335, lat: 47.61 }, 'Seattle');
  setRoutePoint('end', { lng: -122.76, lat: 48.12 }, 'Port Townsend');
  addVia({ lng: -122.305, lat: 47.95 }, { name: 'Mukilteo' });
  addVia({ lng: -122.48, lat: 48.03 }, { name: 'Point on map' });
});

await page.locator('#rb-more').click();
const moreMenu = await page.evaluate(() => ({
  visible: !document.getElementById('routeMoreMenu').hidden,
  expanded: document.getElementById('rb-more').getAttribute('aria-expanded'),
  items: [...document.querySelectorAll('#routeMoreMenu > button')]
    .filter((button) => !button.hidden).map((button) => button.lastElementChild?.textContent.trim()),
  saveMovedToMenu: document.getElementById('routeLibraryBtn').closest('#routeMoreMenu') !== null,
  helpRemoved: !document.getElementById('appHelpBtn'),
  weightsRemovedFromMap: document.getElementById('appWeightsBtn').closest('#routeMoreMenu') !== null,
}));
check('Trip options contains trip editing, Save/Share, Weights, and updates',
  moreMenu.visible && moreMenu.expanded === 'true'
    && moreMenu.items.join('|') === 'Swap start & destination|Add stop|Save, load & share|Routing weights|Check for updates'
    && moreMenu.saveMovedToMenu && moreMenu.helpRemoved && moreMenu.weightsRemovedFromMap,
  JSON.stringify(moreMenu));
await page.locator('#rb-reverse').click();
check('Reverse swaps endpoints and reverses stop order', await page.evaluate(() =>
  routing.startName === 'Port Townsend' && routing.endName === 'Seattle'
    && routing.vias.map((via) => via.name).join('|') === 'Point on map|Mukilteo'
    && !routing.startFromDevice));
await page.locator('#rb-more').click();
await page.locator('#rb-reverse').click();
check('Reverse can restore the original trip order', await page.evaluate(() =>
  routing.startName === 'Seattle' && routing.endName === 'Port Townsend'
    && routing.vias.map((via) => via.name).join('|') === 'Mukilteo|Point on map'));

await page.locator('[data-via-edit="0"]').click();
await page.waitForSelector('#readout.show');
const stopCard = await page.evaluate(() => ({
  title: document.querySelector('#readout .rt-title')?.textContent.trim(),
  pickerHidden: document.getElementById('placePicker').hidden,
}));
check('tapping an itinerary place shows it on the map instead of opening a targeted picker',
  stopCard.title === 'Mukilteo' && stopCard.pickerHidden, JSON.stringify(stopCard));

await page.evaluate(() => setPanelOpen(true));
await page.locator('#rb-start').click();
await page.locator('#placeSearch').fill('Seattle Heights');
await page.waitForSelector('#placeResults .place-hit:not(.place-internet-search)');
await page.waitForTimeout(700); // measure after the deliberate picker entrance transition
const targetedStart = await page.evaluate(() => ({
  title: document.getElementById('placePickerTitle').textContent,
  hint: document.getElementById('placePickerHint').textContent,
  panelOpen: document.body.classList.contains('panel-open'),
  plannerVisible: getComputedStyle(document.querySelector('.route-endpoints')).display !== 'none',
  pickerBelowPlanner: document.getElementById('placePicker').getBoundingClientRect().top
    >= document.getElementById('routeBar').getBoundingClientRect().bottom,
}));
await page.locator('#placeResults .place-hit:not(.place-internet-search)').first().click();
check('Start-triggered search assigns its result immediately without a prompt card',
  await page.evaluate(() => routing.startName.includes('Seattle Heights')
    && document.getElementById('placePicker').hidden
    && !document.getElementById('readout').classList.contains('show')
    && document.querySelectorAll('.search-result-marker').length === 0)
    && targetedStart.title === 'Set start' && /tap the map to set your start/i.test(targetedStart.hint)
    && targetedStart.panelOpen && targetedStart.plannerVisible && targetedStart.pickerBelowPlanner,
  JSON.stringify(targetedStart));

await page.locator('#rb-end').click();
await page.locator('#placeSearch').fill('Port Townsend');
await page.waitForSelector('#placeResults .place-hit:not(.place-internet-search)');
await page.locator('#placeResults .place-hit:not(.place-internet-search)').first().click();
check('Destination-triggered search also assigns directly', await page.evaluate(() =>
  routing.endName.includes('Port Townsend') && document.getElementById('placePicker').hidden
    && !document.getElementById('readout').classList.contains('show')));

const stopCountBeforeSearch = await page.evaluate(() => routing.vias.length);
await page.locator('#rb-more').click();
await page.locator('#rb-add-stop').click();
const targetedStop = await page.evaluate(() => ({
  title: document.getElementById('placePickerTitle').textContent,
  hint: document.getElementById('placePickerHint').textContent,
  placeholder: document.getElementById('placeSearch').placeholder,
  armed: routing.arm,
}));
await page.locator('#placeSearch').fill('Mukilteo');
await page.waitForSelector('#placeResults .place-hit:not(.place-internet-search)');
await page.locator('#placeResults .place-hit:not(.place-internet-search)').first().click();
check('Add stop opens a targeted finder and adds its result immediately',
  await page.evaluate((priorCount) => routing.vias.length === priorCount + 1
    && routing.vias.at(-1).name.includes('Mukilteo')
    && document.getElementById('placePicker').hidden
    && !document.getElementById('readout').classList.contains('show'), stopCountBeforeSearch)
    && targetedStop.title === 'Add stop'
    && /tap the map to add a stop/i.test(targetedStop.hint)
    && targetedStop.placeholder === 'Search for a stop…'
    && targetedStop.armed === 'via',
  JSON.stringify(targetedStop));
await page.evaluate(() => removeVia(routing.vias.at(-1)));

await page.locator('#rb-search').click();
const genericOpened = await page.evaluate(() => ({
  title: document.getElementById('placePickerTitle').textContent,
  hint: document.getElementById('placePickerHint').textContent,
  focused: document.activeElement?.id,
}));
await page.locator('#placeSearch').fill('Seattle');
await page.waitForSelector('#placeResults .place-internet-search');
const genericSearch = await page.evaluate(() => ({
  title: document.getElementById('placePickerTitle').textContent,
  last: document.querySelector('#placeResults .place-hit:last-child')?.textContent.trim(),
  focused: document.activeElement?.id,
}));
check('search is generic and offers internet search as the final result',
  genericSearch.title === 'Find a place'
    && genericSearch.last.startsWith('Search with internet')
    && genericOpened.title === 'Find a place'
    && /search for a place/i.test(genericOpened.hint)
    && !/tap the map|trip/i.test(genericOpened.hint)
    && genericOpened.focused !== 'placeSearch', JSON.stringify({ genericOpened, genericSearch }));

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
  context: document.querySelector('#readout .place-action-context')?.textContent,
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
check('the searched point leads with routing but keeps the existing trip unchanged',
  searchChoice.actions.join('|') === 'Route here|Start here|Add stop'
    && /trip unchanged/i.test(searchChoice.context), JSON.stringify(searchChoice));
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
  /internet result/i.test(internetMode.hint)
    && internetMode.result.includes('Test Coffee') && internetMode.internetChoiceGone,
  JSON.stringify(internetMode));
await page.locator('#placePickerClose').click();

await page.locator('[data-via-index="0"] .route-stop-remove').click();
check('a stop can be removed directly from the itinerary', await page.evaluate(() =>
  routing.vias.length === 1
    && document.querySelectorAll('.route-stop-row').length === 1
    && document.querySelector('.route-stop-edit strong')?.textContent === 'Point on map'
    && document.querySelectorAll('.route-stop-up, .route-stop-down').length === 0));

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
    && !document.querySelector('.route-endpoint-start-row').hidden
    && document.getElementById('panel').classList.contains('route-pane-hidden')
    && document.getElementById('navStartButton').hidden));

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
