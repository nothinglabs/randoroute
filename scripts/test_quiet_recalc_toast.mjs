#!/usr/bin/env node
// A settings-held recompute must SAY something without LOOKING blocking.
//
// The route sheet is hidden behind Settings while a rider flips options, so
// the calc sheet's spinner and progress bar are invisible and the shared
// toast is the only voice. The contract (field decision, v.710 era):
//   - "Updating routes…" appears the moment the quiet recompute starts and
//     stays up for the whole request. The regression this pins: every router
//     progress message used to clear the shared toast "so nothing sits over
//     the calculation sheet" -- which blanked the pill ~300 ms in.
//   - "Routes updated" replaces it when the portfolio lands.
//   - While a bottom sheet is open, both pills sit just ABOVE the sheet
//     (not mid-screen over the map) so they read as a status line, not a
//     blocking dialog. The anchor is --mobile-panel-height, the same
//     measurement the nav dock rides.
import { appPage, launchBrowser, serveRepo, check, done } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);

await page.waitForFunction(() => typeof selectPanelTab === 'function' && routing?.ready,
  null, { timeout: 120000 });

const run = await page.evaluate(async () => {
  routing.start = [-122.3321, 47.6062]; routing.end = [-122.3421, 47.6262];
  computeRoute();
  for (let i = 0; i < 240 && !routing.last?.ok; i++) await new Promise((r) => setTimeout(r, 500));
  if (!routing.last?.ok) return { failedToRoute: true };

  selectPanelTab('settings');
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const toastEl = document.getElementById('routeActionToast');
  const textEl = document.getElementById('routeActionText');
  const geometry = () => {
    const t = toastEl.getBoundingClientRect();
    const p = document.getElementById('panel').getBoundingClientRect();
    return { gap: Math.round(p.top - t.bottom), width: Math.round(t.width) };
  };

  rules.alwaysPreferBikeRoutes = !rules.alwaysPreferBikeRoutes;
  computeRoute({ revealPanel: false });
  const atStart = { text: textEl.textContent, hidden: toastEl.hidden, ...geometry() };

  // The pill must never blank while the request runs. Sample well inside the
  // 6 s backstop so a slow container can't turn its designed expiry into a
  // false failure.
  let blankFrames = 0, samples = 0;
  const began = performance.now();
  while (routing.routeRequestActive && performance.now() - began < 4000) {
    samples++;
    if (toastEl.hidden || textEl.textContent !== 'Updating routes…') blankFrames++;
    await new Promise((r) => setTimeout(r, 50));
  }
  for (let i = 0; i < 120 && routing.routeRequestActive; i++) await new Promise((r) => setTimeout(r, 250));
  await new Promise((r) => setTimeout(r, 100));
  const atEnd = { text: textEl.textContent, hidden: toastEl.hidden, ...geometry() };

  rules.alwaysPreferBikeRoutes = !rules.alwaysPreferBikeRoutes;
  return { atStart, blankFrames, samples, atEnd };
});

check('the quiet recompute routes at all', !run.failedToRoute, JSON.stringify(run));
if (!run.failedToRoute) {
  check('"Updating routes…" appears the moment the recompute starts',
    run.atStart.text === 'Updating routes…' && !run.atStart.hidden, JSON.stringify(run.atStart));
  check('the pill survives the router progress stream',
    run.samples > 0 && run.blankFrames === 0,
    `${run.blankFrames} blank of ${run.samples} samples`);
  check('"Routes updated" lands when the portfolio does',
    run.atEnd.text === 'Routes updated' && !run.atEnd.hidden, JSON.stringify(run.atEnd));
  check('the starting pill sits just above the settings sheet, not mid-screen',
    run.atStart.gap >= 4 && run.atStart.gap <= 40, JSON.stringify(run.atStart));
  check('the completion pill holds the same band',
    run.atEnd.gap >= 4 && run.atEnd.gap <= 40, JSON.stringify(run.atEnd));
}
check('no page errors', page.pageErrors.length === 0, page.pageErrors.join(' | '));

await browser.close();
await site.close();
done();
