#!/usr/bin/env node
// A slim PWA keeps the manifest that was current when a map was downloaded.
// When the default store adds another required artifact, both Maps surfaces
// must expose that as an update instead of treating the old pack as current.
// Updating remains atomic and writes the same archive stamp used by the
// service worker freshness check.
import { check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';

const PLACES = Buffer.from(JSON.stringify({ places: [] }));
const REGIONAL = Buffer.from('synthetic-regional-pmtiles');
const baseState = {
  id: 'oregon', name: 'Oregon', status: 'released', readiness: 7,
  summary: 'Synthetic Oregon map for update UI coverage.',
  bounds: { minLon: -124.8, maxLon: -116.3, minLat: 41.8, maxLat: 46.4 },
  defaultCenter: [-122.6765, 45.5231], defaultZoom: 11,
  stressAgency: 'ODOT', restrictionAgency: 'ODOT', speedAgency: 'ODOT',
  facilitySourceName: 'ODOT facilities', stressLayerName: 'ODOT stress',
  restrictionLayerName: 'ODOT restrictions', interstateRoutePrefixes: [],
  stateRoutePrefixes: [], facilityLevels: {}, routeDirectionSuffixes: {},
  datasets: { graph: false, roads: false, regional: false, basemap: false,
    overlays: false, places: true, ferries: false, bikeroutes: false,
    restrictions: false, closures: false },
  versions: {},
};
const placesFile = { dataset: 'places', path: 'places.json', bytes: PLACES.length };
const oldPlacesFile = { ...placesFile, bytes: 127057061 };
const regionalFile = {
  dataset: 'regional', path: 'regional.pmtiles', bytes: REGIONAL.length,
};
const oldState = {
  ...baseState,
  files: [oldPlacesFile],
  acquisitions: [{
    acquisitionFormat: 1, id: 'map-oregon-before-regional', kind: 'state-map',
    stateIds: ['oregon'], totalBytes: oldPlacesFile.bytes, files: [oldPlacesFile],
  }],
};
const latestState = {
  ...baseState,
  datasets: { ...baseState.datasets, regional: true },
  versions: { regional: 'sha-regional-update-test' },
  files: [placesFile, regionalFile],
  acquisitions: [{
    acquisitionFormat: 1, id: 'map-oregon-with-regional', kind: 'state-map',
    stateIds: ['oregon'], totalBytes: PLACES.length + REGIONAL.length,
    files: [placesFile, regionalFile],
  }],
};
const washingtonState = {
  ...baseState,
  id: 'washington', name: 'Washington', readiness: 8,
  summary: 'Synthetic Washington home map for update UI coverage.',
  bounds: { minLon: -124.9, maxLon: -116.8, minLat: 45.5, maxLat: 49.1 },
  defaultCenter: [-122.3321, 47.6062],
  files: [placesFile],
  acquisitions: [{
    acquisitionFormat: 1, id: 'map-washington-current', kind: 'state-map',
    stateIds: ['washington'], totalBytes: PLACES.length, files: [placesFile],
  }],
};

const site = await serveRepo();
const storeUrl = `http://localhost:${site.port}/upgrade-store/`;
site.publish('/maps/states.js', `(function (root) {
  root.MAP_STATES_BUNDLED = false;
  root.MAP_STATES_BUNDLED_IDS = [];
  root.MAP_STORE_DEFAULT_URL = ${JSON.stringify(storeUrl)};
  root.MAP_STATES = ${JSON.stringify([latestState, washingtonState]
    .map(({ files, acquisitions, ...state }) => state))};
  root.MAP_STATE_ACQUISITIONS = {
    oregon: ${JSON.stringify(latestState.acquisitions)},
    washington: ${JSON.stringify(washingtonState.acquisitions)}
  };
}(typeof self !== 'undefined' ? self : this));`);
site.publish('/upgrade-store/index.json', JSON.stringify({
  storeFormat: 2, states: [latestState, washingtonState],
}));
site.publish('/upgrade-store/oregon/places.json', PLACES);
site.publish('/upgrade-store/oregon/regional.pmtiles', REGIONAL);
site.publish('/upgrade-store/washington/places.json', PLACES);

const browser = await launchBrowser();
try {
  const context = await browser.newContext({ serviceWorkers: 'block',
    viewport: { width: 430, height: 900 }, hasTouch: true, isMobile: true });
  await context.addInitScript(({ installed, home, url }) => {
    if (!localStorage.getItem('jra-installed-states-1')) {
      localStorage.setItem('jra-installed-states-1', JSON.stringify(
        [installed, home].map((state) => ({
          state, storeUrl: url, installedAt: Date.now(), cachedRequests: [],
        }))));
      localStorage.setItem('jra-map-state-1', home.id);
    }
  }, { installed: oldState, home: washingtonState, url: storeUrl });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(site.url, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof openMapsDialog === 'function'
    && window.MapStore && window.Region);

  await page.evaluate(() => openMapsDialog());
  await page.waitForSelector('#mapsStateList .maps-state-update');
  const rowBefore = await page.evaluate(() => {
    const row = [...document.querySelectorAll('#mapsStateList .maps-state')]
      .find((candidate) => candidate.textContent.includes('Oregon'));
    const button = row?.querySelector('.maps-state-update');
    return {
      availability: MapStore.availability('oregon'),
      text: row?.textContent,
      action: button?.textContent,
      label: button?.getAttribute('aria-label'),
    };
  });
  check('an installed default-store map with an old manifest visibly offers Update',
    rowBefore.availability === 'installed' && rowBefore.action === 'Update'
      && /Update the downloaded Oregon map/.test(rowBefore.label || ''),
    JSON.stringify(rowBefore));

  const rowLayout = async (width) => {
    await page.setViewportSize({ width, height: 844 });
    return page.evaluate((viewportWidth) => {
      const row = [...document.querySelectorAll('#mapsStateList .maps-state')]
        .find((candidate) => candidate.textContent.includes('Oregon'));
      const rect = row.getBoundingClientRect();
      const children = [...row.children].map((child) => {
        const childRect = child.getBoundingClientRect();
        return { className: child.className, left: childRect.left, right: childRect.right,
          width: childRect.width };
      });
      return {
        width: viewportWidth, row: { left: rect.left, right: rect.right, width: rect.width },
        scrollWidth: row.scrollWidth, clientWidth: row.clientWidth, children,
        hasSize: !!row.querySelector('.maps-state-size'),
        hasUpdate: !!row.querySelector('.maps-state-update'),
        hasRemove: !!row.querySelector('.maps-state-remove'),
        badge: row.querySelector('.maps-state-badge')?.textContent,
        nameWidth: row.querySelector('.maps-state-name')?.getBoundingClientRect().width,
      };
    }, width);
  };
  const layouts = [await rowLayout(430), await rowLayout(390)];
  check('size, Update, Remove and On device stay inside the map row at phone widths',
    layouts.every((layout) => layout.hasSize && layout.hasUpdate && layout.hasRemove
      && layout.badge === 'On device' && layout.scrollWidth <= layout.clientWidth
      && layout.nameWidth >= 48
      && layout.children.every((child) => child.left >= layout.row.left - 0.5
        && child.right <= layout.row.right + 0.5)), JSON.stringify(layouts));

  await page.evaluate(() => openNationalStateCard('oregon'));
  await page.waitForSelector('#mapStateDialog[open]');
  const card = await page.evaluate(() => ({
    status: document.getElementById('mapStateStatus').textContent,
    action: document.getElementById('mapStatePrimary').textContent,
  }));
  check('the national state card also identifies and offers the update',
    card.status === 'Update available' && /^Update /.test(card.action),
    JSON.stringify(card));
  await page.evaluate(() => document.getElementById('mapStateDialog').close());

  await page.click('#mapsStateList .maps-state-update');
  // The accepted update RELOADS the page on success; every global below
  // belongs to the fresh boot. Waiting only on Region/MapStore raced the new
  // page's parse under suite load -- openMapsDialog was not defined yet --
  // so the readiness of the function itself is part of the wait.
  await page.waitForFunction(() => typeof openMapsDialog === 'function'
    && window.Region?.states
      ?.find((state) => state.id === 'oregon')?.datasets?.regional === true
    && window.MapStore?.installedEntry('oregon')?.state?.datasets?.regional === true,
  null, { timeout: 30000 });
  await page.evaluate(() => openMapsDialog());
  const updated = await page.evaluate(async () => {
    const cache = await caches.open(DATA_CACHE_NAME);
    const paths = (await cache.keys()).map((request) => new URL(request.url).pathname);
    const stamp = await cache.match('maps/oregon/.stamp/regional.pmtiles');
    const entry = MapStore.installedEntry('oregon');
    return {
      paths,
      stamp: stamp ? await stamp.text() : null,
      regional: entry?.state?.datasets?.regional,
      acquisitionIds: entry?.state?.acquisitions?.map((unit) => unit.id),
      updateStillShown: !!document.querySelector('#mapsStateList .maps-state-update'),
    };
  });
  check('Update installs the new regional archive and its freshness stamp',
    updated.paths.includes('/maps/oregon/regional.pmtiles')
      && updated.paths.includes('/maps/oregon/.stamp/regional.pmtiles')
      && updated.stamp === latestState.versions.regional,
    JSON.stringify(updated));
  check('the retained manifest advances and the Update action clears',
    updated.regional === true
      && updated.acquisitionIds?.includes('map-oregon-with-regional')
      && !updated.updateStillShown,
    JSON.stringify(updated));
  check('the update UI path has no JavaScript errors', errors.length === 0,
    errors.join(' | '));
  await context.close();
} finally {
  await browser.close();
  await site.close();
}

done();
