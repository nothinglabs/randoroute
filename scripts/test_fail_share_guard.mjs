#!/usr/bin/env node
/*
 * The fail-share guard, exercised directly.
 *
 * It exists to stop the router starring a route that fails the rider's rules
 * across a large share of its own length when a comparable, far cleaner option
 * is sitting beside it. It has never fired on a real trip: 86 audited trips
 * across Washington and Oregon produced 7 stars above the 15% share bar and
 * zero firings, because the two conditions are anti-correlated in a real graph
 * -- a star only reaches 15% when the corridor is severed, and a severed
 * corridor has no clean parallel to offer as the alternative.
 *
 * That makes this the only place the rule can be checked. It shipped on
 * reasoning alone once; it should not do so twice. Every case below drives the
 * REAL function inside the REAL worker context -- `failShareGuardPick` is
 * called, not re-implemented here -- with hand-built candidates chosen to sit
 * on each side of each threshold.
 *
 * The nearest real miss is preserved as a case: McMinnville -> Newberg starred
 * 3,264 m of failing road over 24,789 m (13.2%), 454 m short of the bar, with
 * four qualifying alternatives already waiting. If a future change moves the
 * bar, that case says which way.
 */
import assert from 'node:assert/strict';
import { routerWorker } from './testlib/harness.mjs';

const worker = routerWorker();
if (!worker.ready) {
  console.log('SKIP: graph did not load');
  process.exit(77);
}

/** A candidate shaped the way routeOptions' pipeline shapes them. */
function candidate(id, { distM, timeS, failM, dismountM = 0, facilityM = 0,
  trailM = 0, ferryM = 0, mtbM = 0 }) {
  const leg = { distM, timeS, failM };
  return { id, distM, timeS, failM, dismountM, facilityM, trailM, ferryM, mtbM,
    legs: [leg] };
}

/** Run the shipped guard over a candidate set, in the worker's own context. */
function guard(star, others) {
  worker.context.__guardStar = star;
  worker.context.__guardChoices = [star, ...others];
  const picked = worker.run(
    'failShareGuardPick(__guardStar, __guardChoices)');
  return picked ? picked.id : null;
}

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`
    + (ok ? '' : `  (picked ${actual ?? 'null'}, wanted ${expected ?? 'null'})`));
}

/* ---------------------------------------------------------------- firing */
// A 10 km star failing 15% of itself, beside a 12 km route carrying 40% of its
// failing metres. The alternative is deliberately SLOWER and loses on price --
// if the pricing loop already preferred it the guard would be redundant.
{
  const star = candidate('star', { distM: 10000, timeS: 2400, failM: 1500 });
  const clean = candidate('clean-parallel-slow',
    { distM: 12000, timeS: 3400, failM: 600 });
  check('fires when the star fails 15% and a cleaner comparable exists',
    guard(star, [clean]), 'clean-parallel-slow');
}

// The motivating shape: Kirkland -> Redmond, 47% of its own length failing.
{
  const star = candidate('arterial', { distM: 7000, timeS: 1500, failM: 3300 });
  const quiet = candidate('neighbourhood',
    { distM: 11000, timeS: 2700, failM: 131, trailM: 3000 });
  check('fires on the 47%-failing arterial shape',
    guard(star, [quiet]), 'neighbourhood');
}

/* --------------------------------------------------------- not firing */
{
  const star = candidate('star', { distM: 10000, timeS: 2400, failM: 1490 });
  const clean = candidate('clean', { distM: 12000, timeS: 3400, failM: 600 });
  check('declines at 14.9% share -- just under the bar',
    guard(star, [clean]), null);
}
{
  const star = candidate('star', { distM: 10000, timeS: 2400, failM: 1500 });
  const nearly = candidate('nearly-as-bad',
    { distM: 12000, timeS: 3400, failM: 615 });   // 41% of the star's fail
  check('declines when the alternative carries 41% of the star\'s failing road',
    guard(star, [nearly]), null);
}
{
  const star = candidate('star', { distM: 10000, timeS: 2400, failM: 1500 });
  // 1.85 * 2400 + 600 = 5040; one second past it.
  const tooSlow = candidate('too-slow', { distM: 12000, timeS: 5041, failM: 600 });
  check('declines one second outside the time window',
    guard(star, [tooSlow]), null);
}
{
  const star = candidate('star', { distM: 10000, timeS: 2400, failM: 1500 });
  // 1.8 * 10000 + 1600 = 19600; one metre past it.
  const tooLong = candidate('too-long', { distM: 19601, timeS: 3400, failM: 600 });
  check('declines one metre outside the distance window',
    guard(star, [tooLong]), null);
}
{
  const star = candidate('star', { distM: 10000, timeS: 2400, failM: 1500 });
  check('declines when nothing else is offered', guard(star, []), null);
}
{
  const star = candidate('clean-star', { distM: 10000, timeS: 2400, failM: 0 });
  const other = candidate('other', { distM: 11000, timeS: 2600, failM: 0 });
  check('declines when the star fails nothing', guard(star, [other]), null);
}
{
  // A zero-length star cannot have a share; the guard must not divide into it.
  const star = candidate('degenerate', { distM: 0, timeS: 0, failM: 0 });
  const other = candidate('other', { distM: 1000, timeS: 300, failM: 0 });
  check('declines on a zero-length star', guard(star, [other]), null);
}
{
  const star = candidate('star', { distM: 10000, timeS: 2400, failM: 1500 });
  const twoLegs = { ...candidate('two-legs',
    { distM: 12000, timeS: 3400, failM: 600 }) };
  twoLegs.legs = [{ distM: 6000, timeS: 1700, failM: 300 },
    { distM: 6000, timeS: 1700, failM: 300 }];
  check('declines a candidate with a different number of legs',
    guard(star, [twoLegs]), null);
}

/* ------------------------------------------------- which one it chooses */
{
  const star = candidate('star', { distM: 10000, timeS: 2400, failM: 1500 });
  // Both qualify. The guard takes the lowest recommendation SCORE, which is not
  // the same as the least failing road -- worth pinning, because "safest wins"
  // is the intuitive reading and it is wrong.
  const safest = candidate('safest-but-slower',
    { distM: 13000, timeS: 4200, failM: 100 });
  const cheapest = candidate('cheapest-by-score',
    { distM: 11000, timeS: 2600, failM: 500, trailM: 6000 });
  check('among qualifying alternatives, takes the lowest score',
    guard(star, [safest, cheapest]), 'cheapest-by-score');
}

/* ----------------------------------- the nearest real miss, as a tripwire */
{
  // McMinnville -> Newberg as measured: 13.2% share. It must NOT fire, and the
  // numbers are kept exact so that a change to GUARD_FAIL_SHARE shows up here
  // as a deliberate decision rather than a silent one.
  const star = candidate('mcminnville-star',
    { distM: 24789, timeS: 4500, failM: 3264 });
  const frontier = candidate('section-frontier',
    { distM: 34700, timeS: 6600, failM: 212 });
  check('McMinnville -> Newberg stays 454 m short of the bar',
    guard(star, [frontier]), null);
  // ...and would fire with those extra 454 m, which is what makes the bar the
  // load-bearing number rather than the window.
  const worse = candidate('mcminnville-star-worse',
    { distM: 24789, timeS: 4500, failM: 3719 });
  check('...and fires once the star carries 15%',
    guard(worse, [frontier]), 'section-frontier');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nfail-share guard holds.');
process.exit(failures ? 1 : 0);
