#!/usr/bin/env node
// A first install is the longest the app will ever take to start, and it is the
// one time the rider has no idea whether it is working. The launch screen has
// to keep saying what it is doing -- including through the routing-graph
// download, which on a fresh install is most of the wait and used to say
// nothing at all because showRouterProgress() only wrote to the route status
// behind the launch screen.
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
// Installed before any page script, so nothing is missed between the first
// paint and the moment the app takes over.
await context.addInitScript(() => {
  window.__launchSaid = [];
  window.__routingWorkerStarts = [];
  const PlatformWorker = window.Worker;
  window.Worker = function RecordingWorker(...args) {
    window.__routingWorkerStarts.push({
      url: String(args[0] || ''),
      appReady: document.documentElement.classList.contains('app-ready'),
    });
    return new PlatformWorker(...args);
  };
  window.Worker.prototype = PlatformWorker.prototype;
  const record = () => {
    const node = document.getElementById('appLaunchStatus');
    const text = node && node.textContent.trim();
    if (text && window.__launchSaid[window.__launchSaid.length - 1] !== text) {
      window.__launchSaid.push(text);
    }
  };
  // Polled rather than observed: an init script runs against the document that
  // is about to be replaced by the navigation, so a MutationObserver bound here
  // would be watching an element the real page never uses.
  setInterval(record, 20);
});
const page = await context.newPage();

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};

await page.goto(site.url, { waitUntil: 'commit' });
await page.waitForFunction(() => document.documentElement.classList.contains('app-ready'),
  { timeout: 120000 }).catch(() => {});
const atReady = await page.evaluate(() => ({
  said: window.__launchSaid.slice(),
  ready: document.documentElement.classList.contains('app-ready'),
  hidden: document.getElementById('appLaunchScreen')?.getAttribute('aria-hidden'),
}));
check('the app reaches a usable map', atReady.ready);
check('and the launch screen steps aside for it', atReady.hidden === 'true',
  JSON.stringify(atReady));
check('the rider is told what is happening more than once', atReady.said.length >= 2,
  JSON.stringify(atReady.said));
check('every message says something specific',
  atReady.said.every((text) => text.length > 4 && !/^\.*$/.test(text)),
  JSON.stringify(atReady.said));

// The routing graph keeps loading after the map is usable, and its progress
// reaches the launch screen too -- which is what matters on the install where
// the graph is still downloading while the screen is up.
const wiring = await page.evaluate(() => {
  const seen = [];
  const real = window.__setAppLaunchStatus;
  window.__setAppLaunchStatus = (message) => { seen.push(message); real(message); };
  showRouterProgress('Downloading the routing map…');
  window.__setAppLaunchStatus = real;
  return { seen, stillOnScreen: document.getElementById('appLaunchStatus')?.textContent };
});
check('routing progress is reported to the launch screen',
  wiring.seen.includes('Downloading the routing map…'), JSON.stringify(wiring));
// ...and once the app owns the screen, those calls must not rewrite it.
check('but not after the app has taken over',
  wiring.stillOnScreen !== 'Downloading the routing map…', JSON.stringify(wiring));

const fallback = await page.evaluate(() => typeof window.__dismissAppLaunchScreen === 'function');
check('a startup failure cannot trap the rider behind the screen', fallback);

// A web install with no saved trip should paint its local map before starting
// the statewide graph's heavy inflate/index pass. Native defers that work until
// both endpoints exist; this page is the ordinary web runtime and pins its
// separate background-prewarm policy.
// Wait for the ROUTING worker specifically, not for any worker at all. MapLibre
// builds its map worker from a blob URL within a few hundred milliseconds of
// the page loading, which satisfies "length > 0" instantly and left the check
// below reading a list the router had not joined yet -- so whether this passed
// depended on how fast the machine was. The router worker starts about three
// seconds in, with app-ready already set, which is exactly what is being
// asserted; it was simply being measured too early.
await page.waitForFunction(
  () => window.__routingWorkerStarts.some((entry) => /router-worker\.js(?:$|\?)/.test(entry.url)),
  { timeout: 20000 }).catch(() => {});
const workerStarts = await page.evaluate(() => window.__routingWorkerStarts.slice());
const routingStarts = workerStarts.filter((entry) => /router-worker\.js(?:$|\?)/.test(entry.url));
check('background routing initialization waits until the first map is usable',
  routingStarts.length > 0 && routingStarts.every((entry) => entry.appReady),
  JSON.stringify(workerStarts));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
