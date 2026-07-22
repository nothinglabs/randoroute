#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const details = fs.readFileSync(new URL('../route-details.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../route-details.css', import.meta.url), 'utf8');
const appCss = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const detailsHtml = fs.readFileSync(new URL('../route-details.html', import.meta.url), 'utf8');

assert.match(app, /locationStart: locationAt\(s\.c0\), locationEnd: locationAt\(s\.c1\)/,
  'stored route details should retain a compact on-road point for each segment');
assert.match(app, /function openRouteDetails\(\) \{[\s\S]*?storeRouteDetails\(routing\.last\)/,
  'opening Details should refresh an already-drawn route with its segment locations');
assert.doesNotMatch(app, /ROUTE_TIME_DISPLAY_MULTIPLIER/,
  'route-choice duration should use the route engine estimate without a display buffer');
assert.match(app, /class="rc-distance">\$\{fmtMi\(m\.distM\)\} mi<\/span><span class="rc-duration">Est\. \$\{fmtDur\(m\.timeS\)\}<\/span>/,
  'the route-choice card should stack miles above its estimated duration');
assert.match(app, /let ordinaryRoadM = 0, ordinaryRoadSpeedM = 0;[\s\S]*?\(s\.facility \|\| 0\) < 2[\s\S]*?ordinaryRoadSpeedM \+= mph \* len[\s\S]*?avgRoadSpeedMph: ordinaryRoadM > 0 \? Math\.round\(ordinaryRoadSpeedM \/ ordinaryRoadM\) : null/,
  'the average speed limit should be distance-weighted across ordinary, non-bike-facility road segments');
assert.match(app, /class="rc-details-wrap">[\s\S]*?class="rc-speed-limit"><b>\$\{averageSpeedLimit\}<\/b><span>Avg\. Road<br>Speed Limit<\/span>[\s\S]*?id="routeDetailsSlot"/,
  'the route-choice card should place the number above its average road speed limit label and Details');
assert.match(details, /streetLine\.textContent = 'Street'[\s\S]*?viewLine\.textContent = 'View'[\s\S]*?mapButton\.className = 'segment-map-button'[\s\S]*?mapLabel\.textContent = 'Map'[\s\S]*?mapIcon\.textContent = '⌖'[\s\S]*?mapButton\.append\(mapLabel, mapIcon\)[\s\S]*?actions\.append\(mapButton, streetView\)/,
  'each route-detail item should put an in-app Map button before its stacked Street View button');
assert.match(details, /window\.parent\.postMessage\(\{ type: 'open-street-view', lat, lng, heading \}, window\.location\.origin\)/,
  'embedded Details should ask the app to open its Street View dialog');
assert.match(app, /event\.data\?\.type === 'open-street-view'[\s\S]*?openStreetView\(lat, lng/,
  'the app should accept Street View requests from its Route Details frame');
assert.match(css, /\.segment-actions\s*\{[^}]*margin-left:\s*auto[\s\S]*?\.segment-streetview\s*\{[^}]*width:\s*42px[^}]*min-height:\s*38px[\s\S]*?\.segment-map-button\s*\{[^}]*display:\s*grid[^}]*width:\s*42px[^}]*min-height:\s*38px/,
  'the equal-sized, stacked Map and Street View controls should align at the card right edge');
assert.match(html, /class="dialog-close streetview-close"[\s\S]*?<span>Close<\/span>/,
  'the embedded Street View close control should have a visible Close label');
assert.match(html, /No view within 200 m\?[\s\S]*?Open in Google Maps/,
  'the embedded viewer should use a concise nearby-coverage fallback');
assert.match(appCss, /\.full-help-head \.streetview-close\s*\{[^}]*min-height:\s*42px/,
  'the embedded Street View close control should have a clear hit target');
assert.match(appCss, /\.sv-coverage-note\s*\{[^}]*position:\s*absolute/,
  'the coverage fallback should remain visible over an unavailable panorama');
assert.match(app, /class="rc-ride-items"[\s\S]*?class="rc-ride-item"[\s\S]*?trails \/ bike lanes[\s\S]*?pass rules[\s\S]*?rc-ride-fail[\s\S]*?fail rules/,
  'the route card should group its ride classes into equal-width items');
assert.match(details, /class="route-summary-mix-items"[\s\S]*?class="route-summary-mix-item"[\s\S]*?trails \/ bike lanes[\s\S]*?pass rules[\s\S]*?mix-fail[\s\S]*?fail rules/,
  'Route Details should group its ride classes into equal-width items');
assert.doesNotMatch(details, /class="route-summary-label">Ride<\//,
  'Route Details should not show an unexplained Ride label above its class metrics');
