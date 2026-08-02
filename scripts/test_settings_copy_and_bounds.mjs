#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

assert.match(app, /minShoulder:\s*\[2,\s*10\]/,
  'imported, shared, and saved rules must clamp the minimum shoulder to 2 ft');
assert.match(app,
  /slider\('minShoulder',\s*'Minimum shoulder width to count as safe-ish',\s*2,\s*10,\s*1,\s*' ft'\)/,
  'the rider-facing shoulder slider must start at 2 ft');
assert.ok(app.includes('Require a bike lane or safe-ish width shoulder.'),
  'the grouped bike-space rule must use the requested wording');
assert.ok(!html.includes('Never a safety rule.'),
  'the removed routing-weights explanation must not remain on screen');
assert.ok(html.includes('id="weightsModifiedNotice"'),
  'the weights screen needs a page-level modified-state header');

console.log('Settings copy and the 2 ft minimum shoulder bound are in place.');
