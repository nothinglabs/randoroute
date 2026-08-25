#!/usr/bin/env node
// SOURCE-TEXT TRIPWIRE, the one sanctioned exception to the no-source-text
// rule (AGENTS.md): this container has no Swift compiler, so the bridge
// cannot be executed here. These matches prove the warmup code still exists;
// they prove nothing about its behavior, which only a device build can.
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
