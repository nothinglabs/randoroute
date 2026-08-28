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

const installedMapRequest = await page.evaluate(async () => {
  const originalAcquisition = MapStore.routingAcquisitionForStates;
  const originalInstalled = MapStore.installedStateIds;
  const originalActive = { ...activeMultiStateRouting };
  let captured = null;
  try {
    MapStore.routingAcquisitionForStates = () => ({ available: true,
      compatibility: { catalogueSha256: 'portfolio-test' } });
    MapStore.installedStateIds = () => ['oregon', 'washington'];
    Object.assign(activeMultiStateRouting, {
      key: 'portfolio-test|oregon', bridge: null, context: null, creating: null,
      session: {
        setInstalledStateIds() {}, cancel() {},
        async route(message) {
          captured = message;
          return { type: message.type, id: message.id, ok: false, options: [],
            reason: 'portfolio request captured' };
        },
      },
    });
    routing.start = [-122.6765, 45.5231];
    routing.end = [-122.641, 45.564];
    routing.startStateId = 'oregon';
    routing.endStateId = 'oregon';
    await computeMultiStateRoute({ revealPanel: false });
    return { type: captured?.type, points: captured?.points,
      normalWeights: captured?.weights, directWeights: captured?.directProbeWeights };
  } finally {
    MapStore.routingAcquisitionForStates = originalAcquisition;
    MapStore.installedStateIds = originalInstalled;
    Object.assign(activeMultiStateRouting, originalActive);
    routing.startStateId = Region.id;
    routing.endStateId = Region.id;
  }
});
check('a trip inside an installed non-home map requests a full route portfolio',
  installedMapRequest.type === 'route-options'
    && installedMapRequest.points?.length === 2
    && installedMapRequest.directWeights?.failRoadBalanced
      < installedMapRequest.normalWeights?.failRoadBalanced,
  JSON.stringify(installedMapRequest));

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

/* ------- choosing a route surfaces its plain-language line as a pill */
const descToast = await page.evaluate(() => {
  const candidate = { profileId: 'p-toast', label: 'Route A', presented: true,
    distM: 9000, timeS: 2000, failM: 0, trailM: 5000, facilityM: 6000,
    desigM: 0, residentialM: 500, freewayM: 0, limitedAccessM: 0,
    ferryM: 0, ascentM: 40, levelM: [0, 3000, 0, 0, 0] };
  routing.allCandidates = [candidate];
  const option = { ok: true, coords: [[0, 0]], segs: [], distM: 9000, timeS: 2000,
    failM: 0, optimization: { label: 'Route A', profileId: 'p-toast' } };
  const host = document.getElementById('routeDescToast');
  activateRouteOption(option);
  // Just above the route chooser (below a top-docked panel on desktop),
  // right of the Navigate button and never overlapping it, on screen
  // (field asks, 2026-08-27 — moved down from over the start/destination
  // card, which it hid).
  const panel = document.getElementById('panel').getBoundingClientRect();
  const navBtn = document.getElementById('navStartButton')?.getBoundingClientRect();
  const pill = host.getBoundingClientRect();
  const phoneLayout = panel.top > window.innerHeight * 0.5;
  const placed = (phoneLayout
    ? pill.bottom <= panel.top - 2 && pill.bottom >= panel.top - 120
    : pill.top >= panel.bottom + 2)
    && (!navBtn?.width || pill.left >= navBtn.right + 3)
    && pill.right <= window.innerWidth - 4 && pill.width >= 180;
  // Two lines of text, never three, and no ✕ taking width from the copy
  // (field ask, 2026-08-28). The clamp is measured, not read off the rule:
  // the text box may hold more than it shows, but it may not be taller
  // than two lines.
  const textEl = host.querySelector('.route-desc-text');
  const lineH = parseFloat(getComputedStyle(host).lineHeight) || 18;
  const shown = { text: textEl?.textContent,
    visible: host.classList.contains('show'),
    hasClose: !!host.querySelector('.route-desc-close'),
    clampedToTwoLines: !!textEl && textEl.clientHeight <= lineH * 2 + 1,
    textHeight: textEl?.clientHeight, lineH,
    placed, phoneLayout, pillTop: pill.top, pillLeft: pill.left,
    pillRight: pill.right, panelTop: panel.top, panelBottom: panel.bottom,
    navRight: navBtn?.right };
  // Turn navigation must stay pill-free: the space belongs to guidance.
  host.classList.remove('show');
  turnNav.active = true;
  activateRouteOption(option);
  const nav = { visible: host.classList.contains('show') };
  turnNav.active = false;
  // A tap on the pill dismisses it instantly so the covered card is usable.
  activateRouteOption(option);
  const beforeTap = host.classList.contains('show');
  host.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 4, clientY: 4 }));
  const tap = { beforeTap, afterTap: host.classList.contains('show') };
  routing.allCandidates = [];
  return { shown, nav, tap, expected: candidateRouteDescriptions([candidate]).get('p-toast') };
});
check('choosing a route shows its description pill',
  descToast.shown.visible && descToast.shown.text.length > 10
    && descToast.shown.text === descToast.expected, JSON.stringify(descToast));
