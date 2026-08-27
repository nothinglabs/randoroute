#!/usr/bin/env node
// A route that starts or ends ON a failing road walks its first/last block
// on the sidewalk instead of riding it or contorting around it (field
// direction, 2026-08-27: "give a freebie to start and end of route so
// users can walk to the nearest safe road"). Everything here RUNS the
// worker on the real Washington graph: the gate must hold on real edges,
// a route from a genuinely walled endpoint must walk out and report the
// stub as caution-level dismount rather than failing mileage, and the
// walk price must sit above the A* floor so every cached bound stays
// admissible.
import fs from 'node:fs';
import vm from 'node:vm';
import { appDefaultRules, check, done, routerWorker } from './testlib/harness.mjs';

const worker = routerWorker();
check('worker loads the graph', worker.ready);

const rules = JSON.stringify(appDefaultRules());

// The pure-edge half of the predicate, on real data: failing edges with a
// sidewalk to walk on must be plentiful (the whole point is that strict
// tagging alone reaches only ~a quarter of them), explicit sidewalk=no
// must block, and freeways/ferries must never qualify.
const gate = worker.run(`(() => {
  const rules = ${rules};
  let eligibleFail = 0, taggedNo = 0, noPassing = 0, freewayPassing = 0;
  let ruralUnknownPassing = 0;
  for (let i = 0; i < E; i++) {
    const fails = edgeLevelFor(i, rules, true) === 4 || edgeLevelFor(i, rules, false) === 4;
    const g = walkAccessGate(i);
    if (fails && g) eligibleFail++;
    if (eOfficial[i] & EDGE_SIDEWALK_NO && !(eOfficial[i] & EDGE_SIDEWALK)) {
      taggedNo++;
      if (g) noPassing++;
    }
    if (g && (eFlags[i] & (4 | 32))) freewayPassing++;
    if (g && !(eOfficial[i] & (EDGE_SIDEWALK | EDGE_URBAN))) ruralUnknownPassing++;
  }
  return { eligibleFail, taggedNo, noPassing, freewayPassing, ruralUnknownPassing };
})()`);
check('failing edges with a walkable sidewalk are plentiful in the shipped graph',
  gate.eligibleFail > 20000, JSON.stringify(gate));
check('explicit sidewalk=no blocks the gate; freeways, ferries and rural unknowns never pass',
  gate.taggedNo > 10000 && gate.noPassing === 0
    && gate.freewayPassing === 0 && gate.ruralUnknownPassing === 0,
  JSON.stringify(gate));

// A walled door: a real node whose EVERY outgoing edge fails the default
// rules, at least one of them walkable — the exact spot the freebie exists
// for — plus a reachable passing-network target roughly a kilometre away.
// Then the route must walk out: the stub seg is caution-level dismount
// with the walkAccess flag, priced at walking time, and contributes no
// failing mileage.
const trip = worker.run(`(() => {
  const rules = ${rules};
  const leaves4 = (a, u) => {
    const ei = outEdge[a];
    return edgeLevelFor(ei, rules, eA[ei] === u) === 4;
  };
  let start = -1;
  for (let u = 0; u < N && start < 0; u++) {
    const deg = outStart[u + 1] - outStart[u];
    if (deg < 2 || !inGiant[u]) continue;
    let walled = true, walkable = false;
    for (let a = outStart[u]; a < outStart[u + 1]; a++) {
      if (!leaves4(a, u)) { walled = false; break; }
      if (walkAccessGate(outEdge[a])) walkable = true;
    }
    if (walled && walkable) start = u;
  }
  if (start < 0) return { start };
  const kx = 111320 * Math.cos(nodeLat[start] * Math.PI / 180), ky = 110540;
  let target = -1;
  for (let v = 0; v < N && target < 0; v++) {
    if (!inGiant[v]) continue;
    const dx = (nodeLon[v] - nodeLon[start]) * kx, dy = (nodeLat[v] - nodeLat[start]) * ky;
    const d2 = dx * dx + dy * dy;
    if (d2 < 600 * 600 || d2 > 1200 * 1200) continue;
    for (let a = outStart[v]; a < outStart[v + 1]; a++) {
      const ei = outEdge[a];
      if (edgeLevelFor(ei, rules, eA[ei] === v) !== 4 && !(eFlags[ei] & (4 | 32))) {
        target = v; break;
      }
    }
  }
  if (target < 0) return { start, target };
  const summarize = (r) => !r.ok ? { ok: false, reason: r.reason } : {
    ok: true, distM: Math.round(r.distM), failM: Math.round(r.failM),
    dismountM: Math.round(r.dismountM),
    walkSegs: r.segs.filter((s) => s.walkAccess).map((s) => ({
      level: s.level, cause: s.cautionCause, dismount: s.dismount,
      timeS: s.timeS, c0: s.c0 })),
    // Every walked seg must sit at the route's ends, never mid-route.
    walkCoordSpan: r.segs.filter((s) => s.walkAccess)
      .map((s) => Math.min(s.c0, r.coords.length - 1 - s.c1)),
    // Failing segs a strict search still admits are the wider goal-side
    // terminal-access carve-out; they must hug an end of the route too.
    failSegFromEnd: r.segs.filter((s) => s.level === 4)
      .map((s) => Math.min(s.c0, r.coords.length - 1 - s.c1)),
    firstSegWalk: !!r.segs[0]?.walkAccess,
  };
  const startLL = [nodeLon[start], nodeLat[start]];
  const endLL = [nodeLon[target], nodeLat[target]];
  const open = summarize(routeLeg(startLL, endLL, rules, 'balanced', false, false));
  const strict = summarize(routeLeg(startLL, endLL,
    { ...rules, requireSafe: true }, 'balanced', false, false));
  return { start, target, open, strict };
})()`);
check('the graph holds a walled door with a walkable escape and a nearby target',
  trip.start >= 0 && trip.target >= 0, JSON.stringify({ s: trip.start, t: trip.target }));
