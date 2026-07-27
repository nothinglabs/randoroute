#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';

const worker = fs.readFileSync(new URL('../router-worker.js', import.meta.url), 'utf8');
const graph = zlib.gunzipSync(fs.readFileSync(new URL('../data/graph2.bin.gz', import.meta.url)));
// 'BGRA' is format 10, which appends edgeLanes/edgeLts; the worker reads both
// and this file relies on its parsing, so either layout is valid here.
assert.ok(['BGR9', 'BGRA'].includes(graph.subarray(0, 4).toString('ascii')),
  'production graph should use a supported direction-aware layout');

const messages = [];
const context = vm.createContext({
  Date, Math, Map, Set, TextDecoder,
  ArrayBuffer, DataView, Float32Array, Float64Array, Int8Array, Int16Array,
  Int32Array, Uint8Array, Uint16Array, Uint32Array,
  postMessage(message) { messages.push(message); },
});
context.importScripts = (...names) => {
  // The worker loads the shared verdict model with importScripts(); mirror that
  // here so a test context is the same environment the browser gives it.
  for (const n of names) {
    vm.runInContext(fs.readFileSync(new URL(`../${n}`, import.meta.url), 'utf8'), context);
  }
};
vm.runInContext(worker, context);
const buffer = graph.byteOffset === 0 && graph.byteLength === graph.buffer.byteLength
  ? graph.buffer : graph.buffer.slice(graph.byteOffset, graph.byteOffset + graph.byteLength);
context.onmessage({ data: { type: 'graph', buffer } });
assert.equal(messages.at(-1)?.type, 'ready', 'direction-aware graph should load');

const repro = vm.runInContext(`(() => {
  const lon = -122.447333, lat = 48.001199;
  let best = null;
  for (let edge = 0; edge < E; edge++) {
    const name = edgeName(edge);
    if (name !== 'State Route 525' && name !== 'SR 525') continue;
    const midLon = (nodeLon[eA[edge]] + nodeLon[eB[edge]]) / 2;
    const midLat = (nodeLat[eA[edge]] + nodeLat[eB[edge]]) / 2;
    const distance = havM(lon, lat, midLon, midLat);
    if (!best || distance < best.distance) {
      best = {
        distance,
        name,
        speedAB: edgeSpeed(edge, true),
        speedBA: edgeSpeed(edge, false),
        shoulderAB: edgeShoulder(edge, true),
        shoulderBA: edgeShoulder(edge, false),
        levelAB: edgeLevel(edge, {
          allowFreeways: true, allowMtbTrails: false, vettedBikeRoutes: true,
          minShoulder: 4, unknownShoulderZero: true, freeMaxSpeed: 35,
          urbanMaxSpeedNoShoulder: 30, ruralMaxSpeedNoShoulder: 35,
          upperMaxSpeed: 45, noUpperLimit: true, requireSafe: false,
          sidewalkFallback: true,
        }, true),
        levelBA: edgeLevel(edge, {
          allowFreeways: true, allowMtbTrails: false, vettedBikeRoutes: true,
          minShoulder: 4, unknownShoulderZero: true, freeMaxSpeed: 35,
          urbanMaxSpeedNoShoulder: 30, ruralMaxSpeedNoShoulder: 35,
          upperMaxSpeed: 45, noUpperLimit: true, requireSafe: false,
          sidewalkFallback: true,
        }, false),
      };
    }
  }
  return best;
})()`, context);

assert.ok(repro && repro.distance < 80,
  'SR-525 should have a graph edge near the Whidbey repro coordinate');
assert.deepEqual(
  new Set([repro.shoulderAB, repro.shoulderBA]),
  new Set([0, 8]),
  'SR-525 should retain its 0 ft and 8 ft shoulders as directional values',
);
assert.equal(repro.speedAB, 55, 'SR-525 increasing direction should retain 55 mph');
assert.equal(repro.speedBA, 55, 'SR-525 decreasing direction should retain 55 mph');
// SR-525 is rated LTS 4, so the direction with an 8 ft shoulder meets every
// measured rule but is still cautioned by the official rating -- 3, not 2. The
// 0 ft direction fails on shoulder regardless. The point of the test is that
// the two directions are scored independently, and they still are.
assert.deepEqual(
  new Set([repro.levelAB, repro.levelBA]),
  new Set([3, 4]),
  'default rules should caution the 8 ft direction and fail the 0 ft direction',
);

console.log('Directional graph data tests passed.');
