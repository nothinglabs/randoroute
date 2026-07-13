/*
 * Client-side bike router v2. A* over the prebuilt graph (data/graph2.bin.gz,
 * scripts/build_graph.py) entirely in this worker — no routing server.
 *
 * Cost = estimated riding TIME (grade-aware speed model on baked-in DEM
 * elevations), scaled per riding mode:
 *   direct    — fastest ride; failing roads allowed with a slight nudge away
 *   balanced  — failing roads cost 3x their time; gentle preference for
 *               comfortable roads and bike infrastructure
 *   low       — low-stress only: failing roads are impassable
 * Prohibited ways are excluded at build time (or marked by the graph migration)
 * in every mode.
 */
'use strict';

let N = 0, E = 0, D = 0;
let nodeLon, nodeLat, nodeEle;
let eA, eB, eLen, eAsc, eDes, eSpeed, eFlags, eSh, eClass, eOff, eCnt;
let outStart, outTarget, outEdge, gLon, gLat;
let eName, nameOff, nameBytes;
let nodeHasLand;
let inGiant;
let nodeLocal;

const _dec = new TextDecoder();
// BGR4's signed shoulder byte normally ranges from -1 (unknown) to 127 ft.
// -128 is reserved by the migration tool for a WSDOT permanent bike
// restriction. It is a hard graph exclusion, never a routing penalty.
const PROHIBITED_SHOULDER = -128;
function edgeName(i) {
  const id = eName[i];
  return _dec.decode(nameBytes.subarray(nameOff[id], nameOff[id + 1]));
}

function loadGraph(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, false) !== 0x42475234) throw new Error('bad graph magic (want BGR4)');
  N = dv.getUint32(4, true); E = dv.getUint32(8, true); D = dv.getUint32(12, true);
  const G = dv.getUint32(16, true), U = dv.getUint32(20, true), B = dv.getUint32(24, true);
  let o = 28;
  const pad4 = () => { o += (4 - (o % 4)) % 4; };
  const f32 = (n) => { const a = new Float32Array(buf, o, n); o += 4 * n; return a; };
  const u32 = (n) => { const a = new Uint32Array(buf, o, n); o += 4 * n; return a; };
  const u16 = (n) => { const a = new Uint16Array(buf, o, n); o += 2 * n; return a; };
  const i16 = (n) => { const a = new Int16Array(buf, o, n); o += 2 * n; return a; };
  const u8 = (n) => { const a = new Uint8Array(buf, o, n); o += n; return a; };
  const i8 = (n) => { const a = new Int8Array(buf, o, n); o += n; return a; };
  nodeLon = f32(N); nodeLat = f32(N); nodeEle = i16(N);
  pad4();
  eA = u32(E); eB = u32(E); eLen = f32(E);
  eAsc = u16(E); eDes = u16(E);
  eSpeed = u8(E); eFlags = u8(E); eSh = i8(E); eClass = u8(E);
  pad4();
  eOff = u32(E);
  eCnt = u16(E);
  pad4();
  outStart = u32(N + 1); outTarget = u32(D); outEdge = u32(D);
  eName = u32(E); nameOff = u32(U + 1);
  gLon = f32(G); gLat = f32(G);
  nameBytes = u8(B);
  // Terminal detection for ferry boarding: a node touching any land edge.
  // (Mid-water junctions where ferry routes cross have only ferry edges.)
  nodeHasLand = new Uint8Array(N);
  for (let i = 0; i < E; i++) {
    if (!(eFlags[i] & 32)) { nodeHasLand[eA[i]] = 1; nodeHasLand[eB[i]] = 1; }
  }
  // The graph contains thousands of tiny disconnected fragments (private
  // loops, orphaned stubs). Snapping to one guarantees "no route", so mark
  // the giant component and snap only within it.
  const parent = new Int32Array(N);
  for (let i = 0; i < N; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let i = 0; i < E; i++) { const a = find(eA[i]), b = find(eB[i]); if (a !== b) parent[a] = b; }
  const compSize = new Map();
  for (let i = 0; i < N; i++) { const r = find(i); compSize.set(r, (compSize.get(r) || 0) + 1); }
  let giantRoot = -1, giantSize = 0;
  for (const [k, v] of compSize) if (v > giantSize) { giantSize = v; giantRoot = k; }
  inGiant = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (find(i) === giantRoot) inGiant[i] = 1;
  // Nodes touching at least one LOCAL, bicycle-legal edge (not a true freeway,
  // ferry, or permanent restriction):
  // snapping prefers these so a tap near I-5 does not board it. A bike-legal
  // limited-access state highway remains eligible as a normal snap target.
  nodeLocal = new Uint8Array(N);
  for (let i = 0; i < E; i++) {
    if (eSh[i] !== PROHIBITED_SHOULDER && !(eFlags[i] & (4 | 32))) {
      nodeLocal[eA[i]] = 1; nodeLocal[eB[i]] = 1;
    }
  }
}

