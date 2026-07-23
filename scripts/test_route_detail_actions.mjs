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
assert.doesNotMatch(detailsHtml, /routePreviewTitle|>Route map<|>Selected route</,
  'the compact route preview should not repeat a visible title or selection label');
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
assert.match(app, /let roadM = 0, roadSpeedM = 0, unpavedM = 0;[\s\S]*?\!\(flags & 8\)[\s\S]*?roadSpeedM \+= mph \* len[\s\S]*?avgRoadSpeedMph: roadM > 0 \? Math\.round\(roadSpeedM \/ roadM\) : null/,
  'the average speed limit should be distance-weighted across all road segments, including bike lanes');
assert.match(app, /class="rc-details-wrap">[\s\S]*?class="rc-speed-limit"><b>\$\{averageSpeedLimit\}<\/b><span>Avg\. Road<br>Speed Limit<\/span>[\s\S]*?id="routeDetailsSlot"/,
  'the route-choice card should place the number above its average road speed limit label and Details');
assert.match(app, /const hasSteepGradeWarning = Number\(m\.maxGradePct\) > 18;[\s\S]*?id="rcElevGradeWarning"[\s\S]*?<span aria-hidden="true">!<\/span> See Details[\s\S]*?openRouteDetails\('stats'\)/,
  'the route-card elevation chart should flag sustained grades above 18% and open the Stats tab');
assert.match(appCss, /\.rc-elev-wrap\s*\{[^}]*position:\s*relative[\s\S]*?\.rc-elev-grade-warning\s*\{[^}]*position:\s*absolute[^}]*min-height:\s*22px[^}]*color:\s*#b42318[^}]*font:\s*850 10px\/1 system-ui/,
  'the route-card steep-grade warning should overlay the elevation chart in red');
assert.match(details, /streetLine\.textContent = 'Street'[\s\S]*?viewLine\.textContent = 'View'[\s\S]*?mapButton\.className = 'segment-map-button'[\s\S]*?mapLabel\.textContent = 'Map'[\s\S]*?mapIcon\.textContent = '⌖'[\s\S]*?mapButton\.append\(mapLabel, mapIcon\)[\s\S]*?actions\.append\(mapButton, streetView\)/,
  'each route-detail item should put an in-app Map button before its stacked Street View button');
assert.match(details, /window\.parent\.postMessage\(\{ type: 'open-street-view', lat, lng, heading \}, window\.location\.origin\)/,
  'embedded Details should ask the app to open its Street View dialog');
assert.match(details, /function setConcernSectionExpanded\(section, expanded\)[\s\S]*?body\.replaceChildren\(\)[\s\S]*?function renderSection[\s\S]*?concern-section-toggle[\s\S]*?aria-expanded/,
  'Concerns should use collapsed, lazy-rendered sections that release their cards when closed');
assert.match(details, /function scrollToConcernSection\(sectionId\)[\s\S]*?setConcernSectionExpanded\(section, true\)[\s\S]*?scrollIntoView\(\{ behavior: 'smooth', block: 'start' \}\)/,
  'direct links to a concern should expand its collapsed section before scrolling');
assert.doesNotMatch(details, /renderConcernShortcuts|concern-shortcut-/,
  'the collapsed section headers should replace the overloaded concern shortcut buttons');
assert.match(css, /\.concern-section-toggle\s*\{[^}]*grid-template-columns:[^}]*min-height:\s*48px[\s\S]*?\.concern-section\.expanded \.concern-section-chevron[\s\S]*?\.concern-section-body\[hidden\]\s*\{[^}]*display:\s*none/,
  'concern section headers should provide compact, readable accordion controls');
