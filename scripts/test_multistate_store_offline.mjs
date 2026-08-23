#!/usr/bin/env node
// Versioned routing acquisitions are atomic, compatible across three states,
// restorable offline, and removable without erasing saved route intent.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appPage, check, done, launchBrowser, ROOT, serveRepo } from './testlib/harness.mjs';

const temp = mkdtempSync(join(tmpdir(), 'randoroute-store-routing-'));
const maps = join(temp, 'maps');
const python = process.env.PYTHON || 'python3';
execFileSync(python, [join(ROOT, 'scripts/testlib/build_synthetic_partition_fixture.py'),
  maps, '--chain-length', '3'], { cwd: ROOT, stdio: 'pipe' });
const cataloguePath = join(maps, 'partition-catalogue.json');
execFileSync(python, [join(ROOT, 'scripts/build_graph_partitions.py'),
  '--maps-root', maps, '--output-root', maps, '--catalogue', cataloguePath,
  '--state', 'state-a', '--state', 'state-b', '--state', 'state-c'],
{ cwd: ROOT, stdio: 'pipe' });
const catalogueBytes = readFileSync(cataloguePath);
const catalogue = JSON.parse(catalogueBytes.toString('utf8'));
const catalogueSha256 = createHash('sha256').update(catalogueBytes).digest('hex');
execFileSync(process.execPath, [join(ROOT, 'scripts/build_map_registry.mjs'),
  '--maps-root', maps], { cwd: ROOT, stdio: 'pipe' });
const storeIndex = JSON.parse(readFileSync(join(maps, 'index.json'), 'utf8'));
const states = storeIndex.states;
check('the generated v2 contract publishes map and routing acquisition units generically',
  storeIndex.storeFormat === 2 && states.length === 3
    && states.every((state) => state.acquisitions.map((unit) => unit.kind).join('|')
      === 'state-map|routing-partitions'), JSON.stringify(states.map((state) => state.acquisitions)));

