#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

assert.match(html, /id="appHelpDialog"[\s\S]*?Route A is the recommended option[\s\S]*?Layers<\/b> changes only what you see/,
  'quick-start help should be concise and distinguish route choices from layer visibility');
assert.match(html, /id="settingsHelpDialog"[\s\S]*?dedicated bike infrastructure is exempt[\s\S]*?Trust designated bike routes[\s\S]*?Speed limits and access restrictions still apply[\s\S]*?technical-note/,
  'settings help should preserve its important technical exception without crowding the main guidance');
assert.match(html, /id="layersHelpDialog"[\s\S]*?Technical data notes[\s\S]*?planning aid, not a guarantee of safety/,
  'map-data help should keep technical context and state its limits');
assert.match(html, /id="routeTipsDialog"[\s\S]*?Compare miles, <b>Est\.<\/b> time[\s\S]*?route context, not automatically a trail or bike facility/,
  'route help should match the current summary label and explain designation plainly');
assert.match(html, /No view within 200 m\? Try <b>Open in Google Maps<\/b>\./,
  'Street View fallback copy should be compact and match the configured radius');
assert.doesNotMatch(html, /Street View searched up to|Assumed safe\./,
  'obsolete verbose or overbroad help claims should not remain');
assert.match(app, /&radius=200\$\{headingParam\}/,
  'the Street View request should match its documented 200-meter search radius');
assert.match(app, /Ordinary roads over \$\{presetRules\.upperMaxSpeed\} mph fail; dedicated bike infrastructure is exempt\.[\s\S]*?Can satisfy the shoulder rule; speed and access limits still apply\./,
  'preset help should describe speed and designated-route behavior accurately');

console.log('Help content tests passed.');
