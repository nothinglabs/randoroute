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
  panelOpen: document.body.classList.contains('panel-open'),
}));
check('an untouched native planner does not start the routing graph', state.workers === 0,
  JSON.stringify(state));
check('the untouched planner shows both endpoints and asks for both',
  !state.startHidden && state.destinationVisible
    && state.emptyMessage === 'Choose start and destination',
  JSON.stringify(state));
check('the phone menu starts closed', !state.panelOpen, JSON.stringify(state));
check('the native full-screen canvas ignores browser keyboard viewport sizing',
  state.appHeight === '', JSON.stringify(state));

await page.click('#panelOpen');
await page.waitForFunction(() => document.querySelector('.route-endpoints')
  ?.classList.contains('route-guidance-flash'));
state = await page.evaluate(() => ({
  endpointCue: document.querySelector('.route-endpoints')?.classList
    .contains('route-guidance-flash'),
  messageCue: document.querySelector('#routeCard .rc-route-message')?.classList
    .contains('route-guidance-flash'),
  message: document.querySelector('#routeCard .rc-route-message strong')?.textContent,
}));
check('opening the empty Route menu links its instruction to the endpoint chooser',
  state.endpointCue && state.messageCue && state.message === 'Choose start and destination',
  JSON.stringify(state));
await page.click('#panelClose');

await page.click('#rb-search');
state = await page.evaluate(() => ({
  placeholder: document.getElementById('placeSearch').placeholder,
  title: document.getElementById('placePickerTitle').textContent,
  focused: document.activeElement?.id,
  mapChoiceGone: !document.getElementById('pickOnMap'),
  hint: document.getElementById('placePickerHint').textContent,
  useLocationHidden: document.getElementById('useLoc').hidden,
  pickerAnimation: getComputedStyle(document.getElementById('placePicker')).animationName,
  toolbarZ: Number(getComputedStyle(document.getElementById('topToolbar')).zIndex),
  mapControlsZ: Number(getComputedStyle(document.querySelector('.maplibregl-ctrl-top-right')).zIndex),
}));
check('generic search tells riders to tap the map without adding a map button',
  state.placeholder === 'Search the map…' && state.title === 'Find a place'
    && state.mapChoiceGone && /search or tap the map/i.test(state.hint)
    && /trip will not change yet/i.test(state.hint) && state.useLocationHidden
    && state.focused !== 'placeSearch' && state.pickerAnimation === 'place-picker-enter',
  JSON.stringify(state));
check('the open search panel stacks above every map control',
  state.toolbarZ > state.mapControlsZ, JSON.stringify(state));
await page.evaluate(() => inspectRoadAt({ x: 190, y: 410 }, { lng: -122.33, lat: 47.61 }));
state = await page.evaluate(() => ({
  pickerHidden: document.getElementById('placePicker').hidden,
  readoutShown: document.getElementById('readout').classList.contains('show'),
  actions: [...document.querySelectorAll('#readout .readout-route-actions button')]
    .map((button) => button.textContent),
}));
check('tapping the map during generic search closes search and shows the normal route choice',
  state.pickerHidden && state.readoutShown && state.actions.join('|') === 'Route here|Start here',
  JSON.stringify(state));
await page.click('#readout .readout-close');
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
    && state.actions.join('|') === 'Route here|Start here', JSON.stringify(state));
await page.click('#readout .readout-close');

await page.evaluate(() => { getFreshDevicePosition = () => new Promise(() => {}); });
await page.click('#rb-end');
state = await page.evaluate(() => ({
  useLocationHidden: document.getElementById('useLoc').hidden,
  mapChoiceGone: !document.getElementById('pickOnMap'),
  pickerVisible: !document.getElementById('placePicker').hidden,
  armed: routing.arm,
  hint: document.getElementById('placePickerHint').textContent,
}));
check('Destination search arms the visible map and never offers current location',
  state.useLocationHidden && state.mapChoiceGone && state.pickerVisible
    && state.armed === 'end' && /tap the map to set your destination/i.test(state.hint),
  JSON.stringify(state));
