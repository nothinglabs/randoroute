#!/usr/bin/env node
// The graph is one network, not an archipelago.
//
// Untagged footways and paths -- the connective tissue of parks and
// footbridges -- used to be excluded from the graph entirely, which severed it
// into 5,417 components: 33,391 stranded nodes, 1,248 islands that contained
// dedicated trail a rider could see on the map but never be routed onto.
// Spokane's Riverfront footbridge was a 14-node island; crossing the river
// beside a 64 m span cost a 5.8 km street detour.
//
// They are walk-your-bike links now, and this holds the repair: connectivity
// is measured on the shipped graph, and the specific crossing that exposed the
// problem must price as a crossing, not a detour.
import { routerWorker } from './testlib/harness.mjs';

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};

const w = routerWorker();
check('the graph loads', w.ready);

const conn = w.run(`(() => {
  const parent = new Int32Array(N);
  for (let i = 0; i < N; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let e = 0; e < E; e++) {
    const a = find(eA[e]), b = find(eB[e]);
    if (a !== b) parent[a] = b;
  }
  const size = new Map(), trail = new Map();
  for (let n = 0; n < N; n++) { const r = find(n); size.set(r, (size.get(r) || 0) + 1); }
  for (let e = 0; e < E; e++) {
    if (!((eFlags[e] & 8) || eFacility[e] >= 4)) continue;
    const r = find(eA[e]); trail.set(r, (trail.get(r) || 0) + 1);
  }
  const comps = [...size.values()].sort((a, b) => b - a);
  const largest = comps[0];
  let largestRoot = null;
  for (const [r, n] of size) if (n === largest) { largestRoot = r; break; }
  let trailIslands = 0;
  for (const r of trail.keys()) if (r !== largestRoot) trailIslands++;
  return { nodes: N, components: comps.length, largest,
    largestPct: 100 * largest / N, trailIslands };
})()`);

// Measured states: before the walk links 95.56% / 1,248 trail islands; after
// them (with the walk-only prune) 96.28% / 954, with 154k more nodes in the
// main network. The thresholds guard the achieved state: a regression to the
// old classifier -- or a prune that starts eating real trail -- fails loudly,
// while ordinary extract drift does not flap.
check(`the main component holds ${conn.largestPct.toFixed(2)}% of nodes (need > 96%)`,
  conn.largestPct > 96, JSON.stringify(conn));
check(`trail-bearing islands: ${conn.trailIslands} (need < 1100)`,
  conn.trailIslands < 1100, JSON.stringify(conn));

// The two kinds of walked edge stay distinguishable in the shipped graph:
// bit 8 prices an edge as a dismount, bit 128 records that a mapper actually
// wrote bicycle=dismount. The app warns (marker, stats, voice) only on the
// tagged ones, so a graph that stopped stamping the tag -- or stamped it on
// edges that are not dismounts at all -- would silently break that split.
const tags = w.run(`(() => {
  let tagged = 0, priced = 0, orphanTag = 0;
  for (let e = 0; e < E; e++) {
    if (eOfficial[e] & 8) priced++;
    if (eOfficial[e] & 128) { tagged++; if (!(eOfficial[e] & 8)) orphanTag++; }
  }
  return { tagged, priced, orphanTag };
})()`);
check(`bicycle=dismount tags are stamped: ${tags.tagged} tagged of ${tags.priced} priced`,
  tags.tagged > 0 && tags.tagged < tags.priced, JSON.stringify(tags));
check('and the tag never appears on an edge that is not priced as a dismount',
  tags.orphanTag === 0, JSON.stringify(tags));

// The crossing that exposed all of this: over the Spokane River beside the
// Riverfront footbridge. A route between banks must use a crossing -- any
// crossing -- rather than a many-kilometre street detour.
const RULES = { minShoulder: 4, maxSpeedNoShoulder: 25, upperMaxSpeed: 45,
  noUpperLimit: true, lanesNoShoulderOver: 4, busyNoShoulder: 2,
  allowSidewalkFallback: true, allowFreeways: true, allowMtbTrails: false,
  inferShoulderFromEdge: false, requireSafe: false };
w.messages.length = 0;
const reply = w.post({ type: 'route', id: 'riverfront',
  points: [[-117.42290, 47.66380], [-117.42290, 47.66230]],
  rules: RULES, mode: 'balanced' });
check('a route crosses the Spokane River at Riverfront Park', reply?.ok === true,
  JSON.stringify({ ok: reply?.ok, reason: reply?.reason }));
if (reply?.ok) {
  check(`and it is a crossing, not a detour: ${(reply.distM / 1000).toFixed(2)} km (need < 1.5 km)`,
    reply.distM < 1500, `${reply.distM} m`);
  check('and it dismounts rather than pretending the footbridge is ridable',
    reply.dismountM > 0, JSON.stringify({ dismountM: reply.dismountM }));
}

