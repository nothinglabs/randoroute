#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const details = fs.readFileSync(new URL('../route-details.js', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../router-worker.js', import.meta.url), 'utf8');
const safetyModel = fs.readFileSync(new URL('../safety-model.js', import.meta.url), 'utf8');
const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const help = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

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
  FLAG_FREEWAY: 4, FLAG_INFRA: 8, FLAG_FERRY: 32, FLAG_LIMITED_ACCESS: 128,
  OFFICIAL_SIDEWALK: 16, OFFICIAL_SIDEWALK_NO: 32, OFFICIAL_URBAN: 64,
  PROHIBITED_SHOULDER: -128,
  FACILITY_NAME: {}, ROAD_CLASS_NAME: {},
};
context.self = context.window;
vm.createContext(context);
vm.runInContext(safetyModel, context);
vm.runInContext([
  functionSource(details, 'noShoulderMaxSpeed'),
  functionSource(details, 'routeSegmentFacts'),
  functionSource(details, 'failReason'),
  functionSource(details, 'failedRoadDetails'),
].join('\n'), context);

const rules = {
  maxSpeedNoShoulder: 35, minShoulder: 4, inferShoulderFromEdge: false,
  lanesNoShoulderOver: 6, busyNoShoulder: 0,
  noUpperLimit: true, upperMaxSpeed: 45,
};
const road = { name: 'Example Road', mph: 45, sh: 0, flags: 0, facility: 0,
  official: 0, lanes: 2, measures: null };
const outside = context.failedRoadDetails(road, rules);
const inside = context.failedRoadDetails({ ...road, official: 64 }, rules);
assert.deepEqual(JSON.parse(JSON.stringify(inside)), JSON.parse(JSON.stringify(outside)),
  'Census area context must not change a failure concern card');
assert.ok(outside.metaFacts.includes('Shoulder or bike lane required above 35 mph'),
  'the card should explain the one current speed trigger');
assert.doesNotMatch(JSON.stringify(outside), /urban|rural/i,
  'a concern card must not imply separate area limits');

assert.doesNotMatch(details, /(?:Urban|Rural) no-shoulder limit|\$\{context\} no-shoulder limit/,
  'Route Details must not contain the removed per-area limit labels');
assert.match(details, /mapped sidewalk fallback/,
  'sidewalk concern metadata should describe the fallback, not an area category');
assert.match(app, /measures:\s*s\.measures\s*\|\|\s*null/,
  'Route Details storage must retain the facts used by the shared safety model');
assert.doesNotMatch(worker, /noShoulderMax\s*\[/,
  'the router must cache one no-shoulder value, not an urban/rural pair');
assert.doesNotMatch(readme,
  /Urban \/ rural max speed without shoulder|urban versus rural no-shoulder|urban\/rural no-shoulder/,
  'current documentation must not describe the removed split');
assert.doesNotMatch(help, /Census urban-area context makes fast roads/i,
  'help must not claim Census area changes the safety verdict');

console.log('Concern cards and routing use one no-shoulder limit everywhere.');
