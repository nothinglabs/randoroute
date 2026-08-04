#!/usr/bin/env node
// Route Remix: one knob over the portfolio's temperament, and three promises.
//
// The knob must actually reach the router (as scaled weights on the request),
// it must never touch the safety rules, and it must snap back to Recommended
// when the trip changes -- a new start or destination -- while surviving the
// refinements of the SAME trip (waypoints, road blocks) and the rider's
// explicit "always use this mode" pin.
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

/* ----------------------------------------------- the weight transform */
const transform = await page.evaluate(() => {
  const base = { ...routingWeights };
  const direct = remixedRoutingWeights('direct');
  const safe = remixedRoutingWeights('safe');
  const normal = remixedRoutingWeights('recommended');
  return { base, direct, safe, normal };
});
check('recommended leaves every weight exactly as tuned',
  JSON.stringify(transform.normal) === JSON.stringify(transform.base));
check('direct softens the failing-road wall toward neutral',
  transform.direct.failRoadBalanced < transform.base.failRoadBalanced
    && transform.direct.failRoadBalanced > 1,
  `${transform.base.failRoadBalanced} -> ${transform.direct.failRoadBalanced}`);
// Field testing found the first cut (exponent 0.45, wall ~2.7×) too timid to
// surface the direct routes it exists for. Under default weights the 9×
// balanced wall must land under 2× -- mostly time and distance, mild nudges.
check('and aggressively so: the default 9x wall lands under 2x',
  transform.base.failRoadBalanced !== 9 || transform.direct.failRoadBalanced < 2,
  `${transform.base.failRoadBalanced} -> ${transform.direct.failRoadBalanced}`);
check('and flattens the trail attraction toward neutral',
  transform.direct.facilityPath > transform.base.facilityPath
    && transform.direct.facilityPath < 1,
  `${transform.base.facilityPath} -> ${transform.direct.facilityPath}`);
check('safe raises the failing-road wall',
  transform.safe.failRoadBalanced > transform.base.failRoadBalanced,
  `${transform.base.failRoadBalanced} -> ${transform.safe.failRoadBalanced}`);
check('and deepens the trail attraction',
  transform.safe.facilityPath < transform.base.facilityPath,
  `${transform.base.facilityPath} -> ${transform.safe.facilityPath}`);
for (const key of ['climbBalancedSecPerM', 'turnBalancedSec', 'ferryWaitMin',
  'uphillFactor', 'freeway', 'mtbTrail', 'diversityQuick']) {
  check(`physics and last-resort walls are untouched: ${key}`,
    transform.direct[key] === transform.base[key] && transform.safe[key] === transform.base[key],
    `${transform.base[key]} vs ${transform.direct[key]}/${transform.safe[key]}`);
}

/* -------------------------- the request carries it; the rules do not move */
const request = await page.evaluate(() => {
  const captured = [];
  routing.worker = { postMessage: (m) => captured.push(m) };
  routing.ready = true;
  routing.start = [-122.335, 47.61];
  routing.end = [-122.31, 47.62];
  routing.remix = 'safe';
  const rulesBefore = JSON.stringify(rules);
  computeRoute();
  routing.remix = 'recommended';
  computeRoute();
  return { calls: captured.map((m) => ({ type: m.type,
    fail: m.weights.failRoadBalanced, rules: JSON.stringify(m.rules) })),
  rulesBefore, rulesAfter: JSON.stringify(rules) };
});
check('a safe remix reaches the router as scaled weights',
  request.calls.length === 2 && request.calls[0].type === 'route-options'
    && request.calls[0].fail > request.calls[1].fail,
  JSON.stringify(request.calls));
check('the rules ride along completely unchanged',
  request.calls[0].rules === request.calls[1].rules
    && request.calls[0].rules === request.rulesBefore
    && request.rulesBefore === request.rulesAfter);

/* --------------------------------------------------- reset semantics */
const resets = await page.evaluate(() => {
  const out = {};
  routing.remix = 'direct'; routing.remixSticky = false;
  setRoutePoint('end', { lng: -122.30, lat: 47.63 });
  out.endpointChange = routing.remix;

  routing.remix = 'direct'; routing.remixSticky = true;
  setRoutePoint('end', { lng: -122.29, lat: 47.64 });
  out.stickyEndpointChange = routing.remix;

  routing.remixSticky = false;
  routing.remix = 'safe';
  // Re-setting the SAME destination is not a trip change.
  setRoutePoint('end', { lng: -122.29, lat: 47.64 });
  out.samePoint = routing.remix;

  addVia({ lng: -122.305, lat: 47.625 });
  out.afterWaypoint = routing.remix;
  addRoadBlock({ lng: -122.302, lat: 47.622 });
  out.afterBlock = routing.remix;

  clearRoute();
  out.afterClear = routing.remix;
  return out;
});
check('changing the destination snaps an unpinned remix back to Recommended',
  resets.endpointChange === 'recommended', JSON.stringify(resets));
