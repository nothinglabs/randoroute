#!/usr/bin/env node
// A cached PMTiles response can look like a complete HTTP 200 while containing
// only the first byte range. That failure shape explains one PMTiles source
// disappearing while the state's other sources continue to draw. The first
// 16 KiB still contains a valid PMTiles header and root directory, so the
// archive appears healthy until MapLibre asks for actual tile bytes. The old
// worker then answered every later range with 416 and left that source blank.
//
// Reproduce the device state, reload through the real service worker, and
// require both a rendered land layer and a repaired full archive in Cache API.
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

const archivePath = '/maps/washington/basemap.pmtiles';
const expectedBytes = (await stat(join(ROOT, archivePath))).size;
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

try {
  await page.goto(site.url, { waitUntil: 'load' });
  await page.waitForFunction(() => navigator.serviceWorker.controller != null);
  await page.waitForFunction(async (path) => {
    const cache = await caches.open('data-offline-map-v9');
    return Boolean(await cache.match(path));
  }, archivePath);

  // Replace only the context archive with the kind of plausible-looking,
  // truncated HTTP 200 seen on the affected device. Leave roads and overlays
  // intact: the visual symptom is safety lines floating over missing ground.
  const poisoned = await page.evaluate(async ({ path }) => {
    const cache = await caches.open('data-offline-map-v9');
    const full = await cache.match(path);
    const prefix = (await full.arrayBuffer()).slice(0, 16 * 1024);
    await cache.put(path, new Response(prefix, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(prefix.byteLength),
      },
    }));
    for (const request of await cache.keys()) {
      if (new URL(request.url).pathname.startsWith(`${path}__chunk`)) {
        await cache.delete(request);
      }
    }
    await cache.put(`${path}__chunk-0`, new Response(prefix));
    await cache.put(`${path}__chunkindex`, new Response(JSON.stringify({
      size: prefix.byteLength,
      chunkBytes: 8 * 1024 * 1024,
      chunks: 1,
    })));
    return prefix.byteLength;
  }, { path: archivePath });
  assert.equal(poisoned, 16 * 1024);

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.map && map.loaded && map.loaded())
    .catch(() => {});
  await page.evaluate(() => map.jumpTo({ center: [-122.3130, 47.5150], zoom: 13 }));
  await page.evaluate(() => Promise.race([
    new Promise((resolve) => map.once('idle', resolve)),
    new Promise((resolve) => setTimeout(resolve, 45000)),
  ]));
  await page.waitForTimeout(1500);

  const land = await page.evaluate(() =>
    map.queryRenderedFeatures({ layers: ['basemap-land', 'basemap-land-detail'] }).length);
  assert.ok(land > 0, `land must recover from a truncated cached archive; rendered ${land}`);

  const repairedBytes = await page.evaluate(async (path) => {
    const cache = await caches.open('data-offline-map-v9');
    const response = await cache.match(path, { ignoreSearch: true });
    return response ? (await response.blob()).size : 0;
  }, archivePath);
  assert.equal(repairedBytes, expectedBytes,
    'the worker must replace the truncated archive, not only bypass it for one tile');
  assert.deepEqual(pageErrors, []);

  console.log(`PMTiles truncated-cache recovery passed (${repairedBytes} bytes, ${land} land features).`);
} finally {
  await browser.close();
  site.close();
}
