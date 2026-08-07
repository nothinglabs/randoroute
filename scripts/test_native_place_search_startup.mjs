#!/usr/bin/env node
// Opening the first From/To search on a fresh iPhone must not start the 44 MB
// routing graph. Its fetch/inflate/index work competes with iOS's first keyboard
// animation and makes the phone look frozen. Native search stays lightweight;
// the router starts only after the rider has actually chosen both endpoints.
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

await page.click('#rb-start');
await page.fill('#placeSearch', 'Seattle');
await page.waitForSelector('#placeResults .place-hit');
state = await page.evaluate(() => ({ workers: window.__routingWorkerStarts.length,
  results: document.querySelectorAll('#placeResults .place-hit').length }));
check('the first From search returns local places without starting the router',
  state.workers === 0 && state.results > 0, JSON.stringify(state));
await page.click('#placeResults .place-hit');

await page.click('#rb-end');
await page.fill('#placeSearch', 'Port Townsend');
await page.waitForSelector('#placeResults .place-hit');
state = await page.evaluate(() => ({ workers: window.__routingWorkerStarts.length,
  results: document.querySelectorAll('#placeResults .place-hit').length }));
check('the first To search also stays responsive',
  state.workers === 0 && state.results > 0, JSON.stringify(state));
await page.click('#placeResults .place-hit');
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