// Seattle's Pier 50: the Southworth/Kingston/Bremerton fast ferries and both
// water taxis board here, and the terminal's ONLY land access is a chain of
// bicycle=dismount sidewalk hops. When the walk-link sidewalk exclusion
// swallowed those, the terminal was reachable solely by arriving on another
// boat -- Seattle->Southworth rode six miles through West Seattle to catch a
// water taxi BACK to a dock 600 m from the start. Land access must stay a
// short walk from Pioneer Square, and the crossing must use the fast ferry.
w.messages.length = 0;
const pier = w.post({ type: 'route', id: 'pier50',
  points: [[-122.3320, 47.6025], [-122.3392, 47.6012]],
  rules: RULES, mode: 'balanced' });
check('Pier 50 is reachable from downtown by land', pier?.ok === true,
  JSON.stringify({ ok: pier?.ok, reason: pier?.reason }));
if (pier?.ok) {
  check(`and it is a short walk-in, not a voyage: ${(pier.distM / 1000).toFixed(2)} km (need < 2 km)`,
    pier.distM < 2000 && pier.ferryM === 0,
    JSON.stringify({ distM: pier.distM, ferryM: pier.ferryM }));
  check('walked where the terminal says to walk', pier.dismountM > 0,
    JSON.stringify({ dismountM: pier.dismountM }));
}
w.messages.length = 0;
const southworth = w.post({ type: 'route', id: 'southworth',
  points: [[-122.3320, 47.6025], [-122.4950, 47.5127]],
  rules: RULES, mode: 'balanced' });
check('Seattle to Southworth sails from Pier 50 rather than detouring to Fauntleroy',
  southworth?.ok === true && southworth.distM < 19500 && southworth.ferryM > 15000,
  JSON.stringify({ ok: southworth?.ok, distM: southworth?.distM, ferryM: southworth?.ferryM }));

// The Palouse to Cascades trail was severed twice near the Snoqualmie Tunnel
// by same-name mapping seams -- consecutive trail ways whose endpoints sit a
// metre apart without sharing an OSM node. The build stitches those now, and
// this is the ride that noticed: North Bend to Hyak is ~20 trail miles, and
// with the seams open every route was a 120-mile detour over other passes.
w.messages.length = 0;
const pass = w.post({ type: 'route', id: 'hyak',
  points: [[-121.7860, 47.4920], [-121.3980, 47.3930]],
  rules: RULES, mode: 'direct' });
check('North Bend reaches Hyak', pass?.ok === true,
  JSON.stringify({ ok: pass?.ok, reason: pass?.reason }));
if (pass?.ok) {
  check(`by the trail, not a 120-mile detour: ${(pass.distM / 1609).toFixed(1)} mi (need < 35 mi)`,
    pass.distM < 56000, `${Math.round(pass.distM)} m`);
  check('and it rides the Palouse to Cascades corridor',
    (pass.segs || []).some((s) => /Palouse to Cascades|Snoqualmie Tunnel/i.test(s.name || '')),
    JSON.stringify([...new Set((pass.segs || []).map((s) => s.name))].slice(0, 8)));
}

// The Interurban Trail passes 47 m from the kerb of Alderwood Mall Boulevard
// in Lynnwood, and its only access there is two signalized crossings joined
// by a few metres of sidewalk. Sidewalks are excluded from the graph as a
// class, and the class exclusion used to swallow those joins: every crossing
// dangled as a dead-end stub, the nearest usable trail entrance sat 800 m
// northeast, and a route asked to join the trail rode out and back PAST its
// own start -- the field-reported lollipop. The build now readmits a sidewalk
// fragment when it is the short span between two kept ways, and this is the
// join that noticed.
w.messages.length = 0;
const interurban = w.post({ type: 'route', id: 'interurban',
  points: [[-122.2870, 47.8180], [-122.28813, 47.81685]],
  rules: RULES, mode: 'balanced' });
check('the Interurban Trail is joinable beside Alderwood Mall Blvd',
  interurban?.ok === true,
  JSON.stringify({ ok: interurban?.ok, reason: interurban?.reason }));
if (interurban?.ok) {
  check(`by the crossings, not a lollipop: ${Math.round(interurban.distM)} m (need < 400 m)`,
    interurban.distM < 400, `${Math.round(interurban.distM)} m`);
}

// Start snapping measures to edge GEOMETRY, not to stored nodes. A rider
// standing mid-block beside a long street run used to snap to whatever node
// happened to be nearest -- sometimes a dead-end stub across the street --
// and the route began with a phantom detour. The distance returned must be
// the distance to the street itself.
const midblock = w.run(
  'nearestNode(-122.28709, 47.8186, { allowMtbTrails: false })');
check(`a mid-block point snaps to the street beside it: ${Math.round(midblock.distM)} m (need < 20 m)`,
  midblock.distM < 20, JSON.stringify(midblock));

console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
