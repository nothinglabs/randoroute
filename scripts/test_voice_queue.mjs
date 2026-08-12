#!/usr/bin/env node
// Voice guidance used to talk over itself. Reported from the road: one prompt
// stopping abruptly so another could start.
//
// It was doing that on purpose. Both engines were told to interrupt --
// `synth.cancel()` before every web utterance, `stopSpeaking(at: .immediate)`
// inside the iOS plugin's speakText -- under a latest-wins rule. On a quiet
// route that is invisible. On a route where a turn, a safety change and a
// status update all come due within a few seconds, the rider hears three
// half-sentences and learns nothing from any of them.
//
// Nothing is handed to an engine now while that engine is still speaking. This
// drives the queue against a stand-in engine that reports when it finishes, so
// the overlap is observable: an utterance that begins before the previous one
// ended is a failure, and it would have been the normal case before.
import { chromiumPath, playwright, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const { chromium } = await playwright();
const browser = await chromium.launch({
  executablePath: chromiumPath(), args: ['--use-gl=swiftshader'],
});
const page = await (await browser.newContext({
  serviceWorkers: 'block', viewport: { width: 430, height: 900 },
})).newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(site.url, { waitUntil: 'load' });
await page.waitForFunction(() => typeof speakNavigation === 'function', { timeout: 60000 });

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};

// A stand-in for the browser's speech engine: it records what it is asked to
// say, when, and whether it was cut off, and finishes an utterance after a
// fixed time rather than a real one.
const install = () => page.evaluate(() => {
  window.__said = [];
  let current = null;
  let clock = 0;
  // window.speechSynthesis is a read-only accessor on Window; a plain
  // assignment is silently ignored and the stand-in never installs.
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
    speak(utterance) {
      const entry = { text: utterance.text, at: clock, ended: null, cancelled: false };
      window.__said.push(entry);
      current = { entry, utterance };
      setTimeout(() => {
        if (!current || current.entry !== entry) return;
        entry.ended = ++clock;
        current = null;
        utterance.onend?.();
      }, 60);
    },
    cancel() {
      if (!current) return;
      current.entry.cancelled = true;
      current.entry.ended = ++clock;
      const { utterance } = current;
      current = null;
      utterance.onend?.();
    },
    resume() {},
    getVoices: () => [],
    addEventListener() {},
  } });
  clearSpeechQueue();
});

/* ------------------------------------------ three prompts in the same instant */
await install();
await page.evaluate(() => {
  speakNavigation('Turn left onto Fremont Avenue North.', 'turn');
  speakNavigation('Caution. Heavy traffic for next 2.0 miles.', 'safety');
  speakNavigation('Speed 12 miles per hour. 4.0 miles remaining.', 'status');
});
await page.waitForFunction(() => window.__said.length === 3 && window.__said[2].ended != null,
  { timeout: 10000 }).catch(() => {});
const burst = await page.evaluate(() => window.__said);
check('all three are said, none dropped', burst.length === 3, JSON.stringify(burst));
check('and none of them is cut off', burst.every((entry) => !entry.cancelled),
  JSON.stringify(burst));
check('each waits for the one before it to finish',
  burst.every((entry, index) => index === 0 || entry.at >= burst[index - 1].ended),
  JSON.stringify(burst));
check('the maneuver is said first, then the safety change, then the status',
  burst.map((entry) => entry.text.slice(0, 6)).join('|') === 'Turn l|Cautio|Speed ',
  JSON.stringify(burst.map((entry) => entry.text)));

/* -------------------------------- rank decides, whatever order they arrive in */
await install();
await page.evaluate(() => {
  speakNavigation('Speed 12 miles per hour.', 'status');
  speakNavigation('Caution. No shoulder for next 0.5 miles.', 'safety');
});
await page.waitForFunction(() => window.__said.length === 2, { timeout: 10000 }).catch(() => {});
const ranked = await page.evaluate(() => window.__said);
check('a status update already speaking is not restarted or dropped',
  ranked[0]?.text.startsWith('Speed') && !ranked[0]?.cancelled, JSON.stringify(ranked));
check('and the safety change follows it', ranked[1]?.text.startsWith('Caution'),
  JSON.stringify(ranked));

/* ---------------------------- a maneuver follows, but never clips, active speech */
await install();
await page.evaluate(async () => {
  speakNavigation('Caution. Heavy traffic for next 3.0 miles.', 'safety');
  await new Promise((resolve) => setTimeout(resolve, 10));
  speakNavigation('Turn right onto North 110th Street.', 'turn');
});
await page.waitForFunction(() => window.__said.length === 2 && window.__said[1].ended != null,
  { timeout: 10000 }).catch(() => {});
const urgent = await page.evaluate(() => window.__said);
check('a maneuver waits for an active safety sentence to finish cleanly',
  urgent[0]?.text.startsWith('Caution') && !urgent[0]?.cancelled
    && urgent[1]?.text.startsWith('Turn right') && urgent[1].at >= urgent[0].ended,
  JSON.stringify(urgent));

