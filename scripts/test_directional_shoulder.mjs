#!/usr/bin/env node
// A shoulder can depend on which way you are riding, and the app must not
// pretend otherwise.
//
// WSDOT surveys each direction of a state highway separately, and the two
// genuinely disagree. On SR 104 at Kingston the same point carries 0 ft one way
// and 5-6 ft the other; across 56 segments there the values are 0 ft x20,
// 6 ft x21, 5 ft x9. Statewide on the shipped graph:
//
//     shoulder differs by direction     58,995 edges
//     VERDICT differs by direction      10,656 edges  (333 mi)
//     passes one way, FAILS the other    2,564 edges  (45 mi)
//
// Two separate obligations, and they were in different states:
//
//   * The ROUTE was already right. router-worker.js scores each segment with
//     edgeFacts(edge, forward) and carries edgeShoulder(edge, forward), so a
//     drawn route has always reflected the direction of travel. This file pins
//     that, because it is easy to "simplify" away and nothing else would notice.
//   * The CARD was wrong. It printed whichever of the two WSDOT features the tap
//     landed on, with nothing indicating a second answer existed -- which is how
//     a road could read "Shoulder 0 ft / Passes your rules" while the router
//     used 6 ft for the way you were actually going.
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';

const ROOT = new URL('..', import.meta.url).pathname;
const appSrc = fs.readFileSync(ROOT + 'app.js', 'utf8');
const workerSrc = fs.readFileSync(ROOT + 'router-worker.js', 'utf8');

/* ---- 1. the router scores in the direction of travel ------------------- */
// Structural: the seg loop must pass `forward` into every directional reader.
// A refactor that dropped it would silently make every route worst-case.
const segLoop = workerSrc.slice(workerSrc.indexOf('let hazardM = 0;'),
  workerSrc.indexOf('desigM, residentialM, freewayM'));
for (const call of ['edgeLevel(ei, rules, forward)', 'edgeShoulder(ei, forward)',
  'edgeSpeed(ei, forward)']) {
  assert.ok(segLoop.includes(call),
    `the route segment loop must call ${call}; without the direction a route is `
    + 'scored worst-case and stops matching the way you are riding');
}

/* ---- 2. and it actually produces different answers on real edges ------- */
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
  assert.ok(box.out.minShoulder != null, 'DEFAULT_RULES lift failed');
  return box.out;
}
const rules = liftRules();

const graph = zlib.gunzipSync(fs.readFileSync(ROOT + 'data/graph2.bin.gz'));
const wctx = vm.createContext({ console, Date, Math, Map, Set, TextDecoder,
  ArrayBuffer, DataView, Float32Array, Float64Array, Int8Array, Int16Array,
  Int32Array, Uint8Array, Uint16Array, Uint32Array, postMessage: () => {} });
wctx.importScripts = (...names) => {
  for (const n of names) vm.runInContext(fs.readFileSync(ROOT + n, 'utf8'), wctx);
};
wctx.self = wctx;
vm.runInContext(workerSrc, wctx);
const buf = graph.buffer.slice(graph.byteOffset, graph.byteOffset + graph.byteLength);
wctx.onmessage({ data: { type: 'graph', buffer: buf } });
wctx.RULES_JSON = JSON.stringify(rules);

const split = vm.runInContext(`(function(){
  const R = JSON.parse(RULES_JSON);
  let shoulderDiffers = 0, verdictDiffers = 0, passOneWayFailOther = 0;
  for (let i = 0; i < eA.length; i++) {
    const ab = edgeFacts(i, true), ba = edgeFacts(i, false);
    if (ab.shoulder !== ba.shoulder) shoulderDiffers++;
    const la = SafetyModel.level(ab, R), lb = SafetyModel.level(ba, R);
    if (la !== lb) verdictDiffers++;
    if ((la <= 2 && lb === 4) || (lb <= 2 && la === 4)) passOneWayFailOther++;
  }
  return { shoulderDiffers, verdictDiffers, passOneWayFailOther, edges: eA.length };
})()`, wctx);

assert.ok(split.shoulderDiffers > 1000,
  `only ${split.shoulderDiffers} edges have a direction-dependent shoulder; the `
  + 'WSDOT directional match may have stopped working');
assert.ok(split.passOneWayFailOther > 100,
  `only ${split.passOneWayFailOther} edges pass one way and fail the other; if this `
  + 'collapsed to zero the directional data is no longer reaching the verdict');
console.log(`  ${split.shoulderDiffers.toLocaleString()} of ${split.edges.toLocaleString()} edges`
  + ` differ by direction; ${split.verdictDiffers.toLocaleString()} change verdict,`
  + ` ${split.passOneWayFailOther.toLocaleString()} flip pass/fail`);

