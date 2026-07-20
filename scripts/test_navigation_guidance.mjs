#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
assert.match(html, /id="navOffRouteBtn"[^>]*>Off-route: Tap to Re-route</,
  'off-route navigation should expose the full-width reroute action');
assert.match(html, /class="nav-banner-copy"[\s\S]*?id="navDetailsBtn"[\s\S]*?id="navOffRouteBtn"/,
  'the off-route action should sit below the preserved navigation information');
assert.match(html, /New Route From Current Location[\s\S]*?Route back to current route[\s\S]*?Keep current route/,
  'off-route recovery dialog should present all three explicit choices');
assert.match(css, /\.nav-banner\.off-route-action-visible\s*\{[^}]*display:\s*grid[\s\S]*?\.nav-off-route-action\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/,
  'off-route action should span a bottom row across the navigation banner');
assert.doesNotMatch(css, /off-route-action-visible[^}]*[\s\S]{0,100}nav-banner-copy[^}]*display:\s*none/,
  'off-route state must preserve the maneuver information');
assert.match(app, /ROUTE_START_OFFER_M\s*=\s*160\.934/,
  'route-to-start should be offered at one tenth of a mile');
assert.match(app, /type:\s*'route-connector'/,
  'navigation should request a separate route-to-start connector');
assert.match(app, /id:\s*'route-connector'/,
  'the connector should have its own visible map layer');
assert.match(app, /AUTO_REROUTE_DELAY_MS\s*=\s*60_000/,
  'automatic rerouting should wait for 60 continuous seconds off route');
assert.match(app, /function requestRouteBackToCurrentRoute[\s\S]*?nearestNavigationPoint\([\s\S]*?turnNav\.plannedRoute\)/,
  'route-back should target the nearest point on the original planned route');
assert.match(app, /type:\s*'navigation-new-route'/,
  'the off-route menu should support a new route from the live location');
assert.match(app, /navVoice\.autoReroute[\s\S]*?maybeAutomaticallyReroute/,
  'the turn-by-turn automatic-rerouting preference should drive recovery');
assert.match(app, /function activateNewRouteFromCurrentLocation[\s\S]*?if \(!result\.ok[\s\S]*?return;[\s\S]*?routing\.start = start/,
  'a failed current-location calculation must return before replacing the planned route');
assert.match(app, /type:\s*'navigation-new-route'[\s\S]*?prefDesignated:\s*routing\.prefDesig,[\s\S]*?prefResidential:\s*routing\.prefResidential/,
  'a current-location route should use the live preference toggles exactly');
const start = app.indexOf('function navDistanceM');
const end = app.indexOf('// Leaving the route no longer triggers rerouting.');
assert.ok(start >= 0 && end > start, 'navigation helper source was not found');

const context = {};
vm.createContext(context);
vm.runInContext(`${app.slice(start, end)}\nthis.buildTurnInstructions = buildTurnInstructions;`, context);

const offerStart = app.indexOf('const OFF_ROUTE_ENTER_M');
const offerEnd = app.indexOf('function navInstructionText', offerStart);
assert.ok(offerStart >= 0 && offerEnd > offerStart, 'route-start offer helper was not found');
vm.runInContext(`${app.slice(offerStart, offerEnd)}\nthis.shouldOfferRouteStartConnector = shouldOfferRouteStartConnector;`, context);
assert.equal(context.shouldOfferRouteStartConnector(800, 0), false,
  'a rider already on the route must not be sent back to its original start');
assert.equal(context.shouldOfferRouteStartConnector(800, 220), true,
  'a rider at least 0.1 mile from the start and off route should get the connector offer');
assert.equal(context.shouldOfferRouteStartConnector(800, 80), true,
  'a rider beyond the rejoin tolerance is off route even when under the ordinary alert threshold');
assert.equal(context.shouldOfferRouteStartConnector(120, 220), false,
  'ordinary nearest-route guidance should handle a rider within 0.1 mile of the start');

const automaticStart = app.indexOf('function automaticRerouteIsDue');
const automaticEnd = app.indexOf('function maybeAutomaticallyReroute', automaticStart);
assert.ok(automaticStart >= 0 && automaticEnd > automaticStart,
  'automatic-reroute timing helper was not found');
const autoContext = vm.createContext({
  navVoice: { autoReroute: true },
  turnNav: {
    active: true, offRoute: true, followingConnector: false,
    autoRerouteAttempted: false, connectorRequestId: null, newRouteRequestId: null,
    offRouteSince: 10_000,
  },
});
vm.runInContext(`const AUTO_REROUTE_DELAY_MS = 60_000; ${app.slice(automaticStart, automaticEnd)}
  this.automaticRerouteIsDue = automaticRerouteIsDue;`, autoContext);
assert.equal(autoContext.automaticRerouteIsDue(69_999), false,
  'automatic rerouting must not fire before 60 continuous seconds');
assert.equal(autoContext.automaticRerouteIsDue(70_000), true,
  'automatic rerouting should become due at 60 continuous seconds');
autoContext.turnNav.autoRerouteAttempted = true;
assert.equal(autoContext.automaticRerouteIsDue(80_000), false,
  'one off-route interval should not repeatedly launch automatic routes');
autoContext.turnNav.autoRerouteAttempted = false;
autoContext.turnNav.followingConnector = true;
assert.equal(autoContext.automaticRerouteIsDue(80_000), false,
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
