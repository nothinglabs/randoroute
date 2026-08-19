#!/usr/bin/env node
// Corridor-severance detector, for every state that ships a graph.
//
// A single missing link can quietly cost 45 miles. Hoffman Hill Boulevard
// continues into Mounts Road SW as an 89 m emergency-access way tagged
// `bicycle=yes`; it was dropped from the graph, which left 1.3 mi of I-5 as the
// only way out of DuPont. At a freeway weight of 60 the router preferred a
// detour through Spanaway and Yelm, and Tacoma-Olympia became a 54 mi ride
// against a 26 mi straight line. Nothing failed. No test noticed. The route was
// simply always long, and it took a rider comparing against a Reddit post to
// find it.
//
// These are INVARIANTS, not measurements. No distance window is pinned, because
// a window would have to be re-blessed on every routing change and would teach
// the wrong reflex. What is asserted:
//
//   1. A route EXISTS between each pair.
//   2. It does not need a freeway. Every pair below has a legal surface-street
//      connection a local cyclist actually rides; needing I-5 means a link is
//      missing.
//   3. It is not absurd relative to the straight line. The multiple is loose on
//      purpose -- it catches "the router went around three counties", not "this
//      is 8% longer than last month".
//
// The corridors themselves are a STATE fact and live in
// `maps/<state>/corridors.json`, beside that state's data, with the reason each
// was chosen. This file used to carry Washington's four as a constant, which
// made it the one acceptance gate a new state could not run: the porting guide
// names this test as the stage-5 proof "with that state's corridors" and there
// was no way to give it any.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { appDefaultRules } from './testlib/harness.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const rules = appDefaultRules();

// maps/states.js is a classic script whose IIFE assigns onto `this`, which in
// Node CJS is module.exports -- so require() reaches it and import() may not.
const { MAP_STATES } = createRequire(import.meta.url)(ROOT + 'maps/states.js');

const MI = 1609.344;
function straightMi(a, b) {
  const dx = (b[0] - a[0]) * Math.cos((a[1] + b[1]) / 2 * Math.PI / 180) * 69.0;
  const dy = (b[1] - a[1]) * 69.0;
  return Math.hypot(dx, dy);
}

function workerFor(state) {
  const graph = zlib.gunzipSync(
    fs.readFileSync(`${ROOT}maps/${state}/graph2.bin.gz`));
  const messages = [];
  const context = vm.createContext({
    console, Date, Math, Map, Set, TextDecoder,
    ArrayBuffer, DataView, Float32Array, Float64Array, Int8Array, Int16Array,
    Int32Array, Uint8Array, Uint16Array, Uint32Array,
    postMessage: (m) => messages.push(m),
  });
  context.importScripts = (...names) => {
    for (const n of names) vm.runInContext(fs.readFileSync(ROOT + n, 'utf8'), context);
  };
  context.self = context;
  vm.runInContext(fs.readFileSync(ROOT + 'router-worker.js', 'utf8'), context);
  const buf = graph.buffer.slice(graph.byteOffset, graph.byteOffset + graph.byteLength);
  context.onmessage({ data: { type: 'graph', buffer: buf } });
  return { context, messages };
}

let failures = 0;
let checked = 0;
for (const state of MAP_STATES) {
  if (!state.datasets?.graph) continue;
  const path = `${ROOT}maps/${state.id}/corridors.json`;
  if (!fs.existsSync(path)) {
    // A shipped graph with no nominated corridors is not a pass. The porting
    // brief requires them written down BEFORE the build, so their absence
    // means nobody ever said what this state is supposed to connect.
    console.log(`FAIL  ${state.id}: ships a graph but has no corridors.json`);
    failures++;
    continue;
  }
  const pairs = JSON.parse(fs.readFileSync(path, 'utf8')).corridors || [];
  if (!pairs.length) {
    console.log(`FAIL  ${state.id}: corridors.json nominates nothing`);
    failures++;
    continue;
  }
  console.log(`\n${state.name} — ${pairs.length} corridor(s)`);
  const { context, messages } = workerFor(state.id);
  for (const pair of pairs) {
    checked++;
    messages.length = 0;
    context.onmessage({ data: { type: 'route-options', id: 1, points: [pair.a, pair.b],
      rules, forceDesignated: true, forceResidential: true } });
    const reply = messages.at(-1);
    const straight = straightMi(pair.a, pair.b);
    if (!reply?.ok) {
      console.log(`FAIL  ${pair.name}: no route at all (${reply?.reason || 'no reply'})`);
      failures++;
      continue;
    }
    const best = reply.options.reduce((x, y) => (y.distM < x.distM ? y : x));
    const mi = best.distM / MI;
    const ratio = mi / straight;
    const freewayMi = (best.freewayM || 0) / MI;
    const notes = [];
    const maxRatio = pair.maxRatio ?? 2.5;
    if (ratio > maxRatio) {
      notes.push(`${ratio.toFixed(1)}x the straight line (limit ${maxRatio}x)`);
    }
    // Any freeway mileage in the SHORTEST option means the surface network could
    // not do the job. On a healthy corridor the router never needs one.
    if (freewayMi > 0.05) notes.push(`needs ${freewayMi.toFixed(1)} mi of freeway`);
    if (notes.length) {
      console.log(`FAIL  ${pair.name}: ${mi.toFixed(1)} mi vs ${straight.toFixed(1)} straight — `
        + notes.join('; '));
      failures++;
    } else {
      console.log(`PASS  ${pair.name}: ${mi.toFixed(1)} mi, ${ratio.toFixed(1)}x straight, no freeway`);
    }
  }
}

if (!checked) {
  console.log('FAIL  no state ships a graph; nothing was checked');
  process.exit(1);
}
if (failures) {
  console.log(`\n${failures} corridor(s) severed or badly detoured.`);
  process.exit(1);
}
console.log(`\nAll ${checked} corridors connect on ordinary roads.`);
