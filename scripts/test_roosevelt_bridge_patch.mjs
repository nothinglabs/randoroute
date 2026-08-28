#!/usr/bin/env node
// The Roosevelt Bridge patch (temporary experiment, 2026-08-27): OSM maps
// the University Bridge side paths bidirectional while each is a one-way
// lane on the ground, so the router rides out one side and back the other.
// The opt-in rule `rooseveltBridgePatch` prohibits the wrong direction of
// each side. This runs the real Washington graph: the geometric selection
// must pick a sane set of unnamed bridge trails, each side must block the
// with-traffic-wrong direction, and a route across the bridge under the
// patch must never traverse a blocked direction while the same trip
// without the patch still routes.
//
// DELETE this test together with rooseveltProhibited when the corrected
// OSM data ships in a graph rebuild.
import { appDefaultRules, check, done, routerWorker } from './testlib/harness.mjs';

const worker = routerWorker();
check('worker loads the graph', worker.ready);

const rules = JSON.stringify(appDefaultRules());

const selection = JSON.parse(worker.run(`(() => {
  rooseveltProhibited(0, true); // build the sets
  const { blockAB, blockBA } = rooseveltPatchSets;
  const describe = (set, forward) => [...set].map((i) => ({
    i,
    named: !!edgeName(i),
    trail: !!(eFlags[i] & 8),
    mLon: +((nodeLon[eA[i]] + nodeLon[eB[i]]) / 2).toFixed(5),
    mLat: +((nodeLat[eA[i]] + nodeLat[eB[i]]) / 2).toFixed(5),
    // The latitude change of the BLOCKED traversal.
    blockedDLat: +(forward ? nodeLat[eB[i]] - nodeLat[eA[i]]
      : nodeLat[eA[i]] - nodeLat[eB[i]]).toFixed(6),
  }));
  return JSON.stringify({ ab: describe(blockAB, true), ba: describe(blockBA, false) });
})()`));
const blocked = [...selection.ab, ...selection.ba];
check('the patch selects a sane bridge-sized set of edges',
  blocked.length >= 6 && blocked.length <= 80, `selected ${blocked.length}`);
check('every patched edge is an unnamed trail in the bridge corridor',
  blocked.every((e) => e.trail && !e.named
    && e.mLon >= -122.3225 && e.mLon <= -122.3176
    && e.mLat >= 47.6513 && e.mLat <= 47.6553),
  JSON.stringify(blocked.filter((e) => !e.trail || e.named).slice(0, 3)));
// Trips across the bridge in BOTH directions, south approach to Campus
// Parkway and back. With the patch, no traversal may use a blocked
// direction, each direction must still cross on a side path, and the two
// directions must ride DIFFERENT sides — that separation is the entire
// point of the one-waying. (A per-edge centerline side check was tried
// here and reproduced the exact mis-siding the chain classification
// exists to fix.)
const trips = JSON.parse(worker.run(`(() => {
  const base = ${rules};
  const south = [-122.3220, 47.6500], north = [-122.3170, 47.6565];
  const run = (a, b, patch) => {
    const r = routeLeg(a, b, { ...base, rooseveltBridgePatch: patch },
      'balanced', false, false);
    if (!r.ok) return { ok: false, reason: r.reason };
    let blockedUses = 0;
    const usedPatched = [];
    for (let k = 0; k < r.edgeIds.length; k++) {
      const ei = r.edgeIds[k];
      const forward = eA[ei] === r.nodeIds[k];
      if (forward ? rooseveltPatchSets.blockAB.has(ei)
        : rooseveltPatchSets.blockBA.has(ei)) blockedUses++;
      if (rooseveltPatchSets.blockAB.has(ei)
        || rooseveltPatchSets.blockBA.has(ei)) usedPatched.push(ei);
    }
    const sidepathM = usedPatched.reduce((sum, ei) => sum + eLen[ei], 0);
    return { ok: true, distM: Math.round(r.distM), blockedUses,
      sidepathM: Math.round(sidepathM), usedPatched };
  };
  return JSON.stringify({
    northbound: run(south, north, true),
    southbound: run(north, south, true),
    off: run(south, north, false),
  });
})()`));
check('the trip routes with the patch on (both ways) and off',
  trips.northbound.ok && trips.southbound.ok && trips.off.ok,
  JSON.stringify({ nb: trips.northbound.ok, sb: trips.southbound.ok, off: trips.off.ok }));
check('under the patch no traversal rides a side path the wrong way',
  trips.northbound.blockedUses === 0 && trips.southbound.blockedUses === 0,
  JSON.stringify({ nb: trips.northbound.blockedUses, sb: trips.southbound.blockedUses }));
check('each direction still crosses the bridge on a side path',
  trips.northbound.sidepathM > 100 && trips.southbound.sidepathM > 100,
  JSON.stringify({ nb: trips.northbound.sidepathM, sb: trips.southbound.sidepathM }));
const nbSet = new Set(trips.northbound.usedPatched);
check('the two directions ride different sides',
  trips.southbound.usedPatched.every((ei) => !nbSet.has(ei)),
  JSON.stringify({ shared: trips.southbound.usedPatched.filter((ei) => nbSet.has(ei)) }));

done();
