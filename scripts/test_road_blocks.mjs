#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../router-worker.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

assert.doesNotMatch(html, /id="rb-via-remove"/,
  'the route menu should no longer offer removal of an arbitrary last waypoint');
assert.match(html, /id="rb-road-block"[\s\S]*?Add road block/,
  'the route menu should offer an explicit road-block action');
assert.match(html, /id="routeActionsMenu"[\s\S]*?id="rb-clear"[\s\S]*?Clear route/,
  'clearing a route should live with the other overflow route actions');
assert.doesNotMatch(html, /route-endpoints[\s\S]*?id="rb-clear"[\s\S]*?id="rb-more"/,
  'the clear-route X should not occupy a separate slot beside the overflow menu');
assert.match(html, /id="removeRouteMarkerDialog"[\s\S]*?id="confirmRemoveRouteMarker"/,
  'tapping a route marker should use a confirmation dialog before removing it');
assert.match(css, /\.route-constraint-marker\s*\{[^}]*width:\s*56px[^}]*height:\s*56px[^}]*touch-action:\s*manipulation/,
  'waypoint and road-block markers should be true phone-sized touch controls');
assert.match(css, /\.waypoint-marker svg\s*\{[^}]*width:\s*26px[^}]*height:\s*40px[\s\S]*?\.road-block-icon\s*\{[^}]*width:\s*32px[^}]*height:\s*32px/,
  'large marker hit areas should preserve compact waypoint and road-block visuals');

