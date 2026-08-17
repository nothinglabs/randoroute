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
  selectPanelTab('settings');
  document.getElementById('settings-tab-routes').click();
  const deadline = Date.now() + 30000;
  while (!document.querySelector('.state-route-row') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const rows = [...document.querySelectorAll('.state-route-row')];
  const out = {
    settingsOpen: settingsMenuIsOpen(),
    paneVisible: document.getElementById('settings-routes').hidden === false,
    tabsVisible: document.getElementById('settingsTabs').getBoundingClientRect().height > 0,
    tabTitle: document.getElementById('settings-tab-routes').textContent.trim(),
    regionNamed: document.getElementById('stateRoutesRegion').textContent,
    rowCount: rows.length,
    detailsPresent: rows.every((row) => row.querySelector('small')?.textContent.length > 0),
    sourceHeadings: [...document.querySelectorAll('.state-route-source-heading')]
      .map((heading) => heading.textContent),
    islandCountyRoute: rows.find((routeRow) =>
      routeRow.querySelector('strong')?.textContent === 'North Whidbey')
      ?.querySelector('small')?.textContent || '',
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
  const routeSource = SOURCES.find((source) => source.id === 'routes');
  const matchingFeature = routeSource.fc.features.find((feature) =>
    routeOverlayNames(feature.properties).includes(out.toggledName));
  out.mapFeaturePreferred = matchingFeature?.properties?.pr === 1;
  out.routeOpacityStyle = map.getPaintProperty('routes', 'line-opacity');
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
  out.mapFeatureCleared = matchingFeature?.properties?.pr === 0;
  selectPanelTab('route');
  return out;
});
check('the Routes screen lists the state’s signed routes',
  routesScreen.settingsOpen && routesScreen.paneVisible && routesScreen.tabsVisible
    && routesScreen.tabTitle === 'Designated Routes'
    && routesScreen.rowCount > 20 && routesScreen.detailsPresent
    && /Washington/.test(routesScreen.regionNamed),
  JSON.stringify({ ...routesScreen, persisted: undefined, savedBlob: undefined }));
check('reviewed routes are grouped separately from OSM without implying safety',
  routesScreen.sourceHeadings.join('|') === 'OSM routes|Island County'
    && /Official route/.test(routesScreen.islandCountyRoute)
    && !/safe/i.test(routesScreen.islandCountyRoute),
  JSON.stringify(routesScreen));
check('marking Preferred sets the rules key and sends the worker the geometry',
  routesScreen.ruleKey === routesScreen.toggledName
    && routesScreen.messageKey === routesScreen.toggledName
    && routesScreen.messageLines > 0 && routesScreen.badgeShown
    && routesScreen.mapFeaturePreferred,
  JSON.stringify(routesScreen));
