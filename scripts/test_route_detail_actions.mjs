#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const details = fs.readFileSync(new URL('../route-details.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../route-details.css', import.meta.url), 'utf8');
const appCss = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

assert.match(app, /locationStart: locationAt\(s\.c0\), locationEnd: locationAt\(s\.c1\)/,
  'stored route details should retain a compact on-road point for each segment');
assert.match(app, /function openRouteDetails\(\) \{[\s\S]*?storeRouteDetails\(routing\.last\)/,
  'opening Details should refresh an already-drawn route with its segment locations');
assert.match(details, /streetView\.textContent = 'Street View'[\s\S]*?mapLink\.textContent = 'Map ↗'/,
  'each route-detail item should expose compact Street View and map actions');
assert.match(details, /window\.parent\.postMessage\(\{ type: 'open-street-view', lat, lng, heading \}, window\.location\.origin\)/,
  'embedded Details should ask the app to open its Street View dialog');
assert.match(app, /event\.data\?\.type === 'open-street-view'[\s\S]*?openStreetView\(lat, lng/,
  'the app should accept Street View requests from its Route Details frame');
assert.match(css, /\.segment-streetview\s*\{[^}]*min-height:\s*28px/,
  'per-segment Street View actions should stay compact');
assert.match(html, /class="dialog-close streetview-close"[\s\S]*?<span>Close<\/span>/,
  'the embedded Street View close control should have a visible Close label');
assert.match(html, /No panorama showing\?[\s\S]*?searched up to 150 m[\s\S]*?Open in Google Maps/,
  'the embedded viewer should explain its nearby-coverage fallback');
assert.match(appCss, /\.full-help-head \.streetview-close\s*\{[^}]*min-height:\s*42px/,
  'the embedded Street View close control should have a clear hit target');
assert.match(appCss, /\.sv-coverage-note\s*\{[^}]*position:\s*absolute/,
  'the coverage fallback should remain visible over an unavailable panorama');

const helperStart = details.indexOf('function lngLat(');
const helperEnd = details.indexOf('function routePercent(', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'route-detail map helpers were not found');
const context = vm.createContext({ Math });
vm.runInContext(details.slice(helperStart, helperEnd), context);
assert.equal(vm.runInContext('itemLocation({ locationStart: [-122.1, 47.6] }).join(",")', context), '-122.1,47.6',
  'a route item should use its stored start point');
const eastHeading = vm.runInContext('itemStreetViewHeading({ locationStart: [-122.1, 47.6], locationEnd: [-122.09, 47.6] })', context);
assert.ok(Math.abs(eastHeading - 90) < 1,
  'a route-detail Street View action should face along an east-west road');
const mapUrl = vm.runInContext('googleMapUrl([-122.1, 47.6])', context);
assert.match(mapUrl, /query=47\.600000,-122\.100000/,
  'a route-detail map link should open the segment location');

console.log('Route detail action tests passed.');