assert.match(details, /function routeSummaryStats\(segs\)[\s\S]*?!isBikeNetwork\(seg\)[\s\S]*?avgRoadSpeedMph: ordinaryRoadM > 0 \? Math\.round\(ordinaryRoadSpeedM \/ ordinaryRoadM\) : null[\s\S]*?summaryRoadSpeed\.textContent = `Avg\. speed limit: \$\{routeStats\.avgRoadSpeedMph == null \? 'N\/A'/,
  'Route Details should show the ordinary-road average speed limit and report unavailable source data as N/A');
assert.match(appCss, /\.rc-ride-items\s*\{[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)[\s\S]*?@media \(max-width: 460px\)[\s\S]*?\.rc-ride-items\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/,
  'the route-card ride classes should balance into two equal columns on narrow phones');
assert.match(appCss, /\.rc-details-wrap\s*\{[^}]*flex-direction:\s*column[^}]*justify-content:\s*flex-end[\s\S]*?\.rc-speed-limit\s*\{[^}]*text-align:\s*center/,
  'the route-choice Details rail should sit at the bottom-left with a compact speed metric above it');
assert.match(css, /\.route-summary-mix-items\s*\{[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)[\s\S]*?@media \(max-width: 460px\)[\s\S]*?\.route-summary-mix-items\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/,
  'the Route Details ride classes should balance into two equal columns on narrow phones');
assert.match(app, /description: routeDetailsOptimizationDescription\(m\.optimization\)/,
  'route-search rationale should remain stored for future Route Details rendering');
assert.doesNotMatch(detailsHtml, /Tap any road, concern, or step/,
  'Route Details should not repeat the map-tapping instruction');
assert.doesNotMatch(detailsHtml, /id="(?:optimization|mapTapHint)"/,
  'Route Details should not need compatibility placeholders once updates are atomic');
assert.doesNotMatch(detailsHtml, /route-optimization|tap-hint/,
  'Route Details should not display the route-search rationale or map-tapping instruction');
assert.doesNotMatch(details, /of this route does not meet your riding rules/,
  'Route Details should not repeat the failing-route distance above its concerns');
assert.match(details, /snapNotes\.push\(`Destination off route by \$\{fmtDist\(details\.snapEndM\)\}`\)[\s\S]*?note\.textContent = `Note: \$\{snapNotes\.join\(' · '\)\}\.`/,
  'pin warnings should identify the affected pin in a compact distance note');

const helperStart = details.indexOf('function lngLat(');
const helperEnd = details.indexOf('function routePercent(', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'route-detail map helpers were not found');
const context = vm.createContext({ Math });
vm.runInContext(details.slice(helperStart, helperEnd), context);
assert.equal(vm.runInContext('itemLocation({ locationStart: [-122.1, 47.6] }).join(",")', context), '-122.1,47.6',
  'a route item should use its stored start point');
const eastHeading = vm.runInContext('itemStreetViewHeading({ locationStart: [-122.1, 47.6], locationEnd: [-122.09, 47.6] })', context);
assert.ok(Math.abs(eastHeading - 90) < 1,
  'a route-detail Street View action should face along an east-west road');

const statsStart = details.indexOf('function routeSummaryStats(');
const statsEnd = details.indexOf('function credibleSegmentGradePct(', statsStart);
assert.ok(statsStart >= 0 && statsEnd > statsStart, 'route-summary statistics helpers were not found');
const statsContext = vm.createContext({
  Math, FLAG_INFRA: 8, FLAG_FERRY: 32,
  isBikeNetwork: (seg) => !!((seg.flags || 0) & 8) || (seg.facility || 0) >= 2,
});
vm.runInContext(details.slice(statsStart, statsEnd), statsContext);
assert.equal(vm.runInContext(`routeSummaryStats([
  { lenM: 100, mph: 30, sh: 0 },
  { lenM: 300, mph: 40, sh: 8 },
  { lenM: 100, mph: 50, facility: 2 },
  { lenM: 100, mph: 20, flags: 8 },
  { lenM: 100, mph: 35, flags: 32 },
  { lenM: 100, mph: 0 }
]).avgRoadSpeedMph`, statsContext), 38,
  'average speed should be distance-weighted across roads with or without shoulders, excluding bike facilities, infrastructure, ferries, and missing speeds');

const speedStart = details.indexOf('function speedProfileFailsShoulder(');
const speedEnd = details.indexOf('function drawElevation(', speedStart);
assert.ok(speedStart >= 0 && speedEnd > speedStart, 'speed-profile helpers were not found');
const speedContext = vm.createContext({
  Math, FLAG_FERRY: 32, FLAG_INFRA: 8, FLAG_DESIGNATED: 64,
  isBikeNetwork: (seg) => !!((seg.flags || 0) & 8) || (seg.facility || 0) >= 2,
});
vm.runInContext(details.slice(speedStart, speedEnd), speedContext);
assert.equal(vm.runInContext(`speedProfileSegments([
  { lenM: 100, mph: 35, sh: 2 },
  { lenM: 100, mph: 30, facility: 2 },
  { lenM: 100, mph: 0, facility: 5, flags: 8 },
  { lenM: 100, mph: 25, sh: 0 },
  { lenM: 100, mph: 45, sh: 0, flags: 64 }
], { minShoulder: 4, freeMaxSpeed: 30, unknownShoulderZero: true, vettedBikeRoutes: true })
  .map((seg) => seg.color + ':' + seg.mph).join('|')`, speedContext),
  'shoulder-fail:35|bike:30|bike:15|road:25|road:45',
  'the speed profile should infer bike paths at 15 mph, highlight facilities lime, and flag only active shoulder-rule failures red');
assert.match(detailsHtml, /id="speedProfile"[\s\S]*?Speed limits[\s\S]*?bike paths shown as 15 mph[\s\S]*?Bike lane or trail[\s\S]*?Fails shoulder rule/,
  'Route Details should include a clear speed-profile graph and legend');
console.log('Route detail action tests passed.');
