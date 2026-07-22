#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
assert.match(app, /if \(more\) more\.disabled = false;/,
  'the more-actions menu should remain available before both endpoints are selected');
assert.match(app, /searchInput\.value = currentEndpointName;/,
  'the search field should preview the current endpoint name when replacing it');
assert.match(app, /input\.classList\.contains\('current-endpoint-preview'\)[\s\S]*?input\.value = '';/,
  'focusing the search field should clear the muted current-endpoint preview');
assert.match(app, /addressdetails:\s*'1'/,
  'Net search should request structured locality details');
assert.match(app, /No Net results for/,
  'an empty Net search should render an explicit result message');
assert.match(app, /routing\.pendingRoute = true;[\s\S]*?setRouteOptionsLoading\(true\);[\s\S]*?ensureRouter\(\);/,
  'a route requested before graph readiness should remain visibly queued');
assert.match(app, /routing\.pendingRoute \|\| routing\.routeRequestActive/,
  'routing-map failures should distinguish preloading from real route requests');

const onlineNameStart = app.indexOf('function onlinePlaceResultName');
const onlineNameEnd = app.indexOf('function restoreViewportAfterPlacePicker', onlineNameStart);
assert.ok(onlineNameStart >= 0 && onlineNameEnd > onlineNameStart,
  'online place-name helper source was not found');
const onlineNameContext = vm.createContext({});
vm.runInContext(`${app.slice(onlineNameStart, onlineNameEnd)}\nthis.onlinePlaceResultName = onlinePlaceResultName;`, onlineNameContext);
assert.equal(onlineNameContext.onlinePlaceResultName({
  name: 'Space Needle', display_name: 'Space Needle, Seattle, Washington',
  address: { city: 'Seattle', state: 'Washington' },
}), 'Space Needle, Seattle, Washington', 'Net results should include city and state');
assert.equal(onlineNameContext.onlinePlaceResultName({
  name: 'Everett', display_name: 'Everett, Snohomish County', address: { city: 'Everett' },
}), 'Everett, Washington', 'a city result should not repeat its city and should still show the state');

const computeStart = app.indexOf('function computeRoute()');
const computeEnd = app.indexOf('// Pseudo-source for tapping the route line itself', computeStart);
assert.ok(computeStart >= 0 && computeEnd > computeStart, 'route-computation helper source was not found');
const readinessCalls = [];
const readinessContext = vm.createContext({
  routing: { start: [-122.35, 47.67], end: [-122.30, 47.90], ready: false, pendingRoute: false },
  setRouteOptionsLoading(value) { readinessCalls.push(['loading', value]); },
  ensureRouter() { readinessCalls.push(['ensure']); },
  showRouterProgress(detail, title) { readinessCalls.push(['progress', detail, title]); },
});
vm.runInContext(`${app.slice(computeStart, computeEnd)}\nthis.computeRoute = computeRoute;`, readinessContext);
readinessContext.computeRoute();
assert.equal(readinessContext.routing.pendingRoute, true,
  'a complete route should stay queued until the routing graph is ready');
assert.deepEqual(readinessCalls.map((call) => call[0]), ['loading', 'ensure', 'progress'],
  'a queued route should show loading, prepare the graph, and explain that it will start automatically');

const failureStart = app.indexOf('function handleRouterFailure');
const failureEnd = app.indexOf('async function ensureRouter', failureStart);
assert.ok(failureStart >= 0 && failureEnd > failureStart, 'router-failure helper source was not found');
const preloadRouting = {
  start: null, end: null, pendingRoute: false, routeRequestActive: false,
  reqId: 0, ready: false, loading: true, worker: null, options: [], last: { ok: true },
};
const failureCalls = [];
const failureContext = vm.createContext({
  routing: preloadRouting,
  map: { isStyleLoaded: () => true },
  showRouteActionToast() {}, setRouteOptionsLoading() {}, setRouteStatus() {},
  renderRouteOptionControls() { failureCalls.push('options'); },
  stopTurnNavigation() { failureCalls.push('navigation'); },
  clearStoredRouteDetails() { failureCalls.push('details'); },
  renderRouteCard() { failureCalls.push('card'); }, drawRoute() { failureCalls.push('draw'); },
});
vm.runInContext(`${app.slice(failureStart, failureEnd)}\nthis.handleRouterFailure = handleRouterFailure;`, failureContext);
failureContext.handleRouterFailure('preload interrupted');
assert.equal(preloadRouting.last.ok, true,
  'a background graph preload failure must not replace the current route with a failure');
