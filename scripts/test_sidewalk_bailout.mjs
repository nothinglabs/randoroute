#!/usr/bin/env node
// The sidewalk bailout: a failing road you can step off is priced below a
// failing road you cannot, and NOTHING else about it moves.
//
// The properties worth pinning are the ones that make that safe:
//
//   1. It is a credit, never a verdict. Changing the weight must not move a
//      single edge's level -- the whole reason this is not a new rung.
//   2. Tagged sidewalks only. The walked-sidewalk escape accepts Census-urban
//      inference; this must not, or the router steers whole routes onto a
//      sidewalk nobody recorded. "You cannot bail your bike onto an
//      inference" (rider, 2026-08-29).
//   3. The exclusions hold: freeway, ferry, prohibited direction, and any road
//      over the rider's absolute speed cap earn nothing, because a sidewalk
//      does not answer those failures.
//   4. `allowSidewalkFallback: false` turns the whole thing off -- one switch
//      for "sidewalks count", the same one that gates rung 7.
//   5. app.js and router-worker.js agree on the number. Those two weight
//      tables are mirrored by hand, and the facility threshold living at
//      `>= 2` in one file and `> 0` in the other is the documented bug this
//      test exists to prevent recurring.
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import { appDefaultRules, check, checkEqual, done, routerWorker, source } from './testlib/harness.mjs';

/* ---------------------------------------------- 1. the predicate, in isolation */
const context = vm.createContext({
  console, Date, Math, Map, Set, TextDecoder,
  ArrayBuffer, DataView, Float32Array, Float64Array, Int8Array, Int16Array,
  Int32Array, Uint8Array, Uint16Array, Uint32Array,
  postMessage: () => {},
});
context.self = context;
context.importScripts = (...names) => {
  for (const n of names) vm.runInContext(source(n), context);
};
vm.runInContext(source('router-worker.js'), context);

const EDGE_SIDEWALK = vm.runInContext('EDGE_SIDEWALK', context);
const EDGE_URBAN = vm.runInContext('EDGE_URBAN', context);
const PROHIBITED = vm.runInContext('PROHIBITED_SHOULDER', context);

// One edge, dialled per case. Everything the predicate reads and nothing else.
function setEdge({ official = 0, flags = 0, shoulder = 0, speed = 30 }) {
  vm.runInContext(`
    eOfficial = new Uint8Array([${official}]);
    eFlags = new Uint8Array([${flags}]);
    eSh = new Int8Array([${shoulder}]);
    eShBA = new Int8Array([${shoulder}]);
    eSpeed = new Uint8Array([${speed}]);
    eSpeedBA = new Uint8Array([${speed}]);
  `, context);
}
const RULES = { allowSidewalkFallback: true, noUpperLimit: true, upperMaxSpeed: 45 };
function applies(edge = {}, rules = {}, level = 4) {
  setEdge(edge);
  const r = JSON.stringify({ ...RULES, ...rules });
  return vm.runInContext(
    `sidewalkBailoutApplies(0, true, ${r}, ${level}, eFlags[0])`, context);
}

check('tagged sidewalk on a failing road earns the bailout',
  applies({ official: EDGE_SIDEWALK }) === true);
check('an untagged road earns nothing',
  applies({ official: 0 }) === false);
check('urban context alone is NOT a sidewalk -- no bailing onto an inference',
  applies({ official: EDGE_URBAN }) === false);
check('a passing road earns nothing (level 3)',
  applies({ official: EDGE_SIDEWALK }, {}, 3) === false);
check('a caution road earns nothing (level 2)',
  applies({ official: EDGE_SIDEWALK }, {}, 2) === false);
check('a freeway earns nothing',
  applies({ official: EDGE_SIDEWALK, flags: 4 }) === false);
check('a ferry earns nothing',
  applies({ official: EDGE_SIDEWALK, flags: 32 }) === false);
check('a prohibited direction earns nothing',
  applies({ official: EDGE_SIDEWALK, shoulder: PROHIBITED }) === false);
check('a road over the absolute speed cap earns nothing',
  applies({ official: EDGE_SIDEWALK, speed: 55 },
    { noUpperLimit: false, upperMaxSpeed: 45 }) === false);
check('a road under the absolute speed cap still earns it',
  applies({ official: EDGE_SIDEWALK, speed: 40 },
    { noUpperLimit: false, upperMaxSpeed: 45 }) === true);
check('allowSidewalkFallback off turns the whole credit off',
  applies({ official: EDGE_SIDEWALK }, { allowSidewalkFallback: false }) === false);

/* ------------------------------------------- 2. the two weight tables agree */
// Evaluate both tables rather than reading them: a regex over source text would
// pass on a commented-out key and fail on a reformat.
const workerWeight = vm.runInContext('DEFAULT_WEIGHTS.sidewalkBailout', context);
const appSrc = source('app.js');
const start = appSrc.indexOf('const DEFAULT_ROUTING_WEIGHTS = Object.freeze({');
assert.ok(start >= 0, 'app.js still defines DEFAULT_ROUTING_WEIGHTS');
const open = appSrc.indexOf('{', start);
let depth = 0, end = open;
for (; end < appSrc.length; end++) {
  if (appSrc[end] === '{') depth++;
  else if (appSrc[end] === '}' && --depth === 0) break;
}
const appWeights = vm.runInNewContext(`(${appSrc.slice(open, end + 1)})`, {});
checkEqual('app.js carries sidewalkBailout', typeof appWeights.sidewalkBailout, 'number');
checkEqual('both weight tables agree on sidewalkBailout',
  appWeights.sidewalkBailout, workerWeight);
