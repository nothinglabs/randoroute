#!/usr/bin/env node
// A map update a rider installs must change what the renderer draws. Field
// (.810): the store update stored the corrected regional archive -- validated,
// byte-perfect -- and the map kept rendering the old one. The service worker
// answers PMTiles ranges from per-archive chunk entries built once per copy;
// nothing invalidated them on a store update, so every render after the
// update kept reading the replaced archive out of the chunk cache. The gzip
// download fix had also removed the stored Content-Length that the chunk
// validator used as its only replacement tripwire.
//
// This test walks the rider's actual lifecycle with the REAL service worker:
// install the .807-era archive from a store, render (chunks build), update to
// the current archive, reload, and assert in PIXELS that the wedge of
// southern Washington the field photographed is land. No fresh-profile
// shortcuts: the point is the persistence the fresh worlds never had.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { check, done, launchBrowser, ROOT, serveRepo } from './testlib/harness.mjs';

const require = createRequire(import.meta.url);
const registry = require('../maps/states.js');

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)'
  + ' AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

// The archive that shipped in .807/.809 (no generalized land layer) and the
// current one. Both real, from history and the tree.
const OLD_COMMIT = 'e92a698';
const oldBytes = execFileSync('git', ['show', `${OLD_COMMIT}:maps/washington/regional.pmtiles`],
  { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
const newBytes = readFileSync(join(ROOT, 'maps/washington/regional.pmtiles'));

const realIndex = JSON.parse(readFileSync(join(ROOT, 'maps/index.json'), 'utf8'));
const realWashington = realIndex.states.find((state) => state.id === 'washington');
const mapUnit = realWashington.acquisitions.find((unit) => unit.kind === 'state-map');
const regionalFile = mapUnit.files.find((file) => file.path === 'regional.pmtiles');

// The map acquisition reduced to its regional archive: the wedge renders from
// that single file, and a one-file unit keeps both installs fast while going
// through the exact same descriptor, staging, validation and commit path.
const makeState = (label, bytes) => {
  const files = [{ ...regionalFile, bytes: bytes.length }];
  return {
    ...realWashington,
    versions: { ...realWashington.versions, regional: `sha-lifecycle-${label}` },
    files,
    acquisitions: [{
      ...mapUnit,
      id: `map-washington-lifecycle-${label}`,
      files,
      totalBytes: bytes.length,
    }],
  };
};
const oldState = makeState('old', oldBytes);
const newState = makeState('new', newBytes);

const site = await serveRepo();
site.publish('/maps/states.js', `(function (root) {
  root.MAP_STATES_BUNDLED = false;
  root.MAP_STATES = ${JSON.stringify(registry.MAP_STATES)};
  root.MAP_STATE_ACQUISITIONS = ${JSON.stringify(registry.MAP_STATE_ACQUISITIONS)};
}(typeof self !== 'undefined' ? self : this));`);
const serveStore = (state, bytes) => {
  site.publish('/store/index.json', (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ storeFormat: 2, states: [state] }));
  });
  site.publish('/store/washington/regional.pmtiles', (req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream',
      'content-length': bytes.length });
    res.end(bytes);
  });
};

const PROBES = [
  ['wedge-amboy', -122.25, 45.95],
  ['wedge-woodland', -122.40, 45.95],
  ['sea-saratoga', -122.48, 48.10],
];
const isWaterColor = ([r, g, b]) => (b - r) > 8;

const browser = await launchBrowser();

