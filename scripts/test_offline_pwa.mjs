#!/usr/bin/env node
// The installed web app, with the network taken away.
//
// Every other browser test in this suite runs `serviceWorkers: 'block'`, so
// until now nothing exercised the service worker at all -- which is how the
// routing graph came to be precached under one URL and requested under another
// for who knows how long. The install downloaded 32 MB that nothing could ever
// read, and a freshly installed app could not route offline until some later
// online session happened to cache the app's own spelling of the URL.
//
// So this asserts the promise the service worker exists to make, the way a
// rider would find out it was broken: install the app, pull the plug, and see
// whether the map draws and a route comes back.
import assert from 'node:assert';
import { playwright, chromiumPath, serveRepo } from './testlib/harness.mjs';

const { chromium } = await playwright();
const site = await serveRepo();
const browser = await chromium.launch({
  executablePath: chromiumPath(), args: ['--use-gl=swiftshader'],
});
// No `serviceWorkers: 'block'` -- the worker is the subject.
const context = await browser.newContext({
  viewport: { width: 1100, height: 850 },
  // Exercise Safari's request-driven route-engine path while keeping a roomy
  // viewport for counting rendered offline map features.
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) '
    + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
});
const page = await context.newPage();
page.setDefaultTimeout(180000);
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

const SEATTLE = [-122.3321, 47.6062];
const BELLEVUE = [-122.2015, 47.6101];
let pass = 0;
const check = (name, ok, detail = '') => {
  if (!ok) {
    console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
    process.exitCode = 1;
  } else {
    pass++;
    console.log(`PASS  ${name}${detail ? `  -- ${detail}` : ''}`);
  }
};

/* ------------------------------------------------------------ install it */
await page.goto(site.url, { waitUntil: 'load' });
await page.waitForFunction(() => window.map && map.loaded && map.loaded(), { timeout: 300000 })
  .catch(() => {});
// The worker precaches the offline dataset. Wait for it rather than guessing.
await page.waitForFunction(
  async () => (await (await caches.open('data-offline-map-v9')).keys()).length >= 9,
  { timeout: 900000 });

const cached = await page.evaluate(async () => {
  const cache = await caches.open('data-offline-map-v9');
  return (await cache.keys()).map((r) => new URL(r.url).pathname + new URL(r.url).search);
});
// The graph's query string is part of its identity: it carries the build and
// the binary format the worker expects. Cached under anything else, it is 32 MB
// of ballast and the app re-downloads its own copy.
const graphUrl = await page.evaluate(() => self.GRAPH_URL);
check('the routing graph is cached under the URL the app actually requests',
  cached.some((u) => u.endsWith(graphUrl.replace(/^data/, '/data'))),
  `app wants ${graphUrl}, cache holds ${cached.filter((u) => u.includes('graph2')).join(' ') || 'no graph'}`);
check('one copy of the graph, not two',
  cached.filter((u) => u.includes('graph2.bin.gz')).length === 1,
  `${cached.filter((u) => u.includes('graph2.bin.gz')).length} copies`);
for (const archive of ['/maps/washington/basemap.pmtiles', '/maps/washington/roads.pmtiles']) {
  check(`${archive} is stored for offline use`, cached.includes(archive));
}

// maps/states.js lives under /maps/ but is a SHELL script, not data -- it is
// the generated index region.js reads to know which states exist. The fetch
// handler matched "/maps/" and sent it to the data cache, where it had never
// been stored, so an offline reload could not find it and the app never got as
// far as running app.js: a blank page, from one over-broad prefix.
const shellCached = await page.evaluate(async () => {
  const name = (await caches.keys()).find((key) => key.startsWith('shell-'));
  return (await (await caches.open(name)).keys()).map((request) =>
    new URL(request.url).pathname);
});
check('the generated state index is cached with the shell, not with the data',
  shellCached.some((path) => path.endsWith('/maps/states.js'))
    && !cached.some((path) => path.endsWith('/maps/states.js')),
  `shell ${shellCached.filter((p) => p.includes('states.js'))}, `
  + `data ${cached.filter((p) => p.includes('states.js'))}`);

/* ------------------------------------------------------- pull the plug */
site.goOffline();
await page.reload({ waitUntil: 'load' });
const mapLoaded = await page
  .waitForFunction(() => window.map && map.loaded && map.loaded(), { timeout: 180000 })
  .then(() => true).catch(() => false);
check('the app starts with no network', mapLoaded);

await page.evaluate(([centre]) => {
  document.body.classList.remove('panel-open');
  map.jumpTo({ center: centre, zoom: 13 });
}, [SEATTLE]);
await page.evaluate(() => Promise.race([
  new Promise((resolve) => map.once('idle', resolve)),
  new Promise((resolve) => setTimeout(resolve, 30000)),
]));

// Vector tiles come out of the stored PMTiles archive through the worker. If
// that path breaks the map renders as blank ocean, which no smoke test that
// only checks for a canvas would notice.
const drawn = await page.evaluate(() => ({
  roads: map.querySourceFeatures('basemap-roads', { sourceLayer: 'roads' }).length,
  rendered: map.queryRenderedFeatures().length,
}));
check('the basemap draws offline from the stored archive', drawn.roads > 500,
  `${drawn.roads} road features, ${drawn.rendered} rendered`);

const routed = await page.evaluate(async ([from, to]) => {
  // A blank planner deliberately keeps the large graph unloaded. Requesting
  // an actual route must start it from the offline cache and then honor this
  // pending calculation as soon as the worker becomes ready.
  routing.start = from;
  routing.end = to;
  computeRoute();
  await new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      if (routing.options?.length) { clearInterval(poll); resolve(); }
    }, 200);
    setTimeout(() => { clearInterval(poll); reject(new Error('no route came back')); }, 180000);
  });
  return { routes: routing.options.length, distM: Math.round(routing.last?.distM || 0) };
}, [SEATTLE, BELLEVUE]).catch((error) => ({ error: error.message }));
check('a route computes offline from the stored graph',
  !routed.error && routed.routes > 0 && routed.distM > 1000,
  routed.error || `${routed.routes} routes, ${routed.distM} m`);

// A rider who installed the app and then lost signal should not be looking at
// an error. Requests that legitimately need the network (the update check) are
// expected to fail; the map and the router are not.
check('no page errors while offline', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
site.close();
console.log(`\n${pass} checks passed`);
