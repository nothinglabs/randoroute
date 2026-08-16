#!/usr/bin/env node
// Measure lesson B6 for a shipped state: how many graph edges change verdict
// because FHWA functional class is present, versus the same facts with only
// that proxy removed. A measured traffic count still wins in both readings.
//
// Usage: node scripts/audit_functional_class_blast_radius.mjs oregon
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';

const ROOT = new URL('..', import.meta.url).pathname;
const state = process.argv[2] || 'oregon-opus-1';
const appSrc = readFileSync(`${ROOT}app.js`, 'utf8');

function shippedRules() {
  const at = appSrc.indexOf('const DEFAULT_RULES');
  const open = appSrc.indexOf('{', at);
  let depth = 0, end = open;
  for (; end < appSrc.length; end++) {
    if (appSrc[end] === '{') depth++;
    else if (appSrc[end] === '}' && --depth === 0) break;
  }
  const box = { out: null };
  vm.createContext(box);
  vm.runInContext(`out = ${appSrc.slice(open, end + 1)}`, box);
  return box.out;
}

const graph = zlib.gunzipSync(readFileSync(`${ROOT}maps/${state}/graph2.bin.gz`));
const context = vm.createContext({
  console: { log() {}, warn() {}, error() {} }, Date, Math, Map, Set, TextDecoder,
  ArrayBuffer, DataView, Float32Array, Float64Array, Int8Array, Int16Array,
  Int32Array, Uint8Array, Uint16Array, Uint32Array, postMessage() {},
});
context.importScripts = (...names) => {
  for (const name of names) vm.runInContext(readFileSync(`${ROOT}${name}`, 'utf8'), context);
};
context.self = context;
context.__state = state;
vm.runInContext(readFileSync(`${ROOT}router-worker.js`, 'utf8'), context);
context.onmessage({ data: { type: 'graph',
  buffer: graph.buffer.slice(graph.byteOffset, graph.byteOffset + graph.byteLength) } });
context.__rules = shippedRules();

