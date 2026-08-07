#!/usr/bin/env node
// Opening the first generic map search on a fresh iPhone must not start the 44 MB
// routing graph. Its fetch/inflate/index work competes with iOS's first keyboard
// animation and makes the phone look frozen. Search and map preview stay
// lightweight; the router starts only after both endpoint roles are assigned.
import { chromiumPath, playwright, serveRepo } from './testlib/harness.mjs';

const { chromium } = await playwright();
const site = await serveRepo();
const browser = await chromium.launch({
  executablePath: chromiumPath(), args: ['--use-gl=swiftshader'],
});
const context = await browser.newContext({
  serviceWorkers: 'block', viewport: { width: 390, height: 844 },
  hasTouch: true, isMobile: true,
});
await context.addInitScript(() => {
  window.__routingWorkerStarts = [];
  const PlatformWorker = window.Worker;
  window.Worker = function RecordingWorker(...args) {
    if (/router-worker\.js(?:$|\?)/.test(String(args[0] || ''))) {
      window.__routingWorkerStarts.push(performance.now());
    }
    return new PlatformWorker(...args);
  };
  window.Worker.prototype = PlatformWorker.prototype;
  window.Capacitor = {
    isNativePlatform: () => true,
    Plugins: { NativeNavigation: {
      getStatus: () => Promise.resolve({ servicesEnabled: true, authorization: 'prompt' }),
    } },
  };
});
const page = await context.newPage();
await page.goto(site.url, { waitUntil: 'load' });
await page.waitForFunction(() => document.documentElement.classList.contains('app-ready'),
  null, { timeout: 120000 });

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};

// Cross the old 1.5 s fallback that initialized the router even when the map
// never reached idle.
await page.waitForTimeout(2200);
let state = await page.evaluate(() => ({
  workers: window.__routingWorkerStarts.length,
  appHeight: document.documentElement.style.getPropertyValue('--app-height'),
}));
check('an untouched native planner does not start the routing graph', state.workers === 0,
  JSON.stringify(state));
check('the native full-screen canvas ignores browser keyboard viewport sizing',
  state.appHeight === '', JSON.stringify(state));

await page.click('#rb-search');
await page.fill('#placeSearch', 'Seattle');
await page.waitForSelector('#placeResults .place-hit:not(.place-internet-search)');
state = await page.evaluate(() => ({ workers: window.__routingWorkerStarts.length,
  results: document.querySelectorAll('#placeResults .place-hit:not(.place-internet-search)').length,
  internetLast: document.querySelector('#placeResults .place-hit:last-child')?.classList.contains('place-internet-search') }));
check('the first map search returns local places without starting the router',
  state.workers === 0 && state.results > 0, JSON.stringify(state));
check('internet search is offered as the final search item instead of a Net button',
  state.internetLast && !await page.$('#onlinePlaceSearch'), JSON.stringify(state));
await page.click('#placeResults .place-hit:not(.place-internet-search)');
await page.waitForSelector('#readout.show');
state = await page.evaluate(() => ({
  workers: window.__routingWorkerStarts.length,
  start: Boolean(routing.start), end: Boolean(routing.end),
  indicator: document.querySelectorAll('.search-result-marker').length,
  actions: [...document.querySelectorAll('#readout .readout-route-actions button')]
    .map((button) => button.textContent),
}));
check('choosing a result previews it on the map without assigning a route role',
  state.workers === 0 && !state.start && !state.end && state.indicator === 1
    && state.actions.join('|') === 'Start|End', JSON.stringify(state));
await page.click('#readout .map-point-start');

await page.click('#rb-search');
await page.fill('#placeSearch', 'Port Townsend');
await page.waitForSelector('#placeResults .place-hit:not(.place-internet-search)');
state = await page.evaluate(() => ({ workers: window.__routingWorkerStarts.length,
  results: document.querySelectorAll('#placeResults .place-hit:not(.place-internet-search)').length }));
check('the second map search also stays responsive',
  state.workers === 0 && state.results > 0, JSON.stringify(state));
await page.click('#placeResults .place-hit:not(.place-internet-search)');
await page.waitForSelector('#readout.show');
await page.click('#readout .map-point-end');
await page.waitForFunction(() => window.__routingWorkerStarts.length > 0, null, { timeout: 30000 });
state = await page.evaluate(() => ({
  workers: window.__routingWorkerStarts.length,
  pickerHidden: document.getElementById('placePicker').hidden,
  start: Boolean(routing.start), end: Boolean(routing.end),
}));
check('routing starts after both endpoints are chosen and the picker has closed',
  state.workers === 1 && state.pickerHidden && state.start && state.end, JSON.stringify(state));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
