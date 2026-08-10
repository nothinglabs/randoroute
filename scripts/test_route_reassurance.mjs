#!/usr/bin/env node
// Reported from the road: a mile of Northeast Ravenna Boulevard with the next
// maneuver 0.6 miles off, and nothing said the whole way.
//
// Silence is ambiguous. It means "carry on" and it means "the app has stopped
// working", and a rider cannot tell which without taking a hand off the bars
// and looking down. So on a long stretch the app says the reassuring thing:
// which road they are on, and how far the next turn is.
//
// It is deliberately NOT the periodic status report, which carries speed, miles
// remaining and ETA, is off unless a rider asks for it, and is a mouthful. This
// is one short line whose only job is to confirm nothing has gone wrong, so it
// is on by default and says as little as it can.
import { appPage, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);
await page.waitForFunction(() => typeof maybeSpeakRouteReassurance === 'function'
  && typeof navVoice === 'object', { timeout: 60000 });

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

// Drive the decision directly with a captured speech channel: what matters is
// which line comes out and when, not how the engine renders it.
const setup = await page.evaluate(() => {
  window.__spoken = [];
  window.__stubReassurance = ({ silentMs, road, nativeTracking = false,
    arrived = false, locationReady = true, on = true }) => {
    window.__spoken = [];
    navVoice.reassure = on;
    turnNav.nativeTracking = nativeTracking;
    turnNav.arrived = arrived;
    turnNav.locationReady = locationReady;
    turnNav.lastVoiceAt = Date.now() - silentMs;
    navCurrentSegment = () => (road === null ? null : { name: road, lenM: 300 });
    speakNavigation = (text, kind) => { window.__spoken.push({ text, kind }); };
  };
  return typeof speakNavigation === 'function';
});
check('the speech channel can be captured', setup === true);

const spoke = async (options, next, remainingM) => page.evaluate(
  ([opts, hasNext, remaining]) => {
    window.__stubReassurance(opts);
    const instruction = hasNext ? { distanceM: remaining, text: 'Bear left', heading: 'west' } : null;
    const result = maybeSpeakRouteReassurance(instruction, remaining);
    return { result, spoken: window.__spoken };
  }, [options, !!next, remainingM]);

/* ------------------------------------------------------- the reported case */
const long = await spoke({ silentMs: 120000, road: 'Northeast Ravenna Boulevard' },
  true, 1000);
check('a long silence with the next turn far off is filled',
  long.result === true && long.spoken.length === 1, JSON.stringify(long));
check('naming the road the rider is on, which is the reassuring part',
  /Northeast Ravenna Boulevard/.test(long.spoken[0]?.text || ''), long.spoken[0]?.text);
check('and how far the next turn is',
  /next turn in/i.test(long.spoken[0]?.text || ''), long.spoken[0]?.text);
check('as a status line, so a turn or a hazard always outranks it',
  long.spoken[0]?.kind === 'status', JSON.stringify(long.spoken[0]));
// One line, not a report. The rider asked for casual, not a briefing.
check('and it stays short -- no speed, no ETA, no miles remaining',
  !/speed|remaining|left|miles per hour/i.test(long.spoken[0]?.text || ''),
  long.spoken[0]?.text);

/* ------------------------------------------------- when it must stay quiet */
const recent = await spoke({ silentMs: 20000, road: 'Northeast Ravenna Boulevard' },
  true, 1000);
check('nothing is said while the last prompt is still recent',
  recent.result === false && recent.spoken.length === 0, JSON.stringify(recent));

// Close to a turn, the turn's own prompt is the reassurance. Speaking here
// would put a "still on" line directly in front of a maneuver.
const nearTurn = await spoke({ silentMs: 120000, road: 'Northeast Ravenna Boulevard' },
  true, 200);
check('nothing is said right before a maneuver',
  nearTurn.result === false && nearTurn.spoken.length === 0, JSON.stringify(nearTurn));

// "You are on an unnamed road" tells the rider less than the silence did.
const unnamed = await spoke({ silentMs: 120000, road: '' }, true, 1000);
check('an unnamed road is left alone rather than announced as unnamed',
  unnamed.result === false && unnamed.spoken.length === 0, JSON.stringify(unnamed));

const noSegment = await spoke({ silentMs: 120000, road: null }, true, 1000);
check('and so is a stretch with no segment matched at all',
  noSegment.result === false, JSON.stringify(noSegment));

const off = await spoke({ silentMs: 120000, road: 'Northeast Ravenna Boulevard', on: false },
  true, 1000);
check('a rider who turns it off gets the silence back',
  off.result === false && off.spoken.length === 0, JSON.stringify(off));

// The native guide owns the cadence on iOS, foreground and background alike.
// Speaking from here too would double every line on a phone.
const native = await spoke(
  { silentMs: 120000, road: 'Northeast Ravenna Boulevard', nativeTracking: true }, true, 1000);
check('the web path defers to the native guide on a phone',
  native.result === false && native.spoken.length === 0, JSON.stringify(native));

const arrived = await spoke(
  { silentMs: 120000, road: 'Northeast Ravenna Boulevard', arrived: true }, true, 1000);
check('and says nothing once the rider has arrived',
  arrived.result === false, JSON.stringify(arrived));

const noFix = await spoke(
  { silentMs: 120000, road: 'Northeast Ravenna Boulevard', locationReady: false }, true, 1000);
check('or before there is a location fix to be reassuring about',
  noFix.result === false, JSON.stringify(noFix));

/* ------------------------------------------------ the last leg has no turn */
const lastLeg = await spoke({ silentMs: 120000, road: 'Green Lake Way North' }, false, Infinity);
check('the run to the destination says so instead of naming a turn',
  lastLeg.result === true && /continue to your destination/i.test(lastLeg.spoken[0]?.text || ''),
  lastLeg.spoken[0]?.text);

/* ------------------------------------------------------------ the setting */
const setting = await page.evaluate(() => {
  buildRulesPanel();
  const box = document.getElementById('v-voiceReassure');
  return {
    exists: !!box,
    checkedByDefault: !!box?.checked,
    label: box?.closest('label')?.textContent.trim(),
  };
});
check('it is on by default, because silence is the thing being fixed',
  setting.exists && setting.checkedByDefault, JSON.stringify(setting));
check('and it says what it does', /confirm the road/i.test(setting.label || ''), setting.label);

check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
