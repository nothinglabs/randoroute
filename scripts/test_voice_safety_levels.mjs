#!/usr/bin/env node
// "Announce route safety levels": at each change of how the route paints, the
// rider hears what is coming and how far it runs, just before they reach it.
//
// The interesting part is not the wording, it is the bookkeeping -- a run must
// be announced once, ahead of itself, in order, and never over the top of a
// turn instruction. All of that is decided by maybeSpeakSafetyChange() against
// turnNav.routeM, so this drives that distance directly and records what would
// have been spoken.
import { appPage, chromiumPath, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};

// A route that changes character four times: a mile of trail, a mile of bike
// lane, a mile of ordinary road, a short caution stretch, then a short failure.
const spoken = await page.evaluate(() => {
  const said = [];
  window.speakNavigation = (text) => said.push(text);
  const runs = [
    ['trail', 1609, { flags: 8, facility: 5, level: 1 }],
    ['bike', 1609, { facility: 2, level: 1, mph: 25, sh: 4 }],
    ['pass', 1609, { level: 1, mph: 25, sh: 4 }],
    ['caution', 300, { level: 3, mph: 35, sh: 0 }],
    ['fail', 300, { level: 4, mph: 55, sh: 0 }],
  ];
  const segs = [];
  const cumulative = [0];
  runs.forEach((entry, index) => {
    segs.push({ ...entry[2], lenM: entry[1], c0: index, c1: index + 1 });
    cumulative.push(cumulative[index] + entry[1]);
  });
  navVoice.safetyLevels = true;
  turnNav.active = true;
  turnNav.arrived = false;
  turnNav.route = {
    segs, cumulative, instructions: [],
    safetyRuns: buildRouteSafetyRuns(segs, cumulative),
    totalM: cumulative[cumulative.length - 1],
  };
  // Walk the route in 10 m steps and collect what gets said, and where.
  const heard = [];
  for (let m = 0; m <= turnNav.route.totalM; m += 10) {
    turnNav.routeM = m;
    const before = said.length;
    maybeSpeakSafetyChange(null, Infinity);
    if (said.length > before) heard.push({ at: m, text: said[said.length - 1] });
  }
  return { heard, runs: turnNav.route.safetyRuns.map((r) => r.category) };
});

check('the route resolves into one run per safety level',
  spoken.runs.join(',') === 'trail,bike,pass,caution,fail', JSON.stringify(spoken.runs));
check('every change is announced exactly once', spoken.heard.length === 5,
  JSON.stringify(spoken.heard));
const texts = spoken.heard.map((h) => h.text);
check('and each says what is coming and how far it runs',
  texts[0] === 'Trail for next 1.0 miles.'
  && texts[1] === 'Bike lane for next 1.0 miles.'
  && texts[2] === 'Normal road for next 1.0 miles.'
  && texts[3] === 'Use caution next 0.2 miles.'
  && texts[4] === 'Warning - safety alert next 0.2 miles.',
  JSON.stringify(texts));
// Each announcement lands before the stretch it describes, not after.
const startsAt = [0, 1609, 3218, 4827, 5127];
check('each is spoken before the change, not after it',
  spoken.heard.every((h, i) => h.at <= startsAt[i] && startsAt[i] - h.at <= 100),
  JSON.stringify({ heard: spoken.heard.map((h) => h.at), startsAt }));

/* -------------------------------------------- the guards around the feature */
const guards = await page.evaluate(() => {
  const said = [];
  window.speakNavigation = (text) => said.push(text);
  const reset = () => {
    for (const run of turnNav.route.safetyRuns) run.spoken = false;
    turnNav.routeM = 0;
    said.length = 0;
  };

  reset();
  navVoice.safetyLevels = false;
  const offCount = maybeSpeakSafetyChange(null, Infinity) ? 1 : said.length;

  reset();
  navVoice.safetyLevels = true;
  // A turn is 40 m away: the turn owns the rider's attention.
  const duringTurn = maybeSpeakSafetyChange({ distanceM: 40 }, 40);

  // ...and the run is still waiting once the turn is behind them.
  const afterTurn = maybeSpeakSafetyChange({ distanceM: 900 }, 900);

  reset();
  turnNav.arrived = true;
  const arrived = maybeSpeakSafetyChange(null, Infinity);
  turnNav.arrived = false;

  // A rider who joins the route halfway is told what they are on now, with the
  // distance that is left of it -- not the stretches already behind them.
  reset();
  turnNav.routeM = 3400;
  said.length = 0;
  const joinedLate = maybeSpeakSafetyChange(null, Infinity);
  const joinedText = said[said.length - 1];
  const skipped = turnNav.route.safetyRuns.filter((r) => r.spoken).map((r) => r.category);
  return { offCount, duringTurn, afterTurn, arrived, joinedLate, joinedText, skipped,
    said: [...said] };
});
check('the option off means silence', guards.offCount === 0, JSON.stringify(guards));
check('a safety change never talks over an imminent turn', guards.duringTurn === false,
  JSON.stringify(guards));
check('and is still announced once the turn has passed', guards.afterTurn === true,
  JSON.stringify(guards));
check('nothing is announced after arrival', guards.arrived === false, JSON.stringify(guards));
check('joining mid-route skips the stretches already behind',
  guards.skipped.join(',') === 'trail,bike,pass', JSON.stringify(guards));
check('and reports what is left of the stretch, not its full length',
  guards.joinedLate === true && guards.joinedText === 'Normal road for next 0.9 miles.',
  JSON.stringify(guards));

const persisted = await page.evaluate(() => {
  const box = document.getElementById('v-voiceSafetyLevels');
  if (!box) return { missing: true };
  const before = navVoice.safetyLevels;
  box.checked = !before;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  const after = navVoice.safetyLevels;
  box.checked = before;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  return { before, after, restored: navVoice.safetyLevels };
});
check('the setting exists and the checkbox drives it',
  !persisted.missing && persisted.after === !persisted.before
    && persisted.restored === persisted.before, JSON.stringify(persisted));

check('no page errors', page.pageErrors.length === 0, page.pageErrors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
