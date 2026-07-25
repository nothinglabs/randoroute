#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

assert.match(html, /id="legendFlyout"[\s\S]*?id="legend"[\s\S]*?Tap any path on map to get details\./,
  'the map legend should end with a compact path-details tip');
assert.match(app, /\['dismount', 'Dismount point — walk your bike'\],[\s\S]*?legend-dismount-swatch">⚠<\/span>/,
  'the dismount legend should use its warning marker once, in the swatch');
assert.match(html, /id="appHelpDialog"[\s\S]*?The letters identify routes; they are not safety grades[\s\S]*?Tap <b>Navigate<\/b> for GPS and voice guidance[\s\S]*?Tap any road or trail to get more information or access <b>Google Street View<\/b>/,
  'quick-start help should distinguish route choices, navigation, and road-information access');
const quickStartHelp = html.match(/<dialog id="appHelpDialog"[\s\S]*?<\/dialog>/)?.[0] || '';
assert.match(quickStartHelp, /<b>⋮<\/b> to add a waypoint \(route through a point\) or road block \(avoid roads near a point\)/,
  'quick-start help should explain the two route constraints under the overflow menu');
assert.doesNotMatch(quickStartHelp, /Layers<\/b> changes only what you see|Routing and safety colors update on this device/,
  'quick-start help should omit the removed layers and disclaimer copy');
assert.match(html, /id="routesHelpDialog"[\s\S]*?Save on this device[\s\S]*?They stay in this browser on this device[\s\S]*?Share a link[\s\S]*?Anyone with the link can open it[\s\S]*?Open a shared route[\s\S]*?without changing your own saved settings[\s\S]*?intended to reproduce the original path[\s\S]*?routing-data updates can produce a different result/,
  'save-and-share help should cover local storage, share-link scope, and shared-route loading');
const routesHelp = html.match(/<dialog id="routesHelpDialog"[\s\S]*?<\/dialog>/)?.[0] || '';
assert.match(routesHelp, /waypoints, road blocks, and routing setup/,
  'save-and-share help should explicitly state that road blocks travel in shared links');
const sharedRouteTip = html.match(/<dialog id="sharedRouteTip"[\s\S]*?<\/dialog>/)?.[0] || '';
assert.doesNotMatch(routesHelp + sharedRouteTip, /Just Rolling Along/,
  'help copy should not depend on the app name');
assert.match(html, /id="settingsHelpDialog"[\s\S]*?help-scroll-hint">Scroll ↓[\s\S]*?id="layersHelpDialog"[\s\S]*?help-scroll-hint">Scroll ↓[\s\S]*?id="routeTipsDialog"[\s\S]*?help-scroll-hint">Scroll ↓/,
  'long help screens should make their scroll affordance visible');
const presetInfo = html.match(/<dialog id="presetInfoDialog"[\s\S]*?<\/dialog>/)?.[0] || '';
assert.doesNotMatch(presetInfo, /help-scroll-hint/,
  'non-scrolling preset rule popups should not show a scroll affordance');
assert.match(html, /id="settingsHelpDialog" class="full-help-dialog settings-help-dialog"[\s\S]*?full-help-head[\s\S]*?full-help-body/,
  'routing-settings help should use the same full-screen layout as the longer help screens');
assert.match(html, /id="settingsHelpDialog"[\s\S]*?dedicated bike infrastructure is exempt[\s\S]*?Trust designated bike routes[\s\S]*?Speed limits and access restrictions still apply[\s\S]*?Only show routes fully matching safety rules[\s\S]*?Minor exception: a short access link near a pin may remain and appear red/,
  'settings help should state the pin-access exception next to the strict route filter');
assert.match(html, /id="settingsHelpDialog"[\s\S]*?<h3>Presets<\/h3>[\s\S]*?<h3>Limits<\/h3>/,
  'settings help should introduce presets before individual routing limits');
assert.match(html, /<h3>Presets<\/h3>[\s\S]*?The Randonneur[\s\S]*?looser rules and fewer roads flagged as failing[\s\S]*?Weekend Wanderer[\s\S]*?Casual Cruiser/,
  'settings help should describe the available routing presets individually');
assert.match(html, /<h3>Limits<\/h3><ul class="help-list">[\s\S]*?Minimum shoulder[\s\S]*?Urban \/ rural max speed without shoulder[\s\S]*?Never allow roads faster than[\s\S]*?No cutoff[\s\S]*?<\/ul>/,
  'settings help should describe each routing limit as a separate, scannable item');
assert.match(html, /Minimum shoulder for faster roads/,
  'settings help should use the same shoulder-limit label as the product');
assert.match(html, /Unknown shoulder = 0 ft[\s\S]*?if shoulder data is missing, treat it as 0 ft for rules purposes/,
  'settings help should plainly explain how missing shoulder data is evaluated');
assert.match(html, /<h3>Voice navigation<\/h3><ul class="help-list">[\s\S]*?<b>Off-route<\/b>[\s\S]*?direction and distance[\s\S]*?manually route back or create a new route[\s\S]*?Speak compass directions[\s\S]*?Status update[\s\S]*?<\/ul>/,
  'voice-navigation help should explain notify-only guidance and manual recovery');
