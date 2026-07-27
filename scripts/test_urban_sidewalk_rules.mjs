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
    urbanMaxSpeedNoShoulder: 30, ruralMaxSpeedNoShoulder: 35,
    allowSidewalkFallback: false, upperMaxSpeed: 45, noUpperLimit: true,
  };
  const originalOfficial = eOfficial[edge];
  const urbanLevel = edgeLevel(edge, rules, true);
  eOfficial[edge] = originalOfficial & ~EDGE_URBAN;
  const ruralLevel = edgeLevel(edge, rules, true);
  eOfficial[edge] = originalOfficial | EDGE_SIDEWALK;
  const sidewalkLevel = edgeLevel(edge, { ...rules, allowSidewalkFallback: true }, true);
  const hardCapLevel = edgeLevel(edge, {
    ...rules, allowSidewalkFallback: true, noUpperLimit: false, upperMaxSpeed: 30,
  }, true);
  const originalFacility = eFacility[edge];
  eFacility[edge] = 1;
  const sharedLaneLevel = edgeLevel(edge, { ...rules, allowSidewalkFallback: true }, true);
  const sharedLaneUsesSidewalk = sidewalkFallbackApplies(
    edge, { ...rules, allowSidewalkFallback: true }, true, 0);
  eFacility[edge] = originalFacility;
  eOfficial[edge] = originalOfficial;
  return {
    official: originalOfficial, shoulder: eSh[edge], urbanLevel, ruralLevel,
    sidewalkLevel, hardCapLevel, sharedLaneLevel, sharedLaneUsesSidewalk,
  };
})()`, context);

assert.ok(!result.error, result.error);
assert.ok(result.official & 64, 'Pioneer Way East should be inside Census urban context');
assert.ok(result.official & 32, 'Pioneer Way East should retain its explicit sidewalk=no tag');
assert.ok(result.shoulder < 4, 'the test edge needs a missing or narrow shoulder');
assert.equal(result.urbanLevel, 4, '35 mph with no shoulder should fail under the 30 mph urban limit');
assert.equal(result.ruralLevel, 1, 'the same 35 mph edge should pass under the 35 mph rural limit');
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

console.log('Urban/rural sidewalk fallback tests passed.');
