#!/usr/bin/env node
// A turn onto an unnamed off-street path must not borrow the name of the
// street being left. Reported from the road (issue 19, 2026-08-30): at
// Roosevelt Way NE and NE 65th Street the banner read "Turn left to stay on
// Northeast 65th Street, heading south" -- a southward turn claiming to stay
// on an east-west street. The route was really leaving 65th for the unnamed
// separated track, but the only NAME in the look-ahead window was a
// metres-long sliver still carrying "Northeast 65th Street" (the ON NOW card
// showed the 16 ft segment), and that sliver named the maneuver.
//
// navDestinationSegment now treats a real stretch of unnamed path after the
// junction as the destination itself, so the prompt names the path. This
// rides the same shape on the real Washington graph: west on NE 65th, then
// left onto the unnamed protected track.
import { appPage, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);
await page.waitForFunction(() => typeof routing !== 'undefined' && routing.ready === true,
  { timeout: 240000 });

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

const ride = await page.evaluate(async () => {
  routing.last = null;
  setRoutePoint('start', { lng: -122.3174, lat: 47.6789 }); // Roosevelt Way NE at NE 67th
  setRoutePoint('end', { lng: -122.3174, lat: 47.6733 });   // Roosevelt Way NE at NE 62nd
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
  // The ride must actually take the shape under test: some named-street
  // riding, then a run of unnamed path-like segments. Without this a data
  // change that reroutes the trip would leave the checks below passing
  // vacuously.
  const segs = routing.last.segs || [];
  const unnamedPathM = segs.filter((s) => !s.name && (s.flags & 8))
    .reduce((sum, s) => sum + (s.lenM || 0), 0);
  return {
    unnamedPathM: Math.round(unnamedPathM),
    spoken: built.instructions.map((ins) => navInstructionText(ins)),
  };
});

check('the ride routes and enters a real stretch of unnamed path',
  !ride.failed && ride.unnamedPathM > 100, JSON.stringify(ride));
check('no prompt claims to stay on a street the turn is leaving',
  !ride.spoken.some((line) => /stay on Northeast 65th Street/i.test(line)),
  JSON.stringify(ride.spoken));
check('the turn onto the unnamed track names the path',
  ride.spoken.some((line) => /onto the (bike )?path, heading south/.test(line)),
  JSON.stringify(ride.spoken));
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
