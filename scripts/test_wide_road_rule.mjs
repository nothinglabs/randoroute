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
const model = fs.readFileSync(new URL('../safety-model.js', import.meta.url), 'utf8');

/* ------------------------------------------------- the threshold is exclusive */
// The setting reads "Lanes of traffic more than X", so X is the widest road
// that still passes. It used to read "at X and above it fails", which put a
// different number on screen for the same roads.
assert.match(model, /return lanes > over;/,
  'the setting is the widest road that PASSES, matching how it is worded');
assert.doesNotMatch(model, /Math\.ceil\(rules\.lanesNoShoulderOver/,
  'lanes are counted as tagged; there is no oneway adjustment');

/* ------------------------- lanes are one trigger of a single needs-space rung */
// Speed, lanes and traffic all answer the same question -- how much of this
// lane is available to a rider -- so they are one rung with three triggers
// rather than three rungs in an order that mattered.
assert.match(model, /function needsSpace\(facts, rules\) \{\s*return speedNeedsSpace\(facts, rules\) \|\| lanesNeedSpace\(facts, rules\)\s*\|\| trafficNeedsSpace\(facts, rules\);/,
  'the three triggers are ORed into one rule');
assert.match(model, /if \(needsSpace\(facts, rules\)\) \{[\s\S]*?return out\(4, 'needs-space'\);/,
  'breaking it fails like every other rule, and never softens to a caution');
// There is NO exception. A signed route across a wide road used to override this
// failure, on the theory that an agency had vetted the corridor. Clallam's
// Olympic Discovery Trail then turned out to run 58.8 miles along ordinary road,
// including US 101 at 60 mph with no shoulder, and the override was removed.
assert.doesNotMatch(model, /trusted/,
  'no designation may excuse a road that is too wide to share');
assert.doesNotMatch(model, /vettedBikeRoutes|vettedCountyRoutes/,
  'the route-trust settings are gone and must not return');
// Merging the rungs removed the ordering problem outright: there is no longer a
// slow-road rung that a wide road could reach and pass on.
assert.doesNotMatch(model, /'slow-road'/,
  'the slow-road rung is gone; speed is a trigger of needs-space now');

/* ------------------------------------------------- the map expression agrees */
assert.match(app, /const tooWide = rules\.lanesNoShoulderOver >= MAX_LANES_NO_LIMIT[\s\S]*?\['>', \['coalesce', \['get', 'ln'\], 0\], rules\.lanesNoShoulderOver\]/,
  'roadLevelExpr should use the same exclusive threshold');
assert.match(app, /const wantsSpace = \['any', tooFast, tooWide, tooBusy\];/,
  'and OR the same three triggers');

/* --------------------------------------------------- a sharrow is not space */
assert.match(model, /function hasRidingSpace\(facts, shoulder, rules\) \{[\s\S]*?FACILITY_RIDING_SPACE/,
  'only a bike lane or better, or a real shoulder, satisfies the rule');
assert.match(model, /var FACILITY_RIDING_SPACE = 2;/,
  'a sharrow (facility 1) must sit below the riding-space threshold');

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
context.importScripts = (...names) => {
  // The worker loads the shared verdict model with importScripts(); mirror that
  // here so a test context is the same environment the browser gives it.
  for (const n of names) {
    vm.runInContext(fs.readFileSync(new URL(`../${n}`, import.meta.url), 'utf8'), context);
  }
};
vm.runInContext(worker, context);
const buffer = graph.byteOffset === 0 && graph.byteLength === graph.buffer.byteLength
  ? graph.buffer : graph.buffer.slice(graph.byteOffset, graph.byteOffset + graph.byteLength);
context.onmessage({ data: { type: 'graph', buffer } });
assert.equal(messages.at(-1)?.type, 'ready', 'the production graph should load');

const out = vm.runInContext(`(() => {
  const rules = {
    allowFreeways: true, allowMtbTrails: false,
    minShoulder: 4, unknownShoulderZero: true, maxSpeedNoShoulder: 35,
    upperMaxSpeed: 45, noUpperLimit: true,
    requireSafe: false, allowSidewalkFallback: true,
    // "more lanes than 3", i.e. 4 and up. Traffic held off throughout: this
    // test isolates the lane trigger, and a busy road failing for its volume
    // would be counted as a lane failure.
    lanesNoShoulderOver: 3, busyNoShoulder: 0,
  };
  const off = { ...rules, lanesNoShoulderOver: 6 };   // slider at "No limit"
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
  'nothing at or under the threshold may fail: 3 lanes is not more than 3');
assert.ok(out.exemptedByFacility > 0 && out.exemptedByShoulder > 0,
  'both exemptions should still be reachable on real data');
assert.ok(out.sidewalkRescued > 0,
  'wide roads with sidewalks exist, and this rule fails them anyway (no sidewalk reprieve)');

console.log(`Wide-road rule tests passed (${out.failedOn.toLocaleString()} edges newly failing, `
  + `${out.sidewalkRescued.toLocaleString()} of them with a mapped sidewalk).`);
