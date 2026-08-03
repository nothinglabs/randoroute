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
const page = await appPage(browser, site.port);

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};

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
  window.__nativePlugin = {
    getCurrentPosition() {
      window.__pluginAsked++;
      return Promise.resolve({ latitude: 47.6, longitude: -122.33, accuracy: 5,
        timestamp: Date.now() });
    },
  };
});
await tapLocate();
await page.waitForTimeout(400);
const nativeIdle = await page.evaluate(() => ({
  calls: window.__webLocationCalls, asked: window.__pluginAsked,
}));
check('on the native app the button asks the plugin, not the web API',
  nativeIdle.calls === 0 && nativeIdle.asked === 1, JSON.stringify(nativeIdle));

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
