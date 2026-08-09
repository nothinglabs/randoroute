#!/usr/bin/env node
// Reported from the road: "turn right onto Stone Way in 100 feet" spoken while
// the corner was still a block away.
//
// It was a missing unit conversion. Distances travel in METRES; under a tenth
// of a mile navDistanceText rounded the metre count to 25 and labelled it
// "feet", so everything close in was understated by 3.28x and 100 m of road
// was announced as 100 feet. This pins the conversion at the boundaries that
// matter, and the phrasing rule that came with it: close enough that a figure
// is false precision, the spoken prompt says "ahead" instead of a number.
import { appPage, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);
await page.waitForFunction(() => typeof navDistanceText === 'function', { timeout: 60000 });

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

const said = await page.evaluate(() => ({
  m30: navDistanceText(30),
  m100: navDistanceText(100),
  m160: navDistanceText(160),
  m161: navDistanceText(161),
  m800: navDistanceText(800),
  mile: navDistanceText(1609.34),
}));
// 100 m is 328 ft; the old code said "100 feet" here, which is the whole bug.
check('a block of road is spoken as its real distance in feet',
  said.m100 === '325 feet', JSON.stringify(said));
check('and a short hop too', said.m30 === '100 feet', JSON.stringify(said));
check('feet stay in use right up to a tenth of a mile',
  said.m160 === '525 feet', JSON.stringify(said));
check('past which it switches to miles', said.m161 === '0.1 miles', JSON.stringify(said));
check('longer distances read in miles', said.m800 === '0.5 miles' && said.mile === '1.0 miles',
  JSON.stringify(said));
// Nothing may ever be spoken as a smaller number than it really is: that is
// the direction of error that puts a rider into a junction unprepared.
const understated = await page.evaluate(() => {
  for (let m = 5; m < 160; m += 5) {
    const feet = Number(navDistanceText(m).split(' ')[0]);
    if (feet < m) return { m, feet };
  }
  return null;
});
check('no distance is ever announced shorter than it is',
  understated === null, JSON.stringify(understated));

/* ------------------------------------- close in, a figure is false precision */
const phrasing = await page.evaluate(() => {
  const instruction = { text: 'Turn right onto Stone Way North', heading: '' };
  return {
    near: navSpokenApproach(40, instruction),
    far: navSpokenApproach(300, instruction),
  };
});
check('a very close turn is announced as "ahead", with no figure',
  phrasing.near === 'Turn right onto Stone Way North ahead.', JSON.stringify(phrasing));
check('a turn with room to judge keeps its distance',
  /^In 0\.2 miles, turn right onto Stone Way North\.$/.test(phrasing.far),
  JSON.stringify(phrasing));

check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
