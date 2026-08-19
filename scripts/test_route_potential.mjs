#!/usr/bin/env node
// A* is only allowed to return the cheapest path under its own cost function,
// and that guarantee rests entirely on one property: the heuristic must never
// claim more remains than really does. The router builds its heuristic by
// running a backward search over a per-edge cost LOWER BOUND, so the property
// reduces to a statement about single edges:
//
//     edgeCostFloor(edge, direction) <= what routeLeg charges for that edge
//
// If that ever fails, routes quietly get worse -- no crash, no failing
// assertion anywhere else, just a slightly wrong answer on some trips. It has
// already failed once: the bound priced an edge off the rider's own safety
// verdict, assuming a discovery lens could only push a road further down the
// ladder. The ladder is not monotone in rule strictness (a 35 mph road with no
// shoulder FAILS against a 35 mph limit but only CAUTIONS against 30), so the
// bound sat above the real cost on 20,947 edges and the lens searches came back
// with routes that were not the cheapest available.
//
// So: check the inequality directly, on every edge in the real graph, in every
// mode, under the rider's rules AND under the conservative discovery lens.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, graphBuffer, source } from './testlib/harness.mjs';

// The worker is loaded into a function scope rather than a vm context so its
// top-level bindings are ordinary locals -- the same shape the browser gives
// it, and fast enough to sweep 858k edges six times.
const probe = `
;self.__floorHoldsFor = function (rules, searchRules, mode, prefDesig, prefResidential) {
  useEdgeCostFloors(rules, searchRules, mode);
  const modeW = modeWeights(mode);
  let checked = 0, worst = null;
  for (let ei = 0; ei < E; ei++) {
    for (let d = 0; d < 2; d++) {
      const forward = d === 0;
      const fl = eFlags[ei];
      // Only edges a route could actually traverse. These are the exclusions
      // routeLeg applies before it prices anything.
      if (edgeShoulder(ei, forward) === PROHIBITED_SHOULDER) continue;
      if (!rules.allowMtbTrails && (eOfficial[ei] & EDGE_MTB)) continue;
      if (!rules.allowFreeways && (fl & 4)) continue;
      if ((fl & 16) && !forward) continue;
      const actualLevel = edgeLevelFor(ei, rules, forward);
      if (modeMult(mode, edgeLevelFor(ei, searchRules, forward)) === Infinity) continue;
      // routeLeg's own price for this edge, from routeLeg's own function.
      // This block used to be a second transcription of that loop, kept in
      // step by hand; it fell behind the moment a term was added, and every
      // diagnostic anyone wrote became a third copy. Omitting the three
      // path-dependent inputs (ferry boarding wait, dismount or facility-gap
      // entry, and turn friction) is deliberate and is exactly what the bound
      // openly drops -- all are >= 0, so leaving them out keeps this comparison
      // conservative.
      const cost = edgeCost(ei, forward, {
        mode, modeW, rules, searchRules, prefDesig, prefResidential,
        requiredSafeAccess: rules.requireSafe && actualLevel === 4,
      });
      checked++;
      const floor = edgeCostFloor(ei, forward);
      // A relative slack, because both sides are long products of doubles.
      if (floor > cost * (1 + 1e-9) + 1e-9) {
        const over = floor / Math.max(cost, 1e-12);
        if (!worst || over > worst.over) {
          worst = { over, edge: ei, forward, floor, cost, actualLevel,
            searchLevel: edgeLevelFor(ei, searchRules, forward) };
        }
      }
    }
  }
  return { checked, worst };
};
`;

