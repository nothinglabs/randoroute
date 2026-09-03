#!/usr/bin/env node
// The map's Layers button opens a compact guide to every icon that can appear
// on an active route. It is a companion to that one entry path, not permanent
// furniture on every way the Layers pane can be reached.
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

const programmatic = await page.evaluate(() => {
  selectPanelTab('layers');
  const hidden = document.getElementById('activeRouteIconLegend').hidden;
  selectPanelTab('route');
  return hidden;
});
check('opening Layers from another UI path does not open the icon guide', programmatic);

// Routing may still be animating the mobile panel after app-ready; invoke the
// control's real click handler directly so this guide test does not wait for an
// unrelated layout-stability window.
await page.evaluate(() => document.getElementById('layersToggle').click());
const opened = await page.evaluate(() => {
  const legend = document.getElementById('activeRouteIconLegend');
  const items = [...legend.querySelectorAll('.active-route-icon-item')];
  return {
    title: document.getElementById('activeRouteIconLegendTitle').textContent,
    visible: !legend.hidden,
    layersOpen: document.getElementById('tab-layers').classList.contains('active'),
    count: items.length,
    height: legend.getBoundingClientRect().height,
    width: legend.getBoundingClientRect().width,
    itemHeights: items.map((item) => item.getBoundingClientRect().height),
    intro: legend.querySelector('.active-route-icon-intro')?.textContent,
    introFont: parseFloat(getComputedStyle(legend.querySelector('.active-route-icon-intro')).fontSize),
    gridColumns: getComputedStyle(document.getElementById('activeRouteIconLegendItems')).gridTemplateColumns,
    hasKicker: /Map guide/i.test(legend.textContent),
    labels: items.map((item) => item.getAttribute('aria-label')),
    hasSecondaryCopy: items.some((item) => item.querySelector('small')),
    colorCount: legend.querySelectorAll('.active-route-color-item, .active-route-color-guide').length,
    painted: items.every((item) => {
      const canvas = item.querySelector('canvas');
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      return pixels.some((value, index) => index % 4 === 3 && value > 0);
    }),
  };
});
check('the map legend button opens Route Icons with the Layers pane',
  opened.visible && opened.layersOpen && opened.title === 'Route Icons'
    && !opened.hasKicker && opened.height > 140 && opened.height <= 260
    && opened.width >= 375 && Math.max(...opened.itemHeights) <= 40
    && opened.intro === 'Tap a route or icon in the map for details.'
    && opened.introFont >= 13,
  JSON.stringify(opened));
check('the retired Route colors section stays gone', opened.colorCount === 0,
  JSON.stringify(opened));
check('all six useful route icon meanings are present, concise, and painted',
  opened.count === 6 && opened.painted
    && opened.labels.some((label) => /Bike route fails rules/.test(label))
    && !opened.labels.some((label) => /MTB|Technical trail/.test(label))
    && !opened.labels.some((label) => /Ferry/.test(label))
    && opened.labels.every((label) => label.includes(':'))
    && !opened.hasSecondaryCopy,
  JSON.stringify(opened));

await page.evaluate(() => document.getElementById('activeRouteIconLegendClose').click());
let closed = await page.evaluate(() => ({
  legendHidden: document.getElementById('activeRouteIconLegend').hidden,
  layersOpen: document.getElementById('tab-layers').classList.contains('active'),
}));
check('closing the icon guide also closes Map Layers',
  closed.legendHidden && !closed.layersOpen, JSON.stringify(closed));

await page.evaluate(() => document.getElementById('layersToggle').click());
await page.evaluate(() => document.getElementById('layersPanelClose').click());
closed = await page.evaluate(() => ({
  legendHidden: document.getElementById('activeRouteIconLegend').hidden,
  layersOpen: document.getElementById('tab-layers').classList.contains('active'),
}));
check('closing Map Layers also closes the icon guide',
  closed.legendHidden && !closed.layersOpen, JSON.stringify(closed));

const bottomControls = await page.evaluate(() => {
  const centerX = (element) => {
    const rect = element.getBoundingClientRect();
    return (rect.left + rect.right) / 2;
  };
  return {
    locationX: centerX(document.querySelector('.maplibregl-ctrl-geolocate')),
    attributionX: centerX(document.querySelector('.maplibregl-ctrl-attrib')),
    inTopLeft: !!document.querySelector('.maplibregl-ctrl-top-left .maplibregl-ctrl-geolocate'),
  };
});
// The location button moved from the bottom-right corner to the top-left
// column under the trip card; the attribution keeps the bottom-right lane.
check('the location button sits in the top-left column, clear of the attribution',
  bottomControls.inTopLeft && bottomControls.locationX < bottomControls.attributionX,
  JSON.stringify(bottomControls));
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

// Desktop has room for both companion panels. Opening the icon guide must not
// hide the Layers panel beneath it (the regression this arrangement guards).
const desktopContext = await browser.newContext({
  serviceWorkers: 'block', viewport: { width: 1200, height: 820 },
  hasTouch: false, isMobile: false,
});
const desktopPage = await desktopContext.newPage();
const desktopErrors = [];
desktopPage.on('pageerror', (error) => desktopErrors.push(error.message));
await desktopPage.goto(site.url, { waitUntil: 'load' });
await desktopPage.waitForFunction(() =>
  document.documentElement.classList.contains('app-ready'), null, { timeout: 120000 });
await desktopPage.evaluate(() => document.getElementById('layersToggle').click());
const desktopPanels = await desktopPage.evaluate(() => {
  const rect = (element) => {
    const box = element.getBoundingClientRect();
    return { top: box.top, right: box.right, bottom: box.bottom, left: box.left };
  };
  const overlaps = (a, b) =>
    !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
  const layers = document.getElementById('panel');
  const legend = document.getElementById('activeRouteIconLegend');
  const layersBox = rect(layers);
  const legendBox = rect(legend);
  return {
    layersVisible: document.getElementById('tab-layers').classList.contains('active'),
    legendVisible: !legend.hidden,
    overlap: overlaps(layersBox, legendBox),
    layersBox,
    legendBox,
  };
});
check('desktop keeps Map Layers visible beside the Route Icons guide',
  desktopPanels.layersVisible && desktopPanels.legendVisible && !desktopPanels.overlap,
  JSON.stringify(desktopPanels));
check('desktop icon guide opens without page errors', desktopErrors.length === 0,
  desktopErrors.slice(0, 3).join(' | '));
await desktopContext.close();

console.log(`\n${passed} passed, ${failed} failed`);
await browser.close();
site.close();
process.exit(failed ? 1 : 0);