check('the "always use this mode" pin survives the same change',
  resets.stickyEndpointChange === 'direct', JSON.stringify(resets));
check('re-setting the identical point changes nothing',
  resets.samePoint === 'safe', JSON.stringify(resets));
check('a waypoint keeps the remix -- it refines the same trip',
  resets.afterWaypoint === 'safe', JSON.stringify(resets));
check('so does a road block', resets.afterBlock === 'safe', JSON.stringify(resets));
check('clearing the route resets an unpinned remix',
  resets.afterClear === 'recommended', JSON.stringify(resets));

/* -------------------------------------------------- the button + dialog */
const ui = await page.evaluate(() => {
  routing.remix = 'recommended'; routing.remixSticky = false;
  routing.options = [{ optimization: { label: 'Route A', recommended: true } }];
  routing.last = routing.options[0];
  renderRouteOptionControls();
  const out = {};
  const button = document.getElementById('routeRemixBtn');
  out.buttonExists = !!button;
  out.defaultTint = button?.classList.contains('remix-active');
  out.title = button?.title || '';
  button?.click();
  const dialog = document.getElementById('remixDialog');
  out.dialogOpen = dialog?.open === true;
  out.choices = [...document.querySelectorAll('.remix-choice')].map((c) => ({
    id: c.dataset.remix, current: c.classList.contains('current'),
    badge: !!c.querySelector('.remix-current-badge'),
  }));
  document.querySelector('.remix-choice[data-remix="safe"]')?.click();
  out.afterPick = routing.remix;
  out.dialogClosedAfterPick = dialog?.open === false;
  out.tintAfterPick = document.getElementById('routeRemixBtn')?.classList.contains('remix-active');
  // Reopen: the Current badge must have moved, and the pin must hold alone.
  document.getElementById('routeRemixBtn')?.click();
  out.currentAfterReopen = document.querySelector('.remix-choice.current')?.dataset.remix;
  const sticky = document.getElementById('remixStickyCheck');
  sticky.checked = true;
  sticky.dispatchEvent(new Event('change'));
  out.stickyAfterCheck = routing.remixSticky;
  dialog?.close();
  return out;
});
check('the route-mix More button renders in the chooser row', ui.buttonExists === true, JSON.stringify(ui));
check('untinted while on Recommended', ui.defaultTint === false, JSON.stringify(ui));
check('its label names the current mode', /Show me routes that are/.test(ui.title), ui.title);
check('tapping it opens the dialog', ui.dialogOpen === true, JSON.stringify(ui));
check('which offers all three modes with Recommended marked current',
  ui.choices.length === 3 && ui.choices.find((c) => c.id === 'recommended')?.current === true
    && ui.choices.find((c) => c.id === 'recommended')?.badge === true
    && ui.choices.filter((c) => c.current).length === 1,
  JSON.stringify(ui.choices));
check('picking safety-focused applies it and closes the dialog',
  ui.afterPick === 'safe' && ui.dialogClosedAfterPick === true, JSON.stringify(ui));
check('and the button shows a remix is active', ui.tintAfterPick === true, JSON.stringify(ui));
check('reopening marks the new mode as current', ui.currentAfterReopen === 'safe', JSON.stringify(ui));
check('the pin checkbox works without picking a mode', ui.stickyAfterCheck === true, JSON.stringify(ui));

// With no trip routed, the weights page's considered-routes button explains
// itself by being disabled instead of opening an empty list.
const considered = await page.evaluate(() => {
  routing.allCandidates = [];
  openRoutingWeights();
  const button = document.getElementById('moreRoutesBtn');
  const out = { disabledWithoutTrip: button?.disabled === true };
  document.getElementById('weightsDialog')?.close();
  routing.allCandidates = [{}];
  openRoutingWeights();
  out.enabledWithTrip = button?.disabled === false;
  document.getElementById('weightsDialog')?.close();
  return out;
});
check('considered-routes sleeps until a trip is routed',
  considered.disabledWithoutTrip && considered.enabledWithTrip, JSON.stringify(considered));

check('no page errors', page.pageErrors.length === 0, page.pageErrors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