check('a Preferred route gets a modest map-opacity lift and clears it again',
  Array.isArray(routesScreen.routeOpacityStyle)
    && routesScreen.routeOpacityStyle[0] === 'case'
    && routesScreen.routeOpacityStyle[2] > routesScreen.routeOpacityStyle[3]
    && routesScreen.mapFeatureCleared,
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
    && tapCard.labels.every((label) => /Prefer route: /.test(label)),
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

// Membership by geometry: an unflagged feature earns the toggle only when
// its own shape RUNS ALONG the route line -- the trail's pavement shares it
// to the metre; a parallel street a block over and a road that merely
// crosses the route do not (the Meadow Road field report).
const along = await page.evaluate(async () => {
  const catalog = await ensureStateRouteCatalog();
  const entry = catalog.get('Interurban Trail');
  const line = entry.lines.sort((a, b) => b.length - a.length)[0];
  const start = Math.floor(line.length / 2);
  const stretch = line.slice(start, Math.min(start + 10, line.length));
  const kx = 111320 * Math.cos(stretch[0][1] * Math.PI / 180);
  const offset = (coords, metres) => coords.map(([lng, lat]) => [lng + metres / kx, lat]);
  const osmFeature = (coordinates) => preferredRouteTogglesFor('osm', {}, {},
    { lng: coordinates[0][0], lat: coordinates[0][1] },
    { geometry: { type: 'LineString', coordinates } });
  const a = stretch[0], b = stretch[stretch.length - 1];
  // A short way crossing the trail at its midpoint, perpendicular-ish.
  const crossMid = stretch[Math.floor(stretch.length / 2)];
  const crossing = [[crossMid[0] - 120 / kx, crossMid[1]], [crossMid[0] + 120 / kx, crossMid[1]]];
  return {
    onRoute: osmFeature(stretch),
    parallel: osmFeature(offset(stretch, 60)),
    crossing: osmFeature(crossing),
    noGeometry: preferredRouteTogglesFor('osm', {}, {}, { lng: a[0], lat: a[1] }, null),
    span: [a, b],
  };
});
check('an unflagged feature earns the toggle only by running along the route',
  along.onRoute.includes('Interurban Trail')
    && !along.parallel.includes('Interurban Trail')
    && !along.crossing.includes('Interurban Trail')
    && along.noGeometry.length === 0,
  JSON.stringify(along));

// Toggling with a live trip must reprice THAT recompute: the geometry
// message has to reach the worker before the route request does.
const ordering = await page.evaluate(async () => {
  const posted = [];
  routing.worker = { postMessage: (message) => posted.push(message.type) };
  routing.ready = true;
  routing.start = [-122.335, 47.61];
  routing.end = [-122.31, 47.62];
  setRoutePreferred('Interurban Trail', true);
  const deadline = Date.now() + 5000;
  while (!posted.includes('route-options') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  setRoutePreferred('Interurban Trail', false);
  routing.start = null; routing.end = null;
  clearRoute();
  return posted;
});
check('a toggle recompute is posted after the geometry it should price',
  ordering.includes('preferred-routes') && ordering.includes('route-options')
    && ordering.indexOf('preferred-routes') < ordering.indexOf('route-options'),
  JSON.stringify(ordering));

const navigationLock = await page.evaluate(() => {
  const before = preferredRouteNames();
  const posted = [];
  routing.worker = { postMessage: (message) => posted.push(message.type) };
  turnNav.active = true;
  const changed = setRoutePreferred('Interurban Trail', true);
  const toast = document.getElementById('routeActionText')?.textContent || '';
  const after = preferredRouteNames();
  turnNav.active = false;
  return { before, after, posted, changed, toast };
});
check('preferred routes cannot change during active navigation',
  navigationLock.changed === false
    && JSON.stringify(navigationLock.after) === JSON.stringify(navigationLock.before)
    && navigationLock.posted.length === 0
    && /Stop navigation/.test(navigationLock.toast),
  JSON.stringify(navigationLock));

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
    && roadCard.some((label) => label === 'Prefer route: Interurban Trail'),
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
// Whichever card won the hit test, the control itself must always identify the
// route. Relying on the card title made the same action read differently on a
// route ribbon than on its underlying trail or road.
check('tapping the route on the real map offers its Preferred checkbox',
  tapped.toggles.some((label) => label === 'Prefer route: Interurban Trail'),
  JSON.stringify(tapped));
await page.evaluate(() => dismissRoadInfo());

/* ---------- a route name is never pinned on a road that is not on it */
// The field report: beside the trail, the nearest record is I-5's, and the
// proximity badge dressed the banned freeway's card as the trail failing.
const attribution = await page.evaluate((mid) => {
  const original = routeBadgeAt;
  const point = { x: 0, y: 0 };
  routeBadgeAt = () => 'Interurban Trail'; // the ribbon is 6 px away
  const out = {
    bannedFreeway: bikeRouteContextRow('blts', { Designated: 0 }, point),
    flaggedRecord: bikeRouteContextRow('blts', { Designated: 1 }, point),
    infrastructure: bikeRouteContextRow('osm', {}, point),
  };
  routeBadgeAt = () => null; // ribbon layer hidden
  out.flaggedNoRibbon = bikeRouteContextRow('roads', { g: 1 }, point);
  out.plainRoad = bikeRouteContextRow('roads', {}, point);
  routeBadgeAt = original;
  // A nearby ribbon is not enough to make an unrelated road's card control
  // that route. A road with its own route flag still receives the control.
  out.prohibitedToggles = preferredRouteTogglesFor('blts',
    {}, { prohibited: true }, { lng: mid[0], lat: mid[1] });
  out.ordinaryToggles = preferredRouteTogglesFor('roads',
    {}, { prohibited: false }, { lng: mid[0], lat: mid[1] });
  out.claimedToggles = preferredRouteTogglesFor('roads',
    { g: 1 }, { prohibited: false }, { lng: mid[0], lat: mid[1] });
  return out;
}, near.mid);
check('a proximity badge never lands on a road without its own route claim',
  attribution.bannedFreeway === null && attribution.plainRoad === null
    && attribution.flaggedRecord?.[1] === 'Interurban Trail'
    && attribution.infrastructure?.[1] === 'Interurban Trail'
    && /designated route/.test(attribution.flaggedNoRibbon?.[1] || ''),
  JSON.stringify(attribution));
check('only a segment that claims route membership offers its checkbox',
  attribution.prohibitedToggles.length === 0
    && attribution.ordinaryToggles.length === 0
    && attribution.claimedToggles.includes('Interurban Trail'),
  JSON.stringify(attribution));

// An ambiguous tap -- a rideable way and a bikes-banned one both in reach --
// resolves to the rideable way, even when the banned one is nearer.
const dodge = await page.evaluate(() => {
  const center = map.getCenter();
  const at = map.project([center.lng, center.lat]);
  const lineAt = (pxOffset) => {
    const a = map.unproject([at.x - 30, at.y + pxOffset]);
    const b = map.unproject([at.x + 30, at.y + pxOffset]);
    return { type: 'LineString', coordinates: [[a.lng, a.lat], [b.lng, b.lat]] };
  };
  const banned = { layer: { id: 'roads__hit' }, properties: { b: 1 }, geometry: lineAt(0) };
  const rideable = { layer: { id: 'roads__hit' }, properties: {}, geometry: lineAt(4) };
  return {
    bannedIsProhibited: hitProhibited(banned),
    rideableIsNot: !hitProhibited(rideable),
    pick: dodgeBannedHit(at, [banned, rideable], banned) === rideable,
    aloneStays: dodgeBannedHit(at, [banned], banned) === banned,
  };
});
check('an ambiguous tap resolves to the rideable way, not the banned one',
  dodge.bannedIsProhibited && dodge.rideableIsNot && dodge.pick && dodge.aloneStays,
  JSON.stringify(dodge));

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
