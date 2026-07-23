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

assert.match(app,
  /function routePlannerIsLoading\(\) \{\s*return routing\.loading && !routing\.ready;\s*\}/,
  'route controls should recognize a graph that is still initializing');
assert.match(app,
  /function openPlacePicker\(kind\) \{\s*if \(waitForRoutePlanner\(\)\) return;/,
  'place search must not arm a route point before the graph is ready');
assert.match(app,
  /function armRoutePoint\(kind\) \{\s*if \(waitForRoutePlanner\(\)\) return;/,
  'map-only route actions must not arm before the graph is ready');
assert.match(app,
  /function placeArmedPoint\(lngLat\) \{[\s\S]*?if \(!routing\.ready\) \{[\s\S]*?return true;/,
  'a stale placement tap should be consumed rather than falling through to road details');
assert.match(app,
  /buildRoutingPanel\(\);\s*buildLegend\(\);[\s\S]*?ensureRouter\(\);/,
  'routing data should preload as the app starts');

console.log('Router startup readiness tests passed.');
