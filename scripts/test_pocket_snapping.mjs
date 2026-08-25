#!/usr/bin/env node
// A tap on a spot bikes can leave but never enter -- a freeway ramp, a
// downhill-only MTB run -- must not refuse the trip. The undirected
// giant-component guard cannot see these pockets (they are connected, by
// arcs pointing out), so the snap used to succeed, the search explored the
// whole graph, and the rider was told no route exists when a reachable
// point sat metres away (audit C1). The failure path now detects the
// pocket, re-snaps to the nearest enterable edge, retries once, and tells
// the rider what moved.
import { check, done, routerWorker } from './testlib/harness.mjs';

const w = routerWorker({ state: 'washington' });
check('the Washington graph loads', w.ready);

const RULES = { minShoulder: 0, maxSpeed: 99, allowFreeways: true };

// Find a real exit-only pocket: build the reverse adjacency once, then test
// freeway-adjacent nodes (ramps are the densest source of pockets) with the
// same bounded reverse walk the worker uses.
const found = w.run(`(() => {
  const D = outTarget.length;
  const inOff = new Uint32Array(N + 1);
  for (let a = 0; a < D; a++) inOff[outTarget[a] + 1]++;
  for (let n = 0; n < N; n++) inOff[n + 1] += inOff[n];
  const inFrom = new Uint32Array(D);
  const cursor = inOff.slice(0, N + 1);
  for (let u = 0; u < N; u++) {
    for (let a = outStart[u]; a < outStart[u + 1]; a++) {
      inFrom[cursor[outTarget[a]]++] = u;
    }
  }
  const pocketAt = (seed) => {
    const visited = new Set([seed]);
    const queue = [seed];
    for (let qi = 0; qi < queue.length; qi++) {
      const u = queue[qi];
      for (let a = inOff[u]; a < inOff[u + 1]; a++) {
        const v = inFrom[a];
        if (visited.has(v)) continue;
        visited.add(v);
        if (visited.size > 4000) return null;
        queue.push(v);
      }
    }
    return visited;
  };
  // Ramps rarely CAPTURE a snap -- nearestNode prefers a usable local edge
  // within 300 m, which is usually the street beside the ramp. The pockets
  // that win snaps are the local-class ones: directional MTB networks. The
  // premise check inside the loop guarantees the returned pocket is one a
  // bare tap actually lands in.
  let tested = 0;
  for (let ei = 0; ei < E; ei++) {
    const seed = eA[ei];
    if (!inGiant[seed]) continue;         // the guard C1 slips past
    if (!(eOfficial[ei] & EDGE_MTB)) continue;
    if (tested >= 4000) break;
    tested++;
    const pocket = pocketAt(seed);
    if (!pocket || pocket.size < 2) continue;
    const lon = nodeLon[seed], lat = nodeLat[seed];
    if (!pocket.has(nearestNode(lon, lat, null).node)) continue;
    return { node: seed, size: pocket.size, lon, lat };
  }
  return null;
})()`);
check('the graph contains an exit-only pocket to test against', !!found,
  JSON.stringify(found));

if (found) {
  // The premise: an unassisted snap at this spot lands inside the pocket.
  const premise = w.run(`(() => {
    const rules = { minShoulder: 0, maxSpeed: 99, allowFreeways: true };
    const snap = nearestNode(${found.lon}, ${found.lat}, rules);
    const pocket = directionalPocket(snap.node, { rules });
    return { snapped: snap.node, inPocket: !!pocket };
  })()`);
  check('a bare tap here snaps into the pocket (the C1 premise)',
    premise.inPocket, JSON.stringify({ found, premise }));

  // A start a few km away, routed TO the pocket spot: this exact request
  // used to return "No route exists on the rideable network".
  const start = [found.lon + 0.03, found.lat + 0.01];
  const reply = w.post({ type: 'route', id: 'pocket-dest',
    points: [start, [found.lon, found.lat]],
    rules: RULES, mode: 'balanced' });
  check('routing to the pocket now succeeds instead of refusing',
    reply?.ok === true, JSON.stringify({ ok: reply?.ok, reason: reply?.reason }));
  if (reply?.ok) {
    const end = reply.coords[reply.coords.length - 1];
    const kx = 111320 * Math.cos(found.lat * Math.PI / 180);
    const movedM = Math.hypot((end[0] - found.lon) * kx, (end[1] - found.lat) * 110540);
    check(`the trip ends just outside the pocket (${Math.round(movedM)} m away, need < 2000)`,
      movedM > 0 && movedM < 2000, JSON.stringify(end));
  }

  // The portfolio reply names the adjustment so the app can tell the rider.
  const options = w.post({ type: 'route-options', id: 'pocket-portfolio',
    points: [start, [found.lon, found.lat]], rules: RULES });
  check('the portfolio carries a destination snap note',
    options?.ok === true && Array.isArray(options.snapNotes)
      && options.snapNotes.some((note) => note.last && note.movedM >= 0),
    JSON.stringify({ ok: options?.ok, snapNotes: options?.snapNotes }));
}

// An ordinary trip must never pay the probe or move a snap.
const plain = w.post({ type: 'route-options', id: 'plain',
  points: [[-122.3321, 47.6062], [-122.3035, 47.6553]], rules: RULES });
check('an ordinary trip routes with no snap notes',
  plain?.ok === true && (plain.snapNotes || []).length === 0,
  JSON.stringify({ ok: plain?.ok, snapNotes: plain?.snapNotes }));

done();
