#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

assert.match(css, /\.readout-close\s*\{[^}]*width:\s*34px[^}]*height:\s*34px[^}]*font:\s*750 17px/,
  'the road-information close control should have a larger icon and hit target');

const roadInfoSection = app.indexOf('// A pinned road card belongs to the map inspection interaction.');
const listenerStart = app.indexOf("document.addEventListener('click'", roadInfoSection);
const listenerEnd = app.indexOf('// ONE global handler pair', listenerStart);
assert.ok(roadInfoSection >= 0 && listenerStart >= 0 && listenerEnd > listenerStart,
  'road-information outside-click handler was not found');

let clickHandler = null;
let dismissals = 0;
const context = vm.createContext({
  readoutEl: { classList: { contains: () => true } },
  dismissRoadInfo() { dismissals++; },
  document: { addEventListener(type, handler) { if (type === 'click') clickHandler = handler; } },
});
vm.runInContext(app.slice(listenerStart, listenerEnd), context);
assert.equal(typeof clickHandler, 'function', 'outside-click handler should be registered');

const eventFor = (insideMap, insideReadout) => ({
  target: { closest(selector) {
    if (selector === '#map') return insideMap ? {} : null;
    if (selector === '#readout') return insideReadout ? {} : null;
    return null;
  } },
});
clickHandler(eventFor(false, false));
assert.equal(dismissals, 1, 'clicking app UI outside the map should close road information');
clickHandler(eventFor(true, false));
assert.equal(dismissals, 1, 'clicking the map should leave map inspection to the map handler');
clickHandler(eventFor(false, true));
assert.equal(dismissals, 1, 'the road card should remain usable for Close and Street View');

console.log('Road information tests passed.');
