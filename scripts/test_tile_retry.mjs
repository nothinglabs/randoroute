#!/usr/bin/env node
// A PMTiles tile is a byte-range read, and on a phone one of those fails now
// and then. Two things used to turn that blip into a permanent defect:
//
//   1. MapLibre never retries a tile it was handed an error for.
//   2. PMTiles memoizes the archive header and every directory read as a
//      PROMISE, stored before it settles -- so a rejected read is remembered as
//      the answer for the rest of the session, and every tile beneath that
//      directory then fails instantly without touching the network.
//
// Together they leave rectangular holes in the map: land polygons missing, the
// bare ocean background showing through, until the rider pans that area away
// and back. This test serves the real archives twice -- once cleanly, once
// through a server that refuses the FIRST read of every distinct byte range --
// and requires the flaky run to render the same map as the clean one.
// Playwright is installed globally in this container, not under the project, so
// resolving it is the harness's job rather than each test file's.
import { playwright, chromiumPath } from './testlib/harness.mjs';
const { chromium } = await playwright();
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.gz': 'application/gzip', '.png': 'image/png',
  '.pmtiles': 'application/octet-stream', '.bin': 'application/octet-stream',
  '.pbf': 'application/octet-stream',
};
// The layers that vanished in the reported screenshot, plus the streets.
const PROBE_LAYERS = ['basemap-land-detail', 'basemap-water', 'basemap-local'];

let flaky = false;
const burned = new Set();
let refused = 0;

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(req.url.split('?')[0]);
    if (path === '/') path = '/index.html';
    const full = join(ROOT, path);
    const info = await stat(full);
    const type = TYPES[extname(path)] || 'application/octet-stream';
    const range = req.headers.range;
    if (flaky && path.endsWith('.pmtiles')) {
      // Every distinct (archive, range) pair is refused exactly once. A second
      // refusal would be a real outage, not a blip, and is not this test's job.
      const key = `${path}|${range || 'full'}`;
      if (!burned.has(key)) {
        burned.add(key);
        refused++;
        res.writeHead(503);
        return res.end('flaky');
      }
    }
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (m) {
        const start = +m[1];
        const end = m[2] ? +m[2] : info.size - 1;
        const body = (await readFile(full)).subarray(start, end + 1);
        res.writeHead(206, {
          'content-type': type, 'accept-ranges': 'bytes',
          'content-range': `bytes ${start}-${end}/${info.size}`,
          'content-length': body.length,
        });
        return res.end(body);
      }
    }
    const body = await readFile(full);
    res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('x');
  }
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch({
  executablePath: chromiumPath(),
  args: ['--use-gl=swiftshader'],
});

async function render(label) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  await page.exposeFunction('__tileError', (m) => errors.push(m));
  await page.goto(`http://localhost:${port}/index.html`, { waitUntil: 'load' });
  await page.evaluate(() => {
    map.on('error', (e) => {
      const source = e && e.sourceId ? e.sourceId : '';
      if (source.startsWith('basemap-')) window.__tileError(`${source}: ${e?.error?.message}`);
    });
  });
  // Puget Sound at the Tacoma tideflats: land, water and a dense street grid,
  // which is where the holes were reported.
  await page.evaluate(() => map.jumpTo({ center: [-122.39, 47.26], zoom: 13 }));
  await page.waitForFunction(() => map.loaded && map.loaded(), { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(7000);
  const counts = await page.evaluate((layers) => {
    const out = {};
    for (const id of layers) {
      out[id] = map.getLayer(id) ? map.queryRenderedFeatures({ layers: [id] }).length : -1;
    }
    return out;
  }, PROBE_LAYERS);
  await context.close();
  console.log(`${label}: ${JSON.stringify(counts)}  errors=${errors.length}`);
  return { counts, errors };
}

const clean = await render('clean connection ');
flaky = true;
const blippy = await render('flaky connection ');

console.log(`range reads refused once and retried: ${refused}`);
await browser.close();
server.close();

for (const id of PROBE_LAYERS) {
  assert.ok(clean.counts[id] > 0, `${id} should render on a clean connection`);
}
assert.ok(refused > 10, `the flaky server should have refused many reads, got ${refused}`);
assert.equal(blippy.errors.length, 0,
  `a transient range failure must be absorbed below MapLibre: ${blippy.errors.slice(0, 3)}`);
for (const id of PROBE_LAYERS) {
  // Tile scheduling is not deterministic, so require most of the map rather
  // than an exact match; a poisoned directory wipes out whole tiles at once.
  assert.ok(blippy.counts[id] >= clean.counts[id] * 0.9,
    `${id} lost geometry to a dropped range read: ${blippy.counts[id]} vs ${clean.counts[id]}`);
}

console.log('PMTiles transient-failure recovery tests passed.');
