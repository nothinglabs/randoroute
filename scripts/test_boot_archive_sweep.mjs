#!/usr/bin/env node
// Dynamic archive re-download is a worst-case fallback, not a feature: every
// archive an installed state ships must be present in the offline cache at
// boot, restored by the boot sweep rather than by the renderer tripping over
// the hole mid-session (field, 2026-08-27: routes computed and drawn before
// the map appeared).
//
// The specimen is regional.pmtiles on a desktop renderer: the desktop style
// never adds the basemap-regional source, so nothing but the sweep can bring
// an evicted copy back. The test evicts it from the real service worker's
// cache twice — once restored by calling the sweep directly, once by a plain
// reload — and requires the complete archive back both times.
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ROOT, playwright, chromiumPath, serveRepo,
} from './testlib/harness.mjs';

const { chromium } = await playwright();
const site = await serveRepo();
const browser = await chromium.launch({
  executablePath: chromiumPath(), args: ['--use-gl=swiftshader'],
});
const context = await browser.newContext({ viewport: { width: 700, height: 700 } });
const page = await context.newPage();
page.setDefaultTimeout(300000);

const archivePath = '/maps/washington/regional.pmtiles';
const expectedBytes = (await stat(join(ROOT, archivePath))).size;
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

const cachedArchiveBytes = (path) => page.evaluate(async (p) => {
  const cache = await caches.open('data-offline-map-v9');
  const response = await cache.match(p, { ignoreSearch: true });
  return response ? (await response.blob()).size : 0;
}, path);

const evictArchive = (path) => page.evaluate(async (p) => {
  const cache = await caches.open('data-offline-map-v9');
  await cache.delete(p, { ignoreVary: true, ignoreSearch: true });
  for (const request of await cache.keys()) {
    if (new URL(request.url).pathname.startsWith(`${p}__chunk`)) {
      await cache.delete(request);
    }
  }
  return Boolean(await cache.match(p, { ignoreSearch: true }));
}, path);

try {
  await page.goto(site.url, { waitUntil: 'load' });
  await page.waitForFunction(() => navigator.serviceWorker.controller != null);
  await page.waitForFunction(async (path) => {
    const cache = await caches.open('data-offline-map-v9');
    return Boolean(await cache.match(path, { ignoreSearch: true }));
  }, archivePath);

  // The URL authority the sweep walks: every dataset the state ships, under
  // the renderer's own spelling of each archive, with the regional ?v= bound
  // to the region.json content stamp rather than a code constant.
  const urls = await page.evaluate(() => BikeBasemap.stateArchiveUrls(Region));
  assert.deepEqual(Object.keys(urls).sort(), ['context', 'overlays', 'regional', 'roads']);
  assert.match(urls.regional, /^pmtiles:\/\/maps\/washington\/regional\.pmtiles\?v=./);
  const regionalStamp = await page.evaluate(() => String(Region.versions.regional));
  assert.ok(urls.regional.endsWith(`?v=${encodeURIComponent(regionalStamp)}`),
    `regional ?v= must be the content stamp: ${urls.regional}`);

  // Desktop style must not carry the regional source — that is what makes
  // this archive a pure test of the sweep, not of the renderer's own restore.
  const regionalSourceAttached = await page.evaluate(() =>
    Boolean(map.getSource?.('basemap-regional')));
  assert.equal(regionalSourceAttached, false,
    'the desktop style attached basemap-regional; pick another specimen archive');

  assert.equal(await evictArchive(archivePath), false, 'eviction must remove the entry');
  await page.evaluate(() => restoreMissingMapArchives());
  assert.equal(await cachedArchiveBytes(archivePath), expectedBytes,
    'the sweep must restore an evicted archive to its full size');

  assert.equal(await evictArchive(archivePath), false, 'second eviction must remove the entry');
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => navigator.serviceWorker.controller != null);
  await page.waitForFunction(async ({ path, bytes }) => {
    const cache = await caches.open('data-offline-map-v9');
    const response = await cache.match(path, { ignoreSearch: true });
    return Boolean(response) && (await response.blob()).size === bytes;
  }, { path: archivePath, bytes: expectedBytes }, { timeout: 120000 });

  assert.deepEqual(pageErrors, []);
  console.log(`Boot archive sweep passed (${expectedBytes} bytes restored twice).`);
} finally {
  await browser.close();
  site.close();
}
