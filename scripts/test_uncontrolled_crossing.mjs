#!/usr/bin/env node
// Crossing a failing road where nothing stops its traffic must cost more
// than crossing at a signal. Field, 2026-08-27: a Phinney Ridge route took
// three uncontrolled crossings of failing arterials because the router
// could not tell a signal from a gap in traffic — the graph carried no
// control data at all. Now it does (edgeLimitedDir bits 2/3), and the
// worker charges crossUncontrolled*Sec once per uncontrolled crossing.
//
// Everything here RUNS the worker on the real Washington graph: the graph
// must actually carry control bits at plausible density, and the penalty
// function must charge exactly the transitions the spec names — no charge
// at a controlled node, no charge arriving on a failing edge, no charge
// once the weight is zeroed, and a real charge at an uncontrolled
// fail-through node found in the shipped data.
import { appDefaultRules, check, done, routerWorker } from './testlib/harness.mjs';

const worker = routerWorker();
check('worker loads the graph', worker.ready);

const rules = JSON.stringify(appDefaultRules());

const density = worker.run(`(() => ({
  controlled: nodeControlledCount, nodes: N,
}))()`);
// Seattle alone holds ~1,400 signal junctions and ~4,400 signalised ped
// crossings; statewide, anything under a few thousand controlled GRAPH
// nodes means the stamping pass lost its data.
check('the graph carries traffic-control nodes at plausible density',
  density.controlled > 5000, JSON.stringify(density));

// Find real specimens by scanning the graph the worker actually loaded:
// an uncontrolled node that a failing road runs through, entered and left
// on passing edges, and a controlled node of the same shape.
const probe = worker.run(`(() => {
  const rules = ${rules};
  const touch = nodeFailTouch(rules);
  const passArcsAt = (u) => {
    const found = [];
    for (let a = outStart[u]; a < outStart[u + 1]; a++) {
      const ei = outEdge[a];
      if (edgeLevelFor(ei, rules, eA[ei] === u) !== 4) found.push(ei);
    }
    return found;
  };
  // A genuine crossing: the failing road through the node is a DIFFERENT
  // road (by name) from the pair of passing edges being ridden.
  const specimen = (wantControlled) => {
    for (let u = 0; u < N; u++) {
      if (touch.count[u] < 2 || !!nodeControlled[u] !== wantControlled) continue;
      const pass = passArcsAt(u);
      if (pass.length < 2) continue;
      const inName = eName[pass[0]], outName = eName[pass[1]];
      const crossesRide = (nm) => nm !== FAIL_TOUCH_NO_NAME
        && nm !== inName && nm !== outName;
      if (!crossesRide(touch.name1[u]) && !crossesRide(touch.name2[u])) continue;
      return { node: u, inEdge: pass[0], outEdge: pass[1] };
    }
    return null;
  };
  const un = specimen(false);
  const con = specimen(true);
  if (!un || !con) return { un, con };
  const at = (spec, mode) =>
    uncontrolledCrossPenaltyS(spec.inEdge, spec.node, spec.outEdge, rules, mode);
  // Arriving ON the failing road: riding along it is the multipliers' job.
  const alongAt = () => {
    for (let a = outStart[un.node]; a < outStart[un.node + 1]; a++) {
      const ei = outEdge[a];
      if (edgeLevelFor(ei, rules, eA[ei] === un.node) === 4) {
        return uncontrolledCrossPenaltyS(ei, un.node, un.outEdge, rules, 'balanced');
      }
    }
    return null;
  };
  const defaults = { un: at(un, 'balanced'), con: at(con, 'balanced') };
  // The rider's opt-in strengths, as the "Avoid uncontrolled crossings"
  // switch sends them (the charge ships OFF by default — 2026-08-27 field
  // direction after a day riding the always-on version).
  useWeights({ ...DEFAULT_WEIGHTS, crossUncontrolledDirectSec: 20,
    crossUncontrolledBalancedSec: 45, crossUncontrolledLowStressSec: 90 });
  const on = { un: at(un, 'balanced'), unLow: at(un, 'low'),
    con: at(con, 'balanced'), along: alongAt() };
  useWeights(DEFAULT_WEIGHTS);
  return { un, con, defaults, on,
    restored: activeWeights.crossUncontrolledBalancedSec === 0 };
})()`);
check('the shipped graph holds both specimen shapes',
  !!(probe.un && probe.con), JSON.stringify({ un: probe.un, con: probe.con }));
