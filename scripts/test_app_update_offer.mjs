#!/usr/bin/env node
// A manual update check that finds a new worker must END somewhere visible:
// the Restart banner, or a plain status telling the rider what to do. Field:
// the pill said "Update found — installing…" forever with no Restart button
// -- the manual path attached its statechange listener without checking the
// state that was already reached, so a fast install offered nothing.
import { check, done, launchBrowser, serveRepo, ROOT } from './testlib/harness.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const site = await serveRepo();
const browser = await launchBrowser();
try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  const page = await context.newPage();
  await page.goto(`http://localhost:${site.port}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller
    && document.documentElement.classList.contains('app-ready'), null, { timeout: 120000 });

  // The next release appears: version.json moves and sw.js's bytes differ.
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  site.publish('/version.json', JSON.stringify({ version: '2099-01-01.999' }));
  site.publish('/sw.js', sw.replace(/const VERSION = 'v\d+';/, "const VERSION = 'v999';"));

  await page.evaluate(() => runManualUpdateCheck());
  await page.waitForFunction(() => {
    const banner = !document.getElementById('updatePrompt').hidden;
    const status = document.querySelector('.manual-update-status, #settingsOptions')
      ?.textContent || '';
    return banner || /reload this page|could not be installed/i.test(status);
  }, null, { timeout: 60000 });
  const outcome = await page.evaluate(() => ({
    banner: !document.getElementById('updatePrompt').hidden,
  }));
  check('a found update ends in a visible Restart offer',
    outcome.banner === true, JSON.stringify(outcome));

  // Accepting it must hand control to the new worker.
  await page.evaluate(() => document.getElementById('getUpdateBtn').click());
  let advanced = null;
  for (let attempt = 0; attempt < 24 && !advanced; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    try {
      const state = await page.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        return { waiting: !!reg.waiting, active: reg.active?.state || null };
      });
      if (!state.waiting && state.active === 'activated') advanced = state;
    } catch (error) { /* handover reload in progress */ }
  }
  check('accepting the offer activates the new worker',
    !!advanced, JSON.stringify(advanced));

  // The uncontrolled-page contract (field, 2026-08-27: a hard-reloaded
  // desktop said "tap Restart to update" while the banner refused to show):
  // offerUpdate hides on an uncontrolled page by default — the first-visit
  // guard — but shows when the manual path vouches with evenUncontrolled.
  const uncontrolled = await page.evaluate(() => {
    const banner = document.getElementById('updatePrompt');
    Object.defineProperty(navigator.serviceWorker, 'controller',
      { get: () => null, configurable: true });
    try {
      banner.hidden = true;
      offerUpdate({ fake: 1 });
      const guarded = banner.hidden;
      offerUpdate({ fake: 1 }, { evenUncontrolled: true });
      const vouched = !banner.hidden;
      return { guarded, vouched };
    } finally {
      delete navigator.serviceWorker.controller;
      banner.hidden = true;
    }
  });
  check('an uncontrolled page hides the automatic offer but shows the manual one',
    uncontrolled.guarded && uncontrolled.vouched, JSON.stringify(uncontrolled));
} finally {
  await browser.close();
  site.close();
}

done();
