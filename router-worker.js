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
 * Prohibited ways were excluded from the graph at build time in every mode.
 */
'use strict';

let N = 0, E = 0, D = 0;
let nodeLon, nodeLat, nodeEle;
let eA, eB, eLen, eAsc, eDes, eSpeed, eFlags, eSh, eOff, eCnt;
let outStart, outTarget, outEdge, gLon, gLat;
let eName, nameOff, nameBytes;
let nodeHasLand;
let inGiant;

const _dec = new TextDecoder();
function edgeName(i) {
  const id = eName[i];
  return _dec.decode(nameBytes.subarray(nameOff[id], nameOff[id + 1]));
}

function loadGraph(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, false) !== 0x42475233) throw new Error('bad graph magic (want BGR3)');
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
  eSpeed = u8(E); eFlags = u8(E); eSh = i8(E);
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
  let best = -1, bestD = Infinity;
  for (let i = 0; i < N; i++) {
    if (!inGiant[i]) continue; // never snap onto a disconnected fragment
    const dx = (nodeLon[i] - lon) * coslat;
    const dy = nodeLat[i] - lat;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return { node: best, distM: havM(lon, lat, nodeLon[best], nodeLat[best]) };
}

// Mirrors the app's effectiveLevel() for packed edge attributes.
function edgeLevel(i, rules) {
  const flags = eFlags[i];
  if (flags & 32) return 2;                         // ferry — no road rules apply
  if (flags & 4 && !rules.allowFreeways) return 4; // limited access
  if (flags & 8) return 1;                          // dedicated infrastructure
  const spd = eSpeed[i];
  if (spd <= rules.freeMaxSpeed) return 1;
  // Designated bike route (USBR/regional): a vetted corridor is a known
  // quantity — it meets criteria regardless of shoulder/speed data.
  if (flags & 64) return 2;
  // eSh < 0 = unknown; pessimistic mode counts that as a 0 ft shoulder.
  let sh = eSh[i];
  if (sh < 0 && rules.unknownShoulderZero) sh = 0;
  if (!(flags & 2) && sh >= 0 && sh < rules.minShoulder) return 4;
  if (!rules.noUpperLimit && spd > rules.upperMaxSpeed) return 4;
  return 2;
}

/* ------------------------------------------------ time model */
// Flat cruising speed (m/s): dedicated infrastructure is a touch slower
// (shared paths, tighter geometry); roads assume a steady recreational pace.
const V_ROAD = 5.6;   // ~12.5 mph
const V_INFRA = 5.0;  // ~11.2 mph
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
// Average terminal wait folded into a ferry leg, applied once when boarding
// from land (mid-water route junctions don't re-charge it).
const FERRY_BOARD_S = 15 * 60;

// Seconds to ride edge i in the given direction (forward = a->b).
function edgeTimeS(i, forward) {
  if (eFlags[i] & 32) {
    // Ferry: sail at the crossing speed baked from the duration tag (mph).
    return eLen[i] / (Math.max(eSpeed[i], 3) * 0.44704);
  }
  const len = eLen[i];
  const asc = forward ? eAsc[i] : eDes[i];
  const des = forward ? eDes[i] : eAsc[i];
  const vflat = (eFlags[i] & 8) ? V_INFRA : V_ROAD;
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

function route(startLL, endLL, rules, mode, prefDesig) {
  const t0 = Date.now();
  const s = nearestNode(startLL[0], startLL[1]);
  const t = nearestNode(endLL[0], endLL[1]);
  if (s.distM > 2000) return { ok: false, reason: 'Start is too far from a rideable road.' };
  if (t.distM > 2000) return { ok: false, reason: 'End is too far from a rideable road.' };

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
      const mult = modeMult(mode, edgeLevel(ei, rules));
      if (mult === Infinity) continue;
      const forward = eA[ei] === u;
      let step = edgeTimeS(ei, forward);
      if ((eFlags[ei] & 32) && nodeHasLand[u]) step += FERRY_BOARD_S; // boarding
      let cost = step * mult;
      const fl = eFlags[ei];
      if (prefDesig && !(fl & 32) && (fl & (64 | 8))) cost *= PREF_DESIG_MULT;
      else if ((fl & 64) && mode !== 'direct') cost *= DESIGNATED_MULT;
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
    // With finite mode multipliers this only happens when the endpoints are
    // on genuinely disconnected pieces of the network.
    return { ok: false, reason: 'No route exists on the rideable network between these points.' };
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
    if (edgeLevel(ei, rules) === 4) failM += eLen[ei];
    segs.push({ c0, c1: coords.length - 1, name: edgeName(ei),
      mph: eSpeed[ei], sh: eSh[ei], flags: eFlags[ei], lenM: Math.round(eLen[ei]) });
    const toNode = forward ? eB[ei] : eA[ei];
    profile.push([distM, nodeEle[toNode]]);
  }
  const ferrySegs = ferryRanges.map(([a, b]) => coords.slice(a, b + 1));
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
    profile: prof, snapStartM: s.distM, snapEndM: t.distM, ms: Date.now() - t0,
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
      const r = route(m.start, m.end, m.rules, m.mode || 'balanced', !!m.prefDesignated);
      postMessage({ type: 'route', id: m.id, ...r });
    }
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
