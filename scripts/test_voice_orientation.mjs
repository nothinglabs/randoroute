#!/usr/bin/env node
// Reported from the road: navigation was silent until the first turn's 350 m
// window, so a rider setting off had no idea which way to go — and at speed,
// fixed windows announced turns too late to act on. Two behaviours are pinned
// against a synthetic due-east route. The first on-route fix speaks a set-off
// orientation from the ROUTE's geometry (GPS heading needs movement the rider
// hasn't made yet): compass word, road name, and the first maneuver folded in
// — once, never again on later fixes. And the announcement windows grow with
// speed: the same distance to a turn that is not yet worth announcing at
// neighborhood pace must be announced when the rider is fast.
import { appPage, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.waitForFunction(() => typeof buildTurnInstructions === 'function'
  && typeof updateTurnNavigation === 'function', { timeout: 60000 });

// A 1.5 km due-east route along 47.6°N with one left turn 700 m in. Speech is
// captured at the speakNavigation boundary; the queue has its own test.
const setup = (speedMps) => page.evaluate((mps) => {
  window.__spoken = [];
  // The real speakNavigation stamps turnNav.lastVoiceAt; several guards read it
  // to decide whether the app has gone quiet. A stub that only records leaves
  // that clock frozen at the start of the ride, so this simulation looks like
  // an hour of silence and picks up prompts a rider would never hear.
  window.speakNavigation = (text, kind = 'turn') => {
    turnNav.lastVoiceAt = Date.now();
    window.__spoken.push({ text, kind });
  };
  const coords = [];
  for (let i = 0; i <= 20; i++) coords.push([-122.3 + i * 0.001, 47.6]);
  const route = buildTurnInstructions({ coords, segs: [{ c0: 0, c1: coords.length - 1, name: 'Pine Street' }] });
  route.instructions = [{ distanceM: 700, text: 'Turn left onto 1st Avenue',
    now: false, ahead: false, approach: false }];
  turnNav.active = true;
  turnNav.arrived = false;
  turnNav.offRoute = false;
  turnNav.route = route;
  turnNav.plannedRoute = route;
  turnNav.followingConnector = false;
  turnNav.joinDecision = 'nearest';
  turnNav.orientationSpoken = false;
  turnNav.next = 0;
  turnNav.prevFix = null;
  turnNav.speedMph = 0;
  // Maneuver speech only: the periodic status and the safety-run announcement
  // have their own tests, and both would otherwise land in this transcript.
  navVoice.updateMin = 0;
  navVoice.safetyLevels = false;
  window.__fix = (lon) => updateTurnNavigation({
    coords: { longitude: lon, latitude: 47.6, speed: mps, accuracy: 5 },
    timestamp: Date.now(),
  });
}, speedMps);

/* --------------------------------------------- setting off, neighborhood pace */
await setup(4); // ~9 mph
await page.evaluate(() => window.__fix(-122.2999));
let spoken = await page.evaluate(() => window.__spoken);
check('the first on-route fix orients the rider',
  spoken.length === 1, JSON.stringify(spoken));
check('with the compass direction read from the route, not GPS',
  /^Head east/.test(spoken[0]?.text || ''), JSON.stringify(spoken));
check('naming the road under the wheels',
  /on Pine Street/.test(spoken[0]?.text || ''), JSON.stringify(spoken));
check('and folding in the first maneuver',
  /turn left onto 1st Avenue\.$/i.test(spoken[0]?.text || ''), JSON.stringify(spoken));
// Orientation folds in the first maneuver, so that fold IS the turn's one
// heads-up (2026-08-31). It marks the maneuver's advance spent, and the
// approach/ahead windows below no longer repeat it -- the reduction a rider
// asked for. Before this, the first turn was announced four times: orientation
// with the turn folded in, then approach, then ahead, then the imperative.
const approachEarly = await page.evaluate(() => turnNav.route.instructions[0].approach);
check('marking the first maneuver'
  + "'s single heads-up spent, so it is not repeated",
  approachEarly === true, String(approachEarly));

/* ------------------------------------------------------- and only ever once */
await page.evaluate(() => window.__fix(-122.2996));
spoken = await page.evaluate(() => window.__spoken);
check('a later fix does not re-orient', spoken.length === 1, JSON.stringify(spoken));

/* ------------------- the folded heads-up is not repeated as the turn nears */
await page.evaluate(() => window.__fix(-122.2953)); // ~350 m to the turn
spoken = await page.evaluate(() => window.__spoken);
check('the approach window does not repeat a turn orientation already covered',
  spoken.length === 1, JSON.stringify(spoken));
await page.evaluate(() => window.__fix(-122.2913)); // closer to the turn
spoken = await page.evaluate(() => window.__spoken);
check('nor does the ahead window', spoken.length === 1, JSON.stringify(spoken));

/* -------------- but the turn itself is always spoken at the junction */
await page.evaluate(() => window.__fix(-122.29075)); // final few metres before the turn
spoken = await page.evaluate(() => window.__spoken);
check('the imperative still speaks the bare turn command at the junction',
  spoken.length === 2 && /^Turn left onto 1st Avenue\.$/.test(spoken[1].text),
  JSON.stringify(spoken));

/* ----------------------------------------- the windows grow with rider speed */
await setup(11.2); // ~25 mph
await page.evaluate(() => { turnNav.orientationSpoken = true; window.__fix(-122.297); }); // ~225 m in, ~475 m out
spoken = await page.evaluate(() => window.__spoken);
check('at 25 mph a 475 m gap is already an approach announcement',
  spoken.length === 1 && /^In .*turn left/i.test(spoken[0]?.text || ''),
  JSON.stringify(spoken));
await setup(4);
await page.evaluate(() => { turnNav.orientationSpoken = true; window.__fix(-122.297); });
spoken = await page.evaluate(() => window.__spoken);
check('at 9 mph the same gap is still too far to announce',
  spoken.length === 0, JSON.stringify(spoken));

check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
