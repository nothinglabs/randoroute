#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const nativeController = fs.readFileSync(
  new URL('../ios/App/App/BridgeViewController.swift', import.meta.url), 'utf8');

const failureHandler = /func locationManager\(_ manager: CLLocationManager, didFailWithError error: Error\) \{([\s\S]*?)\n    \}/
  .exec(nativeController)?.[1] || '';
assert.match(failureHandler, /CLError\)\?\.code == \.locationUnknown/,
  'a transient Core Location warm-up failure must be distinguished from a final error');
assert.match(failureHandler, /schedulePendingPositionRetry\(\)[\s\S]*?return[\s\S]*?rejectPendingPositionCalls/,
  'locationUnknown must retry before the ordinary rejection path');
assert.match(nativeController,
  /schedulePendingPositionRetry[\s\S]*?asyncAfter\(deadline: \.now\(\) \+ \.milliseconds\(750\)/,
  'native GPS warm-up retries must be paced rather than spun in a tight loop');
assert.match(nativeController,
  /pendingPositionRetry\?\.cancel\(\)[\s\S]*?private func resolvePendingPositionCalls/,
  'a completed or timed-out request must cancel its pending native retry');

console.log('Native location warm-up retry checks passed.');