const R = 6371000;
function havM(lon1, lat1, lon2, lat2) {
  const p1 = (lat1 * Math.PI) / 180, p2 = (lat2 * Math.PI) / 180;
  const dp = p2 - p1, dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function nearestNode(lon, lat) {
  const coslat = Math.cos((lat * Math.PI) / 180);
  let best = -1, bestD = Infinity;         // nearest of any kind
  let bestL = -1, bestLD = Infinity;       // nearest touching a local road
  for (let i = 0; i < N; i++) {
    if (!inGiant[i]) continue; // never snap onto a disconnected fragment
    const dx = (nodeLon[i] - lon) * coslat;
    const dy = nodeLat[i] - lat;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
    if (nodeLocal[i] && d < bestLD) { bestLD = d; bestL = i; }
  }
  // Prefer the local-road node unless it's much farther (>300 m extra) than
  // the absolute nearest — a tap beside I-90 should not board I-90.
  if (bestL >= 0 && best !== bestL) {
    const dAny = havM(lon, lat, nodeLon[best], nodeLat[best]);
    const dLoc = havM(lon, lat, nodeLon[bestL], nodeLat[bestL]);
    if (dLoc <= dAny + 300) return { node: bestL, distM: dLoc };
  }
  return { node: best, distM: havM(lon, lat, nodeLon[best], nodeLat[best]) };
}

// Mirrors the app's effectiveLevel() for packed edge attributes.
function edgeLevel(i, rules) {
  const flags = eFlags[i];
  if (eSh[i] === PROHIBITED_SHOULDER) return 4;      // WSDOT prohibition
  if (flags & 32) return 2;                         // ferry — no road rules apply
  if (flags & 4) return 4;                         // freeway: last-resort failure
  if (flags & 8) return 1;                          // dedicated infrastructure
  const limitedAccess = flags & 128;                // WSDOT bike-legal caution
  const spd = eSpeed[i];
  if (spd <= rules.freeMaxSpeed) return limitedAccess ? 3 : 1;
  // Designated bike route (USBR/regional): a vetted corridor is a known
  // quantity — it meets criteria regardless of shoulder/speed data.
  if (flags & 64) return limitedAccess ? 3 : 2;
  // eSh < 0 = unknown; pessimistic mode counts that as a 0 ft shoulder.
  let sh = eSh[i];
  if (sh < 0 && rules.unknownShoulderZero) sh = 0;
  if (!(flags & 2) && sh >= 0 && sh < rules.minShoulder) return 4;
  if (!rules.noUpperLimit && spd > rules.upperMaxSpeed) return 4;
  return limitedAccess ? 3 : 2;
}

/* ------------------------------------------------ time model */
// Flat cruising speed (m/s): one steady recreational pace everywhere — a
// dedicated trail allows full transit speed, so it is never modeled slower
// than a road.
const V_ROAD = 5.6;   // ~12.5 mph
const V_MAX = 12.0;   // ~27 mph downhill cap
const V_MIN = 1.3;    // steep-climb floor (~3 mph)
// A* heuristic speed: must not undershoot any effective edge speed, including
// fast ferries and the strongest cost bonuses, or A* loses optimality.
// Worst case: V_MAX 12 / (0.9 L1 bonus x 0.45 strong-preference) = 29.6 m/s.
const V_HEUR = 30.0;
// Designated bike routes (USBR / regional trails, edge flag 64) get a cost
// bonus in Balanced/Low-stress: a vetted corridor wins ties against an
// equivalent plain road. Cost only — reported times stay honest.
const DESIGNATED_MULT = 0.9;
// "Strongly prefer bike routes & trails": designated routes and dedicated
// infrastructure at half cost or better — worth riding up to ~2x the distance
// to stay on a trail. Ferries keep their own economics.
const PREF_DESIG_MULT = 0.45;
// OSM road class is carried directly in BGR4.  This deliberately does not use
// speed as a stand-in: a signed 25 mph arterial (such as NW 80th in Seattle)
// is not a residential street.  The preference is a cost bonus, not a rule;
// it still lets a shorter/safer non-residential connection win when needed.
const PREF_RESIDENTIAL_MULT = 0.78;
function isResidential(i) {
  return eClass[i] === 1 || eClass[i] === 2; // residential / living_street
}
// Freeways are a true last resort: even a short ordinary failure should win
// over a much longer freeway detour.
const FREEWAY_LAST_RESORT_MULT = 60;
// WSDOT LimitedAccess is not a bike prohibition. When its own speed/shoulder
// data passes the rider's rules, it remains a caution that is preferable to a
// known rule failure, but less attractive than an ordinary passing road. In
// Low-stress mode its normal high-speed cost is enough: adding a separate
// 3x surcharge can make it lose to a known narrow-shoulder rule failure.
const LIMITED_ACCESS_CAUTION_MULT = { direct: 1.05, balanced: 1.35, low: 1 };
// Average terminal wait folded into a ferry leg, applied once when boarding
// from land (mid-water route junctions don't re-charge it).
const FERRY_BOARD_S = 15 * 60;

// Graded pressure toward slower roads: every mph of speed limit over the
// rider's comfort speed makes a road edge cost more (1%/mph balanced,
// 2%/mph low-stress). Trails, ferries, and Direct mode are exempt — a
// 45 mph road costs ~20-40% over a 25 mph street of the same length.
function speedStress(mode, fl, spd, freeMax) {
  if (mode === 'direct' || (fl & (8 | 32))) return 1.0;
  const over = spd - freeMax;
  if (over <= 0) return 1.0;
  return 1 + (mode === 'low' ? 0.02 : 0.01) * over;
}

// Seconds to ride edge i in the given direction (forward = a->b).
function edgeTimeS(i, forward) {
  if (eFlags[i] & 32) {
    // Ferry: sail at the crossing speed baked from the duration tag (mph).
    return eLen[i] / (Math.max(eSpeed[i], 3) * 0.44704);
  }
  const len = eLen[i];
  const asc = forward ? eAsc[i] : eDes[i];
  const des = forward ? eDes[i] : eAsc[i];
  const vflat = V_ROAD;
  const g = (asc - des) / Math.max(len, 1); // net grade
  let v;
  if (g > 0) v = Math.max(vflat * Math.exp(-7 * g), V_MIN);
  else v = Math.min(vflat * (1 - 2.5 * g), V_MAX);
  let t = len / v;
  // Undulation beyond the net climb still costs energy/time (~6 s per meter
  // of extra up-and-down that the net grade doesn't see).
  const extra = asc - Math.max(asc - des, 0);
  t += extra * 6 * 0.5;
  return t;
}

/* ------------------------------------------------ riding modes */
// Multiplier applied to an edge's TIME. Low-stress uses a huge (but finite)
// penalty: it takes any reasonable detour to avoid failing roads, yet still
// returns a route when some failing pavement is truly unavoidable — the app
// highlights those segments instead of refusing to route.
function modeMult(mode, lvl) {
  if (mode === 'direct') return lvl === 4 ? 1.15 : 1.0;
  if (mode === 'balanced') return lvl === 4 ? 3.0 : lvl === 1 ? 0.92 : 1.0;
  /* low */ return lvl === 4 ? 30.0 : lvl === 1 ? 0.9 : 1.0;
}

function routeLeg(startLL, endLL, rules, mode, prefDesig, prefResidential) {
  const t0 = Date.now();
  const s = nearestNode(startLL[0], startLL[1]);
  const t = nearestNode(endLL[0], endLL[1]);
  const farPoints = [];
  if (s.distM > 2000) farPoints.push({ pointOffset: 0, distanceM: s.distM });
  if (t.distM > 2000) farPoints.push({ pointOffset: 1, distanceM: t.distM });
  if (farPoints.length) {
    return {
      ok: false,
      code: 'point-too-far',
      reason: 'A route point is too far from a routable road or path.',
      farPoints,
    };
  }

  const goalLon = nodeLon[t.node], goalLat = nodeLat[t.node];
  const dist = new Float64Array(N).fill(Infinity);
  const prevNode = new Int32Array(N).fill(-1);
  const prevEdge = new Int32Array(N).fill(-1);
  const done = new Uint8Array(N);
  const heap = makeHeap(4096);
  const h = (n) => havM(nodeLon[n], nodeLat[n], goalLon, goalLat) / V_HEUR;
  dist[s.node] = 0;
  heap.push(h(s.node), s.node);

  let found = false;
  while (heap.size) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === t.node) { found = true; break; }
    const du = dist[u];
    for (let a = outStart[u]; a < outStart[u + 1]; a++) {
      const v = outTarget[a];
      if (done[v]) continue;
      const ei = outEdge[a];
      const fl = eFlags[ei];
      // Permanent WSDOT bike restriction: never traverse it, in any mode or
      // with any setting. This is intentionally before all cost/rules logic.
      if (eSh[ei] === PROHIBITED_SHOULDER) continue;
      // This setting controls whether a true freeway can be used at all. When it
      // can, its level and cost still make it a route failure and last resort.
      if (!rules.allowFreeways && (fl & 4)) continue;
      const lvl = edgeLevel(ei, rules);
      // "Fail if no complete safe route": failing roads become impassable in
      // EVERY mode — the mode then picks among fully-passing routes only.
      if (rules.requireSafe && lvl === 4) continue;
      const mult = modeMult(mode, lvl);
      if (mult === Infinity) continue;
      const forward = eA[ei] === u;
      let step = edgeTimeS(ei, forward);
      if ((fl & 32) && nodeHasLand[u]) step += FERRY_BOARD_S; // boarding
      let cost = step * mult;
      cost *= speedStress(mode, fl, eSpeed[ei], rules.freeMaxSpeed);
      if (fl & 4) cost *= FREEWAY_LAST_RESORT_MULT;
      if (fl & 128) cost *= LIMITED_ACCESS_CAUTION_MULT[mode];
      // Bonuses never apply to freeway or WSDOT limited-access highways:
      // a designation should not erase their extra caution cost.
      if (prefDesig && !(fl & (32 | 4 | 128)) && (fl & (64 | 8))) cost *= PREF_DESIG_MULT;
      else if ((fl & 64) && !(fl & (4 | 128)) && mode !== 'direct') cost *= DESIGNATED_MULT;
      if (prefResidential && !(fl & (8 | 32 | 4 | 128)) && isResidential(ei)) {
        cost *= PREF_RESIDENTIAL_MULT;
      }
      const nd = du + cost;
      if (nd < dist[v]) {
        dist[v] = nd;
        prevNode[v] = u;
        prevEdge[v] = ei;
        heap.push(nd + h(v), v);
      }
    }
  }
  if (!found) {
    return {
      ok: false,
      reason: rules.requireSafe
        ? 'No complete safe route exists under your rules — relax a rule, or uncheck “Fail if no complete safe route”.'
        : 'No route exists on the rideable network between these points.',
    };
  }

  // Reconstruct (goal -> start), then emit forward.
  const edges = [];
  for (let v = t.node; v !== s.node; v = prevNode[v]) edges.push([prevEdge[v], prevNode[v]]);
  edges.reverse();

  const coords = [];
  const profile = []; // [cumulative meters, elevation m] per node along the route
  const ferryRanges = []; // coord index ranges covered by ferry legs
  const segs = [];        // per-edge attrs for the tap-to-inspect route readout
  let distM = 0, timeS = 0, ascentM = 0, descentM = 0, failM = 0, ferryM = 0, desigM = 0;
  for (const [ei, fromNode] of edges) {
    const off = eOff[ei], cnt = eCnt[ei];
    const forward = eA[ei] === fromNode;
    if (coords.length === 0) {
      const j = forward ? 0 : cnt - 1;
      coords.push([gLon[off + j], gLat[off + j]]);
      profile.push([0, nodeEle[fromNode]]);
    }
    const c0 = coords.length - 1;
    if (forward) for (let j = 1; j < cnt; j++) coords.push([gLon[off + j], gLat[off + j]]);
    else for (let j = cnt - 2; j >= 0; j--) coords.push([gLon[off + j], gLat[off + j]]);
    distM += eLen[ei];
    timeS += edgeTimeS(ei, forward);
    if (eFlags[ei] & 32) {
      if (nodeHasLand[fromNode]) timeS += FERRY_BOARD_S;
      ferryM += eLen[ei];
      const last = ferryRanges[ferryRanges.length - 1];
      if (last && last[1] === c0) last[1] = coords.length - 1;
      else ferryRanges.push([c0, coords.length - 1]);
    }
    ascentM += forward ? eAsc[ei] : eDes[ei];
    descentM += forward ? eDes[ei] : eAsc[ei];
    if (eFlags[ei] & 64) desigM += eLen[ei];
    const level = edgeLevel(ei, rules);
    if (level === 4) failM += eLen[ei];
    segs.push({ c0, c1: coords.length - 1, name: edgeName(ei),
      mph: eSpeed[ei], sh: eSh[ei], flags: eFlags[ei], roadClass: eClass[ei], level,
      lenM: Math.round(eLen[ei]) });
    const toNode = forward ? eB[ei] : eA[ei];
    profile.push([distM, nodeEle[toNode]]);
  }
  const ferrySegs = ferryRanges.map(([a, b]) => coords.slice(a, b + 1));
  return {
    ok: true, coords, distM, timeS, ascentM, descentM, failM, ferryM, ferrySegs, desigM, segs,
    profile, snapStartM: s.distM, snapEndM: t.distM, ms: Date.now() - t0,
  };
}

