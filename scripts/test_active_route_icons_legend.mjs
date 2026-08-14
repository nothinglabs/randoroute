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

await page.click('#layersToggle');
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
    gridColumns: getComputedStyle(document.getElementById('activeRouteIconLegendItems')).gridTemplateColumns,
    hasKicker: /Map guide/i.test(legend.textContent),
    labels: items.map((item) => item.getAttribute('aria-label')),
    painted: items.every((item) => {
      const canvas = item.querySelector('canvas');
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      return pixels.some((value, index) => index % 4 === 3 && value > 0);
    }),
  };
});
check('the map legend button opens Route Icons with the Layers pane',
  opened.visible && opened.layersOpen && opened.title === 'Route Icons'
    && !opened.hasKicker && opened.height <= 115, JSON.stringify(opened));
check('all eight route icon meanings are present and painted',
  opened.count === 8 && opened.painted
    && opened.labels.some((label) => /Route !\?/.test(label))
    && opened.labels.some((label) => /MTB: Technical trail/.test(label))
    && opened.labels.some((label) => /Ferry/.test(label)), JSON.stringify(opened));

await page.click('#activeRouteIconLegendClose');
let closed = await page.evaluate(() => ({
  legendHidden: document.getElementById('activeRouteIconLegend').hidden,
  layersOpen: document.getElementById('tab-layers').classList.contains('active'),
}));
check('closing the icon guide also closes Map Layers',
  closed.legendHidden && !closed.layersOpen, JSON.stringify(closed));

await page.click('#layersToggle');
await page.click('#layersPanelClose');
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
  };
});
check('the location button now occupies the outer-right map corner',
  bottomControls.locationX > bottomControls.attributionX, JSON.stringify(bottomControls));
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log(`\n${passed} passed, ${failed} failed`);
await browser.close();
site.close();
process.exit(failed ? 1 : 0);
