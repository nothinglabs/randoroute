#!/usr/bin/env node
import { chromiumPath, playwright, serveRepo } from './testlib/harness.mjs';

const { chromium } = await playwright();
const site = await serveRepo();
const browser = await chromium.launch({
  executablePath: chromiumPath(), args: ['--use-gl=swiftshader'],
});
const page = await (await browser.newContext({
  serviceWorkers: 'block', viewport: { width: 390, height: 844 },
  hasTouch: true, isMobile: true,
})).newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
}

await page.goto(site.url, { waitUntil: 'load' });
await page.waitForFunction(() => typeof loadSavedRoutes === 'function', { timeout: 60000 });
await page.evaluate(() => {
  const coords = Array.from({ length: 8 }, (_, index) => [-122.34 + index * .001, 47.60]);
  const segs = [
    { lenM: 35958, flags: 8, facility: 5, level: 1, gradePct: 0 },
    { lenM: 5994, flags: 8, facility: 5, level: 1, gradePct: 7 },
    { lenM: 17123, facility: 2, level: 1, mph: 25, sh: 4 },
    { lenM: 19702, level: 1, mph: 20, sh: 4 },
    { lenM: 1712, level: 1, mph: 20, sh: 4, surface: 2 },
    { lenM: 4281, level: 3, mtb: true },
    { lenM: 856, level: 4, mph: 55, sh: 0 },
  ].map((segment, index) => ({ ...segment, c0: index, c1: index + 1 }));
  const profile = coords.map((_, index) => [index * 85616 / (coords.length - 1),
    120 + (index % 3) * 35]);
  const route = { ok: true, distM: 85616, timeS: 16200, maxGradePct: 7,
    coords, segs, profile };
  routing.start = coords[0];
  routing.end = coords.at(-1);
  routing.last = route;
  routing.pendingRoute = false;
  routing.routeRequestActive = false;
  renderRouteCard(route);
  refreshNavigationUI();
});
const routeCardLayout = await page.evaluate(() => {
  const root = document.querySelector('#routeCard .rc-route-summary');
  const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
  const overview = rect('#routeCard .rc-overview');
  const chart = rect('#routeCard .rc-elev-wrap');
  const categories = rect('#routeCard .rc-category-list');
  const metrics = rect('#routeCard .rc-secondary-metrics');
  const metricLabels = [...root.querySelectorAll('.rc-secondary-item')]
    .map((node) => node.textContent.replace('!', '').trim());
  const clipped = [...root.querySelectorAll('.rc-distance,.rc-duration,.rc-category-item,.rc-secondary-item')]
    .filter((node) => node.scrollWidth > node.clientWidth).map((node) => node.textContent.trim());
  // The labels truncate with an ellipsis rather than bleeding past the card, so
  // an overflowing row no longer shows up in `clipped` -- it shows up as "Needs
  // Cautio…" instead. Catch that here or the backstop hides the real fault.
  const truncated = [...root.querySelectorAll('.rc-category-item > span:last-child,.rc-secondary-label')]
    .filter((node) => node.scrollWidth > node.clientWidth)
    .map((node) => `${node.textContent.trim()} (${node.scrollWidth}>${node.clientWidth})`);
  return {
    height: root.getBoundingClientRect().height,
    overviewWidth: overview.width,
    chartWidth: chart.width,
    categoryWidth: categories.width,
    metricsHeight: metrics.height,
    metricsSpanRightColumns: Math.abs(metrics.left - chart.left) < 1
      && categories.right - metrics.right >= 6
      && categories.right - metrics.right <= 10,
    metricLabels,
    clipped,
    truncated,
    detailsButton: (() => {
      const rect = document.querySelector('#routeCard .route-details-btn')?.getBoundingClientRect();
      return rect ? { width: Math.round(rect.width), height: Math.round(rect.height) } : null;
    })(),
  };
});
check('long route distance and metrics fit without clipping',
  routeCardLayout.clipped.length === 0 && routeCardLayout.truncated.length === 0,
  JSON.stringify(routeCardLayout));
check('the left column is compact and the chart is at least as wide as the categories',
  // 1px of slack: the two right-hand tracks are 1fr each, and the grid can
  // hand one of them a sub-pixel more depending on what the left column took.
  routeCardLayout.overviewWidth <= 90
    && routeCardLayout.chartWidth >= routeCardLayout.categoryWidth - 1,
  JSON.stringify(routeCardLayout));
check('unpaved and incline share one compact strip inset from the phone edge',
  routeCardLayout.metricsHeight <= 26 && routeCardLayout.metricsSpanRightColumns
    && routeCardLayout.height <= 100,
  JSON.stringify(routeCardLayout));
