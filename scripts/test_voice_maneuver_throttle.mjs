#!/usr/bin/env node
// One turn should not be announced three times, and the announcements about it
// should not pile up inside a few seconds. Reported from the road (2026-08-31):
// approaching a single turn, the approach warning, the "ahead" warning and the
// imperative could all land within a fifteen-second window and talk over each
// other.
//
// The rule maneuverVoicePhase enforces: at most one heads-up plus the turn
// itself (never a third), no two advance warnings about the same turn inside
// MANEUVER_VOICE_GAP_MS, and -- the line this must never cross -- the imperative
// is spoken whenever its window is reached even if a heads-up went out a second
// ago. A missed "turn here" is the failure the whole system exists to prevent.
//
// The function is pure over (maneuver, remaining, windows, now): it reads and
// writes the maneuver's own throttle flags and returns which phase to speak, so
// this drives it directly with a fake clock rather than simulating GPS.
import { chromiumPath, playwright, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const { chromium } = await playwright();
const browser = await chromium.launch({
  executablePath: chromiumPath(), args: ['--use-gl=swiftshader'],
});
const page = await (await browser.newContext({
  serviceWorkers: 'block', viewport: { width: 430, height: 900 },
})).newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(site.url, { waitUntil: 'load' });
await page.waitForFunction(() => typeof maneuverVoicePhase === 'function',
  { timeout: 60000 });

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};

const WINDOWS = { immediateM: 40, aheadM: 150, approachM: 400 };

// Run a sequence of {remaining, dtMs} fixes against one fresh maneuver, with a
// clock that only advances by the dt each fix. Returns the phase each fix
// produced.
const run = (fixes) => page.evaluate(([windows, sequence]) => {
  const maneuver = {};
  let clock = 1_000_000; // arbitrary epoch
  return sequence.map(({ remaining, dtMs }) => {
    clock += dtMs;
    return maneuverVoicePhase(maneuver, remaining, windows, clock);
  });
}, [WINDOWS, fixes]);

/* --------------------------------------- the reported bunch: fast approach */
// A rider at 20 mph gets a fix in the approach window, then the ahead window,
// then the immediate window a few seconds apart. Before the fix that was three
// announcements in one short window.
const fast = await run([
  { remaining: 380, dtMs: 0 },    // approach window
  { remaining: 180, dtMs: 4000 }, // still outside ahead? no -> below approach only
  { remaining: 120, dtMs: 3000 }, // ahead window
  { remaining: 60, dtMs: 3000 },  // between ahead and immediate
  { remaining: 30, dtMs: 3000 },  // immediate window
]);
const fastSpoken = fast.filter(Boolean);
check('a fast approach to one turn speaks at most twice',
  fastSpoken.length <= 2, JSON.stringify(fast));
check('and exactly one of those two is the imperative',
  fastSpoken.filter((phase) => phase === 'now').length === 1, JSON.stringify(fast));
check('and only one advance warning, never both approach and ahead',
  fastSpoken.filter((phase) => phase === 'approach' || phase === 'ahead').length === 1,
  JSON.stringify(fast));

/* --------------------------- the imperative is never withheld for spacing */
// Heads-up, then the turn three seconds later. The 12 s spacing must NOT
// swallow the imperative -- this is the "do not make us miss guidance" line.
const closeImperative = await run([
  { remaining: 140, dtMs: 0 },    // ahead -> heads-up
  { remaining: 25, dtMs: 3000 },  // immediate, only 3 s later
]);
check('the imperative still fires when the turn arrives seconds after a heads-up',
  closeImperative[0] === 'ahead' && closeImperative[1] === 'now',
  JSON.stringify(closeImperative));

/* ------------------------------- a turn met head-on gets the imperative alone */
const straightToTurn = await run([
  { remaining: 30, dtMs: 0 },     // already in the immediate window
  { remaining: 10, dtMs: 2000 },  // still inside; must not re-announce
]);
check('a turn reached with no heads-up is announced once, as the imperative',
  straightToTurn[0] === 'now' && straightToTurn[1] === null,
  JSON.stringify(straightToTurn));

/* ------------------------------- an advance warning is spaced by the gap */
// Directly exercise the spacing gate: a maneuver whose last announcement was
// 5 s ago must not get a heads-up yet, but does once 12 s have passed.
const spacing = await page.evaluate(([windows]) => {
  const now = 2_000_000;
  const tooSoon = { lastVoiceAt: now - 5000 };
  const early = maneuverVoicePhase(tooSoon, 300, windows, now);
  const spaced = { lastVoiceAt: now - 13000 };
  const late = maneuverVoicePhase(spaced, 300, windows, now);
  return { early, late };
}, [WINDOWS]);
check('a heads-up within the gap of the last announcement is held', spacing.early === null,
  JSON.stringify(spacing));
check('and released once the gap has passed', spacing.late === 'approach',
  JSON.stringify(spacing));

/* -------------------------- many fixes in-window never exceed two per turn */
const flood = await run(Array.from({ length: 40 }, (_, i) => ({
  remaining: Math.max(20, 390 - i * 10), dtMs: 1500,
})));
const floodSpoken = flood.filter(Boolean);
check('flooding one turn with fixes never speaks it more than twice',
  floodSpoken.length <= 2, JSON.stringify(floodSpoken));
check('and one of them is the imperative',
  floodSpoken.includes('now'), JSON.stringify(floodSpoken));

check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
