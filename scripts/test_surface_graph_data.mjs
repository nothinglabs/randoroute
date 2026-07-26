#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';

const worker = fs.readFileSync(new URL('../router-worker.js', import.meta.url), 'utf8');
const graph = zlib.gunzipSync(fs.readFileSync(new URL('../data/graph2.bin.gz', import.meta.url)));
assert.equal(graph.subarray(0, 4).toString('ascii'), 'BGR9',
  'production graph should use the BGR9 direction-aware surface layout');

const messages = [];
const context = vm.createContext({
  Date, Math, Map, Set, TextDecoder,
  ArrayBuffer, DataView, Float32Array, Float64Array, Int8Array, Int16Array,
  Int32Array, Uint8Array, Uint16Array, Uint32Array,
  postMessage(message) { messages.push(message); },
});
vm.runInContext(worker, context);
const buffer = graph.byteOffset === 0 && graph.byteLength === graph.buffer.byteLength
  ? graph.buffer : graph.buffer.slice(graph.byteOffset, graph.byteOffset + graph.byteLength);
context.onmessage({ data: { type: 'graph', buffer } });
assert.equal(messages.at(-1)?.type, 'ready', 'surface-aware graph should load in the router');

const surfacesFor = (name) => vm.runInContext(`(() => {
  const values = [];
  for (let edge = 0; edge < E; edge++) {
    if (edgeName(edge) === ${JSON.stringify(name)}) values.push(eSurface[edge]);
  }
  return values;
})()`, context);
const palouse = surfacesFor('Palouse to Cascades State Park Trail');
const highLakes = surfacesFor('High Lakes Trail #116');
assert.ok(palouse.length > 0 && palouse.includes(2),
  'Palouse to Cascades should retain its OSM gravel category in the graph');
assert.ok(highLakes.length > 0 && highLakes.every((surface) => surface === 3),
  'High Lakes Trail #116 should retain its OSM ground/rough category in the graph');

const dismountNames = vm.runInContext(`(() => {
  const names = [];
  for (let edge = 0; edge < E; edge++) {
    if (eOfficial[edge] & 8) names.push(edgeName(edge));
  }
  return names;
})()`, context);
assert.ok(dismountNames.length > 0,
  'the rebuilt graph should retain bicycle=dismount walk-bike connectors');
const mountWashingtonBypass = vm.runInContext(`(() => {
  const lon = -121.6809945, lat = 47.4420273;
  for (let edge = 0; edge < E; edge++) {
    if (!(eOfficial[edge] & 8)) continue;
    if (Math.min(havM(lon, lat, nodeLon[eA[edge]], nodeLat[eA[edge]]),
      havM(lon, lat, nodeLon[eB[edge]], nodeLat[eB[edge]])) < 120) return true;
  }
  return false;
})()`, context);
assert.ok(mountWashingtonBypass,
  'the unnamed Palouse-to-Cascades Mount Washington bypass should remain a dismount connector');

const mountWashingtonEndpoints = vm.runInContext(`(() => {
  const lon = -121.6809945, lat = 47.4420273;
  for (let edge = 0; edge < E; edge++) {
    if (!(eOfficial[edge] & 8)) continue;
    if (Math.min(havM(lon, lat, nodeLon[eA[edge]], nodeLat[eA[edge]]),
      havM(lon, lat, nodeLon[eB[edge]], nodeLat[eB[edge]])) < 120) {
      return [[nodeLon[eA[edge]], nodeLat[eA[edge]]], [nodeLon[eB[edge]], nodeLat[eB[edge]]]];
    }
  }
  return null;
})()`, context);
assert.ok(mountWashingtonEndpoints, 'the dismount connector should expose both graph endpoints');
messages.length = 0;
context.onmessage({ data: {
  type: 'route', id: 'dismount-regression', points: mountWashingtonEndpoints,
  rules: {
    allowFreeways: true, allowMtbTrails: false, vettedBikeRoutes: true,
    minShoulder: 4, unknownShoulderZero: true, freeMaxSpeed: 35,
    upperMaxSpeed: 45, noUpperLimit: true, requireSafe: false,
  }, mode: 'balanced', prefDesignated: true,
} });
const dismountRoute = messages.at(-1);
assert.equal(dismountRoute?.type, 'route', 'dismount route request should complete');
assert.ok(dismountRoute?.ok && dismountRoute.dismountM > 0,
  'a route across the Mount Washington bypass should report a dismount distance');

console.log('Surface graph data tests passed.');
