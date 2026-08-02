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

console.log('Page zoom lock tests passed; map pinch remains enabled.');
