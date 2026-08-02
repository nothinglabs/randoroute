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
// A sidewalk fallback is described by what it is, not by which area category
// the road sits in. Render one and read the card.
await page.evaluate(() => localStorage.setItem('wa-bike-route-details-1', JSON.stringify({
  summary: { distM: 500, timeS: 200, ascentM: 0, descentM: 0 },
  rules: {
    maxSpeedNoShoulder: 35, minShoulder: 4, inferShoulderFromEdge: false,
    lanesNoShoulderOver: 6, busyNoShoulder: 0,
    noUpperLimit: true, upperMaxSpeed: 45, allowSidewalkFallback: true,
  },
  segs: [{
    name: 'Sidewalk Fallback Road', mph: 45, sh: 0, flags: 0, facility: 0,
    official: 16, lanes: 2, measures: null, level: 3, lenM: 500,
    displayCategory: 'caution', cautionCause: 'sidewalk-fallback',
  }],
})));
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('#concern-sidewalk-fallback');
await page.click('#concern-sidewalk-fallback .concern-section-toggle');
const fallbackText = await page.locator('#concern-sidewalk-fallback .detail-item').innerText();
check('a sidewalk fallback is described as one', /mapped sidewalk fallback/i.test(fallbackText),
  fallbackText);
check('and not by an area category', !/urban|rural/i.test(fallbackText), fallbackText);

// The stored payload has to carry `measures`, or the safety model on this page
// judges a different road from the one the router judged: no traffic count, no
// functional class, no edge space.
const stored = await page.evaluate(async () => {
  const app = window.open('/index.html', '_blank');
  await new Promise((resolve) => app.addEventListener('load', resolve, { once: true }));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const seg = { name: 'Measured Road', mph: 45, sh: 0, flags: 0, facility: 0, lenM: 100,
    official: 0, lanes: 2, level: 4, c0: 0, c1: 1,
    measures: { adt: 12000, fc: 3, edge: 5 } };
  app.storeRouteDetails({ ok: true, distM: 100, timeS: 30, coords: [[-122.3, 47.6], [-122.29, 47.6]],
    segs: [seg] });
  const payload = JSON.parse(app.localStorage.getItem('wa-bike-route-details-1') || 'null');
  app.close();
  return payload?.segs?.[0]?.measures || null;
});
check('the stored route keeps the measurements the safety model needs',
  stored && stored.adt === 12000 && stored.fc === 3 && stored.edge === 5,
  JSON.stringify(stored));

check('the rendered details page has no JavaScript errors', errors.length === 0, errors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
