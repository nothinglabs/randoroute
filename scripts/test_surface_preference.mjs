#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../router-worker.js', import.meta.url), 'utf8');
const details = fs.readFileSync(new URL('../route-details.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

assert.match(app, /preferPaved:\s*false/,
  'strong paved-surface preference should default off for new settings');
assert.match(app, /check\('preferPaved', 'Strongly prefer paved surfaces'\)/,
  'the strong surface preference should be available in Settings');
assert.match(app, /GRAPH_FORMAT_VERSION = 'bgr8-3'/,
  'the app should request the BGR8 graph layout');
assert.match(worker, /want BGR8/,
  'the router should reject an older graph layout instead of misreading it');
assert.match(worker, /eSurface = u8\(E\)/,
  'the router should load one compact surface category for each graph edge');
assert.match(app, /\['Surface \(OSM\)', routeSurfaceLabel\(p\.surface\)\]/,
  'route-segment popups should show the compact OSM surface category');
assert.match(app, /buildRouteUnpavedData/,
  'confirmed unpaved route segments should have a dedicated map-overlay source');
assert.match(app, /route-unpaved-slats/,
  'the map should render confirmed unpaved segments with cross-slats');
assert.match(app, /'symbol-placement': 'line', 'symbol-spacing': 13/,
  'main-map slats should use fixed-size symbols at stable spacing');
assert.doesNotMatch(app, /'line-pattern': 'route-unpaved-slats'/,
  'main-map slats should not scale with a line texture');
assert.match(details, /Unpaved surfaces/,
  'route details should report confirmed unpaved segments as a concern');
assert.doesNotMatch(details, /rules\.preferPaved === false \? \[\]/,
  'confirmed unpaved segments should remain a concern when the strong preference is off');
assert.match(details, /route-preview-unpaved-slats/,
  'the route-details map preview should preserve the unpaved-surface overlay');
assert.match(details, /'symbol-placement': 'line', 'symbol-spacing': 12/,
  'details-map slats should use fixed-size symbols at stable spacing');
assert.doesNotMatch(details, /'line-pattern': 'route-preview-unpaved-slats'/,
  'details-map slats should not scale with a line texture');
assert.doesNotMatch(html, /streetViewSurfaceNote/,
  'surface labels belong in the road/trail detail popup, not over Street View');

const surfaceLabelStart = app.indexOf('const ROUTE_SURFACE_LABEL');
const surfaceLabelEnd = app.indexOf('/* ------------------------------------------------- riding-rules state */', surfaceLabelStart);
assert.ok(surfaceLabelStart >= 0 && surfaceLabelEnd > surfaceLabelStart,
  'surface classification helpers were not found in the app');
const appSurfaceContext = vm.createContext({ Number });
vm.runInContext(`${app.slice(surfaceLabelStart, surfaceLabelEnd)}\nglobalThis.isConfirmed = isConfirmedUnpavedSurface;`, appSurfaceContext);
assert.equal(appSurfaceContext.isConfirmed(0), false,
  'unknown surfaces must not be presented as unpaved');
assert.equal(appSurfaceContext.isConfirmed(1), false,
  'paved surfaces must not be presented as unpaved');
assert.equal(appSurfaceContext.isConfirmed(2), true,
  'confirmed gravel/compacted surfaces should be presented as unpaved');
assert.equal(appSurfaceContext.isConfirmed(3), true,
  'confirmed rough/unpaved surfaces should be presented as unpaved');

const helperStart = worker.indexOf('function surfacePreferenceS');
const helperEnd = worker.indexOf('// Ordinary 9', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart,
  'surface-preference helper source was not found');
const context = {
  eFlags: new Uint8Array([0, 0, 0, 0, 32]),
  eSurface: new Uint8Array([0, 1, 2, 3, 3]),
  eLen: new Float32Array([1000, 1000, 1000, 1000, 1000]),
  SURFACE_GRAVEL: 2,
  SURFACE_ROUGH: 3,
};
vm.createContext(context);
vm.runInContext(worker.slice(helperStart, helperEnd), context);

assert.equal(context.surfacePreferenceS(0, { preferPaved: true }), 0,
  'unknown OSM surfaces should not be penalized');
assert.equal(context.surfacePreferenceS(1, { preferPaved: true }), 0,
  'paved surfaces should not be penalized');
assert.equal(context.surfacePreferenceS(2, { preferPaved: true }), 260,
  'strong preference should apply a substantially larger gravel cost');
assert.equal(context.surfacePreferenceS(3, { preferPaved: true }), 800,
  'strong preference should apply a substantially larger rough-surface cost');
assert.equal(context.surfacePreferenceS(2, { preferPaved: false }), 13,
  'with strong preference off, gravel should retain the 20-percent baseline cost');
assert.equal(context.surfacePreferenceS(3, { preferPaved: false }), 40,
  'with strong preference off, rough surface should retain the 20-percent baseline cost');
assert.equal(context.surfacePreferenceS(3, {}), 40,
  'routes without an explicit setting should retain the baseline pavement preference');
assert.equal(context.surfacePreferenceS(4, { preferPaved: true }), 0,
  'ferry crossings should never receive a surface cost');

console.log('Surface preference tests passed.');