assert.match(app, /event\.data\?\.type === 'open-street-view'[\s\S]*?openStreetView\(lat, lng/,
  'the app should accept Street View requests from its Route Details frame');
assert.doesNotMatch(app, /highlight-route-concern|showRouteConcernOnMap/,
  'concern shortcuts should stay within the Details page rather than alter the map');
assert.match(css, /\.segment-actions\s*\{[^}]*margin-left:\s*auto[\s\S]*?\.segment-streetview\s*\{[^}]*width:\s*42px[^}]*min-height:\s*38px[\s\S]*?\.segment-map-button\s*\{[^}]*display:\s*grid[^}]*width:\s*42px[^}]*min-height:\s*38px/,
  'the equal-sized, stacked Map and Street View controls should align at the card right edge');
assert.match(details, /function failedRoadDetails\(seg, rules\)[\s\S]*?facts\.push\(`\$\{context\} no-shoulder limit: \$\{noShoulderMaxSpeed\(seg, rules\)\} mph`\)[\s\S]*?return \{ meta: failReason\(seg, rules\), metaFacts: facts \}/,
  'rule-failing roads should separate the primary reason from compact supporting facts');
assert.match(details, /item\.metaFacts\?\.length[\s\S]*?meta\.classList\.add\('meta-structured'\)[\s\S]*?reason\.className = 'meta-reason'[\s\S]*?facts\.className = 'meta-facts'/,
  'structured concern metadata should render with a clear reason and fact list');
assert.match(css, /\.concern-section \.detail-item \.meta-structured\s*\{[^}]*display:\s*block[^}]*margin-top:\s*3px[\s\S]*?\.concern-section \.meta-facts\s*\{[^}]*display:\s*inline[\s\S]*?\.concern-section \.meta-facts > span\s*\{[^}]*border:\s*0/,
  'concern facts should use compact inline text instead of tall metadata pills');
assert.match(html, /class="dialog-close streetview-close"[\s\S]*?<span>Close<\/span>/,
  'the embedded Street View close control should have a visible Close label');
assert.match(html, /Location note:<\/b>[\s\S]*?nearest available view may be up to 250 m away[\s\S]*?For trails, it may show a nearby road/,
  'the embedded viewer should clearly explain its nearby-coverage behavior for roads and trails');
assert.match(app, /maps\/embed\/v1\/streetview[\s\S]*?radius=250/,
  'the embedded Street View lookup should search up to 250 m for nearby imagery');
assert.match(appCss, /\.full-help-head \.streetview-close\s*\{[^}]*min-height:\s*42px/,
  'the embedded Street View close control should have a clear hit target');
assert.match(appCss, /\.sv-overlay-notes\s*\{[^}]*position:\s*absolute[\s\S]*?\.sv-coverage-note\s*\{[^}]*border-left:\s*4px solid #f0b44d[^}]*background:[^}]*font:\s*700 12px/,
  'the coverage note should remain visibly emphasized over the panorama');
assert.match(html, /id="streetViewLoadStatus"[\s\S]*?role="status"/,
  'Street View should expose loading and failure status accessibly');
assert.match(app, /Street View is taking longer than expected[\s\S]*?Street View could not load/,
  'Street View should offer the Google Maps fallback after a timeout or load error');
assert.match(app, /class="rc-ride-items[\s\S]*?class="rc-ride-item"[\s\S]*?trails \/ lanes[\s\S]*?pass rules[\s\S]*?rc-ride-fail[\s\S]*?fail rules/,
  'the route card should group its ride classes into equal-width items');
assert.match(details, /class="route-summary-mix-items"[\s\S]*?class="route-summary-mix-item"[\s\S]*?trails \/ lanes[\s\S]*?pass rules[\s\S]*?mix-fail[\s\S]*?fail rules/,
  'Route Details should group its ride classes into equal-width items');
assert.doesNotMatch(details, /class="route-summary-label">Ride<\//,
  'Route Details should not show an unexplained Ride label above its class metrics');
