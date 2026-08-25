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
  // The release-data refresh runs BESIDE activation, not inside it, so the
  // page is claimed while those five fetches are still in flight. Let the
  // boot pass finish (places.json is fetched last, sequentially) before any
  // request accounting or cache surgery below.
  const bootDeadline = Date.now() + 30000;
  while (!site.requests.some((r) => r.url.includes('/maps/washington/places.json'))
      && Date.now() < bootDeadline) {
    await new Promise((r) => setTimeout(r, 200));
  }

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
  // A FLAKY connection is not a dropped one: offline fails fetches fast, a
  // bad cell link leaves them hanging. Activation must never gate on the
  // release-data refresh, because the browser queues every page fetch until
  // activation's waitUntil settles — with the refresh inside it, the first
  // launch after an update on a flaky link showed a blank app with all data
  // installed (field, 2026-08-25). Publish another release, hang the
  // refresh endpoints forever, take the update: pages must still be served
  // from cache promptly.
  site.goOnline();
  for (const file of ['ferries.geojson.gz', 'bikeroutes.geojson.gz',
    'bike_restrictions.geojson.gz', 'route_closures.geojson.gz', 'places.json']) {
    site.publish(`/maps/washington/${file}`, () => { /* never responds */ });
  }
  site.publish('/sw.js', workerSource.replace(/const VERSION = 'v\d+'/, "const VERSION = 'v1000'"));
  const flakyOutcome = await page.evaluate(async () => {
    const withTimeout = (promise, ms, label) => Promise.race([promise,
      new Promise((resolve) => setTimeout(() => resolve(`timeout:${label}`), ms))]);
    const registration = await navigator.serviceWorker.getRegistration();
    const found = new Promise((resolve) => registration.addEventListener(
      'updatefound', () => resolve(registration.installing), { once: true }));
    await registration.update();
    const worker = registration.installing || registration.waiting || await withTimeout(found, 60000, 'updatefound');
    if (!worker || typeof worker === 'string') return { failed: worker || 'missing' };
    if (worker.state === 'installing') {
      const installed = await withTimeout(new Promise((resolve) =>
        worker.addEventListener('statechange', () => {
          if (worker.state !== 'installing') resolve(worker.state);
        })), 90000, 'install');
      if (typeof installed === 'string' && installed.startsWith('timeout')) return { failed: installed };
    }
    const takeover = new Promise((resolve) => navigator.serviceWorker
      .addEventListener('controllerchange', resolve, { once: true }));
    worker.postMessage({ type: 'SKIP_WAITING' });
    const claimed = await withTimeout(takeover, 20000, 'claim');
    const started = performance.now();
    const served = await withTimeout(
      fetch('maps/washington/regional.pmtiles').then(async (response) => ({
        ok: response.ok, body: await response.text() })),
      15000, 'fetch');
    // The local-only waitUntil settles within moments of the claim; give the
    // state flag a beat to propagate rather than reading it mid-transition.
    const stateDeadline = Date.now() + 5000;
    while (registration.active?.state !== 'activated' && Date.now() < stateDeadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return {
      claimed: typeof claimed !== 'string',
      workerState: registration.active?.state,
      served, ms: Math.round(performance.now() - started),
    };
  });
  check('an update taken on a hanging connection still takes control',
    flakyOutcome.claimed === true && flakyOutcome.workerState === 'activated',
    JSON.stringify(flakyOutcome));
  check('and cached data answers promptly while the refresh fetches hang',
    flakyOutcome.served?.ok === true
      && flakyOutcome.served.body === syntheticData.get('regional.pmtiles')
      && flakyOutcome.ms < 15000,
    JSON.stringify(flakyOutcome));

  await context.close();
} finally {
  await browser.close();
  await site.close();
}

done();