async function bootControlledPage(context) {
  const page = await context.newPage();
  await page.goto(`http://localhost:${site.port}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.MapStore
    && !!navigator.serviceWorker?.controller, null, { timeout: 90000 });
  return page;
}

async function samplePixel(page, lng, lat, zoom) {
  await page.evaluate(({ lng, lat, zoom }) =>
    map.jumpTo({ center: [lng, lat], zoom }), { lng, lat, zoom });
  await page.evaluate(() => new Promise((resolve) => {
    if (map.loaded()) return resolve();
    map.once('idle', resolve);
    setTimeout(resolve, 12000);
  }));
  await page.waitForTimeout(300);
  return page.evaluate(() => new Promise((resolve) => {
    map.once('render', () => {
      const gl = map.getCanvas();
      const out = document.createElement('canvas');
      out.width = 4; out.height = 4;
      const ctx = out.getContext('2d');
      ctx.drawImage(gl, gl.width / 2 - 2, gl.height / 2 - 2, 4, 4, 0, 0, 4, 4);
      const d = ctx.getImageData(2, 2, 1, 1).data;
      resolve([d[0], d[1], d[2]]);
    });
    map.triggerRepaint();
  }));
}

try {
  const context = await browser.newContext({ userAgent: IPHONE_UA,
    viewport: { width: 430, height: 900 }, hasTouch: true, isMobile: true });

  // Install the old archive through the real store path, on a page the real
  // service worker controls.
  serveStore(oldState, oldBytes);
  let page = await bootControlledPage(context);
  await page.evaluate(async (state) => {
    await MapStore.installState('/store/', state);
  }, oldState);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.map && window.Region
    && Region.localDataAvailable === true, null, { timeout: 90000 });

  // Render the wedge: with the .807-era archive this is sea (the bug the
  // field reported), and the render forces the worker to build its chunk
  // entries for that archive copy.
  const before = await samplePixel(page, -122.25, 45.95, 7.3);
  check('the .807-era archive reproduces the field wedge (sea over inland ground)',
    isWaterColor(before), `rgb=(${before})`);
  const chunked = await page.evaluate(async () => {
    const cache = await caches.open(DATA_CACHE_NAME);
    return !!(await cache.match('/maps/washington/regional.pmtiles__chunkindex'));
  });
  check('the worker serves that archive from chunk entries (the persistence under test)',
    chunked === true, String(chunked));

  // The field device's exact state: the update ran under code that did not
  // purge chunks, leaving the corrected archive and registry in place with
  // the previous copy's chunks untouched. No further install happens -- the
  // next session's renders must notice the archive version on the range
  // requests and rebuild from the already-cached archive.
  serveStore(newState, newBytes);
  await page.evaluate(async () => {
    const fresh = await fetch('/store/washington/regional.pmtiles?jra-store-install=lifecycle-sim',
      { cache: 'no-store' });
    const cache = await caches.open(DATA_CACHE_NAME);
    await cache.put('maps/washington/regional.pmtiles',
      new Response(await fresh.blob(), { status: 200 }));
    const installed = JSON.parse(localStorage.getItem('jra-installed-states-1'));
    installed[0].state.versions.regional = 'sha-lifecycle-new';
    localStorage.setItem('jra-installed-states-1', JSON.stringify(installed));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.map && window.Region
    && Region.localDataAvailable === true, null, { timeout: 90000 });
  const healed = await samplePixel(page, -122.25, 45.95, 7.3);
  check('a device already updated under the previous code heals on its next render',
    !isWaterColor(healed), `rgb=(${healed})`);

  // A proper store install must carry the renderer with it in BOTH
  // directions: back to the old archive (wedge sea again -- the chunks
  // followed the install), then forward to the corrected one.
  serveStore(oldState, oldBytes);
  await page.evaluate(async (state) => {
    await MapStore.installState('/store/', state);
  }, oldState);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.map && window.Region
    && Region.localDataAvailable === true, null, { timeout: 90000 });
  const rolledBack = await samplePixel(page, -122.25, 45.95, 7.3);
  check('a store install replaces what the renderer draws (rollback renders the old archive)',
    isWaterColor(rolledBack), `rgb=(${rolledBack})`);

  serveStore(newState, newBytes);
  await page.evaluate(async (state) => {
    await MapStore.installState('/store/', state);
  }, newState);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.map && window.Region
    && Region.localDataAvailable === true, null, { timeout: 90000 });

  const wrong = [];
  for (const [name, lng, lat] of PROBES) {
    for (const zoom of [7.3, 8.3]) {
      const rgb = await samplePixel(page, lng, lat, zoom);
      const water = isWaterColor(rgb);
      const expectWater = name.startsWith('sea');
      if (water !== expectWater) wrong.push(`${name}@z${zoom}=(${rgb})`);
    }
  }
  check('after the update, the renderer draws the NEW archive: wedge land, channels water',
    wrong.length === 0, wrong.join(' | '));
  await context.close();
} finally {
  await browser.close();
  site.close();
}

done();
