#!/usr/bin/env node
// Some trips have a known right answer, and this is the rider's.
//
// Portage Bay Cafe in the University District to Woodland Park Zoo is a trip
// they ride. There are three genuinely different ways to go, all of them
// sensible, and a rider who is shown only one of them has been told something
// false about their city -- the app exists partly to teach the shape of a
// network, not just to hand over one line. So all three must appear among the
// six letters:
//
//   1. up Fremont Avenue N        -- the direct climb out of Fremont
//   2. up Stone Way N             -- the gentler grade, ideally to N 50th
//   3. Ravenna Boulevard to Green Lake  -- the north-east arc, reached by
//                                          11th Avenue NE
//
// This is deliberately NOT a scoring test. It does not care which is starred,
// how they rank, or whether one is a few minutes longer. It cares that the
// board spans the corridors a local rider would name. If a change to weights,
// filtering or selection drops one of these, that is the alarm: routing has
// broken in a way no aggregate measurement will show you, because the corpus
// average barely moves when a whole corridor disappears from one trip.
//
// Every floor below sits well under what the trip currently offers, so ordinary
// re-tuning does not trip it. Losing a corridor outright does.
import assert from 'node:assert';
import { routerWorker } from './testlib/harness.mjs';
import { auditRoute, defaultRules, havM } from './audit_route.mjs';

const TRIP = {
  state: 'washington',
  id: 'portagebay-zoo',
  name: 'Portage Bay Cafe -> Woodland Park Zoo',
  from: [-122.31757, 47.65760],   // 4130 Roosevelt Way NE
  to: [-122.35460, 47.67070],     // 601 N 59th St
};

// `required` fails the run. `preferred` only prints -- the rider called these
// the nicer variants but said they were flexible on them, so they are here to
// be watched over time, not to break a build.
const CORRIDORS = [
  { name: 'Fremont Avenue N', match: /^fremont avenue north$/i, required: 600 },
  { name: 'Stone Way N', match: /^stone way north$/i, required: 800 },
  { name: 'Ravenna Boulevard', match: /ravenna boulevard/i, required: 600 },
  // 800, not 600: this floor also carries what test_dominated_options used
  // to re-assert on this same trip -- 11th Ave NE was once deleted outright
  // by the dominance trim, and 800 m is the guard that noticed.
  { name: '11th Avenue NE', match: /^11th avenue northeast$/i, required: 800 },
  { name: 'N 50th St (with Stone Way)', match: /^north 50th street$/i, preferred: 600 },
];

function metresOf(option, match) {
  const coords = option.coords || [];
  let metres = 0;
  for (const seg of (option.segs || [])) {
    if (!match.test(seg.name || '')) continue;
    for (let k = seg.c0; k < seg.c1 && k + 1 < coords.length; k++) {
      metres += havM(coords[k], coords[k + 1]);
    }
  }
  return metres;
}

const worker = routerWorker({ state: TRIP.state });
assert.ok(worker.ready, 'the washington graph must load');
const audit = auditRoute(worker, TRIP, defaultRules());
assert.ok(audit.ok, `${TRIP.name} must remain routable`);
assert.ok(audit.options.length >= 5,
  `${TRIP.name} offered only ${audit.options.length} routes; this trip has at least`
  + ' three distinct corridors and a board too small to hold them is already the bug');

const missing = [];
for (const corridor of CORRIDORS) {
  let best = 0, on = null;
  for (const option of audit.options) {
    const metres = metresOf(option, corridor.match);
    if (metres > best) { best = metres; on = option; }
  }
  const floor = corridor.required ?? corridor.preferred;
  const mark = best >= floor ? 'ok  ' : (corridor.required ? 'GONE' : 'note');
  console.log(`  ${mark}  ${corridor.name.padEnd(28)} ${String(Math.round(best)).padStart(5)} m`
    + ` (floor ${floor})${on ? `  on ${on.letter}` : ''}`);
  if (corridor.required && best < corridor.required) {
    missing.push(`${corridor.name}: ${Math.round(best)} m offered, wanted ${corridor.required}`);
  }
}

assert.equal(missing.length, 0,
  `${TRIP.name} no longer offers ${missing.length} of its core corridors:\n    `
  + missing.join('\n    ')
  + '\n  These are routes a local rider would name, and they were all on the board when'
  + '\n  this test was written. Something in weighting, filtering or selection has'
  + '\n  stopped surfacing a whole way to go -- check the All Routes list first: if the'
  + '\n  corridor is still being BUILT and merely lost its letter, the fault is in'
  + '\n  selection, not in routing.');
console.log(`${TRIP.name}: all core corridors offered across ${audit.options.length} routes`);