assert.match(html, /id="layersHelpDialog"[\s\S]*?<h3>Data sources<\/h3>[\s\S]*?WSDOT BLTS[\s\S]*?OSM bike infrastructure[\s\S]*?All roads[\s\S]*?Elevation &amp; cautions[\s\S]*?Technical data notes[\s\S]*?planning aid, not a guarantee of safety/,
  'map-data help should lead with its data sources, then keep technical context and state its limits');
const layersHelp = html.match(/<dialog id="layersHelpDialog"[\s\S]*?<\/dialog>/)?.[0] || '';
assert.match(layersHelp, /Toggling layers only adjusts visibility\. All data is always used for routing\.[\s\S]*?<h3>Data sources<\/h3>/,
  'map-data help should state that layer toggles do not change routing before its data sources');
assert.match(layersHelp, /All roads \(OpenStreetMap, estimated speeds\)/,
  'map-data help should spell out OpenStreetMap in its data sources');
assert.match(layersHelp, /All roads \(OpenStreetMap, estimated speeds\)[\s\S]*?known route closures/,
  'layers help should briefly identify the always-on closure data');
assert.match(layersHelp, /try to avoid any climbs over 12%, but steep segments remain routable/,
  'map-data help should describe the bounded steep-grade routing preference');
assert.doesNotMatch(layersHelp, /The router combines Washington road data, OpenStreetMap, and elevation/,
  'map-data help should omit its removed introductory sentence');
assert.doesNotMatch(layersHelp, /lime|blue|amber|red fails|gray lacks enough data/i,
  'map-layers help should not duplicate the route color legend');
const routeHelp = html.match(/<dialog id="routeTipsDialog"[\s\S]*?<\/dialog>/)?.[0] || '';
assert.match(routeHelp, /Concerns:[\s\S]*?sidewalk fallbacks[\s\S]*?highways/,
  'route help should name the concern types that affect current route details');
assert.match(routeHelp, /ordered shortest to longest as A–E[\s\S]*?automatically selects the best match[\s\S]*?may not be A/,
  'route help should explain route ordering without implying that A is the recommendation');
assert.match(html, /id="routeControls"[\s\S]*?class="route-chooser-row"[\s\S]*?id="routeOptions"[\s\S]*?id="routeTipsBtn"/,
  'the main map route picker should keep its selector and Help button on one row');
assert.match(css, /#routeOptions\s*\{[^}]*padding:\s*3px[^}]*border:\s*1px solid #cddde7[\s\S]*?#routeOptions::before\s*\{[^}]*content:\s*'Choose route'[\s\S]*?#routeOptions button\.active\s*\{[^}]*background:\s*#0a66c2/,
  'the main map selector should use the same compact Choose route treatment as Details');
assert.match(css, /\.route-tips-btn\s*\{[^}]*flex:\s*0 0 34px[^}]*min-height:\s*34px[\s\S]*?#routeTipsDialog\s*\{[^}]*height:\s*min\(90dvh, 780px\)/,
  'the Help button should sit beside the selector and its dialog should be slightly shorter than full screen');
assert.match(css, /#routeCard > #routeControls\s*\{[^}]*margin:\s*5px -6px 0/,
  'the main route selector should gain a little top breathing room and extend closer to the panel edges');
assert.match(routeHelp, /<h3>Choose Route<\/h3>[\s\S]*?Tap A–E[\s\S]*?Tap <b>Details<\/b>[\s\S]*?<h3>Details<\/h3>[\s\S]*?Stats:[\s\S]*?Concerns:[\s\S]*?steep uphill grades[\s\S]*?All Steps:[\s\S]*?Tap buttons in route segments[\s\S]*?Google Street View[\s\S]*?Safety ratings &amp; map colors[\s\S]*?<b>Lime<\/b> —[\s\S]*?<b>Dotted lime<\/b> —[\s\S]*?<b>Blue<\/b> —[\s\S]*?<b>Red dashed<\/b> — Road that fails rules\.[\s\S]*?<b>Amber<\/b> — Caution:[\s\S]*?<b>Dashed light blue<\/b> — Designated bike route/,
  'route help should explain the route picker, details tools, and active safety labels');
assert.doesNotMatch(routeHelp, /Gray — Insufficient data|Possible limited-visibility uphill curve/,
  'route help should omit the removed safety-label entries');
assert.match(routeHelp, /<b>Failing lane segments pulse\.<\/b>/,
  'route help should emphasize that failing lane segments pulse');
assert.doesNotMatch(html, /recommended balance|Ride mix|Compare the summaries/,
  'route help should not introduce unused labels or prescribe a route choice');
assert.match(html, /Location note:<\/b> The nearest available view may be up to 250 m away\. For trails, it may show a nearby road\./,
  'Street View copy should explain the possible offset, configured radius, and trail fallback');
assert.doesNotMatch(html, /Street View searched up to|Assumed safe\./,
  'obsolete verbose or overbroad help claims should not remain');
assert.match(app, /&radius=250\$\{headingParam\}/,
  'the Street View request should match its documented 250-meter search radius');
assert.match(app, /Ordinary roads over \$\{presetRules\.upperMaxSpeed\} mph fail; dedicated bike infrastructure is exempt\.[\s\S]*?Can satisfy the shoulder rule; speed and access limits still apply\./,
  'preset help should describe speed and designated-route behavior accurately');

console.log('Help content tests passed.');
