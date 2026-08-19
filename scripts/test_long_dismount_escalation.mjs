#!/usr/bin/env node
// A long continuous signed dismount is a route-level fact: individual edges
// are merely caution, but the assembled run must fail. Keep the explicit
// escalation reason attached so fact-based downstream re-scoring cannot turn
// a hike back into an apparently acceptable bike route.
import assert from 'node:assert/strict';
import { routerWorker } from './testlib/harness.mjs';

const worker = routerWorker({ fresh: true });
assert.ok(worker.ready, 'the worker must load');
const entry = JSON.parse(JSON.stringify(worker.run(`(() => {
  eOfficial = new Uint8Array([
    EDGE_DISMOUNT,
    EDGE_DISMOUNT | EDGE_DISMOUNT_TAG,
    EDGE_DISMOUNT | EDGE_DISMOUNT_TAG,
  ]);
  return {
    inferred: dismountEntryPenaltyS(-1, 0),
    explicit: dismountEntryPenaltyS(-1, 1),
    inferredToExplicit: dismountEntryPenaltyS(0, 1),
    continuedExplicit: dismountEntryPenaltyS(1, 2),
  };
})()`)));
assert.deepEqual(entry, {
  inferred: 0,
  explicit: 60,
  inferredToExplicit: 60,
  continuedExplicit: 0,
}, 'only entry into an explicitly tagged dismount run pays the fixed charge');

const result = JSON.parse(JSON.stringify(worker.run(`(() => {
  const tagged = EDGE_DISMOUNT | EDGE_DISMOUNT_TAG;
  const long = [
    { official: tagged, lenM: 60, level: 3, cautionCause: 'dismount' },
    { official: tagged, lenM: 55, level: 3, cautionCause: 'dismount' },
  ];
  const longLevels = [0, 0, 0, 115, 0];
  const longAdded = escalateLongDismounts(long, longLevels);
  const short = [{ official: tagged, lenM: 100, level: 3, cautionCause: 'dismount' }];
  const shortLevels = [0, 0, 0, 100, 0];
  const shortAdded = escalateLongDismounts(short, shortLevels);
  return { long, longLevels, longAdded, short, shortLevels, shortAdded };
})()`)));

assert.equal(result.longAdded, 115, 'the whole >100 m run must become failing distance');
assert.deepEqual(result.longLevels, [0, 0, 0, 0, 115],
  'the route totals must move the complete run from caution to failure');
assert.ok(result.long.every((seg) => seg.level === 4 && seg.dismountEscalated === true
    && seg.cautionCause === null),
  'each long-run segment must carry the explicit escalation reason');
assert.equal(result.shortAdded, 0, 'a 100 m run remains caution at the boundary');
assert.deepEqual(result.shortLevels, [0, 0, 0, 100, 0]);
assert.equal(result.short[0].dismountEscalated, undefined,
  'a short dismount must not claim the long-run fact');

console.log('Long dismount escalation preserves 115 m as explicit failing route facts.');