assert.match(details, /function routeSummaryStats\(segs, minShoulderFt = 4\)[\s\S]*?maxRoadSpeedMph[\s\S]*?roadAtOrAbove45M[\s\S]*?highSpeedNoBikeAccommodationOrShoulderM[\s\S]*?mph >= 30[\s\S]*?summaryRoadSpeed\.innerHTML = `<span class="speed-limit-metric">[\s\S]*?At least 45 mph[\s\S]*?speedShoulderNote\.innerHTML[\s\S]*?≥30 mph roads/,
  'Route Details should report average and maximum road speeds, high-speed mileage, and a 30+ mph shoulder/accommodation mileage');
assert.match(css, /\.speed-profile-average\s*\{[^}]*display:\s*grid[^}]*gap:\s*4px[\s\S]*?\.speed-limit-metric\s*\{[^}]*grid-template-columns:\s*max-content minmax\(0, 1fr\)[^}]*gap:\s*9px[\s\S]*?\.speed-limit-metric span\s*\{[^}]*white-space:\s*nowrap/,
  'speed-limit metrics should use a compact vertical list with clear label/value separation');
assert.match(css, /\.speed-shoulder-note\s*\{[^}]*font:\s*650 13px\/1\.35 system-ui/,
  'the high-speed shoulder/accommodation note should remain comfortably readable');
assert.match(appCss, /\.rc-ride-items\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)[\s\S]*?\.rc-ride-items:not\(\.has-dismount\) .rc-ride-item:first-child\s*\{[^}]*grid-column:\s*span 2/,
  'the route-card ride classes should use the compact three-column layout while keeping the lead metric balanced');
assert.match(appCss, /@media \(max-width: 375px\)\s*\{[\s\S]*?#routeCard \.rc-ride-mix\s*\{[^}]*font-size:\s*8\.75px[\s\S]*?#routeCard \.rc-ride-items\s*\{[^}]*gap:\s*3px 2px[\s\S]*?#routeCard \.rc-mix-swatch, #routeCard \.rc-unpaved-swatch\s*\{[^}]*width:\s*10px/,
  'narrow phones should compact route-summary tokens instead of horizontally overflowing');
assert.match(appCss, /@media \(max-width: 340px\)\s*\{[\s\S]*?\.rc-ride-items\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)[\s\S]*?\.rc-ride-item:first-child\s*\{[^}]*grid-column:\s*auto/,
  '320px phones should use two metric columns so nowrap labels cannot collide');
assert.match(appCss, /\.rc-details-wrap\s*\{[^}]*flex-direction:\s*column[^}]*justify-content:\s*flex-end[\s\S]*?\.rc-speed-limit\s*\{[^}]*text-align:\s*center/,
  'the route-choice Details rail should sit at the bottom-left with a compact speed metric above it');
assert.match(css, /\.route-quick-summary\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:[^}]*minmax\(0,\s*1\.3fr\)[\s\S]*?\.route-summary-mix-items\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(2, max-content\)[^}]*justify-self:\s*center/,
  'the shared route summary should stack time under mileage and arrange its metrics in two columns');
assert.match(css, /@media \(max-width: 340px\)\s*\{[\s\S]*?\.route-summary-mix-items\s*\{[^}]*grid-template-columns:\s*max-content/,
  'very narrow phones should fall back to one summary-metric column');
assert.match(details, /summary\.innerHTML\s*=\s*`<strong>\$\{fmtMi\(totals\.distM\)\} mi<\/strong><small>\$\{fmtDur\(totals\.timeS\)\}<\/small>`/,
  'the shared route summary should place time under mileage');
assert.match(details, /summaryMix\.innerHTML[\s\S]*totals\.ferryM > 0[\s\S]*mix-ferry[\s\S]*fmtMi\(totals\.ferryM\)[\s\S]*speedShoulderNote/,
  'ferry mileage should appear with the top summary metrics');
assert.doesNotMatch(details, /summarySub\.innerHTML[^;]*Ferry/,
  'ferry mileage should no longer appear in the elevation metrics');
assert.match(app, /description: routeDetailsOptimizationDescription\(m\.optimization\)/,
  'route-search rationale should remain stored for future Route Details rendering');
assert.doesNotMatch(detailsHtml, /Tap any road, concern, or step/,
  'Route Details should not repeat the map-tapping instruction');
assert.match(details, /Uses mapped sidewalks as a route fallback\./,
  'the sidewalk concern should explain the fallback briefly');
assert.doesNotMatch(details, /Verify local bicycle rules and conditions|called out for judgment but are not road-rule failures|mapped sidewalk fallback · strongly deprioritized/,
  'sidewalk concerns should avoid redundant legality and implementation lectures');
assert.match(details, /meta: `\$\{s\.mph\} mph · \$\{\(s\.official \|\| 0\) & OFFICIAL_URBAN \? 'urban' : 'rural'\} road`/,
  'sidewalk concern items should show only speed and area context');
assert.doesNotMatch(details, /meta: `[^`]*mapped sidewalk fallback/,
  'sidewalk concern items should not repeat their section label');
assert.match(details, /title\.textContent = 'Route concerns'[\s\S]*?list\.className = 'route-alert-list'[\s\S]*?alert\.replaceChildren\(title, list\)/,
  'the top concern summary should render as a scannable list instead of a sentence');
assert.match(css, /\.route-alert-list\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)[^}]*font:\s*700 11\.5px\/1\.25 system-ui/,
  'the compact concern summary should use a readable two-column phone layout');
assert.doesNotMatch(detailsHtml, /id="(?:optimization|mapTapHint)"/,
  'Route Details should not need compatibility placeholders once updates are atomic');
assert.doesNotMatch(detailsHtml, /route-optimization|tap-hint/,
  'Route Details should not display the route-search rationale or map-tapping instruction');
assert.doesNotMatch(details, /of this route does not meet your riding rules/,
  'Route Details should not repeat the failing-route distance above its concerns');
assert.match(details, /snapNotes\.push\(`Destination off route by \$\{fmtDist\(details\.snapEndM\)\}`\)[\s\S]*?note\.textContent = `Note: \$\{snapNotes\.join\(' · '\)\}\.`/,
  'pin warnings should identify the affected pin in a compact distance note');
assert.match(details, /if \(failing\.length\) renderSection[\s\S]*?if \(dismounts\.length\) renderSection[\s\S]*?if \(steepGrades\.length\) renderSection[\s\S]*?if \(sidewalkFallbacks\.length\) renderSection/,
  'concern sections should put rule failures first and sidewalk fallback last');
assert.match(app, /routeDetailsDialog'\)\?\.addEventListener\('close'[\s\S]*?frame\.src = 'about:blank'/,
  'closing Route Details should unload its iframe and release the report map and cards');

const consolidateStart = details.indexOf('function consolidateConcernItems(');
const consolidateEnd = details.indexOf('function populateSectionBody(', consolidateStart);
assert.ok(consolidateStart >= 0 && consolidateEnd > consolidateStart,
  'concern consolidation helper was not found');
const consolidateContext = vm.createContext({ Map, Number, String });
vm.runInContext(details.slice(consolidateStart, consolidateEnd), consolidateContext);
const consolidated = vm.runInContext(`consolidateConcernItems([
  { name: 'Example Road', lenM: 100, riskScore: 50, meta: '50 mph', startIndex: 1 },
  { name: 'Example Road', lenM: 200, riskScore: 60, meta: '60 mph', startIndex: 9 },
  { name: 'Unnamed road', lenM: 20, riskScore: 5, startIndex: 12 },
  { name: 'Unnamed road', lenM: 30, riskScore: 6, startIndex: 15 }
])`, consolidateContext);
assert.equal(consolidated.length, 3, 'named concern fragments should combine while unnamed roads stay distinct');
assert.equal(consolidated[0].lenM, 300, 'combined concern mileage should include every matching fragment');
assert.equal(consolidated[0].meta, '60 mph', 'combined concerns should display the worst representative condition');
assert.equal(consolidated[0].startIndex, 9, 'map actions should target the worst representative segment');

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
  isConfirmedUnpavedSurface: (surface) => surface === 2 || surface === 3,
  isDismountSegment: (seg) => !!seg.dismount || !!((seg.official || 0) & 8),
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
assert.equal(vm.runInContext(`routeSummaryStats([
  { lenM: 1609.34, mph: 45, sh: 2 },
  { lenM: 804.67, mph: 35, sh: 4 },
  { lenM: 804.67, mph: 50, facility: 1, sh: 0 },
  { lenM: 804.67, mph: 20, flags: 8 }
]).maxRoadSpeedMph`, statsContext), 50,
  'the speed summary should report the maximum legal road speed');
assert.equal(vm.runInContext(`routeSummaryStats([
  { lenM: 1609.34, mph: 45, sh: 2 },
  { lenM: 804.67, mph: 35, sh: 4 },
  { lenM: 804.67, mph: 50, facility: 1, sh: 0 },
  { lenM: 804.67, mph: 20, flags: 8 }
]).avgRoadSpeedMph`, statsContext), 44,
  'the expanded speed metrics should preserve the distance-weighted average');
assert.ok(Math.abs(vm.runInContext(`routeSummaryStats([
  { lenM: 1609.34, mph: 45, sh: 2 },
  { lenM: 804.67, mph: 35, sh: 4 },
  { lenM: 804.67, mph: 50, facility: 1, sh: 0 },
  { lenM: 804.67, mph: 20, flags: 8 }
]).roadAtOrAbove45M`, statsContext) - 2414.01) < .001,
  'the 45 mph metric should count every road segment at or above that limit');
assert.equal(vm.runInContext(`routeSummaryStats([
  { lenM: 1609.34, mph: 45, sh: 2 },
  { lenM: 804.67, mph: 35, sh: 4 },
  { lenM: 804.67, mph: 50, facility: 2, sh: 0 },
  { lenM: 804.67, mph: 20, flags: 8 }
]).highSpeedNoBikeAccommodationOrShoulderM`, statsContext), 1609.34,
  'the shoulder metric should exclude bike accommodation and retain unknown or narrow shoulders on 30+ mph roads');

const speedStart = details.indexOf('function speedProfileSegments(');
const speedEnd = details.indexOf('function drawElevation(', speedStart);
assert.ok(speedStart >= 0 && speedEnd > speedStart, 'speed-profile helpers were not found');
const speedContext = vm.createContext({
  Math, FLAG_FERRY: 32, FLAG_INFRA: 8,
  isBikeNetwork: (seg) => !!((seg.flags || 0) & 8) || (seg.facility || 0) >= 1,
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
  isConfirmedUnpavedSurface: (surface) => surface === 2 || surface === 3,
  isDismountSegment: (seg) => !!seg.dismount || !!((seg.official || 0) & 8),
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
assert.match(details, /function isBikeNetwork\(seg\)[\s\S]*?\(seg\.facility \|\| 0\) >= 1/,
  'Route Details should count shared-lane markings as bike facilities');
assert.match(app, /const ROUTE_SEG_BIKE_EXPR = \['any',[\s\S]*?\['>=', \['get', 'facility'\], 1\][\s\S]*?good_facility: facility >= 1/,
  'the main map and route readout should treat shared-lane markings as bike facilities');
assert.match(details, /function setRoutePreviewFailPulse\(on\)[\s\S]*?route-preview-fail[\s\S]*?line-opacity[\s\S]*?line-width[\s\S]*?setRoutePreviewFailPulse\(preview\.colored\.features\.some\(\(feature\) => feature\.properties\.style === 'fail'\)\)/,
  'failing route portions should pulse in the Details map preview');
assert.match(detailsHtml, /vendor\/maplibre-gl\.css[\s\S]*?id="routePreviewMap"[\s\S]*?route-preview-attribution[\s\S]*?© OpenStreetMap contributors[\s\S]*?© CARTO[\s\S]*?vendor\/maplibre-gl\.js/,
  'Route Details should load MapLibre with compact, always-visible map attribution');
assert.match(details, /attributionControl:\s*false/,
  'the map library’s expandable attribution control should be replaced by the compact static credit');
assert.match(css, /body\.embedded\s*\{[^}]*padding:\s*10px 16px[\s\S]*?\.route-option-tabs\s*\{[^}]*position:\s*sticky[^}]*align-items:\s*center[^}]*flex-wrap:\s*nowrap[^}]*padding:\s*3px[\s\S]*?\.route-option-tabs::before\s*\{[^}]*flex:\s*0 0 auto[^}]*content:\s*'Choose route'[^}]*font:\s*800 8\.5px\/1\.05 system-ui[\s\S]*?\.route-option-tabs button\s*\{[^}]*min-height:\s*32px[\s\S]*?\.route-preview-map\s*\{[^}]*height:\s*122px/,
  'route choices should sit in a single compact row beneath the Details title, and the route map should be reduced by about one fifth');
assert.match(css, /\.detail-panel\[hidden\]\s*\{\s*display:\s*none !important;/,
  'only the selected Route Details panel should be visible');
assert.match(detailsHtml, /id="tab-stats"[\s\S]*?data-detail-tab="stats">Stats<\/button>[\s\S]*?id="tab-concerns"[\s\S]*?id="tab-steps"/,
  'Route Details should present Stats as the first of its three tabs');
assert.match(detailsHtml, /id="speedProfile"[\s\S]*?Speed Limits \(Roads Only\)[\s\S]*?id="speedProfilePreview"/,
  'Route Details should retain its speed-profile graph');
assert.doesNotMatch(detailsHtml, /Bike paths shown as 15 mph|Bike paths are shown as 15 mph/,
  'the speed-limit cards should not repeat the bike-path display note');
assert.doesNotMatch(detailsHtml, /speed-profile-legend|speed-profile-swatch/,
  'the speed-profile color legend should be removed');
assert.match(detailsHtml, /id="speedProfile"[\s\S]*?class="speed-profile-info"[\s\S]*?id="summaryRoadSpeed"/,
  'average road speed should appear with the speed-limit chart');
assert.match(css, /\.speed-profile\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(136px, 45%\)[\s\S]*?\.speed-profile-preview\s*\{[^}]*cursor:\s*pointer[\s\S]*?#panel-stats \.speed-profile-preview\s*\{[^}]*min-height:\s*100px/,
  'the speed card should keep text left while giving its tappable chart a little more room');
assert.match(detailsHtml, /id="speedProfilePreview"[\s\S]*?id="speedProfileCanvas"[\s\S]*?id="speedDialog"[\s\S]*?id="speedDialogCanvas"/,
  'the speed chart should offer an enlarged dialog view');
assert.equal((detailsHtml.match(/Tap anywhere on the chart to show that route segment on the map\./g) || []).length, 2,
  'both enlarged charts should explain that a tap opens the corresponding map segment');
assert.match(detailsHtml, /id="elevationPreview"[\s\S]*?class="chart-expand-note"[\s\S]*?Tap to expand[\s\S]*?id="speedProfilePreview"[\s\S]*?class="chart-expand-note"/,
  'both compact charts should explain that they can be expanded');
assert.match(details, /speedPreview\.addEventListener\('click',[\s\S]*?speedDialog\.showModal\(\)[\s\S]*?drawSpeedProfile\(document\.getElementById\('speedDialogCanvas'\)\)/,
  'tapping the speed preview should render its enlarged chart');
assert.match(details, /function routeSegmentAtDistance\(distanceM\)[\s\S]*?startIndex:\s*index[\s\S]*?coordStart:\s*seg\?\.c0[\s\S]*?function chartDistanceAtPointer\(canvas, event, padL, padR\)[\s\S]*?function bindExpandedChartMapTap\(canvas, dialog, padL, padR\)[\s\S]*?dialog\.close\(\);[\s\S]*?showRouteStep\(segment\)/,
  'expanded charts should translate a horizontal tap into a route segment and hand it to the map');
assert.match(details, /bindExpandedChartMapTap\(document\.getElementById\('speedDialogCanvas'\), speedDialog, 6, 6\)[\s\S]*?bindExpandedChartMapTap\(document\.getElementById\('elevationDialogCanvas'\), elevationDialog, 8, 8\)/,
  'both enlarged chart canvases should enable map navigation with their rendered plot padding');
assert.match(css, /#elevationDialogCanvas, #speedDialogCanvas\s*\{[^}]*aspect-ratio:\s*1\.45 \/ 1/,
  'both enlarged charts should use a similar compact aspect ratio');
assert.match(css, /\.elevation-dialog-body \.chart-map-hint\s*\{[^}]*color:\s*#1769aa[\s\S]*?\.chart-map-target\s*\{[^}]*cursor:\s*pointer/,
  'expanded chart navigation should have visible instructions and an interactive cursor');
assert.match(details, /summarySub\.innerHTML = `<span class="elevation-metric">[\s\S]*?<b>Climb<\/b>[\s\S]*?<b>Descent<\/b>[\s\S]*?<b>Avg\. grade<\/b>[\s\S]*?<b>Max grade<\/b>[\s\S]*?<b>10%\+ uphill<\/b>[\s\S]*?fmtMi\(steepUphillM\)/,
  'elevation metrics should include the mileage of sustained uphill grade over 10%');
assert.match(detailsHtml, /button id="elevationSteepWarning"[\s\S]*?class="elevation-warning-message"[\s\S]*?grades that may be impassable[\s\S]*?class="elevation-warning-action"[\s\S]*?Tap to review[\s\S]*?Grades[\s\S]*?in Concerns/,
  'the elevation card should clearly explain the steep-grade route warning as an action');
assert.match(details, /elevationSteepWarning\.addEventListener\('click',[\s\S]*?selectDetailTab\('concerns'\)[\s\S]*?requestAnimationFrame\(\(\) => scrollToConcernSection\('concern-steep-grades'\)\)/,
  'tapping the elevation warning should open Concerns at Steep Grades');
assert.match(details, /elevationSteepWarning\.hidden = !\(maxGradePct > 18\)/,
  'the steep-grade elevation warning should appear only above 18%');
assert.match(css, /\.elevation-steep-warning\s*\{[^}]*grid-column:\s*1\s*\/\s*-1[^}]*width:\s*100%[^}]*border-left:\s*4px solid #c33327[^}]*cursor:\s*pointer/,
  'the steep-grade elevation warning should span the card as a prominent, tappable warning');
assert.match(css, /\.elevation-warning-message\s*\{[^}]*clamp\(9px, 2\.6vw, 10px\)[^}]*white-space:\s*nowrap/,
  'the warning sentence should remain intact on a single responsive line');
assert.match(details, /const STEEP_UPHILL_CONCERN_PCT = 10;[\s\S]*?function sustainedUphillGradeConcerns\(segs, thresholdPct = STEEP_UPHILL_CONCERN_PCT\)[\s\S]*?sample\.gradePct > thresholdPct[\s\S]*?const steepGrades = consolidateConcernItems\(sustainedUphillGradeConcerns\(segs\)[\s\S]*?renderSection\(report, 'Steep uphill grades \(over 10%\)', steepGrades, '', 'caution', false, 'concern-steep-grades', 'Note: May contain errors due to data quality\.', true\)/,
  'Concerns should list only sustained uphill segments whose grade exceeds 10% and disclose data quality limits');
assert.match(details, /const minSpeed = 10;[\s\S]*?Math\.min\(maxSpeed - minSpeed, Math\.max\(0, mph - minSpeed\)\)[\s\S]*?mph === minSpeed\) ctx\.fillText\(`\$\{mph\} mph`/,
  'the speed chart should use and visibly label a 10 mph baseline');
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
