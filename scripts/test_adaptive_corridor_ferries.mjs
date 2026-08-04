#!/usr/bin/env node
// A ferry is a crossing, never a shuttle: no offered route may ride the same
// boat twice.
//
// Field-found on Seattle -> Walla Walla with both route preferences on and
// adaptive-corridor preferred (the recipe below is the rider's share link,
// verbatim). The adaptive-corridor probe splices a ferry itinerary's boats
// back around re-imagined land sections, and its "land" alternative for the
// Tacoma -> Walla Walla section itself boarded ferries -- sailing BACK across
// water the seed had already crossed. The offered route rode the Point
// Defiance-Tahlequah ferry twice and five boats total, drawing two
// disconnected-looking arms on the map. The probe now refuses seaborne land
// alternatives; this runs the exact recipe and holds every offered option to
// the no-repeated-boat rule.
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
const reply = w.post({ type: 'route-options', id: 'ww',
  points: [[-122.33006, 47.60383], [-118.33934, 46.06673]], rules: RULES,
  forceDesignated: true, forceResidential: true,
  preferredProfileId: 'adaptive-corridor' });

check('the portfolio answers', reply?.ok === true && (reply.options || []).length >= 3,
  JSON.stringify({ ok: reply?.ok, count: reply?.options?.length }));

for (const option of reply.options || []) {
  const label = `${option.optimization?.label} [${option.optimization?.profileId}]`;
  // A repeated boat is the same ferry name over the same unordered pair of
  // dock coordinates. Distinct legs of one ferry system (Vashon-Southworth
  // vs Fauntleroy-Vashon) differ in name or docks and stay legal.
  const coords = option.coords || [];
  const boats = (option.segs || []).filter((s) => (s.flags || 0) & 32).map((s) => {
    const a = coords[s.c0], b = coords[s.c1];
    const docks = [a, b].map((p) => p?.map((v) => v.toFixed(3)).join(',')).sort().join('|');
    return `${s.name}@${docks}`;
  });
  check(`${label} rides no ferry twice (${boats.length} boat${boats.length === 1 ? '' : 's'})`,
    new Set(boats).size === boats.length, boats.join(' ; '));
}

console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
