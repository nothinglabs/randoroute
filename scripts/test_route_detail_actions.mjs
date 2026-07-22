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
assert.match(app, /function openRouteDetails\(detailTab = null\) \{[\s\S]*?storeRouteDetails\(routing\.last\)[\s\S]*?\['stats', 'concerns', 'steps'\]\.includes\(detailTab\)[\s\S]*?&tab=\$\{detailTab\}/,
  'opening Details should refresh an already-drawn route with its segment locations');
assert.match(app, /function compactRouteCoords\(m, includeIndices = false\)[\s\S]*?Math\.ceil\(coords\.length \/ 600\)[\s\S]*?const routePreview = compactRouteCoords\(m, true\);[\s\S]*?routeCoords: routePreview\?\.coords \|\| null,[\s\S]*?routeCoordIndices: routePreview\?\.indices \|\| null,[\s\S]*?routeOptions: routeDetailsOptionTabs\(m\)/,
  'Route Details should retain compact preview geometry with the source indexes needed for map colors');
assert.match(app, /function selectRouteDetailsOption\(index, detailTab = null\)[\s\S]*?if \(turnNav\.active\) return;[\s\S]*?activateRouteOption\(option\);[\s\S]*?openRouteDetails\(detailTab\);/,
  'choosing a route in Details should update the map selection while preserving the current Details tab');
assert.match(app, /event\.data\?\.type === 'select-route-details-option'[\s\S]*?selectRouteDetailsOption\(event\.data\.index, event\.data\.tab\)/,
  'the app should accept the current Details tab with a route-choice request');
assert.match(app, /const dialogTitle = turnNav\.active \? 'Active Route Details' : `\$\{routeLabel\} Details`/,
  'navigation should title the report "Active Route Details"');
assert.doesNotMatch(app, /ROUTE_TIME_DISPLAY_MULTIPLIER/,
  'route-choice duration should use the route engine estimate without a display buffer');
assert.match(app, /class="rc-distance">\$\{fmtMi\(m\.distM\)\} mi<\/span><span class="rc-duration">Est\. \$\{fmtDur\(m\.timeS\)\}<\/span>/,
  'the route-choice card should stack miles above its estimated duration');
assert.match(app, /let roadM = 0, roadSpeedM = 0;[\s\S]*?\!\(flags & 8\)[\s\S]*?roadSpeedM \+= mph \* len[\s\S]*?avgRoadSpeedMph: roadM > 0 \? Math\.round\(roadSpeedM \/ roadM\) : null/,
  'the average speed limit should be distance-weighted across all road segments, including bike lanes');
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
assert.match(details, /function routeSummaryStats\(segs\)[\s\S]*?\!\(flags & FLAG_INFRA\)[\s\S]*?avgRoadSpeedMph: roadM > 0 \? Math\.round\(roadSpeedM \/ roadM\) : null[\s\S]*?summaryRoadSpeed\.innerHTML = `<b>\$\{routeStats\.avgRoadSpeedMph == null \? 'N\/A'/,
  'Route Details should show the all-road average speed limit and report unavailable source data as N/A');
assert.match(appCss, /\.rc-ride-items\s*\{[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)[\s\S]*?@media \(max-width: 460px\)[\s\S]*?\.rc-ride-items\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/,
  'the route-card ride classes should balance into two equal columns on narrow phones');
assert.match(appCss, /\.rc-details-wrap\s*\{[^}]*flex-direction:\s*column[^}]*justify-content:\s*flex-end[\s\S]*?\.rc-speed-limit\s*\{[^}]*text-align:\s*center/,
  'the route-choice Details rail should sit at the bottom-left with a compact speed metric above it');
assert.match(css, /\.route-quick-summary\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap[\s\S]*?\.route-summary-mix-items\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/,
  'the shared route summary should keep route metrics and safety percentages compactly together');
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
]).avgRoadSpeedMph`, statsContext), 40,
  'average speed should be distance-weighted across all road types, including bike lanes but excluding paths, ferries, and missing speeds');