const store = createServer((request, response) => {
  const path = decodeURIComponent(request.url.split('?')[0].replace(/^\//, ''));
  const body = path === 'index.json'
    ? Buffer.from(JSON.stringify(storeIndex)) : (() => {
      try { return readFileSync(join(maps, path)); } catch (error) { return null; }
    })();
  if (!body) { response.writeHead(404, { 'access-control-allow-origin': '*' }); response.end(); return; }
  response.writeHead(200, { 'access-control-allow-origin': '*',
    'content-type': path.endsWith('.json') ? 'application/json' : 'application/octet-stream',
    'content-length': body.length });
  response.end(body);
});
await new Promise((resolve) => store.listen(0, resolve));
const storeUrl = `http://localhost:${store.address().port}/`;

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);
await page.waitForFunction(() => window.MapStore && window.MultiStateRouteCoordinator,
  null, { timeout: 120000 });

try {
  const initial = await page.evaluate(async ({ url, catalogue: routingCatalogue,
    catalogueSha256: catalogueHash }) => {
    const index = await MapStore.fetchIndex(url);
    for (const id of ['state-a', 'state-c']) {
      await MapStore.installState(url, index.states.find((state) => state.id === id));
    }
    const dependencies = MultiStateRouteCoordinator.routeDependencies(
      routingCatalogue,
      ['state-a', 'state-b', 'state-c'],
      routingCatalogue.partitions.map((partition) => partition.id),
      { path: 'partition-catalogue.json', sha256: catalogueHash });
    localStorage.setItem('jra-test-saved-route', JSON.stringify({ name: 'A to C',
      routeDependencies: dependencies }));
    return { status: MapStore.routeDependencyStatus(dependencies), dependencies,
      installed: MapStore.installedStateIds() };
  }, { url: storeUrl, catalogue, catalogueSha256 });
  check('A and C installed without B report the required transit state',
    !initial.status.available && initial.status.missingStateIds.join() === 'state-b'
      && initial.installed.includes('state-a') && initial.installed.includes('state-c'),
    JSON.stringify(initial));

  const installed = await page.evaluate(async ({ url, dependencies }) => {
    const index = await MapStore.fetchIndex(url);
    await MapStore.installState(url, index.states.find((state) => state.id === 'state-b'));
    const routing = MapStore.routingAcquisitionForStates(['state-a', 'state-b', 'state-c']);
    const context = await MapStore.routingContext(['state-a', 'state-b', 'state-c']);
    return { routingAvailable: routing.available,
      catalogueStates: context.catalogue.states.map((state) => state.id),
      status: MapStore.routeDependencyStatus(dependencies),
      catalogueKey: (await (await caches.open(DATA_CACHE_NAME)).keys())
        .map((request) => request.url).find((url) => url.includes('partition-catalogue')) };
  }, { url: storeUrl, dependencies: initial.dependencies });
  check('installing the transit state makes one compatible three-state acquisition available',
    installed.routingAvailable && installed.status.available
      && installed.catalogueStates.join('|') === 'state-a|state-b|state-c'
      && installed.catalogueKey.includes(catalogueSha256), JSON.stringify(installed));

  await page.context().setOffline(true);
  const offline = await page.evaluate(async () => {
    const context = await MapStore.routingContext(['state-a', 'state-b', 'state-c']);
    return context.catalogue.partitions.length;
  });
  check('the exact partition catalogue restores from Cache Storage while offline',
    offline === catalogue.partitions.length, String(offline));
  await page.context().setOffline(false);

  const failedUpdate = await page.evaluate(async ({ url }) => {
    const before = MapStore.installedEntry('state-b');
    const brokenFile = { dataset: 'places', path: 'missing.json', bytes: 20 };
    const broken = { ...before.state, files: [brokenFile], acquisitions: [{
      acquisitionFormat: 1, id: 'map-state-b-broken', kind: 'state-map',
      stateIds: ['state-b'], totalBytes: 20, files: [brokenFile],
    }] };
    let error = '';
    try { await MapStore.installState(url, broken); } catch (caught) { error = caught.message; }
    const after = MapStore.installedEntry('state-b');
    return { error, before: before.state.acquisitions.map((unit) => unit.id),
      after: after.state.acquisitions.map((unit) => unit.id) };
  }, { url: storeUrl });
  check('a failed update leaves the prior atomic acquisition installed',
    /HTTP 404/.test(failedUpdate.error)
      && failedUpdate.before.join('|') === failedUpdate.after.join('|'),
    JSON.stringify(failedUpdate));

  const failedHash = await page.evaluate(async ({ url }) => {
    const before = MapStore.installedEntry('state-b');
    const acquisitions = structuredClone(before.state.acquisitions);
    const routing = acquisitions.find((unit) => unit.kind === 'routing-partitions');
    routing.id = `${routing.id}-bad-hash`;
    routing.files[0].sha256 = '0'.repeat(64);
    let error = '';
    try {
      await MapStore.installState(url, { ...before.state, acquisitions });
    } catch (caught) { error = caught.message; }
    const after = MapStore.installedEntry('state-b');
    return { error, before: before.state.acquisitions.map((unit) => unit.id),
      after: after.state.acquisitions.map((unit) => unit.id) };
  }, { url: storeUrl });
  check('a corrupt partition fails its SHA check without replacing the installed acquisition',
    /failed its SHA-256 check/.test(failedHash.error)
      && failedHash.before.join('|') === failedHash.after.join('|'),
    JSON.stringify(failedHash));

  const updated = await page.evaluate(async ({ url, dependencies }) => {
    const before = MapStore.installedEntry('state-b').state;
    const mapUnit = before.acquisitions.find((unit) => unit.kind === 'state-map');
    const mapOnly = { ...before, versions: { graph: 'updated-graph-version' },
      acquisitions: [{ ...mapUnit, id: 'map-state-b-updated' }] };
    await MapStore.installState(url, mapOnly);
    const status = MapStore.routeDependencyStatus(dependencies);
    const cache = await caches.open(DATA_CACHE_NAME);
    const oldPartitions = (await cache.keys()).filter((request) =>
      new URL(request.url).pathname.includes('/state-b/partitions/')).length;
    return { status, oldPartitions };
  }, { url: storeUrl, dependencies: initial.dependencies });
  check('a state update invalidates old dependent partitions and the saved-route availability',
    !updated.status.available && updated.status.outdatedStateIds.includes('state-b')
      && updated.oldPartitions === 0, JSON.stringify(updated));

  const removed = await page.evaluate(async ({ url, dependencies }) => {
    const index = await MapStore.fetchIndex(url);
    await MapStore.installState(url, index.states.find((state) => state.id === 'state-b'));
    await MapStore.removeState('state-b');
    localStorage.setItem('wa-bike-saved-routes-1', JSON.stringify([{ name: 'A to C',
      s: [-1, 0], e: [3, 0], v: [], b: [], routeDependencies: dependencies }]));
    document.getElementById('routeLibraryBtn').click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const savedRow = document.querySelector('#savedRoutes .saved-row');
    return { status: MapStore.routeDependencyStatus(dependencies),
      saved: JSON.parse(localStorage.getItem('jra-test-saved-route') || 'null'),
      entry: MapStore.installedEntry('state-b'),
      savedRowText: savedRow?.textContent.replace(/\s+/g, ' ').trim() || '',
      savedLoadDisabled: savedRow?.querySelector('.saved-load')?.disabled };
  }, { url: storeUrl, dependencies: initial.dependencies });
  check('removing the transit state keeps the saved route but marks it unavailable offline',
    !removed.status.available && removed.status.missingStateIds.includes('state-b')
      && removed.saved?.name === 'A to C' && removed.entry === null
      && removed.savedLoadDisabled && /Missing state-b/i.test(removed.savedRowText),
    JSON.stringify(removed));

  const cancelled = await page.evaluate(async ({ url }) => {
    const index = await MapStore.fetchIndex(url);
    const controller = new AbortController();
    controller.abort();
    let errorName = '';
    try {
      await MapStore.installState(url,
        index.states.find((state) => state.id === 'state-b'), () => {},
        { signal: controller.signal });
    } catch (caught) { errorName = caught.name; }
    const temporaryCaches = (await caches.keys())
      .filter((name) => name.includes('-install-') || name.includes('-backup-'));
    return { errorName, temporaryCaches, installed: MapStore.installedEntry('state-b') };
  }, { url: storeUrl });
  check('cancelling an acquisition leaves no partial state or staging cache',
    cancelled.errorName === 'AbortError' && !cancelled.installed
      && cancelled.temporaryCaches.length === 0, JSON.stringify(cancelled));
  check('the acquisition test page has no JavaScript errors',
    page.pageErrors.length === 0, page.pageErrors.join(' | '));
} finally {
  await browser.close();
  await site.close();
  store.close();
  rmSync(temp, { recursive: true, force: true });
}

done();
