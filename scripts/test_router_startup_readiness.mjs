#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

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