const speedStart = details.indexOf('function speedProfileSegments(');
const speedEnd = details.indexOf('function drawElevation(', speedStart);
assert.ok(speedStart >= 0 && speedEnd > speedStart, 'speed-profile helpers were not found');
const speedContext = vm.createContext({
  Math, FLAG_FERRY: 32, FLAG_INFRA: 8,
  isBikeNetwork: (seg) => !!((seg.flags || 0) & 8) || (seg.facility || 0) >= 2,
});
vm.runInContext(details.slice(speedStart, speedEnd), speedContext);
assert.equal(vm.runInContext(`speedProfileSegments([
  { lenM: 100, mph: 35, level: 4 },
  { lenM: 100, mph: 30, facility: 2, level: 1 },
  { lenM: 100, mph: 0, facility: 5, flags: 8, level: 1 },
  { lenM: 100, mph: 25, level: 1 },
  { lenM: 100, mph: 45, level: 3 }
])
  .map((seg) => seg.color + ':' + seg.mph).join('|')`, speedContext),
  'fail:35|bike:30|bike:15|pass:25|caution:45',
  'the speed profile should infer bike paths at 15 mph and use the route safety colors for facilities, passing roads, cautions, and failures');

const previewStart = details.indexOf('function routePreviewPoints(');
const previewEnd = details.indexOf('function routePreviewRenderData(', previewStart);
assert.ok(previewStart >= 0 && previewEnd > previewStart, 'route-preview color helpers were not found');
const previewContext = vm.createContext({
  Math, Number,
  details: {
    segs: [
      { c0: 0, c1: 10, flags: 8, facility: 5, level: 1 },
      { c0: 10, c1: 20, level: 4 },
      { c0: 20, c1: 30, level: 3 },
      { c0: 30, c1: 40, level: 1 },
    ],
  },
  BIKE_NETWORK_COLOR: '#9fc400', PASS_COLOR: '#168ad1', CAUTION_COLOR: '#c46b00', FAIL_COLOR: '#b2182b',
  isBikeNetwork: (seg) => !!((seg.flags || 0) & 8) || (seg.facility || 0) >= 2,
  isDesignated: () => false,
  isMountainBikeTrail: () => false,
});
vm.runInContext(details.slice(previewStart, previewEnd), previewContext);
assert.equal(vm.runInContext(`routePreviewEdgeColors([
  { routeIndex: 0 }, { routeIndex: 10 }, { routeIndex: 20 }, { routeIndex: 30 }, { routeIndex: 40 },
]).join('|')`, previewContext), '#9fc400|#b2182b|#c46b00|#168ad1',
  'the route preview should use the same bike, fail, caution, and pass colors as the map');

assert.match(detailsHtml, /id="routeOptionTabs"[\s\S]*?id="routeQuickSummary"[\s\S]*?id="summary"[\s\S]*?id="summaryMix"[\s\S]*?id="panel-stats"[\s\S]*?id="panel-concerns"[\s\S]*?id="panel-steps"/,
  'route mileage, time, and safety mix should be shared above every Details tab');
assert.match(detailsHtml, /id="panel-stats"[\s\S]*?id="routePreview"[\s\S]*?id="routeSummaryCard"[\s\S]*?id="speedProfile"/,
  'the smaller route map should sit directly below the shared summary, ahead of the charts');
assert.doesNotMatch(detailsHtml, /id="routeRoadSummary"/,
  'road speed should be combined with the speed-limit chart rather than using a separate section');
assert.match(details, /const embeddedDetails = window\.self !== window\.top;[\s\S]*?function renderRouteOptionTabs\(\)[\s\S]*?host\.hidden = !embeddedDetails \|\| options\.length < 2;[\s\S]*?type: 'select-route-details-option',[\s\S]*?tab: selectedDetailTab\(\)/,
  'only non-navigating embedded Details should offer route switching and preserve its current tab');
assert.match(details, /const REQUESTED_DETAIL_TAB[\s\S]*?function restoreInitialDetailTab\(\)[\s\S]*?selectDetailTab\(REQUESTED_DETAIL_TAB\)/,
  'the reloaded report should restore the requested Details tab before showing the new route');
