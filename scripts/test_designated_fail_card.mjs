#!/usr/bin/env node
// A signed route is not automatically a safe road. When the same segment is
// both facts at once, the compact card must say so before Details rather than
// making the rider mentally combine a red line with buried metadata.
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

const result = await page.evaluate(() => {
  const show = (rows) => {
    renderMapTapCard({
      displayTitle: 'Test road', pointName: 'Test road', summary: '', rows,
      lngLat: { lng: -122.33, lat: 47.61 }, anchorPoint: null,
      swatchColor: RoutePalette.fail, swatchLabel: 'Fails rules',
    });
    return {
      warning: document.querySelector('.readout-designated-fail')?.textContent || '',
      beforeVerdict: Boolean(document.querySelector('.readout-designated-fail + .readout-safety-summary')),
      routeFact: [...document.querySelectorAll('.readout-core-fact')]
        .some((node) => node.textContent.includes('US Bicycle Route 95')),
    };
  };
  const designated = show([
    ['Verdict', 'Fails your rules'], ['Why', 'No shoulder'],
    ['Bike route', 'US Bicycle Route 95'],
  ]);
  const ordinary = show([
    ['Verdict', 'Fails your rules'], ['Why', 'No shoulder'],
  ]);
  return { designated, ordinary };
});

check('a failing designated route gets the combined warning',
  result.designated.warning === 'Designated Route — but Fails Safety Rules.'
    && result.designated.beforeVerdict,
  JSON.stringify(result));
check('the named bike route remains visible on the compact card',
  result.designated.routeFact, JSON.stringify(result));
check('an ordinary failure does not claim to be a designated route',
  result.ordinary.warning === '', JSON.stringify(result));
check('rendering the warning raises no page errors', page.pageErrors.length === 0,
  page.pageErrors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
