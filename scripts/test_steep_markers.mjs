#!/usr/bin/env node
// A hill icon has to answer two different questions with one symbol: is there
// a wall on this route, and is there a grind. One threshold cannot do both.
//
// The rule this checks is app.js's STEEP_MARKER_TIERS, run against REAL routes
// from the real graph. It lifts the actual qualifier out of app.js rather than
// restating it, so the test cannot quietly agree with a copy of the rule while
// the app does something else.
//
// The measurement that produced the tiers, as longest consecutive run at grade:
//
//                              3%     4%     5%     6%   7.5%
//   Phinney Ridge             266    266    266    133     70
//   Queen Anne -> Fremont      91      0      0      0      0
//   North Bend -> the Pass   1468   1468    600    281    281
//
// Phinney Ridge holds 5% for 266 m and never holds 7.5% for more than 70 -- a
// sustained climb invisible to a single steep threshold. North Bend holds 4%
// for nearly a mile and a half. Queen Anne -> Fremont has nothing above 4% and
// is the control: it must stay unmarked.
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import { routerWorker } from './testlib/harness.mjs';
import { DEFAULT_WEIGHTS, directLensWeights, defaultRules } from './audit_route.mjs';

const appSrc = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
function lift(name) {
  const at = appSrc.search(new RegExp(`\\nfunction ${name}\\s*\\([^)]*\\)\\s*\\{`));
  assert.notEqual(at, -1, `app.js should define ${name}`);
  let depth = 0;
  for (let j = appSrc.indexOf('{', at); j < appSrc.length; j++) {
    if (appSrc[j] === '{') depth++;
    else if (appSrc[j] === '}' && --depth === 0) return appSrc.slice(at + 1, j + 1);
  }
  throw new Error(`unterminated ${name}`);
}
const tiersLiteral = /const STEEP_MARKER_TIERS = (\[[\s\S]*?\]);/.exec(appSrc);
assert.ok(tiersLiteral, 'app.js should define STEEP_MARKER_TIERS');

const sandbox = vm.createContext({ Math, Number, console });
vm.runInContext(`var STEEP_MARKER_TIERS = ${tiersLiteral[1]};`, sandbox);
vm.runInContext(lift('steepRunQualifies'), sandbox);
const tiers = vm.runInContext('STEEP_MARKER_TIERS', sandbox);
assert.ok(tiers.length >= 2, 'a single tier cannot express both a wall and a grind');
// Gentler tiers must demand more length, or a tier is simply a looser version
// of another and the extra one buys nothing.
for (let i = 1; i < tiers.length; i++) {
  assert.ok(tiers[i].gradePct < tiers[i - 1].gradePct,
    'tiers must be ordered from steepest to gentlest');
  assert.ok(tiers[i].runM > tiers[i - 1].runM,
    `a gentler tier (${tiers[i].gradePct}%) must require MORE length than `
    + `${tiers[i - 1].gradePct}%, or it is strictly looser and the steeper tier is dead`);
}

const R = 6371000;
const havM = ([lo1, la1], [lo2, la2]) => {
  const p1 = la1 * Math.PI / 180, p2 = la2 * Math.PI / 180;
  const a = Math.sin((p2 - p1) / 2) ** 2
    + Math.cos(p1) * Math.cos(p2) * Math.sin((lo2 - lo1) * Math.PI / 360) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

const worker = routerWorker({ state: 'washington' });
assert.ok(worker.ready, 'the washington graph must load');

/** The app's own qualifier, over one real route's segments. */
function routeIsMarked(from, to) {
  const reply = worker.post({ type: 'route-options', id: 'steep', points: [from, to],
    rules: defaultRules(), weights: DEFAULT_WEIGHTS,
    directProbeWeights: directLensWeights(DEFAULT_WEIGHTS) });
  assert.ok(reply?.ok, 'trip must be routable');
  const option = reply.options.find((o) => o.optimization?.recommended) || reply.options[0];
  const coords = option.coords || [];
  const feats = (option.segs || []).map((seg) => {
    let lenM = 0;
    for (let k = seg.c0; k < seg.c1 && k + 1 < coords.length; k++) {
      lenM += havM(coords[k], coords[k + 1]);
    }
    return { gradePct: Number(seg.gradePct) || 0, lenM };
  });
  const qualifies = vm.runInContext('steepRunQualifies', sandbox);
  return { marked: qualifies(feats, 0, feats.length), feats };
}

// Two real routes, chosen because they are the two answers that matter and are
// both quick to compute. North Bend -> Snoqualmie Pass would exercise the long
// grind on real data, and did, but routing a mountain pass took ten minutes --
// far too slow to keep in a suite. The grind tier is checked below instead,
// where its arithmetic can be pinned exactly.
const CASES = [
  { name: 'Phinney Ridge (sustained 5%, never a long 7.5%)',
    from: [-122.31757, 47.65760], to: [-122.35460, 47.67070], want: true },
  { name: 'Queen Anne -> Fremont (nothing above 4%)',
    from: [-122.35700, 47.63700], to: [-122.35000, 47.65100], want: false },
];

for (const c of CASES) {
  const { marked, feats } = routeIsMarked(c.from, c.to);
  const peak = Math.max(0, ...feats.map((f) => f.gradePct));
  console.log(`  ${marked ? 'marked  ' : 'unmarked'} ${c.name}  (peak ${peak.toFixed(1)}%)`);
  assert.equal(marked, c.want, c.want
    ? `${c.name} should be marked: it holds a grade long enough for one of the tiers, `
      + 'and a rider deserves to know a climb is coming'
    : `${c.name} must NOT be marked. Peak grade is ${peak.toFixed(1)}%. A hill icon on a `
      + 'flat route teaches the rider to ignore hill icons.');
}
// Every tier must be reachable, and must not fire one metre early. A tier that
// nothing can satisfy is decoration, and one that fires below its own length
// would put a hill icon on a route that does not have one.
const qualifies = vm.runInContext('steepRunQualifies', sandbox);
const evenly = (gradePct, totalM) => {
  const feats = [];
  for (let done = 0; done < totalM; done += 20) {
    feats.push({ gradePct, lenM: Math.min(20, totalM - done) });
  }
  return feats;
};
for (const tier of tiers) {
  const long = evenly(tier.gradePct, tier.runM + 40);
  assert.ok(qualifies(long, 0, long.length),
    `the ${tier.gradePct}% tier never fires: ${tier.runM + 40} m held at exactly `
    + `${tier.gradePct}% did not qualify, so this tier is decoration`);
  // Just under, at a grade no gentler tier can rescue.
  const short = evenly(tier.gradePct, tier.runM - 40);
  const rescued = tiers.some((other) => other !== tier
    && tier.gradePct >= other.gradePct && tier.runM - 40 >= other.runM);
  if (!rescued) {
    assert.ok(!qualifies(short, 0, short.length),
      `the ${tier.gradePct}% tier fired at ${tier.runM - 40} m, under its own `
      + `${tier.runM} m requirement`);
  }
  console.log(`  tier ${String(tier.gradePct).padStart(4)}% over ${String(tier.runM).padStart(4)} m`
    + '  fires when held, silent when short');
}

console.log(`${tiers.length} steep tiers, checked against real routes and at their edges`);