check('by default the charge is off and routing is untouched',
  probe.defaults.un === 0 && probe.defaults.con === 0 && probe.restored,
  JSON.stringify(probe.defaults));
check('switched on, an uncontrolled crossing of a failing road is charged',
  probe.on.un === 45, `balanced charge ${probe.on.un}`);
check('low-stress diverts further than balanced for the same crossing',
  probe.on.unLow === 90, `low-stress charge ${probe.on.unLow}`);
check('the same crossing at a controlled node stays free',
  probe.on.con === 0, `controlled charge ${probe.on.con}`);
check('arriving on the failing road itself is never charged here',
  probe.on.along === 0, `along charge ${probe.on.along}`);

// The Stone Way inversion (field, 2026-08-27): a street whose bike lane
// serves one direction FAILS ridden the other way, so its own edges put
// every mid-block node at fail-touch 2. Riding ALONG it must charge
// nothing — the failing road through the node is the road being ridden,
// not one being crossed. Found by name in the real graph, driven through
// the real charge with the opt-in weights active.
const stoneWay = worker.run(`(() => {
  const rules = ${rules};
  const touch = nodeFailTouch(rules);
  useWeights({ ...DEFAULT_WEIGHTS, crossUncontrolledDirectSec: 20,
    crossUncontrolledBalancedSec: 45, crossUncontrolledLowStressSec: 90 });
  let checked = 0, charged = 0;
  for (let i = 0; i < E && checked < 200; i++) {
    if (edgeName(i) !== 'Stone Way North') continue;
    for (const u of [eA[i], eB[i]]) {
      if (touch.count[u] < 2 || nodeControlled[u]) continue;
      for (let a = outStart[u]; a < outStart[u + 1]; a++) {
        const other = outEdge[a];
        if (other === i || edgeName(other) !== 'Stone Way North') continue;
        if (edgeLevelFor(i, rules, eB[i] === u) === 4) continue;
        checked++;
        if (uncontrolledCrossPenaltyS(i, u, other, rules, 'balanced') > 0) charged++;
      }
    }
  }
  useWeights(DEFAULT_WEIGHTS);
  return { checked, charged };
})()`);
check('riding along a directionally-failing street is never charged as crossing it',
  stoneWay.checked > 10 && stoneWay.charged === 0, JSON.stringify(stoneWay));

// And the trip that surfaced it: North 34th to Stone Way at 50th, with the
// charge ON, must suggest a route that stays on the bike-lane corridor
// rather than fleeing to a parallel street with failing pavement.
const trip = worker.post({ type: 'route-options', id: 991,
  start: [-122.3402, 47.6497], end: [-122.3399, 47.6648],
  rules: appDefaultRules(),
  weights: { crossUncontrolledDirectSec: 20, crossUncontrolledBalancedSec: 45,
    crossUncontrolledLowStressSec: 90 } });
const suggested = trip?.options?.[0];
const facilityShare = suggested
  ? (suggested.facilityM || 0) / Math.max(1, suggested.distM) : 0;
check('the Stone Way trip stays on the bike lane with the charge on',
  !!suggested && facilityShare > 0.7 && (suggested.failM || 0) < 100,
  suggested ? `facility ${(facilityShare * 100).toFixed(0)}%, fail ${Math.round(suggested.failM)}m, ${(suggested.distM / 1609).toFixed(1)}mi` : 'no route');

