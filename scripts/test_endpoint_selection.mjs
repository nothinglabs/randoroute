#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
assert.match(app, /if \(more\) more\.disabled = false;/,
  'the more-actions menu should remain available before both endpoints are selected');
const start = app.indexOf('function advanceToMissingEndpoint');
const end = app.indexOf('function enableLongPressEndpointMove');
assert.ok(start >= 0 && end > start, 'endpoint-selection helper source was not found');

const messages = [];
const context = vm.createContext({
  routing: { start: null, end: [-122.3, 47.9], arm: null },
  suppressRoadInfo() {},
  updateArmButtons() {},
  setRouteStatus(message) { messages.push(['status', message]); },
  showRouteActionToast(message) { messages.push(['toast', message]); },
});
vm.runInContext(`${app.slice(start, end)}\nthis.advance = advanceToMissingEndpoint;`, context);

assert.equal(context.advance('end'), true, 'destination-first should advance automatically');
assert.equal(context.routing.arm, 'start', 'destination-first should arm the start point');
assert.match(messages.at(-2)[1], /Destination set.*choose start/,
  'destination-first status should explain the next action');

messages.length = 0;
context.routing.start = [-122.35, 47.67];
context.routing.end = null;
context.routing.arm = null;
assert.equal(context.advance('start'), true, 'start-first should advance automatically');
assert.equal(context.routing.arm, 'end', 'start-first should arm the destination');
assert.match(messages.at(-1)[1], /Start set.*Now choose destination/,
  'start-first toast should consistently call the endpoint the destination');
assert.doesNotMatch(messages.at(-1)[1], /choose end/i,
  'endpoint prompts should not switch terminology from destination to end');

context.routing.end = [-122.3, 47.9];
context.routing.arm = null;
assert.equal(context.advance('end'), false, 'a complete route should not auto-arm another endpoint');
assert.equal(context.routing.arm, null, 'replacing an endpoint should preserve normal complete-route behavior');

console.log('Endpoint selection tests passed.');
