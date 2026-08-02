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

await page.goto(site.url, { waitUntil: 'load' });
await page.waitForFunction(() => typeof loadSavedRoutes === 'function', { timeout: 60000 });
await page.evaluate(() => localStorage.setItem('wa-bike-saved-routes-1', JSON.stringify([{
  name: 'Lake loop', s: [-122.34, 47.60], e: [-122.30, 47.64], v: [], b: [],
}]))) ;
await page.click('#routeLibraryBtn');
await page.waitForSelector('#routesDialog[open]');

const layout = await page.evaluate(() => {
  const saved = document.querySelector('.saved-routes-section').getBoundingClientRect();
  const imported = document.querySelector('.import-route-bottom').getBoundingClientRect();
  const icon = document.querySelector('#routeLibraryBtn svg');
  return {
    loadText: document.querySelector('.saved-load')?.textContent.replace(/\s+/g, ' ').trim(),
    importBelowSaved: imported.top >= saved.bottom,
    floppyPaths: icon?.querySelectorAll('path').length || 0,
  };
});
check('a saved route is an explicit load action', layout.loadText === 'Lake loopLoad ›',
  JSON.stringify(layout));
check('shared-link loading is a separate section at the bottom', layout.importBelowSaved,
  JSON.stringify(layout));
check('the route-library button uses a floppy-disk drawing', layout.floppyPaths === 2,
  JSON.stringify(layout));

await page.click('.saved-del');
check('the X asks before deleting', await page.evaluate(() =>
  document.getElementById('deleteSavedRouteDialog').open && loadSavedRoutes().length === 1));
await page.click('#deleteSavedRouteDialog .dialog-actions [data-close="deleteSavedRouteDialog"]');
check('keeping the route leaves it saved', await page.evaluate(() => loadSavedRoutes().length === 1));
await page.click('.saved-del');
await page.click('#confirmDeleteSavedRoute');
check('confirming removes the saved route', await page.evaluate(() =>
  loadSavedRoutes().length === 0 && document.querySelectorAll('.saved-row').length === 0));
check('the saved-routes flow has no JavaScript errors', errors.length === 0, errors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
