#!/usr/bin/env node
// Installed maps provide their complete offline place indexes. An uninstalled
// map contributes only the measured store summary, and choosing one of those
// results resumes the same endpoint intent after a confirmed installation.
import { createHash } from 'node:crypto';
import { check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';

const config = (id, name, readiness, bounds, center) => ({
  id, name, status: 'released', readiness, summary: `${name} synthetic map.`,
  bounds, defaultCenter: center, defaultZoom: 9,
  stressAgency: `${name} DOT`, restrictionAgency: `${name} DOT`, speedAgency: `${name} DOT`,
  facilitySourceName: `${name} facilities`, stressLayerName: `${name} stress`,
  restrictionLayerName: `${name} restrictions`, interstateRoutePrefixes: [],
  stateRoutePrefixes: [], facilityLevels: {}, routeDirectionSuffixes: {}, versions: {},
  datasets: { graph: false, roads: false, basemap: false, overlays: false,
    places: true, ferries: false, bikeroutes: false, restrictions: false, closures: false },
});
const wa = config('washington', 'Washington', 8,
  { minLon: -124.9, maxLon: -116.8, minLat: 45.5, maxLat: 49.1 }, [-122.33, 47.61]);
const or = config('oregon', 'Oregon', 7,
  { minLon: -124.8, maxLon: -116.3, minLat: 41.8, maxLat: 46.4 }, [-122.67, 45.52]);
const placeBodies = {
  washington: JSON.stringify([['Seattle', -122.33006, 47.60383, 'city', 737015]]),
  oregon: JSON.stringify([
    ['Portland', -122.67419, 45.52025, 'city', 652503],
    ['Eugene', -123.09505, 44.05051, 'city', 159150],
  ]),
};
const summary = (state, rows) => ({
  format: 1, sourcePath: 'places.json', sourceBytes: Buffer.byteLength(placeBodies[state.id]),
  completeResultCount: rows.length, resultCount: rows.length,
  entries: rows.map((row) => ({
    id: `${state.id}:${createHash('sha256').update(JSON.stringify(row.slice(0, 5)))
      .digest('hex').slice(0, 20)}`,
    name: row[0], lon: row[1], lat: row[2], type: row[3], population: row[4],
  })),
});
const storeState = (state) => {
  const rows = JSON.parse(placeBodies[state.id]);
  const file = { dataset: 'places', path: 'places.json', bytes: Buffer.byteLength(placeBodies[state.id]) };
  return { ...state, files: [file], placeSearch: summary(state, rows), acquisitions: [{
    acquisitionFormat: 1, id: `map-${state.id}-fixture`, kind: 'state-map',
    stateIds: [state.id], totalBytes: file.bytes, files: [file],
  }] };
};
const waStore = storeState(wa), orStore = storeState(or);

const site = await serveRepo();
site.publish('/maps/states.js', `(function (root) {
  root.MAP_STATES_BUNDLED = false;
  root.MAP_STORE_DEFAULT_URL = 'http://localhost:${site.port}/search-store/';
  root.MAP_STATES = ${JSON.stringify([or, wa])};
  root.MAP_STATE_ACQUISITIONS = {};
}(typeof self !== 'undefined' ? self : this));`);
site.publish('/search-store/index.json', JSON.stringify({
  storeFormat: 2, states: [orStore, waStore],
}));
for (const state of [wa, or]) {
  site.publish(`/search-store/${state.id}/places.json`, placeBodies[state.id]);
  site.publish(`/maps/${state.id}/places.json`, placeBodies[state.id]);
}

const browser = await launchBrowser();
try {
  const context = await browser.newContext({ serviceWorkers: 'block',
    viewport: { width: 430, height: 900 }, hasTouch: true, isMobile: true });
  await context.addInitScript(({ installed }) => {
    if (!localStorage.getItem('jra-installed-states-1')) {
      localStorage.setItem('jra-installed-states-1', JSON.stringify([{
        state: installed, storeUrl: '/search-store/', installedAt: Date.now(), cachedRequests: [],
      }]));
    }
    localStorage.setItem('jra-map-state-1', 'washington');
  }, { installed: waStore });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(site.url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.map && map.loaded() && typeof openPlaceSearch === 'function');
  await page.evaluate(() => openPlaceSearch('end'));
  await page.fill('#placeSearch', 'Eugene');
  await page.waitForSelector('#placeResults .place-hit[data-state-id="oregon"]');
  const offered = await page.evaluate(() => {
    const row = document.querySelector('#placeResults .place-hit[data-state-id="oregon"]');
    return {
      name: row?.dataset.name, stateId: row?.dataset.stateId,
      requiresDownload: row?.dataset.requiresDownload,
      detail: row?.querySelector('small')?.textContent,
      scope: document.querySelector('#placeResults .place-results-scope')?.textContent,
    };
  });
  const uninstalledFullRequests = () => site.requests.filter((request) =>
    request.url.includes('/oregon/places.json')).length;
  check('searching Washington offers Eugene from Oregon with explicit state identity',
    offered.name === 'Eugene' && offered.stateId === 'oregon'
      && offered.requiresDownload === 'true' && /Oregon.*Download map/.test(offered.detail),
    JSON.stringify(offered));
  check('the Oregon offer came from the capped store summary, not its complete place index',
    uninstalledFullRequests() === 0, `requests ${uninstalledFullRequests()}`);

  await page.click('#placeResults .place-hit[data-state-id="oregon"] .place-result-summary');
  await page.waitForSelector('#mapStateDialog[open]');
  const card = await page.evaluate(() => ({
    title: document.getElementById('mapStateTitle').textContent,
    status: document.getElementById('mapStateStatus').textContent,
    routeUse: document.getElementById('mapStateFacts').textContent,
    pending: JSON.parse(localStorage.getItem('jra-pending-map-route-intent-1') || 'null'),
  }));
  check('choosing Eugene stops at an Oregon confirmation with the route implication',
    card.title === 'Oregon' && /Available to download/.test(card.status)
      && /No routing graph offered/.test(card.routeUse) && card.pending?.target === 'end',
    JSON.stringify(card));

  await Promise.all([
    page.waitForFunction(() => Region.id === 'washington'
      && MapStore.availability('oregon') === 'installed'
      && routing.endStateId === 'oregon' && routing.endName === 'Eugene', { timeout: 30000 }),
    page.click('#mapStatePrimary'),
  ]);
  const resumed = await page.evaluate(() => ({
    home: Region.id, end: routing.end, endName: routing.endName,
    endStateId: routing.endStateId,
    pending: localStorage.getItem('jra-pending-map-route-intent-1'),
    installed: MapStore.installedStateIds(),
  }));
  check('installation retains Washington as home and resumes the exact Eugene endpoint',
    resumed.home === 'washington' && resumed.endStateId === 'oregon'
      && resumed.endName === 'Eugene' && resumed.pending === null
      && resumed.installed.join('|') === 'oregon|washington', JSON.stringify(resumed));

  await page.evaluate(async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    placesPromise = null;
    placesIndex = null;
    await ensurePlaces();
    openPlaceSearch('start');
    const input = document.getElementById('placeSearch');
    input.value = 'Seattle';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForSelector('#placeResults .place-hit[data-state-id="washington"]');
  const offline = await page.evaluate(() => ({
    stateId: document.querySelector('#placeResults .place-hit')?.dataset.stateId,
    scope: document.querySelector('#placeResults .place-results-scope')?.textContent,
    internet: Boolean(document.querySelector('#placeResults .place-internet-search')),
  }));
  check('offline search states its installed-map scope and offers no internet action',
    offline.stateId === 'washington' && /Offline search covers installed maps: Oregon, Washington/.test(offline.scope)
      && !offline.internet, JSON.stringify(offline));

  const dedup = await page.evaluate(async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    placesIndex = [
      ['Border Ferry', -122.7600, 45.6100, 'ferry', 0, 'washington', 'osm:n123'],
      ['Border Ferry', -122.7603, 45.6102, 'ferry', 0, 'oregon', 'osm:n123'],
    ];
    placeSearchLoadedStateIds = ['oregon', 'washington'];
    availablePlacesIndex = [];
    placesPromise = Promise.resolve();
    openPlaceSearch('end');
    const input = document.getElementById('placeSearch');
    input.value = 'Border Ferry';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
    return [...document.querySelectorAll('#placeResults .place-hit:not(.place-internet-search)')]
      .map((row) => ({ name: row.dataset.name, stateId: row.dataset.stateId }));
  });
  check('border duplicates collapse by stable source identity only in displayed results',
    dedup.length === 1 && dedup[0].name === 'Border Ferry', JSON.stringify(dedup));
  check('cross-state place search has no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await site.close();
}

done();
