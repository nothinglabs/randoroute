#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

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
assert.match(app, /minZoom:\s*constrainedMapRuntime\s*\?\s*6\s*:\s*5/,
  'phone and WebKit maps must stop before the memory-heavy statewide tile level');
assert.match(app, /fadeDuration:\s*constrainedMapRuntime\s*\?\s*0\s*:\s*300/,
  'phone and WebKit maps must not retain two tile generations for a zoom fade');
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
