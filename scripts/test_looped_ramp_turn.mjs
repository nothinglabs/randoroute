#!/usr/bin/env node
// Reported from the road, twice: a turn onto an unnamed ramp was never
// announced, and a prompt arrived later telling the rider to turn the OTHER
// way, after they had already overshot.
//
// The cause is the guard that stops wiggly trails producing phantom turns. It
// asks what the rider's course is 40-120 m past a junction, and ignores the
// junction when that has barely changed. A ramp that loops up onto an overpass
// rejoins its original heading, so the guard reads "no real turn" and drops
// the one instruction that mattered -- then a point further along the ramp
// passes the same test and is announced with the direction the LOOP exits on.
//
// Leaving a named road for an unnamed way is a decision point by itself: the
// rider has to recognise an unmarked ramp as theirs. With a hard local turn it
// is announced whatever the course does afterwards. This drives the geometry
// directly rather than routing a real trip, so it pins the rule instead of one
// junction in one city's data.
import { appPage, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);
await page.waitForFunction(() => typeof buildTurnInstructions === 'function', { timeout: 60000 });

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

// A named road running south, then an unnamed ramp that turns hard left and
// curves back around to south again -- the shape of a ramp climbing onto an
// overpass. Metres converted to degrees at 47.6 N.
const built = await page.evaluate(() => {
  const M = 1 / 111320;
  const lonM = M / Math.cos(47.6 * Math.PI / 180);
  const road = [];
  for (let i = 0; i < 8; i++) road.push([-122.3, 47.61 - i * 20 * M]);
  const junction = road[road.length - 1];
  // Hard left onto the ramp (east), then a clockwise loop back to south.
  const ramp = [];
  const bearings = [80, 95, 120, 150, 175, 182, 180, 180, 180];
  let point = junction.slice();
  for (const bearing of bearings) {
    const radians = bearing * Math.PI / 180;
    point = [point[0] + Math.sin(radians) * 20 * lonM, point[1] + Math.cos(radians) * 20 * M];
    ramp.push(point.slice());
  }
  const coords = [...road, ...ramp];
  const segs = [
    { c0: 0, c1: road.length - 1, name: 'Rainier Vista Northeast', lenM: 140 },
    { c0: road.length - 1, c1: coords.length - 1, name: '', lenM: 180 },
  ];
  const result = buildTurnInstructions({ coords, segs });
  return {
    instructions: result.instructions.map((instruction) => ({
      m: Math.round(instruction.distanceM), text: navInstructionText(instruction),
    })),
    junctionM: 140,
  };
});

const atRamp = built.instructions.filter((i) => Math.abs(i.m - built.junctionM) <= 45);
check('the turn onto the unnamed ramp is announced',
  atRamp.length >= 1, JSON.stringify(built.instructions));
check('as the left it actually is, not the direction the loop exits on',
  /left/i.test(atRamp[0]?.text || ''), JSON.stringify(atRamp));
// Three junctions inside the first few metres of the ramp used to each clear
// the new rule and produce their own prompt.
check('and only once, not once per stub at the ramp mouth',
  atRamp.length === 1, JSON.stringify(atRamp));

/* ------------------------------- and the guard it relaxes still does its job */
// The same builder over a way that merely wanders: no named road is left, so
// the veto still applies and no phantom turn is announced.
const wander = await page.evaluate(() => {
  const M = 1 / 111320;
  const lonM = M / Math.cos(47.6 * Math.PI / 180);
  const coords = [];
  let point = [-122.3, 47.61];
  // A trail drifting south with a few metres of side-to-side wander.
  const bearings = [180, 200, 160, 195, 165, 185, 175, 190, 170, 180, 178, 182];
  for (const bearing of bearings) {
    const radians = bearing * Math.PI / 180;
    point = [point[0] + Math.sin(radians) * 12 * lonM, point[1] + Math.cos(radians) * 12 * M];
    coords.push(point.slice());
  }
  const segs = coords.slice(0, -1).map((_, i) => ({ c0: i, c1: i + 1, name: '', lenM: 12 }));
  const result = buildTurnInstructions({ coords, segs });
  return result.instructions.map((instruction) => navInstructionText(instruction));
});
check('a wandering unnamed path still produces no phantom turns',
  wander.length === 0, JSON.stringify(wander));

check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
