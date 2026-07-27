/*
 * Client-side bike router v2. A* over the prebuilt graph (data/graph2.bin.gz,
 * scripts/build_graph.py) entirely in this worker — no routing server.
 *
 * Cost = estimated riding TIME (grade-aware speed model on baked-in DEM
 * elevations), scaled across several internal optimization profiles. A route
 * request tests those profiles, removes near-duplicates, and returns up to five
 * genuinely different choices ordered roughly from efficient to friendly.
 * Prohibited ways are excluded at build time (or marked by the graph migration)
 * in every mode.
 */
'use strict';

let N = 0, E = 0, D = 0;
let nodeLon, nodeLat, nodeEle;
let eA, eB, eLen, eAsc, eDes, eSpeed, eSpeedBA, eFlags, eSh, eShBA, eLimitedDir;
let eClass, eFacility, eOfficial, eSurface;
// Format 10 only; null on a BGR9 graph.
let eLanes, eLts;
let eHazAB, eHazBA, eHazStartAB, eHazEndAB, eHazStartBA, eHazEndBA, eOff, eCnt;
let outStart, outTarget, outEdge, gLon, gLat;
let eName, nameOff, nameBytes;
let eBearingA, eBearingB;
let searchDist, searchPrevArc, searchStamp, searchGeneration = 0;
let nodeHasLand;
let inGiant;
let nodeLocal, nodeNonMtb;
// Set for the duration of one request. A road block snaps to a graph node and
// makes every road edge through that location unavailable to the search.
let activeRoadBlockEdges = null;

const _dec = new TextDecoder();
// The signed shoulder byte normally ranges from -1 (unknown) to 127 ft.
// -128 is reserved by the migration tool for a WSDOT permanent bike
// restriction. It is a hard graph exclusion, never a routing penalty.
const PROHIBITED_SHOULDER = -128;
// "Only show routes fully matching safety rules" exemption: the block or two touching a leg's
// endpoints must stay traversable even when it fails the rules — you have to
// reach the door somehow. Only edges near a terminus qualify, and only short
// ones, so the exemption can never leak a failing shortcut into mid-route.
const ACCESS_RADIUS_M = 300;   // ~1,000 ft around each leg endpoint
const ACCESS_EDGE_MAX_M = 800; // a qualifying edge must itself be short
// A failing edge this short, between passing neighbors, is a road CROSSING —
// the few meters of a busy road's own pavement at a signal or trail crossing —
// not riding along the failing road. Crossings are never rule violations.
const CROSSING_MAX_M = 40;
// A fully-matching search provisionally admits short failing edges because a
// crossing can span graph fragments. If the reconstructed movement is not a
// valid crossing, retry with those fragments blocked. Bound the retries so a
// pathological graph cannot turn one request into an unbounded search loop.
const CROSSING_RETRY_LIMIT = 8;
// Bit 4 of the graph's metadata byte marks OSM paths explicitly identified as
// mountain-bike infrastructure (including mtb:scale:imba). They remain in the
// graph for the rider-controlled option, but are unavailable by default.
const EDGE_MTB = 4;
// Stored in the graph's compact edge-source byte. Unlike bicycle=no, a
// bicycle=dismount edge is legal when the rider walks the bike through it.
const EDGE_DISMOUNT = 8;
// OSM sidewalk state and build-time Census urban context share the existing
// metadata byte, so this rule adds no per-edge graph storage.
const EDGE_SIDEWALK = 16;
const EDGE_SIDEWALK_NO = 32;
const EDGE_URBAN = 64;
const SURFACE_UNKNOWN = 0;
const SURFACE_PAVED = 1;
const SURFACE_GRAVEL = 2;
const SURFACE_ROUGH = 3;
const SURFACE_LABEL = ['Unknown', 'Paved', 'Gravel / compacted', 'Unpaved'];
function edgeName(i) {
  const id = eName[i];
  return _dec.decode(nameBytes.subarray(nameOff[id], nameOff[id + 1]));
}

