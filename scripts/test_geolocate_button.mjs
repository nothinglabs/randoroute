#!/usr/bin/env node
// Photographed mid-ride, 3.4 miles in: '"localhost" would like to use your
// current location.' The native plugin had been tracking the rider the whole
// way; the prompt came from a second location source entirely.
//
// MapLibre's geolocate control calls navigator.geolocation, which on the native
// app is a different permission from the plugin's and a second GPS watcher for
// a fix the app already has. app.js captures the click before the control sees
// it -- but only in two of the three states it can be tapped in. The third,
// navigating with the camera already following, is the ordinary state of the
// screen, so the likeliest tap was the one that got through.
//
// What this pins is narrow and checkable: while navigating, that button must
// never reach navigator.geolocation, whatever the camera is doing.
import { appPage, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();

// A native first launch must not even construct MapLibre's browser-location
// client. On WKWebView its permission probe can raise the system sheet before
// a rider touches anything, independently of our explicit getStatus guard.
const nativeStartupContext = await browser.newContext({
  serviceWorkers: 'block',
  viewport: { width: 430, height: 900 },
  hasTouch: true,
  isMobile: true,
});
await nativeStartupContext.addInitScript(() => {
  window.__permissionQueries = 0;
  window.__voiceQueries = 0;
  const originalQuery = navigator.permissions?.query?.bind(navigator.permissions);
  if (originalQuery) {
    navigator.permissions.query = (...args) => {
      window.__permissionQueries++;
      return originalQuery(...args);
    };
  }
  const originalGetVoices = window.speechSynthesis?.getVoices?.bind(window.speechSynthesis);
  if (originalGetVoices) {
    window.speechSynthesis.getVoices = (...args) => {
      window.__voiceQueries++;
      return originalGetVoices(...args);
    };
  }
  window.Capacitor = {
    Plugins: {
      NativeNavigation: {
        getStatus: () => Promise.resolve({ servicesEnabled: true, authorization: 'prompt' }),
      },
    },
    isNativePlatform: () => true,
  };
});
const nativeStartupPage = await nativeStartupContext.newPage();
await nativeStartupPage.goto(site.url, { waitUntil: 'load' });
await nativeStartupPage.waitForFunction(() => window.map?.loaded?.(), { timeout: 30000 }).catch(() => {});
const nativeStartup = await nativeStartupPage.evaluate(() => ({
  customControl: Boolean(document.querySelector('[data-native-location-control="true"]')),
  permissionQueries: window.__permissionQueries,
  voiceQueries: window.__voiceQueries,
}));
await nativeStartupContext.close();

const page = await appPage(browser, site.port);

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};

check('the native shell uses a location button without a browser permission probe',
  nativeStartup.customControl && nativeStartup.permissionQueries === 0,
  JSON.stringify(nativeStartup));
check('a map-only native launch does not initialize the unused browser voice engine',
  nativeStartup.voiceQueries === 0, JSON.stringify(nativeStartup));

// Count every reach for the web location API, and stand in for the native
// plugin so both runtimes can be driven from one browser.
await page.evaluate(() => {
  window.__webLocationCalls = 0;
  const count = () => { window.__webLocationCalls++; };
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
    getCurrentPosition(ok) { count(); ok?.({ coords: { longitude: -122.33, latitude: 47.6, accuracy: 5 }, timestamp: Date.now() }); },
    watchPosition(ok) { count(); ok?.({ coords: { longitude: -122.33, latitude: 47.6, accuracy: 5 }, timestamp: Date.now() }); return 1; },
    clearWatch() {},
  } });
  window.__nativePlugin = null;
  window.nativeNavigationPlugin = () => window.__nativePlugin;
});

