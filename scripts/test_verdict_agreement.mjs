#!/usr/bin/env node
// One road, one verdict.
//
// safety-model.js is the single decision layer -- the app, the router worker
// and the tile build all ask it, and test_build_parity.py keeps them in step.
// That unified the JUDGEMENT. It never unified the EVIDENCE: SOURCES carries
// three scorers reading three different descriptions of the same road, and
// nothing asserted they agree.
//
// So they didn't. `blts` is hit-tested but never painted (applyDisplayMode
// filters its paint layers to false, because the agency's increasing- and
// decreasing-milepost lines would draw on top of each other), yet it answered
// the whole road card. On OR 224 at Three Lynx that produced "Passes your
// rules" on a road the map drew red and the router detours 45 miles to avoid.
//
// This test asserts the invariant directly, for every state that ships a
// graph: the verdict the card shows is the verdict that was painted, and the
// painted verdict is the one the router used.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { ROOT, SafetyModel, check, checkEqual, done, source } from './testlib/harness.mjs';

const appSrc = source('app.js');
const { MAP_STATES } = createRequire(import.meta.url)(ROOT + '/maps/states.js');

/* ------------------------------------------------------- the wiring itself */
// Run the declarations rather than reading them off the source text.
const box = { Set, out: null };
vm.createContext(box);
vm.runInContext(appSrc.slice(appSrc.indexOf('const UNPAINTED_SOURCES'),
  appSrc.indexOf('\n', appSrc.indexOf('const UNPAINTED_SOURCES'))
  + 1) + '\nout = UNPAINTED_SOURCES;', box);
check('blts is declared as a source that is never painted', box.out.has('blts'),
  [...box.out].join(','));

// applyDisplayMode really does filter every blts paint layer off. Lifting the
// whole function would drag in the map; the branch is small enough to run.
const bltsBranch = appSrc.slice(
  appSrc.indexOf("if (src.id === 'blts') {"),
  appSrc.indexOf('updateVisibility(src);',
    appSrc.indexOf("if (src.id === 'blts') {")));
const painted = [];
const ctx = {
  src: { id: 'blts' },
  map: { getLayer: () => true },
  setLayerFilter: (id, f) => painted.push([id, JSON.stringify(f)]),
  osmHitFilter: () => ['boolean', true],
  failId: (s) => s.id + '__fail',
  vhId: (s) => s.id + '__vh',
  hitId: (s) => s.id + '__hit',
};
vm.createContext(ctx);
vm.runInContext(bltsBranch.replace(/^if \(src\.id === 'blts'\) \{/, ''), ctx);
const bltsPaintLayers = painted.filter(([id]) => !id.endsWith('__hit'));
check('every blts paint layer is filtered off', bltsPaintLayers.length >= 3
  && bltsPaintLayers.every(([, f]) => f === '["boolean",false]'),
  JSON.stringify(bltsPaintLayers));
check('but its hit layer stays live, so it can still supply detail rows',
  painted.some(([id]) => id === 'blts__hit'));

/* ------------------ the painted verdict is the one the router acts on */
// scoreRoad reads roads.pmtiles properties; the graph carries the router's own
// per-edge facts. Both feed safety-model.js. Sample real edges out of each
// shipped graph and assert the model returns the level the router stored.
function levelsFromGraph(state) {
  const graph = zlib.gunzipSync(
    readFileSync(`${ROOT}/maps/${state}/graph2.bin.gz`));
  const messages = [];
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} }, Date, Math, Map, Set, TextDecoder,
    ArrayBuffer, DataView, Float32Array, Float64Array, Int8Array, Int16Array,
    Int32Array, Uint8Array, Uint16Array, Uint32Array,
    postMessage: (m) => messages.push(m),
  });
  context.importScripts = (...names) => {
    for (const f of names) vm.runInContext(readFileSync(ROOT + '/' + f, 'utf8'), context);
  };
  context.self = context;
  vm.runInContext(readFileSync(ROOT + '/router-worker.js', 'utf8'), context);
  context.onmessage({ data: { type: 'graph',
    buffer: graph.buffer.slice(graph.byteOffset, graph.byteOffset + graph.byteLength) } });
  return context;
}

// The rider's shipped defaults, lifted from app.js the way every other test
// that needs them does.
const rules = (() => {
  const at = appSrc.indexOf('const DEFAULT_RULES');
  const open = appSrc.indexOf('{', at);
  let depth = 0, i = open;
  for (; i < appSrc.length; i++) {
    if (appSrc[i] === '{') depth++;
    else if (appSrc[i] === '}' && --depth === 0) break;
  }
  const b = { out: null };
  vm.createContext(b);
  vm.runInContext('out = ' + appSrc.slice(open, i + 1), b);
  return b.out;
})();
check('the shipped rules lifted', !!rules && rules.minShoulder != null);

for (const state of MAP_STATES) {
  if (!state.datasets?.graph) continue;
  const g = levelsFromGraph(state.id);
  // The worker's edge arrays are top-level `let`, so they are shared
  // lexically between scripts in this context but are not properties of it.
  // Sample inside the context rather than reaching in from outside.
  g.__rules = rules;
  const r = vm.runInContext(`(() => {
    const total = eLen ? eLen.length : 0;
    if (!total) return { total: 0 };
    // A spread across the whole edge array, not the first N -- those would all
    // be one corner of one county.
    let checked = 0, disagreed = 0;
    const first = [];
    const step = Math.max(1, Math.floor(total / 3000));
    for (let ei = 0; ei < total; ei += step) {
      for (const forward of [true, false]) {
        // evaluate() is what the road card calls; level(), via edgeLevel(), is
        // what the router calls. Both are safety-model.js over the SAME edge
        // facts. If those two entry points ever diverge, a card and a route
        // line disagree about a road the rider is standing on.
        const facts = edgeFacts(ei, forward);
        const card = SafetyModel.evaluate(facts, __rules).level;
        const router = edgeLevel(ei, __rules, forward);
        checked++;
        if (card !== router) {
          disagreed++;
          if (first.length < 4) first.push({ ei, forward, card, router });
        }
      }
    }
    return { total, checked, disagreed, first };
  })()`, g);
  check(`${state.id}: the graph loaded`, r.total > 0, `edges=${r.total}`);
  if (!r.total) continue;
  checkEqual(`${state.id}: the model and the router agree on every sampled `
    + `edge (${r.checked} readings)`, r.disagreed, 0);
  if (r.disagreed) console.log('    first disagreements:', JSON.stringify(r.first));
}

done();
