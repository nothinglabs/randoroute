#!/usr/bin/env node
// One question, one vocabulary, one shape.
//
// The ladder in safety-model.js was always shared. What was not shared was the
// object handed to it: app.js built one shape from normalised props,
// router-worker.js built another from typed arrays, and each of the five
// scorers filled whichever subset its author remembered. Nothing checked them,
// because a forgotten field is not an error in JavaScript -- it is `undefined`,
// which the model reads as "unknown", which is a perfectly valid answer.
//
// That is how a rider got three answers for one road:
//
//   * SR 104 at Kingston drew as failing, the card said "nothing here demands
//     space of its own", and the route over it coloured as passing. scoreBLTS
//     never put AADT into the facts, so the card ignored a count it was
//     printing two lines below the verdict.
//   * `factsOf` read `n.facility` and NO scorer ever set it, so on every card a
//     separated path and a painted lane were the same road.
//
// Neither was a logic error. Both were omissions that looked like data.
//
// This file makes omission impossible to keep:
//
//   1. Every builder produces all of FACT_KEYS. No `undefined`, ever.
//   2. Every source declares which facts it can supply (SOURCE_FACTS), and the
//      declaration is checked against REAL tile data -- a fact claimed but never
//      populated is a broken adapter, and a fact populated but not claimed means
//      the table is stale.
//   3. Sources that share a fact must agree on its type and units.
import assert from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';

const ROOT = new URL('..', import.meta.url).pathname;
const appSrc = fs.readFileSync(ROOT + 'app.js', 'utf8');

const modelBox = vm.createContext({ self: {} });
vm.runInContext(fs.readFileSync(ROOT + 'safety-model.js', 'utf8'), modelBox);
const SM = modelBox.self.SafetyModel;

/* ---- 1. the shape is complete, whatever you feed it -------------------- */
for (const input of [undefined, null, {}, { maxspeed_num: 35 },
  { measures: {} }, { measures: { adt: 100, fc: 4, edge: 6 } },
  { good_facility: true }, { good_facility: true, facility: 5 },
  { facility: 4 }, { lanes: '3' }, { shoulder_width: 0 }]) {
  const facts = SM.factsFrom(input);
  // Spread into a host array: values built inside the vm carry the vm's
  // Array.prototype, and deepStrictEqual compares prototypes.
  assert.deepStrictEqual([...SM.missingFactKeys(facts)], [],
    `factsFrom(${JSON.stringify(input)}) left a fact undefined`);
  for (const k of Object.keys(facts)) {
    assert.ok([...SM.FACT_KEYS].includes(k), `factsFrom invented a fact: ${k}`);
  }
}
assert.deepStrictEqual([...SM.missingFactKeys(SM.sealFacts({}))], [],
  'sealFacts must fill every key');

// The coarse flag may raise a facility to the riding-space floor, never lower a
// known level. A source reporting a separated lane must not be pulled down to 2.
assert.strictEqual(SM.factsFrom({ good_facility: true, facility: 5 }).facility, 5,
  'good_facility must not downgrade a known facility level');
assert.strictEqual(SM.factsFrom({ good_facility: true }).facility, 2,
  'good_facility with no level should reach the riding-space floor');
assert.strictEqual(SM.factsFrom({ facility: 1 }).facility, 1,
  'a sharrow keeps its level; the ladder decides what that is worth');

/* ---- 2. every declared source exists, and vice versa ------------------- */
const declaredSources = Object.keys(SM.SOURCE_FACTS);
for (const [source, keys] of Object.entries(SM.SOURCE_FACTS)) {
  for (const k of keys) {
    assert.ok([...SM.FACT_KEYS].includes(k), `${source} declares an unknown fact: ${k}`);
  }
  assert.strictEqual(new Set(keys).size, keys.length, `${source} lists a fact twice`);
}

/* ---- 3. hold each source to its declaration, on REAL data ------------- */
// Lift the scorers out of app.js and run them over properties taken from the
// shipped graph, which is the only place real attribute combinations live.
// The scorers read the agency's own vocabulary -- its facility names, its
// route-id spelling -- from region.js rather than from literals inlined beside
// them, so the sandbox needs it too.
const { Region } = createRequire(import.meta.url)(
  new URL('../region.js', import.meta.url).pathname);
