#!/usr/bin/env node
// Portfolio controls: route variety is automatic; the rider only supplies
// durable rules and itinerary permissions.
//
// This covers the automatic direct lens, waypoint/road-block regeneration
// policy, removal of the old route-temperament dialog, and the ferry toggle's
// home in Settings > Options.
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

/* --------------------------------------- the automatic direct-lens weights */
const transform = await page.evaluate(() => {
  const base = { ...routingWeights };
  const direct = directLensRoutingWeights();
  return { base, direct };
});
check('the direct lens softens the failing-road wall toward neutral',
  transform.direct.failRoadBalanced < transform.base.failRoadBalanced
    && transform.direct.failRoadBalanced > 1,
  `${transform.base.failRoadBalanced} -> ${transform.direct.failRoadBalanced}`);
// Field testing found exponent 0.45 too timid. Under default weights the 9×
// balanced wall must land under 2×: mostly time/distance, with a mild nudge.
check('the default 9x wall lands under 2x',
  transform.base.failRoadBalanced !== 9 || transform.direct.failRoadBalanced < 2,
  `${transform.base.failRoadBalanced} -> ${transform.direct.failRoadBalanced}`);
check('the lens flattens trail attraction toward neutral',
  transform.direct.facilityPath > transform.base.facilityPath
    && transform.direct.facilityPath < 1,
  `${transform.base.facilityPath} -> ${transform.direct.facilityPath}`);
for (const key of ['climbBalancedSecPerM', 'turnBalancedSec', 'ferryWaitMin',
  'uphillFactor', 'freeway', 'mtbTrail', 'diversityQuick']) {
  check(`physics and last-resort walls are untouched: ${key}`,
    transform.direct[key] === transform.base[key],
    `${transform.base[key]} vs ${transform.direct[key]}`);
}

/* ------------------ every normal request carries both automatic viewpoints */
const request = await page.evaluate(() => {
  const captured = [];
  routing.worker = { postMessage: (message) => captured.push(message) };
  routing.ready = true;
  routing.start = [-122.335, 47.61];
  routing.end = [-122.31, 47.62];
  routing.selectRecommendedNext = true;
  routing.pinnedLetters = null;
  const rulesBefore = JSON.stringify(rules);
  computeRoute();
  const message = captured.at(-1);
  return {
    type: message?.type,
    normalWeights: message?.weights,
    directWeights: message?.directProbeWeights,
    tunedWeights: { ...routingWeights },
    rulesBefore,
    rulesAfter: JSON.stringify(rules),
  };
});
check('a route request uses the rider weights as its normal viewpoint',
  request.type === 'route-options'
    && JSON.stringify(request.normalWeights) === JSON.stringify(request.tunedWeights));
check('and automatically carries a distinct more-direct probe',
  request.directWeights?.failRoadBalanced < request.normalWeights?.failRoadBalanced,
  JSON.stringify({ normal: request.normalWeights?.failRoadBalanced,
    direct: request.directWeights?.failRoadBalanced }));
check('the automatic lens never changes safety rules',
  request.rulesBefore === request.rulesAfter);

