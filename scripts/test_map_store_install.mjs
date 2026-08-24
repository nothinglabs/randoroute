#!/usr/bin/env node
// Installing a map pack from a THIRD-PARTY store, end to end through the UI:
// add the store on the Maps screen, download a state, and end with that state
// switchable, sized, removable -- and its files in the offline data cache
// under the exact logical keys the service worker serves (the graph keyed
// with its query string, the archives with their stamp markers). A store that
// breaks mid-download must leave nothing behind: a state is fully installed
// or absent, never half.
//
// The store is a second local server on its own port -- a genuinely different
// origin, with CORS headers, serving a tiny synthetic state.
import { createServer } from 'node:http';
import { appPage, launchBrowser, serveRepo, check, done } from './testlib/harness.mjs';

/* ----------------------------------------------------- a tiny map store */
const FILES = {
  'graph2.bin.gz': Buffer.from('fake-graph-bytes-for-install-test'),
  'places.json': Buffer.from(JSON.stringify({ places: [] })),
  'roads.pmtiles': Buffer.from('fake-roads-archive-bytes'),
};
const STORE_STATE = {
  id: 'teststate', name: 'Test State', status: 'preview',
  summary: 'A synthetic state for the install test.',
  bounds: { minLon: -1, minLat: -1, maxLon: 1, maxLat: 1 },
  defaultCenter: [0, 0], defaultZoom: 8,
  datasets: { graph: true, places: true, roads: true },
  versions: { graph: 'sha-test-graph', roads: 'sha-test-roads' },
  // Real region.json entries carry this (the oversized-home routing fact);
  // .805 shipped a validator that rejected every state naming it, which made
  // the deployed store uninstallable. Keep one here so the allowlist and the
  // registry can never drift apart silently again.
  graphRawBytes: 123456789,
  files: [
    { dataset: 'graph', path: 'graph2.bin.gz', bytes: FILES['graph2.bin.gz'].length },
    { dataset: 'places', path: 'places.json', bytes: FILES['places.json'].length },
    { dataset: 'roads', path: 'roads.pmtiles', bytes: FILES['roads.pmtiles'].length },
  ],
};
// Identical shape, but its archive 404s: the download must fail CLEANLY.
const BROKEN_STATE = {
  ...STORE_STATE,
  id: 'brokenstate',
  name: 'Broken State',
  versions: { graph: 'sha-broken-graph', roads: 'sha-broken-roads' },
};
const store = createServer((req, res) => {
  const path = req.url.split('?')[0];
  const cors = { 'access-control-allow-origin': '*' };
  if (path === '/index.json') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    return res.end(JSON.stringify({ storeFormat: 1, states: [STORE_STATE, BROKEN_STATE] }));
  }
  const file = /^\/(teststate|brokenstate)\/(.+)$/.exec(path);
  const body = file && FILES[file[2]];
  if (!body || (file[1] === 'brokenstate' && file[2] === 'roads.pmtiles')) {
    res.writeHead(404, cors);
    return res.end('not found');
  }
  res.writeHead(200, { ...cors, 'content-type': 'application/octet-stream', 'content-length': body.length });
  return res.end(body);
});
await new Promise((r) => store.listen(0, r));
const storeUrl = `http://localhost:${store.address().port}/`;

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);
await page.waitForFunction(() => typeof openMapsDialog === 'function' && window.MapStore,
  null, { timeout: 120000 });

/* ------------------------------------ add the store through the Maps UI */
const added = await page.evaluate(async (url) => {
  openMapsDialog();
  document.getElementById('mapsStoreUrl').value = url;
  document.getElementById('mapsStoreAdd').click();
  // The offers render after an async index fetch; under full-suite load a
  // fixed wait loses the race, so poll for them.
  for (let i = 0; i < 100 && !document.querySelector('.maps-store-offer'); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    stores: MapStore.customStores().map((entry) => entry.url),
    rows: document.querySelectorAll('#mapsStoreList .maps-store').length,
    offers: [...document.querySelectorAll('.maps-store-offer')].map((row) => row.textContent),
  };
}, storeUrl);
check('the store is remembered and its offers render',
  added.stores.includes(storeUrl) && added.rows === 1 && added.offers.length === 2
    && added.offers[0].includes('Test State') && added.offers[0].includes('Download'),
  JSON.stringify(added));

