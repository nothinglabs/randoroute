#!/usr/bin/env node
// An installed state's map update announces itself: a rider must not have to
// open the Maps screen to learn their map is stale. The banner compares the
// installed registry against the app-shipped index, so it works offline on
// the first boot after an app update. Dismissal is per offered acquisition
// set -- the banner returns only for a NEWER update -- and the single-state
// Update button drives the real store download into a reboot.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { check, done, launchBrowser, ROOT, serveRepo } from './testlib/harness.mjs';

const require = createRequire(import.meta.url);
const registry = require('../maps/states.js');

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)'
  + ' AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const realIndex = JSON.parse(readFileSync(join(ROOT, 'maps/index.json'), 'utf8'));
const washington = realIndex.states.find((state) => state.id === 'washington');
// The installed registry entry: same state, but its map acquisition id is one
// release behind the shipped index.
const staleState = structuredClone(washington);
const staleMap = staleState.acquisitions.find((unit) => unit.kind === 'state-map');
staleMap.id = 'map-washington-previous-release';
const installedEntry = JSON.stringify([{ state: staleState, storeUrl: 'maps/',
  installedAt: 1756000000000, cachedRequests: [] }]);

const site = await serveRepo();
site.publish('/maps/states.js', `(function (root) {
  root.MAP_STATES_BUNDLED = false;
  root.MAP_STATES = ${JSON.stringify(registry.MAP_STATES)};
  root.MAP_STATE_ACQUISITIONS = ${JSON.stringify(registry.MAP_STATE_ACQUISITIONS)};
}(typeof self !== 'undefined' ? self : this));`);

const browser = await launchBrowser();
try {
  const context = await browser.newContext({ serviceWorkers: 'block',
    userAgent: IPHONE_UA, viewport: { width: 430, height: 900 },
    hasTouch: true, isMobile: true });
  await context.addInitScript(`try {
    localStorage.setItem('jra-installed-states-1', ${JSON.stringify(installedEntry)});
  } catch (e) {}`);
  const page = await context.newPage();
  await page.goto(`http://localhost:${site.port}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.Region && Region.localDataAvailable === true,
    null, { timeout: 90000 });
  await page.waitForFunction(() => !document.getElementById('mapDataUpdatePrompt').hidden,
    null, { timeout: 30000 });
  const shown = await page.evaluate(() => ({
    text: document.getElementById('mapDataUpdateText').textContent,
    button: document.getElementById('mapDataUpdateBtn').textContent,
  }));
  check('a stale installed map announces its update with the state name and size',
    /Washington map update available \(.+\)/.test(shown.text) && shown.button === 'Update',
    JSON.stringify(shown));

  // Dismiss, reload: the same offer stays quiet.
  await page.evaluate(() => document.getElementById('mapDataUpdateLaterBtn').click());
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.Region && Region.localDataAvailable === true,
    null, { timeout: 90000 });
  await page.waitForTimeout(5500);
  const afterDismiss = await page.evaluate(() =>
    document.getElementById('mapDataUpdatePrompt').hidden);
  check('a dismissed offer stays dismissed across boots', afterDismiss === true,
    String(afterDismiss));

  // A NEWER update -- the next app release ships an index that moved again --
  // re-announces on its first boot despite the earlier dismissal, which was
  // keyed to the previous offer.
  const nextIndex = structuredClone(realIndex);
  nextIndex.states.find((state) => state.id === 'washington')
    .acquisitions.find((unit) => unit.kind === 'state-map').id = 'map-washington-next-release';
  const nextAcquisitions = structuredClone(registry.MAP_STATE_ACQUISITIONS);
  nextAcquisitions.washington
    .find((unit) => unit.kind === 'state-map').id = 'map-washington-next-release';
  site.publish('/maps/index.json', JSON.stringify(nextIndex));
  site.publish('/maps/states.js', `(function (root) {
  root.MAP_STATES_BUNDLED = false;
  root.MAP_STATES = ${JSON.stringify(registry.MAP_STATES)};
  root.MAP_STATE_ACQUISITIONS = ${JSON.stringify(nextAcquisitions)};
}(typeof self !== 'undefined' ? self : this));`);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.Region && Region.localDataAvailable === true,
    null, { timeout: 90000 });
  await page.waitForFunction(() => !document.getElementById('mapDataUpdatePrompt').hidden,
    null, { timeout: 30000 });
  check('a newer update re-announces past an old dismissal', true, '');

  // The Update button drives the real store path into the reboot decision.
  const rebooted = await page.evaluate(async () => {
    let called = 0;
    window.rebootIntoInstalledHomeState = () => { called += 1; };
    window.MapStore.installState = async () => {};
    document.getElementById('mapDataUpdateBtn').click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    return called;
  });
  check('the banner update reaches the reboot', rebooted === 1, String(rebooted));
} finally {
  await browser.close();
  site.close();
}

done();