check('the pill sits by the chooser, clear of the Navigate button',
  descToast.shown.placed, JSON.stringify(descToast.shown));
check('the pill spends its width on the description, with no dismiss mark',
  !descToast.shown.hasClose, JSON.stringify(descToast.shown));
check('the pill holds its text to two lines',
  descToast.shown.clampedToTwoLines, JSON.stringify(descToast.shown));

/* ------- the details header carries the same description */
const detailsDesc = await page.evaluate(() => {
  const candidate = { profileId: 'p-toast', label: 'Route A', presented: true,
    distM: 9000, timeS: 2000, failM: 0, trailM: 5000, facilityM: 6000,
    desigM: 0, residentialM: 500, freewayM: 0, limitedAccessM: 0,
    ferryM: 0, ascentM: 40, levelM: [0, 3000, 0, 0, 0] };
  routing.allCandidates = [candidate];
  routing.last = { ok: true, coords: [[0, 0]], segs: [], distM: 9000,
    timeS: 2000, failM: 0,
    optimization: { label: 'Route A', profileId: 'p-toast' } };
  openRouteDetails();
  const desc = document.getElementById('routeDetailsDialogDesc');
  const out = { text: desc?.textContent, hidden: desc?.hidden,
    expected: candidateRouteDescriptions([candidate]).get('p-toast') };
  document.getElementById('routeDetailsDialog')?.close();
  routing.allCandidates = [];
  routing.last = null;
  return out;
});
check('the details header shows the route description',
  !detailsDesc.hidden && detailsDesc.text === detailsDesc.expected,
  JSON.stringify(detailsDesc));
check('the pill stays out of turn navigation', !descToast.nav.visible,
  JSON.stringify(descToast.nav));
check('a tap dismisses the pill instantly',
  descToast.tap.beforeTap && !descToast.tap.afterTap, JSON.stringify(descToast.tap));

/* ------- no description while the routes it describes are being replaced */
// Field, 2026-08-28: booting with a stored trip drew the old route, a GPS fix
// moved the start, and the pill sat over "Calculating route options"
// describing a route about to be replaced.
const staleToast = await page.evaluate(() => {
  const candidate = { profileId: 'p-stale', label: 'Route A', presented: true,
    distM: 9000, timeS: 2000, failM: 0, trailM: 5000, facilityM: 6000,
    desigM: 0, residentialM: 500, freewayM: 0, limitedAccessM: 0,
    ferryM: 0, ascentM: 40, levelM: [0, 3000, 0, 0, 0] };
  routing.allCandidates = [candidate];
  const option = { ok: true, coords: [[0, 0]], segs: [], distM: 9000, timeS: 2000,
    failM: 0, optimization: { label: 'Route A', profileId: 'p-stale' } };
  const host = document.getElementById('routeDescToast');
  const wasActive = routing.routeRequestActive;
  try {
    // A pill already on screen goes when the next computation starts.
    activateRouteOption(option);
    const beforeRecompute = host.classList.contains('show');
    setRouteOptionsLoading(true);
    const afterRecomputeStarted = host.classList.contains('show');
    setRouteOptionsLoading(false);
    // And a selection made mid-computation describes nothing.
    routing.routeRequestActive = true;
    activateRouteOption(option);
    const duringRecompute = host.classList.contains('show');
    return { beforeRecompute, afterRecomputeStarted, duringRecompute };
  } finally {
    routing.routeRequestActive = wasActive;
    routing.allCandidates = [];
    host.classList.remove('show');
    document.getElementById('routeOptions')?.classList.remove('loading');
  }
});
check('starting a recompute takes the pill off screen',
  staleToast.beforeRecompute && !staleToast.afterRecomputeStarted,
  JSON.stringify(staleToast));
