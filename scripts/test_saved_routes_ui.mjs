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
  const route = { ok: true, distM: 85616, timeS: 16200, maxGradePct: 7, coords, segs };
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
  return {
    height: root.getBoundingClientRect().height,
    overviewWidth: overview.width,
    chartWidth: chart.width,
    categoryWidth: categories.width,
    metricsHeight: metrics.height,
    metricsSpanRightColumns: Math.abs(metrics.left - chart.left) < 1
      && Math.abs(metrics.right - categories.right) < 1,
    metricLabels,
    clipped,
  };
});
check('long route distance and metrics fit without clipping',
  routeCardLayout.clipped.length === 0, JSON.stringify(routeCardLayout));
check('the chart yields width to the category list',
  routeCardLayout.overviewWidth >= 92
    && routeCardLayout.chartWidth < routeCardLayout.categoryWidth,
  JSON.stringify(routeCardLayout));
check('unpaved and incline share one compact full-width strip',
  routeCardLayout.metricsHeight <= 24 && routeCardLayout.metricsSpanRightColumns
    && routeCardLayout.height <= 100,
  JSON.stringify(routeCardLayout));
check('incline appears before unpaved and unpaved uses miles',
  routeCardLayout.metricLabels[0]?.includes('Incline over 5%')
    && routeCardLayout.metricLabels[1] === '1.1 miUnpaved',
  JSON.stringify(routeCardLayout.metricLabels));
await page.evaluate(() => localStorage.setItem('wa-bike-saved-routes-1', JSON.stringify([{
  name: 'Lake loop', s: [-122.34, 47.60], e: [-122.30, 47.64], v: [], b: [],
}]))) ;
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
  };
});
check('a saved route is an explicit load action', layout.loadText === 'Lake loopLoad ›',
  JSON.stringify(layout));
check('shared-link loading is a separate section at the bottom', layout.importBelowSaved,
  JSON.stringify(layout));
check('the route-library button uses a floppy-disk drawing', layout.floppyPaths === 2,
  JSON.stringify(layout));

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

const navigationTab = await page.evaluate(() => {
  document.getElementById('routesDialog')?.close();
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
    watchPosition: () => 1,
    clearWatch: () => {},
  } });
  document.body.classList.add('panel-open');
  selectPanelTab('settings');
  document.getElementById('navStartButton').click();
  const active = document.querySelector('.tab.active');
  const result = {
    navigating: turnNav.active,
    activeTab: active?.id,
    routePressed: document.querySelector('#tabs [data-tab="route"]')?.getAttribute('aria-pressed'),
    panelOpen: document.body.classList.contains('panel-open'),
  };
  stopTurnNavigation(false);
  return result;
});
check('starting navigation returns an open menu to the Route tab',
  navigationTab.navigating && navigationTab.activeTab === 'tab-route'
    && navigationTab.routePressed === 'true' && navigationTab.panelOpen,
  JSON.stringify(navigationTab));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
