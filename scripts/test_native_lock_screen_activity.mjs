#!/usr/bin/env node
// SOURCE-TEXT TRIPWIRE, the one sanctioned exception to the no-source-text
// rule (AGENTS.md): this container has no Swift compiler, so the Live
// Activity cannot be executed here. These matches prove the lock-screen
// navigation plumbing still exists across all four pieces — shared
// attributes, widget extension, bridge lifecycle, and the Info.plist
// capability — and that the web payload still feeds it. They prove nothing
// about on-device behavior, which only a physical iPhone can
// (docs/IOS-HANDOFF.md §Live Activity).
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');

const attributes = read('ios/App/App/NavigationActivityAttributes.swift');
assert.match(attributes, /struct NavigationActivityAttributes: ActivityAttributes/);
assert.match(attributes, /var headline: String/);
assert.match(attributes, /var arrowSymbol: String/);

const widget = read('ios/App/RandoRouteActivity/NavigationLiveActivity.swift');
assert.match(widget, /ActivityConfiguration\(for: NavigationActivityAttributes\.self\)/);
assert.match(widget, /DynamicIsland/);

const bundle = read('ios/App/RandoRouteActivity/RandoRouteActivityBundle.swift');
assert.match(bundle, /WidgetBundle/);
assert.match(bundle, /NavigationLiveActivity\(\)/);

const bridge = read('ios/App/App/BridgeViewController.swift');
assert.match(bridge, /func startNavigationActivity\(\)/);
assert.match(bridge, /func syncNavigationActivity\(nearestRouteM/);
assert.match(bridge, /func endNavigationActivity\(arrived/);
// Both guidance paths — per-fix and the stopped-rider cadence — feed the card.
assert.equal(bridge.match(/syncNavigationActivity\(nearestRouteM: nearest\.routeM\)/g)?.length, 2,
  'both guidance paths must sync the activity');
assert.match(bridge, /endNavigationActivity\(arrived: arrived\)/,
  'ride teardown must end the activity');

assert.match(read('ios/App/App/Info.plist'), /NSSupportsLiveActivities/);

// The web payload carries the glance line and arrow for every instruction.
const app = read('app.js');
assert.match(app, /headline: instruction\.kind === 'caution' \? 'Caution ahead' : navManeuverWord\(instruction\.delta\)/);
assert.match(app, /destinationName: \(routing\.endName && routing\.endName\.trim\(\)\) \|\| 'your destination'/);

console.log('Lock-screen Live Activity tripwires all present (existence only — device build is the real test).');
