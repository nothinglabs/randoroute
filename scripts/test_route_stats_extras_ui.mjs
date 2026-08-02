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

const detailsUrl = site.url.replace('/index.html', '/route-details.html');
await page.goto(detailsUrl, { waitUntil: 'load' });
await page.evaluate(() => localStorage.setItem('wa-bike-route-details-1', JSON.stringify({
  summary: { distM: 6836, timeS: 2400, ascentM: 20, descentM: 10 },
  rules: { minShoulder: 4 },
  segs: [
    { name: 'Ferry', mph: 15, sh: -1, flags: 32, level: 2, lenM: 1609 },
    { name: 'Walk link', mph: 10, sh: 4, flags: 0, official: 8, dismount: true,
      level: 3, lenM: 400, displayCategory: 'caution' },
    { name: '35 road', mph: 35, sh: 4, flags: 0, level: 1, lenM: 1609,
      displayCategory: 'pass' },
    { name: '45 road', mph: 45, sh: 4, flags: 0, level: 1, lenM: 1609,
      displayCategory: 'pass' },
    { name: '55 road', mph: 55, sh: 4, flags: 0, level: 1, lenM: 1609,
      displayCategory: 'pass' },
  ],
})));
await page.reload({ waitUntil: 'load' });
const rendered = await page.evaluate(() => ({
  summary: document.getElementById('summary').textContent.replace(/\s+/g, ' ').trim(),
  quickSummary: document.getElementById('summaryMix').textContent.replace(/\s+/g, ' ').trim(),
  elevation: document.getElementById('summarySub').textContent.replace(/\s+/g, ' ').trim(),
  quickSummaryHeight: document.getElementById('routeQuickSummary').getBoundingClientRect().height,
  categoryLabelLines: [...document.querySelectorAll('.route-summary-category-item > span:last-child')]
    .map((label) => Math.round(label.getBoundingClientRect().height
      / Number.parseFloat(getComputedStyle(label).lineHeight))),
  categorySwatches: [...document.querySelectorAll('.route-summary-category-swatch')]
    .map((swatch) => ({ width: swatch.getBoundingClientRect().width,
      height: swatch.getBoundingClientRect().height })),
  speed: document.getElementById('summaryRoadSpeed').textContent.replace(/\s+/g, ' ').trim(),
  speedLabels: [...document.querySelectorAll('#summaryRoadSpeed .speed-limit-metric > span')]
    .map((label) => ({ text: label.textContent.trim(), bold: label.querySelector('strong')?.textContent })),
  shoulder: document.getElementById('speedShoulderNote').textContent.replace(/\s+/g, ' ').trim(),
}));
check('Stats summarizes ferry distance in miles', /Ferry 1\.0 mi/.test(rendered.summary), rendered.summary);
check('Stats summarizes dismount distance', /Dismount 0\.2 mi/.test(rendered.summary), rendered.summary);
check('the 5% grade metric moved out of the top summary',
  !/Incline over 5%|5%\+ uphill/.test(rendered.quickSummary), rendered.quickSummary);
check('Elevation includes the 5% grade percentage',
  /5%\+ uphill\s*\d+(?:\.\d+)?% of route/.test(rendered.elevation), rendered.elevation);
check('the phone summary stays compact with ferry and dismount rows',
  rendered.quickSummaryHeight <= 80, `${rendered.quickSummaryHeight}px`);
check('all category labels stay on one line at phone width',
  rendered.categoryLabelLines.every((lines) => lines === 1), JSON.stringify(rendered.categoryLabelLines));
check('the five route-category color swatches are large enough to scan',
  rendered.categorySwatches.length === 5
    && rendered.categorySwatches.every(({ width, height }) => width >= 18 && height >= 9),
  JSON.stringify(rendered.categorySwatches));
check('Speed Limits includes the 55+ mph row', /At least 55 mph\s*1\.0 mi/.test(rendered.speed), rendered.speed);
check('Speed Limits omits average and maximum rows', !/Avg\. limit|Max limit/.test(rendered.speed), rendered.speed);
check('the threshold speeds are bold inside their labels',
  JSON.stringify(rendered.speedLabels) === JSON.stringify([
    { text: 'At least 35 mph', bold: '35 mph' },
    { text: 'At least 45 mph', bold: '45 mph' },
    { text: 'At least 55 mph', bold: '55 mph' },
  ]), JSON.stringify(rendered.speedLabels));
check('the shoulder statistic omits “confirmed”', !/confirmed/i.test(rendered.shoulder), rendered.shoulder);
check('the rendered Stats page has no JavaScript errors', errors.length === 0, errors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
