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

// The verdict ladder is defined once, in safety-model.js, and shared with the
// app so a road cannot score differently here than it reads on the map. The
// same goes for the segment bitfields and the grade math in route-common.js:
// the numbers this worker stores and the numbers the pages recompute must be
// one implementation.
importScripts('safety-model.js');
importScripts('route-common.js');

let N = 0, E = 0, D = 0;
let nodeLon, nodeLat, nodeEle;
let eA, eB, eLen, eAsc, eDes, eSpeed, eSpeedBA, eFlags, eSh, eShBA, eLimitedDir;
let eClass, eFacility, eOfficial, eSurface;
// Format 10 only; null on a BGR9 graph.
let eLanes, eLts;
// Format 11 only; null on anything older. Statewide road measurements: bail-out
// space, the county's reported paved shoulder, traffic volume with its year and
// source, and FHWA functional class with the owner. Carried to the card; none
// of it prices a route.
let eEdgeSpace, eCountyShoulder, eAdt, eAdtMeta, eClassOwner;
// Format 12 only. Which inventory a count came from; a format 11 graph carries
// only the older single "from the state" bit, handled below.
let eAdtSource;

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
// PROHIBITED_SHOULDER (-128, from route-common.js) is reserved by the
// migration tool for a WSDOT permanent bike restriction. It is a hard graph
// exclusion, never a routing penalty.
// Format 11 packing, mirroring scripts/build_graph.py. 255 means "not known",
// which is not the same as zero: a county that never separately inventoried a
// shoulder is not asserting the road has none.
const MEASURE_UNKNOWN = 255;
const EDGE_SPACE_CLAMPED = 128;
const ADT_YEAR_EPOCH = 1940;
// Format 11 packed provenance as one bit of edgeAdtMeta; format 12 gives it a
// byte, because three sources do not fit in one bit and because a modelled HPMS
// estimate is a different claim from a measured count.
const ADT_META_STATE_BIT = 128;
const ADT_SOURCE_COUNTY = 1;
const ADT_SOURCE_STATE = 2;
const ADT_SOURCE_HPMS = 3;