/* ------------------------------------ which route survives a recompute */
// The frozen-lineup system (pinned recipes, held letters, greyed unroutable
// slots) is gone by field decision: every search generates, sorts and letters
// its portfolio normally, and continuity is the SELECTION -- the rider's
// letter is re-selected in the fresh lineup, falling to the last letter when
// the new lineup is shorter.
const regeneration = await page.evaluate(() => {
  const out = {};
  const posted = [];
  routing.worker = { postMessage: (message) => posted.push(message) };
  routing.ready = true;
  setRoutePoint('start', { lng: -122.335, lat: 47.61 });
  setRoutePoint('end', { lng: -122.31, lat: 47.62 });

  routing.selectRecommendedNext = false;
  addVia({ lng: -122.32, lat: 47.615 });
  out.afterWaypoint = routing.selectRecommendedNext;
  out.waypointRequestHasNoPins = !('pinned' in (posted.at(-1) || {}));

  const via = routing.vias.at(-1);
  routing.selectRecommendedNext = false;
  via.marker.setLngLat({ lng: -122.319, lat: 47.616 });
  via.marker.fire('dragend');
  out.afterWaypointMove = routing.selectRecommendedNext;
  routing.selectRecommendedNext = false;
  removeVia(via);
  out.afterWaypointRemove = routing.selectRecommendedNext;

  // A road block refines the trip; the fresh portfolio still re-letters, and
  // the rider's place is kept by letter, not by recipe.
  routing.selectRecommendedNext = false;
  addRoadBlock({ lng: -122.322, lat: 47.617 });
  out.afterBlock = routing.selectRecommendedNext;
  out.blockRequestHasNoPins = !('pinned' in (posted.at(-1) || {}));

  routing.selectRecommendedNext = false;
  setRoutePoint('end', { lng: -122.29, lat: 47.64 });
  out.afterNewEnd = routing.selectRecommendedNext;

  // Letter continuity, the whole of it: same letter when it exists, last
  // letter when the lineup shrank, recommendation when explicitly asked.
  const lineup = (letters) => letters.map((letter, index) => ({
    optimization: { label: `Route ${letter}`, profileId: `p-${letter}`,
      recommended: index === 0 } }));
  // setRoutePoint above set selectRecommendedNext; these probes are about
  // ordinary continuity, so clear it first.
  routing.selectRecommendedNext = false;
  routing.last = { optimization: { label: 'Route C', profileId: 'old-c' } };
  out.sameLetter = refreshedRouteSelection(lineup(['A', 'B', 'C', 'D']))
    ?.optimization.label;
  routing.last = { optimization: { label: 'Route F', profileId: 'old-f' } };
  out.closestLetter = refreshedRouteSelection(lineup(['A', 'B', 'C']))
    ?.optimization.label;
  routing.selectRecommendedNext = true;
  routing.last = { optimization: { label: 'Route C', profileId: 'old-c' } };
  out.recommendedWins = refreshedRouteSelection(lineup(['A', 'B', 'C']))
    ?.optimization.label;
  routing.selectRecommendedNext = false;
  clearRoute();
  return out;
});
check('a waypoint regenerates the portfolio and takes its recommendation',
  regeneration.afterWaypoint === true && regeneration.waypointRequestHasNoPins === true,
  JSON.stringify(regeneration));
check('moving or removing a waypoint also regenerates the full portfolio',
  regeneration.afterWaypointMove === true && regeneration.afterWaypointRemove === true,
  JSON.stringify(regeneration));
check('a road block keeps the rider\'s letter in a freshly lettered portfolio',
  regeneration.afterBlock === false && regeneration.blockRequestHasNoPins === true,
  JSON.stringify(regeneration));
check('a new destination takes a fresh recommendation', regeneration.afterNewEnd === true,
  JSON.stringify(regeneration));
check('selection continuity is by letter: same, closest, or the recommendation',
  regeneration.sameLetter === 'Route C' && regeneration.closestLetter === 'Route C'
    && regeneration.recommendedWins === 'Route A',
  JSON.stringify(regeneration));

