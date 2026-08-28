#!/usr/bin/env node
// The Roosevelt Bridge patch (temporary experiment, 2026-08-27): OSM joins
// the University Bridge side paths into a tip — a "clean" on-trail U-turn
// across a busy street, a movement the ground does not offer. The opt-in
// rule `rooseveltBridgePatch` breaks that tip: a route may never step
// straight from one side path onto the other, so turning around costs a
// real street crossing. This runs the real Washington graph: the geometric
// selection must pick the two side-path chains, crossings must still route
// on the side paths, and no patched route may contain a direct
// path-to-path step.
//
// DELETE this test together with rooseveltCrossChain when the corrected
// OSM data ships in a graph rebuild.
import { appDefaultRules, check, done, routerWorker } from './testlib/harness.mjs';

const worker = routerWorker();
check('worker loads the graph', worker.ready);

const rules = JSON.stringify(appDefaultRules());

const selection = JSON.parse(worker.run(`(() => {
  const { chainOf } = ensureRooseveltPatch();
  const rows = [...chainOf.entries()].map(([i, side]) => ({
    i, side,
    named: !!edgeName(i),
    trail: !!(eFlags[i] & 8),
    mLon: +((nodeLon[eA[i]] + nodeLon[eB[i]]) / 2).toFixed(5),
    mLat: +((nodeLat[eA[i]] + nodeLat[eB[i]]) / 2).toFixed(5),
  }));
  return JSON.stringify(rows);
})()`));
check('the patch selects a sane bridge-sized set of edges',
  selection.length >= 6 && selection.length <= 80, `selected ${selection.length}`);
check('every patched edge is an unnamed trail in the bridge corridor',
  selection.every((e) => e.trail && !e.named
    && e.mLon >= -122.3235 && e.mLon <= -122.3170
    && e.mLat >= 47.6513 && e.mLat <= 47.6553),
  JSON.stringify(selection.filter((e) => !e.trail || e.named).slice(0, 3)));
check('both side-path chains are present — the ban needs two sides',
  new Set(selection.map((e) => e.side)).size === 2,
  JSON.stringify([...new Set(selection.map((e) => e.side))]));

// Trips across the bridge in both directions plus a deliberate side-to-side
// trip. Under the patch a route may never step straight from one chain onto
// the other; crossings must still ride the side paths, and everything must
// still route with the patch off.
const trips = JSON.parse(worker.run(`(() => {
  const base = ${rules};
  const south = [-122.3220, 47.6500], north = [-122.3170, 47.6565];
  const westMid = [-122.3205, 47.6535], eastMid = [-122.3201, 47.6535];
  const run = (a, b, patch) => {
    const r = routeLeg(a, b, { ...base, rooseveltBridgePatch: patch },
      'balanced', false, false);
    if (!r.ok) return { ok: false, reason: r.reason };
    const { chainOf } = ensureRooseveltPatch();
    let crossSteps = 0, sidepathM = 0;
    for (let k = 0; k < r.edgeIds.length; k++) {
      const side = chainOf.get(r.edgeIds[k]);
      if (side !== undefined) sidepathM += eLen[r.edgeIds[k]];
      if (k > 0) {
        const prev = chainOf.get(r.edgeIds[k - 1]);
        // Only the TURNAROUND is banned: a cross-chain step at the south
        // tip whose entered edge heads back north. The southward drain to
        // the street is load-bearing and stays legal.
        const ei = r.edgeIds[k];
        const fwd = eA[ei] === r.nodeIds[k];
        const dLat = fwd ? nodeLat[eB[ei]] - nodeLat[eA[ei]]
          : nodeLat[eA[ei]] - nodeLat[eB[ei]];
        if (side !== undefined && prev !== undefined && side !== prev
          && nodeLat[r.nodeIds[k]] < ROOSEVELT_TIP_MAX_LAT && dLat > 0) crossSteps++;
      }
    }
    return { ok: true, distM: Math.round(r.distM), crossSteps,
      sidepathM: Math.round(sidepathM) };
  };
  return JSON.stringify({
    northbound: run(south, north, true),
    southbound: run(north, south, true),
    sideToSide: run(westMid, eastMid, true),
    off: run(south, north, false),
  });
})()`));
check('the trips route with the patch on (both ways) and off',
  trips.northbound.ok && trips.southbound.ok && trips.off.ok,
  JSON.stringify({ nb: trips.northbound.ok, sb: trips.southbound.ok, off: trips.off.ok }));
check('no patched route steps straight from one side path onto the other',
  trips.northbound.crossSteps === 0 && trips.southbound.crossSteps === 0
    && (!trips.sideToSide.ok || trips.sideToSide.crossSteps === 0),
  JSON.stringify({ nb: trips.northbound.crossSteps, sb: trips.southbound.crossSteps,
    s2s: trips.sideToSide.crossSteps }));
check('each crossing direction still rides a side path',
  trips.northbound.sidepathM > 100 && trips.southbound.sidepathM > 100,
  JSON.stringify({ nb: trips.northbound.sidepathM, sb: trips.southbound.sidepathM }));
check('neither direction detours to another bridge',
  trips.northbound.distM < 2500 && trips.southbound.distM < 2500,
  JSON.stringify({ nb: trips.northbound.distM, sb: trips.southbound.distM }));

done();
