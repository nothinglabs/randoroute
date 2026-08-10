#!/usr/bin/env node
// Reported from the Sammamish River Trail: the trail jogs -- a right then, 50
// feet later, a left -- and the rider was told "Turn left to stay on Sammamish
// River Trail" while the thing in front of them was the right. The first corner
// was never announced at all.
//
// The cause is the guard that stops wiggly trails producing phantom turns. It
// asks what the rider's course is 40-120 m past a junction and stays quiet when
// that has barely changed. Measured past a 15 m jog, that window lands after
// the SECOND corner, back on the bearing the rider arrived on, so the first
// corner reads as "no real turn" and only the second one speaks.
//
// No local-angle threshold can fix it: a trail weaving +/-30 deg every 30 m
// throws the same 60 deg readings a real corner does -- measured, not assumed,
// and the wander case at the bottom of this file is what holds that line. What
// separates them is COMPANY. Wander is a train of corners; a jog is a PAIR with
// straight running either side. So the rescue is granted only to a junction
// with exactly one close neighbour and nothing past it, and both halves are
// spoken in one prompt, in the order the rider meets them.
//
// This drives the geometry directly rather than routing a real trip, so it pins
// the rule rather than one dogleg in one city's data.
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

// One named trail, built from legs of [bearing, metres]. Each leg is its own
// segment, which is what the graph gives a trail that bends: one way, several
// edges. Metres converted to degrees at 47.7 N.
const build = await page.evaluate(() => {
  window.buildTrail = (legs, name = 'Sammamish River Trail') => {
    const M = 1 / 111320;
    const lonM = M / Math.cos(47.7 * Math.PI / 180);
    const coords = [];
    const segs = [];
    let point = [-122.2, 47.7];
    coords.push(point.slice());
    for (const [bearing, metres] of legs) {
      const c0 = coords.length - 1;
      for (let d = 0; d < metres; d += 10) {
        const radians = bearing * Math.PI / 180;
        point = [point[0] + Math.sin(radians) * 10 * lonM,
          point[1] + Math.cos(radians) * 10 * M];
        coords.push(point.slice());
      }
      segs.push({ c0, c1: coords.length - 1, name, lenM: metres });
    }
    const result = buildTurnInstructions({ coords, segs });
    return result.instructions.map((instruction) => ({
      m: Math.round(instruction.distanceM), text: navInstructionText(instruction),
    }));
  };
  return true;
});
check('the trail builder is available', build === true);

/* ------------------------------------------------------- the reported jog */
// 200 m north, a 15 m jog to the right, then north again: the trail stepping
// sideways across a bridge.
const jog = await page.evaluate(() => buildTrail([[0, 200], [65, 15], [0, 200]]));
check('a 15 m dogleg is announced at all', jog.length >= 1, JSON.stringify(jog));
check('at the FIRST corner, not the second',
  jog[0] && jog[0].m === 200, JSON.stringify(jog));
check('naming the right the rider meets first',
  /^Turn right/.test(jog[0]?.text || ''), jog[0]?.text);
check('and the left that follows it, in that order',
  /then left/.test(jog[0]?.text || ''), jog[0]?.text);
check('as ONE prompt, so the two do not talk over each other',
  jog.length === 1, JSON.stringify(jog));
check('still saying which trail it keeps the rider on',
  /Sammamish River Trail/.test(jog[0]?.text || ''), jog[0]?.text);

// The other way round, to prove the directions are read from the geometry
// rather than fixed.
const mirrored = await page.evaluate(() => buildTrail([[0, 200], [-65, 15], [0, 200]]));
check('a jog the other way says left then right',
  mirrored.length === 1 && /^Turn left, then right,/.test(mirrored[0]?.text || ''),
  JSON.stringify(mirrored));

// Neither half of a 45 deg jog would rate a prompt alone -- on the road the
// rider is already on, an ordinary bend has to clear 50 deg to be worth a word.
// Two of them in opposite directions are still two things to do.
const shallow = await page.evaluate(() => buildTrail([[0, 200], [45, 15], [0, 200]]));
check('a shallower jog is still two steers, so it is still announced',
  shallow.length === 1 && /then left/.test(shallow[0]?.text || ''), JSON.stringify(shallow));

/* ------------------------------------- far enough apart to be two prompts */
// 90 m between the corners is 20 seconds at trail speed. Folding those into one
// prompt would announce the second corner long before the rider could act on
// it, so they get one each -- which the same-road repeat rule used to eat,
// because it could not tell an S-bend from one bend counted twice.
const sBend = await page.evaluate(() => buildTrail([[0, 200], [65, 90], [0, 200]]));
check('an S-bend 90 m across gets a prompt per corner',
  sBend.length === 2, JSON.stringify(sBend));
