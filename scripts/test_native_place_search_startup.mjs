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
  startHidden: document.querySelector('.route-endpoint-start-row')?.hidden,
  destinationVisible: !document.querySelector('.route-endpoint-end-row')?.hidden,
  emptyMessage: document.querySelector('.rc-route-message strong')?.textContent,
}));
check('an untouched native planner does not start the routing graph', state.workers === 0,
  JSON.stringify(state));
check('the untouched planner asks for Destination before showing Start',
  state.startHidden && state.destinationVisible && state.emptyMessage === 'Choose a destination',
  JSON.stringify(state));
check('the native full-screen canvas ignores browser keyboard viewport sizing',
  state.appHeight === '', JSON.stringify(state));

await page.click('#rb-search');
state = await page.evaluate(() => ({
  placeholder: document.getElementById('placeSearch').placeholder,
  mapChoice: document.getElementById('pickOnMap').textContent.trim(),
  useLocationHidden: document.getElementById('useLoc').hidden,
  toolbarZ: Number(getComputedStyle(document.getElementById('topToolbar')).zIndex),
  mapControlsZ: Number(getComputedStyle(document.querySelector('.maplibregl-ctrl-top-right')).zIndex),
}));
check('generic search uses simple place language and offers the map instead of device location',
  state.placeholder === 'Search places…' && state.mapChoice.includes('Tap the map instead')
    && state.useLocationHidden, JSON.stringify(state));
check('the open search panel stacks above every map control',
  state.toolbarZ > state.mapControlsZ, JSON.stringify(state));
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
    && state.actions.join('|') === 'End', JSON.stringify(state));
await page.click('#readout .readout-close');

await page.evaluate(() => { getFreshDevicePosition = () => new Promise(() => {}); });
await page.click('#rb-end');
state = await page.evaluate(() => ({
  useLocationHidden: document.getElementById('useLoc').hidden,
  mapChoiceVisible: !document.getElementById('pickOnMap').hidden,
}));
check('Destination search never offers current location and clearly offers a map tap',
  state.useLocationHidden && state.mapChoiceVisible, JSON.stringify(state));
await page.click('#pickOnMap');
state = await page.evaluate(() => ({
  pickerHidden: document.getElementById('placePicker').hidden,
  armed: routing.arm,
  status: document.getElementById('rb-status').textContent,
}));
check('Tap the map instead arms Destination and closes search',
  state.pickerHidden && state.armed === 'end' && /tap the map.*destination/i.test(state.status),
  JSON.stringify(state));
await page.evaluate(() => { routing.arm = null; updateArmButtons(); });
await page.click('#rb-end');
await page.fill('#placeSearch', 'Port Townsend');
await page.waitForSelector('#placeResults .place-hit:not(.place-internet-search)');
state = await page.evaluate(() => ({ workers: window.__routingWorkerStarts.length,
  results: document.querySelectorAll('#placeResults .place-hit:not(.place-internet-search)').length }));
check('Destination-triggered search also stays responsive',
  state.workers === 0 && state.results > 0, JSON.stringify(state));
await page.click('#placeResults .place-hit:not(.place-internet-search)');
state = await page.evaluate(() => ({
  workers: window.__routingWorkerStarts.length,
  start: Boolean(routing.start), end: Boolean(routing.end),
  startHidden: document.querySelector('.route-endpoint-start-row')?.hidden,
  startLabel: document.querySelector('#rb-start [data-endpoint-value]')?.textContent,
  pickerHidden: document.getElementById('placePicker').hidden,
  promptShown: document.getElementById('readout').classList.contains('show'),
  indicator: document.querySelectorAll('.search-result-marker').length,
}));
check('choosing a targeted Destination assigns it directly and reveals Current location',
  state.workers === 0 && !state.start && state.end && !state.startHidden
    && state.startLabel === 'Current location' && state.pickerHidden
    && !state.promptShown && state.indicator === 0, JSON.stringify(state));

await page.click('#rb-start');
check('current location is available when explicitly choosing Start',
  await page.evaluate(() => !document.getElementById('useLoc').hidden));
await page.fill('#placeSearch', 'Seattle');
await page.waitForSelector('#placeResults .place-hit:not(.place-internet-search)');
await page.click('#placeResults .place-hit:not(.place-internet-search)');
await page.waitForFunction(() => window.__routingWorkerStarts.length > 0, null, { timeout: 30000 });
state = await page.evaluate(() => ({
  workers: window.__routingWorkerStarts.length,
  pickerHidden: document.getElementById('placePicker').hidden,
  start: Boolean(routing.start), end: Boolean(routing.end),
  promptShown: document.getElementById('readout').classList.contains('show'),
}));
check('targeted Start assigns directly and routing begins after both endpoints exist',
  state.workers === 1 && state.pickerHidden && state.start && state.end && !state.promptShown,
  JSON.stringify(state));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
