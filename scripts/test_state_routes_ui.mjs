#!/usr/bin/env node
// Settings → Routes and its relatives: the state's signed routes list with
// per-route Preferred (persisted per state, synced to the worker), the same
// checkbox on a tapped route ribbon's card, the out-of-state GPS toast, and
// the map styles this batch aligned (trail dots, failing-road width floor).
import { chromiumPath, playwright, serveRepo } from './testlib/harness.mjs';

const { chromium } = await playwright();
const site = await serveRepo();
const browser = await chromium.launch({ executablePath: chromiumPath(), args: ['--use-gl=swiftshader'] });
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(site.url, { waitUntil: 'load' });
await page.waitForFunction(() => document.documentElement.classList.contains('app-ready'), null, { timeout: 120000 });

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  (ok ? passed++ : failed++);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
};

/* ------------------------------------------ the Routes screen and the sync */
const routesScreen = await page.evaluate(async () => {
  const posted = [];
  routing.worker = { postMessage: (message) => posted.push(message) };
  routing.ready = true;
  document.getElementById('settings-tab-routes').click();
  const deadline = Date.now() + 30000;
  while (!document.querySelector('.state-route-row') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const rows = [...document.querySelectorAll('.state-route-row')];
  const out = {
    dialogOpen: document.getElementById('stateRoutesDialog').open,
    regionNamed: document.getElementById('stateRoutesRegion').textContent,
    rowCount: rows.length,
    detailsPresent: rows.every((row) => row.querySelector('small')?.textContent.length > 0),
  };
  const row = rows.find((r) => r.querySelector('input') && !r.querySelector('input').checked);
  out.toggledName = row.querySelector('strong').textContent;
  const box = row.querySelector('input');
  box.checked = true;
  box.dispatchEvent(new Event('change'));
  await new Promise((resolve) => setTimeout(resolve, 250));
  const message = posted.find((m) => m.type === 'preferred-routes');
  out.ruleKey = rules.preferredRoutes || null;
  out.messageKey = message?.key ?? null;
  out.messageLines = message?.lines?.length ?? 0;
  out.badgeShown = !row.querySelector('.state-route-preferred-badge').hidden;
  out.persisted = (preferredRoutesByState[Region.id] || []).slice();
  // Per-state: the OTHER state's slot is untouched by this toggle.
  out.otherStatesUntouched = Object.keys(preferredRoutesByState).every((id) => id === Region.id);
  // The choice survives a save/restore of app state.
  saveStateNow();
  out.savedBlob = (JSON.parse(localStorage.getItem('wa-bike-state-1'))
    .preferredRoutesByState?.[Region.id] || []).slice();
  box.checked = false;
  box.dispatchEvent(new Event('change'));
  await new Promise((resolve) => setTimeout(resolve, 150));
  out.ruleKeyCleared = rules.preferredRoutes || null;
  document.getElementById('stateRoutesDialog').close();
  return out;
});
check('the Routes screen lists the state’s signed routes',
  routesScreen.dialogOpen && routesScreen.rowCount > 20 && routesScreen.detailsPresent
    && /Washington/.test(routesScreen.regionNamed),
  JSON.stringify({ ...routesScreen, persisted: undefined, savedBlob: undefined }));
check('marking Preferred sets the rules key and sends the worker the geometry',
  routesScreen.ruleKey === routesScreen.toggledName
    && routesScreen.messageKey === routesScreen.toggledName
    && routesScreen.messageLines > 0 && routesScreen.badgeShown,
  JSON.stringify(routesScreen));
check('the choice persists per state and unmarking clears it',
  routesScreen.persisted.includes(routesScreen.toggledName)
    && routesScreen.savedBlob.includes(routesScreen.toggledName)
    && routesScreen.otherStatesUntouched && routesScreen.ruleKeyCleared === null,
  JSON.stringify(routesScreen));

/* ------------------------------------- the tap card's Preferred checkbox */
const tapCard = await page.evaluate(async () => {
  const names = routeOverlayNames({ n: 'Interurban Trail / 10 (Washington)', t: 'rcn', r: '' });
  renderMapTapCard({
    displayTitle: 'Designated bike route', pointName: 'Interurban Trail',
    summary: '', rows: [], lngLat: { lng: -122.33, lat: 47.6 }, anchorPoint: null,
    swatchColor: '#888', swatchLabel: 'test', preferredRouteToggles: names,
  });
  const boxes = [...document.querySelectorAll('.readout-preferred-route input')];
  const labels = [...document.querySelectorAll('.readout-preferred-route span')]
    .map((span) => span.textContent);
  const out = { split: names, count: boxes.length, labels };
  boxes[0].checked = true;
  boxes[0].dispatchEvent(new Event('change'));
  await new Promise((resolve) => setTimeout(resolve, 150));
  out.marked = (preferredRoutesByState[Region.id] || []).slice();
  boxes[0].checked = false;
  boxes[0].dispatchEvent(new Event('change'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  out.cleared = preferredRoutesByState[Region.id] || null;
  dismissRoadInfo();
  return out;
});
check('a tapped overlapping segment offers one checkbox per route it belongs to',
  tapCard.split.length === 2 && tapCard.count === 2
    && tapCard.labels.every((label) => /Preferred route: /.test(label)),
  JSON.stringify(tapCard));
check('the card checkbox edits the same per-state selection',
  tapCard.marked.join() === 'Interurban Trail' && tapCard.cleared === null,
  JSON.stringify(tapCard));

/* ------------- the checkbox reaches the card a tap actually opens */
// Where a route follows a road or a trail, the road/trail wins the tap, so
// the checkbox must ride on THAT card, found from the overlay data.
const near = await page.evaluate(async () => {
  const catalog = await ensureStateRouteCatalog();
  const entry = catalog.get('Interurban Trail');
  const line = entry.lines.sort((a, b) => b.length - a.length)[0];
  const mid = line[Math.floor(line.length / 2)];
  return {
    mid,
    at: routeNamesNear({ lng: mid[0], lat: mid[1] }),
    offshore: routeNamesNear({ lng: -124.5, lat: 47.5 }),
  };
});
check('routeNamesNear names the routes under a point, and only there',
  near.at.includes('Interurban Trail') && near.offshore.length === 0,
  JSON.stringify(near));

const roadCard = await page.evaluate((names) => {
  renderMapTapCard({
    displayTitle: 'Road (OSM)', pointName: 'Beach Road',
    summary: '', rows: [], lngLat: { lng: -122.33, lat: 47.6 }, anchorPoint: null,
    swatchColor: '#888', swatchLabel: 'test', preferredRouteToggles: names,
  });
  const labels = [...document.querySelectorAll('.readout-preferred-route span')]
    .map((span) => span.textContent);
  dismissRoadInfo();
  return labels;
}, near.at);
check('a road card names the route its checkbox prefers',
  roadCard.length === near.at.length
    && roadCard.some((label) => label === 'Preferred route: Interurban Trail'),
  JSON.stringify(roadCard));

// End to end: a real tap on the trail on the real map opens whatever card
// wins the hit test, and that card carries the checkbox.
await page.evaluate((mid) => {
  dismissRoadInfo();
  map.jumpTo({ center: mid, zoom: 16 });
}, near.mid);
await page.evaluate(() => new Promise((resolve) => {
  map.once('idle', resolve); setTimeout(resolve, 9000);
}));
let tapped = { toggles: [], title: '' };
for (let attempt = 0; attempt < 3 && !tapped.toggles.length; attempt++) {
  const at = await page.evaluate((mid) => map.project(mid), near.mid);
  await page.mouse.click(at.x, at.y);
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline && !tapped.toggles.length) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    tapped = await page.evaluate(() => ({
      toggles: [...document.querySelectorAll('.readout-preferred-route span')]
        .map((span) => span.textContent),
      title: document.querySelector('.rt-title span:last-child')?.textContent || '',
    }));
  }
}
// Whichever card won the hit test -- the ribbon's own (titled by the route,
// plain "Preferred route" label) or a road/trail card (label names the
// route) -- the checkbox must identify the Interurban Trail.
check('tapping the route on the real map offers its Preferred checkbox',
  tapped.toggles.some((label) => /Interurban Trail/.test(label))
    || (tapped.toggles.includes('Preferred route') && /Interurban Trail/.test(tapped.title)),
  JSON.stringify(tapped));
await page.evaluate(() => dismissRoadInfo());

/* --------------------------------------------- GPS outside the selected map */
const gps = await page.evaluate(async () => {
  const out = {};
  map.jumpTo({ center: [-100, 40], zoom: 8 });
  updatePassiveMapLocation({ coords: { longitude: -116.2, latitude: 43.6 } }, 'launch');
  out.toast = document.getElementById('routeActionText').textContent;
  await new Promise((resolve) => setTimeout(resolve, 900));
  const landed = map.getCenter();
  out.landedOnDefault = Math.abs(landed.lng - Region.defaultCenter[0]) < 0.05
    && Math.abs(landed.lat - Region.defaultCenter[1]) < 0.05;
  // An in-state camera is left where the rider had it; only the message shows.
  map.jumpTo({ center: [-122.33, 47.6], zoom: 12 });
  updatePassiveMapLocation({ coords: { longitude: -116.2, latitude: 43.6 } }, 'foreground');
  await new Promise((resolve) => setTimeout(resolve, 200));
  const kept = map.getCenter();
  out.cameraKept = Math.abs(kept.lng + 122.33) < 0.01 && Math.abs(kept.lat - 47.6) < 0.01;
  out.toastAgain = document.getElementById('routeActionText').textContent;
  // An in-bounds fix still centers normally, with no leftover warning.
  const inBounds = updatePassiveMapLocation(
    { coords: { longitude: -122.2, latitude: 47.7 } }, 'foreground');
  out.inBoundsAccepted = inBounds === true;
  return out;
});
check('an out-of-state fix says so and puts the rider on the selected map',
  gps.toast === 'GPS location outside selected map' && gps.landedOnDefault,
  JSON.stringify(gps));
check('the location button repeats the message without yanking an in-state view',
  gps.cameraKept && gps.toastAgain === 'GPS location outside selected map'
    && gps.inBoundsAccepted,
  JSON.stringify(gps));

/* --------------------------------------------------- map style agreements */
const styles = await page.evaluate(() => ({
  trailDash: map.getPaintProperty('osm__trail-dots', 'line-dasharray'),
  routeTrailDash: map.getLayer('route-bike-trail-dots')
    ? map.getPaintProperty('route-bike-trail-dots', 'line-dasharray') : null,
  vhWidth: map.getPaintProperty('roads__vh', 'line-width'),
  vhDashStops: map.getPaintProperty('roads__vh', 'line-dasharray')?.stops?.length ?? 0,
}));
const vhLowZoomWidth = Array.isArray(styles.vhWidth) && styles.vhWidth[0] === 'interpolate'
  ? styles.vhWidth[4] : 0; // ['interpolate', ['linear'], ['zoom'], 5, WIDTH, ...]
check('map trails speak the active route’s dot language',
  JSON.stringify(styles.trailDash) === JSON.stringify([0.05, 2.1]),
  JSON.stringify(styles));
check('a failing road keeps a visible width when zoomed out',
  vhLowZoomWidth >= 1.5 && styles.vhDashStops >= 4, JSON.stringify(styles));

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log(`\n${passed} passed, ${failed} failed`);
await browser.close();
site.close();
process.exit(failed ? 1 : 0);
