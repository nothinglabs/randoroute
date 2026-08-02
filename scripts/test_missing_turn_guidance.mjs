#!/usr/bin/env node
// Maneuvers that went missing on one ride, reproduced on the real graph.
//
// Both were reported from the road, half a mile apart, and both were the same
// failure from the rider's seat: a turn they had to make and were never told
// about. The causes were different, which is why both are pinned here.
//
// Reported from the road: riding east on N 104th and leaving north on Fremont,
// nothing was ever spoken. The banner had already moved on to the turn after
// it, half a mile away, and the rider went through the circle on their own.
//
// The circle is ~14 m across and the bearing sampler looks 20 m, which is the
// whole problem. US circles run counter-clockwise, so a left turn starts by
// swinging RIGHT; sampled forward from the entry the geometry disagreed with
// the road being joined and the maneuver was dropped as untrustworthy. Sampled
// backward from the exit, the chord ran straight across the island and read as
// no turn at all. And when a turn came within 70 m before the circle -- N 104th
// itself does, 48 m out -- the anti-chatter rule ate what was left.
//
// A circle is now one maneuver, measured from the road ridden in to the road
// ridden out, with nothing announced inside it. These four legs pin that: the
// turn is spoken, it is spoken once, it names the right direction, and riding
// straight through says nothing at all.
import { chromiumPath, playwright, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const { chromium } = await playwright();
const browser = await chromium.launch({
  executablePath: chromiumPath(), args: ['--use-gl=swiftshader'],
});
const page = await (await browser.newContext({
  serviceWorkers: 'block', viewport: { width: 430, height: 900 },
})).newPage();
page.setDefaultTimeout(240000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(`http://localhost:${site.port}/index.html`, { waitUntil: 'load' });
await page.waitForFunction(() => typeof routing !== 'undefined' && routing.ready === true,
  { timeout: 240000 });

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};

// The circle sits at 47.70435,-122.35007. These four points are on the streets
// that meet it, far enough out that the route has to cross it.
const WEST = [-122.35078, 47.70435];     // N 104th St, west of the circle
const EAST = [-122.34745, 47.70434];     // N 104th St, east of the circle
const NORTH = [-122.35011, 47.70689];    // Fremont Ave N, north of the circle
const SOUTH = [-122.35004, 47.70054];    // Fremont Ave N, south of the circle
const SOUTHWEST = [-122.35078, 47.70360]; // Evanston Ave N, one turn before it

const ride = (from, to) => page.evaluate(async ([start, end]) => {
  // Drop the previous answer first, or the wait below is satisfied by it and
  // every ride reports the same instructions.
  routing.last = null;
  setRoutePoint('start', { lng: start[0], lat: start[1] });
  setRoutePoint('end', { lng: end[0], lat: end[1] });
  await new Promise((resolve) => {
    const began = Date.now();
    const tick = () => {
      if (routing.last?.ok || Date.now() - began > 90000) return resolve();
      setTimeout(tick, 150);
    };
    tick();
  });
  if (!routing.last?.ok) return { failed: true, spoken: [] };
  const built = buildTurnInstructions(routing.last);
  return {
    spoken: built.instructions.map((instruction) => navInstructionText(instruction)),
    // The stubs that make up the circle, so a data change that removes it shows
    // up as a failure here rather than as a silently pointless test.
    stubs: routing.last.segs.filter((seg) => !seg.name && (seg.lenM || 0) < 30).length,
  };
}, [from, to]);

/* ------------------------------------ east on N 104th, out north on Fremont */
const leftTurn = await ride(WEST, NORTH);
check('the circle is still four short unnamed stubs in the data',
  !leftTurn.failed && leftTurn.stubs >= 3, JSON.stringify(leftTurn));
const circleLines = leftTurn.spoken.filter((line) => /traffic circle/i.test(line));
check('leaving the circle onto Fremont is announced', circleLines.length === 1,
  JSON.stringify(leftTurn.spoken));
check('and it is announced as the left turn it is',
  /At the traffic circle, turn left onto Fremont Avenue North/.test(circleLines[0] || ''),
  circleLines[0]);
check('nothing else is said about the circle',
  !leftTurn.spoken.some((line) => /bear (left|right) onto Fremont/i.test(line)),
  JSON.stringify(leftTurn.spoken));

/* ---------------------------- with a turn 48 m before it, as on the real ride */
// This is the case that was reported. The right onto N 104th used to consume
// the left onto Fremont through the 70 m anti-chatter window.
const afterATurn = await ride(SOUTHWEST, NORTH);
check('a turn shortly before the circle no longer silences it',
  afterATurn.spoken.some((line) => /At the traffic circle, turn left onto Fremont/.test(line)),
  JSON.stringify(afterATurn.spoken));
check('and the turn before it is still announced too',
  afterATurn.spoken.some((line) => /onto North 104th Street/.test(line)),
  JSON.stringify(afterATurn.spoken));

/* ------------------------------------------- straight through, same street */
const straight = await ride(WEST, EAST);
check('riding straight through on the same street says nothing about the circle',
  !straight.spoken.some((line) => /traffic circle/i.test(line)),
  JSON.stringify(straight.spoken));

const alongFremont = await ride(SOUTH, NORTH);
check('nor does riding straight up Fremont through it',
  !alongFremont.spoken.some((line) => /traffic circle/i.test(line)),
  JSON.stringify(alongFremont.spoken));

/* --------------------------------------------------------- the other turn */
// Southbound out of the circle onto N 104th clips a single arc rather than
// travelling round the island, so it is an ordinary right turn and is spoken as
// one. What matters is that it is spoken, once, and to the correct side: a
// median cut-through 130 m earlier used to announce "Continue onto North 104th
// Street" and swallow the real turn through the same-road repeat window.
const rightTurn = await ride(NORTH, WEST);
const named = rightTurn.spoken.filter((line) => /North 104th Street/.test(line));
check('the opposite turn is announced exactly once', named.length === 1,
  JSON.stringify(rightTurn.spoken));
check('and as the right turn it is, not as continuing straight',
  /Turn right onto North 104th Street/.test(named[0] || ''), named[0]);

/* ------------------------------- the second report: the Interurban Trail
 * Riding north on Fremont Avenue North, the route turns right onto North 110th
 * Street and then LEFT onto the Interurban Trail. That street runs 30 m. Inside
 * the 70 m window the trail turn was dropped, so the rider was told to turn
 * right onto N 110th and then nothing at all -- and rode past the trail.
 *
 * Same rule, different junction, and a trail rather than a circle, so it gets
 * its own leg rather than trusting the circle case to cover it.
 */
const FREMONT_SOUTH = [-122.35011, 47.70689];
const TRAIL_NORTH = [-122.34810, 47.71287];
const ontoTrail = await ride(FREMONT_SOUTH, TRAIL_NORTH);
check('the short street before the trail is announced',
  ontoTrail.spoken.some((line) => /Turn right onto North 110th Street/.test(line)),
  JSON.stringify(ontoTrail.spoken));
check('and so is the left onto the trail 30 m later',
  ontoTrail.spoken.some((line) => /Turn left onto Interurban Trail/.test(line)),
  JSON.stringify(ontoTrail.spoken));

/* ------------------------------------------ and the banner tells the truth
 * A maneuver stays on the banner for 60 m past it so a late fix cannot blank it
 * mid-turn. The distance was clamped at zero and printed, and navDistanceText's
 * floor is 25 feet -- so a turn the rider was already through kept promising to
 * be a few steps ahead. Photographed forty metres up the trail.
 */
const banner = await page.evaluate(() => {
  turnNav.active = true;
  turnNav.arrived = false;
  turnNav.message = '';
  turnNav.followingConnector = false;
  turnNav.route = buildTurnInstructions(routing.last);
  turnNav.next = 0;
  const first = turnNav.route.instructions[0];
  const read = (routeM) => { turnNav.routeM = routeM; return navigationBannerInfo().headline; };
  const out = {
    ahead: read(Math.max(0, first.distanceM - 200)),
    at: read(first.distanceM),
    past: read(first.distanceM + 40),
  };
  turnNav.active = false;
  return out;
});
check('a maneuver still ahead reports the distance to it',
  /^In [\d.]+ (feet|miles) · /.test(banner.ahead), JSON.stringify(banner));
check('one the rider has reached says so instead of "In 25 feet"',
  banner.at.startsWith('Now · '), JSON.stringify(banner));
check('and so does one they are already past', banner.past.startsWith('Now · '),
  JSON.stringify(banner));

check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
