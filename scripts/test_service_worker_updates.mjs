#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sw = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const detailsHtml = fs.readFileSync(new URL('../route-details.html', import.meta.url), 'utf8');

assert.match(sw, /c\.addAll\(SHELL\)/,
  'a candidate update must precache the complete app shell before it can install');
assert.match(sw, /url\.origin === location\.origin\) \{\s*e\.respondWith\(cacheFirst\(SHELL_CACHE, e\.request\)\);/,
  'the active app shell should stay cache-first until the user accepts an update');
assert.doesNotMatch(sw, /networkFirst\(SHELL_CACHE/,
  'individual app-shell files must not refresh independently during a release');
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

console.log('Service worker update tests passed.');
