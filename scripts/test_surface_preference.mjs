#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../router-worker.js', import.meta.url), 'utf8');
const details = fs.readFileSync(new URL('../route-details.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

assert.match(app, /preferPaved:\s*true/,
  'paved-surface preference should default on for new and existing saved settings');
assert.match(app, /check\('preferPaved', 'Prefer paved surfaces'\)/,
  'the surface preference should be available in Settings');
assert.match(app, /GRAPH_FORMAT_VERSION = 'bgr8-1'/,
  'the app should request the BGR8 graph layout');
assert.match(worker, /want BGR8/,
  'the router should reject an older graph layout instead of misreading it');
assert.match(worker, /eSurface = u8\(E\)/,
  'the router should load one compact surface category for each graph edge');
assert.match(details, /surface: itemSurface\(item\)/,
  'route-detail Street View launches should send the route segment surface');
assert.match(html, /id="streetViewSurfaceNote"/,
  'the embedded Street View overlay should have a surface note');

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
assert.equal(context.surfacePreferenceS(2, { preferPaved: true }), 65,
  'gravel should receive the moderate distance-proportional cost');
assert.equal(context.surfacePreferenceS(3, { preferPaved: true }), 200,
  'rough unpaved surface should receive the stronger cost');
assert.equal(context.surfacePreferenceS(3, { preferPaved: false }), 0,
  'turning the preference off should leave all rideable surfaces equally eligible');
assert.equal(context.surfacePreferenceS(4, { preferPaved: true }), 0,
  'ferry crossings should never receive a surface cost');

console.log('Surface preference tests passed.');
