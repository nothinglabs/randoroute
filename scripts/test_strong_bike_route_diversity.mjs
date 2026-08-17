#!/usr/bin/env node
// A strong signed-route preference must not collapse the whole chooser.
//
// Field case: U Village -> Woodland Park Zoo returned one 5.7 mi letter when
// "Follow designated bike routes even if they fail safety rules" was on. The
// normal profiles and the automatic more-direct lens all trusted the same
// signed corridor, so no search was capable of leaving it. The lens is the
// portfolio's bounded escape hatch: it relaxes that routing preference for one
// candidate while the rider's real rules continue to admit, score, and colour
// every returned segment.
import { appPage, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};

await page.evaluate(() => {
  routing.start = [-122.2987, 47.6616];
  routing.end = [-122.3507, 47.6688];
  routing.prefDesig = true;
  routing.prefResidential = true;
  rules.alwaysPreferBikeRoutes = true;
  computeRoute();
});
await page.waitForFunction(() => !routing.routeRequestActive && routing.options?.length,
  null, { timeout: 180000 });

const result = await page.evaluate(() => ({
  count: routing.options.length,
  ids: routing.options.map((option) => option.optimization?.profileId),
  miles: routing.options.map((option) => +(option.distM / 1609.344).toFixed(2)),
  preferenceStillOn: rules.alwaysPreferBikeRoutes,
}));
check('the strong signed-route preference still offers a real alternative',
  result.count >= 2, JSON.stringify(result));
check('the bounded direct lens supplies an escape corridor',
  result.ids.some((id) => String(id).startsWith('direct-lens')), JSON.stringify(result));
check('the rider’s signed-route preference remains enabled',
  result.preferenceStillOn === true, JSON.stringify(result));

await browser.close();
await site.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
