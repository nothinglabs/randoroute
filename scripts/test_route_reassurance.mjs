#!/usr/bin/env node
// Periodic status is strictly opt-in. A former always-on reassurance path said
// “Still on …” after a quiet stretch even when Settings said Status update:
// Never. Exercise the public status decision and Voice panel so that silence
// remains silence unless the rider chooses a cadence.
import { appPage, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);
await page.waitForFunction(() => typeof maybeSpeakPeriodicUpdate === 'function'
  && typeof buildVoicePanel === 'function', { timeout: 60000 });

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

const runStatus = (updateMin, silentMs, { nativeTracking = false } = {}) => page.evaluate(
  ([minutes, quietFor, native]) => {
    window.__spoken = [];
    window.speakNavigation = (text, kind) => window.__spoken.push({ text, kind });
    navVoice.updateMin = minutes;
    navVoice.statusRoute = true;
    navVoice.statusSpeed = true;
    navVoice.statusMiles = true;
    navVoice.statusEta = true;
    turnNav.nativeTracking = native;
    turnNav.arrived = false;
    turnNav.lastVoiceAt = Date.now() - quietFor;
    turnNav.speedMph = 12;
    turnNav.routeM = 1000;
    turnNav.route = { totalM: 5000, totalTimeS: 1800 };
    turnNav.plannedRoute = turnNav.route;
    const next = { text: 'Turn left onto Greenwood Avenue', distanceM: 2200 };
    maybeSpeakPeriodicUpdate(next, 1200);
    return window.__spoken;
  }, [updateMin, silentMs, nativeTracking]);

const never = await runStatus(0, 10 * 60000);
check('Status update: Never stays silent even after a long unchanged stretch',
  never.length === 0, JSON.stringify(never));

const optedIn = await runStatus(1, 61000);
check('an opted-in cadence still produces a useful status summary',
  optedIn.length === 1 && optedIn[0].kind === 'status'
    && /Greenwood Avenue/i.test(optedIn[0].text), JSON.stringify(optedIn));
check('the status is not an unsolicited “Still on” reassurance',
  !/still on/i.test(optedIn[0]?.text || ''), optedIn[0]?.text);

const tooSoon = await runStatus(2, 61000);
check('the chosen cadence is respected', tooSoon.length === 0, JSON.stringify(tooSoon));

const nativeOwned = await runStatus(1, 61000, { nativeTracking: true });
check('the web layer does not duplicate native iOS status speech',
  nativeOwned.length === 0, JSON.stringify(nativeOwned));

const panel = await page.evaluate(() => {
  navVoice.updateMin = 0;
  buildVoicePanel();
  return {
    defaultCadence: document.getElementById('r-voiceUpdate')?.value,
    labels: [...document.querySelectorAll('#settingsVoice label')]
      .map((label) => label.textContent.trim()),
  };
});
check('the Voice panel defaults the periodic cadence to Never',
  panel.defaultCadence === '0', JSON.stringify(panel));
check('the removed automatic road reassurance is no longer offered',
  !panel.labels.some((label) => /confirm the road/i.test(label)), JSON.stringify(panel.labels));

check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
