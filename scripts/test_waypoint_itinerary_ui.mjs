#!/usr/bin/env node
// Stops belong to the trip itinerary: they are named, ordered, editable, and
// visible beside the start and destination on both phone and desktop layouts.
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
  const more = document.getElementById('rb-more').getBoundingClientRect();
  return {
    itinerary: [...document.querySelectorAll('.route-endpoint, .route-stop-edit')]
      .map((element) => `${element.querySelector('.endpoint-label')?.textContent} ${element.querySelector('.endpoint-copy strong')?.textContent}`),
    directAddStop: !document.getElementById('rb-via').hidden,
    roadBlockBuried: !!document.getElementById('rb-road-block')?.closest('#routeActionsMenu'),
    markerNumbers: routing.vias.map((via) =>
      via.marker.getElement().querySelector('.waypoint-marker-number')?.textContent),
    cardInsidePhone: card.left >= 0 && card.right <= innerWidth,
    moreInsidePhone: more.left >= 0 && more.right <= innerWidth,
  };
});
check('the main card shows start, named stops, and destination in trip order',
  initial.itinerary.join(' | ') === 'From Seattle | Stop 1 Mukilteo | Stop 2 Point on map | To Port Townsend',
  JSON.stringify(initial.itinerary));
check('Add stop is part of the itinerary while road blocks stay in More',
  initial.directAddStop && initial.roadBlockBuried, JSON.stringify(initial));
check('map stop pins use the same itinerary numbers',
  initial.markerNumbers.join(',') === '1,2', JSON.stringify(initial.markerNumbers));
check('the itinerary and More button fit the phone viewport',
  initial.cardInsidePhone && initial.moreInsidePhone, JSON.stringify(initial));

await page.locator('[data-via-edit="0"]').focus();
check('routine route UI refreshes do not steal focus from a stop control', await page.evaluate(() => {
  updateArmButtons();
  return document.activeElement?.dataset?.viaEdit === '0';
}));

await page.locator('[data-via-index="0"] .route-stop-down').click();
const reordered = await page.evaluate(() => ({
  names: routing.vias.map((via) => via.name),
  labels: [...document.querySelectorAll('.route-stop-edit strong')].map((element) => element.textContent),
  markerNumbers: routing.vias.map((via) =>
    via.marker.getElement().querySelector('.waypoint-marker-number')?.textContent),
}));
check('a stop can be moved later directly from the card',
  reordered.names.join('|') === 'Point on map|Mukilteo'
    && reordered.labels.join('|') === 'Point on map|Mukilteo', JSON.stringify(reordered));
check('map pin numbering follows reordered stops',
  reordered.markerNumbers.join(',') === '1,2', JSON.stringify(reordered));

await page.locator('[data-via-edit="1"]').click();
const editOpen = await page.evaluate(() => ({
  title: document.getElementById('placePickerTitle').textContent,
  value: document.getElementById('placeSearch').value,
  activeRow: document.querySelector('[data-via-index="1"]')?.classList.contains('active'),
}));
check('tapping a stop opens an in-place Change stop picker with its current name',
  editOpen.title === 'Change stop 2' && editOpen.value === 'Mukilteo' && editOpen.activeRow,
  JSON.stringify(editOpen));

await page.evaluate(() => {
  const hit = document.createElement('button');
  hit.className = 'place-hit';
  hit.dataset.lon = '-122.686';
  hit.dataset.lat = '48.219';
  hit.dataset.name = 'Coupeville';
  document.getElementById('placeResults').append(hit);
  hit.click();
});
check('choosing a search result updates the stop name and coordinate', await page.evaluate(() =>
  routing.vias[1].name === 'Coupeville'
    && document.querySelector('[data-via-index="1"] .route-stop-edit strong')?.textContent === 'Coupeville'));

const endpointEdit = await page.evaluate(() => {
  const before = routing.vias.map((via) => via.name);
  setRoutePoint('end', { lng: -122.77, lat: 48.13 }, 'New destination');
  return { before, after: routing.vias.map((via) => via.name) };
});
check('changing an endpoint preserves the rider’s stops',
  endpointEdit.before.join('|') === endpointEdit.after.join('|'), JSON.stringify(endpointEdit));

const shared = await page.evaluate(() => {
  const decoded = readSharedRoute(shareRouteUrl());
  return decoded?.route?.vn;
});
check('shared routes preserve stop names', shared?.join('|') === 'Point on map|Coupeville',
  JSON.stringify(shared));

await page.locator('[data-via-index="0"] .route-stop-remove').click();
check('a stop can be removed directly from the itinerary', await page.evaluate(() =>
  routing.vias.length === 1
    && document.querySelectorAll('.route-stop-row').length === 1
    && document.querySelector('.route-stop-edit strong')?.textContent === 'Coupeville'));

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