/* ----------------------- first install asks only when location is requested */
const initialPermission = await page.evaluate(async () => {
  window.__initialLocationCalls = 0;
  window.__nativePlugin = {
    getStatus: () => Promise.resolve({ servicesEnabled: true, authorization: 'prompt' }),
    getCurrentPosition: () => {
      window.__initialLocationCalls++;
      return Promise.resolve({ latitude: 47.6, longitude: -122.33, accuracy: 5,
        timestamp: Date.now() });
    },
  };
  const promptResult = await requestInitialMapLocation();
  const whilePrompt = window.__initialLocationCalls;
  // The page was originally loaded as an ordinary browser, whose automatic
  // geolocation request can still be pending. This scenario is switching the
  // runtime stub in-place, so clear that unrelated browser promise first.
  mapLocationRequest = null;
  window.__nativePlugin.getStatus = () => Promise.resolve({
    servicesEnabled: true,
    authorization: 'whileUsing',
  });
  const grantedResult = await requestInitialMapLocation();
  // The native bridge resolves asynchronously. Under software GL and a cold
  // PMTiles cache it can take longer than one arbitrary 50 ms turn; wait for
  // the observable request instead of testing the scheduler's luck.
  await new Promise((resolve) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (window.__initialLocationCalls > 0 || Date.now() >= deadline) resolve();
      else setTimeout(poll, 25);
    };
    poll();
  });
  const afterGrant = window.__initialLocationCalls;
  window.__nativePlugin = null;
  return { promptResult, whilePrompt, grantedResult, afterGrant };
});
check('a first native launch does not trigger the location permission sheet',
  initialPermission.promptResult === false && initialPermission.whilePrompt === 0,
  JSON.stringify(initialPermission));
check('a returning rider with permission is still centered automatically',
  initialPermission.grantedResult === true && initialPermission.afterGrant === 1,
  JSON.stringify(initialPermission));

const tapLocate = () => page.evaluate(() => {
  window.__webLocationCalls = 0;
  const button = document.querySelector('.maplibregl-ctrl-geolocate');
  if (!button) return { missing: true };
  button.click();
  return { missing: false };
});

const asNavigating = (following) => page.evaluate((follow) => {
  turnNav.active = true;
  turnNav.arrived = false;
  turnNav.cameraFollow = follow;
  turnNav.lastPosition = [-122.33, 47.6];
  turnNav.followResumeTimer = 0;
}, following);

/* ------------------------------ navigating, camera already on the rider */
// The state the screen is in for almost the whole ride, and the one that used
// to fall through to MapLibre.
await asNavigating(true);
const following = await tapLocate();
await page.waitForTimeout(300);
const afterFollowing = await page.evaluate(() => ({
  calls: window.__webLocationCalls, follows: turnNav.cameraFollow,
}));
check('the locate button is present', following.missing === false);
check('tapping it while navigating never reaches the web location API',
  afterFollowing.calls === 0, JSON.stringify(afterFollowing));
check('and it leaves the camera following the rider', afterFollowing.follows === true,
  JSON.stringify(afterFollowing));

/* ----------------------------------- navigating, panned away from the rider */
await asNavigating(false);
await tapLocate();
await page.waitForTimeout(300);
const afterPanned = await page.evaluate(() => ({
  calls: window.__webLocationCalls, follows: turnNav.cameraFollow,
}));
check('panned away, it still does not reach the web location API',
  afterPanned.calls === 0, JSON.stringify(afterPanned));
check('and it puts the rider back in the middle', afterPanned.follows === true,
  JSON.stringify(afterPanned));

/* --------------------------------- the native app, not navigating */
await page.evaluate(() => {
  turnNav.active = false;
  window.__pluginAsked = 0;
  window.__pluginLocationOptions = null;
  window.__nativePlugin = {
    getCurrentPosition(options) {
      window.__pluginAsked++;
      window.__pluginLocationOptions = options;
      return Promise.resolve({ latitude: 47.6, longitude: -122.33, accuracy: 5,
        timestamp: Date.now() });
    },
  };
});
await tapLocate();
await page.waitForTimeout(400);
const nativeIdle = await page.evaluate(() => ({
  calls: window.__webLocationCalls, asked: window.__pluginAsked,
  options: window.__pluginLocationOptions,
}));
check('on the native app the button asks the plugin, not the web API',
  nativeIdle.calls === 0 && nativeIdle.asked === 1, JSON.stringify(nativeIdle));
check('the native request receives the same finite timeout as web geolocation',
  nativeIdle.options?.timeoutMs === 15000, JSON.stringify(nativeIdle));

/* ------------------------------------- and the ordinary web app is untouched */
await page.evaluate(() => { window.__nativePlugin = null; turnNav.active = false; });
await tapLocate();
await page.waitForTimeout(300);
const webIdle = await page.evaluate(() => window.__webLocationCalls);
check('in a browser, not navigating, the control keeps its own behaviour',
  webIdle > 0, String(webIdle));

check('no page errors', page.pageErrors.length === 0, page.pageErrors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
