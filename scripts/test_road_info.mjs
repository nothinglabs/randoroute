#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

assert.match(css, /\.readout-close\s*\{[^}]*width:\s*34px[^}]*height:\s*34px[^}]*font:\s*750 17px/,
  'the road-information close control should have a larger icon and hit target');
assert.match(css, /\.readout\.near-tap\s*\{[^}]*right:\s*auto[^}]*bottom:\s*auto/,
  'a tapped road-information card should override its fixed corner placement');

const positionStart = app.indexOf('function resetRoadInfoPosition()');
const positionEnd = app.indexOf('function renderReadout(', positionStart);
assert.ok(positionStart >= 0 && positionEnd > positionStart,
  'road-information positioning helpers were not found');

const inlineStyles = new Map();
const classNames = new Set();
const readoutForPosition = {
  classList: {
    add(name) { classNames.add(name); },
    remove(name) { classNames.delete(name); },
  },
  style: {
    set left(value) { inlineStyles.set('left', value); },
    set right(value) { inlineStyles.set('right', value); },
    set top(value) { inlineStyles.set('top', value); },
    set bottom(value) { inlineStyles.set('bottom', value); },
    removeProperty(name) { inlineStyles.delete(name); },
  },
  offsetParent: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
  getBoundingClientRect: () => ({ width: 300, height: 200 }),
};
const positionContext = vm.createContext({
  readoutEl: readoutForPosition,
  map: { getContainer: () => ({
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 390, bottom: 844 }),
  }) },
  Math,
});
vm.runInContext(app.slice(positionStart, positionEnd), positionContext);
vm.runInContext('positionRoadInfoNear({ x: 195, y: 422 })', positionContext);
assert.equal(inlineStyles.get('left'), '45px', 'a centered tap should center the card horizontally');
assert.equal(inlineStyles.get('top'), '322px', 'a centered tap should center the card vertically');
assert.ok(classNames.has('near-tap'), 'a tapped card should use dynamic placement styling');
vm.runInContext('positionRoadInfoNear({ x: 2, y: 840 })', positionContext);
assert.equal(inlineStyles.get('left'), '10px', 'a card should stay inside the left display edge');
assert.equal(inlineStyles.get('top'), '634px', 'a card should stay inside the bottom display edge');
vm.runInContext('resetRoadInfoPosition()', positionContext);
assert.equal(inlineStyles.size, 0, 'hover previews should clear tapped-card inline positioning');
assert.ok(!classNames.has('near-tap'), 'hover previews should return to stable corner placement');

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