check('the first says right, the second says left',
  /^Turn right/.test(sBend[0]?.text || '') && /^Turn left/.test(sBend[1]?.text || ''),
  JSON.stringify(sBend));
check('and neither borrows the other\'s "then"',
  !sBend.some((instruction) => /then/.test(instruction.text)), JSON.stringify(sBend));

/* --------------------------------------------- what the guard still stops */
// The line this cannot cross. A trail weaving +/-30 deg every 30 m produces
// local readings of 60 deg -- identical to a real corner -- which is why the
// rescue is granted on company rather than on angle. Every junction here has a
// near neighbour on BOTH sides, so none of them is a pair, and the guard holds.
const wander = await page.evaluate(() => buildTrail(
  [[0, 60], [30, 30], [-30, 30], [30, 30], [-30, 30], [30, 30], [-30, 30], [0, 60]]));
check('a weaving trail still produces no phantom turns',
  wander.length === 0, JSON.stringify(wander));

// And a single corner is unchanged: one prompt, no chained clause.
const single = await page.evaluate(() => buildTrail([[0, 200], [65, 300]]));
check('a lone corner is still one plain prompt',
  single.length === 1 && /^Turn right to stay on/.test(single[0]?.text || '')
    && !/then/.test(single[0]?.text || ''), JSON.stringify(single));

// A jog with a third corner just past it is a train, not a pair: the rescue is
// withheld, because that is the shape wander takes.
const train = await page.evaluate(() => buildTrail(
  [[0, 200], [65, 15], [0, 15], [65, 15], [0, 200]]));
check('three corners in a row are not treated as a jog',
  !train.some((instruction) => /then/.test(instruction.text)), JSON.stringify(train));

/* ------------------------------ the pair that names roads, not just a trail */
// Second report, same shape: "didn't get notice for a second turn until I
// already had to make it". Two corners 15 m apart, each onto a NAMED street --
// so the rescue above never applied, because it only ran where there was no new
// road to name. Two prompts 15 m apart is about three seconds at riding speed:
// the second one arrives as "Now".
const streets = await page.evaluate(() => {
  window.buildStreets = (legs) => {
    const M = 1 / 111320;
    const lonM = M / Math.cos(47.67 * Math.PI / 180);
    const coords = [];
    const segs = [];
    let point = [-122.29, 47.67];
    coords.push(point.slice());
    for (const [bearing, metres, name] of legs) {
      const c0 = coords.length - 1;
      for (let d = 0; d < metres; d += 5) {
        const radians = bearing * Math.PI / 180;
        point = [point[0] + Math.sin(radians) * 5 * lonM,
          point[1] + Math.cos(radians) * 5 * M];
        coords.push(point.slice());
      }
      segs.push({ c0, c1: coords.length - 1, name, lenM: metres });
    }
    const result = buildTurnInstructions({ coords, segs });
    return result.instructions.map((instruction) => ({
      m: Math.round(instruction.distanceM), text: navInstructionText(instruction),
    }));
  };
  return buildStreets([[0, 200, 'Ravenna Avenue Northeast'],
    [70, 15, 'Northeast 54th Street'],
    [340, 300, 'Northeast 55th Street']]);
});
check('a pair onto named streets folds into one prompt too',
  streets.length === 1 && streets[0].m === 200, JSON.stringify(streets));
check('with both steers in order',
  /^Bear right, then left/.test(streets[0]?.text || ''), streets[0]?.text);
// Naming the 15 m stub between the corners tells the rider about a road they
// are on for three seconds and leaves the one they need unnamed.
check('naming the street the pair puts them ON, not the stub between',
  /onto Northeast 55th Street/.test(streets[0]?.text || '')
    && !/54th/.test(streets[0]?.text || ''), streets[0]?.text);

// The corner's own swing, measured only as far as its neighbour. Over the full
// 20 m window the two swings average each other away -- a 45 deg jog reads as
// 30 and says nothing -- which is how a pair this tight went unannounced.
const shallowStreets = await page.evaluate(() => buildStreets(
  [[315, 200, 'Ravenna Avenue Northeast'],
    [0, 15, 'Northeast 54th Street'],
    [270, 300, 'Northeast 54th Street']]));
check('a shallow pair across a short stub is still measured as two steers',
  shallowStreets.length === 1 && /then left/.test(shallowStreets[0]?.text || ''),
  JSON.stringify(shallowStreets));
check('and reports the heading the SECOND corner leaves them on',
  /heading west/.test(shallowStreets[0]?.text || ''), shallowStreets[0]?.text);

check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
