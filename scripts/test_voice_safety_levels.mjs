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
    ['caution', 300, { level: 3, mph: 25, sh: 4, lts: 4 }],
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
    maybeSpeakSafetyChange();
    if (said.length > before) heard.push({ at: m, text: said[said.length - 1] });
  }
  return { heard, runs: turnNav.route.safetyRuns.map((r) => r.category) };
});

check('the route resolves into one run per safety level',
  spoken.runs.join(',') === 'trail,bike,pass,caution,fail', JSON.stringify(spoken.runs));
check('every change is announced exactly once', spoken.heard.length === 5,
  JSON.stringify(spoken.heard));
const texts = spoken.heard.map((h) => h.text);
check('and each says what is coming, when, and how far it runs',
  texts[0] === 'Trail for next 1.0 miles.'
  && texts[1] === 'Bike lane in 150 feet, for 1.0 miles.'
  && texts[2] === 'Normal road in 150 feet, for 1.0 miles.'
  && texts[3] === 'Caution. Heavy traffic in 150 feet, for 0.2 miles.'
  && texts[4] === 'Warning. No shoulder in 150 feet, for 0.2 miles.',
  JSON.stringify(texts));
// Reported from the road: "Trail for next 3.4 miles" spoken while the rider was
// on an overpass over the freeway, 900 feet short of the trail. It read as a
// claim about the road under them. A stretch that has not started says when it
// does; only the one they are already in says "for next".
check('a stretch still ahead says how far off it is, not "next"',
  texts.slice(1).every((text) => / in [\d.]+ (feet|miles), for /.test(text)),
  JSON.stringify(texts));
// Brevity is the feature. A rider cannot hold a list at 15 mph.
check('nothing said is longer than a sentence',
  texts.every((text) => text.split(/\s+/).length <= 11), JSON.stringify(texts));
// Each announcement lands before the stretch it describes, not after.
const startsAt = [0, 1609, 3218, 4827, 5127];
check('each is spoken before the change, not after it',
  spoken.heard.every((h, i) => h.at <= startsAt[i]),
  JSON.stringify({ heard: spoken.heard.map((h) => h.at), startsAt }));
// The lead used to be 90 m -- under fifteen seconds of riding, and it was
// arriving after the road had changed. Far enough ahead to act on now, and not
// so far that it describes somewhere else.
check('and with real warning, not a few seconds',
  spoken.heard.every((h, i) => i === 0 || startsAt[i] - h.at >= 140),
  JSON.stringify({ leads: spoken.heard.map((h, i) => startsAt[i] - h.at) }));
check('but not so early it is about somewhere else',
  spoken.heard.every((h, i) => startsAt[i] - h.at <= 400),
  JSON.stringify({ leads: spoken.heard.map((h, i) => startsAt[i] - h.at) }));

/* ------------------------------------------ the concern, named specifically */
// "Use caution" tells a rider to be careful without telling them what of. Each
// of these roads is amber or red for a different reason, and the announcement
// has to name that reason -- one of them, the one that dominates the stretch.
const reasons = await page.evaluate(() => {
  const say = (seg) => {
    const segs = [{ lenM: 800, c0: 0, c1: 1, ...seg }];
    const cumulative = [0, 800];
    const runs = buildRouteSafetyRuns(segs, cumulative);
    const run = runs[0];
    return safetyRunSpeech(run.category, SAFETY_REASON_SPEECH[run.reason],
      navDistanceText(run.endM - run.startM), null);
  };
  return {
    freeway: say({ flags: 4, level: 4, mph: 60, sh: 8 }),
    fastNoShoulder: say({ level: 4, mph: 55, sh: 0 }),
    // Only reachable for a rider who set a cutoff, so set one.
    overCap: (() => {
      const before = { noUpperLimit: rules.noUpperLimit, upperMaxSpeed: rules.upperMaxSpeed };
      rules.noUpperLimit = false;
      rules.upperMaxSpeed = 45;
      const text = say({ level: 4, mph: 60, sh: 8 });
      Object.assign(rules, before);
      return text;
    })(),
    wide: say({ level: 4, mph: 25, sh: 0, lanes: 6 }),
    busy: say({ level: 4, mph: 25, sh: 0, measures: { adt: 40000 } }),
    stress: say({ level: 3, mph: 25, sh: 4, lts: 4 }),
    mtb: say({ level: 3, mtb: true, official: 4, flags: 8 }),
    limited: say({ level: 3, flags: 128, mph: 35, sh: 6 }),
    // Nothing specific to say: the plain wording, not an invented reason.
    plain: say({ level: 3, mph: 25, sh: 4, displayCategory: 'caution' }),
    // A stretch that is mostly one thing and briefly another says the one that
    // covers most of it.
    mixed: (() => {
      const segs = [
        { lenM: 700, c0: 0, c1: 1, level: 4, mph: 55, sh: 0 },
        { lenM: 100, c0: 1, c1: 2, level: 4, mph: 25, sh: 0, lanes: 6 },
      ];
      const runs = buildRouteSafetyRuns(segs, [0, 700, 800]);
      return SAFETY_REASON_SPEECH[runs[0].reason];
    })(),
  };
});
check('a freeway is named as one', /Warning\. Freeway for/.test(reasons.freeway), reasons.freeway);
check('a fast road with no shoulder says so',
  /Warning\. No shoulder for/.test(reasons.fastNoShoulder), reasons.fastNoShoulder);
