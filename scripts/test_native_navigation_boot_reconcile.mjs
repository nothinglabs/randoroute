#!/usr/bin/env node
// A freshly loaded page owns no ride. If the native guide still reports one,
// the web layer reloaded mid-ride (an update installed, or WebKit restarted its
// content process) and the ride has no Stop button left: voice guidance and the
// lock-screen card would run on until the app is force-quit, and the card then
// outlives the app. Boot must stop it and say so. When nothing is tracking,
// boot must leave the native guide alone.
import { chromiumPath, playwright, serveRepo } from './testlib/harness.mjs';

const { chromium } = await playwright();
const site = await serveRepo();
const browser = await chromium.launch({
  executablePath: chromiumPath(), args: ['--use-gl=swiftshader'],
});

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};

async function boot(tracking) {
  const context = await browser.newContext({
    serviceWorkers: 'block', viewport: { width: 390, height: 844 },
    hasTouch: true, isMobile: true,
  });
  await context.addInitScript((isTracking) => {
    window.__nativeCalls = [];
    window.Capacitor = {
      isNativePlatform: () => true,
      Plugins: { NativeNavigation: {
        getStatus: () => Promise.resolve({
          servicesEnabled: true, authorization: 'prompt', accuracy: 'full', tracking: isTracking,
        }),
        stopTracking: () => { window.__nativeCalls.push('stopTracking'); return Promise.resolve(); },
        startTracking: () => { window.__nativeCalls.push('startTracking'); return Promise.resolve({}); },
        addListener: () => Promise.resolve({ remove() {} }),
      } },
    };
  }, tracking);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(site.url, { waitUntil: 'load' });
  await page.waitForFunction(() => document.documentElement.classList.contains('app-ready'),
    null, { timeout: 120000 });
  // The boot probe resolves a promise chain after app-ready; give it a tick.
  await page.waitForFunction(() => window.__nativeCalls !== undefined, null, { timeout: 5000 });
  await page.waitForTimeout(300);
  const state = await page.evaluate(() => {
    const toast = document.getElementById('routeActionToast');
    return {
      calls: window.__nativeCalls.slice(),
      toastShown: !!toast && !toast.hidden,
      toastText: document.getElementById('routeActionText')?.textContent || '',
      toastDetail: document.getElementById('routeActionDetail')?.textContent || '',
    };
  });
  await context.close();
  return { ...state, errors };
}

const orphaned = await boot(true);
check('a native ride with no web owner is stopped at boot',
  orphaned.calls.filter((call) => call === 'stopTracking').length === 1
    && !orphaned.calls.includes('startTracking'),
  JSON.stringify(orphaned.calls));
check('the rider is told the ride ended and why',
  orphaned.toastShown && /Navigation stopped/.test(orphaned.toastText)
    && /restarted mid-ride/.test(orphaned.toastDetail),
  JSON.stringify({ shown: orphaned.toastShown, text: orphaned.toastText, detail: orphaned.toastDetail }));
check('no page errors while reconciling', orphaned.errors.length === 0, orphaned.errors.slice(0, 3).join(' | '));

const quiet = await boot(false);
check('an idle native guide is left alone at boot',
  quiet.calls.length === 0 && !quiet.toastShown,
  JSON.stringify({ calls: quiet.calls, toastShown: quiet.toastShown, text: quiet.toastText }));
check('no page errors on the idle boot', quiet.errors.length === 0, quiet.errors.slice(0, 3).join(' | '));

console.log(`\n${passed} passed, ${failed} failed`);
await browser.close();
site.close();
process.exit(failed ? 1 : 0);
