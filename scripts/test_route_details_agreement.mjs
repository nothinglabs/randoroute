#!/usr/bin/env node
// Route Details is a report over SafetyModel, never a second verdict engine.
// Exercise the real page with a deliberately stale stored level, then sweep
// realistic segment fact combinations and compare every answer with the model.
import { chromiumPath, playwright, serveRepo } from './testlib/harness.mjs';

const { chromium } = await playwright();
const site = await serveRepo();
const browser = await chromium.launch({
  executablePath: chromiumPath(), args: ['--use-gl=swiftshader'],
});
const page = await (await browser.newContext({
  serviceWorkers: 'block', viewport: { width: 430, height: 900 },
})).newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};

const rules = {
  maxSpeedNoShoulder: 35,
  minShoulder: 6,
  inferShoulderFromEdge: false,
  lanesNoShoulderOver: 4,
  busyNoShoulder: 2,
  noUpperLimit: true,
  upperMaxSpeed: 55,
  allowSidewalkFallback: true,
  allowMtbTrails: false,
};
const stale = {
  name: 'Stale Stored Verdict Road', lenM: 1000, mph: 45, sh: 5,
  lanes: 2, facility: 0, flags: 0, official: 0,
  // This is deliberately wrong under the rules above. The page must ignore it.
  level: 1, c0: 0, c1: 1,
};
await page.goto(`http://localhost:${site.port}/route-details.html`, { waitUntil: 'load' });
await page.evaluate(({ liveRules, seg }) => {
  localStorage.setItem('wa-bike-route-details-1', JSON.stringify({
    rules: liveRules,
    summary: { distM: seg.lenM, timeS: 240, ascentM: 0, descentM: 0 },
    segs: [seg],
  }));
}, { liveRules: rules, seg: stale });
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => typeof routeSegmentLevel === 'function'
  && typeof routeSummaryStats === 'function');

const staleResult = await page.evaluate((seg) => {
  const model = SafetyModel.evaluate(routeSegmentFacts(seg), details.rules).level;
  const step = buildRouteSteps([seg])[0];
  return {
    model,
    reported: routeSegmentLevel(seg),
    verdict: safetyVerdict(seg),
    step: { safetyLabel: step?.safetyLabel, safetyClass: step?.safetyClass },
    mix: document.getElementById('summaryMix').textContent.replace(/\s+/g, ' ').trim(),
  };
}, stale);
const failConcern = await page.evaluate(() => {
  document.querySelector('#concern-fails .concern-section-toggle')?.click();
  return document.querySelector('#concern-fails .concern-section-body')?.textContent
    .replace(/\s+/g, ' ').trim() || '';
});
check('a stale stored pass is re-evaluated as the model\'s failure',
  staleResult.model === 4 && staleResult.reported === 4, JSON.stringify(staleResult));
check('the rider-facing step uses that same verdict',
  staleResult.verdict.className === 'fail'
    && staleResult.step.safetyClass === 'fail'
    && staleResult.step.safetyLabel === 'Road fails rules', JSON.stringify(staleResult));
check('the rendered percentages and concerns use the same failure',
  /100%\s*Fails Rules/.test(staleResult.mix)
    && /Stale Stored Verdict Road/.test(failConcern),
  JSON.stringify({ ...staleResult, failConcern }));

const sweep = await page.evaluate(() => {
  const shapes = [];
  const flags = [0, FLAG_FREEWAY, FLAG_INFRA, FLAG_LIMITED_ACCESS];
  const measures = [null,
    { adt: 400, fc: 7, edge: null },
    { adt: 2500, fc: 5, edge: null },
    { adt: 16000, fc: 3, edge: 8 }];
  for (const facility of [0, 1, 2, 4, 5]) {
    for (const flag of flags) {
      for (const mph of [0, 15, 25, 35, 45, 60]) {
        for (const sh of [-1, 0, 4, 6]) {
          for (const lanes of [1, 2, 6]) {
            for (const lts of [0, 4]) {
              for (const measurement of measures) {
                shapes.push({ lenM: 10, facility, flags: flag, mph, sh, lanes,
                  lts, measures: measurement, official: 0,
                  // Alternate wrong and absent stored values; neither is truth.
                  level: shapes.length % 2 ? 1 : 0 });
              }
            }
          }
        }
      }
    }
  }
  const disagreements = [];
  for (const seg of shapes) {
    const expected = SafetyModel.evaluate(routeSegmentFacts(seg), details.rules).level;
    const actual = routeSegmentLevel(seg, details.rules);
    if (actual !== expected && disagreements.length < 8) {
      disagreements.push({ seg, expected, actual });
    }
  }
  return { checked: shapes.length, disagreements };
});
check(`Route Details agrees with SafetyModel across ${sweep.checked} segment readings`,
  sweep.checked >= 10000 && sweep.disagreements.length === 0,
  JSON.stringify(sweep.disagreements));

const jurisdictionSegments = [
  { name: 'Border Road', stateId: 'washington', lenM: 100, mph: 45, sh: 8,
    lanes: 2, lts: 4, facility: 0, flags: 0, official: 1, c0: 0, c1: 1 },
  { name: 'Border Road', stateId: 'oregon', lenM: 100, mph: 45, sh: 8,
    lanes: 2, lts: 4, facility: 0, flags: 0, official: 1, c0: 1, c1: 2 },
];
await page.evaluate(({ liveRules, segs }) => {
  localStorage.setItem('wa-bike-route-details-1', JSON.stringify({
    rules: liveRules,
    routeStateIds: ['washington', 'oregon'],
    summary: { distM: 200, timeS: 50, ascentM: 0, descentM: 0 },
    segs,
  }));
}, { liveRules: rules, segs: jurisdictionSegments });
await page.reload({ waitUntil: 'load' });
const jurisdiction = await page.evaluate(() => {
  document.querySelector('#concern-high-stress .concern-section-toggle')?.click();
  const routeSteps = buildRouteSteps(details.segs);
  return {
    routeStepCount: routeSteps.length,
    stepMeta: routeSteps.map((step) => step.meta),
    states: document.getElementById('summary').textContent.replace(/\s+/g, ' ').trim(),
    concerns: document.querySelector('#concern-high-stress .concern-section-body')?.textContent
      .replace(/\s+/g, ' ').trim() || '',
    routeNumbers: {
      washington: stateHighwayName('SR 520', 'washington'),
      oregon: stateHighwayName('OR 224', 'oregon'),
      wrongState: stateHighwayName('OR 224', 'washington'),
    },
  };
});
check('same-named roads stay separate at a state boundary',
  jurisdiction.routeStepCount === 2, JSON.stringify(jurisdiction));
check('route details attribute speed and stress facts to each source state',
  jurisdiction.stepMeta.some((meta) => meta.includes('WSDOT legal speed'))
    && jurisdiction.stepMeta.some((meta) => meta.includes('ODOT legal speed'))
    && /Washington · WSDOT rates it/.test(jurisdiction.concerns)
    && /Oregon · ODOT rates it/.test(jurisdiction.concerns), JSON.stringify(jurisdiction));
check('multi-state summary and route-number interpretation follow the segment jurisdiction',
  /Washington → Oregon/.test(jurisdiction.states)
    && jurisdiction.routeNumbers.washington
    && jurisdiction.routeNumbers.oregon
    && !jurisdiction.routeNumbers.wrongState, JSON.stringify(jurisdiction));
check('the rendered Route Details page has no JavaScript errors',
  errors.length === 0, errors.join(' | '));

await browser.close();
await site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