assert.match(details, /function routePreviewStyle\(seg\)[\s\S]*?Number\(seg\.facility\) === 5 \? 'trail' : 'bike'[\s\S]*?isDesignated\(seg\) \? 'designated' : 'pass'[\s\S]*?function initializeRoutePreviewMap\(\)[\s\S]*?new maplibregl\.Map\([\s\S]*?route-preview-colored[\s\S]*?routePreviewMap\.fitBounds/,
  'the Stats preview should be a real map with the same route safety styles');
assert.match(details, /function setRoutePreviewFailPulse\(on\)[\s\S]*?route-preview-fail[\s\S]*?line-opacity[\s\S]*?line-width[\s\S]*?setRoutePreviewFailPulse\(preview\.colored\.features\.some\(\(feature\) => feature\.properties\.style === 'fail'\)\)/,
  'failing route portions should pulse in the Details map preview');
assert.match(detailsHtml, /vendor\/maplibre-gl\.css[\s\S]*?id="routePreviewMap"[\s\S]*?route-preview-attribution[\s\S]*?© OpenStreetMap contributors[\s\S]*?© CARTO[\s\S]*?vendor\/maplibre-gl\.js/,
  'Route Details should load MapLibre with compact, always-visible map attribution');
assert.match(details, /attributionControl:\s*false/,
  'the map library’s expandable attribution control should be replaced by the compact static credit');
assert.match(css, /\.route-option-tabs\s*\{[^}]*position:\s*sticky[\s\S]*?\.route-preview-map\s*\{[^}]*height:\s*122px/,
  'route choices should remain visible at the top and the route map should be reduced by about one fifth');
assert.match(css, /\.detail-panel\[hidden\]\s*\{\s*display:\s*none !important;/,
  'only the selected Route Details panel should be visible');
assert.match(detailsHtml, /id="tab-stats"[\s\S]*?data-detail-tab="stats">Stats<\/button>[\s\S]*?id="tab-concerns"[\s\S]*?id="tab-steps"/,
  'Route Details should present Stats as the first of its three tabs');
assert.match(detailsHtml, /id="speedProfile"[\s\S]*?Speed limits[\s\S]*?Bike paths shown as 15 mph/,
  'Route Details should retain its speed-profile graph');
assert.doesNotMatch(detailsHtml, /speed-profile-legend|speed-profile-swatch/,
  'the speed-profile color legend should be removed');
assert.match(detailsHtml, /id="speedProfile"[\s\S]*?class="speed-profile-info"[\s\S]*?id="summaryRoadSpeed"/,
  'average road speed should appear with the speed-limit chart');
assert.match(css, /\.speed-profile\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(132px, 43%\)[\s\S]*?\.speed-profile-preview\s*\{[^}]*cursor:\s*pointer/,
  'the tighter speed card should keep text left and a tappable chart preview on the right');
assert.match(detailsHtml, /id="speedProfilePreview"[\s\S]*?id="speedProfileCanvas"[\s\S]*?id="speedDialog"[\s\S]*?id="speedDialogCanvas"/,
  'the speed chart should offer an enlarged dialog view');
assert.match(details, /speedPreview\.addEventListener\('click',[\s\S]*?speedDialog\.showModal\(\)[\s\S]*?drawSpeedProfile\(document\.getElementById\('speedDialogCanvas'\)\)/,
  'tapping the speed preview should render its enlarged chart');
assert.match(css, /#elevationDialogCanvas, #speedDialogCanvas\s*\{[^}]*aspect-ratio:\s*1\.45 \/ 1/,
  'both enlarged charts should use a similar compact aspect ratio');
assert.match(details, /summarySub\.innerHTML = `<span class="elevation-metric">[\s\S]*?<b>Climb<\/b>[\s\S]*?<b>Descent<\/b>[\s\S]*?<b>Grade<\/b>/,
  'elevation metrics should use stable label-and-value rows rather than uneven inline wrapping');
const speedDrawStart = details.indexOf('function drawSpeedProfile(');
const speedDrawEnd = details.indexOf('function drawElevation(', speedDrawStart);
assert.ok(speedDrawStart >= 0 && speedDrawEnd > speedDrawStart, 'speed-profile chart renderer was not found');
assert.doesNotMatch(details.slice(speedDrawStart, speedDrawEnd), /distM \/ 1609\.34.*mi/,
  'the speed-limit chart should not label its horizontal axis with route mileage');

const coordsStart = app.indexOf('function compactRouteCoords(');
const coordsEnd = app.indexOf('function routeDetailsOptionTabs(', coordsStart);
assert.ok(coordsStart >= 0 && coordsEnd > coordsStart, 'compact route-preview geometry helper was not found');
const coordsContext = vm.createContext({ Math, Array, Number });
vm.runInContext(`${app.slice(coordsStart, coordsEnd)} this.compactRouteCoords = compactRouteCoords;`, coordsContext);
const previewCoords = vm.runInContext(`compactRouteCoords({ coords: Array.from({ length: 1201 }, (_, i) => [-122.4 + i / 1e5, 47.6 + i / 1e5]) })`, coordsContext);
assert.ok(previewCoords.length <= 601, 'route-preview geometry should remain compact');
assert.equal(JSON.stringify(previewCoords[0]), JSON.stringify([-122.4, 47.6]),
  'route preview should retain its start point');
assert.equal(JSON.stringify(previewCoords.at(-1)), JSON.stringify([-122.388, 47.612]),
  'route preview should retain its end point');
console.log('Route detail action tests passed.');
