#!/usr/bin/env node
// The road card and the route-segment card describe the same street. They used
// to reach the safety model down two hand-written paths -- factsOf(scorer(p))
// for a tapped road, routeSegFacts(s) for a route segment -- and those paths
// disagreed on `prohibited`, `infraScore` and the good_facility bump. That is
// the drift that produced "the card says fail, the map says pass".
//
// There is now one path: routeSegProps unpacks a worker segment, scoreRouteSeg
// normalises it, factsOf adapts it. This test pins that, and checks a worker
// segment and the equivalent road tile land on the same verdict.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const here = (p) => new URL(p, import.meta.url);
const modelSrc = fs.readFileSync(here('../safety-model.js'), 'utf8');
const appSrc = fs.readFileSync(here('../app.js'), 'utf8');

const sandbox = { self: {} };
vm.createContext(sandbox);
vm.runInContext(modelSrc, sandbox);
const SafetyModel = sandbox.self.SafetyModel;

/* --------------------------------------------- lift the pieces out of app.js */
// app.js is a browser bundle; pull the pure functions and evaluate them against
// the real safety model rather than a copy.
function lift(name) {
  const re = new RegExp(`\\nfunction ${name}\\s*\\([^)]*\\)\\s*\\{`);
  const at = appSrc.search(re);
  assert.notEqual(at, -1, `app.js should define ${name}`);
  let i = appSrc.indexOf('{', at), depth = 0;
  for (let j = i; j < appSrc.length; j++) {
    if (appSrc[j] === '{') depth++;
    else if (appSrc[j] === '}' && --depth === 0) return appSrc.slice(at + 1, j + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const OFFICIAL = /const OFFICIAL_[A-Z_]+ = [^;]+;/g;
const officials = appSrc.match(OFFICIAL) || [];
assert.ok(officials.length >= 3, 'app.js should define the OFFICIAL_* bit constants');

const ctx = { self: {}, SafetyModel, rules: {} };
vm.createContext(ctx);
// `const` at a vm context's top level is lexical and never lands on the context
// object, so re-declare as `var` to be able to read the bit values back out.
vm.runInContext(officials.join('\n').replace(/\bconst /g, 'var '), ctx);
vm.runInContext([
  lift('factsOf'), lift('scoreRoad'), lift('scoreRouteSeg'), lift('routeSegProps'),
  lift('tileMeasures'),
  'function isDismountSegment(s) { return false; }',
  'function evaluateRoad(n) { return SafetyModel.evaluate(factsOf(n), rules); }',
  'function effectiveLevel(n) { return evaluateRoad(n).level; }',
  lift('fallbackRouteLevel'),
].join('\n'), ctx);

const DEFAULTS = (() => {
  const at = appSrc.indexOf('const DEFAULT_RULES');
  assert.notEqual(at, -1, 'app.js should define DEFAULT_RULES');
  const end = appSrc.indexOf('\n});', at);
  assert.notEqual(end, -1, 'DEFAULT_RULES should be an Object.freeze({...}) literal');
  const box = { out: null };
  vm.createContext(box);
  vm.runInContext(appSrc.slice(at, end + 4).replace('const DEFAULT_RULES', 'out'), box);
  return box.out;
})();

/* ------------------------------- one worker segment, scored both ways */
// A worker segment carries a `flags` bitfield; the map's tap layer carries the
// same facts unpacked. routeSegProps is the only place that conversion happens.
const FLAG = { est: 1, facility: 2, freeway: 4, infra: 8, oneway: 16, ferry: 32,
  designated: 64, limitedAccess: 128 };

function seg(over = {}) {
  return { name: 'Test Rd', mph: 45, sh: -1, lenM: 300, flags: 0,
    lanes: 2, lts: 0, facility: 0, official: 0, surface: 0, roadClass: 0, ...over };
}

// The same road expressed as a roads-tile feature. Keys per build_roads.py.
function tile(over = {}) {
  return { n: 'Test Rd', s: 45, w: null, ln: 2, ft: null, u: 0, ...over };
}

let checks = 0;
function bothAgree(label, s, t) {
  Object.assign(ctx.rules, DEFAULTS);
  const viaRoute = ctx.fallbackRouteLevel(s);
  const viaRoad = ctx.effectiveLevel(ctx.scoreRoad(t));
  assert.equal(viaRoute, viaRoad,
    `${label}: route card said ${viaRoute}, road card said ${viaRoad}`);
  checks++;
  return viaRoute;
}

const urban = (1 << 6); // OFFICIAL_URBAN
assert.equal(ctx.OFFICIAL_URBAN, urban, 'OFFICIAL_URBAN should be bit 64');

const lvl45 = bothAgree('45 mph, unknown shoulder, rural',
  seg(), tile());
assert.equal(lvl45, 4, '45 mph with no known shoulder should fail by default');

bothAgree('25 mph rural', seg({ mph: 25 }), tile({ s: 25 }));
bothAgree('25 mph urban',
  seg({ mph: 25, official: urban }), tile({ s: 25, u: 1 }));
bothAgree('45 mph with a 6 ft shoulder', seg({ sh: 6 }), tile({ w: 6 }));
bothAgree('45 mph with a 1 ft shoulder', seg({ sh: 1 }), tile({ w: 1 }));
bothAgree('bike lane at 45 mph',
  seg({ facility: 2 }), tile({ ft: 2 }));
bothAgree('sharrow is not space of your own',
  seg({ facility: 1 }), tile({ ft: 1 }));
bothAgree('freeway', seg({ flags: FLAG.freeway }), tile({ m: 1 }));
bothAgree('four lanes, no shoulder',
  seg({ lanes: 4 }), tile({ ln: 4 }));
bothAgree('WSDOT traffic stress 3',
  seg({ lts: 3, sh: 5 }), tile({ lts: 3, w: 5 }));

/* ------------------------------------- a ferry is a ferry on both paths */
// scoreRouteSeg did not carry `ferry` when the two adapters were merged; the
// old routeSegFacts read it straight from the flags. Without it a ferry leg is
// judged as an ordinary road with no shoulder.
Object.assign(ctx.rules, DEFAULTS);
const ferryLevel = ctx.fallbackRouteLevel(seg({ flags: FLAG.ferry, mph: null }));
const ferryVerdict = SafetyModel.evaluate(
  ctx.factsOf(ctx.scoreRouteSeg(ctx.routeSegProps(seg({ flags: FLAG.ferry, mph: null })))),
  DEFAULTS);
assert.equal(ferryVerdict.rule, 'ferry',
  `a ferry leg should reach the ferry rung, got "${ferryVerdict.rule}"`);
assert.equal(ferryLevel, ferryVerdict.level, 'ferry level should come from that rung');
console.log(`PASS  ferry legs reach the ferry rung (level ${ferryLevel})`);

/* --------------------------- the unpacked feature is what the card scores */
// drawRoute bakes `level` into the tap feature and the card recomputes it from
// the same properties. If those two used different inputs the card could
// contradict the line the rider is looking at.
for (const s of [seg(), seg({ mph: 25 }), seg({ facility: 2 }), seg({ sh: 6 }),
  seg({ flags: FLAG.infra, facility: 5 })]) {
  const props = ctx.routeSegProps(s, 0);
  const baked = ctx.effectiveLevel(ctx.scoreRouteSeg(props));
  const recomputed = ctx.fallbackRouteLevel(s);
  assert.equal(baked, recomputed,
    'the level baked into the route feature should equal the level the card recomputes');
  checks++;
}
console.log('PASS  the baked route level equals what the card recomputes');

/* ------------------------------------------------- no second adapter exists */
assert.doesNotMatch(appSrc, /function routeSegFacts\b/,
  'routeSegFacts was the duplicate adapter; it must not come back');
const unpackCount = (appSrc.match(/flags & 32 \? 1 : 0/g) || []).length;
assert.equal(unpackCount, 1,
  `the worker flags should be unpacked in exactly one place, found ${unpackCount}`);
console.log('PASS  exactly one adapter from a route segment to the safety model');

console.log(`\n${checks} agreement checks, 0 failed`);
