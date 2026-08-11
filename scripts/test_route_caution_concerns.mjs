#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const common = fs.readFileSync(new URL('../route-common.js', import.meta.url), 'utf8');
const details = fs.readFileSync(new URL('../route-details.js', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../router-worker.js', import.meta.url), 'utf8');
const safetyModel = fs.readFileSync(new URL('../safety-model.js', import.meta.url), 'utf8');

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} source was not found`);
  const params = source.indexOf('(', start);
  let parenDepth = 0;
  let paramsEnd = -1;
  for (let index = params; index < source.length; index++) {
    if (source[index] === '(') parenDepth++;
    if (source[index] === ')' && --parenDepth === 0) { paramsEnd = index; break; }
  }
  const brace = source.indexOf('{', paramsEnd);
  let depth = 0;
  for (let index = brace; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`${name} source was incomplete`);
}

const context = {
  window: {},
  ROUTE_CATEGORY_KEYS: ['trail', 'bike', 'pass', 'caution', 'fail'],
  FLAG_FACILITY: 2, FLAG_FREEWAY: 4, FLAG_INFRA: 8, FLAG_FERRY: 32,
  FLAG_DESIGNATED: 64, FLAG_LIMITED_ACCESS: 128,
  OFFICIAL_MTB: 4, OFFICIAL_DISMOUNT: 8, OFFICIAL_SIDEWALK: 16,
  OFFICIAL_SIDEWALK_NO: 32, OFFICIAL_URBAN: 64, PROHIBITED_SHOULDER: -128,
};
context.self = context.window;
vm.createContext(context);
vm.runInContext(safetyModel, context);
vm.runInContext([
  functionSource(details, 'isBikeNetwork'),
  functionSource(details, 'isOffStreetTrail'),
  functionSource(details, 'isMountainBikeTrail'),
  functionSource(common, 'isDismountSegment'),
  functionSource(details, 'activeDetailRules'),
  functionSource(details, 'routeSegmentLevel'),
  functionSource(details, 'routeDisplayCategory'),
  functionSource(details, 'noShoulderMaxSpeed'),
  functionSource(details, 'routeSegmentFacts'),
  functionSource(details, 'isSidewalkFallbackSegment'),
  functionSource(details, 'routeCautionCause'),
  functionSource(details, 'cautionConcernKind'),
].join('\n'), context);

const rules = {
  allowSidewalkFallback: true,
  maxSpeedNoShoulder: 35,
  upperMaxSpeed: 55,
  noUpperLimit: true,
  minShoulder: 4,
  inferShoulderFromEdge: false,
};
const cases = [
  [{ lts: 4, mph: 35, sh: 5 }, 'high-stress'],
  [{ flags: 128, mph: 25, sh: 0 }, 'limited-access'],
  [{ official: 16, mph: 45, sh: 0 }, 'sidewalk-fallback'],
  [{ mtb: true, facility: 5 }, 'mountain-bike'],
  [{ dismount: 1, official: 8 }, 'dismount'],
];
for (const [segment, expected] of cases) {
  assert.equal(context.cautionConcernKind(segment, rules), expected,
    `amber ${JSON.stringify(segment)} must map to the ${expected} concern group`);
}
// A future SafetyModel caution cause must still reach the generic group. Stub
// the model's RESULT for one recognisable fact shape; do not manufacture that
// result by writing stale cached bytes onto the segment.
const evaluate = context.window.SafetyModel.evaluate;
context.window.SafetyModel.evaluate = (facts, liveRules) =>
  facts.speed === 29 ? { level: 3, caution: 'future-new-cause' }
    : evaluate(facts, liveRules);
assert.equal(context.cautionConcernKind({ mph: 29, sh: 4 }, rules), 'other',
  'a genuinely amber future cause must map to the fallback concern group');
context.window.SafetyModel.evaluate = evaluate;

assert.equal(context.cautionConcernKind({ level: 2, displayCategory: 'pass' }, rules), null,
  'an ordinary passing segment must not become a concern');
assert.equal(context.cautionConcernKind({ level: 3, displayCategory: 'caution',
  cautionCause: 'future-new-cause', mph: 20, sh: 0 }, rules), null,
  'cached amber bytes must not turn passing road facts into a concern');

// The router's own segments must carry the cause, not merely the level --
// checked by ROUTING, not by reading the worker's source (which is what this
// used to do, and which broke on a refactor while proving nothing). The dock
// approach at Mukilteo is a real sub-threshold dismount, so the route is
// guaranteed one amber segment whose cause is 'dismount'.
{
  const { routerWorker } = await import('./testlib/harness.mjs');
  const w = routerWorker();
  const reply = w.post({ type: 'route', id: 'cause', mode: 'balanced',
    points: [[-122.3321, 47.6062], [-122.3046, 47.9494]],
    rules: { allowFreeways: true, allowMtbTrails: false, preferPaved: true,
      minShoulder: 4, inferShoulderFromEdge: true, maxSpeedNoShoulder: 35,
      lanesNoShoulderOver: 3, busyNoShoulder: 2, allowSidewalkFallback: true,
      upperMaxSpeed: 45, noUpperLimit: true, requireSafe: false } });
  assert.ok(reply.ok && Array.isArray(reply.segs) && reply.segs.length,
    'the router should produce a segmented route');
  const amber = reply.segs.filter((seg) => seg.level === 3);
  assert.ok(amber.length, 'the dock approach should yield at least one amber segment');
  const uncaused = amber.filter((seg) => !seg.cautionCause);
  assert.equal(uncaused.length, 0,
    `every amber segment must name its cause; missing on: ${
      uncaused.slice(0, 3).map((seg) => seg.name || '(unnamed)').join(', ')}`);
  assert.ok(amber.some((seg) => seg.cautionCause === 'dismount'),
    'the dock approach dismount must be an amber segment with the dismount cause');
}
for (const contract of [
  'Officially rated high-stress roads',
  'concern-high-stress',
  'Other route cautions',
  'concern-other-cautions',
]) assert.ok(details.includes(contract), `Route Details is missing ${contract}`);

console.log('Every amber route segment maps to a specific or fallback concern item.');
