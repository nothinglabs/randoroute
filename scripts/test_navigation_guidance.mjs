#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../router-worker.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const nativeBridge = fs.readFileSync(
  new URL('../ios/App/App/BridgeViewController.swift', import.meta.url),
  'utf8',
);
const nativeInfo = fs.readFileSync(
  new URL('../ios/App/App/Info.plist', import.meta.url),
  'utf8',
);
assert.match(html, /id="navOffRouteBtn"[^>]*>Re-route</,
  'off-route navigation should expose a conventional reroute button');
assert.match(html, /class="nav-banner-main"[\s\S]*?class="nav-banner-copy"[\s\S]*?<\/div>[\s\S]*?id="navOffRouteBtn"/,
  'the off-route action should sit below the preserved navigation information');
assert.doesNotMatch(html, /id="navDetailsBtn"/,
  'the top navigation window should no longer carry a Details button');
// Route details live on the Navigating Route panel now.
assert.match(html, /id="navCard"[\s\S]*?id="navCardDetailsBtn"/,
  'the Navigating Route panel should host the elevation chart and a details button');
assert.match(app, /function drawNavElevation\([\s\S]*?ctx\.clip\(\)[\s\S]*?NAV_ELEV_DONE/,
  'the navigating elevation chart should shade the ridden portion');
assert.match(app, /function updateNavCard\([\s\S]*?navigationElevationProgressM\(\)/,
  'the navigating panel should track the live position on its elevation chart');
assert.match(app, /function startTurnNavigation\(\)\s*\{\s*if \(routing\.pendingRoute \|\| routing\.routeRequestActive\)/,
  'navigation must not start while a replacement route is still calculating');
assert.match(app, /const routeReady = routeAvailable && !routing\.pendingRoute && !routing\.routeRequestActive[\s\S]*?startButton\.disabled = turnNav\.active \? false : !routeReady/,
  'the Navigate button should remain disabled until the latest route is ready');
assert.match(app, /locationReady:\s*false[\s\S]*?Waiting for a GPS fix…/,
  'the navigation card should show an explicit acquisition state before its first fix');
assert.match(app, /!turnNav\.locationReady\s*\?\s*'Navigation begins after a usable GPS fix'/,
  'the navigation banner must not report route progress before a usable GPS fix');
assert.match(app, /function navSegInfoHTML\(\)\s*\{\s*if \(!turnNav\.locationReady\)[\s\S]*?Waiting for GPS…/,
  'the current-road card must not guess the first route segment before a GPS fix');

const mapProgressStart = app.indexOf('function updateNavigationProgress');
const mapProgressEnd = app.indexOf('function rejoinRoute', mapProgressStart);
assert.ok(mapProgressStart >= 0 && mapProgressEnd > mapProgressStart,
  'planned-route progress helpers were not found');
let progressData = null;
const connectorProgressContext = vm.createContext({
  Math, Number, Array,
  navDistanceM(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); },
  map: { getSource: () => ({ setData(data) { progressData = data; } }) },
  turnNav: {
    active: true, followingConnector: true,
    route: { coords: [[9, 9], [10, 10]] },
    nearestSegment: 0, nearestPoint: [9.5, 9.5],
    plannedRoute: { coords: [[0, 0], [1, 0], [2, 0]] },
    plannedNearestSegment: 1, plannedNearestPoint: [1.5, 0],
  },
});
vm.runInContext(`${app.slice(mapProgressStart, mapProgressEnd)}
  this.updateNavigationProgress = updateNavigationProgress;`, connectorProgressContext);
connectorProgressContext.updateNavigationProgress();
assert.deepEqual(progressData.geometry.coordinates, [[0, 0], [1, 0], [1.5, 0]],
  'a return connector must preserve the completed portion of the planned route');

const elevationProgressStart = app.indexOf('function navigationElevationProgressM');
const elevationProgressEnd = app.indexOf('function openRouteDetails', elevationProgressStart);
const elevationProgressContext = vm.createContext({
  Math, Number,
  routing: { last: { distM: 1000 } },
  turnNav: {
    active: true, locationReady: true, followingConnector: true,
    plannedRouteM: 400, routeM: 25,
    plannedRoute: { totalM: 1000 },
  },
});
vm.runInContext(`${app.slice(elevationProgressStart, elevationProgressEnd)}
  this.navigationElevationProgressM = navigationElevationProgressM;`, elevationProgressContext);
assert.equal(elevationProgressContext.navigationElevationProgressM(), 400,
  'connector navigation should keep the original elevation progress instead of resetting it');
// Panel content: destination, miles done/left, and current-segment facts;
// the route-segment percentages are gone.
assert.match(html, /id="navDest"[\s\S]*?id="navSegInfo"[\s\S]*?id="navProgressDist"/,
  'the panel shows destination and current-segment info, then miles done/left in the footer');
assert.doesNotMatch(html, /id="navRideMix"|id="navTripStats"/,
  'the route-segment ride-mix percentages are removed from the panel');
assert.match(app, /function navCurrentSegment\(\)[\s\S]*?nearestSegment/,
  'the current segment is resolved from the live position');
assert.match(app, /function navSegmentClassLabel\([\s\S]*?ROAD_CLASS_NAME/,
  'the current segment reports a general road class');
assert.match(app, /function navShoulderText\(/,
  'the current segment reports shoulder width');
assert.match(html, /class="nav-card-foot">\s*<button id="navCardDetailsBtn"[\s\S]*?id="navProgressFill"/,
  'the footer holds the Details button beside the progress bar');
// The Navigate/Pause button keeps one width and turns amber (not green) while navigating.
assert.match(css, /\.nav-start\s*\{[^}]*min-width:\s*\d/,
  'the Navigate/Pause button has a fixed width so it does not resize');
assert.match(css, /\.nav-start\.navigating\s*\{[^}]*background:/,
  'the pause state uses a non-green color');
assert.match(app, /classList\.toggle\('navigating', turnNav\.active\)/,
  'the button flips to its navigating state while active');
// Tapping a road no longer dismisses the panel.
const inspectBody = app.slice(app.indexOf('function inspectRoadAt'),
  app.indexOf('\nfunction ', app.indexOf('function inspectRoadAt') + 1));
assert.doesNotMatch(inspectBody, /setPanelOpen/,
  'tapping a road should not close the open panel');
// Route details identifies the active route while navigating, keeps the option label otherwise.
assert.match(app, /turnNav\.active \? 'Active Route Details' : `\$\{routeLabel\} Details`/,
  'the route details title identifies the active route during navigation');
// Panel copy tweaks and the Stop button.
assert.match(app, /`To: \$\{name\}`/, 'destination is prefixed "To:"');
assert.match(app, /return `Shoulder: \$\{\+Number\(sh\)\.toFixed\(1\)\} ft`/,
  'the current segment reports "Shoulder: N ft"');
assert.match(app, /startLabel\.textContent = turnNav\.active \? 'Stop' : 'Navigate'/,
  'the navigation button says Stop, not Pause');
assert.match(css, /#tab-route \{ min-height:/,
  'the Route tab has a pinned height so it does not bounce on Navigate');
// Exact-route sharing: recipe carries weights, never resets the receiver's
// settings, and the shared route is offered as "As Shared".
assert.match(app, /w: \{ \.\.\.routingWeights \}/, 'share link includes the routing weights');
assert.doesNotMatch(app, /Object\.assign\(rules, sharedRoute\.rules\)/,
  'a shared link must not overwrite the receiver\'s safety rules');
assert.match(app, /sharedActive \? routing\.sharedRecipe/,
  'the shared route is rebuilt with the sender\'s recipe');
assert.match(app, /function exitSharedRoute\(\)/,
  'leaving the shared route drops the As Shared state');
assert.match(html, /id="sharedSwitchDialog"/,
  'switching away from the shared route confirms via a dialog');
// The app is renamed and no longer closes the panel when navigation starts.
assert.match(html, /<title>Just Rolling Along<\/title>/,
  'the app is titled Just Rolling Along');
assert.doesNotMatch(app, /startTurnNavigation[\s\S]*?mobileNavMedia\.matches\) setPanelOpen\(false\)/,
  'starting navigation should leave the panel open');
assert.match(html, /id="navKeepRouteBtn"[\s\S]*?I'll find my own way[\s\S]*?id="navRouteBackBtn"[\s\S]*?Route to the nearest point[\s\S]*?id="navNewRouteBtn"[\s\S]*?New route to destination/,
  'off-route recovery dialog leads with "find my own way", then all three explicit choices');
assert.match(html, /id="navNewRouteBtn"[\s\S]*?fresh route from here through any remaining stops/,
  'manual dynamic rerouting should also promise to preserve remaining stops');
assert.match(css, /\.nav-banner\.off-route-action-visible\s*\{[^}]*flex-direction:\s*column[\s\S]*?\.nav-off-route-action\s*\{[^}]*border-radius:\s*9px[^}]*background:\s*#b42318/,
  'off-route action should be a distinct conventional button below the navigation information');
assert.doesNotMatch(css, /off-route-action-visible[^}]*[\s\S]{0,100}nav-banner-copy[^}]*display:\s*none/,
  'off-route state must preserve the maneuver information');
assert.match(app, /ROUTE_START_OFFER_M\s*=\s*160\.934/,
  'route-to-start should be offered at one tenth of a mile');
// Free-panning during navigation: a user gesture suspends auto-follow, which
// eases back onto the rider ~30 s after they stop, and the geolocate control
// re-centers (rather than disabling tracking) on the first tap after panning.
assert.match(app, /movestart'[\s\S]{0,80}turnNav\.active && e\.originalEvent[\s\S]{0,40}cameraFollow = false/,
  'a user pan during navigation should suspend camera auto-follow');
assert.match(app, /moveend'[\s\S]{0,80}turnNav\.active && e\.originalEvent[\s\S]{0,40}scheduleNavigationFollowResume/,
  'ending a user pan should schedule the auto-follow resume');
assert.match(app, /CAMERA_RESUME_MS\s*=\s*30000/,
  'auto-follow should resume 30 s after the rider stops panning');
assert.match(app, /if \(!turnNav\.cameraFollow\) return;/,
  'the follow camera must not fight the rider while they are panning');
assert.match(app, /maplibregl-ctrl-geolocate[\s\S]{0,140}!turnNav\.cameraFollow[\s\S]{0,120}recenterNavigationOnRider/,
  'the geolocate control should re-center on the rider on the first tap after panning');
assert.match(app, /requestMapLocationRecenter\('launch'\)/,
  'a fresh app load should request and center on the current location');
assert.doesNotMatch(app, /requestMapLocationRecenter\('foreground'\)/,
  'returning to the foreground should preserve the rider’s map position');
assert.match(app, /showRouteMessage\(\s*'Choose a start and destination',\s*'Use search or tap the map\.'/,
  'the unset route card should provide compact, structured instructions');
assert.match(app, /showRouteMessage\('Route unavailable', reason, hint, true\)/,
  'an invalid route should use the compact error treatment');
assert.match(css, /\.rc-route-message\.error\s*\{[^}]*border-left:[^}]*background:/,
  'invalid route guidance should be visually distinct without becoming a wall of text');
assert.match(app, /type:\s*'route-connector'/,
  'navigation should request a separate route-to-start connector');
assert.match(app, /id:\s*'route-connector'/,
  'the connector should have its own visible map layer');
assert.match(app, /AUTO_OFF_ROUTE_DELAY_MS\s*=\s*60_000/,
  'automatic off-route actions should wait for 60 continuous seconds');
assert.match(app, /function requestRouteBackToCurrentRoute[\s\S]*?nearestNavigationPoint\([\s\S]*?turnNav\.plannedRoute\)/,
  'route-back should target the nearest point on the original planned route');
assert.match(app, /type:\s*'navigation-new-route'/,
  'the off-route menu should support a new route from the live location');
assert.match(app, /navigationOffRouteMode:\s*navVoice\.offRouteMode/,
  'the dormant off-route behavior mode should remain serializable for future restoration');
assert.match(app, /navigationAutoReroute\s*\?\s*'return'\s*:\s*'guidance'/,
  'the former automatic-rerouting checkbox should migrate to automatic return mode');
assert.match(app, /AUTOMATIC_OFF_ROUTE_RECOVERY_ENABLED\s*=\s*false/,
  'automatic off-route recovery should be disabled behind a restorable feature flag');
assert.match(app, /offRouteMode:\s*AUTOMATIC_OFF_ROUTE_RECOVERY_ENABLED\s*\?\s*savedOffRouteRecoveryMode\s*:\s*'guidance'/,
  'navigation should always start in notify-only mode while automatic recovery is disabled');
assert.match(app, /NAVIGATION_SPEECH_RATE\s*=\s*0\.96/,
  'browser navigation speech should use a calmer, less robotic rate');
assert.match(app, /function refreshPreferredNavigationVoice[\s\S]*?speechSynthesis\.getVoices\(\)/,
  'browser navigation should automatically select from the voices exposed by the device');
assert.match(app, /addEventListener\?\.\('voiceschanged'/,
  'browser navigation should handle Safari publishing its voice list asynchronously');
assert.match(nativeBridge, /voice\.quality == \.enhanced[\s\S]*?voice\.quality == \.premium/,
  'native iOS navigation should prefer installed enhanced and premium voices');
assert.match(nativeBridge, /navigationUtterance\([\s\S]*?AVSpeechUtteranceDefaultSpeechRate \* 0\.96/,
  'native iOS navigation should share the calmer speech configuration');
assert.match(app, /function nativeVoiceStatusPayload\(\)[\s\S]*?statusUpdateMin:\s*navVoice\.updateMin[\s\S]*?statusEta:\s*navVoice\.statusEta/,
  'the native route payload should include the complete periodic status configuration');
assert.match(app, /function syncNativeVoiceStatusPreferences[\s\S]*?updateVoiceSettings\(nativeVoiceStatusPayload\(\)\)/,
  'voice status settings should update the native guide during active navigation');
assert.match(nativeBridge, /CAPPluginMethod\(name: "updateVoiceSettings"[\s\S]*?private func maybeSpeakPeriodicStatus/,
  'native iOS navigation should support live status settings and locked-screen updates');
assert.match(nativeBridge, /maybeSpeakPeriodicStatus\([\s\S]*?currentSpeedMph[\s\S]*?spokenDuration/,
  'locked-screen status updates should include the configured route, speed, distance, and time fields');
assert.match(nativeBridge, /private var statusUpdateTimer:\s*Timer\?[\s\S]*?refreshStatusUpdateTimer\(\)/,
  'native periodic status should use a real timer instead of depending only on new GPS fixes');
assert.match(nativeBridge, /private func handleScheduledStatusUpdate\(\)[\s\S]*?let background = UIApplication\.shared\.applicationState != \.active[\s\S]*?if background,[\s\S]*?maybeSpeakPeriodicStatus/,
  'the native status timer should reserve maneuver prompts for the background but speak cadence updates in either app state');
assert.match(app, /function maybeSpeakPeriodicUpdate\([\s\S]*?if \(turnNav\.nativeTracking\) return;/,
  'the foreground web guide should defer cadence updates to the native iOS timer');
assert.match(nativeBridge, /didUpdateLocations[\s\S]*?latestLocation = location/,
  'the status timer should retain the latest native location fix');
assert.match(app, /const routeWidthExpression = \(extra = 0\) => \['interpolate'[\s\S]*?const routeCasingWidthExpression = \(extra = 0\) => \['interpolate'[\s\S]*?id: 'route-shadow'[\s\S]*?'line-width': routeShadowWidthExpression[\s\S]*?'line-opacity': 0\.78[\s\S]*?id: 'route-casing'[\s\S]*?'line-width': routeCasingWidthExpression\(\)/,
  'the selected route should scale with zoom while masking slightly offset background state-highway geometry');
assert.match(nativeInfo, /<key>UIBackgroundModes<\/key>[\s\S]*?<string>audio<\/string>[\s\S]*?<string>location<\/string>/,
  'native navigation should declare both spoken-audio and location background modes');
assert.match(css, /#settingsVoice\s*\{[^}]*align-content:\s*start[^}]*gap:\s*7px/,
  'the compact Voice-Nav cards should stay grouped instead of opening a large middle gap');
const voicePanelSource = app.slice(app.indexOf('function buildVoicePanel'), app.indexOf('function buildLegend'));
assert.doesNotMatch(voicePanelSource, /violet/i,
  'Voice-Nav settings should describe behavior without naming a route color');
assert.doesNotMatch(voicePanelSource, /v-offRouteMode|offRouteChoices|off-route-mode/,
  'Voice-Nav settings should not expose an automatic off-route behavior control');
assert.match(html, /id="offRouteDialog"[\s\S]*?id="navKeepRouteBtn"[\s\S]*?id="navRouteBackBtn"[\s\S]*?id="navNewRouteBtn"/,
  'the off-route dialog should preserve both manual recovery actions');
// The route-settings lock during navigation surfaces inline above the panes
// (where the rider is looking), not as a top-of-screen toast.
assert.match(html, /id="tab-settings"[\s\S]*?id="settingsNavLockNotice"[^>]*class="settings-nav-lock"[\s\S]*?id="settingsTabs"/,
  'the navigation lock notice should sit above the settings tab toolbar');
assert.match(app, /paneLockedByNavigation\(button\.dataset\.settingsPane\)\)\s*\{\s*flashSettingsNavLock\(\);/,
  'tapping a locked settings tab should flash the inline lock notice');
assert.match(app, /function flashSettingsNavLock\(\)[\s\S]*?settingsNavLockNotice/,
  'the inline lock notice helper should target the notice element');
assert.match(app, /function activateNewRouteFromCurrentLocation[\s\S]*?if \(!result\.ok[\s\S]*?return;[\s\S]*?routing\.start = start/,
  'a failed current-location calculation must return before replacing the planned route');
assert.match(app, /type:\s*'navigation-new-route'[\s\S]*?prefDesignated:\s*routing\.prefDesig,[\s\S]*?prefResidential:\s*routing\.prefResidential/,
  'a current-location route should use the live preference toggles exactly');
const waypointStart = app.indexOf('const PASSED_WAYPOINT_TOLERANCE_M');
const newRouteStart = app.indexOf('function requestNewRouteFromCurrentLocation');
const newRouteEnd = app.indexOf('function activateNewRouteFromCurrentLocation', newRouteStart);
assert.ok(waypointStart >= 0 && newRouteStart > waypointStart && newRouteEnd > newRouteStart,
  'new-route waypoint/request helpers were not found');
const viaA = { id: 'A', pt: [-122.34, 47.70] };
const viaB = { id: 'B', pt: [-122.32, 47.80] };
const waypointContext = vm.createContext({
  routing: {
    vias: [viaA, viaB],
    last: { distM: 3000, legs: [{ distM: 1000 }, { distM: 1000 }, { distM: 1000 }] },
  },
  turnNav: { routeM: 0, offRouteInfo: null, plannedRoute: { totalM: 3000 } },
});
vm.runInContext(`${app.slice(waypointStart, newRouteStart)}
  this.remainingNavigationVias = remainingNavigationVias;`, waypointContext);
assert.equal(waypointContext.remainingNavigationVias(undefined, 500).map((via) => via.id).join(','), 'A,B',
  'dynamic routing should retain every waypoint still ahead');
assert.equal(waypointContext.remainingNavigationVias(undefined, 1200).map((via) => via.id).join(','), 'B',
  'dynamic routing should not send the rider back through a waypoint already passed');
waypointContext.routing.last = { distM: 3000 };
assert.equal(waypointContext.remainingNavigationVias(undefined, 2200).map((via) => via.id).join(','), 'A,B',
  'without trustworthy leg boundaries dynamic routing should preserve all waypoints');
const newRouteMessages = [];
const remainingVia = { id: 'remaining', pt: [-122.32, 47.80] };
const newRouteContext = vm.createContext({
  navigationNewRouteRequestId: 0,
  turnNav: {
    active: true, lastPosition: [-122.35, 47.67], newRouteRequestId: null,
    connectorRequestId: null, autoRecoveryAttempted: false, newRouteStart: null,
  },
  routing: {
    end: [-122.30, 47.90], last: { optimization: { mode: 'balanced', profileId: 'efficient' } },
    mode: 'balanced', profileId: 'efficient', prefDesig: true, prefResidential: true,
    worker: { postMessage(message) { newRouteMessages.push(message); } },
  },
  rules: {}, routingWeights: {},
  remainingNavigationVias() { return [remainingVia]; },
  document: { getElementById() { return { open: false, close() {} }; } },
  showRouteActionToast(title) { newRouteMessages.push({ toast: title }); },
  refreshNavigationUI() {},
});
vm.runInContext(`${app.slice(newRouteStart, newRouteEnd)}
  this.requestNewRouteFromCurrentLocation = requestNewRouteFromCurrentLocation;`, newRouteContext);
newRouteContext.requestNewRouteFromCurrentLocation({ automatic: true });
assert.equal(newRouteContext.turnNav.autoRecoveryAttempted, true,
  'an automatic dynamic-route attempt should run only once per off-route interval');
assert.equal(newRouteMessages[0].toast, 'Automatically creating a new route',
  'automatic dynamic routing should explain what it is doing');
assert.equal(newRouteMessages[1].type, 'navigation-new-route',
  'dynamic routing should request a replacement route');
assert.equal(newRouteMessages[1].points[0][0], -122.35,
  'dynamic routing should start at the rider current location');
assert.equal(newRouteMessages[1].points[1][0], remainingVia.pt[0],
  'dynamic routing should include remaining waypoints before the destination');
const activationSource = app.slice(newRouteEnd, app.indexOf('function automaticOffRouteModeDue', newRouteEnd));
assert.match(activationSource, /routing\.vias = remainingVias/,
  'a successful replacement route should keep its remaining waypoint objects and markers');
assert.doesNotMatch(activationSource, /routing\.vias\s*=\s*\[\]/,
  'a successful replacement route must not clear all waypoints');
assert.match(activationSource, /const options = Array\.isArray\(result\.options\)[\s\S]*?routing\.options = options[\s\S]*?activateRouteOption\(selected\)/,
  'an off-route replacement should keep every generated option while navigating the selected route');
assert.match(activationSource, /options\.find\(\(option\) => option\.optimization\?\.recommended\)[\s\S]*?optimization\?\.label === 'Route A'/,
  'an off-route replacement should select the recommended route before falling back to shortest Route A');
const refreshedStart = app.indexOf('function refreshedRouteSelection(');
const refreshedEnd = app.indexOf('function onWorkerMessage(', refreshedStart);
const refreshedSource = app.slice(refreshedStart, refreshedEnd);
assert.match(refreshedSource, /const recommended = options\.find\(\(option\) => option\.optimization\?\.recommended\);[\s\S]*?if \(routing\.selectRecommendedNext\) return recommended \|\| options\[0\];[\s\S]*?if \(!previous\) return recommended \|\| options\[0\];[\s\S]*?if \(exact\) return exact;/,
  'a fresh route search should select the recommended result even when it is not shortest Route A');
assert.match(app, /function setRoutePoint\(kind, lngLat[\s\S]*?routing\.selectRecommendedNext = true;/,
  'changing either endpoint should request the new portfolio recommendation');
assert.match(app, /function onRouterMessage[\s\S]*?routing\.selectRecommendedNext = false;[\s\S]*?activateRouteOption\(selected\)/,
  'changing either endpoint should request the new portfolio recommendation exactly once');
assert.match(worker, /m\.type === 'navigation-new-route'[\s\S]*?const primary = route\(points, m\.rules, mode, !!m\.prefDesignated, !!m\.prefResidential\)[\s\S]*?if \(!primary\.ok\)[\s\S]*?const options = portfolio\?\.ok[\s\S]*?publicCandidate\(\{ \.\.\.primary, _profile: primaryProfile \}\)/,
  'a current-location replacement should preserve a usable Route A when alternatives fail');
const start = app.indexOf('function navDistanceM');
const end = app.indexOf('// Leaving the route no longer triggers rerouting.');
assert.ok(start >= 0 && end > start, 'navigation helper source was not found');

const context = {};
vm.createContext(context);
vm.runInContext(`${app.slice(start, end)}\nthis.buildTurnInstructions = buildTurnInstructions;`, context);

const offerStart = app.indexOf('const OFF_ROUTE_ENTER_M');
const offerEnd = app.indexOf('function navInstructionText', offerStart);
assert.ok(offerStart >= 0 && offerEnd > offerStart, 'route-start offer helper was not found');
context.turnNav = { offRouteCandidateAt: 0, offRouteCandidateFixes: 0 };
vm.runInContext(`${app.slice(offerStart, offerEnd)}
  this.shouldOfferRouteStartConnector = shouldOfferRouteStartConnector;
  this.recordOffRouteCandidate = recordOffRouteCandidate;
  this.clearOffRouteCandidate = clearOffRouteCandidate;`, context);
assert.equal(context.shouldOfferRouteStartConnector(800, 0), false,
  'a rider already on the route must not be sent back to its original start');
assert.equal(context.shouldOfferRouteStartConnector(800, 220), true,
  'a rider at least 0.1 mile from the start and off route should get the connector offer');
assert.equal(context.shouldOfferRouteStartConnector(800, 80), true,
  'a rider beyond the rejoin tolerance is off route even when under the ordinary alert threshold');
assert.equal(context.shouldOfferRouteStartConnector(120, 220), false,
  'ordinary nearest-route guidance should handle a rider within 0.1 mile of the start');
assert.match(app.slice(offerStart, offerEnd), /OFF_ROUTE_ENTER_M = 65;[\s\S]*?OFF_ROUTE_REJOIN_M = 40;/,
  'off-route hysteresis should operate at city-block scale');
assert.equal(context.recordOffRouteCandidate(1_000, 20), false,
  'one accurate off-route fix should not trigger');
assert.equal(context.recordOffRouteCandidate(8_000, 20), true,
  'two consistent accurate fixes should trigger');
context.clearOffRouteCandidate();
assert.equal(context.recordOffRouteCandidate(10_000, 80), false,
  'one coarse off-route fix should not trigger');
assert.equal(context.recordOffRouteCandidate(20_000, 80), false,
  'two coarse off-route fixes should remain a candidate');
assert.equal(context.recordOffRouteCandidate(30_000, 80), true,
  'three consistent coarse fixes should trigger instead of being discarded');
context.clearOffRouteCandidate();
assert.equal(context.recordOffRouteCandidate(40_000, 130), false,
  'an unusably coarse fix should not trigger');
assert.equal(context.turnNav.offRouteCandidateFixes, 0,
  'an unusably coarse fix should not create a candidate');

const automaticStart = app.indexOf('function automaticOffRouteModeDue');
const automaticEnd = app.indexOf('function updateNavigationCamera', automaticStart);
assert.ok(automaticStart >= 0 && automaticEnd > automaticStart,
  'automatic off-route mode helpers were not found');
const automaticActions = [];
const autoContext = vm.createContext({
  Date: { now: () => 70_000 },
  navVoice: { offRouteMode: 'return' },
  turnNav: {
    active: true, offRoute: true, followingConnector: false,
    autoRecoveryAttempted: false, connectorRequestId: null, newRouteRequestId: null,
    offRouteSince: 10_000,
  },
  requestRouteBackToCurrentRoute(options) { automaticActions.push(['return', options]); },
  requestNewRouteFromCurrentLocation(options) { automaticActions.push(['dynamic', options]); },
});
vm.runInContext(`const AUTO_OFF_ROUTE_DELAY_MS = 60_000; ${app.slice(automaticStart, automaticEnd)}
  this.automaticOffRouteModeDue = automaticOffRouteModeDue;
  this.maybeAutomaticallyRecoverOffRoute = maybeAutomaticallyRecoverOffRoute;`, autoContext);
assert.equal(autoContext.automaticOffRouteModeDue(69_999), null,
  'automatic recovery must not fire before 60 continuous seconds');
assert.equal(autoContext.automaticOffRouteModeDue(70_000), 'return',
  'automatic return should become due at 60 continuous seconds');
autoContext.maybeAutomaticallyRecoverOffRoute();
let automaticAction = automaticActions.shift();
assert.equal(automaticAction[0], 'return',
  'automatic return mode should request a connector to the current route');
assert.equal(automaticAction[1].automatic, true, 'automatic return should identify itself as automatic');
autoContext.navVoice.offRouteMode = 'dynamic';
assert.equal(autoContext.automaticOffRouteModeDue(70_000), 'dynamic',
  'dynamic routing should become due on the same 60-second timer');
autoContext.maybeAutomaticallyRecoverOffRoute();
automaticAction = automaticActions.shift();
assert.equal(automaticAction[0], 'dynamic',
  'dynamic mode should request a replacement route from the live location');
assert.equal(automaticAction[1].automatic, true, 'dynamic rerouting should identify itself as automatic');
autoContext.navVoice.offRouteMode = 'guidance';
assert.equal(autoContext.automaticOffRouteModeDue(80_000), null,
  'guidance-only mode must never launch an automatic route');
autoContext.maybeAutomaticallyRecoverOffRoute();
assert.equal(automaticActions.length, 0, 'guidance-only mode should only provide guidance');
autoContext.navVoice.offRouteMode = 'return';
autoContext.turnNav.autoRecoveryAttempted = true;
assert.equal(autoContext.automaticOffRouteModeDue(80_000), null,
  'one off-route interval should not repeatedly launch automatic routes');
autoContext.turnNav.autoRecoveryAttempted = false;
autoContext.turnNav.followingConnector = true;
assert.equal(autoContext.automaticOffRouteModeDue(80_000), null,
  'a rider already following a connector should not be rerouted again');

const coords = [
  [-122.3500, 47.6700],
  [-122.3500, 47.6702],
  [-122.3500, 47.6704],
  [-122.3499, 47.6704],
  [-122.3497, 47.6704],
  [-122.3495, 47.6704],
];

const trailExit = context.buildTurnInstructions({
  coords,
  segs: [
    { c0: 0, c1: 2, name: 'Burke-Gilman Trail', flags: 8, facility: 5, lenM: 44 },
    { c0: 2, c1: 3, name: 'Burke-Gilman Trail', flags: 8, facility: 5, lenM: 8 },
    { c0: 3, c1: 5, name: '24th Avenue Northwest', flags: 0, facility: 0, lenM: 30 },
  ],
});
assert.ok(trailExit.instructions.length > 0, 'trail exit should create a maneuver');
assert.match(trailExit.instructions[0].text, /24th Avenue Northwest/,
  'trail exit should name the destination street');
assert.doesNotMatch(trailExit.instructions[0].text, /onto Burke-Gilman/i,
  'trail exit must not announce the inbound trail as the destination');

const straightPathCrossing = context.buildTurnInstructions({
  coords: [
    [-122.3500, 47.6700],
    [-122.3500, 47.6702],
    [-122.3500, 47.6704],
    [-122.3500, 47.6706],
    [-122.3500, 47.6708],
  ],
  segs: [
    { c0: 0, c1: 2, name: 'Green Lake Cycle Path', flags: 8, facility: 5, lenM: 44 },
    { c0: 2, c1: 3, name: 'Woodland Place North', flags: 0, facility: 0, crossing: 1, lenM: 8 },
    { c0: 3, c1: 4, name: 'Green Lake Cycle Path', flags: 8, facility: 5, lenM: 44 },
  ],
});
assert.match(straightPathCrossing.instructions[0].text, /Continue across Woodland Place North/,
  'a verified road crossing on a straight path should still receive a voice cue');

const unnamedConnector = context.buildTurnInstructions({
  coords,
  segs: [
    { c0: 0, c1: 2, name: 'First Avenue', flags: 0, lenM: 44 },
    { c0: 2, c1: 3, name: '', flags: 0, lenM: 8 },
    { c0: 3, c1: 5, name: 'Second Avenue', flags: 0, lenM: 30 },
  ],
});
assert.match(unnamedConnector.instructions[0].text, /Second Avenue/,
  'a short unnamed junction connector should resolve to the outbound road');

const arrivalStart = app.indexOf('function navigationHasArrived');
const arrivalEnd = app.indexOf('function finishTurnNavigation');
assert.ok(arrivalStart >= 0 && arrivalEnd > arrivalStart, 'arrival helper source was not found');
context.turnNav = {
  route: { coords: [[0, 0], [0.001, 0]], totalM: 111 },
  destinationWasNear: false,
  lastDestinationM: Infinity,
  destinationAwayFixes: 0,
};
vm.runInContext(`${app.slice(arrivalStart, arrivalEnd)}\nthis.navigationHasArrived = navigationHasArrived;`, context);
assert.equal(context.navigationHasArrived([0.00060, 0], { routeM: 70 }), true,
  'arrival should be detected near the destination and end of the route');

context.turnNav.destinationWasNear = false;
context.turnNav.lastDestinationM = Infinity;
context.turnNav.destinationAwayFixes = 0;
assert.equal(context.navigationHasArrived([0.00050, 0], { routeM: 105 }), false,
  'a near miss outside the direct arrival radius should arm pass-through detection');
assert.equal(context.navigationHasArrived([0.00168, 0], { routeM: 111 }), false,
  'one GPS fix moving away should not end navigation prematurely');
assert.equal(context.navigationHasArrived([0.00182, 0], { routeM: 111 }), true,
  'two fixes moving away after passing the destination should end navigation');

const nearestStart = app.indexOf('function projectNavigationSegment');
const nearestEnd = app.indexOf('function updateNavigationCamera', nearestStart);
assert.ok(nearestStart >= 0 && nearestEnd > nearestStart,
  'navigation line-projection helpers were not found');
context.turnNav = {
  routeM: 0,
  nearest: 0,
  route: {
    coords: [[0, 0], [0.02, 0]],
    cumulative: [0, 2226.4],
  },
};
vm.runInContext(`${app.slice(nearestStart, nearestEnd)}\nthis.nearestNavigationPoint = nearestNavigationPoint;`, context);
const midway = context.nearestNavigationPoint(0.01, 0);
assert.ok(midway.offRouteM < 0.5,
  'a rider midway along a long straight edge should remain on route');
assert.ok(Math.abs(midway.routeM - 1113.2) < 1,
  'route progress should interpolate along an edge instead of jumping between vertices');
const offset = context.nearestNavigationPoint(0.01, 0.001);
assert.ok(offset.offRouteM > 110 && offset.offRouteM < 112,
  'off-route distance should be measured to the route line');
assert.ok(Math.abs(offset.point[0] - 0.01) < 1e-6,
  'rejoin guidance should target the projected point on the route');
context.turnNav.route = {
  coords: Array.from({ length: 1202 }, (_, i) => [i * 0.00001, 0]),
  cumulative: Array.from({ length: 1202 }, (_, i) => i),
};
context.turnNav.routeM = 100;
context.turnNav.nearest = 100;
const fullRejoin = context.nearestNavigationPoint(0.01, 0, true);
assert.ok(fullRejoin.index > 950,
  'off-route recovery should scan the whole route rather than the local progress window');

console.log('Navigation guidance tests passed.');
