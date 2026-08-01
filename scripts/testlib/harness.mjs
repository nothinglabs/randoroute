// One place for everything the tests used to rebuild per file.
//
// Before this existed, thirty test files each hand-stubbed a browser with
// node:vm -- listing Date, Math, Map, Set, TextDecoder and eight typed-array
// constructors by hand -- and thirteen of them separately gunzipped the 32 MB
// production graph. That duplication was most of the suite's twenty-minute
// runtime and all of its copy-paste.
//
// safety-model.js needs none of it. Its IIFE ends with
// `}(typeof self !== 'undefined' ? self : this))`, and in a Node CommonJS
// module `this` IS module.exports, so `require()` has always worked on it. The
// vm scaffolding was never necessary to reach the safety model; only app.js and
// router-worker.js genuinely need a fake browser, because they run browser code
// at the top level.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createReadStream, readFile, readFileSync } from 'node:fs';
import { readFile as readFileAsync, stat } from 'node:fs/promises';
import { existsSync, readFileSync as readSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import zlib from 'node:zlib';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require_ = createRequire(import.meta.url);

/** The shared verdict model, imported rather than evaluated in a fake browser. */
export const { SafetyModel } = require_(join(ROOT, 'safety-model.js'));

export const source = (name) => readSync(join(ROOT, name), 'utf8');

/* ------------------------------------------------------------- assertions */
// Deliberately not node:assert. A test file is a list of named behaviours, and
// a run should report every failure rather than stopping at the first one --
// that is what makes a red run actionable instead of a bisect.
let passed = 0;
const failures = [];
export function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${name}`); return true; }
  failures.push(name + (detail ? ` -- ${detail}` : ''));
  console.log(`  FAIL ${name}${detail ? `  -- ${detail}` : ''}`);
  return false;
}
export const checkEqual = (name, actual, expected) =>
  check(name, Object.is(actual, expected), `expected ${expected}, got ${actual}`);
export const checkClose = (name, actual, expected, tol = 1e-6) =>
  check(name, Math.abs(actual - expected) <= tol, `expected ~${expected}, got ${actual}`);

// Every test file ends with this. Non-zero exit on any failure is what the
// runner reads.
export function done() {
  console.log(failures.length
    ? `\n${passed} passed, ${failures.length} FAILED\n  - ${failures.join('\n  - ')}`
    : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
  return failures.length === 0;
}

/* ------------------------------------------------------------ the graph */
let graphBytes = null;
/** The production graph, gunzipped at most once per process. */
export function graphBuffer() {
  if (!graphBytes) {
    const gz = readSync(join(ROOT, 'data/graph2.bin.gz'));
    const raw = zlib.gunzipSync(gz);
    graphBytes = raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength
      ? raw.buffer : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  }
  return graphBytes;
}

/* --------------------------------------------------- the router worker */
// The browser gives a worker a specific, small set of globals. Listing them
// here once means a test that needs one more does not have to rediscover the
// whole list.
function workerGlobals(messages) {
  return {
    Date, Math, Map, Set, WeakMap, WeakSet, JSON, TextDecoder, TextEncoder,
    ArrayBuffer, DataView, Float32Array, Float64Array, Int8Array, Int16Array,
    Int32Array, Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array,
    console, isNaN, isFinite, parseInt, parseFloat, Number, String, Boolean,
    Array, Object, Error, RangeError, TypeError, Promise, Symbol, BigInt,
    postMessage(message) { messages.push(message); },
  };
}

/**
 * A router worker running the real graph, in the environment the browser gives
 * it. Returns { context, messages, run } where run(expression) evaluates inside
 * the worker's own scope -- which is how a test reaches a function the worker
 * never exports.
 */
let workerCache = null;
export function routerWorker({ fresh = false } = {}) {
  if (workerCache && !fresh) return workerCache;
  const messages = [];
  const context = vm.createContext(workerGlobals(messages));
  context.self = context;
  context.importScripts = (...names) => {
    // The worker pulls in the shared verdict model with importScripts(); mirror
    // that so a test context matches what the browser actually provides.
    for (const n of names) vm.runInContext(source(n), context);
  };
  vm.runInContext(source('router-worker.js'), context);
  context.onmessage({ data: { type: 'graph', buffer: graphBuffer() } });
  const ready = messages.at(-1)?.type === 'ready';
  const api = {
    context, messages, ready,
    run: (expression) => vm.runInContext(expression, context),
    post: (message) => { context.onmessage({ data: message }); return messages.at(-1); },
  };
  if (!fresh) workerCache = api;
  return api;
}

/**
 * The nearest graph edge to a point, which nearly every routing test needs and
 * each used to open-code. `where` is an optional JS expression over `i` that
 * narrows the search, e.g. 'eFacility[i] === 1 && eSpeed[i] === 35'.
 *
 * Edges carry no coordinates of their own -- they reference nodes through
 * eA/eB -- so distance is to the nearer endpoint, which is what the hand-rolled
 * copies of this all did.
 */
export function nearestEdge(worker, lon, lat, where = 'true') {
  return worker.run(`(() => {
    let edge = -1, best = Infinity;
    for (let i = 0; i < E; i++) {
      if (!(${where})) continue;
      const d = Math.min(havM(${lon}, ${lat}, nodeLon[eA[i]], nodeLat[eA[i]]),
                         havM(${lon}, ${lat}, nodeLon[eB[i]], nodeLat[eB[i]]));
      if (d < best) { best = d; edge = i; }
    }
    return { edge, metres: edge < 0 ? null : best };
  })()`);
}

/* ------------------------------------------------------- static server */
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.gz': 'application/gzip', '.png': 'image/png',
  '.pmtiles': 'application/octet-stream', '.bin': 'application/octet-stream',
  '.pbf': 'application/octet-stream', '.woff2': 'font/woff2',
};

/**
 * Serves the repo with byte-range support, which PMTiles requires -- without
 * 206 responses the basemap silently renders as open ocean.
 *
 * Ranges are STREAMED off disk. Reading the whole file and slicing it, which
 * this used to do, means a 45 MB read per tile: it made the archives
 * unservable (Node refuses past its string limit under load) and it made every
 * measurement of tile latency a measurement of the test server instead.
 *
 * `offline` makes every request fail the way a dropped connection does, so a
 * test can assert what the app still does without a network.
 */
export async function serveRepo({ offline = false } = {}) {
  const state = { offline, requests: [], overrides: new Map() };
  const server = createServer(async (req, res) => {
    state.requests.push({ url: req.url, range: req.headers.range || null, at: Date.now() });
    // Publishing a release, from the browser's point of view, is nothing more
    // than these bytes changing. Overriding them is how a test can deploy.
    const path = decodeURIComponent(req.url.split('?')[0]);
    if (state.overrides.has(path)) {
      const body = state.overrides.get(path);
      res.writeHead(200, {
        'content-type': TYPES[extname(path)] || 'application/octet-stream',
        'content-length': Buffer.byteLength(body),
      });
      return res.end(body);
    }
    // Destroying the socket is what a dropped connection looks like. Destroying
    // only the request leaves the browser waiting for a response that never
    // comes, which hangs a test instead of failing it.
    if (state.offline) { req.socket?.destroy(); return; }
    try {
      let path = decodeURIComponent(req.url.split('?')[0]);
      if (path === '/') path = '/index.html';
      const full = join(ROOT, path);
      const info = await stat(full);
      const type = TYPES[extname(path)] || 'application/octet-stream';
      const range = req.headers.range && /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      if (range) {
        const from = +range[1];
        const to = Math.min(range[2] ? +range[2] : info.size - 1, info.size - 1);
        if (from > to) {
          res.writeHead(416, { 'content-range': `bytes */${info.size}` });
          return res.end();
        }
        res.writeHead(206, {
          'content-type': type, 'accept-ranges': 'bytes',
          'content-range': `bytes ${from}-${to}/${info.size}`,
          'content-length': to - from + 1,
        });
        return createReadStream(full, { start: from, end: to }).pipe(res);
      }
      res.writeHead(200, {
        'content-type': type, 'accept-ranges': 'bytes', 'content-length': info.size,
      });
      createReadStream(full).pipe(res);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  return {
    server, port, url: `http://localhost:${port}/index.html`,
    // Pull the plug. Everything already cached keeps working; anything that
    // reaches for the network gets what a phone in a valley gets.
    goOffline() { state.offline = true; },
    goOnline() { state.offline = false; },
    publish(path, body) { state.overrides.set(path, body); },
    unpublish(path) { state.overrides.delete(path); },
    get requests() { return state.requests; },
    close: () => server.close(),
  };
}

