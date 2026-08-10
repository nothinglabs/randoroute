#!/usr/bin/env node
// Walk a published corridor in short hops and route each one, to find the
// severance a long corridor hides.
//
// End-to-end comparison is not enough. Oregon's Portland -> Hood River corridor
// came back at 1.6x the straight line and passed the severance detector, while
// a 5.8-mile hop inside it -- Viento to Hood River, on a completed state trail
// -- had no rideable route at all. The long answer was a plausible-looking ride
// around the south side of Mount Hood, and a ratio test cannot tell that from a
// good route. A chain of short hops can: a severance that costs 40 miles is
// invisible at 1.6x over 90 miles and unmissable at 8x over 6.
//
// Usage:
//   node scripts/verify_corridor_chain.mjs <state> [hop miles] [name substring ...]
//
// Prints one line per hop that looks wrong, and a summary per corridor.
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';

const ROOT = new URL('..', import.meta.url).pathname;
const state = process.argv[2] || 'washington';
const hopMi = Number(process.argv[3]) || 5;
const wanted = process.argv.slice(4);
const MI = 1609.344;

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
context.onmessage({ data: { type: 'graph',
  buffer: graph.buffer.slice(graph.byteOffset, graph.byteOffset + graph.byteLength) } });

function metres(a, b) {
  const dx = (b[0] - a[0]) * Math.cos((a[1] + b[1]) / 2 * Math.PI / 180) * 111320;
  const dy = (b[1] - a[1]) * 110540;
  return Math.hypot(dx, dy);
}

const routes = JSON.parse(
  fs.readFileSync(`${ROOT}maps/${state}/bikeroutes.geojson`, 'utf8'));
const byName = new Map();
for (const feature of routes.features) {
  const label = String(feature.properties?.n || feature.properties?.name || '');
  for (const part of label.split(' / ')) {
    const name = part.trim();
    if (!name) continue;
    const lines = feature.geometry.type === 'LineString'
      ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(...lines);
  }
}

// Chain the members end to end: take the longest member as the spine, then
// repeatedly append whichever remaining member starts or ends nearest to a free
// end. Good enough to walk a ribbon in order, which is all the hops need.
function chain(lines) {
  const parts = lines.filter((l) => l.length >= 2).map((l) => l.slice());
  if (!parts.length) return [];
  parts.sort((a, b) => b.length - a.length);
  let spine = parts.shift();
  let joined = true;
  while (joined && parts.length) {
    joined = false;
    let best = null;
    for (let i = 0; i < parts.length; i++) {
      for (const [end, atStart] of [[spine[0], true], [spine[spine.length - 1], false]]) {
        for (const [pt, reversed] of [[parts[i][0], false],
          [parts[i][parts[i].length - 1], true]]) {
          const d = metres(end, pt);
          if (!best || d < best.d) best = { d, i, atStart, reversed };
        }
      }
    }
    if (best && best.d < 200) {
      const piece = best.reversed ? parts[best.i].slice().reverse() : parts[best.i];
      spine = best.atStart ? piece.concat(spine) : spine.concat(piece);
      parts.splice(best.i, 1);
      joined = true;
    }
  }
  return spine;
}

let worstOverall = [];
for (const [name, lines] of byName) {
  if (wanted.length && !wanted.some((w) => name.toLowerCase().includes(w.toLowerCase()))) continue;
  const spine = chain(lines);
  if (spine.length < 2) continue;
  // Sample the spine every `hopMi` miles.
  // Marks carry the distance ALONG the corridor since the previous mark. The
  // straight line between them is the wrong yardstick: Aufderheide Drive loops
  // around Box Canyon, so two marks 4.2 miles apart as the crow flies are 30
  // miles apart on the road, and a correct answer scores 7.2x.
  const marks = [{ at: spine[0], alongM: 0 }];
  let run = 0;
  for (let i = 1; i < spine.length; i++) {
    run += metres(spine[i - 1], spine[i]);
    if (run >= hopMi * MI) { marks.push({ at: spine[i], alongM: run }); run = 0; }
  }
  const last = spine[spine.length - 1];
  if (marks[marks.length - 1].at !== last) marks.push({ at: last, alongM: run });
  if (marks.length < 2) continue;

  const bad = [];
  let worst = 0;
  for (let i = 1; i < marks.length; i++) {
    const a = marks[i - 1].at, b = marks[i].at;
    const straight = marks[i].alongM / MI;
    if (straight < 0.5) continue;
    messages.length = 0;
    context.onmessage({ data: { type: 'route-options', id: 1, points: [a, b], rules,
      forceDesignated: true, forceResidential: true } });
    const reply = messages.at(-1);
    if (!reply?.ok) {
      bad.push(`    NO ROUTE  ${a.map((v) => v.toFixed(4))} -> ${b.map((v) => v.toFixed(4))} `
        + `(${straight.toFixed(1)} mi along the corridor): ${reply?.reason || 'no reply'}`);
      worst = Infinity;
      continue;
    }
    const best = reply.options.reduce((x, y) => (y.distM < x.distM ? y : x));
    const ratio = best.distM / MI / straight;
    if (ratio > worst) worst = ratio;
    if (ratio >= 3) {
      bad.push(`    ${ratio.toFixed(1)}x  ${a.map((v) => v.toFixed(4))} -> `
        + `${b.map((v) => v.toFixed(4))}: ${(best.distM / MI).toFixed(1)} mi `
        + `where the corridor runs ${straight.toFixed(1)} mi`);
    }
  }
  const label = worst === Infinity ? 'SEVERED' : `worst ${worst.toFixed(1)}x`;
  console.log(`${name}  (${marks.length - 1} hops of ~${hopMi} mi)  ${label}`);
  for (const line of bad) console.log(line);
  worstOverall.push([name, worst]);
}
console.log('\nCorridors with a hop over 3x or unroutable:');
for (const [name, worst] of worstOverall.filter(([, w]) => w >= 3)
  .sort((a, b) => b[1] - a[1])) {
  console.log(`  ${worst === Infinity ? 'SEVERED' : worst.toFixed(1) + 'x'}  ${name}`);
}
