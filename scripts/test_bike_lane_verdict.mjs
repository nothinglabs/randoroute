#!/usr/bin/env node
// A bike lane of any kind means the road PASSES, and a painted one on a road
// the agency rates worst-on-scale is not bike NETWORK.
//
// Those are two separate claims and both have to hold, because they live in
// different code. The first is the safety ladder: the traffic caution exists
// for roads whose space is not the rider's, and a lane is space that is. The
// second is the colour: lime is a recommendation, not an inventory, so a lane
// on a 21,000-vehicles-a-day arterial draws blue with the other passing roads.
//
// Get only the first and Bothell-Everett Highway turns lime, which says the
// wrong thing more loudly than the amber did.
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

// Bothell-Everett Highway, as the road card reported it, and the same road with
// every grade of facility and a low rating for contrast.
const seen = await page.evaluate(() => {
  const BUSY = { mph: 40, sh: 0, lanes: 5, official: 64, lts: 4,
    measures: { adt: 21000, fc: 3 } };
  const look = (extra) => {
    const props = { ...BUSY, ...extra };
    const scored = scoreRouteSeg({ ...props, ferry: 0, fw: 0, lim: 0,
      infra: props.facility >= 4 ? 1 : 0 });
    const verdict = evaluateRoad(scored);
    return {
      level: verdict.level,
      caution: verdict.caution,
      highStress: verdict.highStress,
      lime: isBikeNetworkVerdict(scored),
      style: routeVisualStyle({ ...props, level: verdict.level,
        infra: props.facility >= 4 ? 1 : 0, mtb: 0, crossing: 0, ferry: 0 }),
    };
  };
  return {
    none: look({ facility: 0 }),
    sharrow: look({ facility: 1 }),
    lane: look({ facility: 2 }),
    buffered: look({ facility: 3 }),
    separated: look({ facility: 4 }),
    quietLane: look({ facility: 2, lts: 1 }),
    overCap: (() => {
      const before = { noUpperLimit: rules.noUpperLimit, upperMaxSpeed: rules.upperMaxSpeed };
      rules.noUpperLimit = false; rules.upperMaxSpeed = 35;
      const out = look({ facility: 2, mph: 60 });
      Object.assign(rules, before);
      return out;
    })(),
    freeway: (() => {
      const scored = scoreRouteSeg({ ...BUSY, facility: 2, fw: 1, lim: 1, infra: 0 });
      return { level: evaluateRoad(scored).level };
    })(),
    limited: (() => {
      const scored = scoreRouteSeg({ ...BUSY, facility: 2, fw: 0, lim: 1, infra: 0 });
      const verdict = evaluateRoad(scored);
      return { level: verdict.level, caution: verdict.caution };
    })(),
  };
});

/* --------------------------------------------- the road passes the rules */
check('a bike lane on a very busy road passes rather than cautioning',
  seen.lane.level === 2 && seen.lane.caution === null, JSON.stringify(seen.lane));
check('and so does a buffered lane',
  seen.buffered.level === 2 && seen.buffered.caution === null, JSON.stringify(seen.buffered));
check('the same road without one still fails on its own merits',
  seen.none.level === 4, JSON.stringify(seen.none));
check('a sharrow is paint in the traffic lane and earns nothing',
  seen.sharrow.level === 4, JSON.stringify(seen.sharrow));

/* ------------------------------------- but it does not become bike network */
check('a painted lane on a road rated 4 of 4 draws blue, not lime',
  seen.lane.lime === false && seen.lane.style === 'pass', JSON.stringify(seen.lane));
check('the same lane on a road rated 1 of 4 keeps its lime',
  seen.quietLane.lime === true && seen.quietLane.style === 'bike',
  JSON.stringify(seen.quietLane));
check('a SEPARATED lane keeps its lime whatever the rating says',
  seen.separated.lime === true && seen.separated.style === 'bike',
  JSON.stringify(seen.separated));

/* ------------------------------------------ and the hard rungs are untouched */
check('a bike lane cannot carry a road past the rider speed ceiling',
  seen.overCap.level === 4, JSON.stringify(seen.overCap));
check('nor onto a freeway', seen.freeway.level === 4, JSON.stringify(seen.freeway));
check('a stripe does not fix a ramp merging across the rider',
  seen.limited.level === 3 && seen.limited.caution === 'limited-access',
  JSON.stringify(seen.limited));

/* ------------------------- the rating is still a fact, and still reported */
check('the stress rating is reported whatever the verdict',
  seen.lane.highStress === true && seen.separated.highStress === true,
  JSON.stringify([seen.lane.highStress, seen.separated.highStress]));

// The voice describes the road, not the colour: "normal road" would be false
// where there is a lane under the rider's wheels.
const spoken = await page.evaluate(() => {
  const segs = [{ lenM: 3200, c0: 0, c1: 1, facility: 2, mph: 40, sh: 0, lanes: 5,
    lts: 4, measures: { adt: 21000, fc: 3 } }];
  const run = buildRouteSafetyRuns(segs, [0, 3200])[0];
  return { category: run.category, hasLane: run.hasLane,
    text: safetyRunSpeech(run.category, SAFETY_REASON_SPEECH[run.reason],
      navDistanceText(3200), navDistanceText(150), run.hasLane) };
});
check('it is announced as a bike lane with the traffic named',
  /^Bike lane, heavy traffic in /.test(spoken.text), JSON.stringify(spoken));

check('no page errors', page.pageErrors.length === 0, page.pageErrors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
