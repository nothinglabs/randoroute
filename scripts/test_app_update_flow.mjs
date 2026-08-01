#!/usr/bin/env node
// Taking an update, the way a rider does.
//
// Three things were wrong with it, and none of them could be seen from the
// code alone -- they only appear when a release is actually published to a
// running app, which is what this file does: it serves the app, installs it,
// then changes the bytes on the server and watches what happens.
//
//   1. It asked twice. Every time. index.html registered the worker at
//      `./sw.js?release=<version>`, so the script URL changed on every
//      release -- and to a browser a changed script URL IS an update. Taking
//      one installed the new worker and reloaded; the reload then registered
//      the NEXT url for the very same bytes, which installed again and asked
//      again.
//   2. A first visit reloaded itself. The worker calls clients.claim() on
//      activate, which fires controllerchange, which the app read as "a new
//      version took over" -- throwing away a freshly started app.
//   3. Checking took as long as the whole install dance even when there was
//      nothing to install, showing an unchanging "Checking..." throughout.
//      The usual answer is "you are up to date" and it is one small fetch away.
import { playwright, chromiumPath, serveRepo } from './testlib/harness.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './testlib/harness.mjs';

const { chromium } = await playwright();
const site = await serveRepo();
const browser = await chromium.launch({
  executablePath: chromiumPath(), args: ['--use-gl=swiftshader'],
});
// The service worker is the subject; do not block it.
const context = await browser.newContext({ viewport: { width: 1100, height: 850 } });
const page = await context.newPage();
page.setDefaultTimeout(180000);

let pass = 0;
const check = (name, ok, detail = '') => {
  if (!ok) { console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`); process.exitCode = 1; }
  else { pass++; console.log(`PASS  ${name}${detail ? `  -- ${detail}` : ''}`); }
};

const navigations = [];
page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push(Date.now()); });

/* ------------------------------------------------------------- first visit */
await page.goto(site.url, { waitUntil: 'load' });
await page.waitForFunction(() => navigator.serviceWorker.controller != null, { timeout: 120000 });
await page.waitForTimeout(8000);      // long enough for a spurious reload to land
check('a first visit does not reload itself', navigations.length === 1,
  `${navigations.length} navigations`);

const workerScript = async () => page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  return {
    active: reg?.active?.scriptURL?.replace(/^.*\//, '') || null,
    waiting: reg?.waiting?.scriptURL?.replace(/^.*\//, '') || null,
  };
}).catch(() => ({ active: '(navigating)', waiting: null }));
const installed = await workerScript();
check('the worker is registered at a stable url', installed.active === 'sw.js',
  `registered as ${installed.active}`);

/* -------------------------------------------- checking with nothing to get */
const answer = async () => page.evaluate(async () => {
  document.getElementById('appHelpDialog')?.showModal?.();
  const status = document.getElementById('updateCheckStatus');
  status.textContent = '';
  document.getElementById('checkUpdatesBtn').click();
  const started = performance.now();
  while (performance.now() - started < 60000) {
    const text = status.textContent || '';
    if (text && text !== 'Checking…') return { text, ms: Math.round(performance.now() - started) };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { text: status.textContent || '(nothing)', ms: -1 };
});
const first = await answer();
check('an up-to-date check answers promptly', first.ms >= 0 && first.ms < 5000,
  `${first.ms} ms: "${first.text}"`);
check('and says so', /latest version/i.test(first.text), first.text);
// The button re-enables on every path, including the quick ones. It used to
// re-enable only on the slow path, so the first check left it dead.
const second = await answer();
check('the button still works on a second check', second.ms >= 0 && second.ms < 5000,
  `${second.ms} ms: "${second.text}"`);

/* --------------------------------------------------------- publish a release */
const newVersion = '2026-12-25.999';
site.publish('/version.json', JSON.stringify({ version: newVersion }));
site.publish('/sw.js', readFileSync(join(ROOT, 'sw.js'), 'utf8')
  .replace(/const VERSION = 'v\d+'/, "const VERSION = 'v9999'"));

const promptShown = () => page.waitForFunction(() => {
  const prompt = document.getElementById('updatePrompt');
  return prompt && !prompt.hidden;
}, { timeout: 90000 }).then(() => true).catch(() => false);

await page.evaluate(() => {
  document.getElementById('appHelpDialog')?.showModal?.();
  document.getElementById('checkUpdatesBtn').click();
});
check('a published release is offered', await promptShown());

/* ------------------------------------------------------------- take it once */
const before = navigations.length;
await page.evaluate(() => document.getElementById('getUpdateBtn').click());
await page.waitForFunction((n) => navigator.serviceWorker.controller != null && n >= 0, before)
  .catch(() => {});
await page.waitForTimeout(10000);
check('accepting the update restarts the app', navigations.length > before,
  `${navigations.length - before} navigations`);

await page.waitForFunction(() => navigator.serviceWorker.controller != null, { timeout: 60000 })
  .catch(() => {});
// The whole point: after the restart, it must be done asking.
await page.waitForTimeout(8000);
const askedAgain = await page.evaluate(() => {
  const prompt = document.getElementById('updatePrompt');
  return !!prompt && !prompt.hidden;
});
check('it does not ask again after the restart', !askedAgain);
const settled = await workerScript();
check('and the worker url has not drifted', settled.active === 'sw.js',
  `active ${settled.active}, waiting ${settled.waiting}`);

await browser.close();
site.close();
console.log(`\n${pass} checks passed`);
