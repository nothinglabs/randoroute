#!/usr/bin/env node
// A slim shell starts on the resident 51-jurisdiction orientation map, never
// fetches detailed state data before confirmation, supports local location
// suggestion, installs atomically, and keeps manual discovery after dismissal.
import { check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';

const state = (id, name, abbreviation, readiness, center, bounds) => ({
  id, name, status: 'released', readiness,
  summary: `${name} test map.`, bounds, defaultCenter: center, defaultZoom: 11,
  stressAgency: `${abbreviation} DOT`, restrictionAgency: `${abbreviation} DOT`,
  speedAgency: `${abbreviation} DOT`, facilitySourceName: `${abbreviation} facilities`,
  stressLayerName: `${abbreviation} stress`, restrictionLayerName: `${abbreviation} restrictions`,
  interstateRoutePrefixes: [], stateRoutePrefixes: [], facilityLevels: {},
  routeDirectionSuffixes: {}, datasets: { graph: false, roads: false, basemap: false,
    overlays: false, places: true, bikeroutes: false, restrictions: false, closures: false },
  versions: {},
});
const states = [
  state('oregon', 'Oregon', 'OR', 7, [-122.67, 45.52],
    { minLon: -124.8, maxLon: -116.3, minLat: 41.8, maxLat: 46.4 }),
  state('washington', 'Washington', 'WA', 8, [-122.33, 47.61],
    { minLon: -124.9, maxLon: -116.8, minLat: 45.5, maxLat: 49.1 }),
];
const places = new Map([
  ['oregon', JSON.stringify([['Portland', -122.67, 45.52, 'city', 1]])],
  ['washington', JSON.stringify([['Seattle', -122.33, 47.61, 'city', 1]])],
]);
const storeStates = states.map((config) => {
  const file = { dataset: 'places', path: 'places.json', bytes: Buffer.byteLength(places.get(config.id)) };
  return { ...config, files: [file], acquisitions: [{
    acquisitionFormat: 1, id: `map-${config.id}-test`, kind: 'state-map',
    stateIds: [config.id], totalBytes: file.bytes, files: [file],
  }] };
});

const site = await serveRepo();
site.publish('/maps/states.js', `(function (root) {
  root.MAP_STATES_BUNDLED = false;
  root.MAP_STORE_DEFAULT_URL = 'http://localhost:${site.port}/test-store/';
  root.MAP_STATES = ${JSON.stringify(states)};
  root.MAP_STATE_ACQUISITIONS = {};
}(typeof self !== 'undefined' ? self : this));`);
site.publish('/test-store/index.json', JSON.stringify({ storeFormat: 2, states: storeStates }));
for (const config of states) {
  site.publish(`/test-store/${config.id}/places.json`, places.get(config.id));
}

const browser = await launchBrowser();
try {
  const context = await browser.newContext({ serviceWorkers: 'block',
    viewport: { width: 430, height: 900 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(site.url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.map && map.loaded());
  await page.waitForSelector('#mapFirstRunDialog[open]');
  await page.waitForFunction(() =>
    document.querySelectorAll('#firstRunNationalMap .national-state').length === 51);

  const firstRun = await page.evaluate(() => ({
    local: Region.localDataAvailable,
    sourceIds: Object.keys(map.getStyle().sources),
    detailedRequests: performance.getEntriesByType('resource').map((entry) => entry.name)
      .filter((url) => /\.pmtiles|graph2\.bin\.gz/.test(url)),
    states: document.querySelectorAll('#firstRunNationalMap .national-state').length,
    oregonClass: document.querySelector('#firstRunNationalMap [data-state-id="oregon"]')?.getAttribute('class'),
    californiaClass: document.querySelector('#firstRunNationalMap [data-state-id="california"]')?.getAttribute('class'),
  }));
  check('a clean slim launch uses only the resident national boundary source',
    !firstRun.local && firstRun.sourceIds.join() === 'national-states'
      && firstRun.detailedRequests.length === 0, JSON.stringify(firstRun));
  check('the first-run map includes 50 states plus DC and distinguishes availability',
    firstRun.states === 51 && firstRun.oregonClass?.split(' ').includes('available')
      && firstRun.californiaClass?.split(' ').includes('unavailable'), JSON.stringify(firstRun));

  const beforeDownloadRequests = site.requests
    .filter((request) => request.url.includes('/test-store/oregon/places.json')).length;
  await page.click('#firstRunNationalMap [data-state-id="oregon"]');
  await page.waitForSelector('#mapStateDialog[open]');
  const card = await page.evaluate(() => ({
    title: document.getElementById('mapStateTitle').textContent,
    status: document.getElementById('mapStateStatus').textContent,
    primary: document.getElementById('mapStatePrimary').textContent,
    facts: document.getElementById('mapStateFacts').textContent,
  }));
  const afterCardRequests = site.requests
    .filter((request) => request.url.includes('/test-store/oregon/places.json')).length;
  check('tapping an available state opens details with size and does not download',
    card.title === 'Oregon' && /Available to download/.test(card.status)
      && /Download/.test(card.primary) && /Storage/.test(card.facts)
      && beforeDownloadRequests === afterCardRequests, JSON.stringify(card));

  await page.click('#mapStateDialog [data-close="mapStateDialog"]');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      getCurrentPosition(ok) {
        ok({ coords: { longitude: -122.67, latitude: 45.52, accuracy: 10 },
          timestamp: Date.now() });
      },
    } });
  });
  await page.click('#mapFirstRunLocation');
  await page.waitForFunction(() => document.getElementById('mapStateDialog').open
    && document.getElementById('mapStateTitle').textContent === 'Oregon');
  const suggestion = await page.textContent('#mapFirstRunStatus');
  check('explicit location use resolves locally and still stops at confirmation',
    /Oregon found/.test(suggestion)
      && site.requests.filter((request) => request.url.includes('/test-store/oregon/places.json')).length
        === afterCardRequests, suggestion);

  await Promise.all([
    page.waitForFunction(() => window.Region?.localDataAvailable === true
      && Region.id === 'oregon', { timeout: 30000 }),
    page.click('#mapStatePrimary'),
  ]);
  const installed = await page.evaluate(() => ({
    id: Region.id, local: Region.localDataAvailable,
    installed: MapStore.installedEntry('oregon')?.state?.id,
    onboardingOpen: document.getElementById('mapFirstRunDialog').open,
    sources: Object.keys(map.getStyle().sources),
  }));
  check('a confirmed install reloads into the selected state and skips first-run',
    installed.id === 'oregon' && installed.local && installed.installed === 'oregon'
      && !installed.onboardingOpen && !installed.sources.includes('national-states'),
    JSON.stringify(installed));
  await context.close();

  const dismissContext = await browser.newContext({ serviceWorkers: 'block',
    viewport: { width: 430, height: 900 }, hasTouch: true, isMobile: true });
  const dismissPage = await dismissContext.newPage();
  await dismissPage.goto(site.url, { waitUntil: 'load' });
  await dismissPage.waitForSelector('#mapFirstRunDialog[open]');
  await dismissPage.click('#mapFirstRunDismiss');
  await dismissPage.reload({ waitUntil: 'load' });
  await dismissPage.waitForFunction(() => window.openMapsDialog);
  const stayedDismissed = await dismissPage.evaluate(() =>
    document.getElementById('mapFirstRunDialog').open === false);
  await dismissPage.evaluate(() => openMapsDialog());
  await dismissPage.waitForFunction(() =>
    document.querySelectorAll('#mapsNationalMap .national-state').length === 51);
  check('dismissal survives reload while the manual national map remains available',
    stayedDismissed
      && await dismissPage.locator('#mapsNationalMap [data-state-id="oregon"]').count() === 1);
  await dismissContext.close();

  check('the first-run browser path has no JavaScript errors',
    pageErrors.length === 0, pageErrors.join(' | '));
} finally {
  await browser.close();
  await site.close();
}

done();
