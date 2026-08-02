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
  speed: document.getElementById('summaryRoadSpeed').textContent.replace(/\s+/g, ' ').trim(),
  shoulder: document.getElementById('speedShoulderNote').textContent.replace(/\s+/g, ' ').trim(),
}));
check('Stats summarizes ferry distance in miles', /Ferry 1\.0 mi/.test(rendered.summary), rendered.summary);
check('Stats summarizes dismount distance', /Dismount 0\.2 mi/.test(rendered.summary), rendered.summary);
check('Speed Limits includes the 55+ mph row', /At least 55 mph\s*1\.0 mi/.test(rendered.speed), rendered.speed);
check('the shoulder statistic omits “confirmed”', !/confirmed/i.test(rendered.shoulder), rendered.shoulder);
check('the rendered Stats page has no JavaScript errors', errors.length === 0, errors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
