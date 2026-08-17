#!/usr/bin/env node
// Settings is an editing session: route-affecting changes accumulate while
// the full-screen view is open, then the final state is applied exactly once
// when the rider returns to the map.
import { appPage, launchBrowser, serveRepo, check, done } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);

// Wait for the router's ready message as well as the DOM: graph-ready
// computes a restored trip the moment it lands, and a bigger graph made
// that message arrive after this test had planted its endpoints -- the
// startup restore then counted as a "Settings leak" it is not.
await page.waitForFunction(() => typeof selectPanelTab === 'function'
  && document.getElementById('r-maxSpeedNoShoulder')
  && routing.ready === true, null, { timeout: 60000 });

const result = await page.evaluate(async () => {
  const savedRules = { ...rules };
  const savedUi = { ...uiPrefs };
  const savedStart = routing.start;
  const savedEnd = routing.end;
  const realCompute = computeRoute;
  const realRescore = rescoreAll;
  let computes = 0;
  let rescores = 0;
  computeRoute = () => { computes += 1; };
  rescoreAll = () => { rescores += 1; };
  routing.start = [-122.34, 47.60];
  routing.end = [-122.32, 47.63];

  selectPanelTab('settings');
  settingsPaneSelect('rules');
  const speed = document.getElementById('r-maxSpeedNoShoulder');
  speed.value = String(Number(speed.value) === Number(speed.max)
    ? Number(speed.min) : Number(speed.max));
  // Several events model a real thumb drag. They must still become one final
  // route update, not one update per event.
  speed.dispatchEvent(new Event('input', { bubbles: true }));
  speed.value = String(Math.max(Number(speed.min), Number(speed.value) - Number(speed.step)));
  speed.dispatchEvent(new Event('input', { bubbles: true }));
  const paved = document.getElementById('r-preferPaved');
  paved.checked = !paved.checked;
  paved.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 900));
  const whileOpen = { computes, rescores };

  selectPanelTab('route');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const afterExit = { computes, rescores };

  computes = 0;
  rescores = 0;
  selectPanelTab('settings');
  settingsPaneSelect('rules');
  const icons = document.getElementById('r-hideRouteWarningIcons');
  icons.checked = !icons.checked;
  icons.dispatchEvent(new Event('change', { bubbles: true }));
  selectPanelTab('route');
  const displayOnlyExit = { computes, rescores };

  selectPanelTab('settings');
  selectPanelTab('route');
  const cleanExit = { computes, rescores };

  Object.assign(rules, savedRules);
  Object.assign(uiPrefs, savedUi);
  routing.start = savedStart;
  routing.end = savedEnd;
  computeRoute = realCompute;
  rescoreAll = realRescore;
  buildRulesPanel();
  return { whileOpen, afterExit, displayOnlyExit, cleanExit };
});

check('route and map work wait while Settings remains open',
  result.whileOpen.computes === 0 && result.whileOpen.rescores === 0,
  JSON.stringify(result.whileOpen));
check('leaving Settings applies multiple route changes exactly once',
  result.afterExit.computes === 1 && result.afterExit.rescores === 1,
  JSON.stringify(result.afterExit));
check('display-only Settings changes do not recalculate a route',
  result.displayOnlyExit.computes === 0 && result.displayOnlyExit.rescores === 0,
  JSON.stringify(result.displayOnlyExit));
check('closing an unchanged Settings session does no work',
  result.cleanExit.computes === 0 && result.cleanExit.rescores === 0,
  JSON.stringify(result.cleanExit));
check('no page errors', page.pageErrors.length === 0, page.pageErrors.join(' | '));

await browser.close();
await site.close();
done();
