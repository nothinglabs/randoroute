// Capture the onboarding-tour screenshots from the real app.
// Phone-sized, dpr 2, JPEG, cropped to the band each step talks about.
// Writes the final shipped assets into onboarding/ at the repo root.
//
// One STAGED trip drives every scene: Martha Lake -> Mukilteo. Its portfolio
// splits cleanly into a fast option that rides the failing arterial corridor
// (dark-red dashes, a chain of warning badges) and a safer option on
// designated routes and trails nearly the whole way -- the fast/safer pair
// shares one camera so swiping between those steps flips the comparison.
// The fake GPS starts at Martha Lake and is walked along the safer route for
// the navigation scene so the banner shows a real maneuver.
// Eyeball every image after a reshoot -- the script cannot judge composition.
import { launchBrowser, serveRepo } from './testlib/harness.mjs';
import { mkdirSync } from 'node:fs';

const OUT = new URL('../onboarding', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const START = [-122.2390, 47.8508];
const END = [-122.3046, 47.9479];

const site = await serveRepo();
const browser = await launchBrowser();
const context = await browser.newContext({
  serviceWorkers: 'block',
  viewport: { width: 430, height: 900 },
  deviceScaleFactor: 2,
  hasTouch: true, isMobile: true,
  geolocation: { latitude: START[1], longitude: START[0] },
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

// ---- route it, and wait for a NEW portfolio (routing.last stays ok from
// any previous trip, so `ok` alone would read stale options)
console.log('routed:', await page.evaluate(async (trip) => {
  routing.start = trip.start; routing.startName = 'Martha Lake';
  routing.startFromDevice = false;
  routing.end = trip.end; routing.endName = 'Mukilteo';
  updateArmButtons();
  const previous = routing.last;
  computeRoute();
  for (let i = 0; i < 240 && (routing.last === previous || !routing.last?.ok); i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
  document.body.classList.remove('panel-open');
  return routing.last !== previous && !!routing.last?.ok;
}, { start: START, end: END }));

// The two ends of the trade, straight from the live portfolio.
const picks = await page.evaluate(() => {
  const options = routing.options || [];
  const fastest = [...options].sort((a, b) => (a.timeS || 9e9) - (b.timeS || 9e9))[0];
  const safest = [...options].sort((a, b) => (a.failM || 0) - (b.failM || 0)
    || (a.timeS || 9e9) - (b.timeS || 9e9))[0];
  return {
    fastI: options.indexOf(fastest), safeI: options.indexOf(safest),
    fast: { label: fastest?.optimization?.label, mi: +(fastest.distM / 1609.34).toFixed(1), failMi: +(fastest.failM / 1609.34).toFixed(1) },
    safe: { label: safest?.optimization?.label, mi: +(safest.distM / 1609.34).toFixed(1), failMi: +(safest.failM / 1609.34).toFixed(1) },
  };
});
console.log('picks:', JSON.stringify(picks));
const activate = (index) => page.evaluate(async (i) => {
  activateRouteOption(routing.options[i]);
  await new Promise((r) => setTimeout(r, 700));
  document.body.classList.remove('panel-open');
}, index);

// ---- welcome: the safer route's waterfront arrival, fitted to the route
// tail so the framing follows the data rather than a hardcoded center
await activate(picks.safeI);
await page.evaluate(async () => {
  const coords = routing.last.coords;
  const tail = coords.slice(Math.floor(coords.length * 0.7));
  let minX = 180, minY = 90, maxX = -180, maxY = -90;
  for (const [x, y] of tail) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  map.fitBounds([[minX, minY], [maxX, maxY]],
    { padding: { top: 280, bottom: 240, left: 46, right: 46 }, duration: 0 });
});
await idle(); await settle(1500);
await shot('tour-welcome', { x: 0, y: 240, width: 430, height: 470 });

// ---- plan: the trip bar with real endpoints + Find button
await shot('tour-plan', { x: 0, y: 0, width: 430, height: 205 });

// ---- routes: the route chooser sheet (lettered chips, stats, makeup)
await page.evaluate(() => { setPanelOpen(); selectPanelTab('route'); });
await settle(900);
const sheet = await page.evaluate(() => {
  const r = document.getElementById('panel').getBoundingClientRect();
  return { x: 0, y: Math.max(0, r.top - 4), width: 430, height: Math.min(900 - r.top + 4, r.height + 8) };
});
await shot('tour-routes', sheet);
await page.evaluate(() => document.body.classList.remove('panel-open'));

// ---- fast vs safer: one camera fitted to the whole trip, two activations
const frame = await page.evaluate(() => {
  const coords = routing.last.coords;
  let minX = 180, minY = 90, maxX = -180, maxY = -90;
  for (const [x, y] of coords) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  map.fitBounds([[minX, minY], [maxX, maxY]],
    { padding: { top: 230, bottom: 200, left: 44, right: 44 }, duration: 0 });
  return { center: map.getCenter().toArray(), zoom: map.getZoom() };
});
await activate(picks.fastI);
await page.evaluate((f) => map.jumpTo(f), frame);
await idle(); await settle(1500);
await shot('tour-fast', { x: 0, y: 195, width: 430, height: 545 });

await activate(picks.safeI);
await page.evaluate((f) => map.jumpTo(f), frame);
await idle(); await settle(1500);
await shot('tour-safer', { x: 0, y: 195, width: 430, height: 545 });

// ---- road card: tap the LONGEST failing stretch of the fast option;
// the card names the broken rule with the numbers behind it
await activate(picks.fastI);
const cardTop = await page.evaluate(async () => {
  const segLenM = (coords) => {
    let m = 0;
    for (let i = 1; i < coords.length; i++) {
      const dx = (coords[i][0] - coords[i - 1][0]) * 111320 * Math.cos(coords[i][1] * Math.PI / 180);
      const dy = (coords[i][1] - coords[i - 1][1]) * 110540;
      m += Math.hypot(dx, dy);
    }
    return m;
  };
  const stretches = (map.getSource('route-fail')?._data?.features || [])
    .map((f) => ({ coords: f.geometry.coordinates, lenM: segLenM(f.geometry.coordinates) }))
    .sort((a, b) => b.lenM - a.lenM);
  const target = stretches[0].coords[Math.floor(stretches[0].coords.length / 2)];
  map.jumpTo({ center: target, zoom: 15.2 });
  await new Promise((r) => { map.once('idle', r); setTimeout(r, 9000); });
  const point = map.project(target);
  inspectRoadAt(point, map.unproject(point));
  await new Promise((r) => setTimeout(r, 900));
  return Math.round(document.getElementById('readout').getBoundingClientRect().top);
});
console.log('card top', cardTop);
await shot('tour-road', { x: 0, y: Math.max(0, cardTop - 140), width: 430, height: 480 });

// ---- navigate: the safer route, GPS walked a third of the way along
await activate(picks.safeI);
console.log('nav:', await page.evaluate(() => {
  document.getElementById('readout').classList.remove('show');
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

await browser.close();
await site.close();
