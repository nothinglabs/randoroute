#!/usr/bin/env node
// The recommendation pays a PRICE for fail avoidance instead of granting it
// a veto. Field regression this pins: Seattle -> Everett with default rules
// starred a 40.4 mi / 3h19 route over a 33.0 mi / 2h43 one to avoid 651 m of
// failing shoulder -- a 36-minute detour for a difference that rounds to the
// same "1% fails" on both route cards.
import assert from 'node:assert/strict';
import { routerWorker } from './testlib/harness.mjs';

const DEFAULT_RULES = { allowFreeways: true, allowMtbTrails: false, preferPaved: true,
  minShoulder: 4, inferShoulderFromEdge: true, maxSpeedNoShoulder: 35,
  lanesNoShoulderOver: 3, busyNoShoulder: 2, allowSidewalkFallback: true,
  upperMaxSpeed: 45, noUpperLimit: true, requireSafe: false };
// Must match FAIL_AVOID_PRICE_S_PER_M and NETWORK_GAP_PRICE_S_PER_M in
// router-worker.js; the assertion below is what breaks if they drift.
const PRICE_S_PER_M = 1;
const NETWORK_GAP_PRICE_S_PER_M = 0.2;

const w = routerWorker();
const reply = w.post({ type: 'route-options', id: 'star', rules: DEFAULT_RULES,
  points: [[-122.3321, 47.6062], [-122.2021, 47.9790]] });
assert.ok(reply.ok && reply.options.length >= 2, 'a portfolio should come back');

const offered = reply.options.map((option) => ({
  label: option.optimization.label,
  recommended: !!option.optimization.recommended,
  timeS: option.timeS, failM: option.failM, dismountM: option.dismountM || 0,
  // Dismount meters carry the same price as failing meters (a meter the
  // rider cannot properly ride costs a second, whichever way it fails
  // them), and every riding meter that is neither trail nor trusted lane
  // costs a fifth of one -- ride quality has a vote.
  score: option.timeS + (option.failM + (option.dismountM || 0)) * PRICE_S_PER_M
    + Math.max(0, option.distM - option.ferryM - option.facilityM) * NETWORK_GAP_PRICE_S_PER_M,
}));
const star = offered.find((option) => option.recommended);
assert.ok(star, 'one offered route should carry the recommendation');

// 1. The mechanism: among the offered routes, the star's priced score is
// minimal. A lexicographic regression (fail-meters as a veto) fails this the
// moment a faster candidate exists whose extra failing meters cost less than
// the detour.
const best = offered.reduce((a, b) => (a.score <= b.score ? a : b));
assert.ok(star.score <= best.score + 1,
  `the star must minimize time + ${PRICE_S_PER_M} s/m of failing road:\n`
  + offered.map((o) => `  ${o.label} ${Math.round(o.timeS)}s + ${Math.round(o.failM)}m`
    + ` = ${Math.round(o.score)}${o.recommended ? '  << starred' : ''}`).join('\n'));

// 2. The field case: the star stays within a sane detour of the fastest
// offering. The regression starred +36 minutes; hold the line well under it.
const fastest = offered.reduce((a, b) => (a.timeS <= b.timeS ? a : b));
assert.ok(star.timeS <= fastest.timeS + 900,
  `the star should not detour more than 15 min past the fastest offering `
  + `(star ${Math.round(star.timeS)}s vs fastest ${Math.round(fastest.timeS)}s)`);

console.log(`Recommendation price holds: ${star.label} starred at `
  + `${Math.round(star.timeS / 60)} min with ${Math.round(star.failM)} m failing `
  + `(fastest offering ${Math.round(fastest.timeS / 60)} min).`);
