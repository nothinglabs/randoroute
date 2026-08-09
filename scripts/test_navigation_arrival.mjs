#!/usr/bin/env node
// Arriving ends the ride -- including when the NATIVE guide is the one that
// noticed.
//
// With the screen locked this layer is suspended and never sees the fixes that
// would let it detect arrival, so BridgeViewController decides for itself and
// speaks. It used to do only that: set a flag, say one sentence, and stop
// nothing. The rider heard "you have arrived" and then went on being given
// directions. Two definitions of "the ride is over", and only one of them
// ended the ride.
//
// The Swift half needs a Mac. This is the half that does not: the plugin's
// `arrived` event has to tear navigation down here too.
import { appPage, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};

// A stand-in plugin that keeps the handlers it is given, so the test can fire
// the event the native guide would fire.
const armed = await page.evaluate(async () => {
  window.__handlers = {};
  window.__stopCalls = 0;
  window.nativeNavigationPlugin = () => ({
    startTracking: () => Promise.resolve({ accuracy: 'full' }),
    stopTracking: () => { window.__stopCalls++; return Promise.resolve(); },
    updateVoiceSettings: () => Promise.resolve(),
    speak: () => Promise.resolve(),
    stopSpeaking: () => Promise.resolve(),
    addListener: (name, fn) => {
      window.__handlers[name] = fn;
      return Promise.resolve({ remove() {} });
    },
  });
  // The registration is cached after the first ride; clear it so this stub is
  // the one that gets the handlers.
  nativeNavigationListenersReady = null;
  await ensureNativeNavigationListeners();
  return Object.keys(window.__handlers).sort();
});
check('the app subscribes to the native arrival event',
  armed.includes('arrived'), JSON.stringify(armed));

// A ride in progress, then the native guide reports arrival.
const ended = await page.evaluate(() => {
  turnNav.active = true;
  turnNav.arrived = false;
  turnNav.route = { coords: [[-122.3, 47.6], [-122.31, 47.61]], cumulative: [0, 1000],
    totalM: 1000, instructions: [] };
  turnNav.plannedRoute = turnNav.route;
  const before = window.__stopCalls;
  window.__handlers.arrived();
  return {
    active: turnNav.active,
    arrived: turnNav.arrived,
    route: turnNav.route,
    stoppedNative: window.__stopCalls > before,
  };
});
check('a native arrival ends navigation here too', ended.active === false,
  JSON.stringify(ended));
check('and records that the rider arrived rather than merely stopping',
  ended.arrived === true, JSON.stringify(ended));
check('and drops the route it was following', ended.route === null,
  JSON.stringify(ended));
check('and tells the plugin to stop tracking', ended.stoppedNative === true,
  JSON.stringify(ended));

// The web layer can also notice arrival by itself on an unlocked ride, and
// both notices may land. The second must not undo the first or re-announce.
const again = await page.evaluate(() => {
  const spoken = [];
  const realSpeak = window.speakNavigation;
  window.speakNavigation = (text) => { spoken.push(text); };
  window.__handlers.arrived();
  finishTurnNavigation();
  window.speakNavigation = realSpeak;
  return { active: turnNav.active, arrived: turnNav.arrived, spoken };
});
check('a second arrival notice is a no-op', again.active === false
  && again.arrived === true && again.spoken.length === 0, JSON.stringify(again));

const cancelledBeforeJoining = await page.evaluate(() => {
  turnNav.active = true;
  turnNav.plannedRoute = { coords: [[-122.3, 47.6], [-122.31, 47.61]],
    cumulative: [0, 1000], totalM: 1000, instructions: [] };
  turnNav.route = turnNav.plannedRoute;
  showRouteStartOffer(850);
  return {
    dialogOpen: document.getElementById('routeStartDialog').open,
    title: document.getElementById('routeStartDialogTitle').textContent,
    detail: document.getElementById('routeStartDialogText').textContent,
    cancelVisible: !document.getElementById('navCancelStartBtn').hidden,
    cancelCopy: document.getElementById('navCancelStartBtn').textContent,
  };
});
check('the not-on-route distance is the dialog headline',
  cancelledBeforeJoining.title === "You're 0.5 miles from your planned route"
    && cancelledBeforeJoining.detail === 'Choose how to get onto it.',
  JSON.stringify(cancelledBeforeJoining));
check('the not-on-route offer includes an explicit Cancel navigation action',
  cancelledBeforeJoining.dialogOpen && cancelledBeforeJoining.cancelVisible
    && /cancel navigation/i.test(cancelledBeforeJoining.cancelCopy),
  JSON.stringify(cancelledBeforeJoining));
await page.locator('#navCancelStartBtn').click();
check('Cancel navigation exits the accidental ride and closes the offer', await page.evaluate(() =>
  !turnNav.active && !document.getElementById('routeStartDialog').open));

const offRouteCopy = await page.evaluate(() => {
  turnNav.active = true;
  turnNav.offRoute = true;
  turnNav.offRouteInfo = { distM: 7563.9, dir: 'northwest', street: 'Interurban Trail' };
  openOffRouteDialog();
  return {
    title: document.getElementById('offRouteDialogTitle').textContent,
    detail: document.getElementById('offRouteDialogText').textContent,
    oneMileTitle: plannedRouteDistanceTitle(1609.34),
  };
});
check('the off-route distance is the dialog headline',
  offRouteCopy.title === "You're 4.7 miles from your planned route"
    && offRouteCopy.detail.includes('northwest on Interurban Trail')
    && !offRouteCopy.detail.includes('4.7 miles'),
  JSON.stringify(offRouteCopy));
check('a one-mile route distance uses singular grammar',
  offRouteCopy.oneMileTitle === "You're 1 mile from your planned route",
  offRouteCopy.oneMileTitle);

check('no page errors', page.pageErrors.length === 0, page.pageErrors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
