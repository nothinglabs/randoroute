#!/usr/bin/env node
// A shared-lane marking is paint in a travel lane, not space of your own, so it
// must not satisfy the shoulder rule. This landed in app.js first and not in the
// router, which produced a card reading "Verdict: Passes your rules" directly
// above "Why: Fails: shoulder unknown" — the Verdict line comes from the
// worker's edgeLevel, the Why line and the drawn colour from app.js.
//
// Every implementation of the shoulder gate must therefore use the same
// facility threshold. `facility >= 2` is a bike lane or better; 1 is a sharrow.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../router-worker.js', import.meta.url), 'utf8');
const model = fs.readFileSync(new URL('../safety-model.js', import.meta.url), 'utf8');

// One threshold, defined once, above which a facility is space of your own.
assert.match(model, /var FACILITY_RIDING_SPACE = 2;/,
  'a sharrow (facility 1) must sit below the riding-space threshold');
assert.match(model, /function shoulderFails\(facts, shoulder, rules\) \{\s*return \(facts\.facility \|\| 0\) < FACILITY_RIDING_SPACE/,
  'the shoulder rung must gate on the shared riding-space threshold');
assert.match(model, /function sidewalkFallbackApplies[\s\S]*?\(facts\.facility \|\| 0\) < FACILITY_RIDING_SPACE/,
  'the sidewalk fallback should be reachable on a sharrowed road');
// Every scorer must normalise a sharrow to facility 1, never to "has a facility".
assert.match(app, /good_facility: p\.ft >= 2/,
  'a road tile counts a bike lane or better as riding space');
assert.match(app, /good_facility: facility >= 2/,
  'a route segment counts a bike lane or better as riding space');
assert.doesNotMatch(worker, /eFacility\[i\] === 0/,
  'the old "any facility counts" gate should be gone from the router');

/* --------------------------------- and it actually bites on the real graph */
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

const out = vm.runInContext(`(() => {
  const rules = {
    allowFreeways: true, allowMtbTrails: false,
    // 30, not the 35 default: the subject here is whether a SHARROW counts as
    // riding space, and that question only arises once a road is fast enough to
    // reach the shoulder rung. At the default limit this 35 mph edge passes as
    // a slow road and never gets there.
    minShoulder: 4, maxSpeedNoShoulder: 30,
    upperMaxSpeed: 45, noUpperLimit: true,
    requireSafe: false, allowSidewalkFallback: true, maxLanesNoShoulder: 4,
  };
  // 8th Avenue South at S 312th St, Federal Way: sharrow, shoulder untagged,
  // 35 mph, urban. The segment from the bug report.
  const lon = -122.3355, lat = 47.3105;
  let edge = -1, best = 1e9;
  for (let i = 0; i < E; i++) {
    if (edgeName(i) !== '8th Avenue South' || eFacility[i] !== 1 || eSpeed[i] !== 35) continue;
    const d = Math.min(havM(lon, lat, nodeLon[eA[i]], nodeLat[eA[i]]),
                       havM(lon, lat, nodeLon[eB[i]], nodeLat[eB[i]]));
    if (d < best) { best = d; edge = i; }
  }
  if (edge < 0) return { error: 'no sharrowed 35 mph 8th Avenue South edge found' };
  let sharrowsStillPassing = 0;
  for (let i = 0; i < E; i++) {
    if (eFacility[i] !== 1) continue;
    let sh = eSh[i];
    if (sh < 0) sh = 0;
    const gated = sh < rules.minShoulder && !(eFlags[i] & (4 | 8 | 32))
      && eSpeed[i] > rules.maxSpeedNoShoulder;
    // Anything the shoulder rule should catch must now be a fail, or a caution
    // that only the sidewalk fallback earned it.
    if (gated && edgeLevel(i, rules, true) < 3) sharrowsStillPassing++;
  }
  return { level: edgeLevel(edge, rules, true), sharrowsStillPassing };
})()`, context);

assert.equal(out.error, undefined, out.error || '');
assert.equal(out.level, 4,
  'the reported segment should now fail in the router, matching its card and its colour');
assert.equal(out.sharrowsStillPassing, 0,
  'no sharrowed, unshouldered, fast road may still pass the router outright');

console.log('Sharrow tests passed (the reported 8th Avenue South segment now fails in the router too).');
