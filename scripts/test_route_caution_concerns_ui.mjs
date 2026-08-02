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

const detailsUrl = site.url.replace('/index.html', '/route-details.html?tab=concerns');
await page.goto(detailsUrl, { waitUntil: 'load' });
await page.evaluate(() => localStorage.setItem('wa-bike-route-details-1', JSON.stringify({
  summary: {
    distM: 450, timeS: 180, ascentM: 0, descentM: 0,
    avgUphillPct: 0, maxGradePct: 0,
  },
  rules: {
    allowSidewalkFallback: true, maxSpeedNoShoulder: 35,
    minShoulder: 4, unknownShoulderZero: true,
  },
  segs: [
    {
      name: 'High Stress Road', mph: 35, sh: 5, flags: 0, facility: 0,
      official: 0, lts: 4, level: 3, lenM: 200,
      cautionCause: 'high-stress', displayCategory: 'caution',
    },
    {
      name: 'Future Caution Road', mph: 25, sh: 5, flags: 0, facility: 0,
      official: 0, lts: 0, level: 3, lenM: 150,
      cautionCause: 'future-new-cause', displayCategory: 'caution',
    },
    {
      name: 'Passing Road', mph: 20, sh: 0, flags: 0, facility: 0,
      official: 0, lts: 0, level: 1, lenM: 100, displayCategory: 'pass',
    },
  ],
})));
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('#concern-high-stress');

const rendered = await page.evaluate(() => ({
  selectedTab: document.getElementById('tab-concerns').getAttribute('aria-selected'),
  highStressTitle: document.querySelector('#concern-high-stress .concern-section-title')?.textContent,
  highStressSummary: document.querySelector('#concern-high-stress .concern-section-summary')?.textContent,
  fallbackTitle: document.querySelector('#concern-other-cautions .concern-section-title')?.textContent,
  fallbackSummary: document.querySelector('#concern-other-cautions .concern-section-summary')?.textContent,
  alertItems: document.querySelectorAll('#routeAlert .route-alert-list li').length,
}));
check('Concerns opens with a high-stress section',
  rendered.selectedTab === 'true'
    && rendered.highStressTitle === 'Officially rated high-stress roads'
    && rendered.highStressSummary?.includes('1 item'), JSON.stringify(rendered));
check('an unknown amber cause renders in the fallback section',
  rendered.fallbackTitle === 'Other route cautions'
    && rendered.fallbackSummary?.includes('1 item'), JSON.stringify(rendered));
check('both caution groups appear in the concern summary', rendered.alertItems === 2,
  `rendered ${rendered.alertItems}`);

await page.click('#concern-high-stress .concern-section-toggle');
await page.click('#concern-other-cautions .concern-section-toggle');
const cards = await page.evaluate(() => ({
  highStress: document.querySelector('#concern-high-stress .detail-item')?.textContent,
  fallback: document.querySelector('#concern-other-cautions .detail-item')?.textContent,
}));
check('the high-stress concern produces a road card',
  cards.highStress?.includes('High Stress Road') && cards.highStress.includes('4 of 4'),
  cards.highStress || '(missing)');
check('the fallback concern produces a road card',
  cards.fallback?.includes('Future Caution Road') && cards.fallback.includes('Use caution'),
  cards.fallback || '(missing)');
check('the rendered details page has no JavaScript errors', errors.length === 0, errors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