// Report the settled cost at the goal -- the number A* is minimising, and the
// only thing that decides whether a route is the cheapest one.
const reportCost = [
  '    if (u === t.node) { foundArc = incomingArc; break; }',
  '    if (u === t.node) { self.__cost = incomingArc === START_ARC ? 0 : searchDist[incomingArc];'
  + ' foundArc = incomingArc; break; }',
];
const graph = graphBuffer();
const workerSrc = readFileSync(join(ROOT, 'router-worker.js'), 'utf8');
function build(transform) {
  const src = transform(workerSrc);
  const messages = [];
  const importScripts = (...names) => {
    for (const name of names) new Function('self', source(name)).call(globalThis, globalThis);
  };
  const host = {};
  const api = new Function('self', 'importScripts', 'postMessage',
    'let onmessage;\n' + src + probe
    + '\n;return { onmessage, routeLeg, withRoadBlocks, useWeights, nearestNode,'
    + ' floorHolds: self.__floorHoldsFor };')
    .call(host, host, importScripts, (m) => messages.push(m));
  api.host = host;
  api.onmessage({ data: { type: 'graph', buffer: graph } });
  assert.strictEqual(messages.at(-1)?.type, 'ready', 'the graph did not load');
  return api;
}
const worker = build((s) => {
  const out = s.replace(reportCost[0], reportCost[1]);
  assert.notStrictEqual(out, s, 'could not instrument the goal test');
  return out;
});

const RIDER = {
  minShoulder: 4, maxSpeedNoShoulder: 35, upperMaxSpeed: 45, noUpperLimit: true,
  allowFreeways: false, allowMtbTrails: false, requireSafe: false,
  allowSidewalkFallback: true, preferPaved: true, inferShoulderFromEdge: true,
  lanesNoShoulderOver: 4, busyNoShoulder: 2,
};
// Rule sets that move the ladder in different directions, plus weights well
// away from the defaults: the bound is derived from the live weights, so a
// bound that only holds at the shipped numbers is not a bound.
const CASES = [
  ['default rules', RIDER, null],
  ['strict shoulder', { ...RIDER, minShoulder: 6, maxSpeedNoShoulder: 25, upperMaxSpeed: 35, noUpperLimit: false }, null],
  ['only matching routes', { ...RIDER, requireSafe: true }, null],
  ['freeways and MTB allowed', { ...RIDER, allowFreeways: true, allowMtbTrails: true }, null],
  ['signed routes strongly preferred', { ...RIDER, alwaysPreferBikeRoutes: true }, null],
  ['unpaved welcome', { ...RIDER, preferPaved: false }, null],
  ['weights dragged about', RIDER, {
    residential: 0.5, facilityPath: 0.2, facilitySeparated: 0.25, strongDesignated: 0.3,
    failRoadLowStress: 60, comfyRoadLowStress: 0.8, comfyRoadBalanced: 0.85,
    turnBalancedSec: 25, climbBalancedSecPerM: 2.0, uphillFactor: 9, downhillFactor: 4,
    curveLowStress3: 9, busyHeavyBalanced: 2.2, speedBelowLowStress: 0.05, ferryWaitMin: 30,
  }],
];

let checks = 0;
for (const [label, rules, weights] of CASES) {
  worker.useWeights(weights);
  worker.withRoadBlocks([], rules, () => {
    // The lens the discovery candidates search under: the same rules with a
    // lower no-shoulder speed. Both it and the rider's own rules must hold.
    const lens = { ...rules, maxSpeedNoShoulder: Math.max(20, Math.min(30,
      rules.maxSpeedNoShoulder - 5)) };
    for (const searchRules of [rules, lens]) {
      for (const mode of ['direct', 'balanced', 'low']) {
        for (const prefs of [[false, false], [true, true]]) {
          const { checked, worst } = worker.floorHolds(rules, searchRules, mode, prefs[0], prefs[1]);
          assert.ok(checked > 100000, `${label}: only ${checked} edges were priced`);
          assert.strictEqual(worst, null, worst && `${label} / ${mode}`
            + `${searchRules === rules ? '' : ' / discovery lens'}`
            + ` / desig=${prefs[0]} residential=${prefs[1]}: the A* bound prices edge`
            + ` ${worst.edge} at ${worst.floor.toFixed(3)} but the search charges`
            + ` ${worst.cost.toFixed(3)} (${worst.over.toFixed(2)}x over; verdict`
            + ` ${worst.actualLevel} under the rider's rules, ${worst.searchLevel} under the`
            + ` search's). An overshooting bound makes A* return routes that are not the cheapest.`);
          checks++;
        }
      }
    }
  });
}