/* --------------------------- a turn discards summaries that are still waiting */
await install();
const superseded = await page.evaluate(async () => {
  speakNavigation('First sentence already playing.', 'turn');
  speakNavigation('Speed 12 miles per hour.', 'status');
  speakNavigation('Caution. Heavy traffic for next 3.0 miles.', 'safety');
  await new Promise((resolve) => setTimeout(resolve, 10));
  speakNavigation('Turn right onto North 110th Street.', 'turn');
  await new Promise((resolve) => setTimeout(resolve, 300));
  return window.__said;
});
check('a new maneuver drops queued summaries instead of delaying behind them',
  superseded.length === 2
    && superseded[0].text.startsWith('First sentence')
    && superseded[1].text.startsWith('Turn right')
    && superseded.every((entry) => !entry.cancelled),
  JSON.stringify(superseded));

/* --------------------------- an engine that stops reporting must not talk over */
// The web engine's onend can simply never arrive (mobile Safari drops it when
// the page is backgrounded mid-utterance). The watchdog that rescues the queue
// used to fire on a fixed estimate even while the engine was audibly still
// speaking. It has to believe synth.speaking first.
await install();
const patient = await page.evaluate(async () => {
  // An engine that never reports the end, and admits it is still speaking.
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
    speaking: true,
    speak(utterance) { window.__said.push({ text: utterance.text, ended: null }); },
    cancel() {}, resume() {}, getVoices: () => [], addEventListener() {},
  } });
  clearSpeechQueue();
  speakNavigation('Turn left onto Fremont Avenue North.', 'turn');
  speakNavigation('Turn right onto North 110th Street.', 'turn');
  // Well past the spoken estimate plus the old 4 s grace.
  await new Promise((resolve) => setTimeout(resolve, 7000));
  return {
    said: window.__said.map((entry) => entry.text),
    speaking: window.speechSynthesis.speaking,
    active: speechActive?.text || null,
    queued: speechQueue.map((entry) => entry.text),
  };
});
check('a prompt is not sent while the engine says it is still speaking',
  patient.said.length === 1 && patient.said[0].startsWith('Turn left'), JSON.stringify(patient));

/* ------------------------------------------------- and stale prompts are dropped */
await install();
const stale = await page.evaluate(async () => {
  // Hold the queue with one long utterance, then age a status update past the
  // point where it still describes where the rider is.
  speakNavigation('Turn left onto Fremont Avenue North.', 'turn');
  speakNavigation('Speed 12 miles per hour.', 'status');
  speechQueue[0].queuedAt -= 60000;
  await new Promise((resolve) => setTimeout(resolve, 300));
  return window.__said.map((entry) => entry.text);
});
check('a prompt that waited too long is not said late',
  stale.length === 1 && stale[0].startsWith('Turn left'), JSON.stringify(stale));

/* ------------------------------------------- stopping navigation stops the voice */
await install();
const stopped = await page.evaluate(async () => {
  speakNavigation('Turn left onto Fremont Avenue North.', 'turn');
  speakNavigation('Caution. No shoulder for next 0.5 miles.', 'safety');
  clearSpeechQueue();
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { said: window.__said.map((entry) => entry.text), queued: speechQueue.length };
});
check('ending a ride silences what was still waiting',
  stopped.said.length === 1 && stopped.queued === 0, JSON.stringify(stopped));

/* ---------------------- native speech advances on its real delegate callback */
const nativePacing = await page.evaluate(async () => {
  clearSpeechQueue();
  const realPlugin = window.nativeNavigationPlugin;
  window.__nativeSpeechHandlers = {};
  window.__nativeSaid = [];
  window.nativeNavigationPlugin = () => ({
    addListener(name, handler) {
      window.__nativeSpeechHandlers[name] = handler;
      return Promise.resolve({ remove() {} });
    },
    speak(payload) {
      window.__nativeSaid.push(payload);
      return Promise.resolve();
    },
    stopSpeaking() { return Promise.resolve(); },
  });
  nativeNavigationListenersReady = null;
  speakNavigation('Native first sentence.', 'turn');
  speakNavigation('Native second sentence.', 'turn');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const beforeFinish = window.__nativeSaid.map((item) => ({ ...item }));
  const first = beforeFinish[0];
  window.__nativeSpeechHandlers.speechFinished?.({
    speechId: first?.speechId,
    cancelled: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const afterFinish = window.__nativeSaid.map((item) => ({ ...item }));
  clearSpeechQueue();
  window.nativeNavigationPlugin = realPlugin;
  nativeNavigationListenersReady = null;
  return { beforeFinish, afterFinish };
});
check('native voice waits for the real end event instead of a duration guess',
  nativePacing.beforeFinish.length === 1
    && nativePacing.beforeFinish[0].text.startsWith('Native first'),
  JSON.stringify(nativePacing));
check('the next native prompt starts when the delegate reports completion',
  nativePacing.afterFinish.length === 2
    && nativePacing.afterFinish[1].text.startsWith('Native second')
    && nativePacing.afterFinish[1].speechId !== nativePacing.afterFinish[0].speechId,
  JSON.stringify(nativePacing));

check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