// The 🐞 audit's two false-positive classes (field, 2026-08-27), pinned on
// real graph specimens, with the median-hop shape they must NOT break:
//   1. riding INTO a failing stretch of one's own street — same name, short
//      first fragment, no foreign failing road at the node — never charges;
//   2. a node whose failing edges are all unnamed or same-named never
//      charges a rider passing through;
//   3. a short same-named failing entry WITH a foreign named failing road
//      at the node (the divided-arterial median hop) still charges.
const shapes = worker.run(`(() => {
  const rules = ${rules};
  useWeights({ ...DEFAULT_WEIGHTS, crossUncontrolledDirectSec: 20,
    crossUncontrolledBalancedSec: 45, crossUncontrolledLowStressSec: 90 });
  const touch = nodeFailTouch(rules);
  const foreign = (u, a, b) => {
    const ok = (nm) => nm !== FAIL_TOUCH_NO_NAME && nm !== eName[a] && nm !== eName[b];
    return ok(touch.name1[u]) || ok(touch.name2[u]);
  };
  const found = { intoOwn: null, medianHop: null };
  for (let u = 0; u < N && !(found.intoOwn && found.medianHop); u++) {
    if (nodeControlled[u]) continue;
    for (let a1 = outStart[u]; a1 < outStart[u + 1]; a1++) {
      const eIn = outEdge[a1];
      if (edgeLevelFor(eIn, rules, eB[eIn] === u) === 4) continue;
      for (let a2 = outStart[u]; a2 < outStart[u + 1]; a2++) {
        const eOut = outEdge[a2];
        if (eOut === eIn || eName[eOut] !== eName[eIn] || !eName[eIn]) continue;
        if (edgeLevelFor(eOut, rules, eA[eOut] === u) !== 4) continue;
        if (eLen[eOut] > CROSSING_MAX_M || (eFlags[eOut] & 4)) continue;
        const slot = foreign(u, eIn, eOut) ? 'medianHop' : 'intoOwn';
        if (!found[slot]) found[slot] = { u, eIn, eOut, name: edgeName(eIn) };
      }
    }
  }
  const charge = (s) => s
    ? uncontrolledCrossPenaltyS(s.eIn, s.u, s.eOut, rules, 'balanced') : null;
  const result = { intoOwn: found.intoOwn && { name: found.intoOwn.name,
      charged: charge(found.intoOwn) },
    medianHop: found.medianHop && { name: found.medianHop.name,
      charged: charge(found.medianHop) } };
  useWeights(DEFAULT_WEIGHTS);
  return result;
})()`);
check('riding into a failing stretch of your own street never charges',
  !!shapes.intoOwn && shapes.intoOwn.charged === 0, JSON.stringify(shapes));
check('a same-named median hop with a foreign failing road still charges',
  !!shapes.medianHop && shapes.medianHop.charged === 45, JSON.stringify(shapes));

// The 🐞 debug markers (field, 2026-08-27): with the charge fully OFF
// (default zero weights), a debug-flagged request still returns each
// option's uncontrolled failing crossings — detection is independent of
// the avoidance switch, which is the whole point of the marker.
const debugTrip = worker.post({ type: 'route-options', id: 992,
  start: [-122.3300, 47.6800], end: [-122.3500, 47.6510],
  rules: appDefaultRules(), debugUncontrolledCrossings: true });
const lists = (debugTrip?.options || []).map((o) => o.uncontrolledCrossings);
check('debug crossings ride on every option with the charge off',
  lists.length > 0 && lists.every(Array.isArray)
    && lists.some((list) => list.length > 0)
    && lists.flat().every(([lng, lat]) =>
      lng > -125 && lng < -116 && lat > 45 && lat < 50),
  JSON.stringify(lists.map((list) => list?.length)));
const plainTrip = worker.post({ type: 'route-options', id: 993,
  start: [-122.3300, 47.6800], end: [-122.3500, 47.6510],
  rules: appDefaultRules() });
check('without the debug flag the payload stays clean',
  (plainTrip?.options || []).every((o) => o.uncontrolledCrossings === undefined),
  'flagless options must not carry crossings');

done();