check('incline appears before unpaved and unpaved uses miles',
  routeCardLayout.metricLabels[0]?.includes('Incline over 5%')
    && routeCardLayout.metricLabels[1] === '1.1 miUnpaved',
  JSON.stringify(routeCardLayout.metricLabels));

// Relationship pills used to size the first grid track by their text, so
// Suggested, Shorter, Lower Stress and Alternative nudged every item to their
// right when the rider changed letters. Exercise the real labels and require
// the card geometry to remain fixed.
const relationshipLayout = await page.evaluate(() => {
  const original = routing.last;
  const base = { ...original, optimization: { recommended: true }, aggression: .5 };
  const choices = [
    base,
    { ...original, distM: original.distM * .98, optimization: {}, aggression: .5 },
    { ...original, optimization: {}, aggression: .1 },
    { ...original, distM: original.distM * 1.02, optimization: {}, aggression: .5 },
    { ...original, optimization: {}, aggression: .5 },
  ];
  routing.options = choices;
  const samples = choices.map((choice) => {
    routing.last = choice;
    renderRouteCard(choice);
    const box = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { x: Math.round(rect.x * 10) / 10, y: Math.round(rect.y * 10) / 10,
        width: Math.round(rect.width * 10) / 10 };
    };
    return {
      label: document.querySelector('.rc-route-context').textContent,
      labelClipped: document.querySelector('.rc-route-context').scrollWidth
        > document.querySelector('.rc-route-context').clientWidth,
      overview: box('.rc-overview'), chart: box('.rc-elevation-column'),
      categories: box('.rc-category-list'), details: box('#routeDetailsBtn'),
    };
  });
  routing.last = original;
  routing.options = [original];
  renderRouteCard(original);
  return samples;
});
const layoutAnchor = relationshipLayout[0];
const relationshipStable = relationshipLayout.every((sample) =>
  ['overview', 'chart', 'categories', 'details'].every((key) =>
    Math.abs(sample[key].x - layoutAnchor[key].x) <= .1
      && Math.abs(sample[key].y - layoutAnchor[key].y) <= .1
      && Math.abs(sample[key].width - layoutAnchor[key].width) <= .1));
check('route descriptions do not move the route-card contents',
  relationshipStable
    && relationshipLayout.every((sample) => !sample.labelClipped)
    && relationshipLayout.map((sample) => sample.label).join('|')
      === 'Suggested|Shorter|Lower Stress|Longer|Alternative',
  JSON.stringify(relationshipLayout));
await page.evaluate(() => localStorage.setItem('wa-bike-saved-routes-1', JSON.stringify([{
  name: 'Lake loop', s: [-122.34, 47.60], e: [-122.30, 47.64], v: [], b: [],
}])));
// Saved routes are a direct, compact action in Trip options.
await page.click('#rb-more');
await page.click('#routeLibraryBtn');
await page.waitForSelector('#routesDialog[open]');

const layout = await page.evaluate(() => {
  const saved = document.querySelector('.saved-routes-section').getBoundingClientRect();
  const imported = document.querySelector('.import-route-bottom').getBoundingClientRect();
  const icon = document.querySelector('#routeLibraryBtn svg');
  return {
    loadText: document.querySelector('.saved-load')?.textContent.replace(/\s+/g, ' ').trim(),
    importBelowSaved: imported.top >= saved.bottom,
    floppyPaths: icon?.querySelectorAll('path').length || 0,
    inTripMenu: document.getElementById('routeLibraryBtn').closest('#routeMoreMenu') !== null,
  };
});
check('a saved route is an explicit load action', layout.loadText === 'Lake loopLoad ›',
  JSON.stringify(layout));
check('shared-link loading is a separate section at the bottom', layout.importBelowSaved,
  JSON.stringify(layout));
check('the route-library button uses a floppy-disk drawing', layout.floppyPaths === 2,
  JSON.stringify(layout));
check('the route-library button lives in Trip options',
  layout.inTripMenu, JSON.stringify(layout));

await page.click('.saved-del');
check('the X asks before deleting', await page.evaluate(() =>
  document.getElementById('deleteSavedRouteDialog').open && loadSavedRoutes().length === 1));
await page.click('#deleteSavedRouteDialog .dialog-actions [data-close="deleteSavedRouteDialog"]');
check('keeping the route leaves it saved', await page.evaluate(() => loadSavedRoutes().length === 1));
await page.click('.saved-del');
await page.click('#confirmDeleteSavedRoute');
check('confirming removes the saved route', await page.evaluate(() =>
  loadSavedRoutes().length === 0 && document.querySelectorAll('.saved-row').length === 0));
check('the saved-routes flow has no JavaScript errors', errors.length === 0, errors.join(' | '));