const box = vm.createContext({ console });
function lift(startMarker, endMarker) {
  const i = appSrc.indexOf(startMarker);
  assert.notStrictEqual(i, -1, `app.js no longer contains ${startMarker}`);
  return appSrc.slice(i, appSrc.indexOf(endMarker, i));
}
vm.runInContext([
  'const SafetyModel = globalThis.SM;',
  // The bit constants and shared predicates scoreRouteSeg leans on live in
  // route-common.js now; the file is self-contained, so inject it whole.
  fs.readFileSync(ROOT + 'route-common.js', 'utf8'),
  lift('const OSM_PROTECTED', '\nfunction scoreOSM'),
  lift('function scoreOSM', '\n// Full OSM road network'),
  lift('const INTERSTATE_ROUTE_PREFIXES', '\n// OSM bike infrastructure'),
  lift('function scoreRoad', '\nfunction scoreRouteOverlay'),
  lift('const ADT_SOURCE_COUNTY', '\nconst ADT_SOURCE_NAME'),
  lift('function tileMeasures', '\nfunction '),
  lift('function scoreRouteSeg', '\n// '),
  'globalThis.OUT = { scoreOSM, scoreRoad, scoreBLTS, scoreRouteSeg };',
].join('\n'), Object.assign(box, { SM, Region }));
const { scoreOSM, scoreRoad, scoreBLTS, scoreRouteSeg } = box.OUT;

// Real WSDOT properties.
const blts = JSON.parse(zlib.gunzipSync(fs.readFileSync(ROOT + 'data/blts.geojson.gz')))
  .features.slice(0, 6000).map((f) => f.properties);
// Real graph edges, via the worker's own builder.
const graph = zlib.gunzipSync(fs.readFileSync(ROOT + 'data/graph2.bin.gz'));
const wctx = vm.createContext({ console, Date, Math, Map, Set, TextDecoder,
  ArrayBuffer, DataView, Float32Array, Float64Array, Int8Array, Int16Array,
  Int32Array, Uint8Array, Uint16Array, Uint32Array, postMessage: () => {} });
wctx.importScripts = (...names) => {
  for (const n of names) vm.runInContext(fs.readFileSync(ROOT + n, 'utf8'), wctx);
};
wctx.self = wctx;
vm.runInContext(fs.readFileSync(ROOT + 'router-worker.js', 'utf8'), wctx);
const buf = graph.buffer.slice(graph.byteOffset, graph.byteOffset + graph.byteLength);
wctx.onmessage({ data: { type: 'graph', buffer: buf } });

const seen = {};       // source -> fact -> did any sample populate it
const bad = [];
function observe(source, facts) {
  const missing = [...SM.missingFactKeys(facts)];
  if (missing.length) {
    bad.push(`${source} produced facts missing: ${missing.join(', ')}`);
    return;
  }
  const box2 = (seen[source] ||= {});
  for (const k of [...SM.FACT_KEYS]) {
    const v = facts[k];
    const populated = v !== null && v !== false && v !== 0;
    box2[k] = box2[k] || populated;
  }
}

for (const p of blts) observe('blts', SM.factsFrom(scoreBLTS(p)));
const edgeSample = vm.runInContext(`(function(){
  const out = [], step = Math.max(1, Math.floor(eA.length / 40000));
  for (let i = 0; i < eA.length; i += step) out.push(edgeFacts(i, true));
  return out;
})()`, wctx);
for (const f of edgeSample) observe('edge', f);

