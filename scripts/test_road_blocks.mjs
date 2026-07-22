#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../router-worker.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

assert.doesNotMatch(html, /id="rb-via-remove"/,
  'the route menu should no longer offer removal of an arbitrary last waypoint');
assert.match(html, /id="rb-road-block"[\s\S]*?Add road block/,
  'the route menu should offer an explicit road-block action');
assert.match(html, /id="removeRouteMarkerDialog"[\s\S]*?id="confirmRemoveRouteMarker"/,
  'tapping a route marker should use a confirmation dialog before removing it');
assert.match(css, /\.road-block-marker\s*\{[^}]*cursor:\s*pointer/,
  'road blocks should render as a distinct, tappable road-work marker');

assert.match(app, /function bindRouteConstraintMarker\([\s\S]*?promptRemoveRouteMarker\(kind, item\)/,
  'waypoint and road-block markers should directly prompt for removal when tapped');
assert.match(app, /function addVia\([\s\S]*?bindRouteConstraintMarker\(marker, 'via', via\)/,
  'each waypoint marker should get direct removal behavior');
assert.match(app, /function addRoadBlock\([\s\S]*?roadBlockMarkerElement\(\)[\s\S]*?bindRouteConstraintMarker\(marker, 'block', block\)/,
  'each road block should use the physical road-block marker and direct removal behavior');
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

assert.match(worker, /function roadBlockEdgeSet\([\s\S]*?blocked\.add\(outEdge\[arc\]\)/,
  'a road block should turn every graph edge at its snapped location into a hard exclusion');
assert.match(worker, /if \(activeRoadBlockEdges\?\.has\(ei\)\) continue;/,
  'the A* search should never traverse a blocked road edge');
assert.match(worker, /withRoadBlocks\(m\.blocks, m\.rules,[\s\S]*?routeOptions/,
  'all route options should respect the same road blocks');
assert.match(worker, /withRoadBlocks\(m\.blocks, connectorRules,[\s\S]*?route\(/,
  'navigation connectors should respect road blocks');
assert.match(worker, /withRoadBlocks\(m\.blocks, m\.rules,[\s\S]*?navigation-new-route/s,
  'current-location reroutes should respect road blocks');

const helperStart = worker.indexOf('function roadBlockEdgeSet(');
const helperEnd = worker.indexOf('/* ------------------------------------------------ riding modes */', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'road-block helpers were not found');
const context = vm.createContext({
  Number, Set,
  outStart: new Uint32Array([0, 1, 4, 5]),
  outEdge: new Uint32Array([90, 11, 12, 13, 99]),
  nearestNode: () => ({ node: 1, distM: 0 }),
});
vm.runInContext(worker.slice(helperStart, helperEnd), context);
assert.equal(vm.runInContext('Array.from(roadBlockEdgeSet([[-122.3, 47.6]], {})).join(",")', context), '11,12,13',
  'a road block should exclude each outgoing road edge at its snapped graph node');
assert.equal(vm.runInContext('roadBlockEdgeSet([], {})', context), null,
  'an empty block list should leave routing unchanged');

console.log('Road block tests passed.');
