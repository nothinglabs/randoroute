#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const worker = fs.readFileSync(new URL('../router-worker.js', import.meta.url), 'utf8');
const start = worker.indexOf('const MIN_REPORTED_GRADE_M');
const end = worker.indexOf('/* ------------------------------------------------ riding modes', start);
assert.ok(start >= 0 && end > start, 'grade-reporting helper source was not found');

const context = {};
vm.createContext(context);
vm.runInContext(worker.slice(start, end), context);

assert.equal(context.reportedGradePct(1.8, 1), 0,
  'whole-meter elevation noise on a tiny edge must not become a 180% grade');
assert.equal(context.reportedGradePct(8, 100), 8,
  'a sustained credible grade should be retained');
assert.equal(context.reportedGradePct(50, 100), 0,
  'an implausible DEM-derived grade should be rejected');

const stats = context.routeGradeStats([
  { lenM: 1, gradePct: 180, flags: 0 },
  { lenM: 120, gradePct: 8, flags: 0 },
  { lenM: 100, gradePct: 12, flags: 32 },
]);
assert.equal(stats.maxGradePct, 8,
  'the sustained route maximum should ignore tiny-edge artifacts and ferries');
assert.equal(stats.avgUphillPct, 8,
  'the average uphill grade should use credible riding segments');

const spike = context.routeGradeStats([
  { lenM: 20, gradePct: 30, flags: 0 },
  { lenM: 80, gradePct: 0, flags: 0 },
  { lenM: 100, gradePct: 8, flags: 0 },
]);
assert.equal(spike.maxGradePct, 8,
  'a 20 m steep spike should not exceed a longer sustained climb');

const sustained = context.routeGradeStats([
  { lenM: 100, gradePct: 14, flags: 0 },
]);
assert.equal(sustained.maxGradePct, 14,
  'a full 100 m uphill should retain its sustained grade');

console.log('Grade reporting tests passed.');
