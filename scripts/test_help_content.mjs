#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

assert.match(html, /id="legendFlyout"[\s\S]*?id="legend"[\s\S]*?Tap any path to get details\./,
  'the map legend should end with a compact path-details tip');
assert.match(html, /id="appHelpDialog"[\s\S]*?The letters identify routes; they are not safety grades[\s\S]*?Layers<\/b> changes only what you see[\s\S]*?Tap any road or trail to get more information or access <b>Google Street View<\/b>/,
  'quick-start help should distinguish route choices, layer visibility, and road-information access');
assert.match(html, /id="routesHelpDialog"[\s\S]*?Save on this device[\s\S]*?They stay in this browser on this device[\s\S]*?Share a link[\s\S]*?Anyone with the link can open it[\s\S]*?Open a shared route[\s\S]*?without changing your own saved settings[\s\S]*?intended to reproduce the original path[\s\S]*?routing-data updates can produce a different result/,
  'save-and-share help should cover local storage, share-link scope, and shared-route loading');
const routesHelp = html.match(/<dialog id="routesHelpDialog"[\s\S]*?<\/dialog>/)?.[0] || '';
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
assert.match(html, /<h3>Limits<\/h3><ul class="help-list">[\s\S]*?Minimum shoulder[\s\S]*?Max speed without shoulder[\s\S]*?Never allow roads faster than[\s\S]*?No cutoff[\s\S]*?<\/ul>/,
  'settings help should describe each routing limit as a separate, scannable item');
assert.match(html, /Unknown shoulder = 0 ft[\s\S]*?if shoulder data is missing, treat it as 0 ft for rules purposes/,
  'settings help should plainly explain how missing shoulder data is evaluated');
assert.match(html, /<h3>Voice navigation<\/h3><ul class="help-list">[\s\S]*?Notify only[\s\S]*?Route back to route[\s\S]*?Dynamic re-routing[\s\S]*?Speak compass directions[\s\S]*?Status update[\s\S]*?<\/ul>/,
  'voice-navigation help should list each available setting and off-route behavior');
assert.match(html, /id="layersHelpDialog"[\s\S]*?<h3>Data sources<\/h3>[\s\S]*?WSDOT BLTS[\s\S]*?OSM bike infrastructure[\s\S]*?All roads[\s\S]*?Elevation &amp; cautions[\s\S]*?Technical data notes[\s\S]*?planning aid, not a guarantee of safety/,
  'map-data help should lead with its data sources, then keep technical context and state its limits');
const layersHelp = html.match(/<dialog id="layersHelpDialog"[\s\S]*?<\/dialog>/)?.[0] || '';
assert.doesNotMatch(layersHelp, /lime|blue|amber|red fails|gray lacks enough data/i,
  'map-layers help should not duplicate the route color legend');
const routeHelp = html.match(/<dialog id="routeTipsDialog"[\s\S]*?<\/dialog>/)?.[0] || '';
assert.match(routeHelp, /<h3>Choose Route<\/h3>[\s\S]*?Tap A–E[\s\S]*?Click <b>Details<\/b>[\s\S]*?<h3>Details<\/h3>[\s\S]*?Concerns:[\s\S]*?All Steps:[\s\S]*?Google Street View[\s\S]*?Safety ratings &amp; map colors[\s\S]*?Red dashed — Road that fails rules\.[\s\S]*?Amber — Caution:[\s\S]*?Dashed light blue — Designated bike route/,
  'route help should explain the route picker, details tools, and active safety labels');
assert.doesNotMatch(routeHelp, /Gray — Insufficient data|Possible limited-visibility uphill curve/,
  'route help should omit the removed safety-label entries');
assert.match(routeHelp, /<b>Failing lane segments pulse\.<\/b>/,
  'route help should emphasize that failing lane segments pulse');
assert.doesNotMatch(html, /recommended balance|Ride mix|Compare the summaries/,
  'route help should not introduce unused labels or prescribe a route choice');
assert.match(html, /No view within 200 m\? Try <b>Open in Google Maps<\/b>\./,
  'Street View fallback copy should be compact and match the configured radius');
assert.doesNotMatch(html, /Street View searched up to|Assumed safe\./,
  'obsolete verbose or overbroad help claims should not remain');
assert.match(app, /&radius=200\$\{headingParam\}/,
  'the Street View request should match its documented 200-meter search radius');
assert.match(app, /Ordinary roads over \$\{presetRules\.upperMaxSpeed\} mph fail; dedicated bike infrastructure is exempt\.[\s\S]*?Can satisfy the shoulder rule; speed and access limits still apply\./,
  'preset help should describe speed and designated-route behavior accurately');

console.log('Help content tests passed.');
