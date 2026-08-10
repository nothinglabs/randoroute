#!/usr/bin/env node
// Corridor-severance detector.
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
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';

const ROOT = new URL('..', import.meta.url).pathname;
const appSrc = fs.readFileSync(ROOT + 'app.js', 'utf8');
// Brace-match the literal: it does not end on a predictable `\n});`, and a
// terminator guess silently lifts the wrong object.
function liftRules() {
  const at = appSrc.indexOf('const DEFAULT_RULES');
  const open = appSrc.indexOf('{', at);
  let depth = 0, i = open;
  for (; i < appSrc.length; i++) {
    const c = appSrc[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) break; }
  }
  const box = { out: null };
  vm.createContext(box);
  vm.runInContext('out = ' + appSrc.slice(open, i + 1), box);
  if (box.out.minShoulder == null) throw new Error('DEFAULT_RULES lift failed');
  return box.out;
}
const rules = liftRules();

const graph = zlib.gunzipSync(fs.readFileSync(ROOT + 'maps/washington/graph2.bin.gz'));
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

const MI = 1609.344;
function straightMi(a, b) {
  const dx = (b[0] - a[0]) * Math.cos((a[1] + b[1]) / 2 * Math.PI / 180) * 69.0;
  const dy = (b[1] - a[1]) * 69.0;
  return Math.hypot(dx, dy);
}

// Pairs that a local cyclist connects on ordinary roads. The DuPont ones bracket
// the link that went missing; the others are controls, so a failure points at a
// corridor rather than at the router in general.
const PAIRS = [
  { name: 'DuPont -> Nisqually (the severed link)',
    a: [-122.6318, 47.0979], b: [-122.7027, 47.0575], maxRatio: 2.5 },
  { name: 'Tacoma -> Olympia', a: [-122.4443, 47.2529], b: [-122.9007, 47.0379], maxRatio: 2.5 },
  { name: 'Seattle -> Everett', a: [-122.3321, 47.6062], b: [-122.2021, 47.9790], maxRatio: 2.5 },
  { name: 'Olympia -> Centralia', a: [-122.9007, 47.0379], b: [-122.9540, 46.7162], maxRatio: 2.5 },
];

let failures = 0;
for (const pair of PAIRS) {
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
  if (ratio > pair.maxRatio) {
    notes.push(`${ratio.toFixed(1)}x the straight line (limit ${pair.maxRatio}x)`);
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

if (failures) {
  console.log(`\n${failures} corridor(s) severed or badly detoured.`);
  process.exit(1);
}
console.log('\nAll corridors connect on ordinary roads.');