function edgeMeasures(i) {
  if (!eAdt) return null;
  const out = {};
  const space = eEdgeSpace[i];
  if (space !== MEASURE_UNKNOWN) {
    out.edge = space & ~EDGE_SPACE_CLAMPED;
    if (space & EDGE_SPACE_CLAMPED) out.edgeClamp = 1;
  }
  const countyShoulder = eCountyShoulder[i];
  if (countyShoulder !== MEASURE_UNKNOWN) out.countySh = countyShoulder;
  if (eAdt[i]) {
    out.adt = eAdt[i];
    const meta = eAdtMeta[i];
    const year = meta & ~ADT_META_STATE_BIT;
    if (year) out.adty = ADT_YEAR_EPOCH + year;
    // A format 11 graph only knew state-or-not; map that onto the new codes so
    // a rider on a cached graph still gets a correctly labelled card.
    out.adtSrc = eAdtSource ? eAdtSource[i]
      : (meta & ADT_META_STATE_BIT ? ADT_SOURCE_STATE : ADT_SOURCE_COUNTY);
  }
  const classOwner = eClassOwner[i];
  if (classOwner & 15) out.fc = classOwner & 15;
  if (classOwner >> 4) out.owner = classOwner >> 4;
  return Object.keys(out).length ? out : null;
}
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
  // 'BGRA' is format 10, 'BGRB' 11, 'BGRC' 12. Each only ever appends, so a
  // newer reader still understands an older graph and a rider is never stranded
  // on a cached one; the fields it lacks simply read as "not known".
  const hasAdtSource = magic === 0x42475243;
  const hasMeasures = magic === 0x42475242 || hasAdtSource;
  const hasTrafficStress = magic === 0x42475241 || hasMeasures;
  if (magic !== 0x42475239 && !hasTrafficStress) {
    throw new Error('bad graph magic (want BGR9, BGRA, BGRB or BGRC)');
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
  // Format 11: the statewide road measurements. Display-only for now -- nothing
  // below prices a route by them.
  eEdgeSpace = hasMeasures ? u8(E) : null;
  eCountyShoulder = hasMeasures ? u8(E) : null;
  eAdt = hasMeasures ? u16(E) : null;
  eAdtMeta = hasMeasures ? u8(E) : null;
  eAdtSource = hasAdtSource ? u8(E) : null;
  eClassOwner = hasMeasures ? u8(E) : null;
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
  // The fastest ferry actually in this graph. Ferries skip every cost
  // multiplier and sail at their own speed, so the heuristic has to clear them;
  // assuming the field's 255 mph ceiling would slow every search for a boat
  // that does not exist. One pass, at load, not per search.
  maxFerryMps = 0;
  for (let i = 0; i < E; i++) {
    if (!(eFlags[i] & 32)) continue;
    const mps = Math.max(eSpeed[i], 3) * 0.44704;
    if (mps > maxFerryMps) maxFerryMps = mps;
  }
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

function rulesSignature(rules) {
  let out = '';
  for (const key of Object.keys(rules || {}).sort()) {
    if (key === 'requireSafe') continue;
    out += `${key}=${rules[key]};`;
  }
  return out;
}
// Road blocks change which edges the bound may cross, so they belong in its key
// too. Set once per request from the raw marker positions.
let activeBlockSignature = '';

function withRoadBlocks(points, rules, work) {
  const prior = activeRoadBlockEdges;
  const priorSignature = activeBlockSignature;
  activeRoadBlockEdges = roadBlockEdgeSet(points);
  // The safety verdicts and the A* goal potentials are built against the blocks
  // and rules in force. Rather than throw them away when the request ends,
  // record what they were built for: a rider dragging a pin sends the same
  // rules and the same blocks, and re-earning all of it every time was most of
  // what made moving one end of a route cost as much as drawing it.
  activeBlockSignature = JSON.stringify(points || []);
  useVerdictCache(rules);
  try {
    return work();
  } finally {
    activeRoadBlockEdges = prior;
    activeBlockSignature = priorSignature;
  }
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

// Routing cost asks the same question the verdict does, through the same model.
function sidewalkFallbackApplies(i, rules, forward) {
  const facts = edgeFacts(i, forward);
  return SafetyModel.sidewalkFallbackApplies(
    facts, SafetyModel.effectiveShoulder(facts, rules), rules);
}

// Packed edge -> the shared ladder's facts. A WSDOT prohibition is stored in
// the shoulder slot, so it is unpacked here rather than inside the model.
function edgeFacts(i, forward) {
  const flags = eFlags[i];
  const shoulder = edgeShoulder(i, forward);
  const official = eOfficial[i];
  // Sealed through the shared model: this builder reads typed arrays rather
  // than normalised props, so it cannot use factsFrom(), and hand-built shapes
  // are exactly what drifted before. sealFacts fills anything added to
  // FACT_KEYS later, and test_fact_contract fails if this omits one.
  return SafetyModel.sealFacts({
    prohibited: shoulder === PROHIBITED_SHOULDER,
    ferry: !!(flags & 32),
    freeway: !!(flags & 4),
    infra: !!(flags & 8) || eFacility[i] >= 4,
    infraScore: 1,
    facility: eFacility[i],
    limitedAccess: edgeLimited(i, forward),
    speed: edgeSpeed(i, forward),
    shoulder: shoulder >= 0 ? shoulder : null,
    // Bail-out space per side from the CRAB road log; only consulted when
    // `inferShoulderFromEdge` is on and OSM recorded no shoulder.
    edgeSpace: eEdgeSpace && eEdgeSpace[i] !== MEASURE_UNKNOWN
      ? (eEdgeSpace[i] & ~EDGE_SPACE_CLAMPED) : null,
    lanes: eLanes ? eLanes[i] & LANES_COUNT_MASK : 0,
    sidewalk: official & EDGE_SIDEWALK ? 'present'
      : official & EDGE_SIDEWALK_NO ? 'absent' : null,
    urban: !!(official & EDGE_URBAN),
    stressRating: eLts ? (eLts[i] || null) : null,
    // The busy trigger reads a count when the graph has one and the road's
    // class when it does not. Without these the rule would colour the map and
    // do nothing to routing, which is the exact split that made a card
    // disagree with the line under it once already.
    adt: eAdt && eAdt[i] ? eAdt[i] : null,
    fc: eClassOwner && (eClassOwner[i] & 15) ? (eClassOwner[i] & 15) : null,
  });
}

function edgeLevel(i, rules, forward) {
  return SafetyModel.level(edgeFacts(i, forward), rules);
}

// The same answers, remembered. Both of these rebuild a facts object and walk
// the safety ladder, and the inner loop asks for them on every relaxation --
// three times per edge, across twenty searches, plus the backward passes. They
// depend only on the edge, the direction and the rider's rules, and the rules
// do not move for the life of a request.
//
// A discovery lens passes its own stricter rules object; those calls miss and
// fall through, which is correct -- they are a small minority and they must not
// read an answer scored under different rules.
//
// One byte per directed edge: three bits of verdict, one saying the byte is
// filled, one for the sidewalk fallback, and a three-bit generation so a new
// request costs a counter bump rather than clearing 1.7M entries. Every eighth
// request pays the clear.
const VERDICT_KNOWN = 8;
const VERDICT_SIDEWALK_FALLBACK = 16;
// Two rule sets are in play at once. The rider's own hold the first slot for
// the life of a request; the second belongs to whichever conservative discovery
// lens is searching, which is a different object with genuinely different
// answers. With one slot, every relaxation of the discovery searches missed and
// rebuilt the facts object -- an eighth of the router's whole running time.
const verdictSlots = [
  { cache: null, generation: 1, rules: null, key: null, noShoulderMax: 0 },
  { cache: null, generation: 1, rules: null, key: null, noShoulderMax: 0 },
];
function useVerdictSlot(slot, rules) {
  if (!slot.cache) slot.cache = new Uint8Array(2 * E);
  const key = rulesSignature(rules);
  // One value applies to every edge. Cache it per rule set instead of resolving
  // the compatibility keys on every relaxation.
  slot.noShoulderMax = SafetyModel.noShoulderMaxSpeed({}, rules);
  // Dragging a route pin sends the same rules in a new object. Keeping the
  // verdicts across that turns a re-route into forward searching alone.
  if (key !== slot.key) {
    slot.generation = (slot.generation + 1) & 7;
    if (!slot.generation) { slot.cache.fill(0); slot.generation = 1; }
    slot.key = key;
  }
  slot.rules = rules;
  return slot;
}
function useVerdictCache(rules) { useVerdictSlot(verdictSlots[0], rules); }
// Identity is the fast path, taken on every relaxation. Anything else is a rule
// set we have not seen as an object yet, and pays one signature to find its
// slot -- by signature, so the strict "fully matching" probe, which differs
// only by requireSafe and so scores identically, joins the slot that already
// holds those answers instead of evicting the lens from the other one.
function verdictSlotFor(rules) {
  if (rules === verdictSlots[0].rules) return verdictSlots[0];
  if (rules === verdictSlots[1].rules) return verdictSlots[1];
  const key = rulesSignature(rules);
  for (const slot of verdictSlots) {
    if (slot.key === key) { slot.rules = rules; return slot; }
  }
  return useVerdictSlot(verdictSlots[1], rules);
}
function edgeVerdict(slot, i, rules, forward) {
  const at = 2 * i + (forward ? 0 : 1);
  const packed = slot.cache[at];
  if ((packed >>> 5) === slot.generation && (packed & VERDICT_KNOWN)) return packed;
  // Both answers come off one facts object. Building it is the expensive part
  // -- it is a fresh sealed record of fifteen fields -- and asking the two
  // questions separately built it twice.
  const facts = edgeFacts(i, forward);
  const value = VERDICT_KNOWN | SafetyModel.level(facts, rules)
    | (SafetyModel.sidewalkFallbackApplies(facts,
      SafetyModel.effectiveShoulder(facts, rules), rules) ? VERDICT_SIDEWALK_FALLBACK : 0);
  slot.cache[at] = (slot.generation << 5) | value;
  return value;
}
function edgeLevelFor(i, rules, forward) {
  return edgeVerdict(verdictSlotFor(rules), i, rules, forward) & 7;
}
function sidewalkFallbackFor(i, rules, forward) {
  return (edgeVerdict(verdictSlotFor(rules), i, rules, forward) & VERDICT_SIDEWALK_FALLBACK) !== 0;
}
function edgeNoShoulderMaxFor(rules) {
  return verdictSlotFor(rules).noShoulderMax;
}

/* ------------------------------------------------ time model */
// Flat cruising speed (m/s): one steady recreational pace everywhere — a
// dedicated trail allows full transit speed, so it is never modeled slower
// than a road.
const V_ROAD = 5.6;   // ~12.5 mph
const V_MAX = 12.0;   // ~27 mph downhill cap
const V_MIN = 1.3;    // steep-climb floor (~3 mph)
const V_DISMOUNT = 1.15;
// The most this can discount an edge. heuristicSpeed() depends on it.
const SPEED_STRESS_FLOOR = 0.25; // ~2.6 mph while walking a bike
// 6 minutes, raised from 4 by field feedback: routes leaned on walk links a
// little too readily once the network was fully connected.
const DISMOUNT_ENTRY_PENALTY_S = 6 * 60;
// A* heuristic speed: must not undershoot any effective edge speed, including
// fast ferries and the strongest cost bonuses, or A* loses optimality.
// Worst case: V_MAX 12 / (0.30 path facility x 0.78 residential x 0.9
// low-stress comfort bonus) = 57.0 m/s. Keep ample headroom so the heuristic
// remains admissible; the facility sliders bottom out at 0.20, which would be
// 12 / (0.20 x 0.78 x 0.9) = 85.5 m/s and still clears 160.
// A* heuristic speed. h(n) = distance / V_HEUR, so this must not undershoot the
// effective speed of ANY edge -- speed divided by whatever multipliers shrink
// its cost -- or A* stops returning the cheapest route.
//
// It used to be the fixed 160, chosen from a worst case that omitted
// speedStress's 0.25 floor. One constant cannot fit: measured against the
// shipped graph, Direct needs 48, Balanced 105 and Low stress 171. So 160 was
// simultaneously three times too loose for Direct -- costing search that buys
// nothing -- and 7% too tight for Low stress, where it made the heuristic
// inadmissible and the returned route merely near-optimal.
//
// Derived per search instead, from the live weights. O(1), and it tracks the
// weight sliders, which a constant never could: at their minimums the true
// requirement is 1200.
const FERRY_MAX_MPS_FALLBACK = 114.0;   // a u8 mph field caps at 255 mph
let maxFerryMps = FERRY_MAX_MPS_FALLBACK;

// The cost multipliers that can drop BELOW 1, and therefore raise an edge's
// effective speed. Everything else in the cost chain is >= 1 and cannot.
//
// The gating matters and is why this is not one product: speedStress returns
// 1.0 for off-street and ferry edges (fl & (8|32)), and `residential` is
// skipped for the same, so the deepest discount an off-street edge can reach is
// its facility bonus alone. On-street edges get speedStress and residential but
// can never claim the path bonus. Taking the worse of the two cases keeps the
// bound tight without assuming which tags the data happens to carry.
function heuristicSpeed(mode, prefResidential) {
  const comfy = mode === 'direct' ? 1
    : mode === 'low' ? activeWeights.comfyRoadLowStress : activeWeights.comfyRoadBalanced;
  const level = Math.min(1, comfy);
  // On-street: a facility bonus OR a designation bonus, never both.
  const onStreetBonus = Math.min(1,
    activeWeights.facilityShared, activeWeights.facilityLane,
    activeWeights.facilityBuffered, activeWeights.facilitySeparated,
    activeWeights.strongDesignated, activeWeights.designated);
  const residential = prefResidential ? Math.min(1, activeWeights.residential) : 1;
  const onStreet = SPEED_STRESS_FLOOR * onStreetBonus * residential * level;
  // Off-street: no speedStress, no residential, but the path bonus is available.
  const offStreet = Math.min(1, activeWeights.facilityPath) * level;
  const slowest = Math.min(onStreet, offStreet);
  // Ferries bypass every one of those and sail at their own speed.
  return Math.max(V_MAX / slowest, maxFerryMps / level);
}
// Designated bike routes (USBR / regional, edge flag 64) get a modest cost
// bonus. A recorded physical bike facility always gets the stronger bonus;
// designation is useful route context, but is not itself infrastructure.
// Naming: every mode-scaled weight ends in the mode -- Direct, Balanced or
// LowStress -- so the key sorts with its siblings and reads the same way the
// editor labels it. `Low` used to be the suffix and the UI called it
// "friendly", which collided with the `friendly` ROUTE_PROFILES id (low-stress
// mode with both preferences on). Three names for two things; now one each.
const DEFAULT_WEIGHTS = Object.freeze({
  failRoadDirect: 1.5, failRoadBalanced: 9, failRoadLowStress: 30,
  comfyRoadBalanced: 0.92, comfyRoadLowStress: 0.9,
  designated: 0.94, strongDesignated: 0.5, residential: 0.78,
  facilityShared: 0.82, facilityLane: 0.36, facilityBuffered: 0.32,
  facilitySeparated: 0.31, facilityPath: 0.21,
  mtbTrail: 6,
  freeway: 60,
  limitedAccessDirect: 1.05, limitedAccessBalanced: 1.35, limitedAccessLowStress: 1.75,
  // speedOver* and speedBelow* are a pair: cost per mph above your comfort
  // speed, and cost per mph below it on a road with no riding space. The old
  // names were `speedBalanced` and `speedBelowBalanced`, which read as though
  // one were the general case and the other a variant.
  speedOverBalanced: 0.01, speedOverLowStress: 0.02,
  speedBelowDirect: 0.005, speedBelowBalanced: 0.015, speedBelowLowStress: 0.03,
  // Curve severity 1-3. Was `hazard*`, which named no particular hazard.
  curveDirect1: 1.08, curveDirect2: 1.16, curveDirect3: 1.3,
  curveBalanced1: 1.35, curveBalanced2: 1.8, curveBalanced3: 2.6,
  curveLowStress1: 1.8, curveLowStress2: 3.4, curveLowStress3: 6.5,
  // Traffic volume tiers, thresholds in vehicles/day from BUSY_LEVELS. These
  // were `arterialTertiary/Secondary/Primary`, named for the OSM highway tag
  // they used to read. They now price a measured count first and the OSM tag
  // last, so the old names described the weakest of their three inputs.
  busyLightDirect: 1.02, busyLightBalanced: 1.12, busyLightLowStress: 1.22,
  busyMediumDirect: 1.05, busyMediumBalanced: 1.28, busyMediumLowStress: 1.48,
  busyHeavyDirect: 1.1, busyHeavyBalanced: 1.5, busyHeavyLowStress: 1.85,
  // 0 = price busy roads off the OSM tag alone, as before the statewide
  // measurements existed. 1 = let a measured count or an official functional
  // class override the tag. Fractions blend the two.
  useMeasuredTraffic: 1,
  wideRoadDirect: 1.03, wideRoadBalanced: 1.14, wideRoadLowStress: 1.24,
  stressedRoadDirect: 1.04, stressedRoadBalanced: 1.18, stressedRoadLowStress: 1.30,
  ferryWaitMin: 15, uphillFactor: 7, downhillFactor: 2.5, undulationSecPerM: 3,
  climbDirectSecPerM: 0.25, climbBalancedSecPerM: 0.9, climbLowStressSecPerM: 1.6,
  turnDirectSec: 6, turnBalancedSec: 11, turnLowStressSec: 15,
  diversityQuick: 1.3, diversityBalanced: 1.35, diversitySafer: 1.35, diversityWide: 1.6,
});
// One place decides how a mode names its weights. Everything that used to spell
// out `mode === 'low' ? 'Low' : ...` inline now calls this, so a future mode
// cannot be added to some cost functions and forgotten in others.
function modeSuffix(mode) {
  return mode === 'direct' ? 'Direct' : mode === 'low' ? 'LowStress' : 'Balanced';
}
let activeWeights = { ...DEFAULT_WEIGHTS };
let weightsSignature = '';
function useWeights(source) {
  const previous = activeWeights;
  activeWeights = { ...DEFAULT_WEIGHTS };
  applyWeights(source);
  // Everything derived from the weights -- the per-edge cost floors, the goal
  // potentials, the per-mode weight records -- is keyed on this epoch. Bumping
  // it unconditionally discarded all of that on every request, including the
  // many requests that send exactly the weights the last one did.
  const signature = JSON.stringify(activeWeights);
  if (signature === weightsSignature) { activeWeights = previous; return; }
  weightsSignature = signature;
  weightsEpoch++;
}
function applyWeights(source) {
  if (!source || typeof source !== 'object') return;
  const zeroOkay = new Set(['ferryWaitMin', 'speedOverBalanced', 'speedOverLowStress',
    'speedBelowDirect', 'speedBelowBalanced', 'speedBelowLowStress', 'downhillFactor', 'undulationSecPerM',
    'climbDirectSecPerM', 'climbBalancedSecPerM', 'climbLowStressSecPerM',
    'turnDirectSec', 'turnBalancedSec', 'turnLowStressSec', 'useMeasuredTraffic']);
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

// Every mode-scaled weight this mode uses, resolved once. These were reached by
// building a key string -- 'busyLight' + modeSuffix(mode) -- and looking it up
// on a plain object, on every edge relaxation, several times over. Same numbers;
// the concatenation was the cost.
const modeWeightBy = { direct: null, balanced: null, low: null };
let modeWeightEpoch = -1;
function modeWeights(mode) {
  if (modeWeightEpoch !== weightsEpoch) {
    modeWeightBy.direct = modeWeightBy.balanced = modeWeightBy.low = null;
    modeWeightEpoch = weightsEpoch;
  }
  const cached = modeWeightBy[mode];
  if (cached) return cached;
  const s = modeSuffix(mode);
  const record = {
    curve: [1, activeWeights['curve' + s + '1'] || 1, activeWeights['curve' + s + '2'] || 1,
      activeWeights['curve' + s + '3'] || 1],
    busyLight: activeWeights['busyLight' + s],
    busyMedium: activeWeights['busyMedium' + s],
    busyHeavy: activeWeights['busyHeavy' + s],
    wideRoad: activeWeights['wideRoad' + s],
    stressedRoad: activeWeights['stressedRoad' + s],
    limitedAccess: activeWeights['limitedAccess' + s],
  };
  modeWeightBy[mode] = record;
  return record;
}

function hazardMult(weights, severity) {
  if (!severity) return 1;
  return weights.curve[Math.min(3, severity)];
}

// How much traffic is on this road? Three sources answer that question, in
// descending order of directness: a measured AADT, the agency's FHWA functional
// class, and OSM's `highway` tag. This used to read the OSM tag alone, and its
// own comment said why -- "a useful traffic-volume proxy where measured AADT is
// not available". AADT is now available on 51.8% of graph mileage, so the proxy
// was standing in for a number we hold.
//
// All three land on the SAME three tiers, so this changes the evidence and not
// the price: no new tier weights, and an edge OSM already classed pays exactly
// what it paid before unless the measurements disagree with the tag.
//
// This is deliberately a finite route-choice cost, not a safety failure. Any
// recorded bike facility removes the no-facility proxy penalty.
const TIER_NONE = 0, TIER_TERTIARY = 1, TIER_SECONDARY = 2, TIER_PRIMARY = 3;

function osmTrafficTier(i) {
  const cls = eClass[i];
  if (cls === 4 || cls === 5) return TIER_TERTIARY;
  if (cls === 6 || cls === 7) return TIER_SECONDARY;
  if (cls >= 8 && cls <= 11) return TIER_PRIMARY;
  return TIER_NONE;
}

// Thresholds are BUSY_LEVELS ids 4/3/2 from safety-model.js, count and class
// alike. One vocabulary: a rider must never be told a road is "busier than a
// neighborhood street" by the verdict and then have it priced as quiet here.
//
// Returns null -- not TIER_NONE -- when there is no measurement at all. The
// difference matters: null means "keep the OSM answer", while TIER_NONE is a
// measurement saying this road is genuinely quiet, which is the whole point of
// having imported counts for the county roads beside the state highways.
function measuredTrafficTier(i) {
  const adt = eAdt ? eAdt[i] : 0;
  if (adt) {
    return adt > 15000 ? TIER_PRIMARY
      : adt > 6000 ? TIER_SECONDARY
      : adt > 2000 ? TIER_TERTIARY : TIER_NONE;
  }
  const fc = eClassOwner ? (eClassOwner[i] & 15) : 0;
  if (!fc) return null;
  // FHWA runs the other way: smaller is bigger road.
  return fc <= 3 ? TIER_PRIMARY : fc === 4 ? TIER_SECONDARY
    : fc === 5 ? TIER_TERTIARY : TIER_NONE;
}

function trafficTierMult(tier, weights) {
  if (tier === TIER_TERTIARY) return weights.busyLight;
  if (tier === TIER_SECONDARY) return weights.busyMedium;
  if (tier === TIER_PRIMARY) return weights.busyHeavy;
  return 1;
}

function majorRoadMult(i, weights, forward) {
  if (eFacility[i] >= 1 || (eFlags[i] & (8 | 32 | 4)) || edgeLimited(i, forward)) return 1;
  const osm = trafficTierMult(osmTrafficTier(i), weights);
  // `useMeasuredTraffic` blends from the OSM answer toward the measured one. At 0
  // this function is byte-for-byte the old behaviour, which is the point: the
  // measurements can be switched off from the desktop weight editor and ridden
  // against, rather than being an unfalsifiable improvement.
  const blend = activeWeights.useMeasuredTraffic;
  if (!blend) return osm;
  const tier = measuredTrafficTier(i);
  if (tier == null) return osm;
  return osm + blend * (trafficTierMult(tier, weights) - osm);
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
function trafficStressMult(i, weights, forward) {
  if (!eLanes && !eLts) return 1;
  // Only physical separation earns a full exemption. Paint does not shrink the
  // road: 15th Ave NE carries a bike lane along much of its five-lane length,
  // and exempting anything with a stripe meant the road that prompted this was
  // the one road it could never affect. A bike lane or buffer does help, so it
  // halves the cost rather than clearing it.
  if (eFacility[i] >= 4 || (eFlags[i] & (8 | 32 | 4)) || edgeLimited(i, forward)) return 1;
  const paintRelief = eFacility[i] >= 2 ? 0.5 : 1;
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
  const wideMult = wide ? 1 + (weights.wideRoad - 1) * paintRelief : 1;
  const stressMult = stress
    ? 1 + (weights.stressedRoad - 1) * stress * paintRelief : 1;
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
    return 1 + (mode === 'low' ? activeWeights.speedOverLowStress : activeWeights.speedOverBalanced) * delta;
  }
  if (delta === 0 || shoulder > 0) return 1.0;
  const belowKey = mode === 'direct'
    ? 'speedBelowDirect'
    : mode === 'low' ? 'speedBelowLowStress' : 'speedBelowBalanced';
  return Math.max(SPEED_STRESS_FLOOR, 1 - activeWeights[belowKey] * -delta);
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
    : mode === 'low' ? 'climbLowStressSecPerM' : 'climbBalancedSecPerM';
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
// A route-choice cost has to stay proportional to the thing it is judging.
// `lengthFactor` below was the existing attempt at that and it cannot win: it
// falls off linearly in length while the curve rises quadratically in grade,
// so a 24 m ramp at 17% still reached the 40-minute ceiling -- 0.24 * 10,045.
// Avoiding a climb can be worth several times the effort of making it; it
// cannot be worth forty minutes for ten seconds of riding.
//
// This matters most where the grade is not real. Per-edge ascent is sampled
// from a TERRAIN model (edge_climb in build_graph.py) which knows nothing
// about bridges or tunnels, so a flat trail deck over a gully records the
// gully. Two reported Burke-Gilman detours were exactly that. Until the graph
// carries a structure bit, this bound is what stops one phantom climb from
// erasing a corridor.
const MAX_STEEP_AVOID_TIME_MULT = 8;
function steepUphillAvoidanceS(i, forward, mode) {
  // Not on a dismount edge: this penalty exists to price the point where a
  // grade forces a rider OFF the bike ("even a 14%+ stretch can be walked"),
  // and a dismount edge is already priced as walking, entry penalty included.
  // Charging avoidance on top double-counted the same fact -- and did it
  // exactly where grades are least trustworthy, the untagged footways whose
  // DEM samples read gorge walls and park slopes as the path.
  if ((eFlags[i] & 32) || isDismountEdge(i)
      || eLen[i] < MIN_STEEP_AVOID_EDGE_M) return 0;
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
    MAX_STEEP_AVOID_TIME_MULT * edgeTimeS(i, forward),
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
  // Straight continuations are the common case and cost nothing, so decide
  // that before reading the road names -- which only matter for the wider
  // same-road bend below.
  if (delta < 30) return 0;
  if (delta < 70) {
    const incomingName = eName[incomingEdge];
    const sameRoad = incomingName === eName[outgoingEdge]
      && nameOff[incomingName + 1] > nameOff[incomingName];
    if (sameRoad) return 0;
  }
  const key = mode === 'direct' ? 'turnDirectSec'
    : mode === 'low' ? 'turnLowStressSec' : 'turnBalancedSec';
  const base = activeWeights[key];
  if (delta >= 150) return base * 2;
  if (delta < 55) return base * 0.65;
  return base;
}

// DEM elevations are stored as whole meters, while OSM can split a road into
// graph fragments only a few meters long, where quantization turns into
// impossible grades. The credibility rules (MIN_REPORTED_GRADE_M and friends)
// and the shared grade math live in route-common.js.
function reportedGradePct(netRiseM, lenM) {
  const rise = Number(netRiseM);
  const len = Number(lenM);
  if (!Number.isFinite(rise) || !Number.isFinite(len) || len < MIN_REPORTED_GRADE_M) return 0;
  const grade = 100 * rise / len;
  if (!Number.isFinite(grade) || Math.abs(grade) > MAX_CREDIBLE_GRADE_PCT) return 0;
  return Math.round(10 * grade) / 10;
}

/* ------------------------------------------------ riding modes */
// Multiplier applied to an edge's TIME. Low-stress uses a huge (but finite)
// penalty: it takes any reasonable detour to avoid failing roads, yet still
// returns a route when some failing pavement is truly unavoidable — the app
// highlights those segments instead of refusing to route.
function modeMult(mode, lvl) {
  if (mode === 'direct') return lvl === 4 ? activeWeights.failRoadDirect : 1.0;
  if (mode === 'balanced') return lvl === 4 ? activeWeights.failRoadBalanced : lvl === 1 ? activeWeights.comfyRoadBalanced : 1.0;
  /* low */ return lvl === 4 ? activeWeights.failRoadLowStress : lvl === 1 ? activeWeights.comfyRoadLowStress : 1.0;
}

/* ------------------------------------------------------------ goal potential
 * A* needs a lower bound on the cost still to come. A straight line divided by
 * the fastest cost-speed any edge could reach is a legal bound and a nearly
 * worthless one: that speed is ~171 m/s against a real riding speed near 5, so
 * the bound is ~3% of the truth and every profile search degenerates into a
 * Dijkstra across the state. A portfolio runs about twenty of them.
 *
 * Instead: a backward Dijkstra from the leg's goal over a per-edge cost LOWER
 * BOUND -- the real cost function with the smallest number substituted wherever
 * the search's answer cannot be known from the edge alone. What it settles is
 * an exact lower bound on the remaining cost from that node, typically within
 * 10-20% of the truth rather than a factor of thirty.
 *
 * One pass per riding mode, since a bound loose enough for Direct is worth
 * little to a Low-stress search whose roads cost several times more, and one
 * more for the discovery lens when a search uses one. The twelve profiles in a
 * portfolio share a leg's goal four to a mode, so each pass is paid once and
 * spent several times over.
 *
 * This cannot change a route. The potential is used only as h(n), it is a lower
 * bound by construction, and it is consistent (a shortest-path distance under
 * costs that never exceed the real ones), so A* still returns the cheapest path
 * under each profile's own cost function. scripts/test_route_potential.mjs
 * checks the bound against the real cost on every edge of the real graph; that
 * inequality is the whole of the argument, and it has been wrong once already.
 */

// A cached potential is quantised to sixteen bits. It bounds a number of
// seconds in the thousands, so a step of a few hundredths of a second costs it
// nothing, while holding several of these as full float arrays did cost
// something real on a phone. Rounding is downward, the safe direction for a
// lower bound.
const POTENTIAL_UNSETTLED = 0xffff;
// The working arrays, allocated once and reused. A potential is built, read off
// and quantised; doing that with a fresh megabyte allocation several times per
// request is pure garbage.
//
// Double precision, deliberately. Accumulating the pass in floats cost a
// relative error that grows with the number of edges summed, and on a 400 km
// route -- a hundred thousand edges deep -- it drifted far enough above the
// true distance to overshoot, which showed up as routes costing a few seconds
// more than the cheapest available. Doubles make that error ~1e-11, and the
// quantisation below rounds DOWN, so the stored bound is a bound.
let potentialWork = null, potentialSettled = null;
// Belt and braces on the read: `stored * scale` is one more rounding step, and
// a thousandth is orders of magnitude more than it can be off by while still
// leaving the heuristic ~99.9% of its strength.
const POTENTIAL_SAFETY = 0.999;
// How far past the start node the backward pass keeps going. The forward search
// looks at nodes whose remaining true cost runs up to the whole trip's cost, a
// little beyond where the start settles; carrying on briefly gives those nodes
// a real bound instead of the flat frontier value.
const POTENTIAL_MARGIN = 1.15;

// Every edge touching a node, both ways. The routing CSR is directed -- a
// one-way edge appears only at the end it leaves -- so walking backward from
// the goal over that table would miss the ways INTO a node and could overstate
// what remains, which is exactly the error A* cannot tolerate.
let incStart = null, incEdge = null;
function buildIncidence() {
  if (incStart) return;
  const start = new Uint32Array(N + 1);
  for (let i = 0; i < E; i++) { start[eA[i]]++; start[eB[i]]++; }
  let sum = 0;
  for (let n = 0; n < N; n++) { const degree = start[n]; start[n] = sum; sum += degree; }
  start[N] = sum;
  const cursor = start.slice(0, N);
  const edges = new Uint32Array(sum);
  for (let i = 0; i < E; i++) {
    edges[cursor[eA[i]]++] = i;
    edges[cursor[eB[i]]++] = i;
  }
  incStart = start; incEdge = edges;
}

// The cheapest THIS MODE could price an edge, in either direction, whatever the
// rider's bike-route and residential preferences.
//
// Tightness is the whole game. A bound four times under the truth prunes almost
// nothing, so this is the real cost function with the smallest possible number
// substituted wherever the search's answer is not knowable per edge, and one
// bound per mode rather than one shared by all three -- a bound loose enough for
// Direct is worth little to a Low-stress search, whose roads cost several times
// more. Only turn friction, the dismount entry charge, the ferry boarding wait,
// the alternative-corridor penalty and the exempted-access surcharge are dropped
// outright: all are >= 0 and none belongs to a single edge in isolation.
//
// Priced one directed edge at a time, on demand. Pricing all 858k edges three
// times over cost more than the search it was meant to save, and the backward
// pass evaluates each direction at most once anyway -- it meets an edge from
// each of its two ends, and each meeting is one direction of travel.
let floorKey = '', floorSetup = null;
let weightsEpoch = 0;
// Everything the bound reads, as one string.
//
// `requireSafe` is deliberately excluded. It only removes edges from the forward
// search, which can raise a route's real cost and never lower it, so a bound
// built without it still holds -- and leaving it out lets the strict "fully
// matching" probe reuse what the ordinary profiles already built instead of
// paying for three more backward passes to reach the same answer.
//
// Everything keyed on the rider's rules keys on this, so none of it depends on
// the order the callers happen to run in. Handing a bound built under one rule
// set to a search using another is exactly the mistake that would quietly cost
// optimality without failing any test.
function boundSignature(rules) {
  return `${weightsEpoch}|${activeBlockSignature}|${rulesSignature(rules)}`;
}
function useEdgeCostFloors(rules, searchRules, mode) {
  const key = `${mode}|${boundSignature(rules)}|${boundSignature(searchRules)}`;
  if (floorKey === key) return;
  // modeMult comes from the edge's own verdict, scored under the rules the
  // search will actually price against. Flooring it at the comfortable-road
  // bonus instead -- the obvious shortcut, since the verdict is the expensive
  // part -- left the Low-stress bound five times under the truth: it priced a
  // failing road at 0.9 where the search charges 30.
  //
  // Scoring it under the RIDER's rules and assuming a discovery lens could only
  // push a road further DOWN the ladder was also wrong, and quietly cost
  // optimality on exactly the searches that use a lens. The ladder is not
  // monotone in rule strictness: a 35 mph road with no shoulder fails against a
  // 35 mph limit but only cautions against 30. So a lens gets its own floors,
  // and its own potential.
  const limitedFloor = Math.min(1, modeWeights(mode).limitedAccess);
  const freewayFloor = Math.min(1, activeWeights.freeway);
  const mtbFloor = Math.min(1, activeWeights.mtbTrail);
  const designatedFloor = Math.min(1, activeWeights.strongDesignated, activeWeights.designated);
  const residentialFloor = Math.min(1, activeWeights.residential);
  const facility = [1, activeWeights.facilityShared, activeWeights.facilityLane,
    activeWeights.facilityBuffered, activeWeights.facilitySeparated, activeWeights.facilityPath]
    .map((weight) => Math.min(1, weight));
  // speedStress only discounts a road with no riding space signed BELOW the
  // rider's comfort speed, in proportion to how far below. Reading that per
  // edge rather than assuming the 0.25 floor everywhere is most of the reason
  // this bound is worth building at all.
  const belowRate = mode === 'direct' ? activeWeights.speedBelowDirect
    : mode === 'low' ? activeWeights.speedBelowLowStress : activeWeights.speedBelowBalanced;
  const noShoulderMax = verdictSlotFor(searchRules).noShoulderMax;
  const climbRate = activeWeights[mode === 'direct' ? 'climbDirectSecPerM'
    : mode === 'low' ? 'climbLowStressSecPerM' : 'climbBalancedSecPerM'];

  floorKey = key;
  floorSetup = { rules, searchRules, mode, weights: modeWeights(mode), limitedFloor,
    freewayFloor, mtbFloor, designatedFloor, residentialFloor, facility, belowRate,
    noShoulderMax, climbRate };
}

/* What the search charges to ride edge `ei` in one direction.
 *
 * This was written out inline in routeLeg's relaxation loop, and a second time
 * in scripts/test_route_potential.mjs so that the A* lower bound could be
 * checked against it. Two copies of the price of an edge: the test's copy fell
 * behind the moment a term was added, and any diagnostic anyone wrote became a
 * third. Everything that prices an edge calls this now.
 *
 * `ctx` carries the search's settings plus the three path-dependent inputs,
 * which are the only reason this cannot be a pure function of the edge:
 * `boardingWaitS` (a ferry costs its wait only where this end has land),
 * `incomingEdge` and `fromNode` (a dismount run is charged once, and turn
 * friction depends on what you turned off). Omit them and you get the
 * edge-only price -- which is exactly what edgeCostFloor() has to bound.
 */
function edgeCost(ei, forward, ctx) {
  const fl = eFlags[ei];
  const actualLevel = edgeLevelFor(ei, ctx.rules, forward);
  const searchLevel = ctx.searchRules === ctx.rules
    ? actualLevel : edgeLevelFor(ei, ctx.searchRules, forward);
  const mult = modeMult(ctx.mode, searchLevel);
  if (!(mult < Infinity)) return Infinity;
  let step = edgeTimeS(ei, forward) + climbPreferenceS(ei, forward, ctx.mode);
  step += ctx.boardingWaitS || 0;   // ferry boarding, when this end has land
  let cost = step * mult;
  // An exempted terminal-access block is a last resort, never a shortcut:
  // any reasonable fully-safe approach must still win.
  if (ctx.requiredSafeAccess) cost *= 30;
  cost *= speedStress(ctx.mode, fl, edgeSpeed(ei, forward),
    edgeNoShoulderMaxFor(ctx.searchRules), edgeShoulder(ei, forward));
  cost *= hazardMult(ctx.modeW, edgeHazard(ei, forward) || 0);
  cost *= majorRoadMult(ei, ctx.modeW, forward);
  cost *= trafficStressMult(ei, ctx.modeW, forward);
  cost *= sidewalkExposureMult(ei, ctx.mode, forward);
  if (sidewalkFallbackFor(ei, ctx.searchRules, forward)) cost *= sidewalkFallbackMult(ctx.mode);
  if (fl & 4) cost *= activeWeights.freeway;
  // Every other signal costs more as the profile gets friendlier, and this
  // one must too: limitedAccessLowStress sat at 1.0, so the low-stress profile applied
  // no penalty at all to a bike-legal limited-access highway -- less than
  // balanced. The friendliest route was the one most willing to put a rider
  // on a highway shoulder.
  if (edgeLimited(ei, forward)) cost *= ctx.modeW.limitedAccess;
  if (eOfficial[ei] & EDGE_MTB) cost *= activeWeights.mtbTrail;
  // Bonuses never apply to ferries, freeways, or WSDOT limited-access
  // highways: preference must not erase their access/caution costs. For
  // an ordinary road, a physical facility beats designation alone; when
  // both are present, use whichever benefit is stronger rather than
  // stacking them into an outsized corridor bonus.
  // A signed route is a recommendation, not a fact about the road, so the
  // bonus is withheld from an edge that FAILS the rider's rules. It is not
  // withheld from a caution: a caution means the rules are met with a
  // caveat, and two of its three causes -- a limited-access highway and an
  // official high-stress rating -- are facts about the road rather than
  // anything the rider set.
  //
  // A WSDOT limited-access edge is no longer excluded either. Its penalty
  // (limitedAccess*) is applied separately just above and stands
  // on its own; withholding the bonus as well counted it twice, and left a
  // signed shoulder route along a state highway priced identically to any
  // other highway -- the case where a designation carries the most
  // information for a touring rider.
  //
  // A physical facility now always speaks for itself rather than competing
  // with designation through Math.min. That comparison was written when
  // designation was 0.86, weaker than every facility weight; at 0.5 it
  // silently inverted, making a signed road with no infrastructure beat a
  // road with a painted bike lane (0.68).
  if (!(fl & (32 | 4)) && !isDismountEdge(ei) && actualLevel < 4) {
    const signed = fl & 64;
    cost *= eFacility[ei]
      ? facilityPrefMult(eFacility[ei])
      : (signed ? activeWeights[ctx.prefDesig ? 'strongDesignated' : 'designated'] : 1);
  }
  if (ctx.prefResidential && !(fl & (8 | 32 | 4))
      && !edgeLimited(ei, forward) && isResidential(ei)) {
    cost *= activeWeights.residential;
  }
  // Alternative-corridor probes softly penalize ordinary road edges from
  // one already-found path. Protected lanes and shared paths may remain a
  // common trunk: leaving excellent infrastructure merely to be different
  // creates fussy neighborhood detours instead of a useful alternative.
  const protectedInfrastructure = (fl & 8) || eFacility[ei] >= 4;
  if (ctx.diversityEdges?.has(ei) && !protectedInfrastructure && !(fl & 32)) {
    cost *= ctx.diversityFactor;
  }
  // Grade is an independent rideability concern. Apply it after every
  // safety, facility, residential, and alternate-corridor multiplier so
  // a path bonus cannot shrink the penalty for a genuinely steep climb.
  cost += steepUphillAvoidanceS(ei, forward, ctx.mode);
  // Similarly, a designated trail remains eligible but should not erase
  // the rider's explicit preference for pavement.
  cost += surfacePreferenceS(ei, ctx.rules);
  // Dismount access remains available to repair a genuinely connected
  // cycling corridor, but entering it has a fixed interruption cost in
  // addition to the walking time returned by edgeTimeS().  Because the
  // search state includes the incoming edge, a continuous dismount run is
  // charged once rather than once for every split graph edge.
  if (isDismountEdge(ei) && (ctx.incomingEdge == null || ctx.incomingEdge < 0
      || !isDismountEdge(ctx.incomingEdge))) {
    cost += DISMOUNT_ENTRY_PENALTY_S;
  }
  // Turn friction is independent of the road entered: a bike facility or
  // residential bonus should not make repeated intersection turns free.
  if (ctx.fromNode != null) cost += turnPreferenceS(ctx.incomingEdge, ctx.fromNode, ei, ctx.mode);
  return cost;
}

function edgeCostFloor(i, forward) {
  const { rules, searchRules, mode, weights, limitedFloor, freewayFloor, mtbFloor,
    designatedFloor, residentialFloor, facility, belowRate, noShoulderMax, climbRate } = floorSetup;
  const fl = eFlags[i];
  // The verdict the SEARCH prices against, and the verdict the RIDER's own
  // rules give. They are the same for every ordinary profile, and differ only
  // under a discovery lens -- which reprices a road without restating it.
  const searchLevel = edgeLevelFor(i, searchRules, forward);
  const level = searchRules === rules ? searchLevel : edgeLevelFor(i, rules, forward);
  let m = modeMult(mode, searchLevel);
  if (!(m < Infinity)) return Infinity;
  if (fl & 4) m *= freewayFloor;
  if (eOfficial[i] & EDGE_MTB) m *= mtbFloor;
  if (!(fl & (8 | 32 | 4)) && isResidential(i)) m *= residentialFloor;
  if (!(fl & (32 | 4)) && !isDismountEdge(i) && level < 4) {
    // A facility bonus OR a designation bonus, never both, and never on a
    // ferry, freeway or dismount link. The rider may have set neither
    // preference, so take whichever of the two prices the edge lower.
    m *= eFacility[i] ? (facility[eFacility[i]] ?? 1) : ((fl & 64) ? designatedFloor : 1);
  }
  if (!(fl & (8 | 32))) {
    const below = noShoulderMax - edgeSpeed(i, forward);
    if (below > 0 && !(edgeShoulder(i, forward) > 0)) {
      m *= Math.max(SPEED_STRESS_FLOOR, 1 - belowRate * below);
    }
  }
  // Everything the search charges ON TOP of the base time, read from this edge
  // rather than floored at 1. These are what make a Low-stress bound
  // meaningfully stronger than a Direct one.
  m *= hazardMult(weights, edgeHazard(i, forward) || 0);
  m *= majorRoadMult(i, weights, forward);
  m *= trafficStressMult(i, weights, forward);
  m *= sidewalkExposureMult(i, mode, forward);
  if (edgeLimited(i, forward)) m *= limitedFloor;
  let climb = 0;
  if (!(fl & 32)) {
    const asc = forward ? eAsc[i] : eDes[i];
    const des = forward ? eDes[i] : eAsc[i];
    const netAsc = Math.max(0, asc - des);
    const steepness = 1 + Math.max(0, netAsc / Math.max(1, eLen[i]) - 0.04) * 8;
    climb = (netAsc * steepness + Math.max(0, asc - netAsc) * 0.5) * climbRate;
  }
  return (edgeTimeS(i, forward) + climb) * m
    + steepUphillAvoidanceS(i, forward, mode) + surfacePreferenceS(i, rules);
}

// Keyed by goal node, mode and the bound signature, so a potential is only ever
// handed to a search it was actually built for -- and survives into the next
// request when nothing it depends on has moved.
//
// Three modes times a leg's goal. A ferry trip reaches seven: the adaptive
// corridor probe re-searches each land section between crossings, and those
// have goals of their own.
const POTENTIAL_CACHE_MAX = 8;
const potentialCache = new Map();

function goalPotential(goalNode, startNode, rules, searchRules, mode) {
  const cacheKey = `${goalNode}|${mode}|${boundSignature(rules)}|${boundSignature(searchRules)}`;
  const cached = potentialCache.get(cacheKey);
  if (cached) {
    // Move to the back: the ferry probes visit a handful of one-shot goals, and
    // evicting by insertion order let them push out the goal the other twenty
    // searches keep asking for.
    potentialCache.delete(cacheKey);
    potentialCache.set(cacheKey, cached);
    return cached;
  }
  buildIncidence();
  useEdgeCostFloors(rules, searchRules, mode);
  if (!potentialWork) { potentialWork = new Float64Array(N); potentialSettled = new Uint8Array(N); }
  const dist = potentialWork, settled = potentialSettled;
  dist.fill(Infinity); settled.fill(0);
  const heap = makeHeap(4096);
  dist[goalNode] = 0;
  heap.push(0, goalNode);
  // Legality the whole request agrees on. Anything profile-specific is left
  // permissive: allowing an edge the forward search refuses only lowers the
  // bound, which stays admissible.
  const noMtb = !rules?.allowMtbTrails;
  const noFreeway = !rules?.allowFreeways;
  const blocked = activeRoadBlockEdges;
  let frontier = 0, limit = Infinity;
  while (heap.size) {
    frontier = heap.topKey;
    if (frontier > limit) break;
    const u = heap.pop();
    if (settled[u]) continue;
    settled[u] = 1;
    if (u === startNode) limit = frontier * POTENTIAL_MARGIN;
    const du = dist[u];
    for (let k = incStart[u]; k < incStart[u + 1]; k++) {
      const ei = incEdge[k];
      const fl = eFlags[ei];
      if (blocked?.has(ei)) continue;
      if (noFreeway && (fl & 4)) continue;
      if (noMtb && (eOfficial[ei] & EDGE_MTB)) continue;
      // This walks the arc BACKWARD: v is where a route would be coming from,
      // so the traversal under test is v -> u and `forward` is read off v.
      const fromA = eA[ei] !== u;
      const v = fromA ? eA[ei] : eB[ei];
      if (settled[v] || v === u) continue;
      // One-way edges may only be entered from the end they leave.
      if ((fl & 16) && !fromA) continue;
      if (edgeShoulder(ei, fromA) === PROHIBITED_SHOULDER) continue;
      const nd = du + edgeCostFloor(ei, fromA);
      // An excluded edge prices at Infinity and never wins. Push the value as
      // STORED, so a node's heap key and its recorded distance cannot disagree
      // by a rounding step.
      if (nd < dist[v]) { dist[v] = nd; heap.push(dist[v], v); }
    }
  }
  // Only settled nodes hold a true distance; a tentative value is an upper
  // bound on the distance from the goal and would break admissibility.
  // Distances settle in increasing order, so everything left unsettled is at
  // least as far from the goal as the point the pass stopped at.
  const scale = frontier > 0 ? frontier / (POTENTIAL_UNSETTLED - 1) : 1;
  const stored = new Uint16Array(N);
  for (let n = 0; n < N; n++) {
    stored[n] = settled[n]
      ? Math.min(POTENTIAL_UNSETTLED - 1, Math.floor(dist[n] / scale))
      : POTENTIAL_UNSETTLED;
  }
  const potential = { dist: stored, scale, beyond: frontier * POTENTIAL_SAFETY };
  if (potentialCache.size >= POTENTIAL_CACHE_MAX) {
    potentialCache.delete(potentialCache.keys().next().value);
  }
  potentialCache.set(cacheKey, potential);
  return potential;
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
  // Short failing blocks at a leg's own endpoints stay usable so a rider can get
  // out of their own street. A freeway is never that: nobody's driveway is on a
  // motorway, and "(fails)" on the setting has to mean the road is excluded
  // whenever failing roads are.
  const terminalAccessEdge = (ei) =>
    eLen[ei] <= ACCESS_EDGE_MAX_M && !(eFlags[ei] & 4)
    && (nearTerminal(eA[ei]) || nearTerminal(eB[ei]));
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
  const modeW = modeWeights(mode);
  const vHeur = heuristicSpeed(mode, prefResidential);
  // Two admissible bounds; take the stronger. The potential is far and away the
  // better one wherever it reaches, and the straight line still covers what the
  // backward pass stopped short of.
  const potential = goalPotential(t.node, s.node, rules, searchRules, mode);
  const potDist = potential.dist, potBeyond = potential.beyond;
  const potScale = potential.scale * POTENTIAL_SAFETY;
  // Where the backward pass reached, its answer is what matters: it runs some
  // twenty to thirty times the straight line, which is only worth consulting
  // out past the edge of the potential. Taking the larger of the two everywhere
  // meant a haversine -- two sines, two cosines, an arcsine and a square root
  // -- on every single node expansion, to change the answer essentially never.
  //
  // Dropping it costs consistency, not admissibility: both are lower bounds, so
  // either alone is legal, but a heuristic assembled piecewise is not
  // necessarily monotone. The search reopens a settled arc when a cheaper walk
  // to it turns up, which is what makes admissibility enough.
  const h = (n) => {
    const settled = potDist[n];
    if (settled !== POTENTIAL_UNSETTLED) return settled * potScale;
    return Math.max(havM(nodeLon[n], nodeLat[n], goalLon, goalLat) / vHeur, potBeyond);
  };
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
      // A settled arc may still be improvable. Skipping it outright -- pure
      // label-setting A* -- is only sound when the heuristic is CONSISTENT, not
      // merely a lower bound, and the goal potential is stored quantised, so it
      // is a hair off consistent. Left alone, that showed up as routes costing
      // a few seconds more than the cheapest on 400 km trips: the search had
      // settled an arc and would never look at it again.
      //
      // The guard below rules out the overwhelming majority for free, since no
      // edge costs less than nothing: if the walk to here already costs as much
      // as the arc's recorded distance, nothing downstream can improve it.
      if (searchStamp[a] === -generation && du >= searchDist[a]) continue;
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
      const actualLevel = edgeLevelFor(ei, rules, forward);
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
      const cost = edgeCost(ei, forward, {
        mode, modeW, rules, searchRules, prefDesig, prefResidential,
        diversityEdges, diversityFactor,
        requiredSafeAccess,
        boardingWaitS: (fl & 32) && nodeHasLand[u] ? activeWeights.ferryWaitMin * 60 : 0,
        incomingEdge, fromNode: u,
      });
      if (!(cost < Infinity)) continue;
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
    // >= 2, not >= 1: facility 1 is a sharrow, which is paint in a shared lane
    // and must not count toward the route's bike-facility mileage.
    if (eFacility[ei] >= 2) facilityM += eLen[ei];
    if (eOfficial[ei] & EDGE_MTB) mtbM += eLen[ei];
    if (isDismountEdge(ei)) dismountM += eLen[ei];
    if (!(eFlags[ei] & (8 | 32 | 4)) && !edgeLimited(ei, forward)
        && isResidential(ei)) residentialM += eLen[ei];
    if (eFlags[ei] & 4) freewayM += eLen[ei];
    else if (edgeLimited(ei, forward)) limitedAccessM += eLen[ei];
    const verdict = SafetyModel.evaluate(edgeFacts(ei, forward), rules);
    const level = verdict.level;
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
      // The other direction's shoulder, so a card can say "(your direction)"
      // when the two sides differ instead of silently contradicting the road
      // card, which shows the worse of the two.
      shBack: edgeShoulder(ei, !forward),
      flags: eFlags[ei] | (edgeLimited(ei, forward) ? 128 : 0), roadClass: eClass[ei],
      facility: eFacility[ei], official: eOfficial[ei], mtb: !!(eOfficial[ei] & EDGE_MTB),
      dismount: isDismountEdge(ei), level, cautionCause: verdict.caution || null,
      surface: eSurface[ei], surfaceLabel: SURFACE_LABEL[eSurface[ei]] || SURFACE_LABEL[SURFACE_UNKNOWN],
      lanes: eLanes ? eLanes[ei] & LANES_COUNT_MASK : 0,
      centerTurnLane: !!(eLanes && (eLanes[ei] & LANES_CENTER_TURN)),
      lts: eLts ? eLts[ei] : 0,
      measures: edgeMeasures(ei),
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
    // >= 2, not >= 1: facility 1 is a sharrow, which is paint in a shared lane
    // and must not count toward the route's bike-facility mileage.
    if (eFacility[ei] >= 2) facilityM += eLen[ei];
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

// Why did this route get generated at all? The portfolio runs a grid of
// profiles plus several special probes, and the whole point of the "More"
// screen is to see what each one produced -- so each has to be able to say what
// it was asked for, in the rider's vocabulary rather than a profile id.
const MODE_WORDS = { direct: 'Direct', balanced: 'Balanced', low: 'Low stress' };
function profileExplanation(profile) {
  if (profile.fullyMatchingProbe) {
    return 'Strict probe: searched only road that fully matches your rules.';
  }
  if (profile.fullyMatchingRules) {
    return 'Searched only road that fully matches your rules.';
  }
  if (profile.discoveryMaxSpeed) {
    return `Discovery: same search with the no-shoulder speed dropped to ${profile.discoveryMaxSpeed} mph,`
      + ' to see whether a quieter corridor exists at all.';
  }
  const parts = [`${MODE_WORDS[profile.mode] || profile.mode} cost model`];
  if (profile.prefDesig) parts.push('preferring signed bike routes and trails');
  if (profile.prefResidential) parts.push('preferring residential streets');
  let text = parts.join(', ') + '.';
  if (profile.alternativeCorridor) {
    text += ' Re-run with the roads of an earlier option penalised, to force a different corridor.';
  }
  return text;
}

// A coarse outline for the "More" screen's thumbnails, carrying the worst
// verdict level along each kept span so the sketch can show WHERE a route goes
// bad, not merely that it does.
//
// 48 points is enough to tell two corridors apart at thumbnail size and costs
// roughly 700 bytes -- the whole reason the summaries exist is that shipping
// real geometry for every candidate measures megabytes.
var SHAPE_POINTS = 48;
function candidateShape(candidate) {
  var coords = candidate.coords || [];
  if (coords.length < 2) return null;
  // Worst level touching each coordinate, so a short failing stretch inside a
  // long span survives the downsample instead of being averaged away.
  var levelAt = new Uint8Array(coords.length);
  var segs = candidate.segs || [];
  for (var i = 0; i < segs.length; i++) {
    var seg = segs[i], lv = Number(seg.level) || 0;
    for (var c = seg.c0; c <= seg.c1 && c < coords.length; c++) {
      if (lv > levelAt[c]) levelAt[c] = lv;
    }
  }
  var step = Math.max(1, Math.floor(coords.length / SHAPE_POINTS));
  var pts = [], lv2 = [];
  for (var k = 0; k < coords.length; k += step) {
    // Carry the worst level across the points this one stands in for.
    var worst = 0;
    for (var j = k; j < Math.min(k + step, coords.length); j++) {
      if (levelAt[j] > worst) worst = levelAt[j];
    }
    pts.push([Math.round(coords[k][0] * 1e4) / 1e4, Math.round(coords[k][1] * 1e4) / 1e4]);
    lv2.push(worst);
  }
  var last = coords[coords.length - 1];
  pts.push([Math.round(last[0] * 1e4) / 1e4, Math.round(last[1] * 1e4) / 1e4]);
  lv2.push(levelAt[coords.length - 1]);
  return { pts: pts, lv: lv2 };
}

// A compact row for the "More" screen. Deliberately excludes segs/geometry:
// shipping every candidate in full measures 3.4-4.2 MB on a Puget Sound trip,
// which is a large structured clone to pay on every single route request for a
// screen the rider opens occasionally. The full route is fetched on tap
// instead, from the cache below.
function candidateSummary(candidate) {
  const profile = candidate._profile;
  return {
    profileId: profile.id,
    label: candidate._outcome?.label || profile.label,
    presented: !!candidate._outcome,
    recommended: !!candidate._outcome?.recommended,
    why: profileExplanation(profile),
    stage: candidate._stage || 'considered',
    stageWhy: candidate._stageWhy || '',
    distM: candidate.distM,
    timeS: candidate.timeS,
    failM: candidate.failM,
    levelM: candidate.levelM,
    facilityM: candidate.facilityM,
    desigM: candidate.desigM,
    residentialM: candidate.residentialM,
    unpavedM: candidate.unpavedM || 0,
    ferryM: candidate.ferryM || 0,
    ascentM: candidate.ascentM || 0,
    shape: candidateShape(candidate),
  };
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
  // One speed since the urban/rural split was collapsed; the shared model still
  // reads the old keys so a rider on saved settings is not stranded.
  const current = SafetyModel.noShoulderMaxSpeed({}, rules);
  const stricter = Math.max(15, Math.min(30, current - 5));
  return stricter < current ? { ...rules, maxSpeedNoShoulder: stricter } : null;
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
  const discoveryMaxSpeed = SafetyModel.noShoulderMaxSpeed({}, searchRules);
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
    // This probe re-imagines the LAND sections of a ferry itinerary; the
    // seed's boats are spliced back in verbatim. An "alternative" that
    // itself boards a ferry can sail back across water the seed already
    // crossed -- the five-boat Seattle->Walla Walla hybrid rode the
    // Tahlequah ferry twice, once from the seed and once from the
    // alternative -- so a land section's replacement must stay on land.
    if (alternative.ferryM > 0) continue;
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
      discoveryMaxSpeed: SafetyModel.noShoulderMaxSpeed({}, searchRules),
    };
    hybrid.aggression = routeAggression(hybrid);
    raw.push(hybrid);
  }
}

// The last portfolio, kept whole so the "More" screen can hand back a full
// route on tap without re-searching. Keyed by the request it came from, so a
// stale tap after the rider moved a pin is refused rather than answered wrongly.
let lastCandidates = null;
let lastCandidatesKey = null;

function routeOptions(points, rules, forceDesig, forceResidential, preferredProfileId, debug = false,
    progress = null, requestSignature = null) {
  const started = Date.now();
  // Identifies this exact request, so a tap on the "More" screen that arrives
  // after the rider changed something is refused rather than answered from a
  // portfolio built under different inputs.
  //
  // The caller supplies the signature because weights and road blocks are not
  // arguments here -- they are applied around the call -- and both change which
  // routes come back. Leaving them out made the key claim two different
  // portfolios were the same.
  const routeKey = requestSignature
    || JSON.stringify([points, rules, !!forceDesig, !!forceResidential]);
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

  // ---- the troubleshooting record -------------------------------------
  // Mark every candidate with the stage that dropped it, so the "More" screen
  // can explain absence rather than merely listing survivors. Order matters:
  // the earliest stage a route failed to reach is the one that removed it.
  const inReasonable = new Set(reasonable), inUnique = new Set(unique);
  const inUseful = new Set(useful), inSelected = new Set(presented);
  for (const candidate of raw) {
    if (inSelected.has(candidate)) {
      candidate._stage = 'offered';
      candidate._stageWhy = '';
    } else if (!inReasonable.has(candidate)) {
      candidate._stage = 'too-slow';
      candidate._stageWhy = 'Far slower than the quickest option without being safer.';
    } else if (!inUnique.has(candidate)) {
      const twin = unique.find((other) => !meaningfullyDifferent(candidate, other));
      candidate._stage = 'duplicate';
      candidate._stageWhy = twin
        ? `Effectively the same roads as ${twin._outcome?.label || twin._profile.label}.`
        : 'Effectively the same roads as another option.';
    } else if (!inUseful.has(candidate)) {
      candidate._stage = 'dominated';
      candidate._stageWhy = 'Another option shares this corridor and is no slower and no less safe.';
    } else {
      candidate._stage = 'not-chosen';
      candidate._stageWhy = 'Survived every filter, but five slots were filled by more distinct routes.';
    }
  }
  // Letter the extras so a rider can name them. A-E are the offered routes; the
  // rest continue F, G, ... and fall back to numbering past Z.
  const extras = raw.filter((candidate) => !inSelected.has(candidate))
    .sort((a, b) => a.distM - b.distM || a.timeS - b.timeS);
  for (let i = 0; i < extras.length; i++) {
    const index = presented.length + i;
    extras[i]._extraLabel = index < 26
      ? `Route ${String.fromCharCode(65 + index)}`
      : `Route ${index - 25}`;
  }
  const allCandidates = [...presented, ...extras];
  // Cache the full routes so tapping one costs a lookup rather than a re-search.
  lastCandidates = new Map(allCandidates.map((c) => [c._profile.id, c]));
  lastCandidatesKey = String(routeKey);

  return {
    ok: true, options: presented.map(publicCandidate), ms: Date.now() - started,
    candidatesKey: String(routeKey),
    allCandidates: allCandidates.map((candidate) => ({
      ...candidateSummary(candidate),
      label: candidate._outcome?.label || candidate._extraLabel || candidate._profile.label,
    })),
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
    // The smallest key still in the heap. Dijkstra needs it to drop stale
    // entries and to know the distance it has settled up to.
    get topKey() { return n ? keys[0] : Infinity; },
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

// The graph ships gzipped: 32 MB on the wire, 94 MB in memory. Unpacking it
// where it is used costs the UI thread nothing, and the UI thread is what
// raises the keyboard -- doing it in the page meant a rider who tapped the
// search box during startup waited seconds for it to appear.
//
// A caller that has already unpacked the container (every test does, and so
// does a server that decoded Content-Encoding for us) still takes the
// synchronous path below, so `ready` is posted before onmessage returns.
const GZIP_MAGIC = 0x1f8b;
function isGzip(buffer) {
  if (!buffer || buffer.byteLength < 2) return false;
  const head = new Uint8Array(buffer, 0, 2);
  return ((head[0] << 8) | head[1]) === GZIP_MAGIC;
}
async function gunzip(buffer) {
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}
function receiveGraph(buffer) {
  postMessage({ type: 'progress', phase: 'engine', detail: 'Reading the statewide routing map…' });
  loadGraph(buffer);
  postMessage({ type: 'ready', nodes: N, edges: E });
}

onmessage = (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'graph') {
      if (!isGzip(m.buffer)) { receiveGraph(m.buffer); return; }
      postMessage({ type: 'progress', phase: 'engine',
        detail: 'Unpacking road, trail, ferry, and elevation data…' });
      gunzip(m.buffer)
        .then((raw) => receiveGraph(raw))
        .catch((e) => postMessage({ type: 'error', message: `graph: ${e && e.message || e}` }));
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
      // Everything that can change the portfolio goes into the signature.
      const signature = JSON.stringify([pts, m.rules, !!m.forceDesignated,
        !!m.forceResidential, m.weights || null, m.blocks || null]);
      const result = withRoadBlocks(m.blocks, m.rules, () => routeOptions(pts, m.rules,
        !!m.forceDesignated, !!m.forceResidential, m.preferredProfileId, !!m.debug, progress,
        signature));
      postMessage({ type: 'route-options', id: m.id, ...result });
    } else if (m.type === 'route-candidate') {
      // Full geometry for one candidate the "More" screen listed. Served from
      // the portfolio cache, so this is a lookup rather than a second search.
      const cached = lastCandidatesKey === m.candidatesKey && lastCandidates
        ? lastCandidates.get(m.profileId) : null;
      postMessage(cached
        ? { type: 'route-candidate', id: m.id, ok: true,
            option: { ...publicCandidate(cached),
              optimization: { ...publicCandidate(cached).optimization,
                label: cached._outcome?.label || cached._extraLabel
                  || cached._profile.label } } }
        : { type: 'route-candidate', id: m.id, ok: false,
            reason: 'That route is no longer available — the map or your rules changed.' });
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
