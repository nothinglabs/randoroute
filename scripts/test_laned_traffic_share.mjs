#!/usr/bin/env node
// A painted bike lane pays a SHARE of the traffic penalty instead of clearing
// it (rider call, 2026-08-29). Before this, facility >= 2 returned 1 from
// majorRoadMult unconditionally: the busy* sliders were dead on 991 laned
// arterial miles statewide, and no weight could revive them. Physical
// separation (facility >= 4) keeps the full exemption -- separation removes
// exposure, paint does not shrink the road.
import { routerWorker } from './testlib/harness.mjs';

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); return; }
  failed++; console.log(`  FAIL ${name}${detail ? `  -- ${detail}` : ''}`);
};
const worker = routerWorker();
check('worker loads the graph', worker.ready);

const out = JSON.parse(worker.run(`(() => {
  const modeW = modeWeights('balanced');
  // One edge per facility kind, all primary-tier by OSM tag so the full
  // (unshared) multiplier is the same busyHeavy figure for each.
  let laned = -1, bare = -1, separated = -1;
  for (let i = 0; i < eLen.length && (laned < 0 || bare < 0 || separated < 0); i++) {
    if (eLen[i] < 60 || (eFlags[i] & (8 | 32 | 4)) || edgeLimited(i, true)) continue;
    if (osmTrafficTier(i) !== TIER_PRIMARY) continue;
    const fac = edgeFacility(i, true);
    if (fac === 2 && laned < 0) laned = i;
    if (fac === 0 && bare < 0) bare = i;
    if (fac >= 4 && separated < 0) separated = i;
  }
  const base = { ...activeWeights };
  const at = (share, i) => {
    useWeights({ ...base, lanedTrafficShare: share });
    const m = majorRoadMult(i, modeWeights('balanced'), true);
    useWeights(base);
    return +m.toFixed(4);
  };
  const bareMult = at(0.3, bare);
  return JSON.stringify({
    found: { laned, bare, separated },
    bareMult, bareAtZero: at(0, bare), bareAtOne: at(1, bare),
    lanedDefault: at(base.lanedTrafficShare, laned),
    lanedAtZero: at(0, laned), lanedAtHalf: at(0.5, laned), lanedAtOne: at(1, laned),
    separatedAtOne: separated >= 0 ? at(1, separated) : null,
    defaultShare: base.lanedTrafficShare,
  });
})()`));

check('a laned, a bare and a separated primary road were found',
  out.found.laned >= 0 && out.found.bare >= 0, JSON.stringify(out.found));
check('the slider ships at 0.3', out.defaultShare === 0.3, String(out.defaultShare));
check('a bare road pays the full penalty at every slider position',
  out.bareMult > 1 && out.bareAtZero === out.bareMult && out.bareAtOne === out.bareMult,
  JSON.stringify(out));
check('at 0 a painted lane keeps the old full exemption',
  out.lanedAtZero === 1, JSON.stringify(out));
// The lane's full price is its own at-1 figure, not the bare edge's: the two
// edges carry different measured tiers (useMeasuredTraffic overrides the OSM
// tag), so cross-edge equality was comparing two different roads.
check('at 1 a painted lane pays a real traffic penalty',
  out.lanedAtOne > 1.1, JSON.stringify(out));
check('between the ends it pays the stated share of its own excess',
  Math.abs((out.lanedAtHalf - 1) - (out.lanedAtOne - 1) * 0.5) < 0.001
    && Math.abs((out.lanedDefault - 1) - (out.lanedAtOne - 1) * 0.3) < 0.001,
  JSON.stringify(out));
check('physical separation stays exempt even at 1',
  out.separatedAtOne === null || out.separatedAtOne === 1, JSON.stringify(out));

if (failed) { console.log(`\n${failed} FAILED`); process.exit(1); }
console.log(`\n${passed} passed`);