function bearingDeg(fromLon, fromLat, toLon, toLat) {
  const p1 = fromLat * Math.PI / 180, p2 = toLat * Math.PI / 180;
  const dl = (toLon - fromLon) * Math.PI / 180;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function loadGraph(buf) {
  const dv = new DataView(buf);
  // 'BGR9' and 'BGRA'. 'BGRA' is format 10 — the magic is four bytes, so 10 is
  // written as the hex digit A. Format 10 appends edgeLanes and edgeLts after
  // edgeSurface. Reading both means a released worker keeps routing on the
  // graph already cached on riders' phones, and the next data rebuild upgrades
  // them without a coordinated deploy.
  const magic = dv.getUint32(0, false);
  const hasTrafficStress = magic === 0x42475241;
  if (magic !== 0x42475239 && !hasTrafficStress) {
    throw new Error('bad graph magic (want BGR9 or BGRA)');
  }
  N = dv.getUint32(4, true); E = dv.getUint32(8, true); D = dv.getUint32(12, true);
  const G = dv.getUint32(16, true), U = dv.getUint32(20, true), B = dv.getUint32(24, true);
  let o = 28;
  const pad4 = () => { o += (4 - (o % 4)) % 4; };
  const pad2 = () => { o += o % 2; };
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
  eSpeed = u8(E); eSpeedBA = u8(E); eFlags = u8(E);
  eSh = i8(E); eShBA = i8(E); eLimitedDir = u8(E); eClass = u8(E);
  eFacility = u8(E); eOfficial = u8(E); eSurface = u8(E);
  // On a BGR9 graph these stay null and every lookup reports "not tagged", so
  // scoring behaves exactly as it did before the fields existed.
  eLanes = hasTrafficStress ? u8(E) : null;
  eLts = hasTrafficStress ? u8(E) : null;
  eHazAB = u8(E); eHazBA = u8(E);
  pad2();
  eHazStartAB = u16(E); eHazEndAB = u16(E);
  eHazStartBA = u16(E); eHazEndBA = u16(E);
  pad4();
  eOff = u32(E);
  eCnt = u16(E);
  pad4();
  outStart = u32(N + 1); outTarget = u32(D); outEdge = u32(D);
  eName = u32(E); nameOff = u32(U + 1);
  gLon = f32(G); gLat = f32(G);
  nameBytes = u8(B);
  postMessage({ type: 'progress', phase: 'engine', detail: 'Indexing roads, trails, ferries, and restrictions…' });
  // Outbound bearings at each end let A* price real intersection turns. Use
  // the first non-duplicate geometry point so a straight road split into many
  // graph edges does not acquire an artificial turn cost.
  eBearingA = new Float32Array(E);
  eBearingB = new Float32Array(E);
  for (let i = 0; i < E; i++) {
    const off = eOff[i], end = off + eCnt[i] - 1;
    let aNext = Math.min(end, off + 1);
    while (aNext < end && gLon[aNext] === gLon[off] && gLat[aNext] === gLat[off]) aNext++;
    let bNext = Math.max(off, end - 1);
    while (bNext > off && gLon[bNext] === gLon[end] && gLat[bNext] === gLat[end]) bNext--;
    eBearingA[i] = bearingDeg(gLon[off], gLat[off], gLon[aNext], gLat[aNext]);
    eBearingB[i] = bearingDeg(gLon[end], gLat[end], gLon[bNext], gLat[bNext]);
  }
  // Reuse the large edge-state workspace across the many profile searches in
  // one request. Generation stamps avoid clearing 1M+ entries each time.
  searchDist = new Float64Array(D);
  searchPrevArc = new Int32Array(D);
  searchStamp = new Int32Array(D);
  // Terminal detection for ferry boarding: a node touching any land edge.
  // (Mid-water junctions where ferry routes cross have only ferry edges.)
  nodeHasLand = new Uint8Array(N);
  for (let i = 0; i < E; i++) {
    if (!(eFlags[i] & 32)) { nodeHasLand[eA[i]] = 1; nodeHasLand[eB[i]] = 1; }
  }
  postMessage({ type: 'progress', phase: 'engine', detail: 'Connecting the statewide bicycle network…' });
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
  postMessage({ type: 'progress', phase: 'engine', detail: 'Preparing fast start and destination matching…' });
  // Nodes touching at least one LOCAL, bicycle-legal edge (not a true freeway,
  // ferry, or permanent restriction):
  // snapping prefers these so a tap near I-5 does not board it. A bike-legal
  // limited-access state highway remains eligible as a normal snap target.
  nodeLocal = new Uint8Array(N);
  // Keep a second set with explicitly technical MTB paths removed. When the
  // option is off, a point beside one should attach to the closest ordinary
  // bike network rather than snap onto an edge that A* will reject.
  nodeNonMtb = new Uint8Array(N);
  for (let i = 0; i < E; i++) {
    const hasLegalDirection = eSh[i] !== PROHIBITED_SHOULDER
      || (!(eFlags[i] & 16) && eShBA[i] !== PROHIBITED_SHOULDER);
    if (hasLegalDirection && !(eFlags[i] & (4 | 32))) {
      nodeLocal[eA[i]] = 1; nodeLocal[eB[i]] = 1;
      if (!(eOfficial[i] & EDGE_MTB)) {
        nodeNonMtb[eA[i]] = 1; nodeNonMtb[eB[i]] = 1;
      }
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

function nearestNode(lon, lat, rules = null) {
  const coslat = Math.cos((lat * Math.PI) / 180);
  let best = -1, bestD = Infinity;         // nearest of any kind
  let bestL = -1, bestLD = Infinity;       // nearest usable local-network node
  const usableLocal = rules?.allowMtbTrails ? nodeLocal : nodeNonMtb;
  for (let i = 0; i < N; i++) {
    if (!inGiant[i]) continue; // never snap onto a disconnected fragment
    const dx = (nodeLon[i] - lon) * coslat;
    const dy = nodeLat[i] - lat;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
    if (usableLocal[i] && d < bestLD) { bestLD = d; bestL = i; }
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

const ROAD_BLOCK_NEARBY_M = 16;

function roadBlockEdgeSet(points) {
  if (!Array.isArray(points) || !points.length) return null;
  const blocks = [];
  for (const point of points) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const lon = Number(point[0]), lat = Number(point[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    blocks.push({ lon, lat, metersPerLon: 111_320 * Math.cos(lat * Math.PI / 180) });
  }
  if (!blocks.length) return null;

  // A graph edge can span an entire block, or a long stretch of trail. Snapping
  // only to its nearest endpoint can therefore block the wrong road—or none of
  // the road the rider touched. Match against the stored edge geometry instead.
  const closestEdge = new Int32Array(blocks.length);
  closestEdge.fill(-1);
  const closestDistSq = new Float64Array(blocks.length);
  closestDistSq.fill(Infinity);
  const nearby = blocks.map(() => new Set());
  const nearbySq = ROAD_BLOCK_NEARBY_M ** 2;

  for (let edge = 0; edge < E; edge++) {
    const start = eOff[edge];
    const end = start + eCnt[edge] - 1;
    for (let i = start; i < end; i++) {
      const lon0 = gLon[i], lat0 = gLat[i];
      const lon1 = gLon[i + 1], lat1 = gLat[i + 1];
      for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
        const block = blocks[blockIndex];
        const ax = (lon0 - block.lon) * block.metersPerLon;
        const ay = (lat0 - block.lat) * 110_540;
        const bx = (lon1 - block.lon) * block.metersPerLon;
        const by = (lat1 - block.lat) * 110_540;
        const dx = bx - ax, dy = by - ay;
        const spanSq = dx * dx + dy * dy;
        const t = spanSq ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / spanSq)) : 0;
        const px = ax + t * dx, py = ay + t * dy;
        const distSq = px * px + py * py;
        if (distSq < closestDistSq[blockIndex]) {
          closestDistSq[blockIndex] = distSq;
          closestEdge[blockIndex] = edge;
        }
        if (distSq <= nearbySq) nearby[blockIndex].add(edge);
      }
    }
  }

  const blocked = new Set();
  for (let i = 0; i < blocks.length; i++) {
    // Small road offsets often represent the opposite carriageway; include
    // them too. At an intersection this intentionally treats the location as
    // closed, instead of letting the route slip across the marker.
    if (nearby[i].size) for (const edge of nearby[i]) blocked.add(edge);
    else if (closestEdge[i] >= 0) blocked.add(closestEdge[i]);
  }
  return blocked.size ? blocked : null;
}

function withRoadBlocks(points, rules, work) {
  const prior = activeRoadBlockEdges;
  activeRoadBlockEdges = roadBlockEdgeSet(points);
  try {
    return work();
  } finally {
    activeRoadBlockEdges = prior;
  }
}

// Mirrors the app's effectiveLevel() for packed edge attributes.
function edgeNoShoulderMax(i, rules) {
  const legacy = Number(rules.freeMaxSpeed) || 35;
  const urban = Number(rules.urbanMaxSpeedNoShoulder) || legacy;
  const rural = Number(rules.ruralMaxSpeedNoShoulder) || legacy;
  return eOfficial[i] & EDGE_URBAN ? urban : rural;
}

function edgeSpeed(i, forward) {
  return forward ? eSpeed[i] : eSpeedBA[i];
}

function edgeShoulder(i, forward) {
  return forward ? eSh[i] : eShBA[i];
}

function edgeLimited(i, forward) {
  return !!(eLimitedDir[i] & (forward ? 1 : 2));
}

function sidewalkFallbackApplies(i, rules, forward, shoulder = edgeShoulder(i, forward)) {
  return rules.allowSidewalkFallback && !!(eOfficial[i] & EDGE_SIDEWALK)
    && eFacility[i] < 2 && edgeSpeed(i, forward) > edgeNoShoulderMax(i, rules)
    && shoulder >= 0 && shoulder < rules.minShoulder;
}

// Mirrors app.js wideRoadNeedsSpace(). Lanes are counted exactly as tagged,
// turn lanes included, with no oneway adjustment. eLanes is null on a format-9
// graph still cached on a rider's phone, where the rule simply cannot fire.
const WORKER_MAX_LANES_NO_LIMIT = 6;
function wideRoadNeedsSpace(i, rules, shoulder) {
  const limit = Number(rules.maxLanesNoShoulder) || 0;
  if (!eLanes || !limit || limit >= WORKER_MAX_LANES_NO_LIMIT) return false;
  const lanes = eLanes[i] & LANES_COUNT_MASK;
  if (!lanes || lanes < limit) return false;
  // A wide road must PROVE space: a bike lane or better, or a wide enough
  // shoulder. An unknown shoulder is not proof, so it does not exempt.
  return eFacility[i] < 2 && !(shoulder >= rules.minShoulder);
}

function edgeLevel(i, rules, forward) {
  const flags = eFlags[i];
  const shoulder = edgeShoulder(i, forward);
  if (shoulder === PROHIBITED_SHOULDER) return 4;    // WSDOT prohibition
  if (flags & 32) return 2;                         // ferry — no road rules apply
  if (flags & 4) return 4;                         // freeway: last-resort failure
  if ((flags & 8) || eFacility[i] >= 4) return 1;  // protected lane / shared path
  const limitedAccess = edgeLimited(i, forward);    // WSDOT bike-legal caution
  const spd = edgeSpeed(i, forward);
  // The rider-facing “Never allow roads faster than” control is absolute for
  // ordinary roads, including designated routes. Dedicated infrastructure,
  // ferries, freeways, and prohibitions were handled above.
  if (!rules.noUpperLimit && spd > rules.upperMaxSpeed) return 4;
  // Before the slow-road shortcut: Seattle signed every arterial at 25 mph in
  // 2020, so speed alone would pass a five-lane road outright.
  if (wideRoadNeedsSpace(i, rules, shoulder)) return 4;
  if (spd <= edgeNoShoulderMax(i, rules)) return limitedAccess ? 3 : 1;
  // A rider can opt to treat a designated bike route (USBR/regional) as a
  // vetted corridor. Otherwise it is evaluated by the normal shoulder rule.
  if ((flags & 64) && rules.vettedBikeRoutes) return limitedAccess ? 3 : 2;
  // eSh < 0 = unknown; pessimistic mode counts that as a 0 ft shoulder.
  let sh = shoulder;
  if (sh < 0 && rules.unknownShoulderZero) sh = 0;
  // A bike lane or better satisfies the shoulder rule. A shared-lane marking
  // (facility 1) is paint in a travel lane, not space of your own, so it does
  // not -- matching app.js good_facility.
  if (eFacility[i] < 2 && sh >= 0 && sh < rules.minShoulder) {
    // A mapped sidewalk is an opt-in shoulder fallback. It remains a caution
    // and receives a strong route-choice cost below, but is not a rule fail.
    if (sidewalkFallbackApplies(i, rules, forward, sh)) return 3;
    return 4;
  }
  return limitedAccess ? 3 : 2;
}

/* ------------------------------------------------ time model */
// Flat cruising speed (m/s): one steady recreational pace everywhere — a
// dedicated trail allows full transit speed, so it is never modeled slower
// than a road.
const V_ROAD = 5.6;   // ~12.5 mph
const V_MAX = 12.0;   // ~27 mph downhill cap
const V_MIN = 1.3;    // steep-climb floor (~3 mph)
const V_DISMOUNT = 1.15; // ~2.6 mph while walking a bike
const DISMOUNT_ENTRY_PENALTY_S = 4 * 60;
// A* heuristic speed: must not undershoot any effective edge speed, including
// fast ferries and the strongest cost bonuses, or A* loses optimality.
// Worst case: V_MAX 12 / (0.38 path facility x 0.78 residential)
// = 40.5 m/s. Keep ample headroom so the heuristic remains admissible.
const V_HEUR = 160.0;
// Designated bike routes (USBR / regional, edge flag 64) get a modest cost
// bonus. A recorded physical bike facility always gets the stronger bonus;
// designation is useful route context, but is not itself infrastructure.
const DEFAULT_WEIGHTS = Object.freeze({
  directFail: 1.5, balancedComfy: 0.92, balancedFail: 9, lowComfy: 0.9, lowFail: 30,
  designated: 0.94, strongDesignated: 0.86, residential: 0.78,
  facilityShared: 0.82, facilityLane: 0.68, facilityBuffered: 0.58,
  facilitySeparated: 0.46, facilityPath: 0.38,
  mtbTrail: 6,
  freeway: 60, limitedDirect: 1.05, limitedBalanced: 1.35, limitedLow: 1,
  speedBalanced: 0.01, speedLow: 0.02,
  speedBelowDirect: 0.005, speedBelowBalanced: 0.015, speedBelowLow: 0.03,
  hazardDirect1: 1.08, hazardDirect2: 1.16, hazardDirect3: 1.3,
  hazardBalanced1: 1.35, hazardBalanced2: 1.8, hazardBalanced3: 2.6,
  hazardLow1: 1.8, hazardLow2: 3.4, hazardLow3: 6.5,
  arterialTertiaryDirect: 1.02, arterialTertiaryBalanced: 1.12, arterialTertiaryLow: 1.22,
  arterialSecondaryDirect: 1.05, arterialSecondaryBalanced: 1.28, arterialSecondaryLow: 1.48,
  arterialPrimaryDirect: 1.1, arterialPrimaryBalanced: 1.5, arterialPrimaryLow: 1.85,
  wideRoadDirect: 1.03, wideRoadBalanced: 1.14, wideRoadLow: 1.24,
  stressedRoadDirect: 1.04, stressedRoadBalanced: 1.18, stressedRoadLow: 1.30,
  ferryWaitMin: 15, uphillFactor: 7, downhillFactor: 2.5, undulationSecPerM: 3,
  climbDirectSecPerM: 0.25, climbBalancedSecPerM: 0.9, climbLowSecPerM: 1.6,
  turnDirectSec: 6, turnBalancedSec: 11, turnLowSec: 15,
  diversityQuick: 1.3, diversityBalanced: 1.35, diversitySafer: 1.35, diversityWide: 1.6,
});
let activeWeights = { ...DEFAULT_WEIGHTS };
function useWeights(source) {
  activeWeights = { ...DEFAULT_WEIGHTS };
  if (!source || typeof source !== 'object') return;
  const zeroOkay = new Set(['ferryWaitMin', 'speedBalanced', 'speedLow',
    'speedBelowDirect', 'speedBelowBalanced', 'speedBelowLow', 'downhillFactor', 'undulationSecPerM',
    'climbDirectSecPerM', 'climbBalancedSecPerM', 'climbLowSecPerM',
    'turnDirectSec', 'turnBalancedSec', 'turnLowSec']);
  for (const key of Object.keys(DEFAULT_WEIGHTS)) {
    const value = Number(source[key]);
    if (Number.isFinite(value) && value >= (zeroOkay.has(key) ? 0 : 0.1) && value <= 120) activeWeights[key] = value;
  }
}
// Facility multipliers reflect the physical protection recorded on the edge.
// Shared-lane markings get only a small benefit; a separated lane or shared-
// use path can justify a meaningfully longer route. Ferries keep their own
// economics.
// OSM road class is carried directly in BGR8.  This deliberately does not use
// speed as a stand-in: a signed 25 mph arterial (such as NW 80th in Seattle)
// is not a residential street.  The preference is a cost bonus, not a rule;
// it still lets a shorter/safer non-residential connection win when needed.
function facilityPrefMult(level) {
  return [1, activeWeights.facilityShared, activeWeights.facilityLane,
    activeWeights.facilityBuffered, activeWeights.facilitySeparated,
    activeWeights.facilityPath][level] || 1;
}
function isResidential(i) {
  return eClass[i] === 1 || eClass[i] === 2; // residential / living_street
}
function isDismountEdge(i) {
  return !!(eOfficial[i] & EDGE_DISMOUNT);
}
// Freeways are a true last resort: even a short ordinary failure should win
// over a much longer freeway detour.
// WSDOT LimitedAccess is not a bike prohibition. When its own speed/shoulder
// data passes the rider's rules, it remains a caution that is preferable to a
// known rule failure, but less attractive than an ordinary passing road. In
// Low-stress mode its normal high-speed cost is enough: adding a separate
// 3x surcharge can make it lose to a known narrow-shoulder rule failure.
// Average terminal wait folded into a ferry leg, applied once when boarding
// from land (mid-water route junctions don't re-charge it).
function hazardMult(mode, severity) {
  if (!severity) return 1;
  const prefix = mode === 'direct' ? 'hazardDirect' : mode === 'low' ? 'hazardLow' : 'hazardBalanced';
  return activeWeights[prefix + Math.min(3, severity)] || 1;
}

// OSM road class is a useful traffic-volume proxy where measured AADT is not
// available. This is deliberately a finite route-choice cost, not a safety
// failure. Any recorded bike facility removes the no-facility proxy penalty.
function majorRoadMult(i, mode, forward) {
  if (eFacility[i] >= 1 || (eFlags[i] & (8 | 32 | 4)) || edgeLimited(i, forward)) return 1;
  const cls = eClass[i];
  const suffix = mode === 'direct' ? 'Direct' : mode === 'low' ? 'Low' : 'Balanced';
  if (cls === 4 || cls === 5) return activeWeights['arterialTertiary' + suffix];
  if (cls === 6 || cls === 7) return activeWeights['arterialSecondary' + suffix];
  if (cls >= 8 && cls <= 11) return activeWeights['arterialPrimary' + suffix];
  return 1;
}

// Lane count and WSDOT's own stress rating, for the roads where speed has
// stopped discriminating. Seattle signed every arterial at 25 mph in 2020, so
// 15th Ave NE reads the same as the side street beside it: 27 of its 51 ways
// carry four or more lanes, 17 of those at 25 mph, while 21 of its two-lane
// ways are also 25 mph. Lanes still separate them, and OSM tags them on ~100%
// of `secondary` against 3-5% of `residential` — present exactly where it
// matters. A missing tag therefore means "small road", never "unproven", so it
// must leave scoring untouched; on a BGR9 graph these arrays are absent and
// every edge takes that path.
//
// Deliberately a soft cost like the class proxy above, not a rule failure: a
// four-lane road with a protected lane is genuinely fine, and hard gates here
// would risk severing corridors. Any recorded facility exempts the edge.
const LANES_COUNT_MASK = 63;
const LANES_CENTER_TURN = 64;
function trafficStressMult(i, mode, forward) {
  if (!eLanes && !eLts) return 1;
  // Only physical separation earns a full exemption. Paint does not shrink the
  // road: 15th Ave NE carries a bike lane along much of its five-lane length,
  // and exempting anything with a stripe meant the road that prompted this was
  // the one road it could never affect. A bike lane or buffer does help, so it
  // halves the cost rather than clearing it.
  if (eFacility[i] >= 4 || (eFlags[i] & (8 | 32 | 4)) || edgeLimited(i, forward)) return 1;
  const paintRelief = eFacility[i] >= 2 ? 0.5 : 1;
  const suffix = mode === 'direct' ? 'Direct' : mode === 'low' ? 'Low' : 'Balanced';
  const packed = eLanes ? eLanes[i] : 0;
  const lanes = packed & LANES_COUNT_MASK;
  // A centre turn lane is the signature of a wide suburban arterial, so three
  // through lanes plus one counts alongside a plain four.
  const wide = lanes >= 4 || (lanes >= 3 && (packed & LANES_CENTER_TURN));
  const lts = eLts ? eLts[i] : 0;
  // WSDOT rates 4 as high stress and 3 as uncomfortable for most riders. The
  // two signals describe the same road, so take the stronger rather than
  // multiplying them together.
  const stress = lts >= 4 ? 1 : lts === 3 ? 0.5 : 0;
  const wideMult = wide ? 1 + (activeWeights['wideRoad' + suffix] - 1) * paintRelief : 1;
  const stressMult = stress
    ? 1 + (activeWeights['stressedRoad' + suffix] - 1) * stress * paintRelief : 1;
  return Math.max(wideMult, stressMult);
}

// `sidewalk=no` is positive evidence of less forgiving urban road context.
// Missing sidewalk tags remain neutral. This is deliberately a soft cost,
// never a claim about bicycle legality or actual traffic counts.
function sidewalkExposureMult(i, mode, forward) {
  if ((eOfficial[i] & (EDGE_URBAN | EDGE_SIDEWALK_NO)) !== (EDGE_URBAN | EDGE_SIDEWALK_NO)
      || eFacility[i] >= 1 || edgeSpeed(i, forward) < 30 || (eFlags[i] & (8 | 32 | 4))) return 1;
  return mode === 'direct' ? 1.06 : mode === 'low' ? 1.30 : 1.16;
}

function sidewalkFallbackMult(mode) {
  return mode === 'direct' ? 1.9 : mode === 'low' ? 8 : 3.8;
}

function edgeHazard(i, forward) { return forward ? eHazAB[i] : eHazBA[i]; }

// Graded pressure toward slower no-shoulder roads. Every mph over the comfort
// speed makes a road cost more in Balanced/Friendly modes. When the shoulder
// is unknown or zero, every mph below that speed earns a capped bonus in every
// mode. At the default 35 mph setting, an otherwise identical 25 mph road
// without shoulder costs 5% less in Direct, 15% less in Balanced, and 30%
// less in Friendly. Trails and ferries remain speed-neutral.
function speedStress(mode, fl, spd, freeMax, shoulder) {
  if (fl & (8 | 32)) return 1.0;
  const delta = spd - freeMax;
  if (delta > 0) {
    if (mode === 'direct') return 1.0;
    return 1 + (mode === 'low' ? activeWeights.speedLow : activeWeights.speedBalanced) * delta;
  }
  if (delta === 0 || shoulder > 0) return 1.0;
  const belowKey = mode === 'direct'
    ? 'speedBelowDirect'
    : mode === 'low' ? 'speedBelowLow' : 'speedBelowBalanced';
  return Math.max(0.25, 1 - activeWeights[belowKey] * -delta);
}

// Seconds to ride edge i in the given direction (forward = a->b).
function edgeTimeS(i, forward) {
  if (eFlags[i] & 32) {
    // Ferry: sail at the crossing speed baked from the duration tag (mph).
    return eLen[i] / (Math.max(edgeSpeed(i, forward), 3) * 0.44704);
  }
  const len = eLen[i];
  // This is real travel time, not merely a routing penalty.  The separate
  // entry cost below expresses the interruption of getting off and walking.
  if (isDismountEdge(i)) return len / V_DISMOUNT;
  const asc = forward ? eAsc[i] : eDes[i];
  const des = forward ? eDes[i] : eAsc[i];
  const vflat = V_ROAD;
  const g = (asc - des) / Math.max(len, 1); // net grade
  let v;
  if (g > 0) v = Math.max(vflat * Math.exp(-activeWeights.uphillFactor * g), V_MIN);
  else v = Math.min(vflat * (1 - activeWeights.downhillFactor * g), V_MAX);
  let t = len / v;
  // Undulation beyond the net climb still costs energy/time (~3 s per meter
  // of extra up-and-down that the net grade doesn't see).
  const extra = asc - Math.max(asc - des, 0);
  t += extra * activeWeights.undulationSecPerM;
  return t;
}

// Route choice may be more climb-averse than the physical travel-time model.
// Net climbing receives the full mode-specific cost; extra up-and-down within
// an edge receives only half, so rolling terrain is discouraged without being
// treated as harshly as one sustained climb. This affects selection, not ETA.
function climbPreferenceS(i, forward, mode) {
  if (eFlags[i] & 32) return 0;
  const asc = forward ? eAsc[i] : eDes[i];
  const des = forward ? eDes[i] : eAsc[i];
  const netAsc = Math.max(0, asc - des);
  const rollingAsc = Math.max(0, asc - netAsc);
  const key = mode === 'direct' ? 'climbDirectSecPerM'
    : mode === 'low' ? 'climbLowSecPerM' : 'climbBalancedSecPerM';
  const grade = netAsc / Math.max(1, eLen[i]);
  const steepness = 1 + Math.max(0, grade - 0.04) * 8;
  return (netAsc * steepness + rollingAsc * 0.5) * activeWeights[key];
}

// Surface preference is intentionally a soft, distance-proportional route
// cost. Every route gets a modest 20% baseline preference for known pavement;
// the rider-controlled option raises that to ten times the original full cost.
// This makes a reasonable paved detour win very decisively, while unpaved
// links remain available when they are necessary for connectivity.
function surfacePreferenceS(i, rules) {
  if (eFlags[i] & 32) return 0;
  const strength = rules?.preferPaved === true ? 10 : 0.20;
  const surface = eSurface[i];
  if (surface === SURFACE_GRAVEL) return eLen[i] * 0.065 * strength;
  if (surface === SURFACE_ROUGH) return eLen[i] * 0.20 * strength;
  return 0;
}

// Ordinary 9–10% climbs remain available, but a run of them is meaningfully
// tiring. Add a light route-choice cost above 9%, then a much stronger one
// above 12%. The cost is intentionally bounded rather than a prohibition:
// even a 14%+ stretch can be walked, and one short steep segment must not
// erase an otherwise useful route or its alternatives. Because the cost is
// added per edge, repeated steep climbing naturally becomes much less
// attractive without classifying or excluding any OSM bicycle route.
const GRADUAL_UPHILL_AVOID_PCT = 9;
const STEEP_UPHILL_AVOID_PCT = 12;
const MIN_STEEP_AVOID_EDGE_M = 20;
const MAX_STEEP_UPHILL_AVOID_S = 2400;
function steepUphillAvoidanceS(i, forward, mode) {
  if ((eFlags[i] & 32) || eLen[i] < MIN_STEEP_AVOID_EDGE_M) return 0;
  const asc = forward ? eAsc[i] : eDes[i];
  const des = forward ? eDes[i] : eAsc[i];
  const gradePct = 100 * Math.max(0, asc - des) / Math.max(eLen[i], 1);
  if (gradePct <= GRADUAL_UPHILL_AVOID_PCT) return 0;
  // 9–12% has a modest cumulative cost. Above 12%, cost rises sharply so
  // sustained 12–14% climbing outweighs a bike-facility bonus. Friendly
  // routes are most averse; direct routing does not discount this physical
  // limit, but every profile can still use a steep segment where the
  // alternative is a material detour.
  const gradualExcess = Math.min(gradePct, STEEP_UPHILL_AVOID_PCT) - GRADUAL_UPHILL_AVOID_PCT;
  const steepExcess = Math.max(0, gradePct - STEEP_UPHILL_AVOID_PCT);
  const modeFactor = mode === 'low' ? 1.35 : 1;
  const lengthFactor = Math.min(1, eLen[i] / 100);
  return Math.min(MAX_STEEP_UPHILL_AVOID_S,
    lengthFactor * modeFactor * (5 * gradualExcess * gradualExcess + 400 * steepExcess * steepExcess));
}

// Fixed intersection friction discourages routes that zigzag block by block.
// It is deliberately moderate: a safer or substantially quicker corridor can
// still win, but ten unnecessary turns cost roughly 2–5 minutes depending on
// the profile. Straight continuations and ordinary bends on the same named
// road are free, while sharp reversals cost extra.
function turnPreferenceS(incomingEdge, node, outgoingEdge, mode) {
  if (incomingEdge < 0 || incomingEdge === outgoingEdge) return 0;
  const inboundAway = eA[incomingEdge] === node ? eBearingA[incomingEdge] : eBearingB[incomingEdge];
  const outgoing = eA[outgoingEdge] === node ? eBearingA[outgoingEdge] : eBearingB[outgoingEdge];
  const inbound = (inboundAway + 180) % 360;
  const delta = Math.abs((outgoing - inbound + 540) % 360 - 180);
  const incomingName = eName[incomingEdge];
  const sameRoad = incomingName === eName[outgoingEdge]
    && nameOff[incomingName + 1] > nameOff[incomingName];
  if (delta < 30 || (sameRoad && delta < 70)) return 0;
  const key = mode === 'direct' ? 'turnDirectSec'
    : mode === 'low' ? 'turnLowSec' : 'turnBalancedSec';
  const base = activeWeights[key];
  if (delta >= 150) return base * 2;
  if (delta < 55) return base * 0.65;
  return base;
}

// DEM elevations are stored as whole meters, while OSM can split a road into
// graph fragments only a few meters long. Calculating grade on those tiny
// fragments turns ordinary one-meter elevation quantization into impossible
// values (for example, 180%). Report only grades sustained over enough
// horizontal distance to be meaningful, and reject obvious DEM artifacts.
const MIN_REPORTED_GRADE_M = 20;
const MAX_CREDIBLE_GRADE_PCT = 40;
// A single 20 m graph edge can still reflect a small DEM step. Route maxima
// therefore use the steepest sustained 100 m of riding instead.
const SUSTAINED_GRADE_WINDOW_M = 100;

function reportedGradePct(netRiseM, lenM) {
  const rise = Number(netRiseM);
  const len = Number(lenM);
  if (!Number.isFinite(rise) || !Number.isFinite(len) || len < MIN_REPORTED_GRADE_M) return 0;
  const grade = 100 * rise / len;
  if (!Number.isFinite(grade) || Math.abs(grade) > MAX_CREDIBLE_GRADE_PCT) return 0;
  return Math.round(10 * grade) / 10;
}

function credibleSegmentGradePct(seg) {
  const grade = Number(seg?.gradePct);
  const len = Number(seg?.lenM);
  if (!Number.isFinite(grade) || !Number.isFinite(len)
      || len < MIN_REPORTED_GRADE_M || Math.abs(grade) > MAX_CREDIBLE_GRADE_PCT) return 0;
  return grade;
}

function sustainedUphillGradeSamples(segs) {
  const samples = [];
  const window = [];
  let windowM = 0;
  let windowRiseM = 0;
  for (let index = 0; index < (segs || []).length; index++) {
    const seg = segs[index];
    if ((seg.flags || 0) & 32) {
      window.length = 0;
      windowM = 0;
      windowRiseM = 0;
      continue;
    }
    const lenM = Number(seg.lenM) || 0;
    if (!(lenM > 0)) continue;
    const gradePct = credibleSegmentGradePct(seg);
    window.push({ index, lenM, gradePct });
    windowM += lenM;
    windowRiseM += lenM * gradePct / 100;
    while (windowM > SUSTAINED_GRADE_WINDOW_M && window.length) {
      const first = window[0];
      const trimM = Math.min(windowM - SUSTAINED_GRADE_WINDOW_M, first.lenM);
      first.lenM -= trimM;
      windowM -= trimM;
      windowRiseM -= trimM * first.gradePct / 100;
      if (first.lenM <= .001) window.shift();
    }
    if (windowM >= SUSTAINED_GRADE_WINDOW_M && window.length) {
      samples.push({ startIndex: window[0].index, endIndex: index,
        gradePct: 100 * windowRiseM / windowM, lenM: windowM });
    }
  }
  return samples;
}

function routeGradeStats(segs) {
  let uphillM = 0;
  let uphillRiseM = 0;
  for (const seg of segs || []) {
    if ((seg.flags || 0) & 32) continue;
    const grade = credibleSegmentGradePct(seg);
    const len = Number(seg.lenM) || 0;
    if (grade > 0.5 && len > 0) {
      uphillM += len;
      uphillRiseM += len * grade / 100;
    }
  }
  const maxGradePct = sustainedUphillGradeSamples(segs)
    .reduce((max, sample) => Math.max(max, sample.gradePct), 0);
  return {
    avgUphillPct: uphillM > 0 ? Math.round(10 * 100 * uphillRiseM / uphillM) / 10 : 0,
    maxGradePct: Math.round(10 * maxGradePct) / 10,
  };
}

/* ------------------------------------------------ riding modes */
// Multiplier applied to an edge's TIME. Low-stress uses a huge (but finite)
// penalty: it takes any reasonable detour to avoid failing roads, yet still
// returns a route when some failing pavement is truly unavoidable — the app
// highlights those segments instead of refusing to route.
function modeMult(mode, lvl) {
  if (mode === 'direct') return lvl === 4 ? activeWeights.directFail : 1.0;
  if (mode === 'balanced') return lvl === 4 ? activeWeights.balancedFail : lvl === 1 ? activeWeights.balancedComfy : 1.0;
  /* low */ return lvl === 4 ? activeWeights.lowFail : lvl === 1 ? activeWeights.lowComfy : 1.0;
}

function routeLeg(startLL, endLL, rules, mode, prefDesig, prefResidential,
  startSnap, endSnap, diversityEdges = null, diversityFactor = 1, searchRules = rules,
  blockedCrossingEdges = null, crossingRetry = 0) {
  const t0 = Date.now();
  const s = startSnap || nearestNode(startLL[0], startLL[1], rules);
  const t = endSnap || nearestNode(endLL[0], endLL[1], rules);
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

  if (s.node === t.node) {
    return {
      ok: true,
      empty: true,
      coords: [[nodeLon[s.node], nodeLat[s.node]]],
      distM: 0, timeS: 0, ascentM: 0, descentM: 0, failM: 0, ferryM: 0,
      ferrySegs: [], desigM: 0, residentialM: 0, freewayM: 0,
      limitedAccessM: 0, facilityM: 0, mtbM: 0, dismountM: 0, hazardM: 0,
      levelM: [0, 0, 0, 0, 0], edgeIds: [],
      nodeIds: [s.node],
      segs: [], profile: [[0, nodeEle[s.node]]],
      snapStartM: s.distM, snapEndM: t.distM, ms: Date.now() - t0,
    };
  }

  const goalLon = nodeLon[t.node], goalLat = nodeLat[t.node];
  const startLon = nodeLon[s.node], startLat = nodeLat[s.node];
  const nearTerminal = (n) =>
    havM(nodeLon[n], nodeLat[n], startLon, startLat) <= ACCESS_RADIUS_M
    || havM(nodeLon[n], nodeLat[n], goalLon, goalLat) <= ACCESS_RADIUS_M;
  const terminalAccessEdge = (ei) =>
    eLen[ei] <= ACCESS_EDGE_MAX_M && (nearTerminal(eA[ei]) || nearTerminal(eB[ei]));
  // Turn costs depend on how the rider arrived at an intersection, so search
  // directed-edge states rather than collapsing every arrival into one node.
  // This preserves optimal A* behavior while allowing a simpler route to beat
  // a marginally faster residential zigzag.
  searchGeneration++;
  if (searchGeneration >= 0x7fffffff) {
    searchStamp.fill(0);
    searchGeneration = 1;
  }
  const generation = searchGeneration;
  const heap = makeHeap(4096);
  const h = (n) => havM(nodeLon[n], nodeLat[n], goalLon, goalLat) / V_HEUR;
  const START_ARC = -1;
  heap.push(h(s.node), START_ARC);

  let foundArc = -1;
  while (heap.size) {
    const incomingArc = heap.pop();
    if (incomingArc !== START_ARC && searchStamp[incomingArc] === -generation) continue;
    if (incomingArc !== START_ARC) searchStamp[incomingArc] = -generation;
    const u = incomingArc === START_ARC ? s.node : outTarget[incomingArc];
    if (u === t.node) { foundArc = incomingArc; break; }
    const du = incomingArc === START_ARC ? 0 : searchDist[incomingArc];
    const incomingEdge = incomingArc === START_ARC ? -1 : outEdge[incomingArc];
    for (let a = outStart[u]; a < outStart[u + 1]; a++) {
      const v = outTarget[a];
      if (searchStamp[a] === -generation) continue;
      const ei = outEdge[a];
      if (activeRoadBlockEdges?.has(ei)) continue;
      // An immediate reversal can never improve a positive-cost route and
      // dramatically enlarges an edge-state search at dead ends.
      if (ei === incomingEdge) continue;
      const fl = eFlags[ei];
      const forward = eA[ei] === u;
      // Permanent WSDOT bike restriction: never traverse it, in any mode or
      // with any setting. This is intentionally before all cost/rules logic.
      if (edgeShoulder(ei, forward) === PROHIBITED_SHOULDER) continue;
      // Technical mountain-bike paths are opt-in. Unlike a bicycle=no road,
      // they remain available to an informed rider, but never appear in an
      // ordinary road-bike route.
      if (!rules.allowMtbTrails && (eOfficial[ei] & EDGE_MTB)) continue;
      // This setting controls whether a true freeway can be used at all. When it
      // can, its level and cost still make it a route failure and last resort.
      if (!rules.allowFreeways && (fl & 4)) continue;
      const actualLevel = edgeLevel(ei, rules, forward);
      // "Only show routes fully matching safety rules": failing roads become
      // impassable in EVERY mode, so profiles choose only among matching
      // paths — except the short access blocks at a leg's own endpoints,
      // which stay usable (and still report/pulse as failing).
      const provisionalCrossing = eLen[ei] <= CROSSING_MAX_M && !(fl & 4)
        && !blockedCrossingEdges?.has(ei);
      if (rules.requireSafe && actualLevel === 4 && !terminalAccessEdge(ei)
          && !provisionalCrossing) continue;
      const requiredSafeAccess = rules.requireSafe && actualLevel === 4;
      // Discovery lenses may price an otherwise-allowed edge more
      // conservatively, but they never change legality or reported safety.
      const searchLevel = edgeLevel(ei, searchRules, forward);
      const mult = modeMult(mode, searchLevel);
      if (mult === Infinity) continue;
      let step = edgeTimeS(ei, forward) + climbPreferenceS(ei, forward, mode);
      if ((fl & 32) && nodeHasLand[u]) step += activeWeights.ferryWaitMin * 60; // boarding
      let cost = step * mult;
      // An exempted terminal-access block is a last resort, never a shortcut:
      // any reasonable fully-safe approach must still win.
      if (requiredSafeAccess) cost *= 30;
      cost *= speedStress(mode, fl, edgeSpeed(ei, forward),
        edgeNoShoulderMax(ei, searchRules), edgeShoulder(ei, forward));
      cost *= hazardMult(mode, edgeHazard(ei, forward) || 0);
      cost *= majorRoadMult(ei, mode, forward);
      cost *= trafficStressMult(ei, mode, forward);
      cost *= sidewalkExposureMult(ei, mode, forward);
      if (sidewalkFallbackApplies(ei, searchRules, forward)) cost *= sidewalkFallbackMult(mode);
      if (fl & 4) cost *= activeWeights.freeway;
      if (edgeLimited(ei, forward)) {
        cost *= activeWeights[mode === 'direct'
          ? 'limitedDirect' : mode === 'low' ? 'limitedLow' : 'limitedBalanced'];
      }
      if (eOfficial[ei] & EDGE_MTB) cost *= activeWeights.mtbTrail;
      // Bonuses never apply to ferries, freeways, or WSDOT limited-access
      // highways: preference must not erase their access/caution costs. For
      // an ordinary road, a physical facility beats designation alone; when
      // both are present, use whichever benefit is stronger rather than
      // stacking them into an outsized corridor bonus.
      if (!(fl & (32 | 4)) && !edgeLimited(ei, forward) && !isDismountEdge(ei)) {
        const facilityBonus = eFacility[ei] ? facilityPrefMult(eFacility[ei]) : 1;
        if (prefDesig) {
          const designationBonus = (fl & 64) ? activeWeights.strongDesignated : 1;
          cost *= Math.min(facilityBonus, designationBonus);
        } else if (mode !== 'direct') {
          const designationBonus = (fl & 64) ? activeWeights.designated : 1;
          cost *= Math.min(facilityBonus, designationBonus);
        }
      }
      if (prefResidential && !(fl & (8 | 32 | 4))
          && !edgeLimited(ei, forward) && isResidential(ei)) {
        cost *= activeWeights.residential;
      }
      // Alternative-corridor probes softly penalize ordinary road edges from
      // one already-found path. Protected lanes and shared paths may remain a
      // common trunk: leaving excellent infrastructure merely to be different
      // creates fussy neighborhood detours instead of a useful alternative.
      const protectedInfrastructure = (fl & 8) || eFacility[ei] >= 4;
      if (diversityEdges?.has(ei) && !protectedInfrastructure && !(fl & 32)) {
        cost *= diversityFactor;
      }
      // Grade is an independent rideability concern. Apply it after every
      // safety, facility, residential, and alternate-corridor multiplier so
      // a path bonus cannot shrink the penalty for a genuinely steep climb.
      cost += steepUphillAvoidanceS(ei, forward, mode);
      // Similarly, a designated trail remains eligible but should not erase
      // the rider's explicit preference for pavement.
      cost += surfacePreferenceS(ei, rules);
      // Dismount access remains available to repair a genuinely connected
      // cycling corridor, but entering it has a fixed interruption cost in
      // addition to the walking time returned by edgeTimeS().  Because the
      // search state includes the incoming edge, a continuous dismount run is
      // charged once rather than once for every split graph edge.
      if (isDismountEdge(ei) && (incomingEdge < 0 || !isDismountEdge(incomingEdge))) {
        cost += DISMOUNT_ENTRY_PENALTY_S;
      }
      // Turn friction is independent of the road entered: a bike facility or
      // residential bonus should not make repeated intersection turns free.
      cost += turnPreferenceS(incomingEdge, u, ei, mode);
      const nd = du + cost;
      if (Math.abs(searchStamp[a]) !== generation || nd < searchDist[a]) {
        searchStamp[a] = generation;
        searchDist[a] = nd;
        searchPrevArc[a] = incomingArc;
        heap.push(nd + h(v), a);
      }
    }
  }
  if (foundArc < 0) {
    return {
      ok: false,
      reason: rules.requireSafe
        ? 'No route fully matching your safety rules exists — relax a rule, or turn off “Only show routes fully matching safety rules”.'
        : 'No route exists on the rideable network between these points.',
    };
  }

  // Reconstruct (goal -> start), then emit forward.
  const arcs = [];
  for (let a = foundArc; a !== START_ARC; a = searchPrevArc[a]) arcs.push(a);
  arcs.reverse();
  const edges = [];
  for (const a of arcs) {
    const ei = outEdge[a], toNode = outTarget[a];
    edges.push([ei, eA[ei] === toNode ? eB[ei] : eA[ei]]);
  }

  const coords = [];
  const profile = []; // [cumulative meters, elevation m] per node along the route
  const ferryRanges = []; // coord index ranges covered by ferry legs
  const segs = [];        // per-edge attrs for the tap-to-inspect route readout
  const edgeIds = [];
  const nodeIds = edges.length ? [edges[0][1]] : [s.node];
  const levelM = [0, 0, 0, 0, 0];
  let distM = 0, timeS = 0, ascentM = 0, descentM = 0, failM = 0, ferryM = 0;
  let hazardM = 0;
  let desigM = 0, residentialM = 0, freewayM = 0, limitedAccessM = 0, facilityM = 0, mtbM = 0, dismountM = 0;
  for (const [ei, fromNode] of edges) {
    edgeIds.push(ei);
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
    let segTimeS = edgeTimeS(ei, forward);
    if (eFlags[ei] & 32) {
      if (nodeHasLand[fromNode]) segTimeS += activeWeights.ferryWaitMin * 60;
      ferryM += eLen[ei];
      const last = ferryRanges[ferryRanges.length - 1];
      if (last && last[1] === c0) last[1] = coords.length - 1;
      else ferryRanges.push([c0, coords.length - 1]);
    }
    timeS += segTimeS;
    ascentM += forward ? eAsc[ei] : eDes[ei];
    descentM += forward ? eDes[ei] : eAsc[ei];
    if (eFlags[ei] & 64) desigM += eLen[ei];
    if (eFacility[ei] >= 1) facilityM += eLen[ei];
    if (eOfficial[ei] & EDGE_MTB) mtbM += eLen[ei];
    if (isDismountEdge(ei)) dismountM += eLen[ei];
    if (!(eFlags[ei] & (8 | 32 | 4)) && !edgeLimited(ei, forward)
        && isResidential(ei)) residentialM += eLen[ei];
    if (eFlags[ei] & 4) freewayM += eLen[ei];
    else if (edgeLimited(ei, forward)) limitedAccessM += eLen[ei];
    const level = edgeLevel(ei, rules, forward);
    levelM[level] += eLen[ei];
    if (level === 4) failM += eLen[ei];
    const hazard = edgeHazard(ei, forward);
    let hazC0 = null, hazC1 = null;
    if (hazard) {
      if (forward) {
        hazC0 = c0 + eHazStartAB[ei]; hazC1 = c0 + eHazEndAB[ei];
      } else {
        hazC0 = c0 + (cnt - 1 - eHazEndBA[ei]);
        hazC1 = c0 + (cnt - 1 - eHazStartBA[ei]);
      }
    }
    let hazardLenM = 0;
    if (hazard && hazC0 != null && hazC1 != null) {
      for (let j = hazC0 + 1; j <= hazC1; j++) {
        hazardLenM += havM(coords[j - 1][0], coords[j - 1][1], coords[j][0], coords[j][1]);
      }
      hazardM += hazardLenM;
    }
    segs.push({ c0, c1: coords.length - 1, name: edgeName(ei),
      mph: edgeSpeed(ei, forward), sh: edgeShoulder(ei, forward),
      flags: eFlags[ei] | (edgeLimited(ei, forward) ? 128 : 0), roadClass: eClass[ei],
      facility: eFacility[ei], official: eOfficial[ei], mtb: !!(eOfficial[ei] & EDGE_MTB),
      dismount: isDismountEdge(ei), level,
      surface: eSurface[ei], surfaceLabel: SURFACE_LABEL[eSurface[ei]] || SURFACE_LABEL[SURFACE_UNKNOWN],
      lanes: eLanes ? eLanes[ei] & LANES_COUNT_MASK : 0,
      centerTurnLane: !!(eLanes && (eLanes[ei] & LANES_CENTER_TURN)),
      lts: eLts ? eLts[ei] : 0,
      hazard, hazardLenM: Math.round(hazardLenM), hazC0, hazC1,
      gradePct: reportedGradePct((forward ? eAsc[ei] : eDes[ei])
        - (forward ? eDes[ei] : eAsc[ei]), eLen[ei]),
      lenM: Math.round(eLen[ei]), timeS: Math.round(segTimeS) });
    const toNode = forward ? eB[ei] : eA[ei];
    nodeIds.push(toNode);
    profile.push([distM, nodeEle[toNode]]);
  }
  // Reclassify a complete short failing RUN as one crossing. OSM may split a
  // crosswalk or intersection into several graph edges, so requiring one
  // isolated edge incorrectly flags legitimate crossings. The complete run
  // must still be short and bounded on both sides by passing route segments;
  // otherwise it represents riding along the failing road, not crossing it.
  const rejectedCrossingEdges = [];
  for (let i = 0; i < segs.length;) {
    if (segs[i].level !== 4 || (segs[i].flags & 4)) { i++; continue; }
    let end = i;
    let runM = 0;
    while (end < segs.length && segs[end].level === 4 && !(segs[end].flags & 4)) {
      runM += eLen[edgeIds[end]];
      end++;
    }
    const boundedByPassing = i > 0 && end < segs.length
      && segs[i - 1].level !== 4 && segs[end].level !== 4;
    if (boundedByPassing && runM <= CROSSING_MAX_M) {
      for (let j = i; j < end; j++) {
        segs[j].level = 2;
        segs[j].crossing = 1;
      }
      levelM[4] -= runM;
      levelM[2] += runM;
      failM -= runM;
    } else if (rules.requireSafe) {
      // Only provisionally-admitted edges need blocking. Endpoint-access
      // exceptions remain available and continue to be reported as failures.
      const provisional = [];
      for (let j = i; j < end; j++) {
        const ei = edgeIds[j];
        if (!terminalAccessEdge(ei) && eLen[ei] <= CROSSING_MAX_M) {
          provisional.push(ei);
        }
      }
      // Blocking one fragment is enough to invalidate this exact bad run and
      // still lets a retry use another fragment as a legitimate crossing from
      // a different approach. Prefer the longest, least crossing-like piece.
      if (provisional.length) rejectedCrossingEdges.push(provisional.reduce((longest, ei) =>
        eLen[ei] > eLen[longest] ? ei : longest));
    }
    i = end;
  }
  failM = Math.max(0, failM);
  if (rules.requireSafe && rejectedCrossingEdges.length) {
    if (crossingRetry >= CROSSING_RETRY_LIMIT) {
      return {
        ok: false,
        reason: 'No route fully matching your safety rules exists — relax a rule, or turn off “Only show routes fully matching safety rules”.',
      };
    }
    const blocked = new Set(blockedCrossingEdges || []);
    for (const ei of rejectedCrossingEdges) blocked.add(ei);
    return routeLeg(startLL, endLL, rules, mode, prefDesig, prefResidential,
      s, t, diversityEdges, diversityFactor, searchRules, blocked, crossingRetry + 1);
  }
  const ferrySegs = ferryRanges.map(([a, b]) => coords.slice(a, b + 1));
  const gradeStats = routeGradeStats(segs);
  return {
    ok: true, coords, distM, timeS, ascentM, descentM, failM, ferryM, ferrySegs,
    desigM, residentialM, freewayM, limitedAccessM, facilityM, mtbM, dismountM, hazardM,
    levelM, edgeIds, nodeIds, segs, ...gradeStats,
    profile, snapStartM: s.distM, snapEndM: t.distM, ms: Date.now() - t0,
  };
}

// Route through an ordered list of points (A -> B -> C ...): one A* per leg,
// results merged into a single continuous route.
function route(points, rules, mode, prefDesig, prefResidential, snaps,
  diversityEdges = null, diversityFactor = 1, searchRules = rules) {
  const t0 = Date.now();
  const legs = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const leg = routeLeg(points[i], points[i + 1], rules, mode, prefDesig, prefResidential,
      snaps?.[i], snaps?.[i + 1], diversityEdges, diversityFactor, searchRules);
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
  if (legs.every((leg) => leg.empty)) {
    return {
      ok: false,
      code: 'same-point',
      reason: 'Start and destination snap to the same road point. Move one of them farther away.',
    };
  }
  const coords = [], segs = [], ferrySegs = [], profile = [];
  const legSummaries = legs.map((l) => ({
    distM: l.distM, timeS: l.timeS, failM: l.failM,
    desigM: l.desigM, facilityM: l.facilityM, mtbM: l.mtbM || 0,
    dismountM: l.dismountM || 0, residentialM: l.residentialM,
    freewayM: l.freewayM, limitedAccessM: l.limitedAccessM, hazardM: l.hazardM || 0,
    avgUphillPct: l.avgUphillPct || 0, maxGradePct: l.maxGradePct || 0,
  }));
  const edgeIds = [], nodeIds = [];
  const levelM = [0, 0, 0, 0, 0];
  let distM = 0, timeS = 0, ascentM = 0, descentM = 0, failM = 0, ferryM = 0;
  let hazardM = 0;
  let desigM = 0, residentialM = 0, freewayM = 0, limitedAccessM = 0, facilityM = 0, mtbM = 0, dismountM = 0;
  for (const leg of legs) {
    const cOff = coords.length ? coords.length - 1 : 0; // joint vertex is shared
    for (let j = coords.length ? 1 : 0; j < leg.coords.length; j++) coords.push(leg.coords[j]);
    for (const g of leg.segs) segs.push({
      ...g, c0: g.c0 + cOff, c1: g.c1 + cOff,
      hazC0: g.hazC0 == null ? null : g.hazC0 + cOff,
      hazC1: g.hazC1 == null ? null : g.hazC1 + cOff,
    });
    for (const f of leg.ferrySegs) ferrySegs.push(f);
    for (let j = profile.length ? 1 : 0; j < leg.profile.length; j++)
      profile.push([leg.profile[j][0] + distM, leg.profile[j][1]]);
    distM += leg.distM; timeS += leg.timeS; ascentM += leg.ascentM; descentM += leg.descentM;
    failM += leg.failM; ferryM += leg.ferryM; desigM += leg.desigM;
    residentialM += leg.residentialM; freewayM += leg.freewayM;
    limitedAccessM += leg.limitedAccessM; facilityM += leg.facilityM; mtbM += leg.mtbM || 0;
    dismountM += leg.dismountM || 0;
    hazardM += leg.hazardM || 0; edgeIds.push(...leg.edgeIds);
    for (let j = nodeIds.length ? 1 : 0; j < leg.nodeIds.length; j++) nodeIds.push(leg.nodeIds[j]);
    for (let level = 1; level <= 4; level++) levelM[level] += leg.levelM[level];
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
  const gradeStats = routeGradeStats(segs);
  return {
    ok: true, coords, distM, timeS, ascentM, descentM, failM, ferryM, ferrySegs,
    desigM, residentialM, freewayM, limitedAccessM, facilityM, mtbM, dismountM, hazardM,
    levelM, edgeIds, nodeIds, segs, ...gradeStats,
    legs: legSummaries,
    profile: prof, snapStartM: legs[0].snapStartM, snapEndM: legs[legs.length - 1].snapEndM,
    ms: Date.now() - t0,
  };
}

// Slice an already-routed edge path without rerunning A*. This is used to
// preserve structural connectors (especially ferries) while independently
// exploring the land sections on either side.
function routeFragment(source, startEdge, endEdge, rules) {
  if (endEdge <= startEdge) return null;
  const sourceSegs = source.segs.slice(startEdge, endEdge);
  const sourceEdgeIds = source.edgeIds.slice(startEdge, endEdge);
  const nodeIds = source.nodeIds.slice(startEdge, endEdge + 1);
  const coordStart = sourceSegs[0].c0;
  const coordEnd = sourceSegs[sourceSegs.length - 1].c1;
  const coords = source.coords.slice(coordStart, coordEnd + 1);
  const segs = sourceSegs.map((seg, index) => ({
    ...seg,
    c0: seg.c0 - coordStart,
    c1: seg.c1 - coordStart,
    hazC0: seg.hazC0 == null ? null : seg.hazC0 - coordStart,
    hazC1: seg.hazC1 == null ? null : seg.hazC1 - coordStart,
    level: edgeLevel(sourceEdgeIds[index], rules,
      eA[sourceEdgeIds[index]] === nodeIds[index]),
  }));
  const ferryRanges = [];
  const profile = [[0, nodeEle[nodeIds[0]]]];
  const levelM = [0, 0, 0, 0, 0];
  let distM = 0, timeS = 0, ascentM = 0, descentM = 0, failM = 0, ferryM = 0;
  let hazardM = 0;
  let desigM = 0, residentialM = 0, freewayM = 0, limitedAccessM = 0, facilityM = 0, mtbM = 0, dismountM = 0;
  for (let index = 0; index < sourceEdgeIds.length; index++) {
    const ei = sourceEdgeIds[index], fromNode = nodeIds[index];
    const forward = eA[ei] === fromNode;
    const seg = segs[index];
    distM += eLen[ei];
    let segTimeS = edgeTimeS(ei, forward);
    if (eFlags[ei] & 32) {
      if (nodeHasLand[fromNode]) segTimeS += activeWeights.ferryWaitMin * 60;
      ferryM += eLen[ei];
      const last = ferryRanges[ferryRanges.length - 1];
      if (last && last[1] === seg.c0) last[1] = seg.c1;
      else ferryRanges.push([seg.c0, seg.c1]);
    }
    timeS += segTimeS;
    seg.timeS = Math.round(segTimeS);
    ascentM += forward ? eAsc[ei] : eDes[ei];
    descentM += forward ? eDes[ei] : eAsc[ei];
    if (eFlags[ei] & 64) desigM += eLen[ei];
    if (eFacility[ei] >= 1) facilityM += eLen[ei];
    if (eOfficial[ei] & EDGE_MTB) mtbM += eLen[ei];
    if (isDismountEdge(ei)) dismountM += eLen[ei];
    if (!(eFlags[ei] & (8 | 32 | 4)) && !edgeLimited(ei, forward)
        && isResidential(ei)) residentialM += eLen[ei];
    if (eFlags[ei] & 4) freewayM += eLen[ei];
    else if (edgeLimited(ei, forward)) limitedAccessM += eLen[ei];
    const level = edgeLevel(ei, rules, forward);
    levelM[level] += eLen[ei];
    if (level === 4) failM += eLen[ei];
    hazardM += Number(seg.hazardLenM) || 0;
    profile.push([distM, nodeEle[nodeIds[index + 1]]]);
  }
  const gradeStats = routeGradeStats(segs);
  return {
    ok: true, coords, distM, timeS, ascentM, descentM, failM, ferryM,
    ferrySegs: ferryRanges.map(([a, b]) => coords.slice(a, b + 1)),
    desigM, residentialM, freewayM, limitedAccessM, facilityM, mtbM, dismountM, hazardM,
    levelM, edgeIds: sourceEdgeIds, nodeIds, segs, profile, ...gradeStats,
    snapStartM: 0, snapEndM: 0, ms: 0,
  };
}

function routeSummary(routeResult) {
  return {
    distM: routeResult.distM, timeS: routeResult.timeS, failM: routeResult.failM,
    desigM: routeResult.desigM, facilityM: routeResult.facilityM,
    mtbM: routeResult.mtbM || 0, dismountM: routeResult.dismountM || 0,
    residentialM: routeResult.residentialM,
    freewayM: routeResult.freewayM, limitedAccessM: routeResult.limitedAccessM,
    hazardM: routeResult.hazardM || 0,
    avgUphillPct: routeResult.avgUphillPct || 0,
    maxGradePct: routeResult.maxGradePct || 0,
  };
}

// Merge path fragments into one user-facing leg. Unlike route(), these
// boundaries are automatic discovery anchors, not user-supplied waypoints.
function mergeRouteParts(parts, snapStartM, snapEndM) {
  const started = Date.now();
  const coords = [], segs = [], ferrySegs = [], profile = [];
  const edgeIds = [], nodeIds = [];
  const levelM = [0, 0, 0, 0, 0];
  let distM = 0, timeS = 0, ascentM = 0, descentM = 0, failM = 0, ferryM = 0;
  let hazardM = 0;
  let desigM = 0, residentialM = 0, freewayM = 0, limitedAccessM = 0, facilityM = 0, mtbM = 0, dismountM = 0;
  for (const part of parts) {
    const cOff = coords.length ? coords.length - 1 : 0;
    for (let j = coords.length ? 1 : 0; j < part.coords.length; j++) coords.push(part.coords[j]);
    for (const seg of part.segs) segs.push({
      ...seg, c0: seg.c0 + cOff, c1: seg.c1 + cOff,
      hazC0: seg.hazC0 == null ? null : seg.hazC0 + cOff,
      hazC1: seg.hazC1 == null ? null : seg.hazC1 + cOff,
    });
    ferrySegs.push(...part.ferrySegs);
    for (let j = profile.length ? 1 : 0; j < part.profile.length; j++) {
      profile.push([part.profile[j][0] + distM, part.profile[j][1]]);
    }
    distM += part.distM; timeS += part.timeS; ascentM += part.ascentM; descentM += part.descentM;
    failM += part.failM; ferryM += part.ferryM; desigM += part.desigM;
    residentialM += part.residentialM; freewayM += part.freewayM;
    limitedAccessM += part.limitedAccessM; facilityM += part.facilityM; mtbM += part.mtbM || 0;
    dismountM += part.dismountM || 0;
    hazardM += part.hazardM || 0; edgeIds.push(...part.edgeIds);
    for (let j = nodeIds.length ? 1 : 0; j < part.nodeIds.length; j++) nodeIds.push(part.nodeIds[j]);
    for (let level = 1; level <= 4; level++) levelM[level] += part.levelM[level];
  }
  let prof = profile;
  if (prof.length > 240) {
    const stepN = prof.length / 240, downsampled = [];
    for (let i = 0; i < prof.length; i += stepN) downsampled.push(prof[Math.floor(i)]);
    downsampled.push(prof[prof.length - 1]);
    prof = downsampled;
  }
  const gradeStats = routeGradeStats(segs);
  const merged = {
    ok: true, coords, distM, timeS, ascentM, descentM, failM, ferryM, ferrySegs,
    desigM, residentialM, freewayM, limitedAccessM, facilityM, mtbM, dismountM, hazardM,
    levelM, edgeIds, nodeIds, segs, profile: prof, snapStartM, snapEndM, ...gradeStats,
    ms: Date.now() - started,
  };
  merged.legs = [routeSummary(merged)];
  return merged;
}

/* ------------------------------------------ diverse route choices */
// These are internal search profiles, not fixed user-facing modes. The
// preference combinations deliberately probe whether a bike-route or
// residential bias finds a genuinely better corridor. Global preference
// switches force the corresponding bias on for every profile.
const ROUTE_PROFILES = [
  { id: 'quick', label: 'Direct', mode: 'direct', prefDesig: false, prefResidential: false, order: 0 },
  { id: 'quick-bike', label: 'Direct + bike', mode: 'direct', prefDesig: true, prefResidential: false, order: 0.1 },
  { id: 'quick-residential', label: 'Direct + residential', mode: 'direct', prefDesig: false, prefResidential: true, order: 0.2 },
  { id: 'quick-friendly', label: 'Direct + both', mode: 'direct', prefDesig: true, prefResidential: true, order: 0.3 },
  { id: 'efficient', label: 'Balanced', mode: 'balanced', prefDesig: false, prefResidential: false, order: 1 },
  { id: 'bike', label: 'Balanced + bike', mode: 'balanced', prefDesig: true, prefResidential: false, order: 1.1 },
  { id: 'residential', label: 'Balanced + residential', mode: 'balanced', prefDesig: false, prefResidential: true, order: 1.2 },
  { id: 'bike-residential', label: 'Balanced + both', mode: 'balanced', prefDesig: true, prefResidential: true, order: 1.3 },
  { id: 'gentle', label: 'Low stress', mode: 'low', prefDesig: false, prefResidential: false, order: 2 },
  { id: 'gentle-bike', label: 'Low stress + bike', mode: 'low', prefDesig: true, prefResidential: false, order: 2.1 },
  { id: 'gentle-residential', label: 'Low stress + residential', mode: 'low', prefDesig: false, prefResidential: true, order: 2.2 },
  { id: 'friendly', label: 'Low stress + both', mode: 'low', prefDesig: true, prefResidential: true, order: 2.3 },
];

function candidateProfiles(forceDesig, forceResidential) {
  const seen = new Set();
  const profiles = [];
  for (const base of ROUTE_PROFILES) {
    const profile = {
      ...base,
      prefDesig: forceDesig || base.prefDesig,
      prefResidential: forceResidential || base.prefResidential,
    };
    const key = `${profile.mode}:${profile.prefDesig}:${profile.prefResidential}`;
    if (seen.has(key)) continue;
    seen.add(key);
    profiles.push(profile);
  }
  return profiles;
}

function edgeOverlap(a, b) {
  const aSet = new Set(a.edgeIds);
  const bSet = new Set(b.edgeIds);
  let sharedM = 0;
  for (const edge of aSet) if (bSet.has(edge)) sharedM += eLen[edge];
  return sharedM / Math.max(1, Math.min(a.distM, b.distM));
}

function materialTradeoff(a, b) {
  const routeScale = Math.max(250, Math.min(a.distM, b.distM) * 0.08);
  // A short failing stretch can be the most important difference on a long
  // ride. Do not scale this threshold with total route length: doing so once
  // hid hundreds of feet of avoided rule failures as an "equivalent" route.
  return Math.abs(a.failM - b.failM) >= 60
    || Math.abs(a.freewayM - b.freewayM) >= 60
    || Math.abs(a.limitedAccessM - b.limitedAccessM) >= Math.max(120, routeScale * 0.5)
    || Math.abs((a.mtbM || 0) - (b.mtbM || 0)) >= 40
    || (!!a.dismountM !== !!b.dismountM)
    || Math.abs(a.facilityM - b.facilityM) >= routeScale
    || Math.abs((a.hazardM || 0) - (b.hazardM || 0)) >= 50
    || Math.abs(a.desigM - b.desigM) >= routeScale
    || Math.abs(a.residentialM - b.residentialM) >= routeScale;
}

function meaningfullyDifferent(a, b) {
  const overlap = edgeOverlap(a, b);
  // Retain a corridor once at least ~4% of the shorter route changes. That is
  // enough to represent a real neighborhood/road choice on ordinary trips,
  // while still collapsing paths that differ by only a block-end connector.
  // Very-close paths survive only when their safety/facility outcome changes.
  return overlap < 0.96 || (overlap < 0.99 && materialTradeoff(a, b));
}

function routeAggression(r) {
  const ridingM = Math.max(1, r.distM - r.ferryM);
  const levels = r.levelM || [0, 0, 0, 0, 0];
  const stress = (levels[2] * 0.18 + levels[3] * 0.75 + levels[4] * 3.5
    + r.freewayM * 4 + r.limitedAccessM * 0.8 + (r.hazardM || 0) * 1.1
    + (r.mtbM || 0) * 1.25 + (r.dismountM ? 450 + r.dismountM * 1.5 : 0)) / ridingM;
  const friendlyCoverage = (r.desigM * 0.12 + r.facilityM * 0.1 + r.residentialM * 0.08) / ridingM;
  return stress - friendlyCoverage;
}

function compareSafety(a, b) {
  // A known rule failure is the first-order distinction. The remaining
  // metrics break ties between routes with the same failing distance.
  if (a.failM !== b.failM) return a.failM - b.failM;
  if (a.freewayM !== b.freewayM) return a.freewayM - b.freewayM;
  if ((a.mtbM || 0) !== (b.mtbM || 0)) return (a.mtbM || 0) - (b.mtbM || 0);
  if ((a.hazardM || 0) !== (b.hazardM || 0)) return (a.hazardM || 0) - (b.hazardM || 0);
  if (a.limitedAccessM !== b.limitedAccessM) return a.limitedAccessM - b.limitedAccessM;
  return a.aggression - b.aggression || a.timeS - b.timeS;
}

function outcomeDistance(meters) {
  if (meters <= 0) return 'no distance';
  if (meters < 160.934) return `${Math.max(10, Math.round(meters * 3.28084 / 10) * 10)} ft`;
  return `${(meters / 1609.344).toFixed(1)} mi`;
}

function outcomeSnapshot(route) {
  const ridingM = Math.max(1, route.distM - route.ferryM);
  // Ferries are level 2 for routing purposes, but percentages describe only
  // the riding distance. Remove them before calculating the tooltip summary.
  const passingRideM = Math.max(0,
    (route.levelM?.[1] || 0) + (route.levelM?.[2] || 0) - route.ferryM);
  let passPct = `${Math.round(100 * Math.min(ridingM, passingRideM) / ridingM)}`;
  // Never let rounding claim a clean 100% when some distance fails.
  if (route.failM > 0 && passPct === '100') passPct = '99.9';
  const cautionPct = Math.round(100 * (route.levelM?.[3] || 0) / ridingM);
  const bikeNetworkM = (route.segs || []).reduce((sum, seg) => {
    const flags = seg.flags || 0;
    return sum + (!(flags & 32) && ((flags & 8) || (seg.facility || 0) >= 1)
      ? Number(seg.lenM) || 0 : 0);
  }, 0);
  const bikePct = Math.round(100 * Math.min(ridingM, bikeNetworkM) / ridingM);
  const details = [];
  if (route.failM > 0) details.push(`${outcomeDistance(route.failM)} fails rules`);
  if (bikePct > 0) details.push(`${bikePct}% trails/lanes`);
  if (Number(passPct) > 0) details.push(`${passPct}% passes`);
  if (cautionPct > 0) details.push(`${cautionPct}% caution`);
  if (route.limitedAccessM > 0) details.push(`${outcomeDistance(route.limitedAccessM)} limited-access caution`);
  if (route.mtbM > 0) details.push(`${outcomeDistance(route.mtbM)} mountain-bike trail`);
  if (route.dismountM > 0) details.push('contains dismount');
  if (route.hazardM > 0) details.push(`${outcomeDistance(route.hazardM)} curve caution`);
  return details.join(' · ');
}

function presentAsLetters(routes, recommended) {
  if (!routes.length) return routes;
  const ordered = [...routes].sort((a, b) =>
    a.distM - b.distM || a.timeS - b.timeS || compareSafety(a, b));

  for (let i = 0; i < ordered.length; i++) {
    const route = ordered[i];
    const letter = String.fromCharCode(65 + i);
    const isRecommended = route === recommended;
    const lead = isRecommended
      ? 'Recommended — best balance of safety and practicality.'
      : 'A distinct alternative.';
    route._outcome = {
      label: `Route ${letter}`,
      reason: `${lead} ${outcomeSnapshot(route)}.`,
      recommended: isRecommended,
    };
  }
  return ordered;
}

function publicCandidate(candidate) {
  const { edgeIds, nodeIds, _profile, _outcome, ...routeResult } = candidate;
  return {
    ...routeResult,
    optimization: {
      profileId: _profile.id,
      label: _outcome?.label || _profile.label,
      reason: _outcome?.reason || '',
      mode: _profile.mode,
      prefDesignated: _profile.prefDesig,
      prefResidential: _profile.prefResidential,
      alternativeCorridor: !!_profile.alternativeCorridor,
      discoveryMaxSpeed: _profile.discoveryMaxSpeed || null,
      fullyMatchingRules: !!_profile.fullyMatchingRules,
      fullyMatchingProbe: !!_profile.fullyMatchingProbe,
      recommended: !!_outcome?.recommended,
    },
  };
}

function conservativeDiscoveryRules(rules) {
  const legacy = Number(rules.freeMaxSpeed) || 35;
  const urbanCurrent = Number(rules.urbanMaxSpeedNoShoulder) || legacy;
  const ruralCurrent = Number(rules.ruralMaxSpeedNoShoulder) || legacy;
  const urbanMax = Math.max(15, Math.min(30, urbanCurrent - 5));
  const ruralMax = Math.max(15, Math.min(30, ruralCurrent - 5));
  return urbanMax < urbanCurrent || ruralMax < ruralCurrent
    ? { ...rules, urbanMaxSpeedNoShoulder: urbanMax, ruralMaxSpeedNoShoulder: ruralMax }
    : null;
}

// Add a small, bounded set of stricter searches to the candidate pool. These
// searches only discover geometry; route reconstruction, safety metrics, and
// map colors continue to use the rider's actual rules.
function addDiscoveryCandidates(raw, points, rules, forceDesig, forceResidential, snaps) {
  const searchRules = conservativeDiscoveryRules(rules);
  if (!searchRules) return null;
  // Ferry routes are refined section-by-section below. Repeating the same
  // conservative lens across the entire itinerary is slower and recreates the
  // all-or-nothing behavior this portfolio is meant to avoid.
  if (raw.some((candidate) => candidate.ferryM > 0)) return searchRules;
  const discoveryMaxSpeed = Math.max(searchRules.urbanMaxSpeedNoShoulder,
    searchRules.ruralMaxSpeedNoShoulder);
  const directProfile = {
    id: 'discover-quick', label: 'Low-speed discovery', mode: 'direct',
    prefDesig: forceDesig, prefResidential: forceResidential, order: 0.48,
    discoveryMaxSpeed,
  };
  const direct = route(points, rules, directProfile.mode, directProfile.prefDesig,
    directProfile.prefResidential, snaps, null, 1, searchRules);
  if (!direct.ok) return searchRules;
  direct._profile = directProfile;
  direct.aggression = routeAggression(direct);
  raw.push(direct);

  const lowProfile = {
    id: 'discover-gentle', label: 'Low-speed discovery', mode: 'low',
    prefDesig: true, prefResidential: true, order: 2.28, discoveryMaxSpeed,
  };
  const low = route(points, rules, lowProfile.mode, lowProfile.prefDesig,
    lowProfile.prefResidential, snaps, null, 1, searchRules);
  // A discovery lens should uncover a plausible corridor, not reserve a slot
  // for a statewide loop merely because it eliminates a short failure.
  if (low.ok && low.timeS <= direct.timeS * 2.2 + 600) {
    low._profile = lowProfile;
    low.aggression = routeAggression(low);
    raw.push(low);
  }

  const alternativeProfile = {
    id: 'discover-alternative', label: 'Adaptive low-speed corridor',
    mode: 'balanced', prefDesig: true, prefResidential: true, order: 1.48,
    alternativeCorridor: true, discoveryMaxSpeed,
  };
  const alternative = route(points, rules, alternativeProfile.mode,
    alternativeProfile.prefDesig, alternativeProfile.prefResidential, snaps,
    new Set(direct.edgeIds), activeWeights.diversityBalanced, searchRules);
  if (alternative.ok) {
    alternative._profile = alternativeProfile;
    alternative.aggression = routeAggression(alternative);
    raw.push(alternative);
  }
  return searchRules;
}

// A normal weighted search may accept a tiny failing segment even when a
// practical all-matching path exists. Preserve one such option in the
// portfolio. If no ordinary profile found it, run one bounded direct search
// with failing edges unavailable; reporting and map colors still use the
// rider's unchanged rules.
function ensureFullyMatchingCandidate(raw, points, rules, snaps) {
  let matching = raw.filter((candidate) => candidate.failM <= 0.5)
    .reduce((best, candidate) => !best || candidate.timeS < best.timeS ? candidate : best, null);
  if (matching) {
    matching._profile = { ...matching._profile, fullyMatchingRules: true };
    return matching;
  }
  if (rules.requireSafe) return null;

  const strictRules = { ...rules, requireSafe: true };
  const profile = {
    id: 'fully-matching', label: 'Fully matching safety rules', mode: 'direct',
    prefDesig: true, prefResidential: true, order: 2.42,
    fullyMatchingRules: true, fullyMatchingProbe: true,
  };
  const result = route(points, strictRules, profile.mode, profile.prefDesig,
    profile.prefResidential, snaps);
  if (!result.ok || result.failM > 0.5) return null;
  result._profile = profile;
  result.aggression = routeAggression(result);
  raw.push(result);
  return result;
}

function ferryEdgeGroups(routeResult) {
  const groups = [];
  for (let index = 0; index < routeResult.edgeIds.length; index++) {
    if (!(eFlags[routeResult.edgeIds[index]] & 32)) continue;
    const last = groups[groups.length - 1];
    if (last && last.end === index) last.end = index + 1;
    else groups.push({ start: index, end: index + 1 });
  }
  return groups;
}

function ferrySignature(routeResult) {
  return ferryEdgeGroups(routeResult).map(({ start, end }) =>
    routeResult.edgeIds.slice(start, end).join(',')).join('|');
}

// Refine the safest ferry itinerary one land section at a time. A replacement
// is local: using a conservative lens before one ferry never forces that same
// lens onto an island or peninsula after the ferry. Terminals come from ferry
// edges in the graph; no places or coordinates are special-cased.
function addAdaptiveFerryCandidates(raw, rules, forceDesig, forceResidential, searchRules) {
  if (!searchRules) return;
  const itinerarySeeds = new Map();
  for (const candidate of raw) {
    if (candidate._profile.discoveryMaxSpeed) continue;
    const signature = ferrySignature(candidate);
    if (!signature) continue;
    const current = itinerarySeeds.get(signature);
    if (!current || compareSafety(candidate, current) < 0) itinerarySeeds.set(signature, candidate);
  }
  if (!itinerarySeeds.size) return;
  const seed = [...itinerarySeeds.values()].reduce((best, candidate) =>
    compareSafety(candidate, best) < 0 ? candidate : best);
  const ferryGroups = ferryEdgeGroups(seed);
  const landRanges = [];
  const ferryParts = [];
  let cursor = 0;
  for (const group of ferryGroups) {
    landRanges.push({ start: cursor, end: group.start });
    ferryParts.push(routeFragment(seed, group.start, group.end, rules));
    cursor = group.end;
  }
  landRanges.push({ start: cursor, end: seed.edgeIds.length });
  const originalLandParts = landRanges.map(({ start, end }) => routeFragment(seed, start, end, rules));
  const substantialLandSections = originalLandParts.filter((part) => part && part.distM >= 1000).length;
  if (substantialLandSections < 2) return;

  for (let landIndex = 0; landIndex < landRanges.length; landIndex++) {
    const range = landRanges[landIndex], original = originalLandParts[landIndex];
    if (!original || original.distM < 1000) continue;
    const startNode = seed.nodeIds[range.start], endNode = seed.nodeIds[range.end];
    const startPoint = [nodeLon[startNode], nodeLat[startNode]];
    const endPoint = [nodeLon[endNode], nodeLat[endNode]];
    const startSnap = { node: startNode, distM: 0 }, endSnap = { node: endNode, distM: 0 };
    const direct = routeLeg(startPoint, endPoint, rules, 'direct', forceDesig, forceResidential,
      startSnap, endSnap, null, 1, searchRules);
    if (!direct.ok) continue;
    const alternative = routeLeg(startPoint, endPoint, rules, 'balanced', true, true,
      startSnap, endSnap, new Set(direct.edgeIds), activeWeights.diversityBalanced, searchRules);
    if (!alternative.ok || !meaningfullyDifferent(alternative, original)) continue;
    const quickest = Math.min(original.timeS, direct.timeS);
    if (alternative.timeS > quickest * 1.85 + 300
        && alternative.failM + 80 >= Math.min(original.failM, direct.failM)) continue;
    const friendlyGain = (alternative.facilityM + alternative.desigM + alternative.residentialM)
      - (original.facilityM + original.desigM + original.residentialM);
    if (alternative.failM > original.failM + 80
        && friendlyGain < Math.max(1600, alternative.distM * 0.08)) continue;

    const parts = [];
    for (let index = 0; index < landRanges.length; index++) {
      const landPart = index === landIndex ? alternative : originalLandParts[index];
      if (landPart) parts.push(landPart);
      if (index < ferryParts.length && ferryParts[index]) parts.push(ferryParts[index]);
    }
    const hybrid = mergeRouteParts(parts, seed.snapStartM, seed.snapEndM);
    hybrid._profile = {
      id: 'adaptive-corridor',
      label: 'Adaptive corridor', mode: 'balanced', prefDesig: true, prefResidential: true,
      order: seed._profile.order + 0.08 + landIndex * 0.01,
      alternativeCorridor: true,
      discoveryMaxSpeed: Math.max(searchRules.urbanMaxSpeedNoShoulder,
        searchRules.ruralMaxSpeedNoShoulder),
    };
    hybrid.aggression = routeAggression(hybrid);
    raw.push(hybrid);
  }
}

function routeOptions(points, rules, forceDesig, forceResidential, preferredProfileId, debug = false,
    progress = null) {
  const started = Date.now();
  const profiles = candidateProfiles(forceDesig, forceResidential);
  // Snapping scans the statewide node table. Do it once per route point, not
  // once again for every optimization profile.
  const snaps = points.map((point) => nearestNode(point[0], point[1], rules));
  const raw = [];
  let firstFailure = null;
  for (const profile of profiles) {
    const result = route(points, rules, profile.mode, profile.prefDesig, profile.prefResidential, snaps);
    if (!result.ok) {
      if (!firstFailure) firstFailure = result;
      // A bad point or disconnected network is profile-independent.
      if (result.code === 'point-too-far' || result.code === 'same-point') return result;
      continue;
    }
    result._profile = profile;
    result.aggression = routeAggression(result);
    raw.push(result);
  }
  if (!raw.length) return firstFailure || { ok: false, reason: 'No route options were found.' };
  progress?.('Looking for genuinely different route corridors…');

  // Cost profiles can all converge on the same one or two corridors even
  // where a reasonable parallel route exists. If that happens, run a small
  // number of additional A* probes that softly penalize an existing route's
  // edges. The normal time/safety filters and geometry dedupe still decide
  // whether the resulting path is good and distinct enough to show.
  const distinctBeforeProbes = [];
  for (const candidate of raw) {
    if (distinctBeforeProbes.every((other) => meaningfullyDifferent(candidate, other))) {
      distinctBeforeProbes.push(candidate);
    }
  }
  if (distinctBeforeProbes.length < 5) {
    const fastestSeed = raw.reduce((best, r) => r.timeS < best.timeS ? r : best, raw[0]);
    const safestSeed = raw.reduce((best, r) => compareSafety(r, best) < 0 ? r : best, raw[0]);
    const probes = [
      { id: 'alt-quick', mode: 'direct', prefDesig: forceDesig,
        prefResidential: forceResidential, order: 0.45, seed: fastestSeed, factor: activeWeights.diversityQuick },
      { id: 'alt-balanced', mode: 'balanced', prefDesig: true,
        prefResidential: true, order: 1.45, seed: fastestSeed, factor: activeWeights.diversityBalanced },
      { id: 'alt-safer', mode: 'low', prefDesig: true,
        prefResidential: true, order: 2.35, seed: safestSeed, factor: activeWeights.diversitySafer },
      { id: 'alt-wide', mode: 'balanced', prefDesig: forceDesig,
        prefResidential: true, order: 1.55, seed: fastestSeed, factor: activeWeights.diversityWide },
    ];
    for (const probe of probes) {
      const profile = { ...probe, label: 'Alternative corridor', alternativeCorridor: true };
      delete profile.seed; delete profile.factor;
      const result = route(points, rules, profile.mode, profile.prefDesig,
        profile.prefResidential, snaps, new Set(probe.seed.edgeIds), probe.factor);
      if (!result.ok) continue;
      result._profile = profile;
      result.aggression = routeAggression(result);
      raw.push(result);
    }
  }

  const discoveryRules = addDiscoveryCandidates(raw, points, rules,
    forceDesig, forceResidential, snaps);
  if (points.length === 2) {
    addAdaptiveFerryCandidates(raw, rules, forceDesig, forceResidential, discoveryRules);
  }
  progress?.('Checking for a practical route that fully matches your rules…');
  ensureFullyMatchingCandidate(raw, points, rules, snaps);

  const fastest = raw.reduce((best, r) => r.timeS < best.timeS ? r : best, raw[0]);
  const reasonable = raw.filter((r) => r._profile.fullyMatchingRules
    || r.timeS <= fastest.timeS * 2.2 + 600
    || r.failM + 80 < fastest.failM || r.freewayM + 80 < fastest.freewayM);

  // Collapse paths that are not meaningfully different. If one of the equivalent
  // searches used both friendly preferences, retain that explanation so the
  // presented choices still include the required both-preferences candidate.
  const unique = [];
  for (const candidate of reasonable) {
    const same = unique.find((existing) => !meaningfullyDifferent(candidate, existing));
    if (!same) {
      unique.push(candidate);
    } else if (candidate._profile.id === preferredProfileId) {
      unique[unique.indexOf(same)] = candidate;
    } else if (candidate._profile.fullyMatchingRules && !same._profile.fullyMatchingRules) {
      unique[unique.indexOf(same)] = candidate;
    } else if (same._profile.id !== preferredProfileId
        && candidate._profile.prefDesig && candidate._profile.prefResidential
        && !(same._profile.prefDesig && same._profile.prefResidential)) {
      unique[unique.indexOf(same)] = candidate;
    }
  }

  unique.sort((a, b) => a._profile.order - b._profile.order
    || b.aggression - a.aggression || a.timeS - b.timeS);

  const preferred = unique.find((r) => r._profile.id === preferredProfileId);
  const bothPreferences = unique.find((r) => r._profile.prefDesig && r._profile.prefResidential);
  const fullyMatching = unique.find((r) => r._profile.fullyMatchingRules);
  const adaptiveCorridor = unique.find((r) => r._profile.id === 'adaptive-corridor');
  const protectedCandidates = new Set([
    preferred, bothPreferences, fullyMatching, adaptiveCorridor,
  ].filter(Boolean));
  const useful = unique.filter((candidate) => protectedCandidates.has(candidate)
    || !unique.some((other) => {
      if (other === candidate) return false;
      const safety = compareSafety(other, candidate);
      const noSlower = other.timeS <= candidate.timeS + 5;
      // A route may be objectively slower and no safer yet still give the
      // rider a useful different corridor. Only prune dominated candidates
      // when their geometry is also effectively the same.
      const sameCorridor = edgeOverlap(other, candidate) >= 0.96;
      return sameCorridor && noSlower && safety <= 0
        && (other.timeS < candidate.timeS - 5 || safety < 0);
    }));
  const choices = useful.length ? useful : unique;
  progress?.('Comparing safety, travel time, and route variety…');

  const fastestOverall = choices.reduce((best, route) => route.timeS < best.timeS ? route : best, choices[0]);
  const safestOverall = choices.reduce((best, route) => compareSafety(route, best) < 0 ? route : best, choices[0]);
  // Preserve the safest alternative that does not create an excessive detour
  // on any individual leg. Without this guard, a tiny concern near one stop
  // can fill the safer slots with routes that loop far away from that waypoint.
  const hasStops = fastestOverall.legs.length > 1;
  const boundedChoices = hasStops ? choices.filter((route) =>
    route.legs.length === fastestOverall.legs.length && route.legs.every((leg, index) => {
      const quickestLeg = fastestOverall.legs[index];
      return leg.distM <= quickestLeg.distM * 1.55 + 600
        && leg.timeS <= quickestLeg.timeS * 1.6 + 300;
    })) : choices;
  const boundedSafer = boundedChoices.reduce((best, route) =>
    !best || compareSafety(route, best) < 0 ? route : best, null);
  // The recommended route is not necessarily the absolute safest or shortest.
  // Choose the safest result whose every leg stays within a practical detour
  // of the quickest option; the stricter choices remain available as letters.
  const practicalChoices = choices.filter((route) =>
    route.legs.length === fastestOverall.legs.length && route.legs.every((leg, index) => {
      const quickestLeg = fastestOverall.legs[index];
      return leg.distM <= quickestLeg.distM * 1.35 + 800
        && leg.timeS <= quickestLeg.timeS * 1.4 + 300;
    }));
  // The extra strict probe is an availability guarantee, not an instruction
  // to replace the normal recommendation. An all-matching route found by the
  // ordinary profiles remains eligible to be recommended as before.
  const ordinaryPractical = practicalChoices.filter((route) => !route._profile.fullyMatchingProbe);
  const recommendationPool = ordinaryPractical.length ? ordinaryPractical : practicalChoices;
  let recommended = recommendationPool.reduce((best, route) =>
    !best || compareSafety(route, best) < 0 ? route : best, null);
  // The rider's rules outrank a modest time saving: when the practical
  // recommendation still carries failing distance but a fully matching
  // route (including the strict probe) exists within a wider-but-sane
  // detour, recommend the matching route instead.
  if (recommended && recommended.failM > 0.5) {
    const matchingPractical = choices.filter((route) => route.failM <= 0.5
      && route.legs.length === fastestOverall.legs.length
      && route.legs.every((leg, index) => {
        const quickestLeg = fastestOverall.legs[index];
        return leg.distM <= quickestLeg.distM * 1.8 + 1600
          && leg.timeS <= quickestLeg.timeS * 1.85 + 600;
      }));
    const bestMatching = matchingPractical.reduce((best, route) =>
      !best || compareSafety(route, best) < 0 ? route : best, null);
    if (bestMatching) recommended = bestMatching;
  }
  const boundedPreferred = (!hasStops || !preferred || boundedChoices.includes(preferred)
    || preferred === safestOverall) ? preferred : null;
  const boundedBothPreferences = (!hasStops || !bothPreferences
    || boundedChoices.includes(bothPreferences) || bothPreferences === safestOverall)
    ? bothPreferences : null;
  // Keep at most one deliberately extreme per-leg detour: the true safest
  // result. The remaining slots should represent useful approaches to the
  // stops the rider actually chose, not several variations of the same loop.
  const selectionChoices = hasStops ? choices.filter((route) => boundedChoices.includes(route)
    || route === safestOverall || route === boundedPreferred) : choices;
  const selected = [];
  if (selectionChoices.length <= 5) {
    selected.push(...selectionChoices);
  } else {
    selected.push(selectionChoices[0]);
    const last = selectionChoices[selectionChoices.length - 1];
    const pool = selectionChoices.slice(1, -1);
    while (selected.length < 4 && pool.length) {
      let bestIndex = 0, bestScore = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const candidate = pool[i];
        const diversity = Math.min(...selected.map((other) => 1 - edgeOverlap(candidate, other)));
        const profileSpread = Math.min(...selected.map((other) =>
          Math.abs(candidate._profile.order - other._profile.order))) / 4;
        const preferenceBonus = candidate._profile.prefDesig && candidate._profile.prefResidential ? 0.08 : 0;
        const score = diversity + profileSpread * 0.2 + preferenceBonus;
        if (score > bestScore) { bestScore = score; bestIndex = i; }
      }
      const candidate = pool.splice(bestIndex, 1)[0];
      if (selected.every((other) => meaningfullyDifferent(candidate, other))) selected.push(candidate);
    }
    if (selected.every((other) => meaningfullyDifferent(last, other))) selected.push(last);
  }
  const required = [...new Set([recommended, fastestOverall, safestOverall, boundedSafer,
    boundedBothPreferences, boundedPreferred, fullyMatching, adaptiveCorridor].filter(Boolean))];
  for (const candidate of required) {
    if (selected.includes(candidate)) continue;
    if (selected.length < 5) {
      selected.push(candidate);
      continue;
    }
    let replaceAt = selected.length - 1;
    while (replaceAt >= 0 && required.includes(selected[replaceAt])) replaceAt--;
    if (replaceAt >= 0) selected.splice(replaceAt, 1, candidate);
  }
  const presented = presentAsLetters(selected.slice(0, 5), recommended);
  return {
    ok: true, options: presented.map(publicCandidate), ms: Date.now() - started,
    debug: debug ? {
      raw: raw.map((r) => r._profile.id), reasonable: reasonable.map((r) => r._profile.id),
      unique: unique.map((r) => r._profile.id), useful: useful.map((r) => r._profile.id),
      choices: choices.map((r) => r._profile.id), selected: selected.map((r) => r._profile.id),
      safest: safestOverall._profile.id, boundedSafer: boundedSafer?._profile.id,
      fullyMatching: fullyMatching?._profile.id, adaptiveCorridor: adaptiveCorridor?._profile.id,
      recommended: recommended?._profile.id,
    } : undefined,
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
      postMessage({ type: 'progress', phase: 'engine', detail: 'Reading the statewide routing map…' });
      loadGraph(m.buffer);
      postMessage({ type: 'ready', nodes: N, edges: E });
    } else if (m.type === 'route') {
      useWeights(m.weights);
      const pts = m.points && m.points.length >= 2 ? m.points : [m.start, m.end];
      const mode = m.mode || 'balanced';
      postMessage({ type: 'progress', phase: 'reroute', id: m.id,
        detail: 'Finding a route from your current position…' });
      const r = withRoadBlocks(m.blocks, m.rules, () =>
        route(pts, m.rules, mode, !!m.prefDesignated, !!m.prefResidential));
      const profile = {
        id: m.profileId || 'efficient', label: m.profileLabel || 'Selected route',
        mode, prefDesig: !!m.prefDesignated,
        prefResidential: !!m.prefResidential,
      };
      postMessage({ type: 'route', id: m.id, ...publicCandidate({ ...r, _profile: profile }) });
    } else if (m.type === 'route-options') {
      useWeights(m.weights);
      const pts = m.points && m.points.length >= 2 ? m.points : [m.start, m.end];
      const progress = (detail) => postMessage({ type: 'progress', phase: 'route', id: m.id, detail });
      progress('Testing faster, safer, and bike-friendly route profiles…');
      const result = withRoadBlocks(m.blocks, m.rules, () => routeOptions(pts, m.rules,
        !!m.forceDesignated, !!m.forceResidential, m.preferredProfileId, !!m.debug, progress));
      postMessage({ type: 'route-options', id: m.id, ...result });
    } else if (m.type === 'route-connector') {
      useWeights(m.weights);
      const points = m.points && m.points.length >= 2 ? m.points : [m.start, m.end];
      // A connector is deliberately a single balanced search. Current rider
      // rules still score every edge, while requireSafe is relaxed so the
      // temporary route can try to reach the planned start when a perfect
      // match is unavailable. Designated/residential preferences remain soft.
      const connectorRules = { ...m.rules, requireSafe: false };
      const r = withRoadBlocks(m.blocks, connectorRules, () => route(points, connectorRules,
        'balanced', !!m.prefDesignated, !!m.prefResidential));
      const profile = {
        id: 'route-start', label: 'Route to start', mode: 'balanced',
        prefDesig: !!m.prefDesignated,
        prefResidential: !!m.prefResidential,
      };
      postMessage({ type: 'route-connector', id: m.id,
        ...publicCandidate({ ...r, _profile: profile }) });
    } else if (m.type === 'navigation-new-route') {
      useWeights(m.weights);
      const points = m.points && m.points.length >= 2 ? m.points : [m.start, m.end];
      // First preserve the exact single-route behavior that gets a rider
      // moving again when they are off course. The broader portfolio is a
      // convenience for after navigation stops, never a reason to reject a
      // usable recovery route.
      const mode = m.mode || 'balanced';
      const result = withRoadBlocks(m.blocks, m.rules, () => {
        const primary = route(points, m.rules, mode, !!m.prefDesignated, !!m.prefResidential);
        if (!primary.ok) return { primary, portfolio: null };
        let portfolio = null;
        try {
          portfolio = routeOptions(points, m.rules, !!m.prefDesignated,
            !!m.prefResidential, m.profileId);
        } catch (e) { /* Keep the working recovery route if comparison fails. */ }
        return { primary, portfolio };
      });
      const { primary, portfolio } = result;
      if (!primary.ok) {
        postMessage({ type: 'navigation-new-route', id: m.id, ...primary });
        return;
      }
      const primaryProfile = {
        id: m.profileId || 'efficient', label: m.profileLabel || 'Route A',
        mode, prefDesig: !!m.prefDesignated,
        prefResidential: !!m.prefResidential,
      };
      const options = portfolio?.ok && Array.isArray(portfolio.options) && portfolio.options.length
        ? portfolio.options : [publicCandidate({ ...primary, _profile: primaryProfile })];
      postMessage({ type: 'navigation-new-route', id: m.id, ok: true, options,
        ms: portfolio?.ms || primary.ms });
    }
  } catch (err) {
    const message = String(err && err.message || err);
    if (m.type === 'route-connector' || m.type === 'navigation-new-route') {
      postMessage({ type: m.type, id: m.id, ok: false, reason: message });
    } else {
      postMessage({ type: 'error', id: m.id, message });
    }
  }
};