assert.match(app, /function bindRouteConstraintMarker\([\s\S]*?Math\.hypot\([\s\S]*?> 12[\s\S]*?pointerup[\s\S]*?suppressClickUntil[\s\S]*?prompt\(event\)/,
  'waypoint and road-block markers should directly prompt on a forgiving release tap while preserving drag');
assert.match(app, /function waypointMarkerElement\([\s\S]*?<svg viewBox=[\s\S]*?function addVia\([\s\S]*?element: waypointMarkerElement\(\), anchor: 'bottom'[\s\S]*?bindRouteConstraintMarker\(marker, 'via', via\)/,
  'each waypoint should use a large anchored touch control around its compact pin');
assert.match(app, /function addRoadBlock\([\s\S]*?roadBlockMarkerElement\(\)[\s\S]*?bindRouteConstraintMarker\(marker, 'block', block\)/,
  'each road block should use the physical road-block marker and direct removal behavior');
assert.match(app, /function openPlacePicker\(kind\) \{[\s\S]*?if \(kind === 'block'\) \{[\s\S]*?armRoutePoint\('block'\)[\s\S]*?return;/,
  'road blocks should bypass the search picker and immediately enter map-pick mode');
assert.match(app, /document\.getElementById\('rb-road-block'\)\.addEventListener\('click', \(\) => armRoutePoint\('block'\)\)/,
  'the road-block action should immediately ask the rider to pick a map location');
assert.match(app, /blocks: routing\.blocks\?\.map\(\(block\) => block\.pt\) \|\| \[\]/,
  'all route requests should send road-block locations to the routing worker');
assert.match(app, /b: routing\.blocks\.map\(\(x\) => x\.pt\)/,
  'road blocks should persist with a saved route');
assert.match(app, /z: routing\.blocks\.map\(\(block\) => point\(block\.pt\)\)/,
  'shared routes should preserve road blocks');
assert.match(app, /const blocks = Array\.isArray\(data\.z\) \? data\.z : \[\]/,
  'shared route loading should restore road blocks without breaking older links');
assert.match(app, /for \(const p of route\.b \|\| \[\]\) addRoadBlock/,
  'saved and shared route loading should put road blocks back on the map');

assert.match(worker, /function roadBlockEdgeSet\([\s\S]*?const start = eOff\[edge\][\s\S]*?const lon0 = gLon\[i\][\s\S]*?if \(nearby\[i\]\.size\)/,
  'a road block should match its nearby stored road geometry instead of only a graph node');
assert.match(worker, /if \(activeRoadBlockEdges\?\.has\(ei\)\) continue;/,
  'the A* search should never traverse a blocked road edge');
assert.match(worker, /withRoadBlocks\(m\.blocks, m\.rules,[\s\S]*?routeOptions/,
  'all route options should respect the same road blocks');
assert.match(worker, /withRoadBlocks\(m\.blocks, connectorRules,[\s\S]*?route\(/,
  'navigation connectors should respect road blocks');
assert.match(worker, /withRoadBlocks\(m\.blocks, m\.rules,[\s\S]*?navigation-new-route/s,
  'current-location reroutes should respect road blocks');

const helperStart = worker.indexOf('const ROAD_BLOCK_NEARBY_M');
const helperEnd = worker.indexOf('/* ------------------------------------------------ riding modes */', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'road-block helpers were not found');
const context = vm.createContext({
  Number, Set, Math,
  E: 3,
  eOff: new Uint32Array([0, 2, 4]),
  eCnt: new Uint16Array([2, 2, 2]),
  // Edges 0 and 1 are parallel carriageways only ~11 m apart; edge 2 is
  // farther away. A closure on edge 1 should also catch its nearby mate.
  gLon: new Float32Array([-122.40, -122.39, -122.40, -122.39, -122.40, -122.39]),
  gLat: new Float32Array([47.6000, 47.6000, 47.6001, 47.6001, 47.6010, 47.6010]),
});
vm.runInContext(worker.slice(helperStart, helperEnd), context);
assert.equal(vm.runInContext('Array.from(roadBlockEdgeSet([[-122.395, 47.6001]])).join(",")', context), '0,1',
  'a road block should select the exact nearby road geometry and its parallel carriageway');
assert.equal(vm.runInContext('roadBlockEdgeSet([])', context), null,
  'an empty block list should leave routing unchanged');

const graph = zlib.gunzipSync(fs.readFileSync(new URL('../data/graph2.bin.gz', import.meta.url)));
const messages = [];
const routerContext = vm.createContext({
  Date, Math, Map, Set, TextDecoder,
  ArrayBuffer, DataView, Float32Array, Float64Array, Int8Array, Int16Array,
  Int32Array, Uint8Array, Uint16Array, Uint32Array,
  postMessage(message) { messages.push(message); },
});
vm.runInContext(worker, routerContext);
const buffer = graph.byteOffset === 0 && graph.byteLength === graph.buffer.byteLength
  ? graph.buffer : graph.buffer.slice(graph.byteOffset, graph.byteOffset + graph.byteLength);
routerContext.onmessage({ data: { type: 'graph', buffer } });
const rules = {
  allowFreeways: false, allowMtbTrails: false, vettedBikeRoutes: true,
  minShoulder: 4, unknownShoulderZero: true, freeMaxSpeed: 35,
  upperMaxSpeed: 45, noUpperLimit: true, requireSafe: false,
};
const routePoints = [[-122.391, 47.689], [-122.350, 47.673]];
const baseline = vm.runInContext(`route(${JSON.stringify(routePoints)}, ${JSON.stringify(rules)}, 'balanced', true, true)`, routerContext);
assert.equal(baseline.ok, true, baseline.reason || 'a baseline Seattle route should be available');
const blockPoint = baseline.coords[Math.floor(baseline.coords.length / 2)];
const blockedEdges = vm.runInContext(`roadBlockEdgeSet(${JSON.stringify([blockPoint])})`, routerContext);
assert.ok(blockedEdges?.size, 'a block placed on the route should match at least one graph edge');
const rerouted = vm.runInContext(`withRoadBlocks(${JSON.stringify([blockPoint])}, ${JSON.stringify(rules)}, () => route(${JSON.stringify(routePoints)}, ${JSON.stringify(rules)}, 'balanced', true, true))`, routerContext);
assert.equal(rerouted.ok, true, rerouted.reason || 'a nearby Seattle route should remain available around one block');
assert.ok(rerouted.edgeIds.every((edge) => !blockedEdges.has(edge)),
  'a rerouted path must not traverse the graph edge matched by its road block');

console.log('Road block tests passed.');