check('a route chosen mid-computation describes nothing',
  !staleToast.duringRecompute, JSON.stringify(staleToast));

/* ------- tapping a letter fits the map to that route */
const letterZoom = await page.evaluate(async () => {
  const mkOption = (id, coords) => ({ ok: true, coords, segs: [], distM: 15000,
    timeS: 3000, failM: 0, optimization: { label: id, profileId: id } });
  const a = mkOption('Route A', [[-122.42, 47.58], [-122.35, 47.62], [-122.30, 47.68]]);
  // Inside A's bbox on purpose: flipping to it after A's fit must not move
  // the camera (field ask, 2026-08-27 — no dancing while flipping letters).
  const b = mkOption('Route B', [[-122.41, 47.59], [-122.31, 47.65]]);
  routing.options = [a, b];
  routing.last = b;
  routing.allCandidates = [];
  renderRouteOptionControls();
  // An earlier section's computeRoute() against the stub worker never got a
  // reply, so the chooser still wears its loading class; the real flow
  // clears it when options arrive.
  document.getElementById('routeOptions').classList.remove('loading');
  // Poll the outcome, not the event: the fit animates, and other camera
  // settles can fire moveend before it finishes.
  const waitContained = async (coords) => {
    for (let i = 0; i < 40; i++) {
      const bounds = map.getBounds();
      if (coords.every((c) => bounds.contains(c))) return true;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return false;
  };
  // Re-query per tap: activating a route rebuilds the chooser buttons, and
  // a detached button's click no longer bubbles to the delegated handler.
  const letterA = () => [...document.querySelectorAll('[data-route-option]')]
    .find((btn) => Number(btn.dataset.routeOption) === 0);
  const letterB = () => [...document.querySelectorAll('[data-route-option]')]
    .find((btn) => Number(btn.dataset.routeOption) === 1);
  // The fit animates: wait for the camera to stop moving, not merely for
  // the route to enter the frame, before judging later camera behavior.
  const settled = async () => {
    let last = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const now = [map.getZoom(), map.getCenter().lng, map.getCenter().lat];
      if (last && now.every((v, j) => Math.abs(v - last[j]) < 1e-7)) return true;
      last = now;
    }
    return false;
  };
  map.jumpTo({ center: [-120.5, 46.6], zoom: 12 });
  letterA().click();
  const tapContains = await waitContained(a.coords) && await settled();
  // Flipping to an already-in-view route must not move the camera.
  const before = { zoom: map.getZoom(), center: map.getCenter() };
  letterB().click();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const after = { zoom: map.getZoom(), center: map.getCenter() };
  const steady = Math.abs(before.zoom - after.zoom) < 0.01
    && Math.abs(before.center.lng - after.center.lng) < 0.0005
    && Math.abs(before.center.lat - after.center.lat) < 0.0005;
  // Retapping the active letter must bring a panned-away route back too.
  map.jumpTo({ center: [-120.5, 46.6], zoom: 12 });
  letterB().click();
  const retapContains = await waitContained(b.coords);
  routing.options = [];
  routing.last = null;
  return { tapContains, steady, before, after, retapContains };
});
check('tapping a letter fits the map to that route',
  letterZoom.tapContains, JSON.stringify(letterZoom));
check('flipping to an in-view route does not move the camera',
  letterZoom.steady, JSON.stringify(letterZoom));
check('retapping the active letter brings a panned-away route back',
  letterZoom.retapContains, JSON.stringify(letterZoom));

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
  const advancedIds = ['r-alwaysPreferBikeRoutes',
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
