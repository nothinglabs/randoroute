#!/usr/bin/env node
// Routing weights are posted to the router and read by nothing else -- no map
// layer, no paint expression, no scorer. A weight change therefore cannot alter
// a single road's colour.
//
// The advanced-weights sliders used to call scheduleRescore() anyway, which
// every 180ms of a drag re-scored every GeoJSON source and re-uploaded it to
// the map. That is a large amount of main-thread and memory churn for a
// guaranteed no-op, and it is enough to get the tab killed on iOS mid-drag.
// This test pins the sliders to the route-only path.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

/* ------------------- weights really are invisible to the map */
const consumers = [...app.matchAll(/routingWeights/g)].length;
assert.ok(consumers > 0, 'routingWeights should exist');
const rescoreBody = app.slice(app.indexOf('function rescoreAll'), app.indexOf('const FAIL_COLOR'));
assert.doesNotMatch(rescoreBody, /routingWeights/,
  'redrawing the map must not depend on routing weights');
const scorerStart = app.indexOf('function rescore(src)');
assert.doesNotMatch(app.slice(scorerStart, scorerStart + 400), /routingWeights/,
  'per-feature scoring must not depend on routing weights');

/* ---------------------------- the sliders take the route-only path */
// Slice from weightSlider, not buildRoutingWeightsEditor: the per-slider
// handler was factored out when the editor was regrouped into per-cost mode
// triples, and it is the handler that must stay off the re-score path.
const editor = app.slice(app.indexOf('function weightSlider'),
  app.indexOf('function activeRoutingPreset'));
assert.ok(editor.includes('function buildRoutingWeightsEditor'),
  'this slice should still span the whole editor');
assert.match(editor, /scheduleReroute\(\);/,
  'a weight change should re-route');
assert.doesNotMatch(editor, /scheduleRescore\(\)/,
  'a weight change must never trigger a full map re-score');

const reset = app.slice(app.indexOf("getElementById('resetRoutingWeights')"),
  app.indexOf("getElementById('resetRoutingWeights')") + 400);
assert.match(reset, /scheduleReroute\(\);/,
  'resetting weights should re-route, not re-score the map');

/* ----------------------- and it is still debounced, and still saved */
const reroute = app.slice(app.indexOf('function scheduleReroute'),
  app.indexOf('function scheduleReroute') + 400);
assert.match(reroute, /saveStateSoon\(\);/, 'weight changes must still persist');
assert.match(reroute, /clearTimeout\(_ruleRouteTimer\);/,
  'a drag must cancel the pending route, not queue one per frame');
assert.match(reroute, /\}, 700\);/, 'the route should wait for the thumb to settle');

console.log('Routing-weights editor cost tests passed.');
