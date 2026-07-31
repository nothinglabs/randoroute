#!/usr/bin/env node
// A rebuilt routing graph must actually reach a device.
//
// The service worker serves /data/ cache-first ignoring the query string, so a
// graph whose bytes changed under an unchanged name was served from cache
// forever -- county bike routes were baked in using a spare flag bit, the
// format string never moved, and riders kept routing on a graph that had never
// heard of them. Nothing looked broken; the route was just quietly wrong.
//
// This file used to prove that with six regular expressions over the TEXT of
// app.js and sw.js. They broke the moment GRAPH_DATA_VERSION moved into
// build-version.js -- a change that made the very thing they were guarding
// structurally impossible -- while never having been able to notice the worker
// actually serving a stale graph. So it now RUNS the worker: sw.js is evaluated
// in a worker-shaped context, its handlers are invoked with real URLs, and what
// it asks the cache for is recorded.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { ROOT } from './testlib/harness.mjs';

const require_ = createRequire(import.meta.url);
const { GRAPH_DATA_VERSION } = require_(join(ROOT, 'build-version.js'));

let pass = 0, fail = 0;
const ck = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  -- ' + x : ''}`); };

/* ------------------------------------------- run sw.js as a worker would */
const matches = [];      // every cache.match(request, options) the worker makes
const deleted = [];      // every cache.delete the worker makes
const listeners = {};
let cacheKeys = [];

function makeCache(name) {
  return {
    match: async (req, opts) => {
      matches.push({ cache: name, url: String(req.url || req), opts: opts || {} });
      return undefined;
    },
    put: async () => {},
    delete: async (req) => { deleted.push({ cache: name, url: String(req.url || req) }); return true; },
    keys: async () => cacheKeys.map((u) => ({ url: u })),
    addAll: async () => {},
  };
}

const ctx = vm.createContext({
  console, URL, Response, Promise, JSON, Math, Date, Object, Array, String, Number, Set, Map,
  location: { origin: 'https://example.test' },
  caches: {
    open: async (name) => makeCache(name),
    keys: async () => ['data-offline-map-v8'],
    delete: async () => true,
    match: async () => undefined,
  },
  fetch: async () => ({ ok: true, clone: () => ({}) }),
  clients: { claim: async () => {}, matchAll: async () => [] },
  skipWaiting: async () => {},
});
ctx.self = ctx;
ctx.addEventListener = (type, handler) => { listeners[type] = handler; };
ctx.importScripts = (...names) => {
  for (const n of names) {
    vm.runInContext(readFileSync(join(ROOT, String(n).replace(/^\.\//, '')), 'utf8'), ctx);
  }
};
vm.runInContext(readFileSync(join(ROOT, 'sw.js'), 'utf8'), ctx);

ck('sw.js resolves the shared graph version',
  ctx.GRAPH_DATA_VERSION === GRAPH_DATA_VERSION,
  `${ctx.GRAPH_DATA_VERSION} vs ${GRAPH_DATA_VERSION}`);

/* -------------------------------- what the fetch handler asks the cache */
const ask = async (url) => {
  matches.length = 0;
  let responded = null;
  listeners.fetch({ request: { method: 'GET', url }, respondWith: (p) => { responded = p; } });
  if (responded) await Promise.resolve(responded).catch(() => {});
  return matches[0] || null;
};

const graph = await ask(`https://example.test/data/graph2.bin.gz?gv=${GRAPH_DATA_VERSION}`);
ck('the graph is served WITHOUT ignoreSearch', !!graph && graph.opts.ignoreSearch === false,
  graph ? `ignoreSearch=${graph.opts.ignoreSearch}` : 'no cache lookup made');

const other = await ask('https://example.test/data/places.json?v=3');
ck('other /data/ assets still ignore the query string',
  !!other && other.opts.ignoreSearch === true,
  other ? `ignoreSearch=${other.opts.ignoreSearch}` : 'no cache lookup made');

const shell = await ask('https://example.test/app.js');
ck('shell assets come from the shell cache', !!shell && /shell-/.test(shell.cache),
  shell ? shell.cache : 'no cache lookup made');

/* ------------------------------ a graph under an older version is purged */
cacheKeys = [
  `https://example.test/data/graph2.bin.gz?gv=${GRAPH_DATA_VERSION}`,
  'https://example.test/data/graph2.bin.gz?gv=1999-01-01-old',
  'https://example.test/data/places.json',
];
deleted.length = 0;
await ctx.purgeStaleGraph();
ck('a graph cached under an older version is purged',
  deleted.some((d) => d.url.includes('1999-01-01-old')),
  deleted.map((d) => d.url).join(', ') || 'nothing deleted');
ck('the current graph is kept',
  !deleted.some((d) => d.url.includes(GRAPH_DATA_VERSION)),
  deleted.map((d) => d.url).join(', '));
ck('unrelated /data/ assets are left alone',
  !deleted.some((d) => d.url.includes('places.json')));

/* ---------------- the app requests the graph with the version attached */
// The URL the app builds is the behaviour. Evaluate the template rather than
// matching how it is written, so reformatting cannot fail this.
const appSrc = readFileSync(join(ROOT, 'app.js'), 'utf8');
const urlExpr = /(['"`])([^'"`]*graph2\.bin\.gz\?[^'"`]*)\1/.exec(appSrc);
ck('the app builds a graph URL at all', !!urlExpr);
if (urlExpr) {
  const built = urlExpr[2]
    .replace('${GRAPH_FORMAT_VERSION}', 'FMT')
    .replace('${GRAPH_DATA_VERSION}', GRAPH_DATA_VERSION);
  ck('the graph request carries the data version', built.includes(GRAPH_DATA_VERSION), built);
  ck('the graph request carries the format version', built.includes('FMT'), built);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
