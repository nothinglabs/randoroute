#!/usr/bin/env node
// A ferry is a crossing, never a shuttle: no offered route may ride the same
// boat twice.
//
// Field-found on Seattle -> Walla Walla with both route preferences on and
// adaptive-corridor preferred. The adaptive-corridor probe splices a ferry
// itinerary's boats back around re-imagined land sections, and its "land"
// alternative for the Tacoma -> Walla Walla section itself boarded ferries --
// sailing BACK across water the seed had already crossed. The offered route
// rode the Point Defiance-Tahlequah ferry twice and five boats total, drawing
// two disconnected-looking arms on the map. The probe now refuses seaborne
// land alternatives, and this holds every offered option to the
// no-repeated-boat rule.
//
// The trip is NOT the original recipe any more. Routing moved on and
// Seattle -> Walla Walla now answers overland: six options, zero ferry
// segments, zero adaptive-corridor candidates. The file kept passing --
// every assertion was quantified over an empty set -- and cost ~275 s a run
// to assert nothing. That is the failure mode AGENTS.md names: coverage that
// looks like coverage and is not.
//
// So the fixture is Seattle -> Port Townsend, which still exercises the real
// thing (three adaptive-corridor candidates, two boats each), and the first
// checks below are a TRIPWIRE: they assert the trip still boards ferries and
// still builds adaptive itineraries. If routing changes again and this trip
// stops crossing water, the tripwire fails loudly instead of the file going
// quietly vacuous a second time.
import { routerWorker } from './testlib/harness.mjs';

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};

const w = routerWorker();
const RULES = { allowFreeways: true, allowMtbTrails: false, preferPaved: true,
  minShoulder: 4, inferShoulderFromEdge: true, maxSpeedNoShoulder: 35,
  lanesNoShoulderOver: 3, busyNoShoulder: 2, allowSidewalkFallback: true,
  upperMaxSpeed: 45, noUpperLimit: true, requireSafe: false };
const reply = w.post({ type: 'route-options', id: 'pt',
  points: [[-122.33006, 47.60383], [-122.7604, 48.1170]], rules: RULES,
  forceDesignated: true, forceResidential: true,
  preferredProfileId: 'adaptive-corridor' });

check('the portfolio answers', reply?.ok === true && (reply.options || []).length >= 3,
  JSON.stringify({ ok: reply?.ok, count: reply?.options?.length }));

// ---- the tripwire ---------------------------------------------------------
// Everything below is a rule about ferry itineraries. If the fixture stops
// producing any, the rules hold vacuously and this file becomes decoration.
// These two checks are what make the rest mean something.
const ferrySegs = (option) => (option.segs || []).filter((s) => (s.flags || 0) & 32);
{
  const options = reply.options || [];
  const boating = options.filter((option) => ferrySegs(option).length > 0);
  check(`the fixture still boards ferries: ${boating.length} of ${options.length} options`,
    boating.length > 0,
    'Seattle -> Port Townsend answered without crossing water; re-anchor this '
    + 'trip on one that still sails, or the checks below test nothing');
  const adaptive = (reply.allCandidates || [])
    .filter((candidate) => /adaptive-corridor/.test(candidate.profileId || ''));
  check(`and still builds adaptive-corridor itineraries: ${adaptive.length}`,
    adaptive.length > 0,
    'no adaptive-corridor candidate was built, so the splice this file guards '
    + 'never ran');
}

// Every candidate keys downstream state -- the chooser's pinned lineup, the
// candidate cache, selection stickiness -- by profile id, and this pass can
// build several adaptive itineraries in one portfolio. Two candidates
// sharing one id scrambled the route letters in the field (A, B, E, D), so
// uniqueness across the WHOLE candidate record is a contract, not a nicety.
{
  const ids = (reply.allCandidates || []).map((candidate) => candidate.profileId);
  check('every candidate carries a unique profile id',
    new Set(ids).size === ids.length,
    ids.filter((id, index) => ids.indexOf(id) !== index).join(', ') || '(none duplicated)');
}

for (const option of reply.options || []) {
  const label = `${option.optimization?.label} [${option.optimization?.profileId}]`;
  // A repeated boat is the same ferry name over the same unordered pair of
  // dock coordinates. Distinct legs of one ferry system (Vashon-Southworth
  // vs Fauntleroy-Vashon) differ in name or docks and stay legal.
  const coords = option.coords || [];
  const boats = ferrySegs(option).map((s) => {
    const a = coords[s.c0], b = coords[s.c1];
    const docks = [a, b].map((p) => p?.map((v) => v.toFixed(3)).join(',')).sort().join('|');
    return `${s.name}@${docks}`;
  });
  check(`${label} rides no ferry twice (${boats.length} boat${boats.length === 1 ? '' : 's'})`,
    new Set(boats).size === boats.length, boats.join(' ; '));
}

console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