// Route through an ordered list of points (A -> B -> C ...): one A* per leg,
// results merged into a single continuous route.
function route(points, rules, mode, prefDesig, prefResidential) {
  const t0 = Date.now();
  const legs = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const leg = routeLeg(points[i], points[i + 1], rules, mode, prefDesig, prefResidential);
    if (!leg.ok) {
      if (leg.code === 'point-too-far') {
        leg.farPoints = leg.farPoints.map((p) => ({
          pointIndex: i + p.pointOffset,
          distanceM: p.distanceM,
        }));
        leg.pointCount = points.length;
      }
      return leg;
    }
    legs.push(leg);
  }
  const coords = [], segs = [], ferrySegs = [], profile = [];
  const legSummaries = legs.map((l) => ({ distM: l.distM, timeS: l.timeS, failM: l.failM }));
  let distM = 0, timeS = 0, ascentM = 0, descentM = 0, failM = 0, ferryM = 0, desigM = 0;
  for (const leg of legs) {
    const cOff = coords.length ? coords.length - 1 : 0; // joint vertex is shared
    for (let j = coords.length ? 1 : 0; j < leg.coords.length; j++) coords.push(leg.coords[j]);
    for (const g of leg.segs) segs.push({ ...g, c0: g.c0 + cOff, c1: g.c1 + cOff });
    for (const f of leg.ferrySegs) ferrySegs.push(f);
    for (let j = profile.length ? 1 : 0; j < leg.profile.length; j++)
      profile.push([leg.profile[j][0] + distM, leg.profile[j][1]]);
    distM += leg.distM; timeS += leg.timeS; ascentM += leg.ascentM; descentM += leg.descentM;
    failM += leg.failM; ferryM += leg.ferryM; desigM += leg.desigM;
  }
  // Downsample the profile to <= 240 points for the sparkline.
  let prof = profile;
  if (prof.length > 240) {
    const stepN = prof.length / 240;
    const ds = [];
    for (let i = 0; i < prof.length; i += stepN) ds.push(prof[Math.floor(i)]);
    ds.push(prof[prof.length - 1]);
    prof = ds;
  }
  return {
    ok: true, coords, distM, timeS, ascentM, descentM, failM, ferryM, ferrySegs, desigM, segs,
    legs: legSummaries,
    profile: prof, snapStartM: legs[0].snapStartM, snapEndM: legs[legs.length - 1].snapEndM,
    ms: Date.now() - t0,
  };
}