await page.evaluate(() => {
  document.getElementById('routesDialog')?.close();
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
    watchPosition: () => 1,
    clearWatch: () => {},
  } });
  document.body.classList.add('panel-open');
  selectPanelTab('settings');
  // A navigable route always has endpoints; the synthetic route injected at
  // the top of this test only supplied its summary geometry.
  routing.start = [-122.34, 47.60];
  routing.end = [-122.30, 47.64];
  refreshNavigationUI();
  selectPanelTab('route');
});
// Setting endpoints can put a route request in flight, and Navigate refuses to
// start on top of one -- "Wait for the updated route before starting
// navigation." This test is about where the panel sits once navigation is
// running, not about racing the router, so let the router settle first. In
// isolation it always had; under a loaded suite it did not, and the click then
// did nothing at all.
await page.waitForFunction(
  () => !routing.pendingRoute && !routing.routeRequestActive, null, { timeout: 30000 });
const navigationTab = await page.evaluate(async () => {
  const segmentIndex = 3;
  const segment = routing.last.segs[segmentIndex];
  const tap = {
    lng: (routing.last.coords[segment.c0][0] + routing.last.coords[segment.c1][0]) / 2,
    lat: (routing.last.coords[segment.c0][1] + routing.last.coords[segment.c1][1]) / 2,
  };
  const selectedIndex = routeSegmentIndexNearTap(routing.last, tap, 2);
  const farFromRoute = routeSegmentIndexNearTap(routing.last,
    { lng: tap.lng + 0.01, lat: tap.lat + 0.01 }, 2);
  HIT_SRC['route-seg-hit'] = ROUTESEG_SRC;
  renderReadout({
    layer: { id: 'route-seg-hit' },
    properties: routeSegProps(segment, segmentIndex),
    geometry: { type: 'LineString',
      coordinates: routing.last.coords.slice(segment.c0, segment.c1 + 1) },
  }, tap, { x: 195, y: 360 }, { routeElevationIndex: segmentIndex });
  const planningSelection = Number(document.getElementById('rcElevCanvas')
    .dataset.selectedDistanceM);
  // The card's invisible hit target is intentionally wider than the painted
  // route. Reproduce that broad-hit/strict-miss combination: it must clear the
  // prior elevation marker instead of treating the hit feature as sufficient.
  const offRouteTap = { lng: tap.lng, lat: tap.lat + 0.001 };
  renderReadout({
    layer: { id: 'route-seg-hit' },
    properties: routeSegProps(segment, segmentIndex),
    geometry: { type: 'LineString',
      coordinates: routing.last.coords.slice(segment.c0, segment.c1 + 1) },
  }, offRouteTap, { x: 195, y: 350 }, { routeElevationIndex: null });
  const planningClearedOffRoute = !document.getElementById('rcElevCanvas')
    .dataset.selectedDistanceM;
  const routeTipsRect = document.getElementById('routeTipsBtn').getBoundingClientRect();
  const startBefore = document.getElementById('navStartButton').getBoundingClientRect();
  const detailsBefore = document.getElementById('routeDetailsBtn').getBoundingClientRect();
  document.getElementById('navStartButton').click();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const active = document.querySelector('.tab.active');
  const navTips = document.getElementById('navTipsBtn');
  const navTipsRect = navTips.getBoundingClientRect();
  const startAfter = document.getElementById('navStartButton').getBoundingClientRect();
  const detailsAfter = document.getElementById('navCardDetailsBtn').getBoundingClientRect();
  // Starting navigation dismisses the planning inspection card. Tap the same
  // segment again in the live view: each mode should independently place the
  // marker at the same profile distance.
  renderReadout({
    layer: { id: 'route-seg-hit' },
    properties: routeSegProps(segment, segmentIndex),
    geometry: { type: 'LineString',
      coordinates: routing.last.coords.slice(segment.c0, segment.c1 + 1) },
  }, tap, { x: 195, y: 360 }, { routeElevationIndex: segmentIndex });
  const navElevation = document.getElementById('navElevationCanvas');
  const navigationSelection = Number(navElevation.dataset.selectedDistanceM);
  renderReadout({
    layer: { id: 'route-seg-hit' },
    properties: routeSegProps(segment, segmentIndex),
    geometry: { type: 'LineString',
      coordinates: routing.last.coords.slice(segment.c0, segment.c1 + 1) },
  }, offRouteTap, { x: 195, y: 350 }, { routeElevationIndex: null });
  const navigationClearedOffRoute = !navElevation.dataset.selectedDistanceM;
  const navElevationHeight = navElevation.getBoundingClientRect().height;
  // Render the compact card's widest progress string. The first frame after
  // tapping Navigate says "Waiting for GPS", which cannot catch an ETA that
  // clips once location arrives.
  turnNav.locationReady = true;
  const etaClock = navigationEstimateText(3780, false, 0);
  const etaRemaining = navigationEstimateText(3780, true, 0);
  const etaElement = document.getElementById('navProgressEta');
  etaElement.textContent = etaRemaining;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const etaRect = etaElement.getBoundingClientRect();
  const progressRect = document.querySelector('.nav-progress').getBoundingClientRect();
  const chartRect = document.querySelector('.nav-elevation-wrap').getBoundingClientRect();
  const result = {
    navigating: turnNav.active,
    activeTab: active?.id,
    oldNavigationRemoved: !document.getElementById('tabs') && !document.getElementById('panelOpen'),
    panelOpen: document.body.classList.contains('panel-open'),
    navTipsVisible: !navTips.hidden && getComputedStyle(navTips).display !== 'none',
    navTipsSize: { width: Math.round(navTipsRect.width), height: Math.round(navTipsRect.height) },
    helpRightAligned: Math.abs(navTipsRect.right - routeTipsRect.right) <= 1,
    startShift: { x: startAfter.left - startBefore.left, y: startAfter.top - startBefore.top },
    detailsShift: { x: detailsAfter.left - detailsBefore.left, y: detailsAfter.top - detailsBefore.top },
    selection: { planning: planningSelection, navigating: navigationSelection,
      selectedIndex, farFromRoute, planningClearedOffRoute, navigationClearedOffRoute },
    navElevationHeight,
    estimates: { etaClock, etaRemaining },
    etaInsideProgress: etaRect.right <= progressRect.right - 4,
    chartDetailsClearance: detailsAfter.top - chartRect.bottom,
  };
  stopTurnNavigation(false);
  dismissRoadInfo();
  result.selection.cleared = !document.getElementById('rcElevCanvas')
    .dataset.selectedDistanceM;
  return result;
});
check('starting navigation keeps the permanent sheet on Route',
  navigationTab.navigating && navigationTab.activeTab === 'tab-route'
    && navigationTab.oldNavigationRemoved && navigationTab.panelOpen
    && navigationTab.navTipsVisible && navigationTab.navTipsSize.width >= 34
    && navigationTab.navTipsSize.height >= 34 && navigationTab.helpRightAligned,
  JSON.stringify(navigationTab));