/* ------- everyday and advanced routing options live in deliberate homes */
const ui = await page.evaluate(() => {
  routing.worker = { postMessage: () => {} };
  routing.ready = true;
  routing.start = [-122.335, 47.61];
  routing.end = [-122.31, 47.62];
  routing.options = [{ optimization: { label: 'Route A', recommended: true } }];
  routing.last = routing.options[0];
  renderRouteOptionControls();
  settingsPaneSelect?.('rules');
  openRoutingWeights();
  const bikeRouteToggle = document.getElementById('r-alwaysPreferBikeRoutes');
  const toggle = document.getElementById('r-allowFerries');
  const advancedIds = ['r-prefDesig', 'r-alwaysPreferBikeRoutes', 'r-prefResidential',
    'r-allowSidewalkFallback', 'r-allowMtbTrails', 'r-allowFerries'];
  const out = {
    oldButtonGone: !document.getElementById('routeRemixBtn'),
    oldDialogGone: !document.getElementById('remixDialog'),
    chooserButtons: [...document.querySelectorAll('#routeOptions button')]
      .map((button) => button.textContent.trim()),
    toggleExists: !!toggle,
    toggleInAdvanced: !!toggle?.closest('#advancedRoutingOptions'),
    advancedAllPresent: advancedIds.every((id) =>
      document.getElementById(id)?.closest('#advancedRoutingOptions')),
    advancedAbsentFromOptions: advancedIds.every((id) =>
      !document.getElementById(id)?.closest('#settings-options')),
    weightsVisible: document.getElementById('settings-weights')?.hidden === false,
    tabsVisible: document.getElementById('settingsTabs')?.getBoundingClientRect().height > 0,
    defaultChecked: toggle?.checked === true,
    ferryHint: toggle?.closest('.rule-card')?.querySelector('.rule-check-hint')?.textContent || '',
    bikeRouteToggleExists: !!bikeRouteToggle,
    bikeRouteToggleInAdvanced: !!bikeRouteToggle?.closest('#advancedRoutingOptions'),
    bikeRouteDefaultChecked: bikeRouteToggle?.checked === true,
    bikeRouteLabel: bikeRouteToggle?.closest('label')
      ?.querySelector('.weights-route-option-label')?.textContent.trim() || '',
  };
  routing.selectRecommendedNext = false;
  routing.pinnedLetters = [{ letter: 'A', profileId: 'old-ferry-route' }];
  if (toggle) {
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
  }
  if (bikeRouteToggle) {
    bikeRouteToggle.checked = true;
    bikeRouteToggle.dispatchEvent(new Event('change'));
  }
  out.bikeRouteRuleOn = rules.alwaysPreferBikeRoutes === true;
  out.ruleOff = rules.allowFerries === false;
  out.deferredUntilSettingsClose = settingsRouteChangesPending === true;
  out.settingsStayedOpen = settingsMenuIsOpen()
    && document.getElementById('settings-weights')?.hidden === false;
  // Restore the global for the rest of this browser session.
  setRouteOptionsLoading(false);
  if (toggle) {
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
  }
  setRouteOptionsLoading(false);
  settingsPaneSelect?.('rules');
  clearRoute();
  return out;
});
check('the route chooser contains only route choices',
  ui.oldButtonGone && ui.chooserButtons.length === 1
    && ui.chooserButtons[0] === 'A (Only route)',
  JSON.stringify(ui));
check('the Show me routes dialog is removed', ui.oldDialogGone, JSON.stringify(ui));
check('the six expert switches live in Advanced routing, not Options',
  ui.toggleExists && ui.toggleInAdvanced && ui.advancedAllPresent
    && ui.advancedAbsentFromOptions && ui.weightsVisible && ui.tabsVisible && ui.defaultChecked
    && ui.ferryHint === '',
  JSON.stringify(ui));
check('turning ferries off updates the rule and defers one reroute until Settings closes',
  ui.ruleOff && ui.deferredUntilSettingsClose && ui.settingsStayedOpen, JSON.stringify(ui));
check('the strong signed-route preference lives in Advanced routing and defaults off',
  ui.bikeRouteToggleExists && ui.bikeRouteToggleInAdvanced
    && !ui.bikeRouteDefaultChecked
    // The caution copy stays with it through the move to Advanced routing
    // (field direction); the label is the full sentence.
    && ui.bikeRouteLabel === 'Follow designated bike routes even if they fail safety rules (use with caution — not generally recommended)',
  JSON.stringify(ui));
check('turning the signed-route preference on updates the routing rule',
  ui.bikeRouteRuleOn, JSON.stringify(ui));

// With no trip routed, the Settings tab's considered-routes button explains
// itself by being disabled instead of opening an empty list.
const considered = await page.evaluate(() => {
  routing.allCandidates = [];
  syncConsideredRoutesButton();
  const button = document.getElementById('moreRoutesBtn');
  const out = { disabledWithoutTrip: button?.disabled === true };
  routing.allCandidates = [{}];
  syncConsideredRoutesButton();
  out.enabledWithTrip = button?.disabled === false;
  return out;
});
check('considered-routes sleeps until a trip is routed',
  considered.disabledWithoutTrip && considered.enabledWithTrip, JSON.stringify(considered));

check('no page errors', page.pageErrors.length === 0, page.pageErrors.join(' | '));

await browser.close();
site.close();
process.exitCode = failed ? 1 : 0;
console.log(`\n${passed} passed, ${failed} failed`);