/* ------------------------------------------------------- and it stays optimal
 * The inequality above is necessary but not sufficient. A* here is label-
 * SETTING -- it will not revisit an arc it has already settled unless the walk
 * to it got cheaper -- and that shortcut needs the heuristic to be consistent,
 * a stronger property than being a lower bound. It was not: the potential is
 * stored quantised, and on a 400 km trip the search settled arcs it should have
 * corrected and returned routes costing a few seconds more than the cheapest.
 * Nothing in the per-edge check above can see that.
 *
 * So compare against the one thing that cannot be beaten: the same search with
 * no heuristic at all, which is Dijkstra. The costs must match exactly.
 */
const dijkstra = build((s) => {
  const withCost = s.replace(reportCost[0], reportCost[1]);
  const out = withCost.replace(/  const h = \(n\) => \{[\s\S]*?\n  \};/, '  const h = () => 0;');
  assert.notStrictEqual(out, withCost, 'could not zero the heuristic');
  return out;
});

// Long enough to cross the state and accumulate the rounding that broke this,
// and one short city leg where the portfolio's own trips live.
const LEGS = [
  ['Spokane -> Olympia', [-117.4530, 47.7392], [-123.0670, 47.5557]],
  ['Seattle -> Bellevue', [-122.3321, 47.6062], [-122.2015, 47.6101]],
];
const legCost = (api, rules, [, from, to], mode, prefDesig, prefResidential) => {
  api.useWeights(null);
  return api.withRoadBlocks([], rules, () => {
    const snaps = [from, to].map((p) => api.nearestNode(p[0], p[1], rules));
    api.host.__cost = 0;
    const leg = api.routeLeg(from, to, rules, mode, prefDesig, prefResidential, snaps[0], snaps[1]);
    return { cost: api.host.__cost, ok: !!leg.ok, distM: Math.round(leg.distM || 0) };
  });
};

let compared = 0;
for (const leg of LEGS) {
  for (const [label, rules] of [['default rules', RIDER],
      ['strict shoulder', { ...RIDER, minShoulder: 6, maxSpeedNoShoulder: 25, upperMaxSpeed: 35, noUpperLimit: false }]]) {
    for (const mode of ['direct', 'balanced', 'low']) {
      const fast = legCost(worker, rules, leg, mode, false, true);
      if (!fast.ok) continue;
      const best = legCost(dijkstra, rules, leg, mode, false, true);
      // The search runs weighted A*: SEARCH_OVERSHOOT bounds how far above
      // the true optimum a found route may cost. That bound IS the contract
      // -- a violation means the heuristic is not admissible even after the
      // weighting, which the overshoot cannot excuse.
      const overshoot = Number(/const SEARCH_OVERSHOOT = ([\d.]+);/.exec(workerSrc)?.[1]) || 1;
      assert.ok(fast.cost <= best.cost * overshoot + 1e-6,
        `${leg[0]} / ${label} / ${mode}: A* returned a route costing ${fast.cost.toFixed(4)}`
        + ` when ${best.cost.toFixed(4)} was available (${fast.distM}m against ${best.distM}m,`
        + ` bound ${overshoot}x).`
        + ' The heuristic is not admissible, or the search settled an arc it should have revisited.');
      compared++;
    }
  }
}

console.log(`ok - the A* cost bound holds on every usable edge across ${checks} `
  + `mode/rules/preference combinations, and ${compared} legs come back at the `
  + `cost an exhaustive search finds`);