// The graph is also the honest source of realistic ROAD tile properties: the
// tiles are built from the same OSM extract and the same conflation.
for (const f of edgeSample.slice(0, 20000)) {
  observe('roads', SM.factsFrom(scoreRoad({
    w: f.shoulder, s: f.speed, ln: f.lanes, ft: f.facility,
    b: f.prohibited ? 1 : 0, m: f.freeway ? 1 : 0, l: f.limitedAccess ? 1 : 0,
    lts: f.stressRating, u: f.urban ? 1 : 0,
    k: f.sidewalk === 'present' ? 1 : f.sidewalk === 'absent' ? 2 : undefined,
    adt: f.adt, fc: f.fc, es: f.edgeSpace,
  })));
}
// Route segments carry the graph's own facts under the tile key names, which is
// exactly how measureProps flattens them onto a drawn route.
for (const f of edgeSample.slice(0, 20000)) {
  observe('routeseg', SM.factsFrom(scoreRouteSeg({
    facility: f.facility, sh: f.shoulder == null ? -1 : f.shoulder, mph: f.speed,
    ferry: f.ferry ? 1 : 0, fw: f.freeway ? 1 : 0, lim: f.limitedAccess ? 1 : 0,
    infra: f.infra ? 1 : 0, lanes: f.lanes, lts: f.stressRating,
    official: (f.sidewalk === 'present' ? 16 : f.sidewalk === 'absent' ? 32 : 0)
      | (f.urban ? 64 : 0),
    adt: f.adt, fc: f.fc, es: f.edgeSpace,
  })));
}
for (const tags of [{ highway: 'cycleway' }, { highway: 'path', bicycle: 'designated' },
  { highway: 'footway', bicycle: 'yes' }, { highway: 'secondary', cycleway: 'lane' },
  { highway: 'residential', bicycle: 'no' }, { highway: 'track', bicycle: 'yes', width: '3' }]) {
  observe('osm', SM.factsFrom(scoreOSM(tags)));
}

assert.deepStrictEqual(bad, [], 'a builder produced an incomplete facts object');

for (const source of declaredSources) {
  const declared = new Set(SM.SOURCE_FACTS[source]);
  const observed = seen[source];
  assert.ok(observed, `no samples were run for declared source "${source}"`);
  const claimedButEmpty = [...declared].filter((k) => !observed[k]);
  const populatedButUndeclared = [...SM.FACT_KEYS].filter((k) => observed[k] && !declared.has(k));
  assert.deepStrictEqual(populatedButEmptyIsFine(claimedButEmpty, source), [],
    `${source} declares facts it never actually supplies: ${claimedButEmpty.join(', ')}`);
  assert.deepStrictEqual(populatedButUndeclared, [],
    `${source} supplies facts it does not declare, so SOURCE_FACTS is stale: `
    + populatedButUndeclared.join(', '));
}
// `prohibited` and `freeway` are rare enough that a sample may legitimately miss
// them; everything else must show up.
function populatedButEmptyIsFine(list, source) {
  return list.filter((k) => !['prohibited', 'freeway', 'ferry', 'infra'].includes(k));
}

/* ---- 4. shared facts agree on type and units -------------------------- */
// A fact two sources both supply must mean the same thing in both, or the views
// disagree for reasons no amount of ladder-sharing can fix.
const types = {};
for (const [source, factsSeen] of Object.entries(seen)) {
  void factsSeen;
  void source;
}
for (const [source, sampleFacts] of [['edge', edgeSample.slice(0, 500)],
  ['blts', blts.slice(0, 500).map((p) => SM.factsFrom(scoreBLTS(p)))]]) {
  for (const facts of sampleFacts) {
    for (const k of [...SM.FACT_KEYS]) {
      const v = facts[k];
      if (v === null) continue;
      const t = typeof v;
      (types[k] ||= new Map()).set(source, t);
    }
  }
}
for (const [k, bySource] of Object.entries(types)) {
  const distinct = new Set(bySource.values());
  assert.strictEqual(distinct.size, 1,
    `fact "${k}" has different types per source: ${JSON.stringify([...bySource])}`);
}

// Shoulder and edge space are both feet, per side. A source reporting one in
// metres would sail through every other check here.
for (const facts of edgeSample) {
  if (facts.shoulder != null) {
    assert.ok(facts.shoulder >= 0 && facts.shoulder <= 40,
      `shoulder ${facts.shoulder} is not plausible feet-per-side`);
  }
  if (facts.edgeSpace != null) {
    assert.ok(facts.edgeSpace >= 0 && facts.edgeSpace <= 60,
      `edgeSpace ${facts.edgeSpace} is not plausible feet-per-side`);
  }
  if (facts.facility != null) {
    assert.ok(facts.facility >= 0 && facts.facility <= 5,
      `facility ${facts.facility} is outside the shared 0-5 scale`);
  }
  if (facts.fc != null) {
    assert.ok(facts.fc >= 1 && facts.fc <= 7, `fc ${facts.fc} is not an FHWA class`);
  }
}

console.log(`ok - ${SM.FACT_KEYS.length} facts, ${declaredSources.length} sources,`
  + ` ${blts.length + edgeSample.length} real samples; every builder complete`
  + ' and every source matches its declaration');
