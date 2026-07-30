#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sw = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const detailsHtml = fs.readFileSync(new URL('../route-details.html', import.meta.url), 'utf8');
const indexHtml = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const release = JSON.parse(fs.readFileSync(new URL('../version.json', import.meta.url), 'utf8'));

// Deliberately NOT cache.addAll: that is all-or-nothing, so one dropped request
// on a phone failed the whole install, the new worker never reached the waiting
// state, and the app reported an update it could not install. Each file is
// fetched with a retry instead, and a file that fails twice still fails the
// install. This test asserted the old, weaker shape long after sw.js stopped
// using it.
assert.match(sw, /async function precacheShell\(\)[\s\S]*?for \(const path of SHELL\)/,
  'a candidate update must precache the complete app shell before it can install');
assert.match(sw, /for \(let attempt = 0; attempt < 2; attempt\+\+\)/,
  'and must survive a single dropped request rather than failing the install');
assert.match(sw, /if \(lastError\) throw new Error/,
  'while still failing the install when a shell file genuinely cannot be fetched');
assert.match(sw, /precacheData\(\)/,
  'a candidate update must populate the complete offline data cache');
assert.match(sw, /updatingExistingApp = Boolean\(self\.registration\.active\)[\s\S]*?updatingExistingApp \? Promise\.resolve\(\) : precacheData\(\)/,
  'an existing PWA update must not reopen every statewide archive during installation');
assert.match(sw, /for \(const path of DATA\)[\s\S]*?await cache\.add\(request\)/,
  'large statewide data archives should be cached sequentially to limit installation memory');
