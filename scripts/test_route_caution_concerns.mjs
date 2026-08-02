#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
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
  functionSource(details, 'isDismountSegment'),
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
  minShoulder: 4,
  inferShoulderFromEdge: false,
};
const cases = [
  [{ level: 3, displayCategory: 'caution', lts: 4, cautionCause: 'high-stress' }, 'high-stress'],
  [{ level: 3, displayCategory: 'caution', lts: 4 }, 'high-stress'],
  [{ level: 3, displayCategory: 'caution', flags: 128, cautionCause: 'limited-access' }, 'limited-access'],
  [{ level: 3, displayCategory: 'caution', official: 16, mph: 45, sh: 0,
    cautionCause: 'sidewalk-fallback' }, 'sidewalk-fallback'],
  [{ level: 1, displayCategory: 'caution', mtb: true }, 'mountain-bike'],
  [{ level: 3, displayCategory: 'caution', cautionCause: 'future-new-cause' }, 'other'],
  [{ level: 3, displayCategory: 'caution' }, 'other'],
];
for (const [segment, expected] of cases) {
  assert.equal(context.cautionConcernKind(segment, rules), expected,
    `amber ${JSON.stringify(segment)} must map to the ${expected} concern group`);
}
assert.equal(context.cautionConcernKind({ level: 2, displayCategory: 'pass' }, rules), null,
  'an ordinary passing segment must not become a concern');

assert.match(worker, /cautionCause:\s*verdict\.caution\s*\|\|\s*null/,
  'the router must retain the exact SafetyModel caution cause');
assert.match(app, /lts:\s*Number\(s\.lts\)\s*\|\|\s*0,\s*cautionCause:\s*routeSegmentCautionCause\(s\)/,
  'Route Details storage must retain stress ratings and caution causes');
for (const contract of [
  'Officially rated high-stress roads',
  'concern-high-stress',
  'Other route cautions',
  'concern-other-cautions',
]) assert.ok(details.includes(contract), `Route Details is missing ${contract}`);

console.log('Every amber route segment maps to a specific or fallback concern item.');
