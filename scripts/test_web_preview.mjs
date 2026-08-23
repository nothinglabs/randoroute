#!/usr/bin/env node
// Build the exact static preview shape, verify its complete store, then let a
// real service worker install and prove a clean slim launch does not silently
// fetch a fallback state's data before confirmation.
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { check, done, launchBrowser, ROOT, serveRepo } from './testlib/harness.mjs';

const output = await mkdtemp(join(tmpdir(), 'randoroute-web-preview-'));
const expectedBase = 'https://preview.example.test/randoroute/';
try {
  execFileSync(process.execPath, [join(ROOT, 'scripts/build_web_preview.mjs')], {
    cwd: ROOT,
    stdio: 'pipe',
    env: { ...process.env,
      JRA_PREVIEW_OUTPUT: output,
      JRA_PREVIEW_BASE_URL: expectedBase,
    },
  });

  const html = await readFile(join(output, 'index.html'), 'utf8');
  const registry = await readFile(join(output, 'maps/states.js'), 'utf8');
  check('the review bundle stays a web PWA while declaring state data unbundled',
    /data-app-runtime="web"/.test(html)
      && /MAP_STATES_BUNDLED = false/.test(registry)
      && /MAP_STATES_BUNDLED_IDS = \[\]/.test(registry)
      && registry.includes(`${expectedBase}maps/`));

  const store = JSON.parse(await readFile(join(output, 'maps/index.json'), 'utf8'));
  let assets = 0;
  for (const state of store.states) {
    for (const file of state.files) {
      await access(join(output, 'maps', state.id, file.path));
      assets++;
    }
    for (const unit of state.acquisitions || []) {
      if (unit.catalogue) await access(join(output, 'maps', unit.catalogue.path));
      if (unit.kind === 'routing-partitions') {
        for (const file of unit.files || []) {
          await access(join(output, 'maps', file.path));
          assets++;
        }
      }
    }
  }
  check('the preview origin contains every exact state and routing-store artifact', assets > 80,
    `${assets} assets`);

  const record = JSON.parse(await readFile(join(output, 'preview.json'), 'utf8'));
  check('the preview record identifies source, app, catalogue, datasets and retention',
    record.sourceBranch === 'codex/multistate-routing'
      && /^[a-f0-9]{40}$/.test(record.sourceCommit)
      && record.appVersion === '2026-08-22.795'
      && /^[a-f0-9]{64}$/.test(record.partitionCatalogue.sha256)
      && record.states.length === 2 && /PR #3/.test(record.retention),
    JSON.stringify(record));

  const site = await serveRepo({ root: output });
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(site.url, { waitUntil: 'load' });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => navigator.serviceWorker.controller, { timeout: 10000 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const stateDataRequests = site.requests.filter((request) =>
      /^\/maps\/[^/]+\/(?!states\.js|index\.json|national-states\.geojson)/.test(request.url));
    check('a clean slim preview waits for confirmation before fetching state data',
      stateDataRequests.length === 0, JSON.stringify(stateDataRequests.slice(0, 5)));

    const installBody = Buffer.from('complete-same-origin-preview-archive');
    const installRequests = [];
    site.publish('/maps/preview-fixture/roads.pmtiles', (req, res) => {
      installRequests.push(req.url);
      const body = installRequests.length === 1
        ? installBody.subarray(0, installBody.length - 4) : installBody;
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': body.length,
      });
      res.end(body);
    });
    const sameOriginInstall = await page.evaluate(async (bytes) => {
      const state = {
        id: 'preview-fixture', name: 'Preview Fixture', status: 'preview',
        bounds: { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 },
        defaultCenter: [0.5, 0.5], defaultZoom: 8,
        datasets: { roads: true }, versions: { roads: 'fixture-roads-v1' },
        files: [{ dataset: 'roads', path: 'roads.pmtiles', bytes }],
      };
      const progress = [];
      await MapStore.installState('maps/', state, (event) => progress.push(event));
      const cache = await caches.open(DATA_CACHE_NAME);
      const stored = await cache.match('maps/preview-fixture/roads.pmtiles');
      const storedBytes = stored ? (await stored.blob()).size : -1;
      const installed = MapStore.availability(state.id);
      await MapStore.removeState(state.id);
      return { storedBytes, installed,
        retried: progress.some((event) => event.retrying) };
    }, installBody.length);
    check('a truncated same-origin store response bypasses the live cache and retries once',
      installRequests.length === 2
        && installRequests.every((url) => /jra-store-install=/.test(url))
        && sameOriginInstall.retried
        && sameOriginInstall.storedBytes === installBody.length
        && sameOriginInstall.installed === 'installed',
      JSON.stringify({ installRequests, sameOriginInstall }));
    await context.close();
  } finally {
    await browser.close();
    await site.close();
  }
} finally {
  await rm(output, { recursive: true, force: true });
}

done();