check('Navigate and Route Details stay put when navigation starts',
  Math.abs(navigationTab.startShift.x) <= 1 && Math.abs(navigationTab.startShift.y) <= 1
    && Math.abs(navigationTab.detailsShift.x) <= 1 && Math.abs(navigationTab.detailsShift.y) <= 1,
  JSON.stringify(navigationTab));
check('the navigation elevation labels clear the fixed Route Details button',
  navigationTab.chartDetailsClearance >= 2, JSON.stringify(navigationTab));
check('tapping an active-route segment marks the same elevation in both views',
  Number.isFinite(navigationTab.selection.planning)
    && navigationTab.selection.planning > 0
    && navigationTab.selection.planning === navigationTab.selection.navigating
    && navigationTab.selection.selectedIndex === 3
    && navigationTab.selection.farFromRoute === null
    && navigationTab.selection.planningClearedOffRoute
    && navigationTab.selection.navigationClearedOffRoute
    && navigationTab.selection.cleared,
  JSON.stringify(navigationTab.selection));
check('the navigation elevation chart uses the available vertical room',
  navigationTab.navElevationHeight >= 66, JSON.stringify(navigationTab));
check('the navigation estimate alternates between arrival time and time left',
  /^ETA /.test(navigationTab.estimates.etaClock)
    && /^~1 hr 3 min left$/.test(navigationTab.estimates.etaRemaining),
  JSON.stringify(navigationTab));
check('the navigation estimate stays inset from the card edge',
  navigationTab.etaInsideProgress, JSON.stringify(navigationTab));

// The same control in two places. It read "Details" at one size on the route
// card and another in the navigation footer, which made them look like two
// different buttons for two different things.
const detailsButtons = await page.evaluate(() => {
  const size = (node) => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { width: Math.round(rect.width), height: Math.round(rect.height),
      lines: [...node.querySelectorAll('span')].map((span) => span.textContent.trim()) };
  };
  document.body.classList.add('navigation-active');
  document.getElementById('navCard').hidden = false;
  const nav = size(document.getElementById('navCardDetailsBtn'));
  document.getElementById('navCard').hidden = true;
  document.body.classList.remove('navigation-active');
  return { card: size(document.querySelector('#routeCard .route-details-btn')), nav };
});
check('the route-details button is the same size in both views',
  detailsButtons.card && detailsButtons.nav
    && detailsButtons.card.width === detailsButtons.nav.width
    && detailsButtons.card.height === detailsButtons.nav.height,
  JSON.stringify(detailsButtons));
check('and reads "Route Details" on two lines',
  ['card', 'nav'].every((key) =>
    detailsButtons[key]?.lines.join(' ') === 'Route Details'),
  JSON.stringify(detailsButtons));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
