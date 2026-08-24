#!/usr/bin/env node
// A returning PWA must not activate a shell whose newly declared data file is
// absent from the old offline cache. Use tiny synthetic data responses so this
// exercises the real worker lifecycle without downloading the production map.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, done, launchBrowser, ROOT, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const workerSource = readFileSync(join(ROOT, 'sw.js'), 'utf8');
const regionalVersion = JSON.parse(readFileSync(
  join(ROOT, 'maps/washington/region.json'), 'utf8')).versions.regional;
const minimalPage = `<!doctype html><meta charset="utf-8"><title>worker upgrade</title>
<script>navigator.serviceWorker.register('./sw.js');</script>`;
site.publish('/', minimalPage);
site.publish('/index.html', minimalPage);

const syntheticData = new Map([
  ['ferries.geojson.gz', 'old-ferries'],
  ['bikeroutes.geojson.gz', 'old-routes'],
  ['bike_restrictions.geojson.gz', 'old-restrictions'],
  ['route_closures.geojson.gz', 'old-closures'],
  ['roads.pmtiles', 'old-roads'],
  ['regional.pmtiles', 'new-regional'],
  ['basemap.pmtiles', 'old-basemap'],
  ['overlays.pmtiles', 'old-overlays'],
  ['graph2.bin.gz', 'old-graph'],
  ['places.json', '{"places":[]}'],
]);
for (const [file, bytes] of syntheticData) {
  site.publish(`/maps/washington/${file}`, bytes);
}

const browser = await launchBrowser();
try {
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await context.newPage();
  await page.goto(site.url, { waitUntil: 'load' });
  await page.waitForFunction(() => navigator.serviceWorker.controller != null,
    null, { timeout: 120000 });

  const removed = await page.evaluate(async () => {
    const cache = await caches.open('data-offline-map-v9');
    const archive = await cache.delete('maps/washington/regional.pmtiles');
    const marker = await cache.delete('maps/washington/.stamp/regional.pmtiles');
    return { archive, marker };
  });
  check('the fixture starts like a pre-regional offline install',
    removed.archive && removed.marker, JSON.stringify(removed));

  const requestStart = site.requests.length;
  site.publish('/sw.js', workerSource.replace(/const VERSION = 'v\d+'/, "const VERSION = 'v999'"));
  const installedState = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const found = new Promise((resolve) => registration.addEventListener(
      'updatefound', () => resolve(registration.installing), { once: true }));
    await registration.update();
    const worker = registration.installing || registration.waiting || await found;
    if (!worker) return 'missing';
    if (worker.state === 'installing') {
      await new Promise((resolve) => worker.addEventListener('statechange', () => {
        if (worker.state !== 'installing') resolve();
      }));
    }
    return worker.state;
  });
  check('the replacement worker completes installation',
    ['installed', 'activated'].includes(installedState), installedState);

  const beforeActivation = await page.evaluate(async () => {
    const cache = await caches.open('data-offline-map-v9');
    const archive = await cache.match('maps/washington/regional.pmtiles');
    const marker = await cache.match('maps/washington/.stamp/regional.pmtiles');
    const registration = await navigator.serviceWorker.getRegistration();
    return {
      archive: archive ? await archive.text() : null,
      marker: marker ? await marker.text() : null,
      cacheNames: await caches.keys(),
      regionalKeys: (await cache.keys()).map((request) => new URL(request.url).pathname)
        .filter((path) => path.includes('regional.pmtiles')),
      workers: {
        active: registration?.active && { state: registration.active.state,
          url: registration.active.scriptURL },
        waiting: registration?.waiting && { state: registration.waiting.state,
          url: registration.waiting.scriptURL },
        installing: registration?.installing && { state: registration.installing.state,
          url: registration.installing.scriptURL },
      },
    };
  });
  check('the updating worker caches and stamps the missing archive before waiting',
    beforeActivation.archive === syntheticData.get('regional.pmtiles')
      && beforeActivation.marker === regionalVersion,
    JSON.stringify(beforeActivation));

  const stateDataRequests = site.requests.slice(requestStart)
    .map((request) => request.url.split('?')[0])
    .filter((path) => path.startsWith('/maps/washington/'));
  check('the update downloads only the missing state-data entry',
    stateDataRequests.length === 1
      && stateDataRequests[0] === '/maps/washington/regional.pmtiles',
    JSON.stringify(stateDataRequests));

  site.goOffline();
  const activated = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration.waiting) {
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      await new Promise((resolve) => navigator.serviceWorker
        .addEventListener('controllerchange', resolve, { once: true }));
    }
    if (registration.installing) return false;
    return true;
  });
  const offline = await page.evaluate(async () => {
    const response = await fetch('maps/washington/regional.pmtiles');
    return { ok: response.ok, status: response.status, body: await response.text() };
  }).catch((error) => ({ error: error.message }));
  check('the activated update serves the new archive with the network offline',
    activated && offline.ok && offline.status === 200
      && offline.body === syntheticData.get('regional.pmtiles'), JSON.stringify(offline));
  await context.close();
} finally {
  await browser.close();
  await site.close();
}

done();