/* --------------------------------------------- download through the UI */
const installed = await page.evaluate(async () => {
  const offer = [...document.querySelectorAll('.maps-store-offer')]
    .find((row) => row.textContent.includes('Test State'));
  offer.querySelector('.maps-state-download').click();
  const status = document.getElementById('mapsStatus');
  for (let i = 0; i < 100 && !status.textContent.includes('ready to use'); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const cache = await caches.open(DATA_CACHE_NAME);
  const keys = (await cache.keys()).map((request) => {
    const url = new URL(request.url);
    return url.pathname + url.search;
  }).filter((path) => path.includes('teststate'));
  const row = [...document.querySelectorAll('#mapsStateList .maps-state')]
    .find((candidate) => candidate.textContent.includes('Test State'));
  return {
    status: status.textContent,
    keys: keys.sort(),
    entry: !!MapStore.installedEntry('teststate'),
    availability: MapStore.availability('teststate'),
    rowText: row?.textContent, hasRadio: !!row?.querySelector('input[type=radio]'),
    hasRemove: !!row?.querySelector('.maps-state-remove'),
  };
});
check('the download completes and reports ready', installed.status.includes('ready to use'),
  installed.status);
check('every file lands under its logical serving key, the graph query included',
  installed.keys.includes('/maps/teststate/places.json')
    && installed.keys.includes('/maps/teststate/roads.pmtiles')
    && installed.keys.includes('/maps/teststate/graph2.bin.gz?format=bgr10-1&gv=sha-test-graph')
    && installed.keys.includes('/maps/teststate/.stamp/roads.pmtiles'),
  JSON.stringify(installed.keys));
check('the state is recorded and listed as switchable with size and Remove',
  installed.entry && installed.availability === 'installed' && installed.hasRadio
    && installed.hasRemove && /MB|KB|\d/.test(installed.rowText || ''),
  JSON.stringify(installed));

/* ------------------------------------- a reload knows the state by merge */
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => typeof openMapsDialog === 'function', null, { timeout: 60000 });
const merged = await page.evaluate(() => ({
  known: Region.states.some((state) => state.id === 'teststate'),
  active: Region.id,
}));
check('after a reload, region.js has merged the installed state into the index',
  merged.known && merged.active !== 'teststate', JSON.stringify(merged));

/* --------------------------- a broken pack fails clean, installs nothing */
const broken = await page.evaluate(async (url) => {
  const index = await MapStore.fetchIndex(url);
  const state = index.states.find((candidate) => candidate.id === 'brokenstate');
  let message = null;
  try { await MapStore.installState(url, state, () => {}); } catch (error) { message = error.message; }
  const cache = await caches.open(DATA_CACHE_NAME);
  const leftovers = (await cache.keys())
    .filter((request) => new URL(request.url).pathname.includes('brokenstate')).length;
  return { message, leftovers, entry: !!MapStore.installedEntry('brokenstate') };
}, storeUrl);
check('a pack whose file 404s fails with a clear error and leaves nothing behind',
  !!broken.message && broken.leftovers === 0 && !broken.entry, JSON.stringify(broken));

/* ------------------------------------------------------------- removal */
const removed = await page.evaluate(async () => {
  openMapsDialog();
  await new Promise((r) => setTimeout(r, 300));
  const row = [...document.querySelectorAll('#mapsStateList .maps-state')]
    .find((candidate) => candidate.textContent.includes('Test State'));
  row.querySelector('.maps-state-remove').click();
  const status = document.getElementById('mapsStatus');
  for (let i = 0; i < 50 && !status.textContent.includes('removed'); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const cache = await caches.open(DATA_CACHE_NAME);
  const leftovers = (await cache.keys())
    .filter((request) => new URL(request.url).pathname.includes('teststate')).length;
  return {
    leftovers,
    entry: !!MapStore.installedEntry('teststate'),
    listed: [...document.querySelectorAll('#mapsStateList .maps-state')]
      .some((candidate) => candidate.textContent.includes('Test State')),
  };
});
check('Remove empties the cache, the record, and the list',
  removed.leftovers === 0 && !removed.entry && !removed.listed, JSON.stringify(removed));

check('no page errors', page.pageErrors.length === 0, page.pageErrors.join(' | '));

await browser.close();
await site.close();
store.close();
done();