const report = vm.runInContext(`(() => {
  const owners = ['unknown/federal/other', 'state', 'county', 'town', 'city'];
  const blank = () => ({ readings: 0, miles: 0, changed: 0, changedMiles: 0,
    worse: 0, better: 0, passToFail: 0, passToCaution: 0 });
  const total = blank();
  const byOwner = Object.fromEntries(owners.map((name) => [name, blank()]));
  const byClass = Object.fromEntries([1, 2, 3, 4, 5, 6, 7]
    .map((fc) => [fc, blank()]));
  const byContext = { urban: blank(), rural: blank() };
  const changedNames = new Map();
  const costBlank = () => ({ readings: 0, miles: 0, changed: 0,
    changedMiles: 0, raised: 0, lowered: 0 });
  const routeCost = costBlank();
  const costByOwner = Object.fromEntries(owners.map((name) => [name, costBlank()]));
  const costNames = new Map();
  const touch = (box, miles, before, after) => {
    box.readings++;
    box.miles += miles;
    if (before === after) return;
    box.changed++;
    box.changedMiles += miles;
    if (after > before) box.worse++;
    else box.better++;
    if (before <= 2 && after === 4) box.passToFail++;
    if (before <= 2 && after === 3) box.passToCaution++;
  };
  const touchCost = (box, miles, before, after) => {
    box.readings++;
    box.miles += miles;
    if (before === after) return;
    box.changed++;
    box.changedMiles += miles;
    if (after > before) box.raised++;
    else box.lowered++;
  };
  for (let ei = 0; ei < E; ei++) {
    const packed = eClassOwner?.[ei] || 0;
    const fc = packed & 15;
    if (!fc) continue;
    const owner = owners[packed >> 4] || owners[0];
    const miles = (Number(eLen[ei]) || 0) / 1609.344;
    for (const forward of [true, false]) {
      const facts = edgeFacts(ei, forward);
      const withoutClass = SafetyModel.sealFacts({ ...facts, fc: null });
      const before = SafetyModel.level(withoutClass, __rules);
      const after = SafetyModel.level(facts, __rules);
      touch(total, miles, before, after);
      touch(byOwner[owner], miles, before, after);
      touch(byClass[fc], miles, before, after);
      touch(byContext[facts.urban ? 'urban' : 'rural'], miles, before, after);
      // The same class proxy also replaces the OSM traffic tier in route
      // pricing when there is no measured count. Count that separately from
      // verdict changes: a corridor can move even when every edge still passes.
      const exempt = eFacility[ei] >= 1 || (eFlags[ei] & (8 | 32 | 4))
        || edgeLimited(ei, forward);
      const osmTier = osmTrafficTier(ei);
      const measuredTier = measuredTrafficTier(ei);
      const pricedTier = measuredTier == null ? osmTier : measuredTier;
      const beforeCost = exempt ? 0 : osmTier;
      const afterCost = exempt ? 0 : pricedTier;
      touchCost(routeCost, miles, beforeCost, afterCost);
      touchCost(costByOwner[owner], miles, beforeCost, afterCost);
      if (beforeCost !== afterCost) {
        const name = edgeName(ei) || 'Unnamed road';
        const key = owner + '|' + name;
        const item = costNames.get(key) || { owner, name, miles: 0, readings: 0,
          raised: 0, lowered: 0, raisedMiles: 0, loweredMiles: 0,
          beforeTiers: new Set(), afterTiers: new Set(), classes: new Set() };
        item.miles += miles;
        item.readings++;
        if (afterCost > beforeCost) { item.raised++; item.raisedMiles += miles; }
        else { item.lowered++; item.loweredMiles += miles; }
        item.beforeTiers.add(beforeCost);
        item.afterTiers.add(afterCost);
        item.classes.add(fc);
        costNames.set(key, item);
      }
      if (before !== after) {
        const name = edgeName(ei) || 'Unnamed road';
        const key = owner + '|' + name;
        const item = changedNames.get(key) || { owner, name, miles: 0, readings: 0,
          worstBefore: 0, worstAfter: 0, classes: new Set() };
        item.miles += miles;
        item.readings++;
        item.worstBefore = Math.max(item.worstBefore, before);
        item.worstAfter = Math.max(item.worstAfter, after);
        item.classes.add(fc);
        changedNames.set(key, item);
      }
    }
  }
  const round = (box) => ({ ...box,
    miles: Number(box.miles.toFixed(1)),
    changedMiles: Number(box.changedMiles.toFixed(1)),
    changedPct: box.readings ? Number((100 * box.changed / box.readings).toFixed(2)) : 0,
  });
  const roundCost = (box) => ({ ...box,
    miles: Number(box.miles.toFixed(1)),
    changedMiles: Number(box.changedMiles.toFixed(1)),
    changedPct: box.readings ? Number((100 * box.changed / box.readings).toFixed(2)) : 0,
  });
  return {
    state: __state,
    total: round(total),
    byOwner: Object.fromEntries(Object.entries(byOwner).map(([k, v]) => [k, round(v)])),
    byClass: Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, round(v)])),
    byContext: Object.fromEntries(Object.entries(byContext).map(([k, v]) => [k, round(v)])),
    routeCost: roundCost(routeCost),
    routeCostByOwner: Object.fromEntries(Object.entries(costByOwner)
      .map(([k, v]) => [k, roundCost(v)])),
    changedRoads: [...changedNames.values()]
      .sort((a, b) => b.miles - a.miles).slice(0, 30)
      .map((item) => ({ ...item, miles: Number(item.miles.toFixed(1)),
        classes: [...item.classes].sort() })),
    costChangedRoads: [...costNames.values()]
      .sort((a, b) => b.miles - a.miles).slice(0, 40)
      .map((item) => ({ ...item, miles: Number(item.miles.toFixed(1)),
        raisedMiles: Number(item.raisedMiles.toFixed(1)),
        loweredMiles: Number(item.loweredMiles.toFixed(1)),
        beforeTiers: [...item.beforeTiers].sort(), afterTiers: [...item.afterTiers].sort(),
        classes: [...item.classes].sort() })),
    costRaisedRoads: [...costNames.values()]
      .filter((item) => item.raised)
      .sort((a, b) => b.raisedMiles - a.raisedMiles).slice(0, 40)
      .map((item) => ({ ...item, miles: Number(item.miles.toFixed(1)),
        raisedMiles: Number(item.raisedMiles.toFixed(1)),
        loweredMiles: Number(item.loweredMiles.toFixed(1)),
        beforeTiers: [...item.beforeTiers].sort(), afterTiers: [...item.afterTiers].sort(),
        classes: [...item.classes].sort() })),
  };
})()`, context);

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