/* ---- 3. the card names both directions when they disagree -------------- */
const box = vm.createContext({});
function lift(startMarker, endMarker) {
  const i = appSrc.indexOf(startMarker);
  assert.notStrictEqual(i, -1, `app.js no longer contains ${startMarker}`);
  return appSrc.slice(i, appSrc.indexOf(endMarker, i));
}
// Stub the map: the helper only needs queryRenderedFeatures and getLayer.
let siblings = [];
vm.runInContext([
  'var map = { getLayer: () => true, queryRenderedFeatures: () => globalThis.SIBS };',
  lift('function wsdotDirectionLabel', '\nfunction renderReadout'),
  'globalThis.OUT = { wsdotShoulderText, wsdotDirectionLabel, wsdotRouteBase };',
].join('\n'), box);
const { wsdotShoulderText, wsdotDirectionLabel, wsdotRouteBase } = box.OUT;
const setSibs = (list) => { box.SIBS = list.map((properties) => ({ properties })); };

assert.strictEqual(wsdotRouteBase('104i'), '104');
assert.strictEqual(wsdotRouteBase('104d'), '104');
assert.strictEqual(wsdotDirectionLabel('104i'), 'increasing mileposts');
assert.strictEqual(wsdotDirectionLabel('104d'), 'decreasing mileposts');

const point = { x: 100, y: 100 };
// No sibling: one plain number, exactly as before.
setSibs([]);
assert.strictEqual(wsdotShoulderText(point, { RouteIdentifier: '104i', ShoulderWidth: 6 }),
  '6 ft', 'with no opposite segment the card should read as it always did');
// Sibling that agrees: still one number, no noise.
setSibs([{ RouteIdentifier: '104d', ShoulderWidth: 6 }]);
assert.strictEqual(wsdotShoulderText(point, { RouteIdentifier: '104i', ShoulderWidth: 6 }),
  '6 ft', 'agreeing directions must not be spelled out twice');
// Sibling that disagrees: BOTH, each named. This is the Kingston case.
setSibs([{ RouteIdentifier: '104d', ShoulderWidth: 0 }]);
const both = wsdotShoulderText(point, { RouteIdentifier: '104i', ShoulderWidth: 6 });
assert.match(both, /6 ft/, 'the tapped direction must still be shown');
assert.match(both, /0 ft/, 'the opposite direction must be shown too');
assert.match(both, /increasing mileposts/);
assert.match(both, /decreasing mileposts/);
// A different route at the same point is not the other half of this one.
setSibs([{ RouteIdentifier: '305i', ShoulderWidth: 0 }]);
assert.strictEqual(wsdotShoulderText(point, { RouteIdentifier: '104i', ShoulderWidth: 6 }),
  '6 ft', 'a different highway crossing here is not the opposite direction');
// A sibling on the same route whose id carries no direction suffix: report both,
// but do not invent a direction name for the one that has none.
setSibs([{ RouteIdentifier: '104', ShoulderWidth: 0 }]);
const unnamed = wsdotShoulderText(point, { RouteIdentifier: '104i', ShoulderWidth: 6 });
assert.match(unnamed, /6 ft/);
assert.match(unnamed, /0 ft/);
assert.doesNotMatch(unnamed, /mileposts/,
  'do not claim a direction the route id does not encode');
// An unrelated suffix is not a direction, so it is not the other half either.
setSibs([{ RouteIdentifier: '104', ShoulderWidth: 0 }]);
assert.strictEqual(wsdotShoulderText(point, { RouteIdentifier: '104x', ShoulderWidth: 6 }),
  '6 ft', '104x is a different route id, not the opposite direction of 104');
// Nothing recorded stays nothing.
setSibs([{ RouteIdentifier: '104d', ShoulderWidth: 5 }]);
assert.strictEqual(wsdotShoulderText(point, { RouteIdentifier: '104i', ShoulderWidth: null }),
  null, 'an unrecorded shoulder must not be invented from the other direction');

/* ---- 4. the real WSDOT data still carries both directions -------------- */
const blts = JSON.parse(zlib.gunzipSync(fs.readFileSync(ROOT + 'data/blts.geojson.gz')));
const byBase = new Map();
for (const f of blts.features) {
  const id = String(f.properties.RouteIdentifier || '');
  const base = id.replace(/[id]$/i, '');
  if (!base || base === id) continue;
  (byBase.get(base) || byBase.set(base, new Set()).get(base)).add(id);
}
const twoWay = [...byBase.values()].filter((s) => s.size > 1).length;
assert.ok(twoWay > 50,
  `only ${twoWay} routes carry both an i and a d segment; the direction suffix `
  + 'convention this card relies on may have changed');
console.log(`  ${twoWay} WSDOT routes carry both directions`);

console.log('ok - the route rides its own direction, and the card says when they differ');
