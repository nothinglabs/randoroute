#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';

const graph = zlib.gunzipSync(fs.readFileSync(new URL('../data/graph2.bin.gz', import.meta.url)));
const messages = [];
const context = vm.createContext({
  console, Date, Math, Map, Set, TextDecoder,
  ArrayBuffer, DataView, Float32Array, Float64Array, Int8Array, Int16Array,
  Int32Array, Uint8Array, Uint16Array, Uint32Array,
  postMessage(message) { messages.push(message); },
});
vm.runInContext(fs.readFileSync(new URL('../router-worker.js', import.meta.url), 'utf8'), context);
const buffer = graph.byteOffset === 0 && graph.byteLength === graph.buffer.byteLength
  ? graph.buffer : graph.buffer.slice(graph.byteOffset, graph.byteOffset + graph.byteLength);
context.onmessage({ data: { type: 'graph', buffer } });

messages.length = 0;
context.onmessage({ data: {
  type: 'route-connector', id: 71,
  points: [[-122.391, 47.689], [-122.350, 47.673]],
  rules: {
    allowFreeways: false, allowMtbTrails: false, vettedBikeRoutes: true,
    minShoulder: 4, unknownShoulderZero: true, freeMaxSpeed: 35,
    upperMaxSpeed: 45, noUpperLimit: true, requireSafe: true,
  },
  prefDesignated: true,
  prefResidential: true,
} });

const result = messages.at(-1);
assert.equal(result?.type, 'route-connector', 'worker should return a dedicated connector response');
assert.equal(result?.id, 71, 'connector response should preserve the request id');
assert.equal(result?.ok, true, result?.reason || 'Seattle connector route should be available');
assert.ok(result.coords.length > 2 && result.distM > 500,
  'connector should contain a useful routed geometry');
assert.equal(result.optimization.mode, 'balanced', 'connector should use balanced routing');
assert.equal(result.optimization.prefDesignated, true,
  'connector should retain the rider’s bike-route preference');
assert.equal(result.optimization.prefResidential, true,
  'connector should retain the rider’s residential preference');

messages.length = 0;
context.onmessage({ data: {
  type: 'navigation-new-route', id: 72,
  points: [[-122.391, 47.689], [-122.370, 47.680], [-122.350, 47.673]],
  rules: {
    allowFreeways: false, allowMtbTrails: false, vettedBikeRoutes: true,
    minShoulder: 4, unknownShoulderZero: true, freeMaxSpeed: 35,
    upperMaxSpeed: 45, noUpperLimit: true, requireSafe: false,
  },
  mode: 'low', profileId: 'gentle', profileLabel: 'Route A',
  prefDesignated: true, prefResidential: false,
} });
const replacement = messages.at(-1);
assert.equal(replacement?.type, 'navigation-new-route',
  'worker should return a dedicated current-location route response');
assert.equal(replacement?.ok, true, replacement?.reason || 'replacement route should be available');
assert.equal(replacement.optimization.mode, 'low',
  'new route should retain the selected routing mode');
assert.equal(replacement.optimization.prefDesignated, true,
  'new route should retain the current bike-route preference');
assert.equal(replacement.optimization.prefResidential, false,
  'new route should retain the current residential preference');
assert.equal(replacement.optimization.label, 'Route A',
  'a sole replacement route should restart the route labels at A');
assert.equal(replacement.legs?.length, 2,
  'a replacement route should preserve its ordered waypoint as two routed legs');

console.log('Route connector tests passed.');