// Binary min-heap on (key, node) pairs.
function makeHeap(cap) {
  let keys = new Float64Array(cap), vals = new Int32Array(cap), n = 0;
  return {
    get size() { return n; },
    push(k, v) {
      if (n === keys.length) {
        const k2 = new Float64Array(n * 2), v2 = new Int32Array(n * 2);
        k2.set(keys); v2.set(vals); keys = k2; vals = v2;
      }
      let i = n++; keys[i] = k; vals[i] = v;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (keys[p] <= keys[i]) break;
        const tk = keys[p]; keys[p] = keys[i]; keys[i] = tk;
        const tv = vals[p]; vals[p] = vals[i]; vals[i] = tv;
        i = p;
      }
    },
    pop() {
      const topV = vals[0]; n--;
      keys[0] = keys[n]; vals[0] = vals[n];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let s = i;
        if (l < n && keys[l] < keys[s]) s = l;
        if (r < n && keys[r] < keys[s]) s = r;
        if (s === i) break;
        const tk = keys[s]; keys[s] = keys[i]; keys[i] = tk;
        const tv = vals[s]; vals[s] = vals[i]; vals[i] = tv;
        i = s;
      }
      return topV;
    },
  };
}

onmessage = (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'graph') {
      loadGraph(m.buffer);
      postMessage({ type: 'ready', nodes: N, edges: E });
    } else if (m.type === 'route') {
      const pts = m.points && m.points.length >= 2 ? m.points : [m.start, m.end];
      const r = route(pts, m.rules, m.mode || 'balanced', !!m.prefDesignated, !!m.prefResidential);
      postMessage({ type: 'route', id: m.id, ...r });
    }
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
