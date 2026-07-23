#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../router-worker.js', import.meta.url), 'utf8');
const details = fs.readFileSync(new URL('../route-details.js', import.meta.url), 'utf8');

const styleStart = app.indexOf('function scoreRouteSeg');
const styleEnd = app.indexOf('function sameRouteCoordinate', styleStart);
assert.ok(styleStart >= 0 && styleEnd > styleStart, 'route-style helpers were not found');
const context = {
  effectiveLevel: () => 4,
  OFFICIAL_SIDEWALK: 16,
  OFFICIAL_SIDEWALK_NO: 32,
  OFFICIAL_URBAN: 64,
};
vm.createContext(context);
vm.runInContext(`${app.slice(styleStart, styleEnd)}\nthis.routeVisualStyle = routeVisualStyle;`, context);
assert.equal(context.routeVisualStyle({ crossing: 1, ferry: 0, facility: 0, infra: 0 }), 'pass',
  'a verified short crossing should stay blue on the selected route');
assert.equal(context.routeVisualStyle({ crossing: 0, ferry: 0, facility: 0, infra: 0 }), 'fail',
  'an otherwise failing road should remain red');

assert.match(worker, /segs\[j\]\.level = 2;[\s\S]*?segs\[j\]\.crossing = 1;/,
  'the router should explicitly mark a bounded short failing run as a crossing');
assert.match(app, /crossing: s\.crossing \? 1 : 0/,
  'route details storage should preserve the crossing classification');
assert.match(details, /intersection crossing/,
  'route steps should explain distance classified as an intersection crossing');

console.log('Route crossing tests passed.');
