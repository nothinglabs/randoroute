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
assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.readout\s*\{[^}]*width:\s*min\(310px, calc\(100vw - 20px\)\)/,
  'the mobile road-information card should use a compact content width');
assert.match(css, /\.readout td\.k\s*\{[^}]*white-space:\s*nowrap/,
  'road-information labels should stay on one line to reduce card height');
assert.match(css, /\.streetview-launch\s*\{[^}]*min-height:\s*34px/,
  'the road-card Street View action should be compact');
assert.match(app, /streetViewBtn\.textContent\s*=\s*'Google Street View'[\s\S]*?mapLink\.textContent\s*=\s*'Google Maps ↗'/,
  'the road card should use the requested Google Street View label and retain a Google Maps link');
assert.match(app, /readoutEl\.append\(close, heading, table, mapActions\)/,
  'the compact road-card actions should appear below the road details');
assert.match(app, /function scoreBLTS\(p\)[\s\S]*?urban: p\.Urban === 1[\s\S]*?\['Area', n\.urban \? 'Urban \(Census\)' : 'Rural \(Census\)'\][\s\S]*?\['Designated bike route', p\.Designated === 1 \? 'yes' : null\]/,
  'WSDOT road scoring and its popup should use the same Census urban/rural context as routing');
assert.match(css, /#settings-limits\s*\{[^}]*overflow-y:\s*hidden[\s\S]*?#settings-limits #settingsSliders\s*\{[^}]*gap:\s*3px[\s\S]*?#settings-limits #settingsSliders \.rule-card\s*\{[^}]*padding:\s*3px 8px/,
  'the compact Limits pane should fit its controls without a nested scrollbar');
assert.match(app, /slider\('urbanMaxSpeedNoShoulder', '<strong class="area-rule area-rule-urban">Urban<\/strong> max speed without shoulder'[\s\S]*?slider\('ruralMaxSpeedNoShoulder', '<strong class="area-rule area-rule-rural">Rural<\/strong> max speed without shoulder'[\s\S]*?slider\('minShoulder', 'Minimum shoulder for faster roads'[\s\S]*?label for="r-upperMaxSpeed">Never allow roads faster than/,
  'Limits should distinguish urban/rural rules and place the minimum shoulder above the speed cutoff');
assert.match(app, /roadInfoHoverMedia\s*=\s*window\.matchMedia\('\(hover: hover\) and \(pointer: fine\)'\)[\s\S]*?if \(!roadInfoHoverMedia\.matches\) return/,
  'touch-generated mouse movement must not open the fixed hover preview');
assert.match(app, /canvas\.addEventListener\('touchend'[\s\S]*?inspectRoadAt\(point, lngLat\)[\s\S]*?lastRoadInfoTouchAt = Date\.now\(\)/,
  'a deliberate map touch should directly open and position pinned road information');

const touchBlockStart = app.indexOf('(() => {', app.indexOf('// Handle deliberate taps directly'));
const touchBlockEnd = app.indexOf("map.on('click'", touchBlockStart);
assert.ok(touchBlockStart >= 0 && touchBlockEnd > touchBlockStart,
  'touch road-inspection handler was not found');
const touchHandlers = {};
const inspectedTouches = [];
const touchContext = vm.createContext({
  Date: { now: () => 2468 },
  Math,
  routing: { arm: null },
  map: {
    getCanvasContainer: () => ({
      addEventListener(type, handler) { touchHandlers[type] = handler; },
    }),
    getCanvas: () => ({ getBoundingClientRect: () => ({ left: 10, top: 20 }) }),
    unproject: ([x, y]) => ({ lng: x, lat: y }),
  },
  inspectRoadAt(point, lngLat) { inspectedTouches.push({ point, lngLat }); return true; },
  placeArmedPoint() { throw new Error('an unarmed inspection tap must not place an endpoint'); },
});
vm.runInContext(`let lastRoadInfoTouchAt = 0; ${app.slice(touchBlockStart, touchBlockEnd)}`, touchContext);
touchHandlers.touchstart({ touches: [{ clientX: 100, clientY: 140 }] });
let touchPrevented = false;
let touchStopped = false;
touchHandlers.touchend({
  changedTouches: [{ clientX: 100, clientY: 140 }],
  preventDefault() { touchPrevented = true; },
  stopPropagation() { touchStopped = true; },
});
assert.equal(inspectedTouches[0].point.x, 90,
  'touch inspection should anchor the card at the tap longitude-axis position');
assert.equal(inspectedTouches[0].point.y, 120,
  'touch inspection should anchor the card at the tap latitude-axis position');
assert.equal(touchPrevented, true, 'a handled road tap should suppress the stale synthetic click');
assert.equal(touchStopped, true, 'a handled road tap should not bubble into competing touch logic');

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

const headingStart = app.indexOf('function streetViewRoadHeading(');
const headingEnd = app.indexOf('function renderReadout(', headingStart);
assert.ok(headingStart >= 0 && headingEnd > headingStart,
  'Street View road-heading helper was not found');
const headingContext = vm.createContext({ Math });
vm.runInContext(app.slice(headingStart, headingEnd), headingContext);
const eastHeading = vm.runInContext(`streetViewRoadHeading({ geometry: {
  type: 'LineString', coordinates: [[-122.1, 47.6], [-122.09, 47.6]]
} }, { lng: -122.095, lat: 47.6 })`, headingContext);
const northHeading = vm.runInContext(`streetViewRoadHeading({ geometry: {
  type: 'LineString', coordinates: [[-122.1, 47.6], [-122.1, 47.61]]
} }, { lng: -122.1, lat: 47.605 })`, headingContext);
assert.ok(Math.abs(eastHeading - 90) < 1, 'an east-west road should open Street View facing along the road');
assert.ok(northHeading < 1 || northHeading > 359, 'a north-south road should open Street View facing along the road');

const urlStart = app.indexOf('function googleMapsPointUrl(');
const urlEnd = app.indexOf('function openStreetView(', urlStart);
assert.ok(urlStart >= 0 && urlEnd > urlStart,
  'Google Map and Street View URL helpers were not found');
const urlContext = vm.createContext({ Math });
vm.runInContext(app.slice(urlStart, urlEnd), urlContext);
const mapUrl = vm.runInContext('googleMapsPointUrl(47.6, -122.1)', urlContext);
const streetViewUrl = vm.runInContext('googleStreetViewUrl(47.6, -122.1, 90)', urlContext);
assert.match(mapUrl, /maps\/search\/\?api=1&query=47\.600000,-122\.100000/,
  'the Google Map link should open the selected coordinates');
assert.match(streetViewUrl, /map_action=pano[\s\S]*?heading=90/,
  'the direct Google Street View link should preserve the road-aligned heading');
assert.match(app, /&radius=250\$\{headingParam\}/,
  'the embedded Street View search should look up to 250 meters from the selected road');
assert.match(app, /const externalLink = document\.getElementById\('streetViewExternal'\);[\s\S]*?externalLink\.href = googleMapsPointUrl\(lat, lng\)/,
  'the Street View header Google Maps link should open the normal map, not panorama mode');

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
