#!/usr/bin/env node
// Hill Taunt: light mockery on real climbs, and only there. Lifts the shipped
// climb-run builder and speaker from app.js and drives them with a stub
// turnNav, so the assertions cover exactly what a ride would hear: nothing on
// flats or blips, one line at most every five minutes, at most two per route,
// nothing when the option is off, and lines that stay in the approved set.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appSrc = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const commonSrc = fs.readFileSync(new URL('../route-common.js', import.meta.url), 'utf8');

function lift(src, name) {
  const re = new RegExp(`\\nfunction ${name}\\s*\\([^)]*\\)\\s*\\{`);
  const at = src.search(re);
  assert.notEqual(at, -1, `should define ${name}`);
  let depth = 0;
  for (let j = src.indexOf('{', at); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(at + 1, j + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function constOf(src, name) {
  const m = new RegExp(`const ${name} = ([^;]+);`).exec(src);
  assert.ok(m, `expected const ${name}`);
  return `var ${name} = ${m[1]};`;
}

const spoken = [];
let clock = 1_000_000;
const context = {
  Object, Math, Number, JSON, Date: { now: () => clock },
  navVoice: { hillTaunt: true },
  turnNav: { arrived: false, routeM: 0, route: null, hillTauntCount: 0, hillTauntAt: 0 },
  speakNavigation: (text, kind) => spoken.push({ text, kind }),
};
vm.createContext(context);
const lines = /const HILL_TAUNT_LINES = Object\.freeze\(\[[\s\S]*?\]\);/.exec(appSrc);
assert.ok(lines, 'expected the taunt line list');
vm.runInContext([
  constOf(commonSrc, 'MIN_REPORTED_GRADE_M'),
  constOf(commonSrc, 'MAX_CREDIBLE_GRADE_PCT'),
  lift(commonSrc, 'credibleSegmentGradePct'),
  constOf(appSrc, 'HILL_TAUNT_GRADE_PCT'),
  constOf(appSrc, 'HILL_TAUNT_MIN_RUN_M'),
  constOf(appSrc, 'HILL_TAUNT_MERGE_GAP_M'),
  constOf(appSrc, 'HILL_TAUNT_MIN_INTO_M'),
  constOf(appSrc, 'HILL_TAUNT_MIN_LEFT_M'),
  constOf(appSrc, 'HILL_TAUNT_COOLDOWN_MS'),
  constOf(appSrc, 'HILL_TAUNT_MAX_PER_ROUTE'),
  lines[0].replace('const ', 'var '),
  lift(appSrc, 'buildRouteClimbRuns'),
  lift(appSrc, 'maybeSpeakHillTaunt'),
].join('\n'), context);

// One helper route: coordinate index === metre, one seg per stretch.
function routeOf(stretches) {
  const segs = [];
  const cumulative = [0];
  let at = 0, c = 0;
  for (const [lenM, gradePct, flags] of stretches) {
    cumulative.push(at + lenM);
    segs.push({ c0: c, c1: c + 1, lenM, gradePct, flags: flags || 0 });
    at += lenM;
    c += 1;
  }
  return { segs, cumulative: Object.assign(cumulative, {}) };
}
const runsOf = (stretches) => {
  const { segs, cumulative } = routeOf(stretches);
  context.__segs = segs;
  context.__cum = cumulative;
  // Through JSON: vm results live in another realm, whose Array prototype
  // fails deepStrictEqual against this one's.
  return JSON.parse(vm.runInContext('JSON.stringify(buildRouteClimbRuns(__segs, __cum))', context));
};

// Climb-run construction.
assert.deepEqual(runsOf([[500, 1]]), [], 'a flat route has no climbs');
assert.deepEqual(runsOf([[100, 8]]), [], 'a 100 m ramp is a blip, not a hill');
assert.deepEqual(runsOf([[300, 8]]), [{ startM: 0, endM: 300, taunted: false }],
  'a 300 m 8% stretch is a hill');
assert.deepEqual(runsOf([[400, 2], [250, 7], [50, 1], [200, 9], [300, 1]]),
  [{ startM: 400, endM: 900, taunted: false }],
  'a short easier interruption keeps one hill whole');
assert.deepEqual(runsOf([[300, 8], [500, 1], [300, 8]]),
  [{ startM: 0, endM: 300, taunted: false }, { startM: 800, endM: 1100, taunted: false }],
  'a long flat splits two hills');
assert.deepEqual(runsOf([[300, -8]]), [], 'descending 8% is not a climb');
assert.deepEqual(runsOf([[300, 8, 32]]), [], 'a ferry cannot be a hill');

// Speaking contract, on a route with three real hills.
const speak = () => vm.runInContext('maybeSpeakHillTaunt()', context);
const ride = routeOf([[1000, 1], [400, 8], [2000, 1], [400, 9], [2000, 1], [400, 8]]);
context.turnNav.route = { climbRuns: (() => {
  context.__segs = ride.segs; context.__cum = ride.cumulative;
  return vm.runInContext('buildRouteClimbRuns(__segs, __cum)', context);
})() };
assert.equal(context.turnNav.route.climbRuns.length, 3, 'three hills on the ride');

context.turnNav.routeM = 500;
assert.equal(speak(), false, 'no taunt on the flat approach');
context.turnNav.routeM = 1020;
assert.equal(speak(), false, 'no taunt in the first metres of the hill');
context.turnNav.routeM = 1200;
assert.equal(speak(), true, 'mid-hill earns the taunt');
assert.equal(spoken.length, 1);
assert.equal(spoken[0].kind, 'status', 'a taunt never outranks guidance');
assert.ok(vm.runInContext('HILL_TAUNT_LINES', context).includes(spoken[0].text),
  'the line comes from the approved list');
assert.equal(speak(), false, 'the same hill never taunts twice');

context.turnNav.routeM = 3600; // well inside hill two
clock += 2 * 60_000;
assert.equal(speak(), false, 'two minutes later is inside the cooldown');
clock += 4 * 60_000;
assert.equal(speak(), true, 'past the cooldown the next hill taunts');
assert.equal(spoken.length, 2);

context.turnNav.routeM = 6000; // well inside hill three
clock += 10 * 60_000;
assert.equal(speak(), false, 'two per route is the ceiling');

context.turnNav.hillTauntCount = 0;
context.navVoice.hillTaunt = false;
assert.equal(speak(), false, 'switched off means silent');
context.navVoice.hillTaunt = true;
context.turnNav.arrived = true;
assert.equal(speak(), false, 'no taunting a rider who has arrived');

// Copy stays light: no crude vocabulary in any line.
for (const line of vm.runInContext('HILL_TAUNT_LINES', context)) {
  assert.ok(!/damn|hell\b|stupid|idiot|sucker|loser|fat|slow\b/i.test(line),
    `line stays light: ${line}`);
}

console.log('hill taunt: all checks passed');
