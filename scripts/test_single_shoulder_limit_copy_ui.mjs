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
  summary: { distM: 500, timeS: 200, ascentM: 0, descentM: 0 },
  rules: {
    maxSpeedNoShoulder: 35, minShoulder: 4, inferShoulderFromEdge: false,
    lanesNoShoulderOver: 6, busyNoShoulder: 0,
    noUpperLimit: true, upperMaxSpeed: 45, allowSidewalkFallback: true,
  },
  segs: [{
    name: 'Single Limit Road', mph: 45, sh: 0, flags: 0, facility: 0,
    official: 64, lanes: 2, measures: null, level: 4, lenM: 500,
    displayCategory: 'fail',
  }],
})));
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('#concern-fails');
await page.click('#concern-fails .concern-section-toggle');
const cardText = await page.locator('#concern-fails .detail-item').innerText();
check('the failure card names the single current trigger',
  cardText.includes('Shoulder or bike lane required above 35 mph'), cardText);
check('the failure card has no urban/rural limit wording',
  !/urban|rural/i.test(cardText), cardText);
check('the rendered details page has no JavaScript errors', errors.length === 0, errors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
