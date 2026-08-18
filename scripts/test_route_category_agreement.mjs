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
      { sh: -128 }, { mph: 55, sh: 0 }, { mph: 45, sh: 2 }, { surface: 3 },
      { facilityGap: true, facility: 1, flags: 16, mph: 25, sh: 4 },
      { dismount: true, official: 136, dismountEscalated: true }]) {
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
// Cached bytes from older/saved routes may disagree with today's rider rules.
// Every consumer must treat all of these as the same underlying facts.
const SEGMENTS = [...scored,
  ...SHAPES.map((seg) => ({ ...seg, level: 0 })),
  ...SHAPES.map((seg, index) => ({ ...seg, level: index % 4 + 1 }))];

const fromApp = await app.evaluate((segs) =>
  segs.map((seg) => routeSegmentDisplayCategory(seg)), SEGMENTS);
const fromDetails = await details.evaluate((segs) =>
  segs.map((seg) => routeDisplayCategory(seg)), SEGMENTS);
const modelTruth = await app.evaluate((segs) => segs.map((seg) => {
  const props = routeSegProps(seg);
  let level = effectiveLevel(scoreRouteSeg(props));
  if (seg.facilityGap && level < 3) level = 3;
  if ((seg.flags || 0) & 32) return null;
  if (seg.crossing) return 'pass';
  if (seg.dismountEscalated) return 'fail';
  if (level === 4) return 'fail';
  if (isDismountSegment(seg) || level === 3 || seg.mtb) return 'caution';
  const bike = SafetyModel.isBikeNetwork(SafetyModel.sealFacts({
    infra: !!((seg.flags || 0) & 8) || (seg.facility || 0) >= 4,
    facility: Number(seg.facility) || 0,
    stressRating: Number(seg.lts) || null,
  }));
  return bike ? ((seg.facility || 0) === 5 ? 'trail' : 'bike') : 'pass';
}), SEGMENTS);

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
const modelDisagreements = SEGMENTS.flatMap((seg, index) =>
  fromApp[index] === modelTruth[index] && fromDetails[index] === modelTruth[index]
    ? [] : [{ seg, model: modelTruth[index], card: fromApp[index], details: fromDetails[index] }]);
check('the card and Details classifications both follow the model facts, not cached levels',
  modelDisagreements.length === 0, JSON.stringify(modelDisagreements.slice(0, 5)));

const gapFeatureLevel = await app.evaluate(() => routeSegmentMapFeature(
  [[-122.3185, 47.6556], [-122.3183, 47.6555]],
  { c0: 0, c1: 1, lenM: 16, facility: 1, flags: 16, mph: 25, sh: 4,
    facilityGap: true }, 0).properties.level);
check('a traffic-conflict connector is baked into the drawn route as amber', gapFeatureLevel === 3,
  `level ${gapFeatureLevel}`);

const riderFacing = await app.evaluate((segs) => {
  const cumulative = [0];
  const routeSegs = segs.map((seg, index) => {
    cumulative.push(cumulative[index] + (Number(seg.lenM) || 0));
    return { ...seg, c0: index, c1: index + 1 };
  });
  const summary = routeSummaryStats({ segs: routeSegs });
  const voice = buildRouteSafetyRuns(routeSegs, cumulative).map((run) => ({
    category: run.category, metres: run.endM - run.startM,
  }));
  return { categoryM: summary.categoryM, voice };
}, SEGMENTS.slice(0, 80));
const expectedM = Object.fromEntries(['trail', 'bike', 'pass', 'caution', 'fail']
  .map((category) => [category, 0]));
SEGMENTS.slice(0, 80).forEach((seg, index) => {
  const category = modelTruth[index];
  if (Object.hasOwn(expectedM, category)) expectedM[category] += Number(seg.lenM) || 0;
});
check('route-summary distances aggregate those same model-backed categories',
  JSON.stringify(riderFacing.categoryM) === JSON.stringify(expectedM),
  JSON.stringify({ actual: riderFacing.categoryM, expected: expectedM }));
check('voice-navigation runs use only those same model-backed categories',
  riderFacing.voice.every((run) => ['trail', 'bike', 'pass', 'caution', 'fail', 'ferry'].includes(run.category))
    && Math.round(riderFacing.voice.filter((run) => run.category !== 'ferry')
      .reduce((sum, run) => sum + run.metres, 0))
      === Math.round(Object.values(expectedM).reduce((sum, metres) => sum + metres, 0)),
  JSON.stringify(riderFacing.voice));

// A category outside the five buckets is silently dropped from the totals on
// both pages, so it must not be reachable from a real segment.
const stray = fromApp.filter((c) => c !== null && !['trail', 'bike', 'pass', 'caution', 'fail'].includes(c));
check('the route card produces no category outside the five it can total',
  stray.length === 0, [...new Set(stray)].join(', '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
