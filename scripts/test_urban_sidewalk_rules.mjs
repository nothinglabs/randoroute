#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';

const worker = fs.readFileSync(new URL('../router-worker.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const graph = zlib.gunzipSync(fs.readFileSync(new URL('../data/graph2.bin.gz', import.meta.url)));
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
assert.equal(messages.at(-1)?.type, 'ready', 'the production graph should load');
assert.match(app, /const DEFAULT_RULES = Object\.freeze\(\{[\s\S]*?allowSidewalkFallback:\s*true/,
  'sidewalk fallback should default on for new route settings');
const presetsStart = app.indexOf('const ROUTING_PRESETS = Object.freeze([');
const presetsEnd = app.indexOf('function validRoutePoint', presetsStart);
assert.ok(presetsStart >= 0 && presetsEnd > presetsStart, 'routing presets should be defined');
const presets = app.slice(presetsStart, presetsEnd);
assert.equal((presets.match(/\.\.\.DEFAULT_RULES/g) || []).length, 3,
  'every preset should inherit the sidewalk-fallback default');
assert.doesNotMatch(presets, /allowSidewalkFallback:\s*false/,
  'no preset should disable sidewalk fallback by default');

const result = vm.runInContext(`(() => {
  // Pioneer Way E is the urban, 35 mph, explicitly-no-sidewalk test case.
  const lon = -122.248, lat = 47.183;
  let edge = -1;
  for (let i = 0; i < E; i++) {
    if (edgeName(i) !== 'Pioneer Way East' || eSpeed[i] !== 35) continue;
    const distance = Math.min(havM(lon, lat, nodeLon[eA[i]], nodeLat[eA[i]]),
      havM(lon, lat, nodeLon[eB[i]], nodeLat[eB[i]]));
    if (distance < 1800) { edge = i; break; }
  }
  if (edge < 0) return { error: 'No Pioneer Way East 35 mph edge near Puyallup' };
  const rules = {
    allowFreeways: true, allowMtbTrails: false, vettedBikeRoutes: false,
    minShoulder: 4, unknownShoulderZero: true,
    maxSpeedNoShoulder: 35,
    allowSidewalkFallback: false, upperMaxSpeed: 45, noUpperLimit: true,
  };
  const originalOfficial = eOfficial[edge];
  // The slow-road rung still answers to the setting: this 35 mph edge fails at
  // a 30 mph limit and passes at 35.
  const strictLevel = edgeLevel(edge, { ...rules, maxSpeedNoShoulder: 30 }, true);
  const looseLevel = edgeLevel(edge, rules, true);
  // But the urban flag no longer moves it either way. That fork is gone: a
  // 35 mph lane with no shoulder is the same lane in town or out of it.
  eOfficial[edge] = originalOfficial & ~EDGE_URBAN;
  const ruralSameLevel = edgeLevel(edge, rules, true);
  const ruralStrictLevel = edgeLevel(edge, { ...rules, maxSpeedNoShoulder: 30 }, true);
  eOfficial[edge] = originalOfficial | EDGE_SIDEWALK;
  const sidewalkLevel = edgeLevel(edge,
    { ...rules, maxSpeedNoShoulder: 30, allowSidewalkFallback: true }, true);
  const hardCapLevel = edgeLevel(edge, {
    ...rules, maxSpeedNoShoulder: 30, allowSidewalkFallback: true,
    noUpperLimit: false, upperMaxSpeed: 30,
  }, true);
  const originalFacility = eFacility[edge];
  eFacility[edge] = 1;
  const sharedLaneLevel = edgeLevel(edge,
    { ...rules, maxSpeedNoShoulder: 30, allowSidewalkFallback: true }, true);
  const sharedLaneUsesSidewalk = sidewalkFallbackApplies(
    edge, { ...rules, maxSpeedNoShoulder: 30, allowSidewalkFallback: true }, true, 0);
  eFacility[edge] = originalFacility;
  eOfficial[edge] = originalOfficial;
  return {
    official: originalOfficial, shoulder: eSh[edge],
    strictLevel, looseLevel, ruralSameLevel, ruralStrictLevel,
    sidewalkLevel, hardCapLevel, sharedLaneLevel, sharedLaneUsesSidewalk,
  };
})()`, context);

assert.ok(!result.error, result.error);
assert.ok(result.official & 64, 'Pioneer Way East should be inside Census urban context');
assert.ok(result.official & 32, 'Pioneer Way East should retain its explicit sidewalk=no tag');
assert.ok(result.shoulder < 4, 'the test edge needs a missing or narrow shoulder');
assert.equal(result.strictLevel, 4, '35 mph with no shoulder should fail under a 30 mph limit');
assert.equal(result.looseLevel, 1, 'the same edge should pass under a 35 mph limit');
// The point of the collapse: geography no longer changes the answer.
assert.equal(result.ruralSameLevel, result.looseLevel,
  'clearing the urban flag must not change the verdict; there is one limit now');
assert.equal(result.ruralStrictLevel, result.strictLevel,
  'and it must not change it under a stricter limit either');
assert.equal(result.sidewalkLevel, 3, 'a mapped sidewalk should become an amber fallback, not a pass');
assert.equal(result.hardCapLevel, 4, 'sidewalk fallback must not bypass the upper speed limit');
// A sharrow is paint in a travel lane, not space of your own, so it no longer
// satisfies the shoulder rule. By this point the setup above has given the edge
// a mapped sidewalk, so the fallback catches it at amber rather than a fail --
// and a sharrow no longer suppresses that fallback the way it used to.
assert.equal(result.sharedLaneLevel, 3,
  'a shared-lane marking must not stand in for a shoulder; only the sidewalk saves it');
assert.equal(result.sharedLaneUsesSidewalk, true,
  'a sharrowed road with no shoulder should be eligible for sidewalk fallback and its penalty');

console.log('Sidewalk fallback tests passed; the urban flag no longer forks the speed rule.');
