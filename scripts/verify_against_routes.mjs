#!/usr/bin/env node
// Route between the ends of a published bicycle route and dump what the router
// offered, for the verification report `maps/<state>/VERIFICATION.md` requires
// at readiness 5 and above.
//
// This is NOT a test. It asserts nothing and pins nothing: a disagreement with
// a signed route is a signal, not a failure -- lesson D1 is the case where the
// signed route was the wrong answer and the router was right. What it does is
// make the comparison cheap enough to run on twenty corridors instead of two,
// so the report can be about coverage rather than about the two routes someone
// had the patience to check by hand.
//
// The ground truth is the state's OWN `bikeroutes.geojson`: the `route=bicycle`
// relations already in the extract. That is deliberate -- those corridors were
// mapped by people who ride them, they carry the agency's names (in Oregon,
// every Scenic Bikeway and the TransAmerica Trail), and they cost nothing extra
// to fetch.
//
// Usage:
//   node scripts/verify_against_routes.mjs <state> [name substring ...]
//   node scripts/verify_against_routes.mjs oregon > /tmp/out.json
//
// Writes JSON on stdout: for each named route, its endpoints, and for every
// option the router offered, the fraction of that option's length running
// within TOLERANCE_M of the published corridor. Read it with
// scripts/verify_against_routes.py, which does the geometry.
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';

const ROOT = new URL('..', import.meta.url).pathname;
const state = process.argv[2] || 'washington';
const wanted = process.argv.slice(3);

const appSrc = fs.readFileSync(ROOT + 'app.js', 'utf8');
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
  return box.out;
}
const rules = liftRules();

const graph = zlib.gunzipSync(fs.readFileSync(`${ROOT}maps/${state}/graph2.bin.gz`));
const messages = [];
const context = vm.createContext({
  console: { log() {}, warn() {}, error() {} }, Date, Math, Map, Set, TextDecoder,
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

const routes = JSON.parse(
  fs.readFileSync(`${ROOT}maps/${state}/bikeroutes.geojson`, 'utf8'));

// One published corridor is spread over many relation members, so collect every
// member whose name mentions the route and treat the union as the corridor.
const byName = new Map();
for (const feature of routes.features) {
  const label = String(feature.properties?.n || feature.properties?.name || '');
  if (!label) continue;
  for (const part of label.split(' / ')) {
    const name = part.trim();
    if (!name) continue;
    const lines = feature.geometry.type === 'LineString'
      ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(...lines);
  }
}

function metres(a, b) {
  const dx = (b[0] - a[0]) * Math.cos((a[1] + b[1]) / 2 * Math.PI / 180) * 111320;
  const dy = (b[1] - a[1]) * 110540;
  return Math.hypot(dx, dy);
}

// The two ends of the corridor: the farthest-apart pair among sampled vertices.
// A published route is a ribbon, not a tree, so its diameter is its endpoints.
function endpoints(lines) {
  const pts = [];
  for (const line of lines) {
    const step = Math.max(1, Math.floor(line.length / 40));
    for (let i = 0; i < line.length; i += step) pts.push(line[i]);
    pts.push(line[line.length - 1]);
  }
  let best = null, bestD = -1;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = metres(pts[i], pts[j]);
      if (d > bestD) { bestD = d; best = [pts[i], pts[j]]; }
    }
  }
  return { ends: best, spanM: bestD, vertices: pts.length };
}

const out = [];
for (const [name, lines] of byName) {
  if (wanted.length && !wanted.some((w) => name.toLowerCase().includes(w.toLowerCase()))) continue;
  const { ends, spanM } = endpoints(lines);
  if (!ends || spanM < 3000) continue;   // a fragment, not a corridor
  let publishedM = 0;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) publishedM += metres(line[i - 1], line[i]);
  }
  messages.length = 0;
  const started = Date.now();
  context.onmessage({ data: { type: 'route-options', id: 1, points: ends, rules } });
  const reply = messages.at(-1);
  const record = {
    name, ends, spanM: Math.round(spanM), publishedM: Math.round(publishedM),
    ms: Date.now() - started, ok: !!reply?.ok, reason: reply?.reason || null,
    corridor: lines,
    options: (reply?.options || []).map((option) => ({
      distM: Math.round(option.distM),
      timeS: Math.round(option.timeS),
      failM: Math.round(option.failM || 0),
      dismountM: Math.round(option.dismountM || 0),
      trailM: Math.round(option.trailM || 0),
      facilityM: Math.round(option.facilityM || 0),
      freewayM: Math.round(option.freewayM || 0),
      desigM: Math.round(option.desigM || 0),
      coords: option.coords,
    })),
  };
  out.push(record);
  process.stderr.write(`${name}: ${(spanM / 1609.344).toFixed(1)} mi apart, `
    + `${record.options.length} options, ${record.ms} ms\n`);
}
process.stdout.write(JSON.stringify(out));
