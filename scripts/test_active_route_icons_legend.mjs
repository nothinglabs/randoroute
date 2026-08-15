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
  const colorItems = [...legend.querySelectorAll('.active-route-color-item')];
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
    descriptions: items.map((item) => item.querySelector('small')?.textContent || ''),
    colorCount: colorItems.length,
    colorLabels: colorItems.map((item) => item.textContent.replace(/\s+/g, ' ').trim()),
    colorSamples: colorItems.map((item) => {
      const sample = item.querySelector('.active-route-line');
      return {
        before: getComputedStyle(sample, '::before').backgroundColor,
        after: getComputedStyle(sample, '::after').backgroundColor,
        afterImage: getComputedStyle(sample, '::after').backgroundImage,
      };
    }),
    painted: items.every((item) => {
      const canvas = item.querySelector('canvas');
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      return pixels.some((value, index) => index % 4 === 3 && value > 0);
    }),
  };
});
check('the map legend button opens Route Icons with the Layers pane',
  opened.visible && opened.layersOpen && opened.title === 'Route Icons'
    && !opened.hasKicker && opened.height > 280 && opened.height <= 560,
  JSON.stringify(opened));
check('the guide explains every active-route color treatment',
  opened.colorCount === 6
    && opened.colorLabels.some((label) => /Off-street trail.*Separated from motor traffic/.test(label))
    && opened.colorLabels.some((label) => /Bike lane.*Marked bicycle space beside traffic/.test(label))
    && opened.colorLabels.some((label) => /Passes your rules.*within your limits/.test(label))
    && opened.colorLabels.some((label) => /Use caution.*Hill, traffic, or surface needs care/.test(label))
    && opened.colorLabels.some((label) => /Fails your rules.*exceeds a limit/.test(label))
    && opened.colorLabels.some((label) => /Designated bike route.*center still shows safety/i.test(label))
    && opened.colorSamples.every((sample) => sample.before !== sample.after
      || sample.afterImage !== 'none'), JSON.stringify(opened));
check('all six useful route icon meanings are present, explained, and painted',
  opened.count === 6 && opened.painted
    && opened.labels.some((label) => /Designated route !\?/.test(label))
    && !opened.labels.some((label) => /MTB|Technical trail/.test(label))
    && !opened.labels.some((label) => /Ferry/.test(label))
    && opened.descriptions.every((description) => description.length >= 12),
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
  };
});
check('the location button now occupies the outer-right map corner',
  bottomControls.locationX > bottomControls.attributionX, JSON.stringify(bottomControls));
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log(`\n${passed} passed, ${failed} failed`);
await browser.close();
site.close();
process.exit(failed ? 1 : 0);
