#!/usr/bin/env node
// The lane rule ("Lanes needing a shoulder or bike lane") is implemented four
// times: the tap-card ladder, the map expression, the route-segment scorer, and
// the router's edgeLevel. Only the last one can exclude an edge under
// requireSafe, so a rule that lives in the first three changes what a rider is
// told and nothing about where they are sent. This test pins all four to the
// same threshold, the same exemptions, and the same verdict.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../router-worker.js', import.meta.url), 'utf8');

/* ---------------------------------------------- the threshold is inclusive */
assert.match(app, /function wideRoadNeedsSpace\(n, sh\) \{[\s\S]*?lanes >= rules\.maxLanesNoShoulder && !hasRidingSpace\(n, sh\)/,
  'the setting is the lane count that FAILS, not the widest road allowed');
assert.doesNotMatch(app, /function wideRoadNeedsSpace\(n, sh\) \{[\s\S]*?Math\.ceil\(rules\.maxLanesNoShoulder/,
  'lanes are counted as tagged; there is no oneway adjustment');
assert.match(app, /if \(wideRoadNeedsSpace\(n, sh\)\) return 4;/,
  'breaking the lane rule fails like every other rule, and never softens to a caution');

/* ------------------------------------------- it precedes the slow-road rule */
const ladder = app.slice(app.indexOf('function effectiveLevel'), app.indexOf('function roadLevelExpr'));
assert.ok(ladder.indexOf('wideRoadNeedsSpace') < ladder.indexOf('spd <= noShoulderMax'),
  'a road too wide to share must fail before 25 mph signage can pass it');

/* ------------------------------------------------- the map expression agrees */
assert.match(app, /cases\.push\(\['all',\s*\['>=', \['coalesce', \['get', 'ln'\], 0\], rules\.maxLanesNoShoulder\][\s\S]*?\], 4\);/,
  'roadLevelExpr should use the same inclusive threshold and the same verdict');

/* --------------------------------------------- the route-segment scorer too */
assert.match(app, /\(s\.lanes \|\| 0\) >= rules\.maxLanesNoShoulder\s*&&\s*\(s\.facility \|\| 0\) < 2 && !\(s\.sh >= rules\.minShoulder\)\) return 4;/,
  'route segments should reach the same verdict as the road they lie on');

/* --------------------------------------------------- a sharrow is not space */
assert.match(app, /function hasRidingSpace\(n, sh\) \{\s*return !!n\.good_facility \|\| \(sh != null && sh >= rules\.minShoulder\);/,
  'only a bike lane or better, or a real shoulder, satisfies the rule');

/* --------------------------------------- and the turn lane is not re-counted */
assert.doesNotMatch(app, /\$\{p\.ctl \? ' \+ centre turn lane'/,
  'OSM lanes already includes the centre turn lane; the card must not add it again');
assert.equal((app.match(/, incl\. centre turn lane/g) || []).length, 2,
  'both the route card and the street card should describe the turn lane the same way');

/* ------------------------------------------ the router enforces it for real */
const graph = zlib.gunzipSync(fs.readFileSync(new URL('../data/graph2.bin.gz', import.meta.url)));
const messages = [];
const context = vm.createContext({
  Date, Math, Map, Set, TextDecoder,
  ArrayBuffer, DataView, Float32Array, Float64Array, Int8Array, Int16Array,
  Int32Array, Uint8Array, Uint16Array, Uint32Array,
  postMessage(message) { messages.push(message); },
});
vm.runInContext(worker, context);
const buffer = graph.byteOffset === 0 && graph.byteLength === graph.buffer.byteLength
  ? graph.buffer : graph.buffer.slice(graph.byteOffset, graph.byteOffset + graph.byteLength);
context.onmessage({ data: { type: 'graph', buffer } });
assert.equal(messages.at(-1)?.type, 'ready', 'the production graph should load');

const out = vm.runInContext(`(() => {
  const rules = {
    allowFreeways: true, allowMtbTrails: false, vettedBikeRoutes: true,
    minShoulder: 4, unknownShoulderZero: true, urbanMaxSpeedNoShoulder: 30,
    ruralMaxSpeedNoShoulder: 35, upperMaxSpeed: 45, noUpperLimit: true,
    requireSafe: false, allowSidewalkFallback: true, maxLanesNoShoulder: 4,
  };
  const off = { ...rules, maxLanesNoShoulder: 6 };   // slider at "No limit"
  // Every edge the rule can reach: lane-tagged, no bike lane, no shoulder.
  let failedOn = 0, failedOff = 0, exemptedByFacility = 0, exemptedByShoulder = 0;
  let threeLaneFailures = 0, sidewalkRescued = 0;
  for (let i = 0; i < E; i++) {
    const lanes = eLanes[i] & 63;
    if (!lanes) continue;
    const on = edgeLevel(i, rules, true) === 4;
    const was = edgeLevel(i, off, true) === 4;
    if (on && !was) {
      failedOn++;
      if (lanes < 4) threeLaneFailures++;
      if (eOfficial[i] & 16) sidewalkRescued++;
    }
    if (was) failedOff++;
    if (lanes >= 4 && eFacility[i] >= 2) exemptedByFacility++;
    if (lanes >= 4 && eFacility[i] < 2 && eSh[i] >= 4) exemptedByShoulder++;
  }
  return { failedOn, failedOff, threeLaneFailures, sidewalkRescued,
           exemptedByFacility, exemptedByShoulder };
})()`, context);

assert.ok(out.failedOn > 10000,
  `the router should newly fail the wide roads the map fails, got ${out.failedOn}`);
assert.equal(out.threeLaneFailures, 0,
  'nothing under the threshold may fail: a 3-lane road is not caught at a setting of 4');
assert.ok(out.exemptedByFacility > 0 && out.exemptedByShoulder > 0,
  'both exemptions should still be reachable on real data');
assert.ok(out.sidewalkRescued > 0,
  'wide roads with sidewalks exist, and this rule fails them anyway (no sidewalk reprieve)');

console.log(`Wide-road rule tests passed (${out.failedOn.toLocaleString()} edges newly failing, `
  + `${out.sidewalkRescued.toLocaleString()} of them with a mapped sidewalk).`);
