#!/usr/bin/env node
// Boot must survive poisoned storage. The installed-states registry is a
// BOOT dependency -- region.js maps its entries into the state list before
// anything else runs -- and one wrong-shaped entry used to throw there and
// brick every subsequent launch ("Region is not defined", white app, and
// the poison persists across reloads). A rider cannot fix that; the app
// has to. Registry reads now drop malformed entries, and region.js belts
// the same boundary.
import { check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)'
  + ' AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const KEYS = ['wa-bike-state-1', 'wa-bike-saved-routes-1', 'jra.graphDataVersion',
  'jra-pending-map-route-intent-1', 'jra-installed-states-1', 'jra-map-state-1'];
// The registry-shaped poison is the one that bricked boot: a valid ARRAY
// whose entries are not registry entries. The parse succeeds; the shape is
// wrong everywhere it is read.
const POISONS = [
  ['registry-shaped junk', JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ i })))],
  ['unparseable', '{{{{'],
];
const site = await serveRepo();
const browser = await launchBrowser();
try {
  for (const [name, poison] of POISONS) {
    const context = await browser.newContext({ serviceWorkers: 'block',
      userAgent: IPHONE_UA, viewport: { width: 430, height: 900 },
      hasTouch: true, isMobile: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 120)));
    await context.addInitScript(({ keys, value }) => {
      try { for (const key of keys) localStorage.setItem(key, value); } catch (e) {}
    }, { keys: KEYS, value: poison });
    await page.goto(`http://localhost:${site.port}/index.html`, { waitUntil: 'load' });
    const ready = await page.waitForFunction(() =>
      document.documentElement.classList.contains('app-ready')
      && window.map && map.loaded && map.loaded()
      && !!window.Region?.id, null, { timeout: 90000 })
      .then(() => true).catch(() => false);
    check(`the app boots to a live map with ${name} in every stored key`,
      ready && errors.length === 0, JSON.stringify(errors.slice(0, 4)));
    await context.close();
  }
} finally {
  await browser.close();
  site.close();
}

done();
