#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

assert.match(html, /<div class="status hidden" id="status" role="status" aria-live="polite">Loading…<\/div>/,
  'the generic map-data status should remain hidden until it has a real message');
assert.match(css, /\.status \{[\s\S]*?top: calc\(env\(safe-area-inset-top\) \+ 96px\); left: 12px;[\s\S]*?max-width: calc\(100vw - 68px\);/,
  'mobile map-data status should render below, rather than behind, the endpoint card');
assert.match(css, /\.status\.hidden \{ visibility: hidden; opacity: 0; \}/,
  'hidden generic status should not leave a visible loading badge');

assert.doesNotMatch(app, /function waitForRoutePlanner/,
  'route-point editing should not be blocked on a fresh graph download');
assert.match(app,
  /function openPlacePicker\(kind\) \{[\s\S]*?routing\.arm = kind;[\s\S]*?ensureRouter\(\);/,
  'place search should safely arm a route point while graph startup continues');
assert.match(app,
  /function armRoutePoint\(kind\) \{[\s\S]*?routing\.arm = routing\.arm === kind \? null : kind;[\s\S]*?ensureRouter\(\);/,
  'map-only route actions should safely arm while graph startup continues');
assert.match(app,
  /function computeRoute\(\) \{[\s\S]*?if \(!routing\.ready\) \{[\s\S]*?routing\.pendingRoute = true;[\s\S]*?return;/,
  'a complete route selected during startup should queue until the graph is ready');
assert.match(app,
  /buildRoutingPanel\(\);[\s\S]*?ensureRouter\(\);/,
  'routing data should preload as the app starts');

console.log('Router startup readiness tests passed.');
