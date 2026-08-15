// Capture the onboarding-tour screenshots from the real app.
// Phone-sized, dpr 2, JPEG, cropped to the band each step talks about.
// Writes the final shipped assets into onboarding/ at the repo root.
//
// The scenes are STAGED, on two trips:
//  - Ballard Locks -> UW for the welcome/plan/routes/colors scenes and for
//    turn navigation, with the fake GPS walked a third of the way along so
//    the banner shows a real maneuver instead of the wake-lock notice.
//  - A second trip pinned to 15th Ave NW for the failing-road scenes: the
//    arterial fails the default rules on traffic (34k vehicles/day) with no
//    recorded shoulder -- a long, unmistakable dark-red dashed stretch on
//    the active route, and a card that names the broken rule.
// Eyeball every image after a reshoot -- the script cannot judge composition.
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
const route = (start, startName, end, endName) => page.evaluate(async (trip) => {
  routing.start = trip.start; routing.startName = trip.startName;
  routing.startFromDevice = false;
  routing.end = trip.end; routing.endName = trip.endName;
  updateArmButtons();
  // Wait for a NEW portfolio, not merely an ok one -- routing.last stays ok
  // from the previous trip, and reading routing.options before the fresh
  // reply lands staged the wrong route's scenes once.
  const previous = routing.last;
  computeRoute();
  for (let i = 0; i < 240 && (routing.last === previous || !routing.last?.ok); i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
  document.body.classList.remove('panel-open');
  return routing.last !== previous && !!routing.last?.ok;
}, { start, startName, end, endName });

/* ============================== trip 1: Ballard Locks -> UW (Burke-Gilman) */
console.log('trip 1 routed:', await route([-122.3974, 47.6656], 'Ballard Locks',
  [-122.3035, 47.6555], 'University of Washington'));

// ---- welcome: the suggested route across the city, panel closed
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

// ---- navigate: GPS walked a third of the way along, next maneuver showing
console.log('nav:', await page.evaluate(() => {
  try { startTurnNavigation(); } catch (e) { return 'threw: ' + e.message; }
  return true;
}));
await settle(1500);
const along = await page.evaluate(() =>
  routing.last.coords.filter((_, i) => i % Math.ceil(routing.last.coords.length / 14) === 0));
for (const [lon, lat] of along.slice(1, 5)) {
  await context.setGeolocation({ latitude: lat, longitude: lon });
  await settle(1200);
}
// Headless Chromium has no wake lock, so the banner leads with "Screen may
// sleep on this device" -- true here, useless in a tour. Clear it so the
// banner shows what a rider sees: the next maneuver.
console.log('banner:', await page.evaluate(() => {
  turnNav.screenMaySleep = false; turnNav.message = '';
  refreshNavigationUI();
  return document.getElementById('navBannerText').textContent;
}));
await idle(); await settle(1200);
await shot('tour-navigate', { x: 0, y: 0, width: 430, height: 560 });
await page.evaluate(() => stopTurnNavigation(false));
await settle(600);

/* ============================= trip 2: straight down the 15th Ave NW wall */
// Both endpoints sit ON 15th Ave NW, so the corridor ride exists in every
// portfolio; the recommended pick detours around the failing arterial, so
// activate the highest-fail option -- the one that rides 15th end to end.
// That guarantees a long, unmistakable red-dashed active stretch no matter
// how the portfolio shuffles between runs.
console.log('trip 2 routed:', await route([-122.37655, 47.66855], '15th Ave NW & NW Market St',
  [-122.37632, 47.65964], '15th Ave NW & NW Ballard Way'));
console.log('fail option:', await page.evaluate(async () => {
  const byFail = [...(routing.options || [])].sort((a, b) => (b.failM || 0) - (a.failM || 0));
  activateRouteOption(byFail[0]);
  await new Promise((r) => setTimeout(r, 700));
  document.body.classList.remove('panel-open');
  return { label: byFail[0]?.optimization?.label, failM: Math.round(byFail[0]?.failM || 0) };
}));

// ---- warning: the long dark-red dashed stretch down 15th Ave NW
await page.evaluate(() => map.jumpTo({ center: [-122.3752, 47.6641], zoom: 14.7 }));
await idle(); await settle(1500);
await shot('tour-warning', { x: 0, y: 230, width: 430, height: 440 });

// ---- road card: tap the failing stretch; the card names the broken rule
const cardTop = await page.evaluate(async () => {
  document.body.classList.remove('panel-open');
  map.jumpTo({ center: [-122.37627, 47.66626], zoom: 15.4 });
  await new Promise((r) => { map.once('idle', r); setTimeout(r, 9000); });
  const point = map.project([-122.37627, 47.66626]);
  inspectRoadAt(point, map.unproject(point));
  await new Promise((r) => setTimeout(r, 900));
  return Math.round(document.getElementById('readout').getBoundingClientRect().top);
});
console.log('card top', cardTop);
await shot('tour-road', { x: 0, y: Math.max(0, cardTop - 140), width: 430, height: 480 });

await browser.close();
await site.close();
