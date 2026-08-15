// Capture the onboarding-tour screenshots from the real app.
// Phone-sized, dpr 2, JPEG, cropped to the band each step talks about.
// Writes the final shipped assets into onboarding/ at the repo root.
import { launchBrowser, serveRepo } from './testlib/harness.mjs';
import { mkdirSync } from 'node:fs';

const OUT = new URL('../onboarding', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const site = await serveRepo();
const browser = await launchBrowser();
const context = await browser.newContext({
  serviceWorkers: 'block',
  viewport: { width: 430, height: 900 },
  deviceScaleFactor: 2,
  hasTouch: true, isMobile: true,
  geolocation: { latitude: 47.6656, longitude: -122.3974 },
  permissions: ['geolocation'],
});
const page = await context.newPage();
page.on('pageerror', (e) => console.error('pageerror:', e.message));
await page.goto(`http://localhost:${site.port}/index.html`, { waitUntil: 'load' });
await page.waitForFunction(() => window.map && map.loaded && map.loaded() && routing?.ready, null, { timeout: 120000 });

const idle = () => page.evaluate(() => new Promise((r) => { map.once('idle', r); setTimeout(r, 12000); }));
const settle = (ms = 700) => page.waitForTimeout(ms);
const shot = async (name, clip) => {
  await page.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 78, clip });
  console.log('shot', name, JSON.stringify(clip || null));
};

// ---- route: Ballard Locks -> UW (Burke-Gilman, water, varied streets)
await page.evaluate(async () => {
  routing.start = [-122.3974, 47.6656];
  routing.startName = 'Ballard Locks';
  routing.startFromDevice = false;
  routing.end = [-122.3035, 47.6555];
  routing.endName = 'University of Washington';
  updateArmButtons();
  computeRoute();
  for (let i = 0; i < 240 && !routing.last?.ok; i++) await new Promise((r) => setTimeout(r, 500));
});
console.log('routed:', await page.evaluate(() => routing.last?.ok));

// ---- welcome: the route across Ballard->UW, panel closed
await page.evaluate(() => { document.body.classList.remove('panel-open'); updateArmButtons(); });
await idle(); await settle(1500);
await shot('tour-welcome', { x: 0, y: 330, width: 430, height: 470 });

// ---- plan: the trip bar with real endpoints + Find button
await shot('tour-plan', { x: 0, y: 0, width: 430, height: 205 });

// ---- routes: the route chooser sheet (A-F chips, stats, makeup)
await page.evaluate(() => { setPanelOpen(); selectPanelTab('route'); });
await settle(900);
const sheet = await page.evaluate(() => {
  const r = document.getElementById('panel').getBoundingClientRect();
  return { x: 0, y: Math.max(0, r.top - 4), width: 430, height: Math.min(900 - r.top + 4, r.height + 8) };
});
await shot('tour-routes', sheet);

// ---- colors: mixed safety colors near Fremont/Aurora, no sheet
await page.evaluate(() => { document.body.classList.remove('panel-open'); map.jumpTo({ center: [-122.3493, 47.6535], zoom: 13.6 }); });
await idle(); await settle(1500);
await shot('tour-colors', { x: 0, y: 215, width: 430, height: 480 });

// ---- road card: tap Woodland Park Ave N
const cardInfo = await page.evaluate(async () => {
  const point = map.project([-122.34445, 47.65505]);
  inspectRoadAt(point, map.unproject(point));
  await new Promise((r) => setTimeout(r, 900));
  const r = document.getElementById('readout').getBoundingClientRect();
  return [Math.round(r.top), Math.round(r.height)];
});
console.log('card', JSON.stringify(cardInfo));
await shot('tour-road', { x: 0, y: 360, width: 430, height: 440 });

// ---- navigate: GPS turn navigation, card dismissed
const navState = await page.evaluate(async () => {
  document.getElementById('readout').classList.remove('show');
  try { startTurnNavigation(); } catch (e) { return 'threw: ' + e.message; }
  for (let i = 0; i < 40 && !turnNav.active; i++) await new Promise((r) => setTimeout(r, 250));
  return turnNav.active;
});
console.log('nav:', navState);
await idle(); await settle(1500);
console.log('card visible during nav:', await page.evaluate(() =>
  document.getElementById('readout').classList.contains('show')));
await shot('tour-navigate', { x: 0, y: 0, width: 430, height: 440 });

await browser.close();
await site.close();
