#!/usr/bin/env node
// Keeping the screen on is a battery decision, so it is the rider's.
//
// It is also the one place the app was asserting something it had not checked.
// `startNativeNavigationTracking()` set `screenMaySleep = false` -- "the screen
// is fine" -- because native LOCATION tracking had started, which is a different
// fact, and it raced the wake lock, which sets the same flag from evidence. On
// iOS that suppressed the warning whether or not anything had kept the screen
// awake, and there is no `isIdleTimerDisabled` anywhere in ios/ to fall back on.
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

// A stand-in for the platform lock, so both the request and the release are
// observable and a refusal can be simulated.
await page.evaluate(() => {
  window.__locks = { requested: 0, released: 0, refuse: false };
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: {
    request() {
      if (window.__locks.refuse) return Promise.reject(new Error('NotAllowedError'));
      window.__locks.requested++;
      return Promise.resolve({
        release() { window.__locks.released++; return Promise.resolve(); },
        addEventListener() {},
      });
    },
  } });
});

const ride = () => page.evaluate(async () => {
  window.__locks.requested = 0;
  window.__locks.released = 0;
  turnNav.active = true;
  await requestNavigationWakeLock();
  return { requested: window.__locks.requested, maySleep: turnNav.screenMaySleep };
});

/* ------------------------------------------------- on by default, and it works */
const on = await ride();
check('a ride holds the screen awake by default', on.requested === 1, JSON.stringify(on));
check('and does not warn that the screen may sleep', on.maySleep === false, JSON.stringify(on));

/* -------------------------------------------------- the rider can turn it off */
const off = await page.evaluate(async () => {
  const box = document.getElementById('v-keepScreenAwake');
  if (!box) return { missing: true };
  box.checked = false;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  window.__locks.requested = 0;
  await requestNavigationWakeLock();
  return {
    setting: navVoice.keepScreenAwake,
    requested: window.__locks.requested,
    released: window.__locks.released,
    // Asked for, so not a problem to warn about.
    maySleep: turnNav.screenMaySleep,
  };
});
check('the setting has a control', off.missing !== true, JSON.stringify(off));
check('switching it off releases the lock and stops asking for one',
  off.setting === false && off.requested === 0 && off.released >= 1, JSON.stringify(off));
check('and does not warn about a screen the rider chose to let sleep',
  off.maySleep === false, JSON.stringify(off));

/* ------------------------------------------ a refusal is reported, not hidden */
const refused = await page.evaluate(async () => {
  const box = document.getElementById('v-keepScreenAwake');
  box.checked = true;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  window.__locks.refuse = true;
  turnNav.locationReady = true;
  await requestNavigationWakeLock();
  return { maySleep: turnNav.screenMaySleep, message: turnNav.message };
});
check('a refused lock says the screen may sleep', refused.maySleep === true,
  JSON.stringify(refused));
check('and says it about the device, not "this browser"',
  /screen may sleep on this device/i.test(refused.message), JSON.stringify(refused));

// The flag must answer for the SCREEN. Native location tracking starting is a
// different fact and used to clear it, which is what made this warning dead on
// the native app.
const nativeClaim = await page.evaluate(async () => {
  const realPlugin = window.nativeNavigationPlugin;
  window.nativeNavigationPlugin = () => ({
    startTracking: () => Promise.resolve({ accuracy: 'full' }),
    stopTracking: () => Promise.resolve(),
    addListener: () => Promise.resolve({ remove() {} }),
  });
  turnNav.active = true;
  turnNav.screenMaySleep = true;      // as a refused wake lock would leave it
  await startNativeNavigationTracking();
  const after = turnNav.screenMaySleep;
  window.nativeNavigationPlugin = realPlugin;
  turnNav.nativeTracking = false;
  return { after };
});
check('starting native location tracking does not claim the screen is safe',
  nativeClaim.after === true, JSON.stringify(nativeClaim));

/* ------------------------------------ native iOS owns the idle timer directly */
const nativeLock = await page.evaluate(async () => {
  const realPlugin = window.nativeNavigationPlugin;
  window.__nativeAwakeCalls = [];
  window.nativeNavigationPlugin = () => ({
    setScreenAwake({ enabled }) {
      window.__nativeAwakeCalls.push(enabled);
      return Promise.resolve();
    },
  });
  window.__locks.requested = 0;
  turnNav.active = true;
  navVoice.keepScreenAwake = true;
  turnNav.screenMaySleep = true;
  await requestNavigationWakeLock();
  const held = {
    calls: window.__nativeAwakeCalls.slice(),
    browserRequests: window.__locks.requested,
    maySleep: turnNav.screenMaySleep,
  };
  releaseNavigationWakeLock();
  await Promise.resolve();
  held.afterRelease = window.__nativeAwakeCalls.slice();
  window.nativeNavigationPlugin = realPlugin;
  return held;
});
check('the native app disables the iOS idle timer for navigation',
  nativeLock.calls.length === 1 && nativeLock.calls[0] === true
    && nativeLock.maySleep === false,
  JSON.stringify(nativeLock));
check('native idle control is preferred over an uncertain WebKit wake lock',
  nativeLock.browserRequests === 0, JSON.stringify(nativeLock));
check('ending navigation restores the iOS idle timer',
  nativeLock.afterRelease.length === 2 && nativeLock.afterRelease[1] === false,
  JSON.stringify(nativeLock));

await page.evaluate(() => { turnNav.active = false; window.__locks.refuse = false; });
check('no page errors', page.pageErrors.length === 0, page.pageErrors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
