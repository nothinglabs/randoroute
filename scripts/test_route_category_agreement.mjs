#!/usr/bin/env node
// The route card and the Route Details page print the same five percentages
// about the same route -- from two separate classifiers, in two files that
// cannot import each other: routeVisualStyle() in app.js and
// routeDisplayCategory() in route-details.js. route-details.js says so in a
// comment ("mirrors routeVisualStyle() in app.js"), and a comment is not a
// guarantee: the moment one of them learns a rule the other has not, a rider
// reads "25% Needs Caution" on one screen and 27% on the next.
//
// So run both, in their own real pages, over the same segment shapes, and
// require the same answer. This is what makes the duplication safe rather than
// merely deliberate.
import { chromiumPath, playwright, serveRepo } from './testlib/harness.mjs';

const { chromium } = await playwright();
const site = await serveRepo();
const browser = await chromium.launch({
  executablePath: chromiumPath(), args: ['--use-gl=swiftshader'],
});
const context = await browser.newContext({ serviceWorkers: 'block',
  viewport: { width: 430, height: 900 } });

const app = await context.newPage();
await app.goto(`http://localhost:${site.port}/index.html`, { waitUntil: 'load' });
await app.waitForFunction(() => typeof routeSegmentDisplayCategory === 'function',
  { timeout: 60000 });

// Both pages must be judging against the same rules, or a disagreement says
// nothing about the classifiers. Hand Route Details the rules the app is
// actually using before it loads.
const rules = await app.evaluate(() => JSON.parse(JSON.stringify(rules)));
const details = await context.newPage();
await details.addInitScript((liveRules) => {
  localStorage.setItem('wa-bike-route-details-1', JSON.stringify({
    rules: liveRules, summary: { distM: 0, timeS: 0 }, segs: [],
  }));
}, rules);
await details.goto(`http://localhost:${site.port}/route-details.html`, { waitUntil: 'load' });
await details.waitForFunction(() => typeof routeDisplayCategory === 'function', { timeout: 60000 });
const sameRules = await details.evaluate((live) =>
  JSON.stringify(details?.rules || null) === JSON.stringify(live), rules);

// Every combination that can change the answer, and several that should not.
const SHAPES = [];
for (const facility of [0, 1, 2, 3, 4, 5]) {
  for (const flags of [0, 4, 8, 32, 64, 128]) {
    for (const extra of [{}, { mtb: true, official: 4 }, { crossing: 1 },
      { sh: -128 }, { mph: 55, sh: 0 }, { mph: 45, sh: 2 }, { surface: 3 }]) {
      SHAPES.push({ lenM: 100, facility, flags, mph: 30, sh: 4, c0: 0, c1: 1, ...extra });
    }
  }
}
// A stored segment's level comes from the safety model, so give each shape the
// level that model actually assigns it. Inventing a level that contradicts the
// facts -- level 1 on a 55 mph road with no shoulder -- would only measure
// which side re-scores, which is not the question.
const scored = await app.evaluate((shapes) =>
  shapes.map((seg) => ({ ...seg, level: fallbackRouteLevel(seg) })), SHAPES);
// ...and level 0 as well: an older release stored routes without one, and
// "not scored" must not be read as "fine" on either page.
const SEGMENTS = [...scored, ...SHAPES.map((seg) => ({ ...seg, level: 0 }))];

const fromApp = await app.evaluate((segs) =>
  segs.map((seg) => routeSegmentDisplayCategory(seg)), SEGMENTS);
const fromDetails = await details.evaluate((segs) =>
  segs.map((seg) => routeDisplayCategory(seg)), SEGMENTS);

const disagreements = [];
SEGMENTS.forEach((seg, i) => {
  if (fromApp[i] === fromDetails[i]) return;
  disagreements.push({ seg, card: fromApp[i], details: fromDetails[i] });
});

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};

check('both pages are judging against the same rules', sameRules);
check(`both pages classify all ${SEGMENTS.length} segment shapes the same way`,
  disagreements.length === 0,
  disagreements.slice(0, 5).map((d) =>
    `${JSON.stringify(d.seg)} -> card ${d.card}, details ${d.details}`).join(' | '));

// A category outside the five buckets is silently dropped from the totals on
// both pages, so it must not be reachable from a real segment.
const stray = fromApp.filter((c) => c !== null && !['trail', 'bike', 'pass', 'caution', 'fail'].includes(c));
check('the route card produces no category outside the five it can total',
  stray.length === 0, [...new Set(stray)].join(', '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
