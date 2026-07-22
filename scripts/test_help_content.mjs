#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

assert.match(html, /id="appHelpDialog"[\s\S]*?The letters identify routes; they are not safety grades[\s\S]*?Layers<\/b> changes only what you see/,
  'quick-start help should be concise and distinguish route choices from layer visibility');
assert.match(html, /id="routesHelpDialog"[\s\S]*?Save on this device[\s\S]*?They stay in this browser on this device[\s\S]*?Share a link[\s\S]*?Anyone with the link can open it[\s\S]*?Open a shared route[\s\S]*?without changing your own saved settings/,
  'save-and-share help should cover local storage, share-link scope, and shared-route loading');
const routesHelp = html.match(/<dialog id="routesHelpDialog"[\s\S]*?<\/dialog>/)?.[0] || '';
const sharedRouteTip = html.match(/<dialog id="sharedRouteTip"[\s\S]*?<\/dialog>/)?.[0] || '';
assert.doesNotMatch(routesHelp + sharedRouteTip, /Just Rolling Along/,
  'help copy should not depend on the app name');
assert.match(html, /id="settingsHelpDialog"[\s\S]*?dedicated bike infrastructure is exempt[\s\S]*?Trust designated bike routes[\s\S]*?Speed limits and access restrictions still apply[\s\S]*?Only show routes fully matching safety rules[\s\S]*?Minor exception: a short access link near a pin may remain and appear red/,
  'settings help should state the pin-access exception next to the strict route filter');
assert.match(html, /id="settingsHelpDialog"[\s\S]*?<h3>Presets<\/h3>[\s\S]*?<h3>Limits<\/h3>/,
  'settings help should introduce presets before individual routing limits');
assert.match(html, /<h3>Limits<\/h3><ul class="help-list">[\s\S]*?Minimum shoulder[\s\S]*?Max speed without shoulder[\s\S]*?Never allow roads faster than[\s\S]*?No cutoff[\s\S]*?<\/ul>/,
  'settings help should describe each routing limit as a separate, scannable item');
assert.match(html, /id="layersHelpDialog"[\s\S]*?<h3>Data sources<\/h3>[\s\S]*?WSDOT BLTS[\s\S]*?OSM bike infrastructure[\s\S]*?All roads[\s\S]*?Elevation &amp; cautions[\s\S]*?Technical data notes[\s\S]*?planning aid, not a guarantee of safety/,
  'map-data help should lead with its data sources, then keep technical context and state its limits');
const layersHelp = html.match(/<dialog id="layersHelpDialog"[\s\S]*?<\/dialog>/)?.[0] || '';
assert.doesNotMatch(layersHelp, /lime|blue|amber|red fails|gray lacks enough data/i,
  'map-layers help should not duplicate the route color legend');
assert.match(html, /id="routeTipsDialog"[\s\S]*?Route information[\s\S]*?Route cards show distance, estimated time, elevation[\s\S]*?<h3>Details<\/h3>[\s\S]*?Concerns:[\s\S]*?All Steps:[\s\S]*?Google Street View[\s\S]*?Safety ratings &amp; map colors[\s\S]*?route context, not automatically a trail or bike facility/,
  'route help should focus on the information and inspection tools the app provides');
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