/* ------------------------------------------------------------- browser */
// The container ships Chromium under a versioned directory and Playwright is
// installed globally, so neither resolves the way a project-local install
// would. Both used to be hardcoded per test file, which meant a container
// bump broke six files at once.
export function chromiumPath() {
  for (const candidate of [
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  ]) if (existsSync(candidate)) return candidate;
  return undefined; // let Playwright find its own
}

export async function playwright() {
  for (const path of ['playwright', '/opt/node22/lib/node_modules/playwright/index.js']) {
    try {
      const mod = await import(path);
      return mod.chromium ? mod : mod.default;
    } catch { /* try the next */ }
  }
  throw new Error('playwright is not installed; browser tests cannot run');
}

/**
 * One browser for a whole file. Callers make pages from it, so six behaviours
 * share a single ~2 s launch instead of paying it six times.
 */
export async function launchBrowser() {
  const { chromium } = await playwright();
  return chromium.launch({
    executablePath: chromiumPath(),
    args: ['--use-gl=swiftshader'],
  });
}

/** A page with the app loaded and the map settled. */
export async function appPage(browser, port, { desktop = false } = {}) {
  const context = await browser.newContext({
    serviceWorkers: 'block',
    viewport: desktop ? { width: 1200, height: 820 } : { width: 430, height: 900 },
    hasTouch: !desktop, isMobile: !desktop,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${port}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.map && map.loaded && map.loaded(),
    { timeout: 30000 }).catch(() => {});
  page.pageErrors = errors;
  return page;
}