check('the bailout is a discount, not a penalty', workerWeight > 0 && workerWeight < 1);

/* ------------------------------- 3. a credit, never a verdict (real graph) */
const worker = routerWorker();
check('router worker is ready', worker.ready);

// Every edge's level, computed under one weight then the other. A weight that
// can move a verdict is a rung wearing a weight's clothes.
const levelsFor = (weight) => worker.run(`(() => {
  useWeights({ sidewalkBailout: ${weight} });
  const rules = ${JSON.stringify(appDefaultRules())};
  const out = [];
  for (let i = 0; i < Math.min(E, 4000); i++) out.push(edgeLevelFor(i, rules, true));
  return out.join(',');
})()`);
checkEqual('changing the bailout weight moves no verdict',
  levelsFor(0.85), levelsFor(1));

// And it does reach the price: same edge, two weights, cost ratio is the weight.
const ratio = worker.run(`(() => {
  const rules = ${JSON.stringify(appDefaultRules())};
  for (let i = 0; i < E; i++) {
    if (!(eOfficial[i] & ${EDGE_SIDEWALK})) continue;
    if (eFlags[i] & (4 | 32)) continue;
    if (edgeLevelFor(i, rules, true) !== 4) continue;
    const priceAt = (w) => {
      useWeights({ sidewalkBailout: w });
      return edgeCostParts(i, true, 'balanced', modeWeights('balanced'),
        rules, rules, false, false, 0, false);
    };
    const full = priceAt(1), cut = priceAt(0.85);
    if (!(full > 0) || !Number.isFinite(full)) continue;
    return cut / full;
  }
  return null;
})()`);
check('a failing edge with a tagged sidewalk is priced at the bailout weight',
  ratio !== null && Math.abs(ratio - 0.85) < 1e-6, `ratio=${ratio}`);

/* ----------------------- 4. the map's twin answers exactly as the router does */
// segmentSidewalkBailout() in app.js decides the BADGE; sidewalkBailoutApplies()
// in router-worker.js decides the PRICE. A rider seeing a bailout the router did
// not grant (or the reverse) is the "card lies by omission" failure this pins.
// Lifted and evaluated, never regex-matched.
const fnAt = appSrc.indexOf('function segmentSidewalkBailout(');
assert.ok(fnAt >= 0, 'app.js still defines segmentSidewalkBailout');
const fnOpen = appSrc.indexOf('{', fnAt);
let fnDepth = 0, fnEnd = fnOpen;
for (; fnEnd < appSrc.length; fnEnd++) {
  if (appSrc[fnEnd] === '{') fnDepth++;
  else if (appSrc[fnEnd] === '}' && --fnDepth === 0) break;
}
const appBox = { OFFICIAL_SIDEWALK: EDGE_SIDEWALK, rules: { ...RULES } };
vm.createContext(appBox);
vm.runInContext(appSrc.slice(fnAt, fnEnd + 1), appBox);

// mph/official/flags in the map's vocabulary, the same cases as above.
const CASES = [
  ['tagged sidewalk, failing', { official: EDGE_SIDEWALK }, {}],
  ['untagged, failing', { official: 0 }, {}],
  ['urban inference only', { official: EDGE_URBAN }, {}],
  ['freeway', { official: EDGE_SIDEWALK, flags: 4 }, {}],
  ['ferry', { official: EDGE_SIDEWALK, flags: 32 }, {}],
  ['over the cap', { official: EDGE_SIDEWALK, speed: 55 },
    { noUpperLimit: false, upperMaxSpeed: 45 }],
  ['under the cap', { official: EDGE_SIDEWALK, speed: 40 },
    { noUpperLimit: false, upperMaxSpeed: 45 }],
  ['fallback switched off', { official: EDGE_SIDEWALK }, { allowSidewalkFallback: false }],
];
let mirrored = true;
for (const [label, edge, ruleOverrides] of CASES) {
  const router = applies(edge, ruleOverrides);
  Object.assign(appBox.rules, RULES, ruleOverrides);
  const map = appBox.segmentSidewalkBailout({
    official: edge.official || 0,
    ferry: (edge.flags || 0) & 32 ? 1 : 0,
    fw: (edge.flags || 0) & 4 ? 1 : 0,
    mph: edge.speed === undefined ? 30 : edge.speed,
  }, 'fail');
  if (router !== map) {
    mirrored = false;
    check(`map and router agree: ${label}`, false, `router=${router} map=${map}`);
  }
}
check('the map badge and the routing credit answer alike on every case', mirrored);
// A passing segment is never a bailout, whatever it carries.
check('the map draws no bailout on a road that is not failing',
  appBox.segmentSidewalkBailout({ official: EDGE_SIDEWALK, mph: 30 }, 'caution') === false);

done();
