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

/* ------------------------------------------------- the app's own rules */
/**
 * The rider's default rules, lifted from app.js rather than transcribed.
 *
 * app.js is a plain script with no exports, so a test that needs its
 * constants has to evaluate the source. Three tests each hand-rolled that --
 * find `const DEFAULT_RULES`, brace-match the literal, eval it -- and all
 * three broke at once when DEFAULT_RULES grew a reference to
 * ADVANCED_ROUTE_OPTION_DEFAULTS: the lifted literal no longer stands alone.
 *
 * The lesson is not "add the missing constant" but that the lifting belongs
 * in ONE place. Evaluating the constants in dependency order into a single
 * sandbox means the next constant that references another simply works, and
 * a test never has to know app.js's internal order again.
 */
export function appDefaultRules() {
  const source = readSync(join(ROOT, 'app.js'), 'utf8');
  const literalAfter = (name) => {
    const at = source.indexOf(`const ${name}`);
    if (at === -1) throw new Error(`app.js no longer defines ${name}`);
    const open = source.indexOf('{', at);
    let depth = 0, i = open;
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) break;
    }
    return source.slice(open, i + 1);
  };
  const box = {};
  vm.createContext(box);
  // Order matters: later literals reference earlier ones.
  for (const name of ['ADVANCED_ROUTE_OPTION_DEFAULTS', 'DEFAULT_RULES']) {
    vm.runInContext(`var ${name} = ${literalAfter(name)}`, box);
  }
  const rules = box.DEFAULT_RULES;
  if (!rules || rules.minShoulder == null) throw new Error('DEFAULT_RULES lift failed');
  return rules;
}

/* ------------------------------------------------------------ the graph */
/** The generated registry: one entry per maps/<state>/region.json. */
export const mapStates = () => require_(join(ROOT, 'maps/states.js')).MAP_STATES;

/**
 * The state a test gets when it does not name one.
 *
 * This file used to hardcode `maps/washington/graph2.bin.gz`, which made it
 * the one place outside maps/ that named a state -- the thing maps/README
 * forbids -- and meant no test could load a second state's graph at all.
 * Washington still wins, but because it wins the app's OWN rule (released,
 * highest readiness, in region.js), so the harness follows the registry
 * rather than a literal.
 */
export function defaultStateId() {
  const states = mapStates();
  const released = states.filter((state) => state.status === 'released');
  return (released.length
    ? released.reduce((best, state) =>
      ((state.readiness || 0) > (best.readiness || 0) ? state : best))
    : states[0]).id;
}

const graphBytesByState = new Map();
/** A state's production graph, gunzipped at most once per process. */
export function graphBuffer(stateId = defaultStateId()) {
  if (!graphBytesByState.has(stateId)) {
    const gz = readSync(join(ROOT, 'maps', stateId, 'graph2.bin.gz'));
    const raw = zlib.gunzipSync(gz);
    graphBytesByState.set(stateId,
      raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength
        ? raw.buffer : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  }
  return graphBytesByState.get(stateId);
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
    // Browsers give workers timers; the cache pre-warm sweeps in setTimeout
    // chunks so a real request only ever waits for the current slice.
    setTimeout, clearTimeout,
    postMessage(message) { messages.push(message); },
  };
}

/**
 * A router worker running the real graph, in the environment the browser gives
 * it. Returns { context, messages, run } where run(expression) evaluates inside
 * the worker's own scope -- which is how a test reaches a function the worker
 * never exports.
 */
const workerCache = new Map();
export function routerWorker({ fresh = false, state = defaultStateId() } = {}) {
  if (workerCache.has(state) && !fresh) return workerCache.get(state);
  const messages = [];
  const context = vm.createContext(workerGlobals(messages));
  context.self = context;
  context.importScripts = (...names) => {
    // The worker pulls in the shared verdict model with importScripts(); mirror
    // that so a test context matches what the browser actually provides.
    for (const n of names) vm.runInContext(source(n), context);
  };
  vm.runInContext(source('router-worker.js'), context);
  context.onmessage({ data: { type: 'graph', buffer: graphBuffer(state),
    stateIds: [state] } });
  const ready = messages.at(-1)?.type === 'ready';
  const api = {
    context, messages, ready, state,
    run: (expression) => vm.runInContext(expression, context),
    post: (message) => { context.onmessage({ data: message }); return messages.at(-1); },
  };
  if (!fresh) workerCache.set(state, api);
  return api;
}

/** A router worker loaded with caller-supplied ordinary graph bytes. */
export function routerWorkerFromBuffer(buffer, metadata = {}) {
  const messages = [];
  const context = vm.createContext(workerGlobals(messages));
  context.self = context;
  context.importScripts = (...names) => {
    for (const n of names) vm.runInContext(source(n), context);
  };
  vm.runInContext(source('router-worker.js'), context);
  context.onmessage({ data: { type: 'graph', buffer, ...metadata } });
  return {
    context, messages,
    ready: messages.at(-1)?.type === 'ready',
    run: (expression) => vm.runInContext(expression, context),
    post: (message) => { context.onmessage({ data: message }); return messages.at(-1); },
  };
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
export async function serveRepo({ offline = false, root = ROOT } = {}) {
  const state = { offline, requests: [], overrides: new Map() };
  const server = createServer(async (req, res) => {
    state.requests.push({ url: req.url, range: req.headers.range || null, at: Date.now() });
    // Publishing a release, from the browser's point of view, is nothing more
    // than these bytes changing. Overriding them is how a test can deploy.
    const path = decodeURIComponent(req.url.split('?')[0]);
    if (state.overrides.has(path)) {
      const body = state.overrides.get(path);
      if (typeof body === 'function') return body(req, res);
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
      const full = join(root, path);
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
    publish(path, bodyOrHandler) { state.overrides.set(path, bodyOrHandler); },
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
    process.env.CHROMIUM_PATH,
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  ]) if (candidate && existsSync(candidate)) return candidate;
  return undefined; // let Playwright find its own
}

export async function playwright() {
  for (const path of [
    process.env.PLAYWRIGHT_MODULE_PATH,
    'playwright',
    '/opt/node22/lib/node_modules/playwright/index.js',
  ]) {
    if (!path) continue;
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

/**
 * A page with the app loaded and the map settled.
 *
 * Driving a route programmatically: call `setRoutePoint('start'|'end',
 * {lng, lat}, name)` then `computeRoute()`. Assigning `routing.start` /
 * `routing.end` directly skips the per-point state resolution
 * (`startStateId`/`endStateId` stay null), so a cross-state pair silently
 * routes single-state through the home worker — a state unreachable from
 * the real UI. Direct assignment is only safe when the test also sets the
 * state ids itself (see test_route_portfolio_controls.mjs).
 */
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
