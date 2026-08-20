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
  summary: { distM: 6836, timeS: 2400, ascentM: 20, descentM: 10,
    avgUphillPct: 3.4 },
  profile: [[0, 100], [2000, 120], [4000, 115], [6836, 130]],
  rules: { minShoulder: 4 },
  segs: [
    { name: 'Ferry', mph: 15, sh: -1, flags: 32, level: 2, lenM: 1609 },
    // A walk link the build synthesised (dismount priced, official bit 8
    // only) and a stretch a mapper tagged bicycle=dismount (bits 8|128).
    // The Dismount stat counts only the second; the concerns report lists
    // both.
    { name: 'Walk link', mph: 10, sh: 4, flags: 0, official: 8, dismount: true,
      level: 3, lenM: 400, displayCategory: 'caution' },
    { name: 'Tagged dismount', mph: 10, sh: 4, flags: 0, official: 136, dismount: true,
      level: 3, lenM: 160, displayCategory: 'caution' },
    { name: '35 road', mph: 35, sh: 4, flags: 0, level: 1, lenM: 1609, gradePct: 6,
      displayCategory: 'pass' },
    { name: '45 road', mph: 45, sh: 4, flags: 0, level: 1, lenM: 1609, gradePct: 12,
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
  elevationPreviewVisible: !document.getElementById('elevationPreview').hidden,
  elevationDialogSummary: document.getElementById('elevationDialogSummary').textContent
    .replace(/\s+/g, ' ').trim(),
  quickSummaryHeight: document.getElementById('routeQuickSummary').getBoundingClientRect().height,
  mixText: [...document.querySelectorAll(
    '.route-summary-category-item, .route-summary-secondary-item')]
    .map((item) => item.textContent.replace(/\s+/g, ' ').trim()),
  categoryLabelLines: [...document.querySelectorAll('.route-summary-category-label')]
    .map((label) => Math.round(label.getBoundingClientRect().height
      / Number.parseFloat(getComputedStyle(label).lineHeight))),
  // The mix is one aligned column: every row -- the five categories AND the
  // unpaved line -- shares a right edge for its percentage and a left edge for
  // its label, with visible space between them. The shipped mess this guards
  // against read "11%Trails" across two ragged columns.
  mixAlignment: [...document.querySelectorAll(
    '.route-summary-category-item, .route-summary-secondary-item')].map((item) => {
    const pct = item.querySelector('b').getBoundingClientRect();
    // Addressed by CLASS, not position. This was `span:last-child`, and adding a
    // distance column after the label silently made it null -- the selector was
    // describing where the label sat rather than what it was.
    const label = item.querySelector('.route-summary-category-label').getBoundingClientRect();
    return { pctRight: Math.round(pct.right), labelLeft: Math.round(label.left),
      gap: Math.round(label.left - pct.right) };
  }),
  categorySwatches: [...document.querySelectorAll('.route-summary-category-swatch')]
    .map((swatch) => ({ width: swatch.getBoundingClientRect().width,
      height: swatch.getBoundingClientRect().height })),
  speed: document.getElementById('summaryRoadSpeed').textContent.replace(/\s+/g, ' ').trim(),
  speedLabels: [...document.querySelectorAll('#summaryRoadSpeed .speed-limit-metric > span')]
    .map((label) => ({ text: label.textContent.trim(), bold: label.querySelector('strong')?.textContent })),
  shoulder: document.getElementById('speedShoulderNote').textContent.replace(/\s+/g, ' ').trim(),
  dismountConcern: document.getElementById('concern-dismount')?.textContent.replace(/\s+/g, ' ') || '',
}));
check('Stats summarizes ferry distance in miles', /Ferry 1\.0 mi/.test(rendered.summary), rendered.summary);
check('the Dismount stat counts only the tagged stretch', /Dismount 0\.1 mi/.test(rendered.summary),
  rendered.summary);
check('the synthesised walk link stays out of that number', !/Dismount 0\.[23] mi/.test(rendered.summary),
  rendered.summary);
// The section renders collapsed, so the header is what a rider first sees:
// its total and count must cover BOTH stretches (400 m + 160 m ≈ 0.3 mi),
// proving the walk link the stats exclude is still reported here.
check('while the concerns report keeps both walked stretches',
  /0\.3 mi/.test(rendered.dismountConcern) && /2 items/.test(rendered.dismountConcern),
  rendered.dismountConcern.slice(0, 200));
check('the 5% grade metric moved out of the top summary',
  !/Incline over 5%|5%\+ uphill/.test(rendered.quickSummary), rendered.quickSummary);
check('Elevation reports the 5%+ uphill distance in miles',
  /5%\+ uphill\s*2\.0 mi/.test(rendered.elevation), rendered.elevation);
check('Elevation preserves the route climb, descent and modelled grades',
  /Climb\s*↗ 66 ft/.test(rendered.elevation)
    && /Descent\s*↘ 33 ft/.test(rendered.elevation)
    && /Avg\. grade\s*3\.4% uphill/.test(rendered.elevation)
    && /Max grade\s*12\.0%/.test(rendered.elevation), rendered.elevation);
check('the stored route profile reaches the rider-facing elevation preview',
  rendered.elevationPreviewVisible
    && /4\.2 mi · ↗ 66 ft climb · 3\.4% avg uphill · 12\.0% max grade/
      .test(rendered.elevationDialogSummary), rendered.elevationDialogSummary);
// One aligned row per category costs more height than the old two-column cram
// (which is why the cram existed); ~110px is the single-column layout, and the
// bound flags a regression that stacks or wraps rows rather than sub-pixel
// drift.
check('the phone summary stays a single compact card',
  rendered.quickSummaryHeight <= 118, `${rendered.quickSummaryHeight}px`);
check('every mix row aligns its percentage and its label to shared edges',
  rendered.mixAlignment.length === 6
    && rendered.mixAlignment.every(({ pctRight, labelLeft }) =>
      pctRight === rendered.mixAlignment[0].pctRight
      && labelLeft === rendered.mixAlignment[0].labelLeft),
  JSON.stringify(rendered.mixAlignment));
check('and no percentage is glued to its label',
  rendered.mixAlignment.every(({ gap }) => gap >= 3), JSON.stringify(rendered.mixAlignment));
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
// A share alone does not tell a rider what they are in for: 10% caution is a
// pleasant surprise on a four-mile ride and thirteen miles of it on a century.
// Every mix row carries both, including Unpaved.
check('every mix row shows a share AND a distance',
  rendered.mixText.length === 6
    && rendered.mixText.every((row) => /\d+%/.test(row) && /[\d.]+ mi\b/.test(row)),
  rendered.mixText.join(' | '));

check('the rendered Stats page has no JavaScript errors', errors.length === 0, errors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