assert.deepEqual(failureCalls, [], 'a background preload failure must not tear down route UI or navigation');
assert.doesNotMatch(app, /function advanceToMissingEndpoint/,
  'placing one endpoint should not automatically arm the other endpoint');
assert.doesNotMatch(app, /Now choose (?:start|destination)|now set the (?:start|destination)/i,
  'endpoint placement should not prompt riders to choose the other endpoint');
assert.match(app, /setRoutePoint\(kind, lngLat\);[\s\S]*?setRouteStatus\(kind === 'start' \? 'Start set' : 'Destination set'\);/,
  'placing a lone endpoint on the map should simply confirm that placement');
assert.match(app, /function clearWaypointsForEndpointChange\(kind, lngLat\)[\s\S]*?previous\[0\] !== lngLat\.lng[\s\S]*?for \(const via of routing\.vias\) via\.marker\.remove\(\);[\s\S]*?routing\.vias = \[\];[\s\S]*?function setRoutePoint\(kind, lngLat, name = 'Point on map'\) \{[\s\S]*?clearWaypointsForEndpointChange\(kind, lngLat\);/,
  'changing either endpoint should remove every waypoint before recalculating');
assert.match(app, /routing\[mk\]\.on\('dragend', \(\) => \{[\s\S]*?setRoutePoint\(kind, ll\);[\s\S]*?finished\.active && commit\) \{[\s\S]*?setRoutePoint\(kind, ll\);/,
  'desktop and touch marker moves should use the same waypoint-clearing endpoint update');
assert.match(app, /else \{\s*setRouteStatus\(placeTarget === 'start' \? 'Start set' : 'Destination set'\);\s*\}/,
  'selecting a place-search result should simply confirm the selected endpoint');
assert.match(app, /dialog\.showModal\(\);[\s\S]*?dialog\.focus\(\{ preventScroll: true \}\);/,
  'opening Save & Share should focus its dialog rather than preselecting the help button');

const waypointStart = app.indexOf('function clearWaypointsForEndpointChange');
const waypointEnd = app.indexOf('function setRoutePoint', waypointStart);
assert.ok(waypointStart >= 0 && waypointEnd > waypointStart,
  'endpoint waypoint-clearing helper source was not found');
const removedMarkers = [];
const waypointContext = vm.createContext({
  routing: {
    start: [-122.3, 47.6], end: [-122.2, 47.7], arm: 'via',
    vias: [
      { marker: { remove: () => removedMarkers.push('one') } },
      { marker: { remove: () => removedMarkers.push('two') } },
    ],
  },
});
vm.runInContext(`${app.slice(waypointStart, waypointEnd)}\nthis.clearWaypointsForEndpointChange = clearWaypointsForEndpointChange;`, waypointContext);
assert.equal(waypointContext.clearWaypointsForEndpointChange('start', { lng: -122.31, lat: 47.6 }), true,
  'moving an existing endpoint should report that it cleared waypoints');
assert.deepEqual(removedMarkers, ['one', 'two'], 'endpoint changes should remove every waypoint marker');
assert.equal(waypointContext.routing.vias.length, 0, 'endpoint changes should clear every waypoint coordinate');
assert.equal(waypointContext.routing.arm, null, 'endpoint changes should disarm waypoint placement');
assert.equal(waypointContext.clearWaypointsForEndpointChange('end', { lng: -122.2, lat: 47.7 }), false,
  'an unchanged endpoint should not clear waypoints');

console.log('Endpoint selection tests passed.');