check('the route walks out of the walled door',
  trip.open?.ok && trip.open.walkSegs.length > 0 && trip.open.firstSegWalk,
  JSON.stringify(trip.open));
check('the walked stub is caution-level dismount, never failing mileage',
  trip.open?.walkSegs.every((s) => s.level === 3 && s.cause === 'dismount' && s.dismount)
    && trip.open.dismountM > 0,
  JSON.stringify(trip.open?.walkSegs));
// The walled start contributes NO failing meters under strict matching —
// its stub is walked. Failing meters the strict search still reports are
// the goal-side terminal-access carve-out (which stays deliberately
// reported as failing), so every level-4 seg must hug an end of the route.
check('under "fully matching" the walled door walks out clean',
  trip.strict?.ok && trip.strict.walkSegs.length > 0 && trip.strict.firstSegWalk
    && trip.strict.failSegFromEnd.every((span) => span < 40),
  JSON.stringify(trip.strict));

// The escape must stay at the ends: no walked seg deeper than the radius
// plus one block from its own end of the route (coordinate index is a
// proxy; the real bound is geometric and tighter).
check('walked segs sit at the route ends only',
  (trip.open?.walkSegs || []).length <= 6
    && (trip.open?.walkCoordSpan || []).every((span) => span < 40),
  JSON.stringify(trip.open?.walkCoordSpan));

// Admissibility: the walk price can never undercut the A* floor, or every
// cached bound computed before this feature would overestimate and the
// search would go quietly suboptimal. floorSetup is initialised by the
// route above; walk pricing at 0.87 s/m must clear the floor's best-case
// ride on every gate-eligible edge, both directions.
const floors = worker.run(`(() => {
  let checked = 0, undercut = 0, worst = null;
  for (let i = 0; i < E && checked < 20000; i++) {
    if (!walkAccessGate(i)) continue;
    checked++;
    const walkS = eLen[i] / V_DISMOUNT;
    for (const fwd of [true, false]) {
      const floor = edgeCostFloor(i, fwd);
      if (floor > walkS + 1e-9) { undercut++; worst = { i, floor, walkS }; }
    }
  }
  return { checked, undercut, worst };
})()`);
check('walking never undercuts the A* cost floor on any eligible edge',
  floors.checked > 5000 && floors.undercut === 0, JSON.stringify(floors));

// The app and Route Details both re-score segments client-side from raw road
// facts ("a stored worker byte is a cache, not truth"), which re-FAILED a
// stub the engine had walked: maroon paint and a "!" over an amber walk
// (field, 2026-08-27). walkAccess is a structural fact the client cannot
// re-derive — it depends on where the leg's endpoints were — so both pages
// must preserve it the way they preserve dismountEscalated. Lift the real
// functions and drive them with facts that fail raw: the flag alone must
// flip the verdict to caution/dismount.
function lift(src, marker, endMarker, label) {
  const i = src.indexOf(marker);
  check(`${label} still contains ${marker}`, i !== -1);
  const e = src.indexOf(endMarker, i);
  check(`${label} ${marker} still ends with the expected marker`, e !== -1);
  return src.slice(i, e + endMarker.length);
}
const appSrc = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const appBox = vm.createContext({
  effectiveLevel: () => 4, scoreRouteSeg: (p) => p, routeSegProps: () => ({}),
  evaluateRoad: () => ({ level: 4 }), routeSegmentDisplayCategory: () => 'fail',
});
vm.runInContext([
  lift(appSrc, 'function fallbackRouteLevel', '\n}', 'app.js'),
  lift(appSrc, 'function routeSegmentCautionCause', '\n}', 'app.js'),
  'globalThis.OUT = { level: fallbackRouteLevel, cause: routeSegmentCautionCause };',
].join('\n'), appBox);
check('app: a raw-failing seg scores 4, the walkAccess flag alone makes it caution 3',
  appBox.OUT.level({}) === 4 && appBox.OUT.level({ walkAccess: true }) === 3,
  `plain=${appBox.OUT.level({})} walked=${appBox.OUT.level({ walkAccess: true })}`);
check('app: the walked stub names dismount as its caution cause',
  appBox.OUT.cause({ walkAccess: true }) === 'dismount',
  String(appBox.OUT.cause({ walkAccess: true })));

const detailsSrc = fs.readFileSync(new URL('../route-details.js', import.meta.url), 'utf8');
const detailsBox = vm.createContext({
  window: { SafetyModel: { evaluate: () => ({ level: 4 }) } },
  routeSegmentFacts: () => ({}), activeDetailRules: () => ({}),
  isDismountSegment: () => false, isMountainBikeTrail: () => false,
  routeDisplayCategory: () => 'fail', details: { rules: {} },
});
vm.runInContext([
  lift(detailsSrc, 'function routeSegmentLevel', '\n}', 'route-details.js'),
  lift(detailsSrc, 'function routeCautionCause', '\n}', 'route-details.js'),
  'globalThis.OUT = { level: routeSegmentLevel, cause: routeCautionCause };',
].join('\n'), detailsBox);
check('route details: a raw-failing seg scores 4, the walkAccess flag makes it caution 3',
  detailsBox.OUT.level({}) === 4 && detailsBox.OUT.level({ walkAccess: true }) === 3,
  `plain=${detailsBox.OUT.level({})} walked=${detailsBox.OUT.level({ walkAccess: true })}`);
check('route details: the walked stub names dismount as its caution cause',
  detailsBox.OUT.cause({ walkAccess: true }) === 'dismount',
  String(detailsBox.OUT.cause({ walkAccess: true })));

done();
