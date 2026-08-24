#!/usr/bin/env node
// A resurrected iOS PWA can serve empty localStorage reads for the first
// moments of a launch. region.js decides localDataAvailable synchronously in
// that window, so a slim-shell device with its home state fully installed
// boots as if it had no data: national map, no prompt, while Settings and the
// restored route read healthy storage moments later. Field (.808): exactly
// that, recovered only by force-killing the PWA. The app must notice the
// registry holds the active state after all and reboot itself once -- and a
// registry that is truly empty must never reload-loop. Installing the
// data-less home state's pack must also reboot rather than reporting "ready
// to use" over a national map.
import { check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const registry = require('../maps/states.js');

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)'
  + ' AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const site = await serveRepo();
// The slim world: states are indexed but nothing is bundled; only the
// installed-states registry makes data local.
site.publish('/maps/states.js', `(function (root) {
  root.MAP_STATES_BUNDLED = false;
  root.MAP_STATES = ${JSON.stringify(registry.MAP_STATES)};
  root.MAP_STATE_ACQUISITIONS = ${JSON.stringify(registry.MAP_STATE_ACQUISITIONS)};
}(typeof self !== 'undefined' ? self : this));`);

const washington = registry.MAP_STATES.find((state) => state.id === 'washington');
const installedEntry = JSON.stringify([{
  state: { ...washington, acquisitions: registry.MAP_STATE_ACQUISITIONS.washington },
  storeUrl: 'maps/', installedAt: 1756000000000, cachedRequests: [],
}]);

const browser = await launchBrowser();
try {
  // Phase 1: registry present, but every storage read is blind for the first
  // 1200ms of the first boot. window.name survives reloads with no storage,
  // so each boot appends its own verdict: B = booted dataless, H = healthy.
  const blind = await browser.newContext({ serviceWorkers: 'block',
    userAgent: IPHONE_UA, viewport: { width: 430, height: 900 },
    hasTouch: true, isMobile: true });
  await blind.addInitScript(`(() => {
    try { localStorage.setItem('jra-installed-states-1', ${JSON.stringify(installedEntry)}); }
    catch (e) {}
    if (!location.hash.includes('jra-storage-retry')) {
      const real = Storage.prototype.getItem;
      const start = Date.now();
      Storage.prototype.getItem = function (key) {
        if (Date.now() - start < 1200) return null;
        return real.call(this, key);
      };
    }
    document.addEventListener('DOMContentLoaded', () => {
      window.name += window.Region && Region.localDataAvailable ? 'H' : 'B';
    });
  })()`);
  const page = await blind.newPage();
  await page.goto(`http://localhost:${site.port}/index.html`, { waitUntil: 'commit' });
  // The heal reload destroys any in-page waiter mid-flight, so poll from
  // Node and treat a destroyed context as "navigating, try again".
  let healed = null;
  for (let attempt = 0; attempt < 60 && !healed; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const state = await page.evaluate(() => ({
        boots: window.name,
        localData: window.Region ? Region.localDataAvailable : null,
        hash: location.hash,
        stateId: window.Region?.id || null,
      }));
      if (state.boots.endsWith('H')) healed = state;
    } catch (error) { /* reload in progress */ }
  }
  healed = healed || { boots: 'never healed' };
  check('a storage-blind boot of an installed home state reboots itself healthy',
    healed.boots === 'BH' && healed.localData === true && healed.stateId === 'washington'
      && healed.hash === '', JSON.stringify(healed));
  await page.waitForTimeout(3000);
  const settled = await page.evaluate(() => window.name);
  check('the healed session stays put', settled === 'BH', settled);
  await blind.close();

  // Phase 2: a registry that is truly empty. The heal must give up without a
  // reload, and installing the home state's pack through the store flow must
  // reach the reboot decision instead of leaving the national map up.
  const empty = await browser.newContext({ serviceWorkers: 'block',
    userAgent: IPHONE_UA, viewport: { width: 430, height: 900 },
    hasTouch: true, isMobile: true });
  await empty.addInitScript(`document.addEventListener('DOMContentLoaded', () => {
    window.name += window.Region && Region.localDataAvailable ? 'H' : 'B';
  })`);
  const bare = await empty.newPage();
  await bare.goto(`http://localhost:${site.port}/index.html`, { waitUntil: 'load' });
  await bare.waitForTimeout(4000);
  const dataless = await bare.evaluate(() => ({
    boots: window.name, localData: Region.localDataAvailable,
  }));
  check('a genuinely dataless boot stays on the national map without reloading',
    dataless.boots === 'B' && dataless.localData === false, JSON.stringify(dataless));
  const rebooted = await bare.evaluate(async () => {
    let called = 0;
    window.rebootIntoInstalledHomeState = () => { called += 1; };
    window.MapStore.fetchIndex = async () => ({ states: [
      { id: Region.id, name: 'Washington', files: [], acquisitions: [] },
    ] });
    window.MapStore.installState = async () => {};
    await downloadStoreState('http://store.invalid/', { id: Region.id, name: 'Washington' }, null);
    return called;
  });
  check('installing the data-less home state reaches the reboot decision',
    rebooted === 1, `rebootIntoInstalledHomeState calls: ${rebooted}`);
  await empty.close();
} finally {
  await browser.close();
  site.close();
}

done();