check('a road over the rider\'s speed cutoff says that instead',
  /Warning\. High speed limit for/.test(reasons.overCap), reasons.overCap);
check('a wide slow road names its width, which "no shoulder" alone would hide',
  /Warning\. Wide road, no shoulder for/.test(reasons.wide), reasons.wide);
check('a busy slow road names the traffic',
  /Warning\. Heavy traffic, no shoulder for/.test(reasons.busy), reasons.busy);
check('an officially high-stress road is a caution about traffic',
  /Caution\. Heavy traffic for/.test(reasons.stress), reasons.stress);
check('a mountain-bike trail is named as one',
  /Caution\. Mountain bike trail for/.test(reasons.mtb), reasons.mtb);
check('a limited-access road is named as one',
  /Caution\. Limited access road for/.test(reasons.limited), reasons.limited);
check('and with nothing specific to say, it stays plain rather than inventing one',
  reasons.plain === 'Caution. Ride with care for next 0.5 miles.', reasons.plain);
check('a mixed stretch reports the reason covering most of it',
  reasons.mixed === 'No shoulder', JSON.stringify(reasons.mixed));

/* ------------------------- green, and still told what it runs alongside */
// A trusted bike lane on a road the agency rates worst-on-scale is not a
// caution -- the rider decided that -- but the rating is still a fact about the
// road, and they asked to hear it. It rides as an aside rather than an alert.
const headsUp = await page.evaluate(() => {
  const say = (seg) => {
    const segs = [{ lenM: 3200, c0: 0, c1: 1, ...seg }];
    const run = buildRouteSafetyRuns(segs, [0, 3200])[0];
    return { category: run.category, text: safetyRunSpeech(run.category,
      SAFETY_REASON_SPEECH[run.reason], navDistanceText(3200), navDistanceText(150),
      run.hasLane) };
  };
  // No stored level -- the point is what the rider's rules make of the road.
  const busyLane = { facility: 2, mph: 40, sh: 0, lanes: 5, lts: 4,
    measures: { adt: 21000, fc: 3 } };
  return {
    busyLane: say(busyLane),
    quiet: say({ facility: 2, mph: 25, sh: 4 }),
    separated: say({ facility: 4, flags: 8, mph: 40, sh: 0, lts: 4 }),
    noLane: say({ mph: 25, sh: 4, lts: 4 }),
  };
});
check('a bike lane on a busy road is announced as a bike lane, not a caution',
  headsUp.busyLane.category === 'pass'
    && /^Bike lane, heavy traffic in /.test(headsUp.busyLane.text), JSON.stringify(headsUp));
check('a busy road WITHOUT a lane is still the caution it was',
  headsUp.noLane.category === 'caution'
    && /^Caution\. Heavy traffic in /.test(headsUp.noLane.text), JSON.stringify(headsUp));
check('a bike lane on a quiet road says nothing extra',
  headsUp.quiet.text === 'Bike lane in 150 feet, for 2.0 miles.', JSON.stringify(headsUp));
check('and a separated lane on a busy road carries the same heads-up',
  /heavy traffic/.test(headsUp.separated.text), JSON.stringify(headsUp));

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
  const offCount = maybeSpeakSafetyChange() ? 1 : said.length;

  reset();
  navVoice.safetyLevels = true;
  // A turn coming up no longer holds this back. It used to, and because a
  // safety level almost always changes AT a junction the announcement kept
  // losing that moment to the maneuver prompt and arriving after the road had
  // already changed. The speech queue is what keeps the two apart now.
  const duringTurn = maybeSpeakSafetyChange();

  reset();
  turnNav.arrived = true;
  const arrived = maybeSpeakSafetyChange();
  turnNav.arrived = false;

  // A rider who joins the route halfway is told what they are on now, with the
  // distance that is left of it -- not the stretches already behind them.
  reset();
  turnNav.routeM = 3400;
  said.length = 0;
  const joinedLate = maybeSpeakSafetyChange();
  const joinedText = said[said.length - 1];
  const skipped = turnNav.route.safetyRuns.filter((r) => r.spoken).map((r) => r.category);
  return { offCount, duringTurn, arrived, joinedLate, joinedText, skipped,
    said: [...said] };
});
check('the option off means silence', guards.offCount === 0, JSON.stringify(guards));
check('an imminent turn no longer holds the safety change back',
  guards.duringTurn === true, JSON.stringify(guards));
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
