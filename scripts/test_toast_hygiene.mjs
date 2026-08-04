#!/usr/bin/env node
// Toasts earn their interruption.
//
// Three regressions this pins, all reported from the phone in one morning:
// startup stacked "Loading X… / X: N segments" pills on top of the routing
// progress notice; the action toast sat at safe-area+72px, directly over the
// endpoint search box while the rider was typing in it; and the snap-distance
// warning fired at 384 ft, which is an ordinary pin in a park, not news.
import { appPage, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);
await page.setViewportSize({ width: 390, height: 844 });

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};

// The sources have loaded by now (appPage waits for boot). None of that may
// have gone through the status pill -- the Layers panel carries the counts.
// The element holds a static "Loading…" placeholder from the HTML; what
// matters is whether anything ever REVEALED it, so hidden text is fine.
const status = await page.evaluate(() => {
  const pill = document.getElementById('status');
  return pill.classList.contains('hidden') ? null : pill.textContent;
});
check('source loading never talks through the status pill',
  status === null || !/segments|Loading|streaming/i.test(status), JSON.stringify(status));

// The snap warning: 384 ft of connection is normal life and stays silent;
// 650 ft is a genuine walk and warns.
const snap = await page.evaluate(() => {
  const toast = document.getElementById('routeActionToast');
  const read = () => (toast.hidden ? null : document.getElementById('routeActionText').textContent);
  showRouteActionToast('');
  notifySnapDistance({ ok: true, snapEndM: 117 }); // 384 ft
  const under = read();
  notifySnapDistance({ ok: true, snapEndM: 198 }); // 650 ft
  const over = read();
  showRouteActionToast('');
  return { under, over };
});
check('a 384 ft connection does not warn', snap.under === null, JSON.stringify(snap));
check('a 650 ft connection does', /connects .* away/.test(snap.over || ''), JSON.stringify(snap));

// Position: the toast must sit clear of the endpoint card and its search
// suggestions, and drop further when the place picker is typing.
const bands = await page.evaluate(() => {
  const toast = document.getElementById('routeActionToast');
  showRouteActionToast('measuring', { duration: 0 });
  const normal = toast.getBoundingClientRect().top / innerHeight;
  document.body.classList.add('place-picker-open');
  const picking = toast.getBoundingClientRect().top / innerHeight;
  document.body.classList.remove('place-picker-open');
  showRouteActionToast('');
  return { normal, picking };
});
check(`the toast sits low on the map (${Math.round(bands.normal * 100)}vh, need ≥ 28vh)`,
  bands.normal >= 0.28, JSON.stringify(bands));
check(`and lower still while the place picker is open (${Math.round(bands.picking * 100)}vh, need ≥ 50vh)`,
  bands.picking >= 0.50, JSON.stringify(bands));

check('no page errors', page.pageErrors.length === 0, page.pageErrors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
