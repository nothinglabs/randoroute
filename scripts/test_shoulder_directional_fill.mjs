#!/usr/bin/env node
/*
 * Every state must carry its shoulder measurements in BOTH directions of travel.
 *
 * The graph stores shoulder width per direction -- `eSh` for A->B, `eShBA` for
 * B->A -- and an unknown shoulder is scored as zero on purpose, because a fast
 * road has to prove it has room. That design has a failure mode which is
 * invisible from any single number: an adapter that lands its agency's
 * measurement in one slot and leaves the other unknown produces a graph where
 * the same asphalt fails the rules riding north and passes riding south.
 *
 * Oregon shipped that way. Its ODOT adapter consulted the opposite-direction
 * record only when a route key held no rows AT ALL, so US 101 -- whose
 * decreasing key covers 13 of its 363 miles -- looked served and was not. The
 * result was 8,473 km rated one way only, and a coast highway painted 94%
 * failing northbound against 34% true. Total coverage looked fine throughout:
 * Oregon carried data on 56.2% of fast-road length against Washington's 55.2%.
 * Only the RATIO of both-direction to either-direction fill showed it, at 0.26
 * against Washington's 0.86.
 *
 * So that is what this measures, for whatever states `maps/` happens to hold.
 * It is not Oregon's test and it is not Washington's; it is the shape of the
 * defect, checked against every state that ships.
 *
 * A state whose agency genuinely publishes one side only is not a bug, but it
 * is a fact about that state, so it declares `directionalShoulderFloor` in its
 * own `region.json` and says why. Silence means the default applies.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, mapStates, routerWorker } from './testlib/harness.mjs';

// Below this speed the shoulder rung rarely decides the verdict, so a missing
// measurement there is not what this test is looking for.
const FAST_MPH = 45;
// Washington, built by an adapter that fills both sides, sits at 0.86. Oregon
// before the fix sat at 0.26. Anything under this is the one-slot signature.
const DEFAULT_FLOOR = 0.6;

const states = mapStates().filter((state) => state.status === 'released');
if (!states.length) {
  console.log('SKIP: no released states in the registry');
  process.exit(77);
}

let failures = 0;
for (const state of states) {
  const worker = routerWorker({ state: state.id, fresh: true });
  if (!worker.ready) {
    console.log(`SKIP: ${state.id} graph did not load`);
    continue;
  }
  // Length-weighted, because a state's shoulder data is not uniform along its
  // roads and counting edges would let a thousand short urban stubs outvote a
  // highway.
  const measured = worker.run(`(() => {
    let bothM = 0, eitherM = 0, fastM = 0;
    for (let i = 0; i < E; i++) {
      if (eFlags[i] & (8 | 32)) continue;            // walk links and ferries
      const fast = Math.max(eSpeed[i], eSpeedBA[i]) >= ${FAST_MPH};
      if (!fast) continue;
      const len = eLen[i];
      fastM += len;
      const ab = eSh[i] >= 0, ba = eShBA[i] >= 0;
      if (ab && ba) bothM += len;
      if (ab || ba) eitherM += len;
    }
    return { bothM, eitherM, fastM };
  })()`);

  const { bothM, eitherM, fastM } = measured;
  if (eitherM <= 0) {
    console.log(`SKIP: ${state.id} has no shoulder measurements on fast roads`);
    continue;
  }

  const region = JSON.parse(
    readFileSync(join(ROOT, 'maps', state.id, 'region.json'), 'utf8'));
  const floor = Number.isFinite(region.directionalShoulderFloor)
    ? region.directionalShoulderFloor : DEFAULT_FLOOR;
  const declared = region.directionalShoulderFloor !== undefined;

  const ratio = bothM / eitherM;
  const oneWayKm = (eitherM - bothM) / 1000;
  const ok = ratio >= floor;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${state.id}: both/either = ${ratio.toFixed(3)}`
    + ` (floor ${floor}${declared ? ', declared' : ''})`
    + `  -- ${(bothM / 1000).toFixed(0)} km both, ${oneWayKm.toFixed(0)} km one way only,`
    + ` of ${(fastM / 1000).toFixed(0)} km at ${FAST_MPH}+ mph`);
  if (!ok) {
    console.log(`      ${oneWayKm.toFixed(0)} km of ${state.name} is rated in one`
      + ' direction of travel and unknown in the other. An unknown shoulder scores'
      + ' as zero, so those roads fail the rules one way and pass the other.'
      + ` Check the state's own adapter under maps/${state.id}/tools/ for a`
      + ' single-side read or a suppressed opposite-direction fallback. If the'
      + ' agency truly publishes one side only, declare'
      + ' `directionalShoulderFloor` in its region.json and say why.');
  }
}

assert.equal(failures, 0, `${failures} state(s) carry one-direction-only shoulder data`);
console.log('\nEvery released state fills both directions.');
