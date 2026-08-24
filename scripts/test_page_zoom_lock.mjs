#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const index = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const details = fs.readFileSync(new URL('../route-details.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const nativeController = fs.readFileSync(
  new URL('../ios/App/App/BridgeViewController.swift', import.meta.url), 'utf8');

for (const [name, html] of [['main app', index], ['Route Details', details]]) {
  const viewport = /<meta name="viewport" content="([^"]+)"/.exec(html)?.[1] || '';
  assert.match(viewport, /width=device-width/, `${name} must use the device width`);
  assert.match(viewport, /minimum-scale=1/, `${name} must not zoom below 1x`);
  assert.match(viewport, /maximum-scale=1/, `${name} must not page-zoom above 1x`);
  assert.match(viewport, /user-scalable=no/, `${name} must disable browser page pinch`);
  assert.match(viewport, /viewport-fit=cover/, `${name} must preserve iOS safe-area layout`);
}

assert.match(nativeController, /scrollView\.setZoomScale\(1, animated: false\)/,
  'the native shell must reset a page scale inherited from an older session');
assert.match(nativeController, /pinchGestureRecognizer\?\.isEnabled = false/,
  'WKWebView native page pinch must be disabled');
assert.ok(!app.includes('touchZoomRotate?.disable') && !app.includes('touchZoomRotate.disable'),
  'MapLibre map pinch must remain enabled');
// The zoom floor and cross-fade are behaviors of the constructed options, not
// spellings: evaluate the constructor's actual options literal under each
// runtime combination instead of pinning the expression's text.
function mapOptions(constrainedMapRuntime, localDataAvailable) {
  const call = app.indexOf('new maplibregl.Map(');
  assert.ok(call > 0, 'app.js constructs the MapLibre map');
  const open = app.indexOf('{', call);
  let depth = 0, close = open;
  for (; close < app.length; close++) {
    if (app[close] === '{') depth++;
    else if (app[close] === '}' && --depth === 0) break;
  }
  const stub = () => new Proxy(function stubbed() {}, {
    get: (target, key) => (key === Symbol.toPrimitive ? () => 0 : stub()),
    apply: () => stub(),
  });
  const scope = {
    constrainedMapRuntime,
    Region: { localDataAvailable, defaultCenter: [-120.7, 47.4] },
    savedState: null,
  };
  const proxy = new Proxy(scope, {
    has: () => true,
    get: (target, key) => (key === Symbol.unscopables ? undefined
      : key in target ? target[key] : stub()),
  });
  const context = vm.createContext({ __scope: proxy });
  return vm.runInContext(`with (__scope) { (${app.slice(open, close + 1)}) }`, context);
}
assert.equal(mapOptions(true, true).minZoom, 6,
  'phone and WebKit maps must stop before the memory-heavy statewide tile level');
assert.equal(mapOptions(false, true).minZoom, 5,
  'unconstrained browsers keep the wider statewide view');
assert.equal(mapOptions(false, false).minZoom, 1.5,
  'a shell with no local state data must allow national orientation zoom');
assert.equal(mapOptions(true, true).fadeDuration, 0,
  'phone and WebKit maps must not retain two tile generations for a zoom fade');
assert.equal(mapOptions(false, true).fadeDuration, 300,
  'unconstrained browsers keep the tile cross-fade');
assert.equal(mapOptions(true, true).maxTileCacheZoomLevels, 2,
  'phone maps must cap retained tile zoom levels (multi-GB zoom retention measured)');
assert.equal(mapOptions(false, true).maxTileCacheZoomLevels, undefined,
  'unconstrained browsers keep the default retained-tile budget');
assert.match(app, /map\.on\('zoomstart', \(\) => trimRouterCachesSoon\(\)\)/,
  'map zoom must release disposable phone routing caches before widening the tile set');
assert.match(app, /m\.type === 'route-options'[\s\S]*?trimRouterCachesSoon\(\)/,
  'a completed phone route must release its disposable search caches');
assert.match(app, /function moveMapToPlace[\s\S]*?constrainedMapRuntime\) map\.jumpTo\(camera\)/,
  'endpoint selection must jump directly on a constrained phone instead of retaining animated tile generations');
assert.match(app, /function ensureRouterAfterMapSettles[\s\S]*?map\.once\('idle', start\)[\s\S]*?setTimeout\(start, 1800\)/,
  'the phone routing graph must wait for the itinerary camera to settle before its large allocation');
assert.match(app, /duration:\s*constrainedMapRuntime\s*\?\s*0\s*:\s*550/,
  'phone itinerary fitting must avoid an intermediate animated tile allocation');

console.log('Page zoom lock tests passed; map pinch remains enabled.');