await page.evaluate(() => placeArmedPoint({ lng: -122.76, lat: 48.12 }));
state = await page.evaluate(() => ({
  pickerHidden: document.getElementById('placePicker').hidden,
  armed: routing.arm,
  end: routing.end,
  endName: routing.endName,
}));
check('tapping the map during Destination search sets it directly and closes search',
  state.pickerHidden && state.armed === null && state.endName === 'Point on map'
    && state.end[0] === -122.76 && state.end[1] === 48.12,
  JSON.stringify(state));
await page.evaluate(() => clearRoute());
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
check('choosing a targeted Destination assigns it directly and defaults Start to Current location',
  state.workers === 0 && !state.start && state.end && !state.startHidden
    && state.startLabel === 'Current location' && state.pickerHidden
    && !state.promptShown && state.indicator === 0, JSON.stringify(state));

await page.click('#rb-start');
state = await page.evaluate(() => ({
  available: !document.getElementById('useLoc').hidden,
  inHeader: document.getElementById('useLoc').parentElement?.classList
    .contains('picker-head-actions'),
  beforeResults: Boolean(document.getElementById('placeSearch')
    .compareDocumentPosition(document.getElementById('placeResults'))
    & Node.DOCUMENT_POSITION_FOLLOWING),
}));
check('Start keeps current location compact in the header and results below search',
  state.available && state.inHeader && state.beforeResults, JSON.stringify(state));
await page.evaluate(() => {
  getFreshDevicePosition = () => Promise.reject(new Error('GPS unavailable'));
});
await page.click('#useLoc');
await page.waitForFunction(() => document.getElementById('placePickerHint')
  ?.classList.contains('location-error'));
state = await page.evaluate(() => ({
  pickerVisible: !document.getElementById('placePicker').hidden,
  hint: document.getElementById('placePickerHint').textContent,
  buttonReady: !document.getElementById('useLoc').disabled,
}));
check('an explicit Current location failure is explained inside the open picker',
  state.pickerVisible && state.buttonReady && /couldn’t get your location/i.test(state.hint)
    && /search or tap the map/i.test(state.hint), JSON.stringify(state));
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

// A blank Safari/Web visit used to eagerly retain the expanded route graph,
// leaving too little headroom for MapLibre when a rider zoomed out. Web now
// follows the same request-driven startup as native, and the map stops at a
// useful statewide view instead of accepting continent-scale zooms.
const webContext = await browser.newContext({
  serviceWorkers: 'block', viewport: { width: 390, height: 844 },
  hasTouch: true, isMobile: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) '
    + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
});
await webContext.addInitScript(() => {
  window.__routingWorkerStarts = [];
  const PlatformWorker = window.Worker;
  window.Worker = function RecordingWorker(...args) {
    if (/router-worker\.js(?:$|\?)/.test(String(args[0] || ''))) {
      window.__routingWorkerStarts.push(performance.now());
    }
    return new PlatformWorker(...args);
  };
  window.Worker.prototype = PlatformWorker.prototype;
});
const webPage = await webContext.newPage();
const webErrors = [];
webPage.on('pageerror', (error) => webErrors.push(error.message));
await webPage.goto(site.url, { waitUntil: 'load' });
await webPage.waitForFunction(() => document.documentElement.classList.contains('app-ready'),
  null, { timeout: 120000 });
await webPage.waitForTimeout(2200);
const webIdle = await webPage.evaluate(() => {
  map.jumpTo({ zoom: 1 });
  return {
    workers: window.__routingWorkerStarts.length,
    minZoom: map.getMinZoom(),
    zoom: map.getZoom(),
    panelOpen: document.body.classList.contains('panel-open'),
    menuVisible: getComputedStyle(document.getElementById('panelOpen')).display !== 'none',
  };
});
check('a blank web planner keeps the large route graph unloaded', webIdle.workers === 0,
  JSON.stringify(webIdle));
check('web zoom-out is clamped to the useful statewide range',
  webIdle.minZoom === 5 && webIdle.zoom >= 5, JSON.stringify(webIdle));
check('the web phone menu also starts closed',
  !webIdle.panelOpen && webIdle.menuVisible, JSON.stringify(webIdle));
check('the web zoom guard produces no page errors', webErrors.length === 0,
  webErrors.join(' | '));
await webContext.close();

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