assert.match(sw, /ALWAYS_REFRESH_DATA = new Set\(\[[\s\S]*?bikeroutes\.geojson\.gz[\s\S]*?async function refreshReleaseData[\s\S]*?cache\.put\(request, response\)/,
  'small changed route overlays should refresh during activation without redownloading every statewide archive');
for (const asset of ['data/roads.pmtiles', 'data/basemap.pmtiles']) {
  assert.ok(sw.includes(`'./${asset}'`), `offline data cache omits ${asset}`);
}
// The graph is listed with a cache-busting query string rather than as a bare
// path. The service worker serves /data/ cache-first and ignores the query, so
// without this a rider keeps the graph they first downloaded forever and a
// rebuilt one silently never reaches them. A plain-substring check for the path
// missed it entirely once the template literal went in.
assert.match(sw, /`\.\/data\/graph2\.bin\.gz\?gv=\$\{GRAPH_DATA_VERSION\}`/,
  'the graph must be precached under its data version, not as a bare path');
assert.match(sw, /url\.pathname\.endsWith\('\.pmtiles'\)[\s\S]*?pmtilesOnlineFirst\(e\.request\)/,
  'online PMTiles reads should avoid materializing the complete cached archive');
assert.match(sw, /async function pmtilesOnlineFirst[\s\S]*?response\.status === 206[\s\S]*?return pmtilesRangeResponse\(req\)/,
  'PMTiles should use server byte ranges online and retain the offline archive fallback');
assert.match(sw, /const pmtilesBlobPromises = new Map\(\)[\s\S]*?pmtilesBlobPromises\.get\(archiveKey\)[\s\S]*?pmtilesBlobPromises\.set\(archiveKey, blobPromise\)/,
  'offline range reads should reuse one archive Blob instead of copying it per tile');
assert.match(sw, /url\.origin === location\.origin\) \{\s*e\.respondWith\(cacheFirst\(SHELL_CACHE, e\.request\)\);/,
  'the active app shell should stay cache-first until the user accepts an update');
assert.doesNotMatch(sw, /networkFirst\(SHELL_CACHE/,
  'individual app-shell files must not refresh independently during a release');
assert.match(indexHtml, /version\.json\?register=\$\{Date\.now\(\)\}[\s\S]*?sw\.js\$\{suffix\}[\s\S]*?updateViaCache: 'none'/,
  'service-worker registration must use the cache-busted published release URL');
assert.match(app, /version\.json\?update-check=\$\{Date\.now\(\)\}/,
  'manual update checks must use a unique release-marker URL');
assert.match(app, /publishedVersion !== APP_VERSION/,
  'the app must compare its version with the published release marker');
assert.match(app, /sw\.js\?release=\$\{encodeURIComponent\(publishedVersion\)\}[\s\S]*?scope: '\.\/', updateViaCache: 'none'/,
  'manual update checks must bypass a stale CDN copy of the worker script');
const appVersion = /const APP_VERSION = '([^']+)'/.exec(app)?.[1];
assert.equal(release.version, appVersion,
  'the published release marker must match the app version');
const detailsAssetVersion = /route-details\.css\?v=(\d+)/.exec(detailsHtml)?.[1];
assert.ok(detailsAssetVersion, 'Route Details should version its CSS URL');
assert.match(detailsHtml, new RegExp(`route-details\\.js\\?v=${detailsAssetVersion}`),
  'Route Details CSS and JavaScript should use the same asset version');
assert.match(sw, new RegExp(`'\\./route-details\\.css\\?v=${detailsAssetVersion}'`),
  'the service worker should precache the exact versioned Route Details stylesheet');
assert.match(sw, new RegExp(`'\\./route-details\\.js\\?v=${detailsAssetVersion}'`),
  'the service worker should precache the exact versioned Route Details script');

const cacheFirstStart = sw.indexOf('async function cacheFirst(');
assert.ok(cacheFirstStart >= 0, 'cache-first helper was not found');
const cacheFirstSource = sw.slice(cacheFirstStart);

let fetchCalls = 0;
const cachedResponse = { source: 'cached' };
const cacheHit = {
  match: async () => cachedResponse,
  put: async () => { throw new Error('should not rewrite a cache hit'); },
};
const hitContext = vm.createContext({
  caches: { open: async () => cacheHit },
  fetch: async () => { fetchCalls++; return { source: 'network' }; },
});
vm.runInContext(cacheFirstSource, hitContext);
assert.equal(await vm.runInContext('cacheFirst("shell", "route-details.js")', hitContext), cachedResponse,
  'a running release should use its already precached Route Details script');
assert.equal(fetchCalls, 0, 'a cache hit must not fetch a potentially newer shell file');

let writtenResponse = null;
const freshResponse = { ok: true, source: 'network', clone: () => ({ source: 'clone' }) };
const cacheMiss = {
  match: async () => null,
  put: async (_request, response) => { writtenResponse = response; },
};
const missContext = vm.createContext({
  caches: { open: async () => cacheMiss },
  fetch: async () => freshResponse,
});
vm.runInContext(cacheFirstSource, missContext);
assert.equal(await vm.runInContext('cacheFirst("shell", "new-shell-file.js")', missContext), freshResponse,
  'an uncached local file should still load from the network');
assert.deepEqual(writtenResponse, { source: 'clone' }, 'a successful network response should be cached for offline use');

const rangeBytes = new Uint8Array([10, 20, 30, 40, 50, 60]);
const fullArchive = new Response(rangeBytes, {
  status: 200,
  headers: { 'Content-Type': 'application/octet-stream' },
});
const rangeCache = {
  match: async () => fullArchive.clone(),
  put: async () => { throw new Error('a cached archive should not be rewritten'); },
};
const rangeContext = vm.createContext({
  caches: { open: async () => rangeCache },
  fetch: async () => { throw new Error('a cached archive range must not use the network'); },
  Request,
  Response,
  Blob,
  URL,
  Headers,
  Uint8Array,
});
rangeContext.DATA_CACHE = 'data-offline-map-v1';
vm.runInContext(cacheFirstSource, rangeContext);
rangeContext.rangeRequest = new Request('https://example.test/data/roads.pmtiles?v=11', {
  headers: { Range: 'bytes=2-4' },
});
const partial = await vm.runInContext('pmtilesRangeResponse(rangeRequest)', rangeContext);
assert.equal(partial.status, 206, 'a cached PMTiles byte range should return HTTP 206');
assert.equal(partial.headers.get('Content-Range'), 'bytes 2-4/6');
assert.deepEqual([...new Uint8Array(await partial.arrayBuffer())], [30, 40, 50],
  'the offline PMTiles response should contain only the requested bytes');

console.log('Service worker update tests passed.');
