/*
 * Client-side bike router v2. A* over the prebuilt graph (maps/washington/graph2.bin.gz,
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
// Format 13, stored-unused (see the parse-site note): per-edge extras and
// width, plus the turn-restriction and ramp-destination trailers.
let eExtras, eWidth, rViaNode, rFromEdge, rToEdge, rKind, destEdge, destName;
// Format 12 only. Which inventory a count came from; a format 11 graph carries
// only the older single "from the state" bit, handled below.
let eAdtSource;

let eHazAB, eHazBA, eHazStartAB, eHazEndAB, eHazStartBA, eHazEndBA, eOff, eCnt;
let outStart, outTarget, outEdge, gLon, gLat;
let eName, nameOff, nameBytes;
let eBearingA, eBearingB;
// Derived from the existing graph topology at load time. No state-specific
// data or graph-format change is needed: this marks only the narrow pattern
// where protected bike space feeds into a tiny one-way sharrow connector on a
// tertiary-or-larger road, then returns to protected space.
let eFacilityGap;
let searchDist, searchPrevArc, searchStamp, searchGeneration = 0;
let nodeHasLand;
// Traffic control (a signal or all-way stop) at or within a few metres of the
// node, derived at load from edgeLimitedDir bits 2/3 -- see the crossing
// penalty at uncontrolledCrossPenaltyS. Zero controlled nodes means a graph
// built before the bits existed; the penalty stands down entirely then rather
// than treating every signalised crossing in the state as uncontrolled.
let nodeControlled = null, nodeControlledCount = 0;
let inGiant;
// Partition-composite sidecars. An ordinary graph leaves these null and keeps
// the historical one-state behavior.
let eStateIndex = null, ePartitionIndex = null;
let graphStateIds = [], loadedPartitionIds = [];
let graphPartitionRanges = [];
let loadedGraphInputBytes = 0, partitionGraphDiagnostics = null;
let allowDisconnectedSnaps = false;
// Nodes where the loaded composite reaches a validated portal into detail that
// is not resident yet. A route request records only frontiers whose admissible
// lower bound can still compete with its found route.
let configuredFrontiers = new Map();
let requestFrontierHits = new Map();
// True while a sub-search runs between interior nodes of an existing candidate
// (ferry land-section refinement). Its portal observations are section-scale:
// merged into the request's hits, a few-kilometre lower bound was compared
// against the whole trip's worst option time, and the coordinator chased
// partitions far off the corridor. Only a request leg records request hits.
let suppressFrontierHitRecording = false;
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
// The walked sidewalk escape (field direction, 2026-08-27): a route that
// starts or ends ON a failing road gets its first/last block on foot. The
// rider walks to the door and locks up anyway, so a failing edge that
// touches a node within 150 ft of the leg's own endpoint — and that has a
// sidewalk to walk on — is priced as WALKING (V_DISMOUNT, no fail
// multipliers) and reported as a caution-level dismount stretch rather
// than failing mileage. "Has a sidewalk" is the tagged present bit, or
// Census-urban context without an explicit sidewalk=no: OSM sidewalk
// tagging reaches only 23.5% of failing edges statewide, while urban
// arterials nearly always have one — the explicit-no bit still blocks the
// true negatives. Walking is slow (0.87 s/m), so the escape is
// self-limiting: any rideable alternative beats it on price, and it can
// never leak a mid-route shortcut because only the endpoint neighborhood
// qualifies. Both radius and edge cap sit far inside the requireSafe
// access exemption above, so a walk-access edge is always already
// admitted to a fully-matching search.
const WALK_ACCESS_RADIUS_M = 46;    // 150 ft around each leg endpoint
const WALK_ACCESS_EDGE_MAX_M = 120; // about one city block
// The positional half (near a leg endpoint) lives in routeLeg; this half is
// pure edge fact: short, walkable-beside (never a freeway or ferry), and
// carrying a sidewalk to walk on. Callers gate on the failing verdict
// themselves.
function walkAccessGate(ei) {
  return eLen[ei] <= WALK_ACCESS_EDGE_MAX_M && !(eFlags[ei] & (4 | 32))
    && ((eOfficial[ei] & EDGE_SIDEWALK)
      || ((eOfficial[ei] & (EDGE_URBAN | EDGE_SIDEWALK_NO)) === EDGE_URBAN));
}
// A failing edge this short, between passing neighbors, is a road CROSSING —
// the few meters of a busy road's own pavement at a signal or trail crossing —
// not riding along the failing road. Crossings are never rule violations.
const CROSSING_MAX_M = 40;
// A fully-matching search provisionally admits short failing edges because a
// crossing can span graph fragments. If the reconstructed movement is not a
// valid crossing, retry with those fragments blocked. Bound the retries so a
// pathological graph cannot turn one request into an unbounded search loop.
const CROSSING_RETRY_LIMIT = 8;
// A direct cycleway crossing is normal bicycle connectivity. The dangerous
// pattern reported at the University Bridge is different: protected space
// ends, the rider enters a one-way shared traffic lane on a through road, and
// protected space resumes almost immediately. Keep the definition narrow so
// ordinary bike-lane-to-bike-lane crossings (including Aurora) are not swept
// in merely because they cross a large road.
const FACILITY_GAP_MAX_EDGE_M = 55;
const FACILITY_GAP_MAX_RUN_M = 180;
const FACILITY_GAP_CONNECTOR_MAX_EDGE_M = 40;
const FACILITY_GAP_CONNECTOR_MAX_RUN_M = 50;
const FACILITY_GAP_MIN_ROAD_CLASS = 4; // tertiary or larger
const FACILITY_GAP_ENTRY_PENALTY_S = 120;
const FACILITY_GAP_PENALTY_S_PER_M = 3;
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

function edgeJurisdiction(i) {
  const stateIndex = eStateIndex ? eStateIndex[i] : 0;
  const partitionIndex = ePartitionIndex ? ePartitionIndex[i] : -1;
  const range = partitionIndex >= 0 ? graphPartitionRanges[partitionIndex] : null;
  return {
    stateId: graphStateIds[stateIndex] || null,
    partitionId: partitionIndex >= 0 ? (loadedPartitionIds[partitionIndex] || null) : null,
    localEdgeIndex: range && i >= range.edgeStart ? i - range.edgeStart : i,
  };
}

function routeJurisdictionFields(segs) {
  const jurisdictions = [];
  const stateIds = [], partitionIds = [];
  for (let index = 0; index < segs.length; index++) {
    const seg = segs[index];
    if (seg.stateId && !stateIds.includes(seg.stateId)) stateIds.push(seg.stateId);
    if (seg.partitionId && !partitionIds.includes(seg.partitionId)) partitionIds.push(seg.partitionId);
    let run = jurisdictions[jurisdictions.length - 1];
    if (!run || run.stateId !== seg.stateId) {
      run = { stateId: seg.stateId || null, edgeStart: index, edgeEnd: index,
        coordStart: seg.c0, coordEnd: seg.c1, distM: 0, partitionIds: [] };
      jurisdictions.push(run);
    }
    run.edgeEnd = index;
    run.coordEnd = seg.c1;
    run.distM += Number(seg.lenM) || 0;
    if (seg.partitionId && !run.partitionIds.includes(seg.partitionId)) {
      run.partitionIds.push(seg.partitionId);
    }
  }
  return { jurisdictions, stateIds, partitionIds };
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
  const hasExtras = magic === 0x42475244;
  const hasAdtSource = magic === 0x42475243 || hasExtras;
  const hasMeasures = magic === 0x42475242 || hasAdtSource;
  const hasTrafficStress = magic === 0x42475241 || hasMeasures;
  if (magic !== 0x42475239 && !hasTrafficStress) {
    throw new Error('bad graph magic (want BGR9, BGRA, BGRB, BGRC or BGRD)');
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
  // Format 13: collected for the 50-state build, priced and displayed by
  // NOTHING yet -- parsed and held so the day a consumer appears is an app
  // release, not fifty graph rebuilds. eSurface additionally carries the
  // OSM smoothness rank in its high nibble from this format on, which is
  // why every surface read masks the low nibble.
  eExtras = hasExtras ? u8(E) : null;
  eWidth = hasExtras ? u8(E) : null;
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
  // Format 13 trailer: node-via turn restrictions and ramp destinations.
  // Held, not consulted -- see the eExtras note above.
  rViaNode = rFromEdge = rToEdge = rKind = destEdge = destName = null;
  if (hasExtras) {
    pad4();
    const restrictionCount = dv.getUint32(o, true); o += 4;
    rViaNode = u32(restrictionCount);
    rFromEdge = u32(restrictionCount);
    rToEdge = u32(restrictionCount);
    rKind = u8(restrictionCount);
    pad4();
    const destinationCount = dv.getUint32(o, true); o += 4;
    destEdge = u32(destinationCount);
    destName = u32(destinationCount);
  }
  // DEM nodata and bathymetry poison a handful of pier and terminal nodes
  // with impossible depths (-2,973 m in the released Washington graph), and
  // the 100 m pier edge that climbs back out carries thousands of metres of
  // invented ascent -- a Kirkland-Tacoma ferry route reported 9,022 ft of
  // climb from one such node. No US land sits below -100 m (Death Valley is
  // -86 m), so anything deeper is repaired from a sane neighbor and the
  // incident edges' ascent/descent rebuilt from the endpoint delta. The same
  // repair lives in partition-runtime.js for the partition session.
  {
    const bogus = new Set();
    for (let n = 0; n < N; n++) if (nodeEle[n] < -100) bogus.add(n);
    for (let pass = 0; pass < 3 && bogus.size; pass++) {
      for (const n of [...bogus]) {
        for (let d = outStart[n]; d < outStart[n + 1]; d++) {
          const other = outTarget[d];
          if (nodeEle[other] >= -100) { nodeEle[n] = nodeEle[other]; bogus.delete(n); break; }
        }
      }
    }
    for (const n of bogus) nodeEle[n] = 0;
    let repairedEdges = 0;
    for (let i = 0; i < E; i++) {
      const delta = nodeEle[eB[i]] - nodeEle[eA[i]];
      // An impossible stored climb (steeper than 1:1 over a real distance)
      // can only come from a poisoned sample; endpoint truth replaces it.
      if ((eAsc[i] > 100 && eAsc[i] > eLen[i]) || (eDes[i] > 100 && eDes[i] > eLen[i])) {
        // Shallower poison (a -78 m node passes the depth test) can leave
        // even the endpoint delta impossible; nothing climbs steeper than
        // 1:1, so the edge's own length caps it.
        const cap = Math.floor(eLen[i]);
        eAsc[i] = Math.min(Math.max(0, delta), cap);
        eDes[i] = Math.min(Math.max(0, -delta), cap);
        repairedEdges++;
      }
    }
    if (repairedEdges) console.log(`Repaired ${repairedEdges} edges with impossible elevation.`);
  }
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
  // Identify short protected-space interruptions from topology, rather than
  // guessing from a route's visual U-turn. A legitimate switchback stays
  // untouched. The core must be a short one-way SHARED-LANE run on a through
  // road. It may connect to protected space through up to 50 m of ordinary
  // road fragments: OSM splits the University Bridge movement into the shared
  // lane, two pieces across Eastlake, NE 40th, and Cowlitz Road. The extended
  // form must include a major-road fragment, which keeps ordinary
  // bike-lane-to-bike-lane crossings (including Aurora) out.
  const protectedNode = new Uint8Array(N);
  for (let i = 0; i < E; i++) {
    if ((eFlags[i] & (4 | 32)) || isDismountEdge(i)) continue;
    if ((eFlags[i] & 8) || edgeFacilityBest(i) >= 4) {
      protectedNode[eA[i]] = 1;
      protectedNode[eB[i]] = 1;
    }
  }
  const candidateEdges = [];
  const candidatesAtNode = new Map();
  for (let i = 0; i < E; i++) {
    const flags = eFlags[i];
    if ((flags & (4 | 8 | 32)) || !(flags & 16) || isDismountEdge(i)) continue;
    if (edgeFacilityBest(i) !== 1 || eClass[i] < FACILITY_GAP_MIN_ROAD_CLASS
        || eLen[i] > FACILITY_GAP_MAX_EDGE_M) continue;
    candidateEdges.push(i);
    for (const node of [eA[i], eB[i]]) {
      const beside = candidatesAtNode.get(node);
      if (beside) beside.push(i);
      else candidatesAtNode.set(node, [i]);
    }
  }
  // Only index ordinary connector edges close to a core candidate. Building a
  // statewide node-to-road map here would duplicate the graph adjacency and
  // cost phones a large amount of memory. Two bounded expansion passes cover
  // the field case while keeping this index tiny and one-time.
  let connectorFrontier = new Set();
  for (const i of candidateEdges) {
    connectorFrontier.add(eA[i]);
    connectorFrontier.add(eB[i]);
  }
  const connectorEdges = new Set();
  const connectorEligible = (i) => {
    const flags = eFlags[i];
    return !(flags & (4 | 8 | 32)) && !isDismountEdge(i)
      && edgeFacilityBest(i) === 0 && eClass[i] > 0 && eClass[i] <= 6
      && eLen[i] <= FACILITY_GAP_CONNECTOR_MAX_EDGE_M;
  };
  for (let hop = 0; hop < 2 && connectorFrontier.size; hop++) {
    const nextFrontier = new Set();
    for (let i = 0; i < E; i++) {
      if (!connectorEligible(i)
          || (!connectorFrontier.has(eA[i]) && !connectorFrontier.has(eB[i]))) continue;
      connectorEdges.add(i);
      nextFrontier.add(eA[i]);
      nextFrontier.add(eB[i]);
    }
    connectorFrontier = nextFrontier;
  }
  const connectorsAtNode = new Map();
  for (const i of connectorEdges) {
    for (const node of [eA[i], eB[i]]) {
      const beside = connectorsAtNode.get(node);
      if (beside) beside.push(i);
      else connectorsAtNode.set(node, [i]);
    }
  }
  eFacilityGap = new Uint8Array(E);
  const visitedCandidates = new Set();
  for (const seed of candidateEdges) {
    if (visitedCandidates.has(seed)) continue;
    const component = [], protectedEnds = new Set(), queue = [seed];
    let runM = 0;
    while (queue.length) {
      const i = queue.pop();
      if (visitedCandidates.has(i)) continue;
      visitedCandidates.add(i);
      component.push(i);
      runM += eLen[i];
      for (const node of [eA[i], eB[i]]) {
        if (protectedNode[node]) protectedEnds.add(node);
        for (const next of candidatesAtNode.get(node) || []) {
          if (!visitedCandidates.has(next)) queue.push(next);
        }
      }
    }
    if (runM > FACILITY_GAP_MAX_RUN_M) continue;

    // Find protected endpoints through no more than two very short ordinary
    // road fragments. This is deliberately local and distance-bounded: it is
    // a connector test, not a search for any trail somewhere down the street.
    const connectorPaths = new Map();
    for (const startNode of new Set(component.flatMap((i) => [eA[i], eB[i]]))) {
      const queue = [{ node: startNode, metres: 0, path: [], major: false }];
      const bestAtNode = new Map([[startNode, 0]]);
      while (queue.length) {
        const state = queue.shift();
        if (state.metres > 0 && protectedNode[state.node]) {
          const known = connectorPaths.get(state.node);
          if (!known || state.metres < known.metres) connectorPaths.set(state.node, state);
          continue;
        }
        if (state.path.length >= 2) continue;
        for (const edge of connectorsAtNode.get(state.node) || []) {
          if (state.path.includes(edge)) continue;
          const node = eA[edge] === state.node ? eB[edge] : eA[edge];
          const metres = state.metres + eLen[edge];
          if (metres > FACILITY_GAP_CONNECTOR_MAX_RUN_M
              || metres >= (bestAtNode.get(node) ?? Infinity)) continue;
          bestAtNode.set(node, metres);
          queue.push({ node, metres, path: [...state.path, edge],
            major: state.major || eClass[edge] >= 6 });
        }
      }
    }
    const connectedProtected = new Set(protectedEnds);
    for (const node of connectorPaths.keys()) connectedProtected.add(node);
    const extendedMajorCrossing = [...connectorPaths.values()].some((path) => path.major)
      && component.some((i) => eClass[i] >= 6);
    // It must be a brief interruption bounded by protected bike space, not a
    // long sharrow corridor that merely begins beside a trail. Directly
    // bounded gaps preserve the original narrow rule; connector-assisted gaps
    // additionally require a major-road crossing.
    if (connectedProtected.size >= 2
        && (protectedEnds.size >= 2 || extendedMajorCrossing)) {
      for (const i of component) eFacilityGap[i] = 1;
      for (const path of connectorPaths.values()) {
        for (const i of path.path) eFacilityGap[i] = 1;
      }
    }
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
  nodeControlled = new Uint8Array(N);
  nodeControlledCount = 0;
  for (let i = 0; i < E; i++) {
    const ld = eLimitedDir[i];
    if ((ld & 4) && !nodeControlled[eA[i]]) { nodeControlled[eA[i]] = 1; nodeControlledCount++; }
    if ((ld & 8) && !nodeControlled[eB[i]]) { nodeControlled[eB[i]] = 1; nodeControlledCount++; }
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
}

const R = 6371000;
function havM(lon1, lat1, lon2, lat2) {
  const p1 = (lat1 * Math.PI) / 180, p2 = (lat2 * Math.PI) / 180;
  const dp = p2 - p1, dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Snap to the nearest EDGE, not the nearest node. Nodes are sparse on long
// straight ways -- a rider standing ON the Interurban Trail snapped to a
// street-side stub 9 m away (its only edge a dismount link) because the
// trail's nearest NODE was far along the path, and the route then left on
// the street and looped back to the trail it started beside (field report:
// "something badly wrong with this route"). Distance is measured to the
// stored edge geometry, the road-block matcher's method; the snap lands on
// the edge's nearer endpoint along that geometry. The local-over-freeway
// preference (>300 m extra before the absolute nearest wins -- a tap beside
// I-90 should not board I-90) and the MTB filter keep their semantics,
// applied per edge instead of per node.
function nearestNode(lon, lat, rules = null, exclude = null, localOnly = false) {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110540;
  const allowMtb = !!(rules && rules.allowMtbTrails);
  let anyNode = -1, anyDm = Infinity;      // nearest of any kind
  let localNode = -1, localDm = Infinity;  // nearest usable local-network edge
  for (let ei = 0; ei < E; ei++) {
    if (!allowDisconnectedSnaps && !inGiant[eA[ei]]) continue; // ordinary graph: skip fragments
    const start = eOff[ei], count = eCnt[ei];
    if (count < 2) continue;
    // The edge cannot come closer than its first geometry point's distance
    // minus its own length; that lower bound skips almost everything once
    // the running minima are small.
    let px = (gLon[start] - lon) * kx, py = (gLat[start] - lat) * ky;
    const reachable = Math.sqrt(px * px + py * py) - eLen[ei];
    if (reachable > anyDm && reachable > localDm) continue;
    let bestSegD = Infinity, alongAtBest = 0, cum = 0;
    for (let i = start + 1; i < start + count; i++) {
      const qx = (gLon[i] - lon) * kx, qy = (gLat[i] - lat) * ky;
      const dx = qx - px, dy = qy - py;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(px * dx + py * dy) / len2)) : 0;
      const nx = px + t * dx, ny = py + t * dy;
      const d = Math.sqrt(nx * nx + ny * ny);
      const segLen = Math.sqrt(len2);
      if (d < bestSegD) { bestSegD = d; alongAtBest = cum + t * segLen; }
      cum += segLen;
      px = qx; py = qy;
    }
    if (!(bestSegD < anyDm) && !(bestSegD < localDm)) continue;
    const node = alongAtBest * 2 <= cum ? eA[ei] : eB[ei];
    // Pocket re-snap: an edge whose snap node sits inside the excluded
    // directional pocket cannot be the answer; the next-nearest edge is.
    if (exclude && exclude.has(node)) continue;
    if (bestSegD < anyDm) { anyDm = bestSegD; anyNode = node; }
    const hasLegalDirection = eSh[ei] !== PROHIBITED_SHOULDER
      || (!(eFlags[ei] & 16) && eShBA[ei] !== PROHIBITED_SHOULDER);
    const isLocal = hasLegalDirection && !(eFlags[ei] & (4 | 32))
      && (allowMtb || !(eOfficial[ei] & EDGE_MTB));
    if (isLocal && bestSegD < localDm) { localDm = bestSegD; localNode = node; }
  }
  // localOnly: the pocket re-snap may only land on an edge of the class the
  // search can actually enter -- a legal-direction, non-MTB (unless opted
  // in), non-ferry, non-freeway edge -- whatever the distance. The ordinary
  // +300 m preference below still lets a nearby ramp or trail win, which is
  // exactly what a re-snap must not repeat.
  if (localOnly) return { node: localNode, distM: localDm };
  if (localNode >= 0 && localNode !== anyNode && localDm <= anyDm + 300) {
    return { node: localNode, distM: localDm };
  }
  return { node: anyNode, distM: anyDm };
}

/* ------------------------------------------ directional-pocket snapping */
// A tap can land on an edge you can legally LEAVE but never ENTER: freeway
// ramps, downhill-only MTB runs, a base behind its gates. The undirected
// giant-component check above cannot see these -- the pocket is connected,
// by arcs pointing out -- so the snap succeeded, the search explored the
// whole graph, and the rider was told "no route exists between these
// points", which is false: a reachable point sits metres away (audit C1;
// 470 Washington pockets and 157 Oregon, the largest 255 nodes). Everything
// here runs only AFTER a search has already failed, so the routine case
// pays nothing.

// The set of nodes that can reach `node` (or that `node` can reach, when
// `forward`). A real destination is reachable from essentially the whole
// state, so a search that EXHAUSTS under the cap has proven the node sits in
// a small directional pocket -- and the visited set is exactly that pocket.
const POCKET_NODE_CAP = 4000;
// Transient reverse adjacency: a counting sort over the arc table. Built only
// on the failure path and released with its caller, so the graph never
// carries a second adjacency in memory.
function buildReverseAdjacency() {
  const D = outTarget.length;
  const inOff = new Uint32Array(N + 1);
  for (let a = 0; a < D; a++) inOff[outTarget[a] + 1]++;
  for (let n = 0; n < N; n++) inOff[n + 1] += inOff[n];
  const inFrom = new Uint32Array(D);
  const inEdge = new Uint32Array(D);
  const cursor = inOff.slice(0, N + 1);
  for (let u = 0; u < N; u++) {
    for (let a = outStart[u]; a < outStart[u + 1]; a++) {
      const at = cursor[outTarget[a]]++;
      inFrom[at] = u;
      inEdge[at] = outEdge[a];
    }
  }
  return { inOff, inFrom, inEdge };
}
// The walk honors the SAME admission gates the search applies -- permanent
// prohibition, MTB opt-in, freeways, ferries -- because "enterable" only
// means anything in the graph the search is allowed to traverse. A
// structurally reachable node behind an illegal arc is still a refusal.
function directionalPocket(node,
  { forward = false, reverseIndex = null, rules = null } = {}) {
  if (!(node >= 0)) return null;
  const index = forward ? null : (reverseIndex || buildReverseAdjacency());
  const legal = (ei, src) => {
    const fwd = eA[ei] === src;
    if (edgeShoulder(ei, fwd) === PROHIBITED_SHOULDER) return false;
    if (rules) {
      if (!rules.allowMtbTrails && (eOfficial[ei] & EDGE_MTB)) return false;
      if (!rules.allowFreeways && (eFlags[ei] & 4)) return false;
      if (rules.allowFerries === false && (eFlags[ei] & 32)) return false;
    }
    return true;
  };
  const visited = new Set([node]);
  const queue = [node];
  for (let qi = 0; qi < queue.length; qi++) {
    const u = queue[qi];
    const lo = forward ? outStart[u] : index.inOff[u];
    const hi = forward ? outStart[u + 1] : index.inOff[u + 1];
    for (let a = lo; a < hi; a++) {
      const v = forward ? outTarget[a] : index.inFrom[a];
      if (visited.has(v)) continue;
      const ei = forward ? outEdge[a] : index.inEdge[a];
      if (!legal(ei, forward ? u : v)) continue;
      visited.add(v);
      if (visited.size > POCKET_NODE_CAP) return null; // escaped: not a pocket
      queue.push(v);
    }
  }
  return visited;
}

// When a leg finds no route, test whether an endpoint is the reason: a
// destination nothing can enter, or a start nothing can leave. Re-snap the
// guilty endpoint to the nearest edge OUTSIDE its pocket -- which is the
// place the rider's tap meant -- writing the correction into the shared snap
// object so every later profile in the same request routes with it directly.
function adjustPocketSnaps(s, t, startLL, endLL, rules) {
  let adjusted = false;
  let reverseIndex = null;
  const resnap = (snap, ll, forward) => {
    const opts = forward ? { forward, rules } : { rules, reverseIndex:
      (reverseIndex ||= buildReverseAdjacency()) };
    const exclude = directionalPocket(snap.node, opts);
    if (!exclude) return;
    // An MTB network or ramp braid is a COMPLEX of adjacent pockets; merge
    // each one the re-snap lands in and try again until an enterable edge
    // wins or the neighborhood is exhausted. localOnly keeps every attempt
    // on the edge class the search is allowed to traverse.
    for (let attempt = 0; attempt < 12; attempt++) {
      const next = nearestNode(ll[0], ll[1], rules, exclude, true);
      if (!(next.node >= 0)) return;
      const nested = directionalPocket(next.node, opts);
      if (!nested) {
        snap.node = next.node;
        snap.pocketAdjustedM = Math.round(next.distM);
        snap.distM = next.distM;
        adjusted = true;
        return;
      }
      for (const n of nested) exclude.add(n);
    }
  };
  resnap(t, endLL, false);
  resnap(s, startLL, true);
  return adjusted;
}

const ROAD_BLOCK_NEARBY_M = 16;

function roadBlockEdgeSet(points) {
  if (!Array.isArray(points) || !points.length) return null;
  const blocks = [];
  for (const entry of points) {
    const point = Array.isArray(entry) ? entry : entry?.point;
    if (!Array.isArray(point) || point.length < 2) continue;
    const lon = Number(point[0]), lat = Number(point[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    blocks.push({
      lon, lat,
      metersPerLon: 111_320 * Math.cos(lat * Math.PI / 180),
      ferryName: typeof entry?.ferryName === 'string' ? entry.ferryName.trim() : '',
    });
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
  // A ferry service can have separate outbound and return tracks hundreds of
  // feet apart. A point-only roadblock excluded one track and let the router
  // switch to the same boat in the other direction. The map supplies the
  // tapped service name, so exclude every graph edge of that named ferry while
  // leaving all other ferry services available.
  const ferryNames = new Set(blocks.map((block) => block.ferryName).filter(Boolean));
  if (ferryNames.size) {
    for (let edge = 0; edge < E; edge++) {
      if ((eFlags[edge] & 32) && ferryNames.has(edgeName(edge))) blocked.add(edge);
    }
  }
  return blocked.size ? blocked : null;
}

/* ---------------- per-route Preferred (Settings -> Routes / the tap card) */
// The rider can mark individual signed routes Preferred. The graph stores
// only an anonymous on-a-signed-route bit (flag 64), never which route, so
// the main thread sends the chosen routes' geometry from the bikeroutes
// overlay and the edges are matched here, once per selection. The selection
// key rides in `rules.preferredRoutes`, so every cost, bound, and portfolio
// signature already distinguishes selections; the key match below is what
// keeps a search honest if it ever races the geometry message.
let preferredEdges = null;      // Uint8Array(E): 1 = edge of a Preferred route
let preferredRoutesKey = '';    // the selection the set was built for

// A rider can switch off a whole non-OSM route source -- a county's bike map,
// a state's scenic bikeways -- and have it stop counting as a designated route
// for both drawing and routing.
//
// The graph cannot answer this on its own. Reviewed supplemental sources are
// stamped into eFlags bit 64 at build time, the SAME bit OSM relations use, and
// nothing records which source stamped an edge. So the suppressed set is
// re-derived at runtime from the published linework, using the same matcher
// that applies a Preferred route.
let suppressedRouteEdges = null;  // Uint8Array(E): 1 = designation suppressed
let suppressedRoutesKey = '';     // the suppression the set was built for

// THE one question "is this edge a designated route" -- every read of bit 64
// goes through here, with one deliberate exception noted at
// receiveSuppressedRoutes. Two of the callers are the cost/floor pair that A*
// requires to agree: if edgeCostParts thinks an edge is designated and
// edgeCostFloor does not, the search's lower bound stops being a lower bound
// and routing breaks quietly rather than loudly.
function designatedEdge(ei, fl) {
  if (!(fl & 64)) return false;
  return !(suppressedRouteEdges !== null && suppressedRouteEdges[ei] === 1);
}

// Match published linework to graph edges by overlap AND bearing. Proximity
// alone makes a parallel frontage road inherit the route, and a single shared
// point makes a crossing road inherit it. Requiring most of an edge's stored
// length to run near and parallel to the source avoids both. The build-time
// supplemental-route stamper evaluates this same function against every edge;
// Preferred-route changes evaluate only the already-designated candidates.
function matchRouteLines(lines, eligibleEdge = () => true) {
  if (!Array.isArray(lines) || !lines.length || !E) return new Uint8Array(E || 0);
  const TOL_M = 30;
  const CELL_DEG = 0.005;
  const PAD_DEG = 0.0006; // wider than TOL_M in degrees at mid latitudes
  const MIN_OVERLAP = 0.8;
  const MIN_PARALLEL_COS = Math.cos(35 * Math.PI / 180);
  const grid = new Map(); // "x,y" cell -> flat [lon0, lat0, lon1, lat1, ...]
  for (const line of lines) {
    if (!Array.isArray(line)) continue;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i];
      const lon0 = Number(a?.[0]), lat0 = Number(a?.[1]);
      const lon1 = Number(b?.[0]), lat1 = Number(b?.[1]);
      if (!Number.isFinite(lon0) || !Number.isFinite(lat0)
        || !Number.isFinite(lon1) || !Number.isFinite(lat1)) continue;
      const xMin = Math.floor((Math.min(lon0, lon1) - PAD_DEG) / CELL_DEG);
      const xMax = Math.floor((Math.max(lon0, lon1) + PAD_DEG) / CELL_DEG);
      const yMin = Math.floor((Math.min(lat0, lat1) - PAD_DEG) / CELL_DEG);
      const yMax = Math.floor((Math.max(lat0, lat1) + PAD_DEG) / CELL_DEG);
      for (let x = xMin; x <= xMax; x++) {
        for (let y = yMin; y <= yMax; y++) {
          const cell = `${x},${y}`;
          let bucket = grid.get(cell);
          if (!bucket) grid.set(cell, bucket = []);
          bucket.push(lon0, lat0, lon1, lat1);
        }
      }
    }
  }
  if (!grid.size) return new Uint8Array(E);
  const tolSq = TOL_M * TOL_M;
  const segmentOnRoute = (lon0, lat0, lon1, lat1) => {
    const lon = (lon0 + lon1) / 2, lat = (lat0 + lat1) / 2;
    const bucket = grid.get(`${Math.floor(lon / CELL_DEG)},${Math.floor(lat / CELL_DEG)}`);
    if (!bucket) return false;
    const metersPerLon = 111_320 * Math.cos(lat * Math.PI / 180);
    const edgeDx = (lon1 - lon0) * metersPerLon;
    const edgeDy = (lat1 - lat0) * 110_540;
    const edgeSpan = Math.hypot(edgeDx, edgeDy);
    if (!(edgeSpan > 0)) return false;
    for (let s = 0; s < bucket.length; s += 4) {
      const ax = (bucket[s] - lon) * metersPerLon, ay = (bucket[s + 1] - lat) * 110_540;
      const bx = (bucket[s + 2] - lon) * metersPerLon, by = (bucket[s + 3] - lat) * 110_540;
      const dx = bx - ax, dy = by - ay;
      const spanSq = dx * dx + dy * dy;
      if (!spanSq) continue;
      const parallel = Math.abs(edgeDx * dx + edgeDy * dy)
        / (edgeSpan * Math.sqrt(spanSq));
      if (parallel < MIN_PARALLEL_COS) continue;
      const t = spanSq ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / spanSq)) : 0;
      const px = ax + t * dx, py = ay + t * dy;
      if (px * px + py * py <= tolSq) return true;
    }
    return false;
  };
  const set = new Uint8Array(E);
  for (let ei = 0; ei < E; ei++) {
    if (!eligibleEdge(ei)) continue;
    const start = eOff[ei], count = eCnt[ei];
    let totalM = 0, matchedM = 0;
    for (let i = start; i + 1 < start + count; i++) {
      const lon0 = gLon[i], lat0 = gLat[i], lon1 = gLon[i + 1], lat1 = gLat[i + 1];
      const metresLon = 111_320 * Math.cos((lat0 + lat1) * Math.PI / 360);
      const length = Math.hypot((lon1 - lon0) * metresLon, (lat1 - lat0) * 110_540);
      totalM += length;
      if (segmentOnRoute(lon0, lat0, lon1, lat1)) matchedM += length;
    }
    if (totalM > 0 && matchedM / totalM >= MIN_OVERLAP) set[ei] = 1;
  }
  return set;
}

// `lines` is the linework of routes whose EVERY source the rider switched off.
// `keepLines` is the linework of every route still standing. The subtraction is
// the whole point, and it is not the same protection the caller already
// applies. app.js keeps a route whose NAME is claimed by a surviving source as
// well; this keeps a stretch of PAVEMENT that a differently-named surviving
// route runs down. Measured, switching Oregon's Scenic Bikeways off without it
// takes 1,505 edges off the TransAmerica Trail and 73 off the Oregon Coast
// Scenic Bikeway -- separate OSM relations sharing road with a bikeway.
// Washington's Island County map costs 103 edges the same way.
//
// The keep pass is restricted to edges the suppressed pass already matched, and
// matchRouteLines tests eligibility before it touches geometry, so the second
// call costs a fraction of the first however large the kept catalogue is.
function receiveSuppressedRoutes(key, lines, keepLines) {
  suppressedRoutesKey = String(key || '');
  suppressedRouteEdges = null;
  if (!suppressedRoutesKey || !Array.isArray(lines) || !lines.length || !E) {
    postMessage({ type: 'suppressed-routes-applied', key: suppressedRoutesKey, edges: 0 });
    return;
  }
  // The one place that reads bit 64 raw instead of through designatedEdge():
  // this IS the pass that decides what designatedEdge() will answer, so it has
  // to see every edge the graph stamped, including whatever the previous
  // selection had suppressed.
  const candidate = matchRouteLines(lines, (ei) => !!(eFlags[ei] & 64));
  const kept = Array.isArray(keepLines) && keepLines.length
    ? matchRouteLines(keepLines, (ei) => candidate[ei] === 1) : null;
  let marked = 0;
  for (let ei = 0; ei < candidate.length; ei++) {
    if (kept && kept[ei] === 1) candidate[ei] = 0;
    marked += candidate[ei];
  }
  suppressedRouteEdges = candidate;
  postMessage({ type: 'suppressed-routes-applied', key: suppressedRoutesKey, edges: marked });
}

function receivePreferredRoutes(key, lines) {
  preferredRoutesKey = String(key || '');
  preferredEdges = null;
  if (!preferredRoutesKey || !Array.isArray(lines) || !lines.length || !E) return;
  // Candidates are only edges already flagged as designated-route members.
  // That now includes OSM relations plus reviewed supplemental sources stamped
  // into the graph at build time; the restriction also keeps neighboring roads
  // out of a rider's per-route preference.
  const set = matchRouteLines(lines, (ei) => designatedEdge(ei, eFlags[ei]));
  let marked = 0;
  for (let ei = 0; ei < set.length; ei++) marked += set[ei];
  preferredEdges = set;
  postMessage({ type: 'preferred-routes-applied', key: preferredRoutesKey, edges: marked });
}

function rulesSignature(rules) {
  let out = '';
  for (const key of Object.keys(rules || {}).sort()) {
    if (key === 'requireSafe') continue;
    out += `${key}=${rules[key]};`;
  }
  return out;
}

// Cost-only route-choice lenses belong in rulesSignature() because the arc
// caches and A* potential genuinely change. They do not belong in the verdict
// cache: SafetyModel deliberately ignores them, and throwing away 1.7 million
// directed verdict bytes when the rider toggles one would only add latency.
function safetyRulesSignature(rules) {
  let out = '';
  for (const key of Object.keys(rules || {}).sort()) {
    if (key === 'requireSafe' || key === 'alwaysPreferBikeRoutes'
      || key === 'preferredRoutes' || key === 'suppressedRouteSources') continue;
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

// eFacility packs both directions in one byte: low nibble = the A->B rung,
// high nibble 0 = the same rung both ways (every graph built before the
// split, and any symmetrically tagged road), else the B->A rung + 1. A lane
// painted on one side of a two-way street serves one direction of travel;
// the other direction is just riding the road (field: 37th Avenue NE showed
// "Bike lane" to a rider on the unlaned side).
function edgeFacility(i, forward) {
  const packed = eFacility[i];
  if (forward) return packed & 15;
  const back = packed >> 4;
  return back ? back - 1 : packed & 15;
}

// The better direction — for structural passes with no travel direction
// (facility-gap detection) and for describing the STREET rather than a ride.
function edgeFacilityBest(i) {
  const packed = eFacility[i];
  const back = packed >> 4;
  return Math.max(packed & 15, back ? back - 1 : 0);
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
    infra: !!(flags & 8) || edgeFacility(i, forward) >= 4,
    infraScore: 1,
    facility: edgeFacility(i, forward),
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
  { cache: null, generation: 1, rules: null, key: null, noShoulderMax: 0, failTouch: null },
  { cache: null, generation: 1, rules: null, key: null, noShoulderMax: 0, failTouch: null },
];
function useVerdictSlot(slot, rules) {
  if (!slot.cache) slot.cache = new Uint8Array(2 * E);
  const key = safetyRulesSignature(rules);
  // One value applies to every edge. Cache it per rule set instead of resolving
  // the compatibility keys on every relaxation.
  slot.noShoulderMax = SafetyModel.noShoulderMaxSpeed({}, rules);
  // Dragging a route pin sends the same rules in a new object. Keeping the
  // verdicts across that turns a re-route into forward searching alone.
  if (key !== slot.key) {
    slot.generation = (slot.generation + 1) & 7;
    if (!slot.generation) { slot.cache.fill(0); slot.generation = 1; }
    slot.key = key;
    slot.failTouch = null;
  }
  slot.rules = rules;
  return slot;
}
// Which failing roads touch each node under this rule set: a count of
// distinct failing edges (saturated at 2) plus the first two distinct NAMES
// among them. 2+ edges means a road failing the rider's rules runs THROUGH
// the node -- the topological signature of a crossing (a divided arterial's
// single carriageway alone contributes its arriving and departing edge).
// The names exist because of Stone Way (field, 2026-08-27): a street whose
// bike lane serves one direction FAILS ridden the other way, so its own
// edges put every mid-block node at count 2 -- and the charge then priced
// riding ALONG the trusted lane as one uncontrolled crossing per driveway,
// pushing the suggested route onto a worse parallel street. A crossing must
// involve a failing road that is a DIFFERENT road from the one being
// ridden, and the name is how the penalty tells (two unnamed roads meeting
// go uncharged -- the acceptable miss).
// Lives on the verdict slot: levels are a safety-rules fact, the slot
// already keys and evicts by exactly those, and the identity fast path
// keeps this out of the relaxation loop's budget. The one eager O(E) pass
// warms the slot's verdict bytes it would have computed lazily anyway.
// Freeways are excluded -- their only shared nodes with a surface street
// are ramp mouths, where traffic merges rather than crosses -- and ferries
// never fail.
const FAIL_TOUCH_NO_NAME = 0xFFFFFFFF;
function nodeFailTouch(rules) {
  const slot = verdictSlotFor(rules);
  if (slot.failTouch) return slot.failTouch;
  const count = new Uint8Array(N);
  const name1 = new Uint32Array(N).fill(FAIL_TOUCH_NO_NAME);
  const name2 = new Uint32Array(N).fill(FAIL_TOUCH_NO_NAME);
  for (let i = 0; i < E; i++) {
    if (eFlags[i] & (4 | 32)) continue;
    // Unnamed failing edges are excluded outright: a nameless fragment
    // cannot prove a DIFFERENT road, and counting one made N 34th's unnamed
    // twin carriageway read as a foreign failing road crossing 34th itself
    // (field 🐞 audit, 2026-08-27). A real failing road is a busy arterial,
    // and busy arterials carry names.
    const nm = eName[i];
    if (!nm) continue;
    if (edgeLevelFor(i, rules, true) !== 4 && edgeLevelFor(i, rules, false) !== 4) continue;
    for (const u of [eA[i], eB[i]]) {
      if (count[u] < 2) count[u]++;
      if (name1[u] === FAIL_TOUCH_NO_NAME) name1[u] = nm;
      else if (name1[u] !== nm && name2[u] === FAIL_TOUCH_NO_NAME) name2[u] = nm;
    }
  }
  slot.failTouch = { count, name1, name2 };
  return slot.failTouch;
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
  const key = safetyRulesSignature(rules);
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
// One minute: dismounting is a mode switch, not a disaster. This was six,
// and the flat fee's own comment warned it "hits a thirty-second dock
// approach as hard as a half-mile slog" -- the field then found the
// consequence: an Interurban Trail crossing gate (three edges, 27 m, level
// 1) priced at ~10 minutes with the walk multipliers stacked on, so routes
// LOOPED off the trail and around the gate on failing streets (the lollipop
// at the rider's start). Length judgement belongs to the per-metre
// multipliers below, which is also why 12 minutes here once priced the Pier
// 50 fast ferry out of the Southworth route.
// Only an explicit OSM bicycle=dismount instruction pays the mode-switch
// charge. Synthesised walk links exist because bicycle access was not mapped;
// walking pace and the distance multiplier already price that uncertainty.
const DISMOUNT_ENTRY_PENALTY_S = 60;
// Freeway is a last resort, and "last resort" is a judgment about the DECISION
// to get on one -- not about each metre once you are already there. A flat
// per-metre surcharge has the wrong gradient: it prices a 300 m opportunistic
// hop and a 17 km gorge crossing identically per metre, so the only freeway
// that ever survives is one with no alternative at any price. Cascade Locks to
// Hood River offered 159 km around Mount Hood when a legal 32 km route existed
// on I-84 shoulder; Vantage to Quincy offered 205 km rather than 2.8 km across
// the only Columbia crossing for forty miles. An ENTRY charge inverts the
// gradient -- the shorter the run, the worse it amortises -- which is the rule
// the surcharge was reaching for all along. Modelled on the dismount entry
// charge above, and paid once per contiguous freeway run.
const FREEWAY_ENTRY_PENALTY_S = 1200;
// Search-cost multiplier on the walked time of a dismount stretch (the ETA
// keeps the honest walking time). See the note at its use in edgeCostParts.
// Three tiers by EDGE length: a bollard gate or crossing island (< 25 m)
// costs a shrug, not a detour-off-the-trail; an ordinary walk link keeps the
// doubled field-tuned judgment; and long edges -- how long unrideable trails
// appear in the graph -- price harshest, because a rider bushwhacked one
// once when a router shrugged at it.
const DISMOUNT_GATE_EDGE_M = 25;
const DISMOUNT_GATE_MULT = 3;
const DISMOUNT_WALK_COST_MULT = 8;
const DISMOUNT_LONG_EDGE_M = 100;
const DISMOUNT_LONG_EDGE_MULT = 32;
// A CONTIGUOUS tagged-dismount run longer than this reports as FAILING the
// rules, not merely caution: a gate or a dock approach is a shrug, a real
// stretch of signed trail you cannot ride is a route that failed to be a
// bike route. Runs at or under it stay caution. TAGGED only (`official`
// carries both the pricing bit and the bicycle=dismount tag bit): the walk
// links the graph build synthesises from untagged footways stay amber
// whatever their length -- red at every park connector would teach the
// rider to ignore the red that stands for a real sign. Well above
// CROSSING_MAX_M, so a failing dismount run can never be mistaken for an
// intersection crossing.
const DISMOUNT_FAIL_RUN_M = 100;
const EDGE_DISMOUNT_TAG = 128;
const taggedDismountSeg = (seg) =>
  (seg.official & (EDGE_DISMOUNT | EDGE_DISMOUNT_TAG)) === (EDGE_DISMOUNT | EDGE_DISMOUNT_TAG);

// Walk the finished segment list, find contiguous tagged-dismount runs over
// the threshold, and escalate them from caution to fail -- adjusting the
// level tallies in place and returning the failing meters added. Shared by
// the route builder and the summary rebuilder so the two cannot disagree.
function escalateLongDismounts(segs, levelM) {
  let addedFailM = 0;
  for (let i = 0; i < segs.length;) {
    if (!taggedDismountSeg(segs[i])) { i++; continue; }
    let end = i, runM = 0;
    while (end < segs.length && taggedDismountSeg(segs[end])) { runM += segs[end].lenM; end++; }
    if (runM > DISMOUNT_FAIL_RUN_M) {
      for (let j = i; j < end; j++) {
        const seg = segs[j];
        if (seg.level === 4) continue;
        levelM[seg.level] -= seg.lenM;
        levelM[4] += seg.lenM;
        addedFailM += seg.lenM;
        seg.level = 4;
        seg.cautionCause = null;
        // A per-edge verdict cannot know that adjacent dismount edges form a
        // long run. Carry the named route-level fact so downstream consumers
        // can re-score ordinary safety facts without losing this escalation.
        seg.dismountEscalated = true;
      }
    }
    i = end;
  }
  return addedFailM;
}
// A* heuristic speed: must not undershoot any effective edge speed, including
// fast ferries and the strongest cost bonuses, or A* loses optimality.
// Example at the 2026-08-26 defaults: V_MAX 12 / (0.25 path facility x 0.5
// residential x 0.9 low-stress comfort bonus) = 106.7 m/s; at the slider
// minimums (path 0.1, residential 0.4) the requirement is far higher, which
// is why the bound below is derived from the live weights per search.
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
// A route explicitly marked Preferred gets one strong bonus, never a second
// multiplier stacked on top of its physical facility. Use whichever single
// bonus is stronger: the Preferred value or that edge's trail/lane value. The
// no-edge form is the global lower bound used by the heuristic.
function preferredSignedRouteMult(edge = null, forward = true) {
  const facility = edge == null
    ? Math.min(1, activeWeights.facilityShared, activeWeights.facilityLane,
      activeWeights.facilityBuffered, activeWeights.facilitySeparated,
      activeWeights.facilityPath)
    : facilityPrefMult(edgeFacility(edge, forward));
  return Math.min(activeWeights.preferredRoute, facility);
}

// One semantics for both follow-signed-routes lenses: the global option
// (alwaysPreferBikeRoutes) trusts EVERY signed edge; a per-route Preferred
// (Settings -> Routes) trusts the edges of just the chosen routes. Both are
// routing lenses, not safety verdicts -- the trusted edge is priced like the
// a strong, rider-adjustable corridor bonus, and its actual
// verdict still colors the map and the route.
function trustRouteEdge(ei, fl, rules) {
  if (!designatedEdge(ei, fl) || (fl & 32) || isDismountEdge(ei)) return false;
  if (rules.alwaysPreferBikeRoutes) return true;
  return preferredEdges !== null && preferredEdges[ei] === 1
    && rules.preferredRoutes === preferredRoutesKey;
}
// Whether the per-route lens is live for this rules object -- the heuristic
// needs a global answer where trustRouteEdge answers per edge.
function preferredRoutesActive(rules) {
  return preferredEdges !== null && rules?.preferredRoutes === preferredRoutesKey;
}

// A neutral portfolio lens must remove the scoped trust exception itself.
// Setting its multiplier to 1 is not enough: trusted edges also bypass the
// ordinary road-stress costs. Keep every actual riding rule and global route
// option intact; remove only the selected named-route key.
function withoutPreferredRouteSelection(rules) {
  if (!rules || !Object.prototype.hasOwnProperty.call(rules, 'preferredRoutes')) return rules;
  const neutral = { ...rules };
  delete neutral.preferredRoutes;
  return neutral;
}

function heuristicSpeed(mode, prefResidential, rules = null) {
  const comfy = mode === 'direct' ? 1
    : mode === 'low' ? activeWeights.comfyRoadLowStress : activeWeights.comfyRoadBalanced;
  const level = Math.min(1, comfy);
  // On-street: a facility bonus OR a designation bonus, never both.
  const onStreetBonus = Math.min(1,
    activeWeights.facilityShared, activeWeights.facilityLane,
    activeWeights.facilityBuffered, activeWeights.facilitySeparated,
    activeWeights.strongDesignated,
    (rules?.alwaysPreferBikeRoutes || preferredRoutesActive(rules))
      ? preferredSignedRouteMult() : 1);
  // The residential bonus is always on (2026-08-26); the prefResidential
  // parameter survives in signatures for profile bookkeeping but no longer
  // gates any cost, so the heuristic must assume the bonus everywhere.
  const residential = Math.min(1, activeWeights.residential);
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
  // Field-tuned 2026-08-26 (rider's settled values became the defaults). The
  // old `designated` off-state weight is gone: the signed-route preference is
  // always on, so strongDesignated is THE designation bonus.
  strongDesignated: 0.5, preferredRoute: 0.1, residential: 0.6,
  facilityShared: 0.75, facilityLane: 0.42, facilityBuffered: 0.38,
  facilitySeparated: 0.32, facilityPath: 0.25,
  mtbTrail: 6,
  // Per-metre freeway surcharge, on top of the level-4 multiplier. Calibrated
  // WITH FREEWAY_ENTRY_PENALTY_S against six trips whose right answer is known
  // -- three where the freeway is the only sane link and three where it is an
  // opportunistic hop beside a good parallel. The passing band is 8 to 20: at
  // 60 (the old flat-price value) Vantage -> Quincy still offers 206 km rather
  // than 2.8 km across the only Columbia crossing for forty miles, and at 4 or
  // below the router takes 9 km of I-84 at Mosier to save 60 m. 12 sits inside
  // the band with room on both sides. Move it and re-run scripts/audit_route
  // against those six.
  freeway: 12,
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
  // The shape of the climb curve: nothing extra below the knee, and this much
  // per metre climbed at 10%. 4 / 7.84 reproduces the curve exactly as shipped.
  climbKneePct: 4, climbCostAt10Pct: 7.84,
  climbDirectSecPerM: 0.25, climbBalancedSecPerM: 0.9, climbLowStressSecPerM: 1.6,
  turnDirectSec: 6, turnBalancedSec: 11, turnLowStressSec: 15,
  // Crossing a failing road with no signal or all-way stop (seconds, once
  // per crossing; see uncontrolledCrossPenaltyS). Rider-settled after two
  // field days of tuning (2026-08-27): strong enough to prefer a signal a
  // block or so away, never enough to buy a bridge detour. Controlled
  // crossings are free by design at any setting — the point is the
  // difference, not a crossing tax. A slider at 0 silences that mode.
  crossUncontrolledDirectSec: 10, crossUncontrolledBalancedSec: 20,
  crossUncontrolledLowStressSec: 20,
  diversityQuick: 1.3, diversityBalanced: 1.35, diversitySafer: 1.35, diversityWide: 1.6,
  // How far the facility-neutral diversity round moves the facility
  // discounts toward neutral for its one extra search (log-space exponent
  // 1-s): 0 skips the round entirely, 0.5 halves the pull, 1 removes it for
  // that search. Never touches the pricing of any offered route.
  facilityNeutralStrength: 0.5,
  // How much different riding (miles, on the shorter of the two) makes two
  // options genuinely different instead of one route offered twice. The
  // default is the field-tuned 800 m the dedupe shipped with.
  distinctRideMi: 0.5,
  // Scales every outcome threshold in materialTradeoff below: under 1,
  // smaller safety/facility differences keep a near-identical pair
  // separate; above 1 only large ones do. 1 is the shipped behaviour.
  twinTradeoffX: 1,
});
// One place decides how a mode names its weights. Everything that used to spell
// out `mode === 'low' ? 'Low' : ...` inline now calls this, so a future mode
// cannot be added to some cost functions and forgotten in others.
function modeSuffix(mode) {
  return mode === 'direct' ? 'Direct' : mode === 'low' ? 'LowStress' : 'Balanced';
}
let activeWeights = { ...DEFAULT_WEIGHTS };
let weightsSignature = '';
// Keep semantic bounds explicit instead of treating every weight as an
// interchangeable multiplier. A traffic blend outside [0, 1] extrapolates
// beyond both inputs and can make an edge cost negative.
const ROUTING_WEIGHT_BOUNDS = Object.freeze({
  useMeasuredTraffic: Object.freeze([0, 1]),
  preferredRoute: Object.freeze([0.05, 1]),
  // A knee of 0 charges every metre climbed; 9 charges almost nothing until the
  // grade is genuinely steep. Above 9 the anchor at 10% has nothing to bite on.
  climbKneePct: Object.freeze([0, 9]),
  // 1 is a flat rate per metre of ascent, ignoring steepness entirely -- which
  // is what the app did before the curve existed, and is worth being able to
  // return to. Anything below 1 would make a steep metre cheaper than a gentle
  // one, so the floor is 1 rather than 0.
  climbCostAt10Pct: Object.freeze([1, 40]),
  // A search-lens fraction, not a road multiplier: above 1 the lens would
  // INVERT the facility preference for its probe.
  facilityNeutralStrength: Object.freeze([0, 1]),
  // Below ~250 ft everything reads as different and the portfolio fills
  // with near-twins; above 2 mi short trips cannot offer alternatives.
  distinctRideMi: Object.freeze([0.05, 2]),
  twinTradeoffX: Object.freeze([0.3, 3]),
});
const ZERO_ROUTING_WEIGHTS = new Set(['ferryWaitMin', 'speedOverBalanced', 'speedOverLowStress',
  'speedBelowDirect', 'speedBelowBalanced', 'speedBelowLowStress', 'downhillFactor', 'undulationSecPerM',
  'climbDirectSecPerM', 'climbBalancedSecPerM', 'climbLowStressSecPerM',
  'turnDirectSec', 'turnBalancedSec', 'turnLowStressSec', 'useMeasuredTraffic', 'facilityNeutralStrength',
  'crossUncontrolledDirectSec', 'crossUncontrolledBalancedSec', 'crossUncontrolledLowStressSec']);
function validatedRoutingWeight(key, sourceValue) {
  const value = Number(sourceValue);
  if (!Number.isFinite(value)) return null;
  const bounds = ROUTING_WEIGHT_BOUNDS[key];
  if (bounds) return Math.min(bounds[1], Math.max(bounds[0], value));
  const minimum = ZERO_ROUTING_WEIGHTS.has(key) ? 0 : 0.1;
  return value >= minimum && value <= 120 ? value : null;
}
// A weight set KEEPS its epoch. The direct-lens probe switches weights inside
// every request (main -> lens -> main); with a plain counter that round trip
// minted two fresh epochs per request, and since every cache key embeds the
// epoch, it silently invalidated every cost slot, floor slot and potential on
// every search. Content-keyed epochs make the round trip free: returning to a
// known set restores its old epoch, and the lens set caches under its own.
const weightsEpochBySignature = new Map();
let weightsEpochCounter = 0;
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
  let epoch = weightsEpochBySignature.get(signature);
  if (epoch == null) {
    epoch = ++weightsEpochCounter;
    weightsEpochBySignature.set(signature, epoch);
    // Bounded: a rider dragging a weight slider mints signatures freely.
    if (weightsEpochBySignature.size > 32) {
      weightsEpochBySignature.delete(weightsEpochBySignature.keys().next().value);
    }
  }
  weightsEpoch = epoch;
}
function applyWeights(source) {
  if (!source || typeof source !== 'object') return;
  for (const key of Object.keys(DEFAULT_WEIGHTS)) {
    const value = validatedRoutingWeight(key, source[key]);
    if (value !== null) activeWeights[key] = value;
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
function facilityRouteBonusApplies(level, safetyLevel) {
  // A sharrow is a route-choice hint, not protection. Keep that modest hint on
  // a failing road without allowing stronger facilities or signed-route-only
  // bonuses to conceal a failure.
  return safetyLevel < 4 || level === 1;
}
function isResidential(i) {
  return eClass[i] === 1 || eClass[i] === 2; // residential / living_street
}
function isDismountEdge(i) {
  return !!(eOfficial[i] & EDGE_DISMOUNT);
}
function isTaggedDismountEdge(i) {
  return i != null && i >= 0
    && (eOfficial[i] & (EDGE_DISMOUNT | EDGE_DISMOUNT_TAG))
      === (EDGE_DISMOUNT | EDGE_DISMOUNT_TAG);
}
function dismountEntryPenaltyS(incomingEdge, outgoingEdge) {
  return isTaggedDismountEdge(outgoingEdge) && !isTaggedDismountEdge(incomingEdge)
    ? DISMOUNT_ENTRY_PENALTY_S : 0;
}
function isFreewayEdge(i) {
  return i != null && i >= 0 && !!(eFlags[i] & 4);
}
function freewayEntryPenaltyS(incomingEdge, outgoingEdge) {
  return isFreewayEdge(outgoingEdge) && !isFreewayEdge(incomingEdge)
    ? FREEWAY_ENTRY_PENALTY_S : 0;
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
// This is deliberately a finite route-choice cost, not a safety failure. Real
// bike space removes the no-facility proxy penalty; a sharrow does not.
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
  // A real bike lane or separated facility makes motor-traffic exposure less
  // relevant to route choice. A sharrow is only paint in the traffic lane, so
  // measured traffic must still be priced normally.
  if (edgeFacility(i, forward) >= 2 || (eFlags[i] & (8 | 32 | 4))
      || edgeLimited(i, forward)) return 1;
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
  if (edgeFacility(i, forward) >= 4 || (eFlags[i] & (8 | 32 | 4))
      || edgeLimited(i, forward)) return 1;
  const paintRelief = edgeFacility(i, forward) >= 2 ? 0.5 : 1;
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
      || edgeFacility(i, forward) >= 1 || edgeSpeed(i, forward) < 30
      || (eFlags[i] & (8 | 32 | 4))) return 1;
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

// How much worse is a metre of climbing at this grade than a metre of gentle
// climbing? Rises from 1x at 4% -- below which nobody minds -- and accelerates,
// because the misery of a hill is not linear in its steepness: 8% is far worse
// than twice 4%, and 10% is worse again.
//
//     4%  1.00      8%  4.04      12%  13.16
//     6%  1.76     10%  7.84      15%  24.00
//
// This replaced `1 + max(0, grade - 0.04) * 8`, which rose only 1.00 -> 1.88
// across the whole range 4% -> 15%. Because the charge is per metre of ASCENT,
// and a steeper way to the same height is shorter, that shallow ramp very
// nearly cancelled: gaining 50 m at 4% and at 12% cost almost the same. Fremont
// Avenue N -- 557 m at 3-6%, 239 m at 6-9%, and a 15.8% block -- was charged 58
// seconds against Stone Way N's 30 for the same hill, and Stone Way is the
// gentler climb every local rider takes.
//
// ASCENT is clamped, not just the multiplier, and that ordering is the point.
// The DEM cannot see a bridge deck or a trail benched into a hillside, so a
// short edge can record a grade no bicycle could climb. Bounding the multiplier
// alone would still leave the invented metres of ascent to be paid for. One
// clamp on ascent bounds both, and 15% is where riding stops and walking
// begins -- which the dismount model already prices.
const MAX_PRICED_GRADE = 0.15;
// The curve is anchored on a number a rider can actually judge: what a 10%
// grade should cost per metre climbed against a gentle one. The quadratic
// coefficient follows from it, so moving the slider moves the whole curve
// without anyone having to reason about what 0.19 means.
//
//   costAt10 7.84 (default), knee 4%   ->   6%  1.8   8%  4.0   12%  13.2
//
// Both live in the routing weights, so the Advanced menu can reach them and a
// shared route reproduces the sender's curve rather than the recipient's.
function climbSteepness(netAsc, lengthM) {
  const gradePct = 100 * netAsc / Math.max(1, lengthM);
  const knee = activeWeights.climbKneePct;
  const excessAt10 = Math.max(1, 10 - knee);
  const bite = (activeWeights.climbCostAt10Pct - 1) / (excessAt10 * excessAt10);
  return 1 + Math.max(0, bite) * Math.max(0, gradePct - knee) ** 2;
}
function pricedAscent(netAsc, lengthM) {
  return Math.min(netAsc, lengthM * MAX_PRICED_GRADE);
}

// Route choice may be more climb-averse than the physical travel-time model.
// Net climbing receives the full mode-specific cost; extra up-and-down within
// an edge receives only half, so rolling terrain is discouraged without being
// treated as harshly as one sustained climb. This affects selection, not ETA.
function climbPreferenceS(i, forward, mode) {
  if (eFlags[i] & 32) return 0;
  const asc = forward ? eAsc[i] : eDes[i];
  const des = forward ? eDes[i] : eAsc[i];
  const netAsc = pricedAscent(Math.max(0, asc - des), eLen[i]);
  const rollingAsc = Math.max(0, asc - Math.max(0, asc - des));
  const key = mode === 'direct' ? 'climbDirectSecPerM'
    : mode === 'low' ? 'climbLowStressSecPerM' : 'climbBalancedSecPerM';
  return (netAsc * climbSteepness(netAsc, eLen[i]) + rollingAsc * 0.5)
    * activeWeights[key];
}

// Surface preference is intentionally a soft, distance-proportional route
// cost. Every route gets a modest 20% baseline preference for known pavement;
// the rider-controlled option raises that to ten times the original full cost.
// This makes a reasonable paved detour win very decisively, while unpaved
// links remain available when they are necessary for connectivity.
function surfacePreferenceS(i, rules) {
  if (eFlags[i] & 32) return 0;
  const strength = rules?.preferPaved === true ? 10 : 0.20;
  const surface = eSurface[i] & 15;
  if (surface === SURFACE_GRAVEL) return eLen[i] * 0.065 * strength;
  if (surface === SURFACE_ROUGH) return eLen[i] * 0.20 * strength;
  return 0;
}

function isFacilityGapEdge(i) {
  return !!(eFacilityGap && eFacilityGap[i]);
}

function facilityGapDistancePenaltyS(i) {
  return isFacilityGapEdge(i) ? eLen[i] * FACILITY_GAP_PENALTY_S_PER_M : 0;
}

function facilityGapEntryPenaltyS(incomingEdge, outgoingEdge) {
  return isFacilityGapEdge(outgoingEdge)
    && (incomingEdge == null || incomingEdge < 0 || !isFacilityGapEdge(incomingEdge))
    ? FACILITY_GAP_ENTRY_PENALTY_S : 0;
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

// Crossing a road that FAILS the rider's rules where nothing makes its
// traffic stop means finding a gap that never has to open. The graph carries
// where a signal or all-way stop is (nodeControlled, from edgeLimitedDir
// bits 2/3); everywhere else this charges a flat entry once per crossing, so
// the router now spends up to that many seconds of detour to reach a
// controlled crossing instead. Controlled crossings stay free. Two shapes of
// crossing, matching how OSM maps them:
//   - the failing road's own short pavement (a CROSSING_MAX_M run -- divided
//     arterials, median islands): charged on entering it from a non-failing
//     edge, once per run;
//   - a plain shared junction node: both the incoming and outgoing edge pass,
//     while >= 2 failing edges touch the node -- a failing road runs through.
// Riding ALONG a failing road is priced per metre by the level-4 multipliers,
// so a transition arriving on a failing edge charges nothing here. Turning
// onto a parallel non-failing edge at the shared node is charged like the
// straight-through crossing -- shared nodes between a crossing street and a
// parallel facility are rare enough that bearing analysis is not worth its
// cost. A graph without control bits (built before they existed) disables
// the charge entirely rather than pricing every signalised crossing in the
// state as uncontrolled.
// The one definition of "this transition crosses a failing road
// uncontrolled", shared by the routing charge and the 🐞 debug markers so
// the two can never disagree. Every clause earned its place in the field:
// a NAMED failing road different from both the street ridden in and the
// street ridden out must touch the node — the name test is what stops a
// directionally-failing street from charging its own riders (Stone Way),
// what stops riding INTO a failing stretch from reading as a crossing
// (N 92nd: same name, short first fragment), and what still charges a
// median hop over Aurora, whose crossing stub carries the minor street's
// name while Aurora's own named edges sit at the same node.
function uncontrolledCrossingAt(incomingEdge, node, outgoingEdge, rules) {
  if (!nodeControlledCount || !(incomingEdge >= 0) || nodeControlled[node]) return false;
  if (edgeLevelFor(incomingEdge, rules, eB[incomingEdge] === node) === 4) return false;
  const touch = nodeFailTouch(rules);
  const inName = eName[incomingEdge];
  const outFails = edgeLevelFor(outgoingEdge, rules, eA[outgoingEdge] === node) === 4;
  // When the out edge PASSES, its name is excluded too: the street being
  // ridden may change name at the node (Stone Way becoming Green Lake Way)
  // without that being a crossing. When the out edge FAILS, only the
  // street ridden in on is excluded — the failing road entered is exactly
  // the road being crossed (9th Ave doglegging 7 m along failing NE 40th),
  // and excluding its name too suppressed that genuine charge while it was
  // only ever needed to spare riding INTO one's own street's failing
  // stretch (N 92nd), which the inName exclusion already covers.
  const outName = outFails ? FAIL_TOUCH_NO_NAME : eName[outgoingEdge];
  const crosses = (nm) => nm !== FAIL_TOUCH_NO_NAME && nm !== inName && nm !== outName;
  if (!crosses(touch.name1[node]) && !crosses(touch.name2[node])) return false;
  if (outFails) {
    return eLen[outgoingEdge] <= CROSSING_MAX_M && !(eFlags[outgoingEdge] & 4);
  }
  return touch.count[node] >= 2;
}

function uncontrolledCrossPenaltyS(incomingEdge, node, outgoingEdge, rules, mode) {
  // Weight first: at 0 (the shipped default) the charge does no detection
  // work and builds no cache at all.
  const sec = activeWeights[mode === 'direct' ? 'crossUncontrolledDirectSec'
    : mode === 'low' ? 'crossUncontrolledLowStressSec' : 'crossUncontrolledBalancedSec'];
  if (!sec) return 0;
  return uncontrolledCrossingAt(incomingEdge, node, outgoingEdge, rules) ? sec : 0;
}

// Debug surface for the field: every uncontrolled crossing of a failing
// road along a finished path, detected exactly as the charge above does but
// INDEPENDENT of the weights — the rider needs to SEE these intersections
// whether or not the avoidance switch is on. Returns [lon, lat] pairs from
// the segs a public candidate already carries.
function debugUncontrolledCrossingsFor(segs, rules) {
  if (!nodeControlledCount || !Array.isArray(segs)) return [];
  const out = [];
  let lastNode = -1;
  for (let k = 1; k < segs.length; k++) {
    const e1 = segs[k - 1]?.localEdgeIndex, e2 = segs[k]?.localEdgeIndex;
    if (!(e1 >= 0) || !(e2 >= 0) || e1 === e2) continue;
    let u = -1;
    for (const n1 of [eA[e1], eB[e1]]) {
      if (n1 === eA[e2] || n1 === eB[e2]) u = n1;
    }
    if (u < 0 || u === lastNode) continue;
    if (!uncontrolledCrossingAt(e1, u, e2, rules)) continue;
    lastNode = u;
    out.push([nodeLon[u], nodeLat[u]]);
    if (out.length >= 200) break;
  }
  return out;
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
let floorValues = null;   // the active slot's Float32Array(2E), NaN = not yet computed
// Floors are a pure function of (edge, direction, key), and the same keys are
// asked for again and again: the six (mode x lens) keys cycle within one
// request, a ferry trip alternates two of them per land section, and a moved
// pin re-asks all six with only the goal changed. One shared array meant every
// key switch threw the previous key's floors away -- profiled at two thirds of
// each backward pass, ~10 s of a moved-pin request in the dev container. One
// slot per key instead, LRU over six. Float32, not Float64: a stored floor is
// never accumulated (the pass sums distances in doubles), and the half-ulp a
// store can round UP is ~1e-7 relative -- absorbed a thousand times over by
// POTENTIAL_SAFETY. ~11 MB per slot at 2.7M directed edges.
const FLOOR_SLOTS = 8;
const floorSlots = [];
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
  let slot = null;
  for (let i = 0; i < floorSlots.length; i++) {
    if (floorSlots[i].key === key) { slot = floorSlots.splice(i, 1)[0]; break; }
  }
  if (!slot) {
    slot = floorSlots.length < floorSlotCap
      ? { key: '', values: new Float32Array(2 * E) }
      : floorSlots.pop();
    slot.key = key;
    slot.values.fill(NaN);
  }
  floorSlots.unshift(slot);
  floorValues = slot.values;
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
  const designatedFloor = Math.min(1, activeWeights.strongDesignated);
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
 * `ctx` carries the search's settings plus the path-dependent inputs,
 * which are the only reason this cannot be a pure function of the edge:
 * `boardingWaitS` (a ferry costs its wait only where this end has land),
 * `incomingEdge` and `fromNode` (a dismount or traffic-conflict run is charged
 * once, and turn friction depends on what you turned off). Omit them and you get the
 * edge-only price -- which is exactly what edgeCostFloor() has to bound.
 */
function edgeCost(ei, forward, ctx) {
  const mul = edgeCostParts(ei, forward, ctx.mode, ctx.modeW, ctx.rules,
    ctx.searchRules, ctx.prefDesig, ctx.prefResidential,
    ctx.boardingWaitS || 0, !!ctx.requiredSafeAccess);
  if (!(mul < Infinity)) return Infinity;
  let cost = mul;
  if (ctx.diversityEdges?.has(ei) && partsDivOk) cost *= ctx.diversityFactor;
  cost += partsSteep;
  cost += partsSurf;
  cost += dismountEntryPenaltyS(ctx.incomingEdge, ei);
  cost += freewayEntryPenaltyS(ctx.incomingEdge, ei);
  cost += facilityGapEntryPenaltyS(ctx.incomingEdge, ei);
  if (ctx.fromNode != null) {
    cost += turnPreferenceS(ctx.incomingEdge, ctx.fromNode, ei, ctx.mode);
    cost += uncontrolledCrossPenaltyS(ctx.incomingEdge, ctx.fromNode, ei, ctx.rules, ctx.mode);
  }
  return cost;
}

/* The arc-deterministic pieces of edgeCost, split out so the relaxation loop
 * can cache them per arc: `mul` is the whole multiplicative chain (including
 * the ferry boarding wait and the required-safe-access surcharge, both fixed
 * per arc), `steep`/`surf` the per-arc additive terms, `divOk` whether an
 * alternative-corridor diversity penalty may apply. What stays out is exactly
 * what depends on more than the arc and the search config: the diversity
 * factor itself (per candidate), the dismount/traffic-conflict entry charges,
 * turn friction and the uncontrolled-crossing charge
 * (per transition). edgeCost() above recombines them in the original order,
 * so the cached path and the reference path price an edge identically. */
let partsSteep = 0, partsSurf = 0, partsDivOk = 0;
function edgeCostParts(ei, forward, mode, modeW, rules, searchRules,
    prefDesig, prefResidential, boardingWaitS, requiredSafeAccess) {
  const fl = eFlags[ei];
  const actualLevel = edgeLevelFor(ei, rules, forward);
  const searchLevel = searchRules === rules
    ? actualLevel : edgeLevelFor(ei, searchRules, forward);
  // This opt-in is deliberately a routing lens, not a safety verdict. A signed
  // bicycle route is treated like trusted separated infrastructure while A*
  // prices it, even when the unchanged model calls it caution or failure.
  // Permissions remain permissions: prohibited edges never reach here, and
  // freeway/MTB/ferry admission is still handled by their own settings.
  const trustSignedRoute = trustRouteEdge(ei, fl, rules);
  const mult = modeMult(mode, trustSignedRoute ? 1 : searchLevel);
  if (!(mult < Infinity)) { partsSteep = 0; partsSurf = 0; partsDivOk = 0; return Infinity; }
  let step = edgeTimeS(ei, forward) + climbPreferenceS(ei, forward, mode);
  step += boardingWaitS;   // ferry boarding, when this end has land
  let cost = step * mult;
  // An exempted terminal-access block is a last resort, never a shortcut:
  // any reasonable fully-safe approach must still win.
  if (requiredSafeAccess) cost *= 30;
  if (trustSignedRoute) {
    // Similar to a shared path, by request. Keep hills and surface additive
    // below so "prefer this vetted corridor" does not mean "pretend it is flat
    // and paved." The actual verdict is still emitted from actualLevel.
    cost *= preferredSignedRouteMult(ei, forward);
  } else {
    cost *= speedStress(mode, fl, edgeSpeed(ei, forward),
      edgeNoShoulderMaxFor(searchRules), edgeShoulder(ei, forward));
    cost *= hazardMult(modeW, edgeHazard(ei, forward) || 0);
    cost *= majorRoadMult(ei, modeW, forward);
    cost *= trafficStressMult(ei, modeW, forward);
    cost *= sidewalkExposureMult(ei, mode, forward);
    if (sidewalkFallbackFor(ei, searchRules, forward)) cost *= sidewalkFallbackMult(mode);
    if (fl & 4) cost *= activeWeights.freeway;
  }
  // Every other signal costs more as the profile gets friendlier, and this
  // one must too: limitedAccessLowStress sat at 1.0, so the low-stress profile applied
  // no penalty at all to a bike-legal limited-access highway -- less than
  // balanced. The friendliest route was the one most willing to put a rider
  // on a highway shoulder.
  if (!trustSignedRoute && edgeLimited(ei, forward)) cost *= modeW.limitedAccess;
  if (!trustSignedRoute && (eOfficial[ei] & EDGE_MTB)) cost *= activeWeights.mtbTrail;
  // Walking the bike is a bad OUTCOME, not merely a slow one. Dismount
  // stretches already cost their real walking time (V_DISMOUNT) plus the
  // six-minute entry below; this multiplier is the judgment on top, sized so
  // a gate or a short transition stays a shrug while a fifth of a mile of
  // "trail" you cannot ride prices like something to genuinely route around.
  // Proportional by construction: it scales the walked seconds themselves,
  // and a LONG dismount edge -- how a long unrideable trail appears in the
  // graph -- escalates further still.
  if (isDismountEdge(ei)) {
    cost *= eLen[ei] > DISMOUNT_LONG_EDGE_M ? DISMOUNT_LONG_EDGE_MULT
      : eLen[ei] < DISMOUNT_GATE_EDGE_M ? DISMOUNT_GATE_MULT
        : DISMOUNT_WALK_COST_MULT;
  }
  // Bonuses never apply to ferries, freeways, or WSDOT limited-access
  // highways: preference must not erase their access/caution costs. For
  // an ordinary road, a physical facility beats designation alone; when
  // both are present, use whichever benefit is stronger rather than
  // stacking them into an outsized corridor bonus.
  // A signed route is a recommendation, not a fact about the road, so its
  // ordinary bonus is withheld from an edge that FAILS the rider's rules. It is not
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
  // Sharrows are the narrow exception: their modest route-choice signal still
  // applies on a failing road, while the unchanged failure multiplier and
  // normal traffic cost keep that road appropriately expensive and red.
  const ridingFacility = edgeFacility(ei, forward);
  if (!trustSignedRoute && !(fl & (32 | 4)) && !isDismountEdge(ei)
      && facilityRouteBonusApplies(ridingFacility, actualLevel)) {
    const signed = designatedEdge(ei, fl);
    cost *= ridingFacility
      ? facilityPrefMult(ridingFacility)
      : (signed ? activeWeights.strongDesignated : 1);
  }
  if (!trustSignedRoute && !(fl & (8 | 32 | 4))
      && !edgeLimited(ei, forward) && isResidential(ei)) {
    cost *= activeWeights.residential;
  }
  // Alternative-corridor probes softly penalize ordinary road edges from
  // one already-found path. Protected lanes and shared paths may remain a
  // common trunk: leaving excellent infrastructure merely to be different
  // creates fussy neighborhood detours instead of a useful alternative.
  // (The factor itself is applied by the caller -- it varies per candidate.)
  const protectedInfrastructure = trustSignedRoute || (fl & 8)
    || edgeFacility(ei, forward) >= 4;
  // Grade is an independent rideability concern, applied after every
  // safety, facility, residential, and alternate-corridor multiplier so
  // a path bonus cannot shrink the penalty for a genuinely steep climb.
  partsSteep = steepUphillAvoidanceS(ei, forward, mode);
  // Similarly, a designated trail remains eligible but should not erase
  // the rider's explicit preference for pavement.
  partsSurf = surfacePreferenceS(ei, rules) + facilityGapDistancePenaltyS(ei);
  partsDivOk = !protectedInfrastructure && !(fl & 32) ? 1 : 0;
  return cost;
}

/* Per-arc cost cache. A portfolio request runs dozens of searches over the
 * same arcs, and profiling put over half its time in re-deriving the same
 * per-arc prices. An arc's `mul`/`add`/`divOk` are pure functions of the arc
 * and the search configuration, so they are computed once per configuration
 * and reused; the transition terms stay live in the relaxation loop. Two
 * slots, because adaptive-corridor probing alternates two configurations
 * (direct and balanced) per candidate -- one slot would thrash on exactly
 * the request this exists to speed up. */
// Fifteen: the profile grid is 3 modes x 4 preference combos = 12 distinct
// cache keys per rules configuration, and the discovery lens adds 3 more
// (direct/low/balanced under the stricter searchRules signature), and the
// two direct-lens probes two more under their own weights epoch. At 12 slots
// a request's own tail evicted the head of its working set -- LRU over 15
// keys cycling through 12 slots re-derived several configs on EVERY repeat
// request; discovery alone re-paid ~4 s per search. Storage is Float32 --
// per-arc seconds need 7 digits of precision, not 16 -- so a slot is ~16 MB
// at 2.6M arcs. The strict fully-matching probe does NOT need a slot of its
// own: requireSafe is excluded from the key on purpose, and its surcharge is
// applied live in the relaxation, never stored (see the fill below).
const COST_CACHE_SLOTS = 17;
// A constrained device (the app decides and says so via a 'configure'
// message) gets hard caps on every large cache instead of the full working
// set. Field: an iPhone can have the 142 MB graph, roughly 55 MB of permanent
// indexes/search state, 300+ MB of reusable routing caches, and MapLibre's
// statewide tiles alive at once. Zooming out is then enough for WebKit to kill
// the page. Caps trade warm-repeat speed for surviving the request: an evicted
// config is re-derived in a few seconds; a killed page loses everything.
// They only bound NEW allocation. `trimRoutingCaches` below releases existing
// reusable slots at a request/renderer boundary, never while a search uses one.
let costSlotCap = COST_CACHE_SLOTS;
let floorSlotCap = FLOOR_SLOTS;
let potentialCap = 12;  // mirrors POTENTIAL_CACHE_MAX, declared below
// See the h() comment in routeLeg: found-route cost is bounded by this factor
// times the optimum. 1.0 = exact A*.
const SEARCH_OVERSHOOT = 1.15;
const costCacheSlots = [];
function arcCostCache(key) {
  for (let i = 0; i < costCacheSlots.length; i++) {
    if (costCacheSlots[i].key === key) {
      const slot = costCacheSlots.splice(i, 1)[0];
      costCacheSlots.unshift(slot);
      return slot;
    }
  }
  const slot = costCacheSlots.length < costSlotCap
    ? { key: '', mul: new Float32Array(D), add: new Float32Array(D), divOk: new Uint8Array(D) }
    : costCacheSlots.pop();
  slot.key = key;
  slot.mul.fill(NaN);   // NaN = not yet computed; a real cost is never NaN
  costCacheSlots.unshift(slot);
  return slot;
}

/* ---- idle cache pre-warm -------------------------------------------------
 * Fills the per-arc cost cache for the profile grid's configurations while
 * nobody is waiting, so the FIRST search of a session runs at the speed a
 * long-lived app reaches organically. Field diagnosis behind it: a Mac's
 * fresh tab took 16.8 s where a phone that had routed all evening took 3.5 s
 * -- matching (uncached compute) identical, search phases 3-12x apart. The
 * fill is EXACTLY what the search would compute and store (same key, same
 * edgeCostParts, same Float32 rounding), so warmed and organic results are
 * indistinguishable. Chunked with setTimeout(0) so a real request arriving
 * mid-warm waits only for the current slice; a newer warm-up (rules changed)
 * cancels the old one via the token. */
let prewarmToken = 0;
function prewarmArcCosts(rules, configs, id) {
  const token = ++prewarmToken;
  const started = Date.now();
  let configIndex = 0, u = 0, filled = 0;
  const CHUNK_NODES = 30000;
  const step = () => {
    if (token !== prewarmToken) return;
    const config = configs[configIndex];
    if (!config) {
      postMessage({ type: 'prewarm-done', id, filled, ms: Date.now() - started });
      return;
    }
    const modeW = modeWeights(config.mode);
    // Seed the rider's rules into the first verdict slot exactly as a real
    // request does. Without this the rider rules land in the SECOND slot --
    // and a lens config then evicts them per arc, ping-ponging one slot
    // between two rule sets: two signature hashes and a generation bump per
    // arc, verdict bytes never retained. Profiled at 10x the sweep's cost.
    useVerdictCache(rules);
    // A `lens` config warms a discovery key: same rider rules, priced through
    // the conservative searchRules -- the exact key addDiscoveryCandidates
    // will ask for. The requireSafe surcharge is never stored (see the
    // relaxation fill), so no strict config exists to warm. One lens OBJECT
    // per config, not per chunk: the verdict slots key on identity first.
    const lens = config.lens ? (config._lens ??= conservativeDiscoveryRules(rules)) : null;
    const searchRules = lens || rules;
    const costKey = `${config.mode}|${config.prefDesig ? 1 : 0}${config.prefResidential ? 1 : 0}`
      + `|${boundSignature(rules)}|${lens ? boundSignature(lens) : '='}`;
    const { mul: cMul, add: cAdd, divOk: cDivOk } = arcCostCache(costKey);
    const stop = Math.min(N, u + CHUNK_NODES);
    for (; u < stop; u++) {
      for (let a = outStart[u]; a < outStart[u + 1]; a++) {
        if (cMul[a] === cMul[a]) continue;
        const ei = outEdge[a];
        const fl = eFlags[ei];
        const forward = eA[ei] === u;
        // The same admission gates the search applies; an arc it would skip
        // stays NaN and is filled organically if a config ever admits it.
        if (edgeShoulder(ei, forward) === PROHIBITED_SHOULDER) continue;
        if (!rules.allowMtbTrails && (eOfficial[ei] & EDGE_MTB)) continue;
        if (!rules.allowFreeways && (fl & 4)) continue;
        if (rules.allowFerries === false && (fl & 32)) continue;
        cMul[a] = edgeCostParts(ei, forward, config.mode, modeW, rules, searchRules,
          config.prefDesig, config.prefResidential,
          (fl & 32) && nodeHasLand[u] ? activeWeights.ferryWaitMin * 60 : 0,
          false);
        cAdd[a] = partsSteep + partsSurf;
        cDivOk[a] = partsDivOk;
        filled++;
      }
    }
    if (u >= N) { configIndex++; u = 0; }
    // A real pause, not just a yield: the sweep shares CPU cores with the
    // MAP workers parsing tiles, and a zero-delay chain starved them while
    // the rider browsed the map before routing (field: slow tile reloads on
    // zoom). Warming a few seconds slower costs nobody anything.
    setTimeout(step, 12);
  };
  step();
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
  const trustSignedRoute = trustRouteEdge(i, fl, rules);
  let m = modeMult(mode, trustSignedRoute ? 1 : searchLevel);
  if (!(m < Infinity)) return Infinity;
  if (trustSignedRoute) {
    m *= preferredSignedRouteMult(i, forward);
  } else if (fl & 4) m *= freewayFloor;
  if (!trustSignedRoute && (eOfficial[i] & EDGE_MTB)) m *= mtbFloor;
  if (!trustSignedRoute && !(fl & (8 | 32 | 4)) && isResidential(i)) m *= residentialFloor;
  const floorFacility = edgeFacility(i, forward);
  if (!trustSignedRoute && !(fl & (32 | 4)) && !isDismountEdge(i)
      && facilityRouteBonusApplies(floorFacility, level)) {
    // A facility bonus OR a designation bonus, never both, and never on a
    // ferry, freeway or dismount link. The rider may have set neither
    // preference, so take whichever of the two prices the edge lower.
    m *= floorFacility ? (facility[floorFacility] ?? 1)
      : (designatedEdge(i, fl) ? designatedFloor : 1);
  }
  if (!trustSignedRoute && !(fl & (8 | 32))) {
    const below = noShoulderMax - edgeSpeed(i, forward);
    if (below > 0 && !(edgeShoulder(i, forward) > 0)) {
      m *= Math.max(SPEED_STRESS_FLOOR, 1 - belowRate * below);
    }
  }
  // Everything the search charges ON TOP of the base time, read from this edge
  // rather than floored at 1. These are what make a Low-stress bound
  // meaningfully stronger than a Direct one.
  if (!trustSignedRoute) {
    m *= hazardMult(weights, edgeHazard(i, forward) || 0);
    m *= majorRoadMult(i, weights, forward);
    m *= trafficStressMult(i, weights, forward);
    m *= sidewalkExposureMult(i, mode, forward);
    if (edgeLimited(i, forward)) m *= limitedFloor;
  }
  let climb = 0;
  if (!(fl & 32)) {
    const asc = forward ? eAsc[i] : eDes[i];
    const des = forward ? eDes[i] : eAsc[i];
    const netAsc = Math.max(0, asc - des);
    // Identical to climbPreferenceS: this is A*'s lower bound on the same
    // quantity, and the two diverging breaks the search rather than the price.
    const priced = pricedAscent(netAsc, eLen[i]);
    climb = (priced * climbSteepness(priced, eLen[i])
      + Math.max(0, asc - netAsc) * 0.5) * climbRate;
  }
  const floor = (edgeTimeS(i, forward) + climb) * m
    + steepUphillAvoidanceS(i, forward, mode) + surfacePreferenceS(i, rules)
    + facilityGapDistancePenaltyS(i);
  // A walk-eligible edge can be traversed at walking price when it sits at a
  // leg's endpoint, and a failing edge's ride floor (base time times the
  // minimum fail multiplier) sits ABOVE that. The floor cannot know where
  // the endpoints are — it feeds bound caches keyed by rules alone — so for
  // these edges it must cover the cheaper of the two traversals everywhere.
  // Passing edges ride below walking pace, so min() moves nothing there;
  // only short failing sidewalk edges get the lower floor, which weakens
  // the potential immeasurably and keeps it admissible.
  return walkAccessGate(i) ? Math.min(floor, eLen[i] / V_DISMOUNT) : floor;
}

// Keyed by goal node, mode and the bound signature, so a potential is only ever
// handed to a search it was actually built for -- and survives into the next
// request when nothing it depends on has moved.
//
// Three modes times a leg's goal, plus three more under the discovery lens.
// A ferry trip adds several one-shot section goals on top: the adaptive
// corridor probe re-searches each land section between crossings, and those
// have goals of their own. Sized so a ferry trip's tail cannot evict the six
// keys the next request of the same trip will ask for again -- a potential is
// a bounded backward Dijkstra, cheap to hold (a Uint16 per node) and slow to
// rebuild.
const POTENTIAL_CACHE_MAX = 14;
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
  // Not profile-specific: banning ferries changes the reachable graph for the
  // WHOLE request, and the potential cache keys on the rules signature, so a
  // tighter no-ferry bound can never leak into a ferry-allowed search.
  const noFerry = rules?.allowFerries === false;
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
      if (noFerry && (fl & 32)) continue;
      // This walks the arc BACKWARD: v is where a route would be coming from,
      // so the traversal under test is v -> u and `forward` is read off v.
      const fromA = eA[ei] !== u;
      const v = fromA ? eA[ei] : eB[ei];
      if (settled[v] || v === u) continue;
      // One-way edges may only be entered from the end they leave.
      if ((fl & 16) && !fromA) continue;
      if (edgeShoulder(ei, fromA) === PROHIBITED_SHOULDER) continue;
      const fi = ei * 2 + (fromA ? 1 : 0);
      let floorC = floorValues[fi];
      if (floorC !== floorC) {
        // Read BACK through the Float32 store: a pass that fills a floor and a
        // later pass that reuses it must price the arc identically, or two
        // builds of the same potential could differ in the last digit.
        floorValues[fi] = edgeCostFloor(ei, fromA);
        floorC = floorValues[fi];
      }
      const nd = du + floorC;
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
  while (potentialCache.size >= Math.min(POTENTIAL_CACHE_MAX, potentialCap)) {
    potentialCache.delete(potentialCache.keys().next().value);
  }
  potentialCache.set(cacheKey, potential);
  return potential;
}

function routeLeg(startLL, endLL, rules, mode, prefDesig, prefResidential,
  startSnap, endSnap, diversityEdges = null, diversityFactor = 1, searchRules = rules,
  blockedCrossingEdges = null, crossingRetry = 0, progressPenaltySecPerM = 0,
  pocketRetry = 0) {
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
      limitedAccessM: 0, facilityM: 0, trailM: 0, mtbM: 0, dismountM: 0, hazardM: 0,
      levelM: [0, 0, 0, 0, 0], edgeIds: [],
      nodeIds: [s.node],
      segs: [], profile: [[0, nodeEle[s.node]]],
      snapStartM: s.distM, snapEndM: t.distM, ms: Date.now() - t0,
    };
  }

  const goalLon = nodeLon[t.node], goalLat = nodeLat[t.node];
  const progressLonMPerDegree = 111320 * Math.cos(goalLat * Math.PI / 180);
  const progressDistanceM = progressPenaltySecPerM > 0
    ? (n) => Math.hypot((nodeLon[n] - goalLon) * progressLonMPerDegree,
      (nodeLat[n] - goalLat) * 111320)
    : null;
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
  // The walked sidewalk escape (see WALK_ACCESS_RADIUS_M). Planar distance:
  // at 46 m scale the flat-earth error is nanometres, and this runs inside
  // the relax loop for every failing arc.
  const walkKx = 111320 * Math.cos(goalLat * Math.PI / 180), walkKy = 110540;
  const nearWalkTerminal = (n) => {
    const dxs = (nodeLon[n] - startLon) * walkKx, dys = (nodeLat[n] - startLat) * walkKy;
    if (dxs * dxs + dys * dys <= WALK_ACCESS_RADIUS_M * WALK_ACCESS_RADIUS_M) return true;
    const dxg = (nodeLon[n] - goalLon) * walkKx, dyg = (nodeLat[n] - goalLat) * walkKy;
    return dxg * dxg + dyg * dyg <= WALK_ACCESS_RADIUS_M * WALK_ACCESS_RADIUS_M;
  };
  const walkAccessEdge = (ei) => walkAccessGate(ei)
    && (nearWalkTerminal(eA[ei]) || nearWalkTerminal(eB[ei]));
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
  const costKey = `${mode}|${prefDesig ? 1 : 0}${prefResidential ? 1 : 0}`
    + `|${boundSignature(rules)}|${searchRules === rules ? '=' : boundSignature(searchRules)}`;
  const { mul: cMul, add: cAdd, divOk: cDivOk } = arcCostCache(costKey);
  const vHeur = heuristicSpeed(mode, prefResidential, rules);
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
  // Bounded overshoot: scaling an admissible heuristic by this factor turns
  // A* into weighted A*, whose found route costs AT MOST this factor times
  // the true optimum -- a hard mathematical bound, not a heuristic hope. In
  // practice the potential is tight along the corridor the route actually
  // takes, so the found routes are nearly always identical; what the factor
  // prunes is lateral exploration far from the goal. 1.0 restores exact A*.
  // Chosen with the rider's explicit trade: large speedups for at-most-minor
  // route differences, never a capability loss.
  // Never weighted while a diversity penalty is active: the penalty asks for
  // a DIFFERENT corridor, and an overshoot tolerance lets the search shrug
  // the penalty off and hand back the seed corridor -- which collapsed the
  // alternatives into near-identical thumbnails on the More screen. Exact
  // search there; the probes are a small share of the portfolio's time.
  const overshoot = diversityEdges ? 1 : SEARCH_OVERSHOOT;
  const geometricGoalBound = (n) =>
    havM(nodeLon[n], nodeLat[n], goalLon, goalLat) / vHeur;
  const h = (n) => {
    const settled = potDist[n];
    const bound = settled !== POTENTIAL_UNSETTLED ? settled * potScale
      : Math.max(geometricGoalBound(n), potBeyond);
    return bound * overshoot;
  };
  const START_ARC = -1;
  heap.push(h(s.node), START_ARC);

  let foundArc = -1;
  const legFrontierHits = new Map();
  while (heap.size) {
    const incomingArc = heap.pop();
    if (incomingArc !== START_ARC && searchStamp[incomingArc] === -generation) continue;
    if (incomingArc !== START_ARC) searchStamp[incomingArc] = -generation;
    const u = incomingArc === START_ARC ? s.node : outTarget[incomingArc];
    const du = incomingArc === START_ARC ? 0 : searchDist[incomingArc];
    if (configuredFrontiers.has(u)) {
      // A backward graph potential is admissible only for the currently loaded
      // topology. Detail loaded beyond this portal may introduce a cheaper
      // continuation, and weighted A* also does not promise that `du` is the
      // cheapest prefix when the node is observed. Straight-line bounds from
      // the snapped start to the portal and onward to the goal stay admissible
      // under every future expansion.
      const lowerBound = havM(nodeLon[s.node], nodeLat[s.node],
        nodeLon[u], nodeLat[u]) / vHeur + geometricGoalBound(u);
      const previous = legFrontierHits.get(u);
      if (Number.isFinite(lowerBound) && (previous == null || lowerBound < previous)) {
        legFrontierHits.set(u, lowerBound);
      }
    }
    if (u === t.node) { foundArc = incomingArc; break; }
    const incomingEdge = incomingArc === START_ARC ? -1 : outEdge[incomingArc];
    const progressFromGoalM = progressDistanceM ? progressDistanceM(u) : 0;
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
      // Ferries are an admission gate like freeways and MTB trails, not a
      // price: off means the crossing does not exist. The key is absent from
      // presets (it is a travel option, not a safety rule) so a missing key
      // means allowed.
      if (rules.allowFerries === false && (fl & 32)) continue;
      const actualLevel = edgeLevelFor(ei, rules, forward);
      // "Only show routes fully matching safety rules": failing roads become
      // impassable in EVERY mode, so profiles choose only among matching
      // paths — except the short access blocks at a leg's own endpoints,
      // which stay usable (and still report/pulse as failing).
      const provisionalCrossing = eLen[ei] <= CROSSING_MAX_M && !(fl & 4)
        && !blockedCrossingEdges?.has(ei);
      if (rules.requireSafe && actualLevel === 4 && !terminalAccessEdge(ei)
          && !provisionalCrossing) continue;
      // The arc-deterministic price, cached per search configuration; the
      // transition terms (diversity per candidate, dismount entry, turn
      // friction and the uncontrolled-crossing charge per arrival) are
      // applied live, exactly as edgeCost() does.
      // Discovery lenses may price an otherwise-allowed edge more
      // conservatively, but they never change legality or reported safety.
      let mulC = cMul[a];
      if (mulC !== mulC) {
        // The requireSafe access surcharge is applied LIVE below, never
        // stored: rulesSignature excludes requireSafe (so the strict probe
        // shares this slot with the ordinary config), and a stored x30 would
        // poison the shared slot for every later ordinary search.
        cMul[a] = edgeCostParts(ei, forward, mode, modeW, rules,
          searchRules, prefDesig, prefResidential,
          (fl & 32) && nodeHasLand[u] ? activeWeights.ferryWaitMin * 60 : 0,
          false);
        cAdd[a] = partsSteep + partsSurf;
        cDivOk[a] = partsDivOk;
        // Read BACK through the Float32 store: the filling search must price
        // an arc exactly as every later cache hit will, or a cold and a warm
        // run of the same request could disagree in the last float digit.
        mulC = cMul[a];
      }
      let cost;
      if (actualLevel === 4 && mulC < Infinity && walkAccessEdge(ei)) {
        // Walked sidewalk escape: real walking time, no fail multipliers,
        // no climb or surface additives (walking pace shrugs at both). The
        // transition charges below still apply — arrival friction is real
        // on foot too. The mulC guard keeps this a price change, never a
        // legality change: an edge the chain excludes stays excluded.
        // Walking (0.87 s/m) sits far above edgeCostFloor's best ride, so
        // every cached bound stays admissible untouched.
        cost = eLen[ei] / V_DISMOUNT;
      } else {
        cost = diversityEdges && cDivOk[a] && diversityEdges.has(ei)
          ? mulC * diversityFactor : mulC;
        if (progressPenaltySecPerM > 0) {
          const awayM = progressDistanceM(v) - progressFromGoalM;
          if (awayM > 0) cost += awayM * progressPenaltySecPerM;
        }
        // An exempted terminal-access block is a last resort, never a shortcut
        // (multiplicative, so applying it here equals applying it inside the
        // chain; the additive terms below are rightly exempt).
        if (rules.requireSafe && actualLevel === 4) cost *= 30;
        cost += cAdd[a];
      }
      cost += dismountEntryPenaltyS(incomingEdge, ei);
      cost += freewayEntryPenaltyS(incomingEdge, ei);
      cost += facilityGapEntryPenaltyS(incomingEdge, ei);
      cost += turnPreferenceS(incomingEdge, u, ei, mode);
      cost += uncontrolledCrossPenaltyS(incomingEdge, u, ei, rules, mode);
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
    mergeFrontierHits(legFrontierHits, Infinity);
    // Before declaring the network disconnected, test whether an endpoint is
    // the real reason: a destination inside an enter-proof pocket, or a start
    // inside a leave-proof one. If so, correct the snap in place -- shared
    // snap objects carry the fix to every later profile -- and search once
    // more. Only a genuine disconnection reaches the message below.
    if (pocketRetry === 0 && adjustPocketSnaps(s, t, startLL, endLL, rules)) {
      return routeLeg(startLL, endLL, rules, mode, prefDesig, prefResidential,
        s, t, diversityEdges, diversityFactor, searchRules,
        blockedCrossingEdges, crossingRetry, progressPenaltySecPerM, 1);
    }
    return {
      ok: false,
      reason: rules.requireSafe
        ? 'No route fully matching your safety rules exists — relax a rule, or turn off “Only show routes fully matching safety rules”.'
        : 'No route exists on the rideable network between these points.',
    };
  }

  // Weighted A* guarantees the found cost is within SEARCH_OVERSHOOT of the
  // optimum. A frontier with a larger admissible lower bound cannot improve or
  // diversify this search enough to justify another partition fetch.
  mergeFrontierHits(legFrontierHits, searchDist[foundArc] * SEARCH_OVERSHOOT);

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
  let desigM = 0, residentialM = 0, freewayM = 0, limitedAccessM = 0;
  let facilityM = 0, trailM = 0, mtbM = 0, dismountM = 0;
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
    // Same predicate and same walking time the search priced this arc with,
    // so the reported route cannot disagree with the one the search chose.
    const walkAccess = walkAccessEdge(ei) && edgeLevelFor(ei, rules, forward) === 4;
    let segTimeS = walkAccess ? eLen[ei] / V_DISMOUNT : edgeTimeS(ei, forward);
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
    if (designatedEdge(ei, eFlags[ei])) desigM += eLen[ei];
    // >= 2, not >= 1: facility 1 is a sharrow, which is paint in a shared lane
    // and must not count toward the route's bike-facility mileage.
    if (edgeFacility(ei, forward) >= 2) facilityM += eLen[ei];
    if (eFlags[ei] & 8) trailM += eLen[ei];
    if (eOfficial[ei] & EDGE_MTB) mtbM += eLen[ei];
    if (isDismountEdge(ei) || walkAccess) dismountM += eLen[ei];
    if (!(eFlags[ei] & (8 | 32 | 4)) && !edgeLimited(ei, forward)
        && isResidential(ei)) residentialM += eLen[ei];
    if (eFlags[ei] & 4) freewayM += eLen[ei];
    else if (edgeLimited(ei, forward)) limitedAccessM += eLen[ei];
    const verdict = SafetyModel.evaluate(edgeFacts(ei, forward), rules);
    // A dismount stretch reports as CAUTION in the route's numbers and its
    // segments, matching the amber it is drawn with and the walker markers
    // over it -- unless the road fails outright anyway. When dismount is what
    // elevated the level, it is also the cause the Concerns list names
    // ('dismount' is already in SafetyModel.CAUTION_CAUSES). A walked
    // sidewalk escape reports the same way from the other side: the road
    // fails, but the rider walks it, so the stretch is a caution-level
    // dismount rather than failing mileage — that is the freebie.
    const dismountHere = isDismountEdge(ei);
    const facilityGap = isFacilityGapEdge(ei);
    const level = walkAccess ? 3
      : (dismountHere || facilityGap) && verdict.level < 3 ? 3 : verdict.level;
    const cautionCause = level !== 3 ? null
      : (walkAccess ? 'dismount'
        : facilityGap ? 'facility-gap'
          : (verdict.level < 3 ? 'dismount' : (verdict.caution || (dismountHere ? 'dismount' : null))));
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
      ...edgeJurisdiction(ei),
      mph: edgeSpeed(ei, forward), sh: edgeShoulder(ei, forward),
      // The other direction's shoulder, so a card can say "(your direction)"
      // when the two sides differ instead of silently contradicting the road
      // card, which shows the worse of the two.
      shBack: edgeShoulder(ei, !forward),
      flags: eFlags[ei] | (edgeLimited(ei, forward) ? 128 : 0), roadClass: eClass[ei],
      // The direction actually ridden, same contract as sh/shBack: a lane on
      // one side of a two-way street must not describe the other side's ride.
      facility: edgeFacility(ei, forward), facilityOther: edgeFacility(ei, !forward),
      official: eOfficial[ei], mtb: !!(eOfficial[ei] & EDGE_MTB),
      // walkAccess rides the dismount display channel (amber, walker
      // markers) but keeps its own flag so slicing can re-derive levels
      // without losing which segs were endpoint walks.
      dismount: dismountHere || walkAccess, walkAccess, facilityGap, level, cautionCause,
      surface: eSurface[ei] & 15, surfaceLabel: SURFACE_LABEL[eSurface[ei] & 15] || SURFACE_LABEL[SURFACE_UNKNOWN],
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
      s, t, diversityEdges, diversityFactor, searchRules, blocked, crossingRetry + 1,
      progressPenaltySecPerM);
  }
  const ferrySegs = ferryRanges.map(([a, b]) => coords.slice(a, b + 1));
  failM += escalateLongDismounts(segs, levelM);
  const gradeStats = routeGradeStats(segs);
  return {
    ok: true, coords, distM, timeS, ascentM, descentM, failM, ferryM, ferrySegs,
    desigM, residentialM, freewayM, limitedAccessM, facilityM, trailM,
    mtbM, dismountM, hazardM,
    levelM, edgeIds, nodeIds, segs, ...routeJurisdictionFields(segs), ...gradeStats,
    profile, snapStartM: s.distM, snapEndM: t.distM, ms: Date.now() - t0,
  };
}

// Route through an ordered list of points (A -> B -> C ...): one A* per leg,
// results merged into a single continuous route.
function route(points, rules, mode, prefDesig, prefResidential, snaps,
  diversityEdges = null, diversityFactor = 1, searchRules = rules,
  progressPenaltySecPerM = 0) {
  const t0 = Date.now();
  const legs = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const leg = routeLeg(points[i], points[i + 1], rules, mode, prefDesig, prefResidential,
      snaps?.[i], snaps?.[i + 1], diversityEdges, diversityFactor, searchRules,
      null, 0, progressPenaltySecPerM);
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
    desigM: l.desigM, facilityM: l.facilityM, trailM: l.trailM || 0, mtbM: l.mtbM || 0,
    dismountM: l.dismountM || 0, residentialM: l.residentialM,
    freewayM: l.freewayM, limitedAccessM: l.limitedAccessM, hazardM: l.hazardM || 0,
    avgUphillPct: l.avgUphillPct || 0, maxGradePct: l.maxGradePct || 0,
  }));
  const edgeIds = [], nodeIds = [];
  const levelM = [0, 0, 0, 0, 0];
  let distM = 0, timeS = 0, ascentM = 0, descentM = 0, failM = 0, ferryM = 0;
  let hazardM = 0;
  let desigM = 0, residentialM = 0, freewayM = 0, limitedAccessM = 0;
  let facilityM = 0, trailM = 0, mtbM = 0, dismountM = 0;
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
    limitedAccessM += leg.limitedAccessM; facilityM += leg.facilityM;
    trailM += leg.trailM || 0; mtbM += leg.mtbM || 0;
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
  failM += escalateLongDismounts(segs, levelM);
  const gradeStats = routeGradeStats(segs);
  return {
    ok: true, coords, distM, timeS, ascentM, descentM, failM, ferryM, ferrySegs,
    desigM, residentialM, freewayM, limitedAccessM, facilityM, trailM,
    mtbM, dismountM, hazardM,
    levelM, edgeIds, nodeIds, segs, ...routeJurisdictionFields(segs), ...gradeStats,
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
  const segs = sourceSegs.map((seg, index) => {
    const ei = sourceEdgeIds[index];
    const forward = eA[ei] === nodeIds[index];
    const rawLevel = edgeLevel(ei, rules, forward);
    // A walked sidewalk escape is positional — it depended on the ORIGINAL
    // leg's endpoints — so the slice preserves the source seg's flag rather
    // than re-deriving what it cannot know.
    const walkAccess = !!seg.walkAccess;
    const dismount = isDismountEdge(ei) || walkAccess;
    const facilityGap = isFacilityGapEdge(ei);
    const level = walkAccess ? 3
      : (dismount || facilityGap) && rawLevel < 3 ? 3 : rawLevel;
    return {
      ...seg,
      c0: seg.c0 - coordStart,
      c1: seg.c1 - coordStart,
      hazC0: seg.hazC0 == null ? null : seg.hazC0 - coordStart,
      hazC1: seg.hazC1 == null ? null : seg.hazC1 - coordStart,
      dismount, facilityGap, level,
      cautionCause: level !== 3 ? null
        : (walkAccess ? 'dismount'
          : facilityGap ? 'facility-gap'
            : (rawLevel < 3 ? 'dismount' : (seg.cautionCause || (dismount ? 'dismount' : null)))),
    };
  });
  const ferryRanges = [];
  const profile = [[0, nodeEle[nodeIds[0]]]];
  const levelM = [0, 0, 0, 0, 0];
  let distM = 0, timeS = 0, ascentM = 0, descentM = 0, failM = 0, ferryM = 0;
  let hazardM = 0;
  let desigM = 0, residentialM = 0, freewayM = 0, limitedAccessM = 0;
  let facilityM = 0, trailM = 0, mtbM = 0, dismountM = 0;
  for (let index = 0; index < sourceEdgeIds.length; index++) {
    const ei = sourceEdgeIds[index], fromNode = nodeIds[index];
    const forward = eA[ei] === fromNode;
    const seg = segs[index];
    distM += eLen[ei];
    let segTimeS = seg.walkAccess ? eLen[ei] / V_DISMOUNT : edgeTimeS(ei, forward);
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
    if (designatedEdge(ei, eFlags[ei])) desigM += eLen[ei];
    // >= 2, not >= 1: facility 1 is a sharrow, which is paint in a shared lane
    // and must not count toward the route's bike-facility mileage.
    if (edgeFacility(ei, forward) >= 2) facilityM += eLen[ei];
    if (eFlags[ei] & 8) trailM += eLen[ei];
    if (eOfficial[ei] & EDGE_MTB) mtbM += eLen[ei];
    if (isDismountEdge(ei) || seg.walkAccess) dismountM += eLen[ei];
    if (!(eFlags[ei] & (8 | 32 | 4)) && !edgeLimited(ei, forward)
        && isResidential(ei)) residentialM += eLen[ei];
    if (eFlags[ei] & 4) freewayM += eLen[ei];
    else if (edgeLimited(ei, forward)) limitedAccessM += eLen[ei];
    // Same dismount-as-caution elevation as the primary route builder above,
    // so a rebuilt summary cannot disagree with the original one.
    const rawLevel = edgeLevel(ei, rules, forward);
    const level = seg.walkAccess ? 3
      : (isDismountEdge(ei) || isFacilityGapEdge(ei)) && rawLevel < 3
        ? 3 : rawLevel;
    levelM[level] += eLen[ei];
    if (level === 4) failM += eLen[ei];
    hazardM += Number(seg.hazardLenM) || 0;
    profile.push([distM, nodeEle[nodeIds[index + 1]]]);
  }
  failM += escalateLongDismounts(segs, levelM);
  const gradeStats = routeGradeStats(segs);
  return {
    ok: true, coords, distM, timeS, ascentM, descentM, failM, ferryM,
    ferrySegs: ferryRanges.map(([a, b]) => coords.slice(a, b + 1)),
    desigM, residentialM, freewayM, limitedAccessM, facilityM, trailM,
    mtbM, dismountM, hazardM,
    levelM, edgeIds: sourceEdgeIds, nodeIds, segs, profile,
    ...routeJurisdictionFields(segs), ...gradeStats,
    snapStartM: 0, snapEndM: 0, ms: 0,
  };
}

function routeSummary(routeResult) {
  return {
    distM: routeResult.distM, timeS: routeResult.timeS, failM: routeResult.failM,
    desigM: routeResult.desigM, facilityM: routeResult.facilityM,
    trailM: routeResult.trailM || 0,
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
  let desigM = 0, residentialM = 0, freewayM = 0, limitedAccessM = 0;
  let facilityM = 0, trailM = 0, mtbM = 0, dismountM = 0;
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
    limitedAccessM += part.limitedAccessM; facilityM += part.facilityM;
    trailM += part.trailM || 0; mtbM += part.mtbM || 0;
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
  failM += escalateLongDismounts(segs, levelM);
  const gradeStats = routeGradeStats(segs);
  const merged = {
    ok: true, coords, distM, timeS, ascentM, descentM, failM, ferryM, ferrySegs,
    desigM, residentialM, freewayM, limitedAccessM, facilityM, trailM,
    mtbM, dismountM, hazardM,
    levelM, edgeIds, nodeIds, segs, profile: prof, snapStartM, snapEndM,
    ...routeJurisdictionFields(segs), ...gradeStats,
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

// A named Preferred route is a request to foreground that corridor, not to
// erase every other useful answer. Run three otherwise-identical Balanced
// searches: the rider-adjustable strong pull, a geometric midpoint toward
// ordinary pricing, and a neutral search with the per-route exception removed.
// The ordinary profile grid still runs as before; these are small, explicit
// anchors that stop one strong preference from collapsing the whole portfolio.
function preferredRouteSpectrum(strong = activeWeights.preferredRoute) {
  const clampedStrong = Math.min(1, Math.max(0.05, Number(strong) || 1));
  return [
    { id: 'preferred-strong', label: 'Strong Preferred route',
      strength: 'strong', multiplier: clampedStrong },
    { id: 'preferred-moderate', label: 'Moderate Preferred route',
      strength: 'moderate', multiplier: Math.sqrt(clampedStrong) },
    { id: 'preferred-neutral', label: 'Preferred-route alternative',
      strength: 'neutral', multiplier: 1 },
  ];
}

// Metres of a candidate that ride a Preferred route. designatedEdge() is the
// same gate trustRouteEdge() applies, so a Preferred route whose source the
// rider switched off measures zero rather than winning the strong-Preferred
// seat with ground nothing is actually pricing.
function preferredRouteMeters(candidate) {
  if (!preferredEdges || !candidate?.edgeIds) return 0;
  let meters = 0;
  for (const edge of candidate.edgeIds) {
    if (preferredEdges[edge] === 1 && designatedEdge(edge, eFlags[edge])) meters += eLen[edge];
  }
  return meters;
}

function bestStrongPreferredCandidate(candidates) {
  return candidates.filter((candidate) =>
    candidate._profile?.preferredRouteStrength === 'strong'
      && preferredRouteMeters(candidate) > 0)
    .reduce((best, candidate) => !best
      || recommendationScore(candidate) < recommendationScore(best)
      || (recommendationScore(candidate) === recommendationScore(best)
        && preferredRouteMeters(candidate) > preferredRouteMeters(best))
      ? candidate : best, null);
}

function preferredStrengthRank(profile) {
  return profile?.preferredRouteStrength === 'strong' ? 3
    : profile?.preferredRouteStrength === 'moderate' ? 2
      : profile?.preferredRouteStrength === 'neutral' ? 1 : 0;
}

// A route can be locally cheap yet make a large move away from its destination
// to stay on a facility -- for example, riding across a bridge and back on the
// other side instead of using a short street connection. This measures the
// largest continuous retreat from the closest point reached so far. It is
// deliberately geometric and route-level: ordinary winding roads do not add
// up dozens of tiny bends into one false alarm.
function routeMaxRetreatM(candidate, destination) {
  if (!candidate?.coords?.length || !destination) return 0;
  let closestM = Infinity;
  let maxRetreatM = 0;
  for (const point of candidate.coords) {
    const remainingM = havM(point[0], point[1], destination[0], destination[1]);
    closestM = Math.min(closestM, remainingM);
    maxRetreatM = Math.max(maxRetreatM, remainingM - closestM);
  }
  return maxRetreatM;
}

const PROGRESS_LENS_SEC_PER_RETREAT_M = 0.25;
function addForwardProgressCandidate(raw, points, rules, forceDesig,
    forceResidential, snaps) {
  if (!raw.length || points.length !== 2) return null;
  const seed = raw.reduce((best, candidate) => candidate.timeS < best.timeS
    ? candidate : best, raw[0]);
  if (seed.ferryM > 0) return null;
  const straightM = havM(points[0][0], points[0][1], points[1][0], points[1][1]);
  const triggerM = Math.min(800, Math.max(180, straightM * 0.08));
  if (routeMaxRetreatM(seed, points[1]) < triggerM) return null;
  const progressRules = preferredRoutesActive(rules)
    ? withoutPreferredRouteSelection(rules) : rules;
  const profile = { id: 'forward-progress', label: 'Forward-progress alternative',
    mode: 'direct', prefDesig: forceDesig, prefResidential: forceResidential,
    order: 0.47, forwardProgress: true,
    preferredRouteStrength: progressRules === rules ? null : 'neutral' };
  const result = route(points, progressRules, profile.mode, profile.prefDesig,
    profile.prefResidential, snaps, null, 1, progressRules,
    PROGRESS_LENS_SEC_PER_RETREAT_M);
  if (!result.ok) return null;
  result._profile = profile;
  result.aggression = routeAggression(result);
  raw.push(result);
  return result;
}

// Equivalent geometry can be generated by several profiles. If normal dedupe
// keeps another profile for its explanation or selection continuity, retain
// the fact that this exact route was also found by the stronger Preferred lens.
function carryPreferredStrength(candidate, equivalent) {
  if (preferredStrengthRank(equivalent?._profile) <= preferredStrengthRank(candidate?._profile)) {
    return candidate;
  }
  candidate._profile = {
    ...candidate._profile,
    preferredRouteStrength: equivalent._profile.preferredRouteStrength,
    preferredRouteMultiplier: equivalent._profile.preferredRouteMultiplier,
  };
  return candidate;
}

function edgeOverlap(a, b) {
  const aSet = new Set(a.edgeIds);
  const bSet = new Set(b.edgeIds);
  let sharedM = 0;
  for (const edge of aSet) if (bSet.has(edge)) sharedM += eLen[edge];
  return sharedM / Math.max(1, Math.min(a.distM, b.distM));
}

function materialTradeoff(a, b) {
  // The rider's twinTradeoffX slider scales every threshold at once: below
  // 1, smaller outcome differences keep a near-twin; above 1 only large
  // ones do. At the default 1 this is exactly the shipped behaviour.
  const x = Math.min(3, Math.max(0.3, activeWeights.twinTradeoffX || 1));
  const routeScale = Math.max(250, Math.min(a.distM, b.distM) * 0.08) * x;
  // A short failing stretch can be the most important difference on a long
  // ride. Do not scale this threshold with total route length: doing so once
  // hid hundreds of feet of avoided rule failures as an "equivalent" route.
  return Math.abs(a.failM - b.failM) >= 60 * x
    || Math.abs(a.freewayM - b.freewayM) >= 60 * x
    || Math.abs(a.limitedAccessM - b.limitedAccessM) >= Math.max(120 * x, routeScale * 0.5)
    || Math.abs((a.mtbM || 0) - (b.mtbM || 0)) >= 40 * x
    || (!!a.dismountM !== !!b.dismountM)
    || Math.abs(a.facilityM - b.facilityM) >= routeScale
    || Math.abs((a.trailM || 0) - (b.trailM || 0)) >= routeScale
    || Math.abs((a.hazardM || 0) - (b.hazardM || 0)) >= 50 * x
    || Math.abs(a.desigM - b.desigM) >= routeScale
    || Math.abs(a.residentialM - b.residentialM) >= routeScale;
}

// Distinctness is measured in ROAD, not percentage alone. The old flat 4%
// floor meant a real road choice on a 200-mile trip (8 mi of different
// riding) but three blocks on a short one — offered options read as the
// same ride (field, 2026-08-26). Distinct now requires at least half a
// mile of different riding on the shorter route (field-tuned down from an
// initial 2 mi, which collapsed too much), as a fraction capped at 25% so
// very short trips can still offer close variants. Trips of ~12 miles and
// up keep the old 4% behaviour exactly.
function twinOverlapLimit(a, b) {
  const shorterM = Math.max(1, Math.min(a.distM, b.distM));
  // The rider's distinctRideMi slider; the 0.5 mi default is the 800 m
  // this shipped with. The 25% cap keeps short trips able to offer close
  // variants; the 4% floor keeps ~12 mi+ trips at the old behaviour.
  const distinctM = activeWeights.distinctRideMi * 1609.344;
  return 1 - Math.min(0.25, Math.max(0.04, distinctM / shorterM));
}
function meaningfullyDifferent(a, b) {
  const overlap = edgeOverlap(a, b);
  // Very-close paths survive only when their safety/facility outcome changes.
  return overlap < twinOverlapLimit(a, b) || (overlap < 0.99 && materialTradeoff(a, b));
}

function routeAggression(r) {
  const ridingM = Math.max(1, r.distM - r.ferryM);
  const levels = r.levelM || [0, 0, 0, 0, 0];
  const stress = (levels[2] * 0.18 + levels[3] * 0.75 + levels[4] * 3.5
    + r.freewayM * 4 + r.limitedAccessM * 0.8 + (r.hazardM || 0) * 1.1
    + (r.mtbM || 0) * 1.25 + (r.dismountM ? 450 + r.dismountM * 3 : 0)) / ridingM;
  // A trail is not merely another kind of lane: it removes motor-traffic
  // exposure altogether. Count physical facilities once, then give the
  // off-street portion a second, larger comfort credit.
  const friendlyCoverage = (r.desigM * 0.12 + r.facilityM * 0.08
    + (r.trailM || 0) * 0.12 + r.residentialM * 0.08) / ridingM;
  return stress - friendlyCoverage;
}

function compareSafety(a, b) {
  // Walking is a more severe route compromise than riding a short known
  // failure. Compare their weighted distances together first so a long
  // dismount cannot become the "safest" candidate merely by avoiding a few
  // metres of red road.
  const severeA = a.failM + (a.dismountM || 0) * 3;
  const severeB = b.failM + (b.dismountM || 0) * 3;
  if (severeA !== severeB) return severeA - severeB;
  // The remaining metrics break ties between routes with the same weighted
  // severe outcome.
  if (a.failM !== b.failM) return a.failM - b.failM;
  if (a.freewayM !== b.freewayM) return a.freewayM - b.freewayM;
  if ((a.mtbM || 0) !== (b.mtbM || 0)) return (a.mtbM || 0) - (b.mtbM || 0);
  if ((a.hazardM || 0) !== (b.hazardM || 0)) return (a.hazardM || 0) - (b.hazardM || 0);
  // A mandatory walk outranks a limited-access caution: it is the more
  // concrete compromise -- the rider is off the bike, not merely warned.
  if ((a.dismountM || 0) !== (b.dismountM || 0)) return (a.dismountM || 0) - (b.dismountM || 0);
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

// Letters run A..F by increasing distance, which is what a rider scanning a
// list expects. They deliberately carry no relation to the slot positions the
// selection above reasons about -- that ordering is by profile, and is internal.
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
  if (profile.crossBred) {
    return profile.crossBreedKind === 'ferry'
      ? 'Combined the practical and safer versions of the same ferry itinerary at shared terminals.'
      : profile.crossBreedKind === 'frontier'
        ? 'Combined non-dominated sections from existing candidates at exact shared road junctions.'
        : 'Combined sections of two existing candidates at an exact shared road junction.';
  }
  if (profile.fullyMatchingProbe) {
    return 'Strict probe: searched only road that fully matches your rules.';
  }
  // Before the fullyMatchingRules adoption tag: a clean facility-neutral
  // find is often ALSO the fastest fully-matching candidate, and its row
  // should say how it was found, not how it was later adopted.
  if (profile.facilityNeutral) {
    return 'Re-run with the pull of bike lanes, trails and signed routes halved,'
      + ' to surface a corridor that loses only because facility miles are priced shorter.'
      + ' Safety pricing and every shown stat still use your settings.';
  }
  if (profile.fullyMatchingRules) {
    return 'Searched only road that fully matches your rules.';
  }
  if (profile.discoveryMaxSpeed) {
    return `Discovery: same search with the no-shoulder speed dropped to ${profile.discoveryMaxSpeed} mph,`
      + ' to see whether a quieter corridor exists at all.';
  }
  if (profile.forwardProgress) {
    return 'Looked for a practical connection that avoids a large backtrack away from the destination.'
      + (profile.preferredRouteStrength === 'neutral'
        ? ' Ignored the Preferred-route pull so this remains a real alternative.' : '');
  }
  if (profile.preferredRouteStrength === 'strong') {
    return 'Strongly followed the route you marked Preferred.';
  }
  if (profile.preferredRouteStrength === 'moderate') {
    return 'Moderately favored the route you marked Preferred, allowing sensible departures.';
  }
  if (profile.preferredRouteStrength === 'neutral') {
    return 'Ignored the Preferred-route pull to preserve a genuinely different alternative.';
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
    // Stage-specific comparators for the "More" screen: who covered a
    // dominated route and by how much, which twin a duplicate matches, each
    // seated/near-miss candidate's closest offered route -- with `overlap`
    // as the shared-road fraction of the shorter route. Labels resolve
    // app-side from the shipped list by mateId.
    stageData: candidate._stageData || null,
    distM: candidate.distM,
    timeS: candidate.timeS,
    failM: candidate.failM,
    refinedFrom: candidate._profile.refinedFrom || null,
    preferredRouteStrength: profile.preferredRouteStrength || null,
    forwardProgress: !!profile.forwardProgress,
    crossBred: !!profile.crossBred,
    crossBreedKind: profile.crossBreedKind || null,
    sectionFrontier: !!profile.sectionFrontier,
    levelM: candidate.levelM,
    facilityM: candidate.facilityM,
    trailM: candidate.trailM || 0,
    desigM: candidate.desigM,
    residentialM: candidate.residentialM,
    unpavedM: candidate.unpavedM || 0,
    ferryM: candidate.ferryM || 0,
    ascentM: candidate.ascentM || 0,
    // Caution mileage the official traffic-stress rating caused, so the
    // description layer can say a caution-heavy route is mostly heavy
    // traffic (field ask, 2026-08-27).
    highStressM: (candidate.segs || []).reduce((sum, seg) =>
      sum + (seg.cautionCause === 'high-stress' ? (Number(seg.lenM) || 0) : 0), 0),
    suggestionScore: recommendationScoreBreakdown(candidate),
    safetyEquivalentM: candidate.failM + (candidate.dismountM || 0) * 3,
    preferredRouteM: preferredRouteMeters(candidate),
    preferredRouteMultiplier: profile.preferredRouteStrength === 'neutral' ? 1
      : (Number.isFinite(profile.preferredRouteMultiplier)
        ? profile.preferredRouteMultiplier : null),
    shape: candidateShape(candidate),
    stateIds: candidate.stateIds || [],
    partitionIds: candidate.partitionIds || [],
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
      preferredRouteStrength: _profile.preferredRouteStrength || null,
      alternativeCorridor: !!_profile.alternativeCorridor,
      crossBred: !!_profile.crossBred,
      sectionFrontier: !!_profile.sectionFrontier,
      directLens: !!_profile.directLens,
      forwardProgress: !!_profile.forwardProgress,
      discoveryMaxSpeed: _profile.discoveryMaxSpeed || null,
      // This describes the route RESULT, not merely whether it came from the
      // strict probe. Ordinary searches often discover an all-matching route
      // too, and the rider should be told the same truth about it.
      fullyMatchingRules: candidate.failM <= 0.5,
      fullyMatchingProbe: !!_profile.fullyMatchingProbe,
      recommended: !!_outcome?.recommended,
    },
  };
}

function configurePartitionFrontiers(frontiers) {
  configuredFrontiers = new Map();
  for (const frontier of Array.isArray(frontiers) ? frontiers : []) {
    const node = Number(frontier?.node);
    if (!Number.isInteger(node) || node < 0 || node >= N) continue;
    if (!configuredFrontiers.has(node)) configuredFrontiers.set(node, []);
    configuredFrontiers.get(node).push({
      portalId: String(frontier.portalId || ''),
      adjacentPartitionId: String(frontier.adjacentPartitionId || ''),
      adjacentStateId: String(frontier.adjacentStateId || ''),
    });
  }
}

function beginFrontierRequest() { requestFrontierHits = new Map(); }

function mergeFrontierHits(hits, ceiling) {
  if (suppressFrontierHitRecording) return;
  for (const [node, lowerBound] of hits) {
    if (!(lowerBound <= ceiling)) continue;
    const previous = requestFrontierHits.get(node);
    if (previous == null || lowerBound < previous) requestFrontierHits.set(node, lowerBound);
  }
}

function publicFrontierHits() {
  return [...requestFrontierHits]
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .map(([node, lowerBound]) => ({ node, lowerBound,
      exits: configuredFrontiers.get(node) || [] }));
}

function conservativeDiscoveryRules(rules) {
  // One speed since the urban/rural split was collapsed; the shared model still
  // reads the old keys so a rider on saved settings is not stranded.
  const current = SafetyModel.noShoulderMaxSpeed({}, rules);
  const stricter = Math.max(20, Math.min(30, current - 5));
  return stricter < current ? { ...rules, maxSpeedNoShoulder: stricter } : null;
}

// Add a small, bounded set of stricter searches to the candidate pool. These
// searches only discover geometry; route reconstruction, safety metrics, and
// map colors continue to use the rider's actual rules.
function addDiscoveryCandidates(raw, points, rules, forceDesig, forceResidential, snaps, progress = null) {
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
  progress?.('Trying discovery profiles on calmer roads… (1 of 2)', 0.63);
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
  progress?.('Trying discovery profiles on calmer roads… (2 of 2)', 0.72);
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

// The star pays a PRICE for fail avoidance instead of granting it a veto.
// This used to be compareSafety() -- lexicographic, so any reduction in
// absolute failing meters beat any amount of time within the practical
// window. On Seattle-Everett that recommended 40.4 mi / 3h19 over
// 33.0 mi / 2h43 to avoid 651 m of failing shoulder: a 36-minute detour
// for a difference that rounds to the same "1% fails" on both cards. At
// one second per meter, avoiding a full mile of failing road is worth up
// to ~27 minutes of extra riding -- and no more. Ties still break toward
// the strictly safer route, and the strictly safest candidate keeps its
// own lettered slot regardless (safestOverall, below).
const FAIL_AVOID_PRICE_S_PER_M = 1;
// A mandatory walk is worse than riding a short known failure. Its honest
// walking time is already inside timeS; this additional distance price keeps
// a long walk from winning the star merely because it removes a small amount
// of red road.
const DISMOUNT_AVOID_PRICE_S_PER_M = 3;
//
// Ride QUALITY gets a vote too. Every riding meter that is neither trail nor
// trusted lane (facilityM counts facility >= 2, so sharrows never qualify;
// ferries are removed as not-riding) costs a fifth of a second. A dedicated
// trail earns another 0.08 s/m over a lane because it removes motor-traffic
// exposure altogether. Sized from the field: 31.8 mi / 2h39 at 64%
// trails-and-lanes was starred over 36.1 mi / 3h00 at 90% -- the star
// saved 21 minutes by spending 12 extra kilometers alongside traffic,
// and the rider's verdict was "I'd rather be recommended routes like
// this" about the other one. At 0.2 s/m, a mile of ordinary road is
// worth about five and a half minutes of detour on better ground.
const NETWORK_GAP_PRICE_S_PER_M = 0.2;
// Was 0.12, which priced the score indifferent between 1 m of ordinary road
// and 5.6 m of trail: at ~0.19 s/m of riding, an ordinary meter costs 0.39 s
// and a trail meter 0.07 s. That ratio was sized on a case where the trail
// route was 13% longer, and it also authorised Lake Forest Park -> Woodland
// Park Zoo at 13.11 mi / 66 min over a 9.46 mi / 49 min option with ZERO
// failing meters -- 3.65 extra miles bought not to avoid danger but to avoid
// ordinary legal streets. At 0.08 the exchange is about 3.5 m of trail per
// meter of road: still a deliberate pull toward trail, and deliberately not
// a cap on how far a trail route may wander (the rider's verdict is that
// long trail-heavy recommendations are welcome), just a gentler rate.
// Rider's call, 2026-08-19.
const TRAIL_BONUS_S_PER_M = 0.08;
function recommendationScoreBreakdown(route) {
  const travelS = route.timeS;
  const failS = route.failM * FAIL_AVOID_PRICE_S_PER_M;
  const dismountS = (route.dismountM || 0) * DISMOUNT_AVOID_PRICE_S_PER_M;
  const ordinaryRoadM = Math.max(0, route.distM - route.ferryM - route.facilityM);
  const ordinaryRoadS = ordinaryRoadM * NETWORK_GAP_PRICE_S_PER_M;
  const trailCreditS = (route.trailM || 0) * TRAIL_BONUS_S_PER_M;
  return {
    totalS: travelS + failS + dismountS + ordinaryRoadS - trailCreditS,
    travelS, failS, dismountS, ordinaryRoadS, trailCreditS, ordinaryRoadM,
  };
}
const recommendationScore = (route) => recommendationScoreBreakdown(route).totalS;

// The fail-share guard: never star a route carrying far more failing road than
// an option shown beside it. Factored out of routeOptions so it can be
// exercised directly, and it needs that because it fires rarely -- roughly one
// trip in thirty. It was once recorded here as having "not fired once across 86
// audited trips", and on that claim it was deleted in v.769; instrumenting the
// live worker over the 30-trip round-5 corpus caught it firing on Tillamook ->
// Pacific City, moving the star from 45.9 km / 154 min / 19.8% failing to
// 51.2 km / 186 min / 6.4%. Restored in v.770. Rare is not the same as
// unreachable, and the way to tell them apart is to instrument the real thing
// rather than reason about anti-correlated tests.
//
// It draws from the FULL candidate list on purpose, not the priced pool. The
// pool is bounded against the fastest route, so the very alternative worth
// having is often outside it: McMinnville -> Newberg came 454 m of failing road
// short of firing with four qualifying alternatives waiting, every one of them
// unpriced. Catching what the practical window excludes is the whole job.
const GUARD_FAIL_SHARE = 0.15;        // of the starred route's own length
const GUARD_ALTERNATIVE_SHARE = 0.4;  // the alternative's fail, against the star's
function failShareGuardPick(recommended, choices) {
  if (!recommended || !(recommended.distM > 0)) return null;
  if (recommended.failM < recommended.distM * GUARD_FAIL_SHARE) return null;
  // The same "wider but sane detour" the fully-matching override uses,
  // measured against the STAR: the question is whether a route of comparable
  // length avoids what this one rides.
  const saferComparable = choices.filter((route) => route !== recommended
    && route.failM <= recommended.failM * GUARD_ALTERNATIVE_SHARE
    && route.legs.length === recommended.legs.length
    && route.legs.every((leg, index) => {
      const starLeg = recommended.legs[index];
      return leg.distM <= starLeg.distM * 1.8 + 1600
        && leg.timeS <= starLeg.timeS * 1.85 + 600;
    }));
  return saferComparable.reduce((best, route) =>
    !best || recommendationScore(route) < recommendationScore(best) ? route : best, null);
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
function addAdaptiveFerryCandidates(raw, rules, forceDesig, forceResidential, searchRules, progress = null) {
  if (!searchRules) return;
  // TWO representatives per distinct boat plan: the safest AND the best
  // priced. Keeping only the safest hid exactly the candidate the rider is
  // starred onto -- quick-friendly shared a ferry signature with a calmer
  // sibling, so the mainstream itinerary was never available to refine.
  const itinerarySeeds = new Map();
  for (const candidate of raw) {
    if (candidate._profile.discoveryMaxSpeed) continue;
    const signature = ferrySignature(candidate);
    if (!signature) continue;
    const entry = itinerarySeeds.get(signature) || {};
    if (!entry.safest || compareSafety(candidate, entry.safest) < 0) entry.safest = candidate;
    if (!entry.practical
        || recommendationScore(candidate) < recommendationScore(entry.practical)) {
      entry.practical = candidate;
    }
    itinerarySeeds.set(signature, entry);
  }
  if (!itinerarySeeds.size) return;
  const seedPool = [...new Set([...itinerarySeeds.values()]
    .flatMap((entry) => [entry.safest, entry.practical]))];
  const safestSeed = seedPool.reduce((best, candidate) =>
    compareSafety(candidate, best) < 0 ? candidate : best);
  // Refine the PRACTICAL itinerary too. Seeding only the safest one built
  // hybrids on top of its long calm legs -- on Seattle -> Port Townsend the
  // adaptive hybrid landed at 88.7 mi, nearly the longest offering, while
  // the rider's ask was the opposite composition: the starred 71 mi route
  // with ONLY its traffic-heavy Whidbey section becalmed. The best-priced
  // seed produces exactly those hybrids; the ladder then carries both
  // families and dedupe drops whichever collapsed together.
  const practicalSeed = seedPool.reduce((best, candidate) =>
    recommendationScore(candidate) < recommendationScore(best) ? candidate : best);
  // And the rider's MAINSTREAM itinerary: the best-priced can be a bold one
  // (on Seattle -> Port Townsend it was a 10%-failing sprint), and the
  // itinerary the star actually sits on -- practical AND broadly within the
  // rules -- refined by neither seed above. Its becalmed hybrid is the one
  // the rider keeps asking for.
  const lowFailSeed = seedPool.filter((candidate) => candidate.failM <= candidate.distM * 0.05)
    .reduce((best, candidate) =>
      !best || recommendationScore(candidate) < recommendationScore(best) ? candidate : best, null);
  const seeds = new Set([safestSeed, practicalSeed]);
  if (lowFailSeed) seeds.add(lowFailSeed);
  for (const seed of seeds) {
    refineFerrySeed(seed, raw, rules, forceDesig, forceResidential, searchRules, progress);
  }
  // CROSS-BREED same-boat candidates: the pool can already hold one route
  // with the better mainland and another with the better island, and no
  // search will ever produce their combination -- field case (Seattle ->
  // Port Townsend): the practical hybrid rode trail all the way to Mukilteo
  // but crossed Whidbey direct, a calm full-length candidate crossed
  // Whidbey beautifully and wasted the mainland, and neither letter offered
  // both. Two routes sharing a ferry signature cut at identical terminal
  // nodes, so their land sections splice WITHOUT a single new search: take
  // the practical representative, swap in the safest one's section, one
  // section at a time. Dedupe, the reasonable-time bound and selection
  // judge the offspring like any other candidate.
  for (const entry of itinerarySeeds.values()) {
    if (!entry.practical || !entry.safest || entry.practical === entry.safest) continue;
    crossBreedFerryCandidates(entry.practical, entry.safest, raw, rules);
  }
}

// Splice one land section of `donor` into `base`. Both share a ferry
// signature, so every section boundary is the same terminal node.
function crossBreedFerryCandidates(base, donor, raw, rules) {
  const baseGroups = ferryEdgeGroups(base);
  const donorGroups = ferryEdgeGroups(donor);
  if (!baseGroups.length || baseGroups.length !== donorGroups.length) return;
  const cut = (route, groups) => {
    const landRanges = [];
    const ferryParts = [];
    let cursor = 0;
    for (const group of groups) {
      landRanges.push({ start: cursor, end: group.start });
      ferryParts.push(routeFragment(route, group.start, group.end, rules));
      cursor = group.end;
    }
    landRanges.push({ start: cursor, end: route.edgeIds.length });
    return { landParts: landRanges.map(({ start, end }) => routeFragment(route, start, end, rules)),
      ferryParts };
  };
  const basePieces = cut(base, baseGroups);
  const donorPieces = cut(donor, donorGroups);
  for (let landIndex = 0; landIndex < basePieces.landParts.length; landIndex++) {
    const mine = basePieces.landParts[landIndex];
    const theirs = donorPieces.landParts[landIndex];
    if (!mine || !theirs || theirs.distM < 1000) continue;
    if (!meaningfullyDifferent(theirs, mine)) continue;
    // `donor` is safer over the whole itinerary, but that does not imply each
    // one of its land sections is an improvement. Only splice a section that
    // is actually safer or better-priced than the corresponding base section;
    // otherwise this pass can reserve a slot for the donor's bad mainland
    // while missing the exact practical-mainland / safe-island composition it
    // exists to build.
    mine.aggression = routeAggression(mine);
    theirs.aggression = routeAggression(theirs);
    if (compareSafety(theirs, mine) >= 0
        && recommendationScore(theirs) + 5 >= recommendationScore(mine)) continue;
    const parts = [];
    for (let index = 0; index < basePieces.landParts.length; index++) {
      const landPart = index === landIndex ? theirs : basePieces.landParts[index];
      if (landPart) parts.push(landPart);
      if (index < basePieces.ferryParts.length && basePieces.ferryParts[index]) {
        parts.push(basePieces.ferryParts[index]);
      }
    }
    const hybrid = mergeRouteParts(parts, base.snapStartM, base.snapEndM);
    hybrid._profile = {
      id: `adaptive-corridor${raw.some((r) => r._profile.id.startsWith('adaptive-corridor'))
        ? `-${raw.filter((r) => r._profile.id.startsWith('adaptive-corridor')).length + 1}` : ''}`,
      label: 'Adaptive corridor', mode: 'balanced', prefDesig: true, prefResidential: true,
      order: base._profile.order + 0.06 + landIndex * 0.01,
      alternativeCorridor: true,
      crossBred: true,
      crossBreedKind: 'ferry',
      replacedLandSection: landIndex,
      refinedFrom: `${base._profile.id}+${donor._profile.id}`,
    };
    hybrid.aggression = routeAggression(hybrid);
    raw.push(hybrid);
  }
}

// Ordinary route candidates can contain the same local complement as the
// ferry field case: one found the better first half, another found the better
// second half, and a global cost profile never asked for that combination.
// Ferries make the splice points obvious (their terminal nodes). Away from a
// ferry, use only EXACT graph nodes shared by both paths -- two lines crossing
// on the map are not necessarily connected road.
//
// Keep this deliberately bounded. Cross-breeding is a cheap path operation,
// not another search, but an unrestricted all-pairs/all-junction pass would
// still fill the troubleshooting record with arbitrary combinations. Ten
// distinct parents means at most 45 pairs; each pair contributes only its
// best-priced and safest useful child, and at most six children enter `raw`.
const GENERAL_CROSS_BREED_MAX_SEEDS = 10;
const GENERAL_CROSS_BREED_MAX_RESULTS = 6;
const GENERAL_CROSS_BREED_MIN_PART_M = 1000;

// A second, more general composition pass searches only the compact UNION of
// edges already found by strong candidates. It can switch parents more than
// once at exact graph junctions, unlike the one-cut breeder below, while never
// paying for another statewide search. Eight Pareto labels per union node keeps
// the work and memory bounded on a phone. Ferry routes are grouped by their
// exact boat-edge signature so composition can improve land sections without
// silently changing, skipping, or repeating a crossing.
const SECTION_FRONTIER_MAX_SEEDS = 10;
const SECTION_FRONTIER_LABELS_PER_NODE = 8;
const SECTION_FRONTIER_MAX_RESULTS = 6;
const SECTION_FRONTIER_KEYS = [
  'failM', 'dangerM', 'cautionM', 'gapM', 'nonTrailM', 'roughM',
  'ascentM', 'timeS', 'distM',
];

function emptySectionFrontierMetrics() {
  return { failM: 0, dangerM: 0, cautionM: 0, gapM: 0, nonTrailM: 0, roughM: 0,
    ascentM: 0, timeS: 0, distM: 0 };
}

function addSectionFrontierMetrics(first, second) {
  const total = {};
  for (const key of SECTION_FRONTIER_KEYS) total[key] = first[key] + second[key];
  return total;
}

function sectionFrontierDominates(first, second) {
  let strictly = false;
  for (const key of SECTION_FRONTIER_KEYS) {
    if (first[key] > second[key]) return false;
    if (first[key] < second[key]) strictly = true;
  }
  return strictly;
}

function compareSectionFrontierSafety(first, second) {
  return first.failM - second.failM
    || first.dangerM - second.dangerM
    || first.cautionM - second.cautionM
    || first.roughM - second.roughM
    || first.gapM - second.gapM
    || first.nonTrailM - second.nonTrailM
    || first.ascentM - second.ascentM
    || first.timeS - second.timeS;
}

function sectionFrontierPracticalScore(metrics) {
  // This is only an exploration/ranking key inside the already-small union,
  // not a new safety verdict. Failures and concrete danger lead; ordinary-road
  // exposure, climbing and time keep the answer usable rather than absolute.
  return metrics.timeS + metrics.failM * 2 + metrics.dangerM * 0.35
    + metrics.cautionM * 0.2 + metrics.gapM * 0.08 + metrics.nonTrailM * 0.12
    + metrics.roughM * 0.2
    + metrics.ascentM * 0.6;
}

function selectSectionFrontierLabels(labels, limit = SECTION_FRONTIER_LABELS_PER_NODE) {
  if (labels.length <= limit) return labels;
  const chosen = [];
  const add = (label) => { if (label && !chosen.includes(label)) chosen.push(label); };
  const minimum = (compare) => labels.reduce((best, label) => compare(label, best) < 0 ? label : best);
  add(minimum((a, b) => compareSectionFrontierSafety(a.metrics, b.metrics)));
  add(minimum((a, b) => sectionFrontierPracticalScore(a.metrics)
    - sectionFrontierPracticalScore(b.metrics)));
  add(minimum((a, b) => a.metrics.cautionM - b.metrics.cautionM
    || compareSectionFrontierSafety(a.metrics, b.metrics)));
  add(minimum((a, b) => a.metrics.gapM - b.metrics.gapM
    || compareSectionFrontierSafety(a.metrics, b.metrics)));
  add(minimum((a, b) => a.metrics.nonTrailM - b.metrics.nonTrailM
    || compareSectionFrontierSafety(a.metrics, b.metrics)));
  add(minimum((a, b) => a.metrics.roughM - b.metrics.roughM
    || a.metrics.timeS - b.metrics.timeS));
  add(minimum((a, b) => a.metrics.ascentM - b.metrics.ascentM
    || a.metrics.timeS - b.metrics.timeS));
  add(minimum((a, b) => a.metrics.timeS - b.metrics.timeS));
  for (const label of [...labels].sort((a, b) =>
    sectionFrontierPracticalScore(a.metrics) - sectionFrontierPracticalScore(b.metrics))) {
    if (chosen.length >= limit) break;
    add(label);
  }
  return chosen.slice(0, limit);
}

// Generic bounded multi-objective search over directed candidate-path arcs.
// Kept independent of the statewide graph so tiny fixture tests can exercise
// the composition and dominance rules directly.
function boundedSectionFrontierPaths(paths, startNode, endNode) {
  const adjacency = new Map();
  const seenArcs = new Set();
  for (const path of paths) {
    for (const arc of path) {
      const key = `${arc.from}:${arc.to}:${arc.edge}`;
      if (seenArcs.has(key)) continue;
      seenArcs.add(key);
      if (!adjacency.has(arc.from)) adjacency.set(arc.from, []);
      adjacency.get(arc.from).push(arc);
    }
  }
  const labels = [];
  const atNode = new Map();
  const heap = makeHeap(1024);
  const start = { node: startNode, metrics: emptySectionFrontierMetrics(),
    previous: -1, arc: null, active: true };
  labels.push(start); atNode.set(startNode, [start]); heap.push(0, 0);

  while (heap.size) {
    const labelIndex = heap.pop(), label = labels[labelIndex];
    if (!label?.active) continue;
    for (const arc of adjacency.get(label.node) || []) {
      const metrics = addSectionFrontierMetrics(label.metrics, arc.metrics);
      let frontier = atNode.get(arc.to) || [];
      if (frontier.some((other) => sectionFrontierDominates(other.metrics, metrics)
          || SECTION_FRONTIER_KEYS.every((key) => other.metrics[key] === metrics[key]))) continue;
      for (const other of frontier) {
        if (sectionFrontierDominates(metrics, other.metrics)) other.active = false;
      }
      frontier = frontier.filter((other) => other.active);
      const next = { node: arc.to, metrics, previous: labelIndex, arc, active: true };
      labels.push(next); frontier.push(next);
      const kept = selectSectionFrontierLabels(frontier);
      if (!kept.includes(next)) next.active = false;
      for (const other of frontier) if (!kept.includes(other)) other.active = false;
      atNode.set(arc.to, kept);
      if (next.active) heap.push(sectionFrontierPracticalScore(metrics), labels.length - 1);
    }
  }

  return (atNode.get(endNode) || []).filter((label) => label.active).map((goal) => {
    const arcs = [];
    let label = goal;
    while (label?.arc) {
      arcs.push(label.arc);
      label = labels[label.previous];
    }
    arcs.reverse();
    return { arcs, metrics: goal.metrics };
  });
}

function sectionFrontierArcMetrics(source, index) {
  const edge = source.edgeIds[index], fromNode = source.nodeIds[index];
  const seg = source.segs[index], len = eLen[edge], flags = eFlags[edge];
  const forward = eA[edge] === fromNode;
  const failM = seg.level === 4 ? len : 0;
  const cautionM = seg.level === 3 ? len : 0;
  const freewayM = flags & 4 ? len : 0;
  const mtbM = eOfficial[edge] & EDGE_MTB ? len : 0;
  const dismountM = isDismountEdge(edge) ? len : 0;
  const hazardM = Number(seg.hazardLenM) || 0;
  const limitedM = !(flags & 4) && edgeLimited(edge, forward) ? len : 0;
  const gapM = flags & (8 | 32) || (seg.facility || 0) >= 2 ? 0 : len;
  const nonTrailM = flags & (8 | 32) ? 0 : len;
  const roughM = !(flags & 32) && (eSurface[edge] & 15) >= SURFACE_GRAVEL ? len : 0;
  return {
    failM,
    dangerM: failM * 8 + freewayM * 20 + mtbM * 6 + dismountM * 5
      + hazardM * 2 + limitedM * 0.75,
    cautionM, gapM, nonTrailM, roughM,
    ascentM: forward ? eAsc[edge] : eDes[edge],
    timeS: Number(seg.timeS) || edgeTimeS(edge, forward),
    distM: len,
  };
}

function sectionFrontierRouteMetrics(routeResult) {
  let metrics = emptySectionFrontierMetrics();
  for (let index = 0; index < routeResult.edgeIds.length; index++) {
    metrics = addSectionFrontierMetrics(metrics,
      sectionFrontierArcMetrics(routeResult, index));
  }
  return metrics;
}

function distinctSectionFrontierSeeds(candidates) {
  const distinct = [];
  for (const candidate of [...candidates].sort((a, b) =>
    recommendationScore(a) - recommendationScore(b) || compareSafety(a, b))) {
    if (candidate.edgeIds?.length > 1
        && candidate.nodeIds?.length === candidate.edgeIds.length + 1
        && new Set(candidate.nodeIds).size === candidate.nodeIds.length
        && distinct.every((other) => meaningfullyDifferent(candidate, other))) {
      distinct.push(candidate);
    }
  }
  if (distinct.length <= SECTION_FRONTIER_MAX_SEEDS) return distinct;
  const chosen = [];
  const add = (candidate) => { if (candidate && !chosen.includes(candidate)) chosen.push(candidate); };
  add(distinct[0]);
  add(distinct.reduce((best, route) => route.timeS < best.timeS ? route : best));
  add(distinct.reduce((best, route) => compareSafety(route, best) < 0 ? route : best));
  const metrics = new Map(distinct.map((route) => [route, sectionFrontierRouteMetrics(route)]));
  add(distinct.reduce((best, route) => metrics.get(route).cautionM < metrics.get(best).cautionM
    ? route : best));
  add(distinct.reduce((best, route) => route.ascentM < best.ascentM ? route : best));
  while (chosen.length < SECTION_FRONTIER_MAX_SEEDS) {
    let best = null, bestValue = -Infinity;
    for (const candidate of distinct) {
      if (chosen.includes(candidate)) continue;
      const value = Math.min(...chosen.map((other) => 1 - edgeOverlap(candidate, other)));
      if (value > bestValue) { best = candidate; bestValue = value; }
    }
    if (!best) break;
    add(best);
  }
  return chosen;
}

function sharedCrossBreedCuts(first, second) {
  const secondIndex = new Map();
  for (let index = 1; index < second.nodeIds.length - 1; index++) {
    secondIndex.set(second.nodeIds[index], index);
  }
  const cuts = [];
  let previousFirst = -2, previousSecond = -2;
  for (let firstIndex = 1; firstIndex < first.nodeIds.length - 1; firstIndex++) {
    const secondAt = secondIndex.get(first.nodeIds[firstIndex]);
    if (secondAt == null) continue;
    // Switching anywhere along the same shared edge run creates identical
    // geometry. Retain only the first node of that run. Consecutive shared
    // nodes reached over DIFFERENT parallel edges remain separate cuts.
    const sameRun = firstIndex === previousFirst + 1 && secondAt === previousSecond + 1
      && first.edgeIds[previousFirst] === second.edgeIds[previousSecond];
    if (!sameRun) cuts.push({ first: firstIndex, second: secondAt });
    previousFirst = firstIndex;
    previousSecond = secondAt;
  }
  return cuts;
}

function crossBreedWouldLoop(prefix, prefixCut, suffix, suffixCut) {
  // Each A* parent is simple. A loop can only appear when a node in the chosen
  // prefix occurs again after the junction in the other parent's suffix.
  const prefixNodes = new Set(prefix.nodeIds.slice(0, prefixCut));
  for (let index = suffixCut + 1; index < suffix.nodeIds.length; index++) {
    if (prefixNodes.has(suffix.nodeIds[index])) return true;
  }
  return false;
}

function crossBreedPrefixMetrics(route) {
  const prefix = [{ distM: 0, timeS: 0, failM: 0, dismountM: 0,
    facilityM: 0, trailM: 0 }];
  for (let index = 0; index < route.edgeIds.length; index++) {
    const previous = prefix[index], edge = route.edgeIds[index], seg = route.segs[index];
    const distM = previous.distM + eLen[edge];
    prefix.push({
      distM,
      timeS: previous.timeS + (Number(seg.timeS) || 0),
      failM: previous.failM + (seg.level === 4 ? eLen[edge] : 0),
      dismountM: previous.dismountM + (isDismountEdge(edge) ? eLen[edge] : 0),
      facilityM: previous.facilityM + ((seg.facility || 0) >= 2 ? eLen[edge] : 0),
      trailM: previous.trailM + (eFlags[edge] & 8 ? eLen[edge] : 0),
    });
  }
  return prefix;
}

function crossBreedEstimate(prefixMetrics, prefixCut, suffixMetrics, suffixCut) {
  const before = prefixMetrics[prefixCut];
  const suffixStart = suffixMetrics[suffixCut];
  const suffixEnd = suffixMetrics[suffixMetrics.length - 1];
  const combined = {};
  for (const key of ['distM', 'timeS', 'failM', 'dismountM', 'facilityM', 'trailM']) {
    combined[key] = before[key] + suffixEnd[key] - suffixStart[key];
  }
  combined.score = combined.timeS + combined.failM + combined.dismountM
    + Math.max(0, combined.distM - combined.facilityM) * NETWORK_GAP_PRICE_S_PER_M
    - combined.trailM * TRAIL_BONUS_S_PER_M;
  return combined;
}

function improvesOnParent(child, parent) {
  // A real blend gives something back against EACH parent: time, priced
  // recommendation quality, or the lexicographic safety outcome. This keeps
  // "take two already-worse halves" noise out without requiring the child to
  // dominate either endpoint of a useful fast-vs-safe tradeoff.
  return child.timeS + 5 < parent.timeS
    || recommendationScore(child) + 5 < recommendationScore(parent)
    || compareSafety(child, parent) < 0;
}

function distinctLandCrossBreedSeeds(raw) {
  const eligible = raw.filter((candidate) => candidate.ferryM <= 0.5
    && candidate.edgeIds?.length > 1
    && candidate.nodeIds?.length === candidate.edgeIds.length + 1
    && new Set(candidate.nodeIds).size === candidate.nodeIds.length);
  if (eligible.length < 2) return eligible;
  const fastest = eligible.reduce((best, route) => route.timeS < best.timeS ? route : best);
  const reasonable = eligible.filter((route) => route.timeS <= fastest.timeS * 2.2 + 600
    || route.failM + 80 < fastest.failM || route.freewayM + 80 < fastest.freewayM);
  const distinct = [];
  for (const candidate of [...reasonable].sort((a, b) =>
    recommendationScore(a) - recommendationScore(b)
      || compareSafety(a, b) || a._profile.id.localeCompare(b._profile.id))) {
    if (distinct.every((other) => meaningfullyDifferent(candidate, other))) distinct.push(candidate);
  }
  if (distinct.length <= GENERAL_CROSS_BREED_MAX_SEEDS) return distinct;

  // Always retain the three useful endpoints, then fill by corridor diversity.
  const chosen = [];
  const add = (candidate) => { if (candidate && !chosen.includes(candidate)) chosen.push(candidate); };
  add(distinct.reduce((best, route) =>
    recommendationScore(route) < recommendationScore(best) ? route : best));
  add(distinct.reduce((best, route) => route.timeS < best.timeS ? route : best));
  add(distinct.reduce((best, route) => compareSafety(route, best) < 0 ? route : best));
  while (chosen.length < GENERAL_CROSS_BREED_MAX_SEEDS) {
    let best = null, bestValue = -Infinity;
    for (const candidate of distinct) {
      if (chosen.includes(candidate)) continue;
      const diversity = Math.min(...chosen.map((other) => 1 - edgeOverlap(candidate, other)));
      const quality = Math.min(1, recommendationScore(chosen[0]) / recommendationScore(candidate));
      const value = diversity * 0.8 + quality * 0.2;
      if (value > bestValue) { best = candidate; bestValue = value; }
    }
    if (!best) break;
    add(best);
  }
  return chosen;
}

function addGeneralCrossBreedCandidates(raw, rules) {
  const seeds = distinctLandCrossBreedSeeds(raw);
  if (seeds.length < 2) return;
  const metrics = new Map(seeds.map((route) => [route, crossBreedPrefixMetrics(route)]));
  const pool = [];
  for (let firstIndex = 0; firstIndex < seeds.length; firstIndex++) {
    for (let secondIndex = firstIndex + 1; secondIndex < seeds.length; secondIndex++) {
      const first = seeds[firstIndex], second = seeds[secondIndex];
      if (!meaningfullyDifferent(first, second)) continue;
      const recipes = [];
      const pair = [];
      for (const cut of sharedCrossBreedCuts(first, second)) {
        for (const recipe of [
          { prefix: first, prefixCut: cut.first, suffix: second, suffixCut: cut.second },
          { prefix: second, prefixCut: cut.second, suffix: first, suffixCut: cut.first },
        ]) {
          if (crossBreedWouldLoop(recipe.prefix, recipe.prefixCut,
            recipe.suffix, recipe.suffixCut)) continue;
          recipe.estimate = crossBreedEstimate(metrics.get(recipe.prefix), recipe.prefixCut,
            metrics.get(recipe.suffix), recipe.suffixCut);
          const prefixM = metrics.get(recipe.prefix)[recipe.prefixCut].distM;
          const suffixMetrics = metrics.get(recipe.suffix);
          const suffixM = suffixMetrics[suffixMetrics.length - 1].distM
            - suffixMetrics[recipe.suffixCut].distM;
          if (prefixM < GENERAL_CROSS_BREED_MIN_PART_M
              || suffixM < GENERAL_CROSS_BREED_MIN_PART_M) continue;
          recipes.push(recipe);
        }
      }
      // Full route fragments copy geometry and segment records. Rank every
      // possible junction using additive prefix metrics, then materialize only
      // the best-priced and safest few. That keeps the pass cheap on a phone.
      const byPrice = [...recipes].sort((a, b) => a.estimate.score - b.estimate.score
        || a.estimate.failM - b.estimate.failM);
      const bySafety = [...recipes].sort((a, b) => a.estimate.failM - b.estimate.failM
        || a.estimate.dismountM - b.estimate.dismountM
        || a.estimate.score - b.estimate.score);
      const finalists = [];
      for (const recipe of [byPrice[0], bySafety[0]]) {
        if (recipe && !finalists.includes(recipe)) finalists.push(recipe);
      }
      for (const recipe of finalists) {
        const prefixPart = routeFragment(recipe.prefix, 0, recipe.prefixCut, rules);
        const suffixPart = routeFragment(recipe.suffix, recipe.suffixCut,
          recipe.suffix.edgeIds.length, rules);
        if (!prefixPart || !suffixPart
            || prefixPart.distM < GENERAL_CROSS_BREED_MIN_PART_M
            || suffixPart.distM < GENERAL_CROSS_BREED_MIN_PART_M) continue;
        const child = mergeRouteParts([prefixPart, suffixPart],
          recipe.prefix.snapStartM, recipe.suffix.snapEndM);
        child.aggression = routeAggression(child);
        if (!improvesOnParent(child, recipe.prefix)
            || !improvesOnParent(child, recipe.suffix)) continue;
        // It must add a route, not merely reconstruct either parent or a
        // third candidate already in the portfolio.
        if (raw.some((existing) => !meaningfullyDifferent(child, existing))) continue;
        child._crossBreedParents = [recipe.prefix, recipe.suffix];
        pair.push(child);
      }
      if (!pair.length) continue;
      pair.sort((a, b) => recommendationScore(a) - recommendationScore(b)
        || compareSafety(a, b) || a.timeS - b.timeS);
      pool.push(pair[0]);
      const safest = pair.reduce((best, child) => compareSafety(child, best) < 0 ? child : best);
      if (safest !== pair[0] && meaningfullyDifferent(safest, pair[0])) pool.push(safest);
    }
  }
  if (!pool.length) return;

  // Collapse children from different parent pairs that found the same blend.
  const unique = [];
  for (const child of pool.sort((a, b) => recommendationScore(a) - recommendationScore(b)
    || compareSafety(a, b))) {
    if (unique.every((other) => meaningfullyDifferent(child, other))) unique.push(child);
  }
  const chosen = [];
  const add = (child) => {
    if (child && chosen.length < GENERAL_CROSS_BREED_MAX_RESULTS
        && chosen.every((other) => meaningfullyDifferent(child, other))) chosen.push(child);
  };
  add(unique[0]);
  add(unique.reduce((best, child) => compareSafety(child, best) < 0 ? child : best));
  while (chosen.length < GENERAL_CROSS_BREED_MAX_RESULTS) {
    let best = null, bestValue = -Infinity;
    for (const child of unique) {
      if (chosen.includes(child)) continue;
      const diversity = Math.min(...chosen.map((other) => 1 - edgeOverlap(child, other)));
      const quality = Math.min(1, recommendationScore(unique[0]) / recommendationScore(child));
      const value = diversity * 0.7 + quality * 0.3;
      if (value > bestValue) { best = child; bestValue = value; }
    }
    if (!best) break;
    add(best);
    // `best` can be too close to a route already chosen. Remove it so the
    // bounded loop still makes progress.
    if (!chosen.includes(best)) unique.splice(unique.indexOf(best), 1);
  }

  for (let index = 0; index < chosen.length; index++) {
    const child = chosen[index];
    const [prefix, suffix] = child._crossBreedParents;
    delete child._crossBreedParents;
    child._profile = {
      id: `combined-corridor${index ? `-${index + 1}` : ''}`,
      label: 'Combined corridor', mode: 'balanced',
      prefDesig: !!(prefix._profile.prefDesig || suffix._profile.prefDesig),
      prefResidential: !!(prefix._profile.prefResidential || suffix._profile.prefResidential),
      order: 1.47 + index * 0.01,
      alternativeCorridor: true,
      crossBred: true,
      crossBreedKind: 'junction',
      refinedFrom: `${prefix._profile.id}+${suffix._profile.id}`,
    };
    raw.push(child);
  }
}

function selectSectionFrontierPaths(paths) {
  if (!paths.length) return [];
  const fastest = paths.reduce((best, path) => path.metrics.timeS < best.metrics.timeS ? path : best);
  const bounded = paths.filter((path) =>
    path.metrics.timeS <= fastest.metrics.timeS * 1.85 + 600
    && path.metrics.distM <= fastest.metrics.distM * 1.8 + 1600);
  const choices = bounded.length ? bounded : paths;
  const practical = choices.reduce((best, path) =>
    sectionFrontierPracticalScore(path.metrics) < sectionFrontierPracticalScore(best.metrics)
      ? path : best);
  const safest = choices.reduce((best, path) =>
    compareSectionFrontierSafety(path.metrics, best.metrics) < 0 ? path : best);
  // Secondary endpoints may trade comfort, climbing and time, but may not buy
  // them with materially more rule-failing road than the practical path.
  const nearSafe = choices.filter((path) =>
    path.metrics.failM <= Math.max(safest.metrics.failM + 80, practical.metrics.failM + 20));
  const pool = nearSafe.length ? nearSafe : choices;
  const selected = [];
  const add = (path) => { if (path && !selected.includes(path)) selected.push(path); };
  add(practical); add(safest);
  add(pool.reduce((best, path) => path.metrics.cautionM < best.metrics.cautionM
    || (path.metrics.cautionM === best.metrics.cautionM
      && sectionFrontierPracticalScore(path.metrics) < sectionFrontierPracticalScore(best.metrics))
    ? path : best));
  add(pool.reduce((best, path) => path.metrics.gapM < best.metrics.gapM
    || (path.metrics.gapM === best.metrics.gapM
      && sectionFrontierPracticalScore(path.metrics) < sectionFrontierPracticalScore(best.metrics))
    ? path : best));
  add(pool.reduce((best, path) => path.metrics.nonTrailM < best.metrics.nonTrailM
    || (path.metrics.nonTrailM === best.metrics.nonTrailM
      && sectionFrontierPracticalScore(path.metrics) < sectionFrontierPracticalScore(best.metrics))
    ? path : best));
  add(pool.reduce((best, path) => path.metrics.ascentM < best.metrics.ascentM
    || (path.metrics.ascentM === best.metrics.ascentM
      && sectionFrontierPracticalScore(path.metrics) < sectionFrontierPracticalScore(best.metrics))
    ? path : best));
  return selected;
}

function materializeSectionFrontierPath(path, seeds, rules) {
  if (!path?.arcs?.length) return null;
  const runs = [];
  for (const arc of path.arcs) {
    const last = runs[runs.length - 1];
    if (last && last.source === arc.source && last.end === arc.index) last.end++;
    else runs.push({ source: arc.source, start: arc.index, end: arc.index + 1 });
  }
  const parts = runs.map((run) => routeFragment(seeds[run.source], run.start, run.end, rules));
  if (parts.some((part) => !part)) return null;
  const child = mergeRouteParts(parts, seeds[0].snapStartM, seeds[0].snapEndM);
  child._sectionSources = [...new Set(runs.map((run) => run.source))]
    .map((source) => seeds[source]._profile);
  return child;
}

function addSectionFrontierCandidates(raw, rules) {
  const groups = new Map();
  for (const candidate of raw) {
    if (candidate._profile.sectionFrontier) continue;
    const signature = ferrySignature(candidate);
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature).push(candidate);
  }
  const pool = [];
  for (const [signature, candidates] of groups) {
    const seeds = distinctSectionFrontierSeeds(candidates);
    if (seeds.length < 2) continue;
    const startNode = seeds[0].nodeIds[0];
    const endNode = seeds[0].nodeIds[seeds[0].nodeIds.length - 1];
    if (!seeds.every((seed) => seed.nodeIds[0] === startNode
        && seed.nodeIds[seed.nodeIds.length - 1] === endNode)) continue;
    const paths = seeds.map((source, sourceIndex) => source.edgeIds.map((edge, index) => ({
      from: source.nodeIds[index], to: source.nodeIds[index + 1], edge,
      source: sourceIndex, index, metrics: sectionFrontierArcMetrics(source, index),
    })));
    const frontier = boundedSectionFrontierPaths(paths, startNode, endNode);
    const existingMetrics = candidates.map((candidate) =>
      [candidate, sectionFrontierRouteMetrics(candidate)]);
    for (const path of selectSectionFrontierPaths(frontier)) {
      const child = materializeSectionFrontierPath(path, seeds, rules);
      if (!child || new Set(child.nodeIds).size !== child.nodeIds.length) continue;
      if (ferrySignature(child) !== signature) continue;
      if (raw.some((candidate) => !meaningfullyDifferent(child, candidate))) continue;
      const childMetrics = sectionFrontierRouteMetrics(child);
      if (existingMetrics.some(([, metrics]) => sectionFrontierDominates(metrics, childMetrics))) {
        continue;
      }
      child._sectionMetrics = childMetrics;
      child.aggression = routeAggression(child);
      pool.push(child);
    }
  }
  if (!pool.length) return;

  const unique = [];
  for (const child of pool.sort((a, b) =>
    sectionFrontierPracticalScore(a._sectionMetrics)
      - sectionFrontierPracticalScore(b._sectionMetrics)
      || compareSectionFrontierSafety(a._sectionMetrics, b._sectionMetrics))) {
    if (unique.every((other) => meaningfullyDifferent(child, other))) unique.push(child);
  }
  const chosen = [];
  const add = (child) => {
    if (child && chosen.length < SECTION_FRONTIER_MAX_RESULTS && !chosen.includes(child)) {
      chosen.push(child);
    }
  };
  add(unique[0]);
  add(unique.reduce((best, child) =>
    compareSectionFrontierSafety(child._sectionMetrics, best._sectionMetrics) < 0 ? child : best));
  add(unique.reduce((best, child) =>
    child._sectionMetrics.cautionM < best._sectionMetrics.cautionM ? child : best));
  add(unique.reduce((best, child) =>
    child._sectionMetrics.nonTrailM < best._sectionMetrics.nonTrailM ? child : best));
  add(unique.reduce((best, child) =>
    child._sectionMetrics.ascentM < best._sectionMetrics.ascentM ? child : best));
  while (chosen.length < SECTION_FRONTIER_MAX_RESULTS) {
    let best = null, bestValue = -Infinity;
    for (const child of unique) {
      if (chosen.includes(child)) continue;
      const value = Math.min(...chosen.map((other) => 1 - edgeOverlap(child, other)));
      if (value > bestValue) { best = child; bestValue = value; }
    }
    if (!best) break;
    add(best);
  }

  for (let index = 0; index < chosen.length; index++) {
    const child = chosen[index];
    const sourceProfiles = child._sectionSources;
    delete child._sectionSources;
    delete child._sectionMetrics;
    child._profile = {
      id: `section-frontier${index ? `-${index + 1}` : ''}`,
      label: 'Section frontier', mode: 'balanced',
      prefDesig: sourceProfiles.some((profile) => profile.prefDesig),
      prefResidential: sourceProfiles.some((profile) => profile.prefResidential),
      order: 1.44 + index * 0.01,
      alternativeCorridor: true, crossBred: true, crossBreedKind: 'frontier',
      sectionFrontier: true, refinedFrom: sourceProfiles.map((profile) => profile.id).join('+'),
    };
    raw.push(child);
  }
}

// One seed's land sections, re-searched under the conservative lens; the
// seed's boats are spliced back verbatim.
function refineFerrySeed(seed, raw, rules, forceDesig, forceResidential, searchRules, progress) {
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
    progress?.(`Refining the land sections of a ferry itinerary… (${landIndex + 1} of ${landRanges.length})`, 0.62 + 0.26 * (landIndex / landRanges.length));
    const startNode = seed.nodeIds[range.start], endNode = seed.nodeIds[range.end];
    const startPoint = [nodeLon[startNode], nodeLat[startNode]];
    const endPoint = [nodeLon[endNode], nodeLat[endNode]];
    const startSnap = { node: startNode, distM: 0 }, endSnap = { node: endNode, distM: 0 };
    // These legs run between interior nodes of the seed. Their portal
    // observations must not become request-level frontier hits: the seed's own
    // request legs already routed, so the section search reports only how this
    // land stretch might be refined, never that the trip needs more map.
    suppressFrontierHitRecording = true;
    let direct, alternative;
    try {
      direct = routeLeg(startPoint, endPoint, rules, 'direct', forceDesig, forceResidential,
        startSnap, endSnap, null, 1, searchRules);
      alternative = direct.ok
        ? routeLeg(startPoint, endPoint, rules, 'balanced', true, true,
          startSnap, endSnap, new Set(direct.edgeIds), activeWeights.diversityBalanced, searchRules)
        : null;
    } finally { suppressFrontierHitRecording = false; }
    if (!direct.ok) continue;
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
      // UNIQUE per candidate. This pass can produce several adaptive
      // itineraries in one portfolio, and everything downstream -- the
      // chooser lineup, the candidate cache, selection stickiness --
      // keys candidates by profile id. Two candidates sharing one id
      // scrambled the route letters the first time a ferry trip offered two
      // adaptives (the chooser rendered A, B, E, D). Matching code tests
      // startsWith('adaptive-corridor').
      id: `adaptive-corridor${raw.some((r) => r._profile.id.startsWith('adaptive-corridor'))
        ? `-${raw.filter((r) => r._profile.id.startsWith('adaptive-corridor')).length + 1}` : ''}`,
      label: 'Adaptive corridor', mode: 'balanced', prefDesig: true, prefResidential: true,
      order: seed._profile.order + 0.08 + landIndex * 0.01,
      alternativeCorridor: true,
      // Which itinerary this hybrid refined -- the More screen and any
      // diagnosis want to know whose legs it inherited.
      refinedFrom: seed._profile.id,
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

// A route result needs the graph and `lastCandidates`: the latter supplies
// full geometry when the rider opens More. Everything else below is a
// disposable acceleration cache. Drop those large arrays after a phone has
// its answer, and again before a low-zoom tile burst, so routing and rendering
// do not compete for the same WebKit memory ceiling. References are cleared as
// one worker message, after the current search has returned; GC can therefore
// reclaim them without invalidating live search locals or changing an answer.
function routingCacheStats() {
  const costSlotCount = costCacheSlots.length;
  const floorSlotCount = floorSlots.length;
  const potentialEntries = potentialCache.size;
  const verdictSlotCount = verdictSlots.filter((slot) => !!slot.cache).length;
  const reusableBytes = costSlotCount * D * (4 + 4 + 1)
    + floorSlotCount * 2 * E * 4
    + potentialEntries * N * 2
    + verdictSlotCount * 2 * E
    + (incStart ? (N + 1 + 2 * E) * 4 : 0)
    + (potentialWork ? N * (8 + 1) : 0);
  return {
    costSlots: costSlotCount,
    floorSlots: floorSlotCount,
    potentialEntries,
    verdictSlots: verdictSlotCount,
    incidence: !!incStart,
    potentialWork: !!potentialWork,
    reusableBytes,
    reusableMiB: Math.round(reusableBytes / 104857.6) / 10,
    limits: { cost: costSlotCap, floor: floorSlotCap, potential: potentialCap },
  };
}

function routingMemoryStats() {
  const derivedPermanentBytes = [eBearingA, eBearingB, eFacilityGap,
    searchDist, searchPrevArc, searchStamp, nodeHasLand, inGiant]
    .reduce((sum, array) => sum + (array?.byteLength || 0), 0);
  const sidecarBytes = (eStateIndex?.byteLength || 0) + (ePartitionIndex?.byteLength || 0);
  const reusableBytes = routingCacheStats().reusableBytes;
  return {
    graphInputBytes: loadedGraphInputBytes,
    derivedPermanentBytes,
    sidecarBytes,
    reusableBytes,
    measuredBytes: loadedGraphInputBytes + derivedPermanentBytes + sidecarBytes + reusableBytes,
    nodes: N, edges: E, directedArcs: D,
    loadedPartitionIds: [...loadedPartitionIds],
    stateIds: [...graphStateIds],
    partitionInput: partitionGraphDiagnostics,
  };
}

function trimRoutingCaches() {
  const before = routingCacheStats();
  // Cancel a chunked idle pre-warm before releasing the arrays it would refill.
  prewarmToken++;
  costCacheSlots.length = 0;
  floorSlots.length = 0;
  floorValues = null;
  floorKey = '';
  floorSetup = null;
  potentialCache.clear();
  potentialWork = null;
  potentialSettled = null;
  incStart = null;
  incEdge = null;
  for (const slot of verdictSlots) {
    slot.cache = null;
    slot.generation = 1;
    slot.rules = null;
    slot.key = null;
    slot.noShoulderMax = 0;
    slot.failTouch = null;
  }
  return { before, after: routingCacheStats(), candidatesRetained: !!lastCandidates };
}

function addPreferredRouteSpectrumCandidates(raw, points, rules, forceDesig, forceResidential,
    snaps, progress = null) {
  if (!preferredRoutesActive(rules)) return;
  const mainWeights = { ...activeWeights };
  const spectrum = preferredRouteSpectrum(mainWeights.preferredRoute);
  try {
    for (let index = 0; index < spectrum.length; index++) {
      const lens = spectrum[index];
      progress?.(`Testing Preferred-route alternatives… (${index + 1} of ${spectrum.length})`,
        0.025 + index * 0.01);
      const profile = {
        id: lens.id, label: lens.label, mode: 'balanced',
        prefDesig: forceDesig, prefResidential: forceResidential,
        order: 0.86 + index * 0.01,
        preferredRouteStrength: lens.strength,
        preferredRouteMultiplier: lens.multiplier,
      };
      const searchRules = lens.strength === 'neutral'
        ? withoutPreferredRouteSelection(rules) : rules;
      useWeights({ ...mainWeights, preferredRoute: lens.multiplier });
      const result = route(points, searchRules, profile.mode, profile.prefDesig,
        profile.prefResidential, snaps);
      if (!result.ok) continue;
      result._profile = profile;
      result.aggression = routeAggression(result);
      raw.push(result);
    }
  } finally {
    useWeights(mainWeights);
  }
}

// The facility-neutral diversity round (rider direction, 2026-08-27): one
// extra Balanced search with every facility discount moved halfway to
// neutral in log space (sqrt: path 0.25 -> 0.5, lane 0.42 -> 0.65, shared
// 0.75 -> 0.87, strongDesignated 0.5 -> 0.71). Safety pricing is untouched;
// the round asks "same standards — what would you ride if trails were half
// as magnetic?", which is exactly the near-tie corridor that a hair's
// change in weights or start point flips into and out of the portfolio.
// The ordinary dedupe and filters decide whether its find is distinct
// enough to offer, and every stat and score the rider sees is computed
// under their own unchanged weights.
const FACILITY_NEUTRAL_KEYS = Object.freeze(['facilityShared', 'facilityLane',
  'facilityBuffered', 'facilitySeparated', 'facilityPath', 'strongDesignated']);
function facilityNeutralWeights(base) {
  // The rider's facilityNeutralStrength slider: 0 returns the weights
  // unchanged, which makes the round's signature match the main weights and
  // the round skip itself — that IS the off switch.
  const strength = Math.min(1, Math.max(0, base.facilityNeutralStrength ?? 0));
  const weights = { ...base };
  if (!strength) return weights;
  for (const key of FACILITY_NEUTRAL_KEYS) {
    if (Number.isFinite(weights[key]) && weights[key] > 0) {
      weights[key] = +Math.pow(weights[key], 1 - strength).toFixed(4);
    }
  }
  return weights;
}

function routeOptions(points, rules, forceDesig, forceResidential, preferredProfileId, debug = false,
    progress = null, requestSignature = null,
    mainWeights = null, lensWeights = null) {
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
  // Where the request's time went, phase by phase. Shipped in the reply so a
  // slow platform can be diagnosed from its console instead of guessed at.
  const phaseMs = {};
  let phaseT = Date.now();
  const endPhase = (name) => {
    phaseMs[name] = (phaseMs[name] || 0) + (Date.now() - phaseT);
    phaseT = Date.now();
  };
  // Snapping scans the statewide node table. Do it once per route point, not
  // once again for every optimization profile.
  const snaps = points.map((point) => nearestNode(point[0], point[1], rules));
  endPhase('snap');
  const raw = [];
  let firstFailure = null;
  addPreferredRouteSpectrumCandidates(raw, points, rules, forceDesig,
    forceResidential, snaps, progress);
  for (let pi = 0; pi < profiles.length; pi++) {
    const profile = profiles[pi];
    progress?.(`Testing route profiles… (${pi + 1} of ${profiles.length})`, 0.03 + 0.37 * (pi / profiles.length));
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
  endPhase('profiles');
  progress?.('Looking for genuinely different route corridors…', 0.4);

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
    for (let ci = 0; ci < probes.length; ci++) {
      const probe = probes[ci];
      progress?.(`Exploring alternative corridors… (${ci + 1} of ${probes.length})`, 0.41 + 0.17 * (ci / probes.length));
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

  endPhase('corridors');
  // The facility-neutral round (see facilityNeutralWeights above). Not
  // gated on the <5-distinct trigger: that would skip it exactly on the
  // trips where one magnetic corridor owns every profile, which is where
  // it earns its keep. The rider's facilityNeutralStrength slider at 0
  // makes the lens equal the main weights, and the signature check below
  // skips the search. Weights are restored before anything else prices or
  // scores — only this one search sees the lens.
  {
    const mainSignature = weightsSignature;
    const savedWeights = activeWeights;
    useWeights(facilityNeutralWeights(activeWeights));
    if (weightsSignature !== mainSignature) {
      progress?.('Retrying with half the trail pull…', 0.58);
      const profile = { id: 'facility-neutral', label: 'Half trail pull',
        mode: 'balanced', prefDesig: forceDesig, prefResidential: forceResidential,
        order: 1.42, facilityNeutral: true };
      const result = route(points, rules, profile.mode, profile.prefDesig,
        profile.prefResidential, snaps);
      useWeights(savedWeights);
      if (result.ok) {
        result._profile = profile;
        result.aggression = routeAggression(result);
        raw.push(result);
      }
    } else {
      useWeights(savedWeights);
    }
    endPhase('facilityNeutral');
  }
  progress?.('Trying discovery profiles on calmer roads…', 0.6);
  const discoveryRules = addDiscoveryCandidates(raw, points, rules,
    forceDesig, forceResidential, snaps, progress);
  endPhase('discovery');
  const forwardProgressCandidate = addForwardProgressCandidate(raw, points, rules, forceDesig,
    forceResidential, snaps);
  endPhase('progress');
  // The more-direct lens: a bounded flattening run as ONE ordinary candidate
  // inside every portfolio. Field case
  // (Ravenna -> Phinney Ridge): all nineteen normal candidates collapsed onto
  // one greenway corridor -- the facility pull owns every profile AND every
  // diversity probe on a short trip -- while the flattened search found a
  // genuinely shorter corridor the rider had to know to ask for. This is a
  // search preference only: safety metrics, map colors and the star's pricing
  // all come from the rider's unchanged rules, and the ordinary dedupe decides
  // whether what the lens found is actually different.
  if (lensWeights) {
    const mainSignature = weightsSignature;
    useWeights(lensWeights);
    if (weightsSignature !== mainSignature) {
      progress?.('Trying a more direct lens…', 0.76);
      // A named Preferred route is deliberately strong in the ordinary
      // candidates. Carrying that exception into the escape lens made the
      // supposedly direct search follow the same corridor and collapse the
      // portfolio to one route. The lens is the neutral end of the Preferred
      // spectrum: keep the rider's rules, remove only the selected-route pull.
      const directRules = preferredRoutesActive(rules)
        ? withoutPreferredRouteSelection(rules) : rules;
      const preferredRouteStrength = directRules === rules ? null : 'neutral';
      // Two lens candidates. The direct one finds the aggressive end --
      // useful, but on Duck Pond -> Kenmore it was ALSO the only lens find,
      // a 6.5 mi route that is 51% failing, and with nothing moderate
      // inside the practical window the star had to sit on it. The genuinely
      // better middle routes come from DIVERSITY under the
      // flattened weights (its alt probes found 17% failing where friendly
      // preferences alone just re-found the aggressive corridor), so the
      // second candidate is a diversity probe seeded off the first: balanced
      // and friendly, pushed off the aggressive corridor's own edges.
      const lensProfile = { id: 'direct-lens', label: 'More-direct lens', mode: 'direct',
        prefDesig: forceDesig, prefResidential: forceResidential, order: 0.46, directLens: true,
        preferredRouteStrength };
      const direct = route(points, directRules, lensProfile.mode, lensProfile.prefDesig,
        lensProfile.prefResidential, snaps);
      if (direct.ok) {
        direct._profile = lensProfile;
        direct.aggression = routeAggression(direct);
        raw.push(direct);
        const moderateProfile = { id: 'direct-lens-friendly', label: 'More-direct lens',
          mode: 'balanced', prefDesig: true, prefResidential: true, order: 1.46,
          alternativeCorridor: true, directLens: true, preferredRouteStrength };
        const moderate = route(points, directRules, moderateProfile.mode, moderateProfile.prefDesig,
          moderateProfile.prefResidential, snaps,
          new Set(direct.edgeIds), activeWeights.diversityBalanced);
        if (moderate.ok) {
          moderate._profile = moderateProfile;
          moderate.aggression = routeAggression(moderate);
          raw.push(moderate);
        }
      }
      useWeights(mainWeights);
    } else {
      useWeights(mainWeights);
    }
  }
  endPhase('lens');
  if (points.length === 2) {
    progress?.('Probing ferry corridors and terminals…',
      raw.some((c) => c.ferryM > 0) ? 0.62 : 0.8);
    addAdaptiveFerryCandidates(raw, rules, forceDesig, forceResidential, discoveryRules, progress);
    endPhase('ferries');
  }
  progress?.('Checking for a practical route that fully matches your rules…', 0.9);
  ensureFullyMatchingCandidate(raw, points, rules, snaps);
  endPhase('matching');
  if (points.length === 2) {
    progress?.('Combining compatible route sections…', 0.93);
    addGeneralCrossBreedCandidates(raw, rules);
    endPhase('crossbreed');
    progress?.('Building a safety-first section frontier…', 0.95);
    addSectionFrontierCandidates(raw, rules);
    endPhase('frontier');
  }

  // Portfolio admission. The time bound keeps merely-slower duplicates out, but
  // the two safety escapes below are deliberately UNBOUNDED in time and distance:
  // a candidate carrying materially less failing road, or less freeway, is always
  // offered no matter how far it goes around. A rider who wants the safe line is
  // entitled to see it and decide; the audit of 2026-08-19 raised the 411-mile
  // Marblemount -> Winthrop options as a defect and the answer was that this is
  // the intended behaviour. Do not add a length or time ceiling to the escapes.
  const fastest = raw.reduce((best, r) => r.timeS < best.timeS ? r : best, raw[0]);
  const reasonable = raw.filter((r) => r._profile.fullyMatchingRules
    || r._profile.preferredRouteStrength === 'strong'
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
      unique[unique.indexOf(same)] = carryPreferredStrength(candidate, same);
    } else if (candidate._profile.fullyMatchingRules && !same._profile.fullyMatchingRules) {
      unique[unique.indexOf(same)] = carryPreferredStrength(candidate, same);
    } else if (same._profile.id !== preferredProfileId
        && candidate._profile.prefDesig && candidate._profile.prefResidential
        && !(same._profile.prefDesig && same._profile.prefResidential)) {
      unique[unique.indexOf(same)] = carryPreferredStrength(candidate, same);
    }
  }

  unique.sort((a, b) => a._profile.order - b._profile.order
    || b.aggression - a.aggression || a.timeS - b.timeS);

  const preferred = unique.find((r) => r._profile.id === preferredProfileId);
  const bothPreferences = unique.find((r) => r._profile.prefDesig && r._profile.prefResidential);
  const fullyMatching = unique.filter((route) => route.failM <= 0.5)
    .reduce((best, route) => !best || recommendationScore(route) < recommendationScore(best)
      ? route : best, null);
  const adaptiveCorridor = unique.find((r) => r._profile.id.startsWith('adaptive-corridor'));
  // Ferry cross-breeding can already contain the exact field-requested blend:
  // keep the practical mainland from one route and the safer island from
  // another. Protect the SAFEST such child explicitly. Previously we reserved
  // whichever adaptive candidate happened to have the lowest generated id,
  // which surfaced a direct Whidbey route and left the useful blend only in
  // the troubleshooting list.
  const ferryCrossBreed = unique.filter((r) => r._profile.crossBreedKind === 'ferry')
    .reduce((best, route) => !best || compareSafety(route, best) < 0 ? route : best, null);
  const sectionFrontier = unique.filter((r) => r._profile.sectionFrontier)
    .reduce((best, route) => !best || compareSafety(route, best) < 0 ? route : best, null);
  const combinedCorridor = unique.find((r) => r._profile.id.startsWith('combined-corridor'));
  const strongPreferredCandidate = preferredRoutesActive(rules)
    ? bestStrongPreferredCandidate(unique) : null;
  const protectedCandidates = new Set([
    preferred, bothPreferences, fullyMatching, adaptiveCorridor, ferryCrossBreed,
    sectionFrontier, combinedCorridor, strongPreferredCandidate,
  ].filter(Boolean));
  // A route may be objectively slower and no safer yet still give the rider a
  // useful different corridor. Only prune dominated candidates when their
  // geometry is also effectively the same.
  //
  // v.768 removed that geometry condition, on the finding that a route beaten
  // on distance AND time AND failing road was a wasted slot whatever corridor
  // it used. It is not, and the cost was measured on the road: University
  // District -> Woodland Park Zoo stopped offering 11th Avenue NE -- 1,570 m of
  // bike lane on a corridor nothing else touched -- and stayed that way for six
  // commits while near-identical routes held letters. Three follow-ups tried to
  // rescue it: rank the losers by redundancy, protect the most distinct six,
  // measure distinctness farthest-first so a corridor's two candidates stop
  // cancelling each other out. Each fixed a real defect in the one before it.
  //
  // With all three in place the trim was measured against the 30-trip corpus
  // with itself switched off, and it had become a no-op: 179 options either
  // way, 15 dominated either way, mean overlap 0.307 vs 0.303, and one MORE
  // near-identical pair with it on than off. Its own guard rails had reduced it
  // to nothing, because it may only remove candidates outside the most distinct
  // six and those are the ones the selection pass drops anyway.
  //
  // So it is gone, and the geometry condition is back. What actually widened
  // this trip's portfolio was pricing hills by steepness -- Stone Way N went
  // from 11 m offered to 1,364 m at that commit, with no help from here. A
  // route that loses on every axis is a wasted slot only when the rider already
  // has its corridor; deciding that from the numbers alone deletes the map.
  // The dominator is kept, not merely detected: the troubleshooting record
  // names WHO covered each dominated candidate and by how much.
  const dominatorOf = new Map();
  const useful = unique.filter((candidate) => {
    if (protectedCandidates.has(candidate)) return true;
    const dominator = unique.find((other) => {
      if (other === candidate) return false;
      const safety = compareSafety(other, candidate);
      return edgeOverlap(other, candidate) >= 0.96
        && other.timeS <= candidate.timeS + 5 && safety <= 0
        && (other.timeS < candidate.timeS - 5 || safety < 0);
    });
    if (dominator) dominatorOf.set(candidate, dominator);
    return !dominator;
  });
  const choices = useful.length ? useful : unique;
  progress?.('Comparing safety, travel time, and route variety…', 0.96);

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
  // Choose from the results whose every leg stays within a practical detour
  // of the quickest option; the stricter choices remain available as letters.
  // Distance allows 1.5x where time allows 1.4x: time is the real
  // practicality bound, and a tighter 1.35x distance clause once stranded
  // the star on a 56%-failing corridor because the 17%-failing alternative
  // -- WITHIN the time window -- was 1.55x its distance. A route the rider
  // can ride in comparable time is practical, however the miles divide.
  // v.762 wrapped this in a loop that widened the window (1.8x, 2.2x, 3x, then
  // everything) whenever it admitted fewer than two routes, and added a
  // "fail-share guard" that overrode the star when it failed across 15% or more
  // of its own length. Both were removed in v.769 after being measured rather
  // than reasoned about: across 31 real trips in two states the widening fired
  // ZERO times -- including Kirkland -> Redmond, the trip it was written for,
  // which no longer reproduces -- and the guard changed no recommendation in
  // 146 audited trips. They were shipped on argument, untested by the commit
  // that added them, and never earned their keep. If the one-member pool
  // becomes reachable again, reach for it with a trip that demonstrates it.
  const practicalChoices = choices.filter((route) =>
    route.legs.length === fastestOverall.legs.length && route.legs.every((leg, index) => {
      const quickestLeg = fastestOverall.legs[index];
      return leg.distM <= quickestLeg.distM * 1.5 + 800
        && leg.timeS <= quickestLeg.timeS * 1.4 + 300;
    }));
  // Preserve the strongest practical off-street option explicitly. Trails and
  // protected lanes used to share one aggregate, so a shorter lane-heavy route
  // could crowd the Interurban-heavy choice out even though both "counted" as
  // 100% bike network. Absolute trail distance is deliberate here: it answers
  // the rider's useful question, "which sane option lets me stay away from
  // traffic the longest?"
  const trailRich = practicalChoices.reduce((best, route) => {
    if (!best || (route.trailM || 0) > (best.trailM || 0)) return route;
    if ((route.trailM || 0) === (best.trailM || 0)
        && recommendationScore(route) < recommendationScore(best)) return route;
    return best;
  }, null);
  // The extra strict probe is an availability guarantee, not an instruction
  // to replace the normal recommendation. An all-matching route found by the
  // ordinary profiles remains eligible to be recommended as before.
  const ordinaryPractical = practicalChoices.filter((route) => !route._profile.fullyMatchingProbe);
  const recommendationPool = ordinaryPractical.length ? ordinaryPractical : practicalChoices;
  const preferredRouteAnchor = preferredRoutesActive(rules)
    ? strongPreferredCandidate : null;
  let recommended = null;
  let recommendationBasis = 'lowest-score';
  for (const route of recommendationPool) {
    if (!recommended) { recommended = route; continue; }
    const delta = recommendationScore(route) - recommendationScore(recommended);
    if (delta < 0 || (delta === 0 && compareSafety(route, recommended) < 0)) {
      recommended = route;
    }
  }
  // The rider's rules outrank a MODEST time saving: when the practical
  // recommendation still carries failing distance and a fully matching
  // route (including the strict probe) exists within a wider-but-sane
  // detour, prefer the matching route -- but the switch itself pays the
  // price test. As an unconditional veto this rule undid the priced star:
  // Phinney Ridge -> Mukilteo starred a 40.1 mi / 3h22 zero-fail loop over
  // a 30.7 mi / 2h33 route whose 1% of failing distance prices at about
  // eight minutes -- a 49-minute detour taken automatically, inside the
  // veto's 1.8x window. Zero-fail is now worth at most ten minutes of
  // score on top of what fail meters already charge; the best matching
  // candidate is chosen by the same score, not by lexicographic safety.
  const MATCHING_OVERRIDE_PRICE_S = 600;
  if (recommended && recommended.failM > 0.5) {
    const matchingPractical = choices.filter((route) => route.failM <= 0.5
      && route.legs.length === fastestOverall.legs.length
      && route.legs.every((leg, index) => {
        const quickestLeg = fastestOverall.legs[index];
        return leg.distM <= quickestLeg.distM * 1.8 + 1600
          && leg.timeS <= quickestLeg.timeS * 1.85 + 600;
      }));
    const bestMatching = matchingPractical.reduce((best, route) =>
      !best || recommendationScore(route) < recommendationScore(best) ? route : best, null);
    if (bestMatching && recommendationScore(bestMatching)
        <= recommendationScore(recommended) + MATCHING_OVERRIDE_PRICE_S) {
      recommended = bestMatching;
      recommendationBasis = 'fully-matching-override';
    }
  }
  // Last resort: never star a route that fails the rider's rules across a
  // large share of itself while a comparable route beside it barely fails.
  //
  // Every rule above assumes the comparison that produced `recommended` was
  // a real one. The floor on the practical window makes a one-member pool
  // rare; this makes its consequence harmless, and unlike the window it does
  // not depend on a threshold that has already had to move once.
  //
  // The test is the SHARE of the route that fails, not its metres. A long
  // ride with 1% failing distance is an ordinary route with a bad block in
  // it, and overriding there is what once starred a 40.1 mi zero-fail loop
  // over a 30.7 mi route -- a 49-minute detour bought for eight minutes of
  // priced fail. A route failing 15% or more of its own length is a
  // different animal: Kirkland -> Redmond was 47%, two miles of 40 mph
  // arterial with no shoulder, offered beside routes carrying 58-131 m.
  //
  // Placed BEFORE the Preferred-route override on purpose. This guards the
  // AUTOMATIC choice, where the comparison behind the star may have been
  // thin; marking a route Preferred is the rider saying which corridor they
  // want, and a safety net that quietly undid their instruction would be a
  // worse failure than the one it prevents. Running it last did exactly that
  // -- test_preferred_routes caught the strong Preferred candidate losing
  // the star to this rule.
  const guarded = failShareGuardPick(recommended, choices);
  if (guarded) {
    recommended = guarded;
    recommendationBasis = 'fail-share-guard';
  }
  // Marking a named route Preferred is an explicit recommendation request.
  // The strong lens takes the star when it found a route that actually uses
  // the chosen corridor, even when a neutral alternative is materially
  // shorter. Moderate and neutral results remain in the portfolio so this
  // preference never turns into an all-or-nothing constraint.
  if (preferredRouteAnchor) {
    recommended = preferredRouteAnchor;
    recommendationBasis = 'preferred-route-override';
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
  // Six lettered slots, up from five: the direct-lens candidate widened the
  // portfolio's real variety, and the extra slot lets it surface without
  // pushing an ordinary choice out. Interior picks fill to two under the cap
  // so the endpoints (shortest, longest) keep their seats.
  const MAX_OFFERED = 6;
  const selected = [];
  if (selectionChoices.length <= MAX_OFFERED) {
    selected.push(...selectionChoices);
  } else {
    selected.push(selectionChoices[0]);
    const last = selectionChoices[selectionChoices.length - 1];
    const pool = selectionChoices.slice(1, -1);
    while (selected.length < MAX_OFFERED - 2 && pool.length) {
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
  // A ferry composition already represents the important trail/safety section
  // tradeoff on a boat trip. Prefer it over a second global trail extreme when
  // the six slots cannot hold both; on ferry-free trips reserve `trailRich`.
  const trailPortfolio = ferryCrossBreed || trailRich;
  const forwardProgressChoice = selectionChoices.includes(forwardProgressCandidate)
    ? forwardProgressCandidate : null;
  const required = [...new Set([recommended, fastestOverall, safestOverall, boundedSafer,
    forwardProgressChoice, sectionFrontier, trailPortfolio,
    boundedBothPreferences, boundedPreferred, fullyMatching,
    ferryCrossBreed, adaptiveCorridor, combinedCorridor, strongPreferredCandidate,
    preferredRouteAnchor].filter(Boolean))];
  for (const candidate of required) {
    if (selected.includes(candidate)) continue;
    if (selected.length < MAX_OFFERED) {
      selected.push(candidate);
      continue;
    }
    // Drop the most REDUNDANT seat, not the last one. Walking backwards evicts
    // whichever route the diversity pass seated last, and that is structurally
    // the highest-order endpoint -- the most conservative candidate, usually the
    // most distinct thing in the set. Bellevue -> Seattle lost its only I-90
    // route that way (edgeOverlap 0.024 against the rest) while keeping two SR
    // 520 variants that overlap each other 0.696. Redundancy is what a slot is
    // wasted on, so redundancy is what should lose it.
    let replaceAt = -1, worstOverlap = -Infinity;
    for (let i = 0; i < selected.length; i++) {
      if (required.includes(selected[i])) continue;
      let overlap = 0;
      for (let j = 0; j < selected.length; j++) {
        if (j === i) continue;
        overlap = Math.max(overlap, edgeOverlap(selected[i], selected[j]));
      }
      if (overlap > worstOverlap) { worstOverlap = overlap; replaceAt = i; }
    }
    if (replaceAt < 0) {
      // Every seat is itself required. There are fifteen required roles and six
      // slots, so this happens -- and what happened then was that whoever came
      // LATER in the list was dropped in silence, position deciding the board.
      // Seattle -> Mukilteo lost its combined corridor exactly that way once the
      // safest and quickest roles went to routes the redundancy-ranked trim had
      // kept: a spliced corridor overlaps both its parents by construction, so
      // it can never win a distinctness contest against them, and a guarantee
      // that only holds when the feature's output happens to look unusual is
      // not a guarantee.
      //
      // So the seat goes to whichever required route duplicates the rest of the
      // board most -- never the recommendation, which is the one seat no rule
      // here may take.
      const overlapAgainstBoard = (route) => Math.max(0, ...selected
        .filter((other) => other !== route)
        .map((other) => edgeOverlap(route, other)));
      for (let i = 0; i < selected.length; i++) {
        if (selected[i] === recommended) continue;
        const theirs = overlapAgainstBoard(selected[i]);
        if (theirs > worstOverlap) { worstOverlap = theirs; replaceAt = i; }
      }
    }
    if (replaceAt >= 0) selected.splice(replaceAt, 1, candidate);
  }

  // ---- the diversity sweep ---------------------------------------------
  // Everything above seats routes by ROLE -- safest, quickest, both
  // preferences, section frontier, combined corridor, twelve more -- and
  // nothing anywhere asks whether the finished board shows the rider six
  // different ways to go. On University District -> Woodland Park Zoo it did
  // not: quick-friendly, section-frontier and bike-residential each won a role
  // and all three were the same road, overlapping 0.92 to 0.99, while a
  // 6.2 km route carrying 1,872 m of Stone Way N sat in `choices` with no
  // letter, shorter and quicker than three of the six on offer. Six other
  // Stone Way candidates queued behind it. Nothing filtered them out; the
  // seating simply never looked.
  //
  // So finish by improving the board directly. While some seat is a near-copy
  // of another, swap it for whichever unused candidate is least like what
  // remains -- and keep the swap only when it strictly raises the WORST
  // distinctness on the board. Optimising that minimum is what "show me
  // genuinely different options" means; ranking never expressed it, because a
  // role a route wins says nothing about whether another seat already goes
  // that way.
  //
  // Self-calibrating on purpose: no overlap threshold to tune, because the
  // corpus has no natural one -- 271 dominated candidates spread smoothly from
  // 0.4 to 1.0. The sweep asks only whether a swap makes the board better than
  // it currently is.
  //
  // The starred route never moves. It is the app's answer to "where should I
  // go", and a rule about variety may not overrule it.
  //
  // Overlaps are computed once for every pair that could appear on a board and
  // read back from a table. The sweep tries seats x bench candidates x sweeps
  // boards, each needing every pair in it, so computing them on demand ran
  // edgeOverlap thousands of times per request and cost about three seconds --
  // most of a phone's patience, spent re-deriving the same numbers.
  const bench = selectionChoices.filter((route) => !selected.includes(route));
  const overlapTable = new Map();
  const pairOverlap = (a, b) => {
    let row = overlapTable.get(a);
    if (!row) { row = new Map(); overlapTable.set(a, row); }
    if (!row.has(b)) {
      const value = edgeOverlap(a, b);
      row.set(b, value);
      let mirror = overlapTable.get(b);
      if (!mirror) { mirror = new Map(); overlapTable.set(b, mirror); }
      mirror.set(a, value);
    }
    return row.get(b);
  };
  const boardWorstOverlap = (board) => {
    let worst = 0;
    for (let i = 0; i < board.length; i++) {
      for (let j = i + 1; j < board.length; j++) {
        worst = Math.max(worst, pairOverlap(board[i], board[j]));
      }
    }
    return worst;
  };
  // Every seat is tried against every bench candidate. A cheaper version that
  // only attacked the single worst PAIR was measured and rejected: it found a
  // worse board -- it dropped the 6.2 km Stone Way route this whole exercise
  // was about -- and saved nothing, because the sweep is not where the time
  // goes. Measured on identical code, sweep off 6,000 ms a trip against sweep
  // on 6,271: the whole feature costs 271 ms, about 4%.
  for (let sweep = 0; sweep < MAX_OFFERED && bench.length; sweep++) {
    const before = boardWorstOverlap(selected);
    if (before <= 0) break;
    let bestBoard = null, bestScore = before, bestSeat = -1, bestPick = -1;
    for (let seat = 0; seat < selected.length; seat++) {
      if (selected[seat] === recommended) continue;
      for (let pick = 0; pick < bench.length; pick++) {
        const trial = selected.slice();
        trial[seat] = bench[pick];
        const score = boardWorstOverlap(trial);
        if (score < bestScore) {
          bestScore = score; bestBoard = trial; bestSeat = seat; bestPick = pick;
        }
      }
    }
    if (!bestBoard) break;
    bench.push(selected[bestSeat]);
    bench.splice(bestPick, 1);
    selected.splice(0, selected.length, ...bestBoard);
  }

  let presented = presentAsLetters(selected.slice(0, MAX_OFFERED), recommended);

  // Every request presents a freshly ranked, freshly lettered portfolio.
  // Pinned requests -- re-running a frozen lineup's recipes under held
  // letters, reporting the unroutable ones in `missing` -- left with the
  // app-side pinning system (field decision: regenerate and re-letter
  // normally; the app re-selects by letter).
  // ---- the troubleshooting record -------------------------------------
  // Mark every candidate with the stage that dropped it, so the "More" screen
  // can explain absence rather than merely listing survivors. Order matters:
  // the earliest stage a route failed to reach is the one that removed it.
  const inReasonable = new Set(reasonable), inUnique = new Set(unique);
  const inUseful = new Set(useful), inSelected = new Set(presented);
  const severeM = (route) => route.failM + (route.dismountM || 0) * 3;
  // The candidate's nearest offered route, by shared road. Only computed for
  // routes that reached the seating (offered and not-chosen): the earlier
  // stages carry their own comparator, and paying ~6 edgeOverlap calls for
  // every one of hundreds of raw candidates would cost real seconds.
  const nearestOffered = (candidate) => {
    let best = null, overlap = 0;
    for (const offered of presented) {
      if (offered === candidate) continue;
      const value = pairOverlap(candidate, offered);
      if (value >= overlap) { overlap = value; best = offered; }
    }
    return best ? { mateId: best._profile.id, overlap } : null;
  };
  for (const candidate of raw) {
    candidate._stageData = null;
    if (inSelected.has(candidate)) {
      candidate._stage = 'offered';
      candidate._stageWhy = '';
      candidate._stageData = nearestOffered(candidate);
    } else if (!inReasonable.has(candidate)) {
      candidate._stage = 'too-slow';
      candidate._stageWhy = 'Far slower than the quickest option without being safer.';
      candidate._stageData = { vsQuickestS: fastest.timeS };
    } else if (!inUnique.has(candidate)) {
      const twin = unique.find((other) => !meaningfullyDifferent(candidate, other));
      candidate._stage = 'duplicate';
      candidate._stageWhy = twin
        ? `Effectively the same roads as ${twin._outcome?.label || twin._profile.label}.`
        : 'Effectively the same roads as another option.';
      if (twin) {
        candidate._stageData = { mateId: twin._profile.id,
          overlap: pairOverlap(candidate, twin) };
      }
    } else if (!inUseful.has(candidate)) {
      const dominator = dominatorOf.get(candidate);
      candidate._stage = 'dominated';
      candidate._stageWhy = 'Another option shares this corridor and is no slower and no less safe.';
      if (dominator) {
        candidate._stageData = { mateId: dominator._profile.id,
          overlap: pairOverlap(candidate, dominator),
          slowerS: candidate.timeS - dominator.timeS,
          moreSevereM: severeM(candidate) - severeM(dominator) };
      }
    } else {
      candidate._stage = 'not-chosen';
      candidate._stageWhy = `Survived every filter, but ${MAX_OFFERED} slots were filled by more distinct routes.`;
      candidate._stageData = nearestOffered(candidate);
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

  endPhase('ranking');
  return {
    ok: true, options: presented.map(publicCandidate), ms: Date.now() - started,
    timings: { ...phaseMs, totalMs: Date.now() - started },
    candidatesKey: String(routeKey),
    // Endpoints the pocket re-snap moved (audit C1): the app tells the rider
    // their tap landed on a spot bikes cannot enter (or leave) and where the
    // trip actually starts/ends instead.
    snapNotes: snaps.map((snap, index) => (snap.pocketAdjustedM >= 0 ? {
      point: index, last: index === snaps.length - 1,
      movedM: snap.pocketAdjustedM,
    } : null)).filter(Boolean),
    allCandidates: allCandidates.map((candidate) => ({
      ...candidateSummary(candidate),
      label: candidate._outcome?.label || candidate._extraLabel || candidate._profile.label,
      recommendationBasis: candidate === recommended ? recommendationBasis : null,
    })),
    debug: debug ? {
      raw: raw.map((r) => r._profile.id), reasonable: reasonable.map((r) => r._profile.id),
      unique: unique.map((r) => r._profile.id), useful: useful.map((r) => r._profile.id),
      choices: choices.map((r) => r._profile.id), selected: selected.map((r) => r._profile.id),
      safest: safestOverall._profile.id, boundedSafer: boundedSafer?._profile.id,
      fullyMatching: fullyMatching?._profile.id, adaptiveCorridor: adaptiveCorridor?._profile.id,
      ferryCrossBreed: ferryCrossBreed?._profile.id,
      sectionFrontier: sectionFrontier?._profile.id,
      forwardProgress: forwardProgressChoice?._profile.id,
      trailRich: trailRich?._profile.id,
      combinedCorridor: combinedCorridor?._profile.id,
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
  if (typeof DecompressionStream === 'function') {
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  }
  // WebKit before 16.4 ships no DecompressionStream, and the iOS deployment
  // target admits such devices; the bundled fflate inflates the same bytes.
  // Loaded only on this path so modern engines never parse it.
  if (typeof fflate === 'undefined') importScripts('vendor/fflate.js');
  const raw = fflate.gunzipSync(new Uint8Array(buffer));
  return raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength
    ? raw.buffer : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
}
function receiveGraph(buffer, metadata = {}) {
  // Frontier expansion replaces the whole composite. Anything keyed by an old
  // node, edge or arc index must be gone before the new dimensions take over.
  trimRoutingCaches();
  lastCandidates = null;
  lastCandidatesKey = null;
  preferredEdges = null;
  preferredRoutesKey = '';
  suppressedRouteEdges = null;
  suppressedRoutesKey = '';
  activeRoadBlockEdges = null;
  searchGeneration = 0;
  postMessage({ type: 'progress', phase: 'engine', detail: 'Reading the statewide routing map…' });
  loadGraph(buffer);
  loadedGraphInputBytes = buffer.byteLength;
  allowDisconnectedSnaps = !!metadata.partitioned;
  configuredFrontiers = new Map();
  requestFrontierHits = new Map();
  graphStateIds = Array.isArray(metadata.stateIds) ? [...metadata.stateIds] : [];
  loadedPartitionIds = Array.isArray(metadata.loadedPartitionIds) ? [...metadata.loadedPartitionIds] : [];
  graphPartitionRanges = Array.isArray(metadata.partitionRanges)
    ? metadata.partitionRanges.map((range) => ({ ...range })) : [];
  partitionGraphDiagnostics = metadata.diagnostics || null;
  const sidecar = (value, count) => {
    if (value instanceof Uint16Array && value.length === count) return value;
    if (value instanceof ArrayBuffer && value.byteLength === count * 2) return new Uint16Array(value);
    return null;
  };
  eStateIndex = sidecar(metadata.edgeStateIndexes, E);
  ePartitionIndex = sidecar(metadata.edgePartitionIndexes, E);
  postMessage({ type: 'ready', nodes: N, edges: E, memory: routingMemoryStats(),
    loadedPartitionIds: [...loadedPartitionIds] });
}

onmessage = (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'graph') {
      if (!isGzip(m.buffer)) { receiveGraph(m.buffer, m); return; }
      postMessage({ type: 'progress', phase: 'engine',
        detail: 'Unpacking road, trail, ferry, and elevation data…' });
      gunzip(m.buffer)
        .then((raw) => receiveGraph(raw, m))
        .catch((e) => postMessage({ type: 'error', message: `graph: ${e && e.message || e}` }));
    } else if (m.type === 'route') {
      beginFrontierRequest();
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
      const routePayload = { type: 'route', id: m.id,
        ...publicCandidate({ ...r, _profile: profile }),
        blocksApplied: Array.isArray(m.blocks) ? m.blocks.length : 0,
        frontierHits: publicFrontierHits() };
      if (m.debugUncontrolledCrossings) {
        routePayload.uncontrolledCrossings =
          debugUncontrolledCrossingsFor(routePayload.segs, m.rules);
      }
      postMessage(routePayload);
    } else if (m.type === 'partition-frontiers') {
      configurePartitionFrontiers(m.frontiers);
      postMessage({ type: 'partition-frontiers-ready', id: m.id,
        nodes: configuredFrontiers.size });
    } else if (m.type === 'preferred-routes') {
      receivePreferredRoutes(m.key, m.lines);
    } else if (m.type === 'suppressed-routes') {
      receiveSuppressedRoutes(m.key, m.lines, m.keepLines);
    } else if (m.type === 'configure') {
      // Sent once at startup, before any search allocates. See the cap
      // comment at COST_CACHE_SLOTS: a phone survives startup by holding
      // fewer slots and re-deriving evicted configs instead.
      if (m.constrained) {
        // Two cost/floor configurations cover the adaptive search's hot pair;
        // three compact potentials cover the main modes. The previous 8/8/12
        // limits could retain roughly 300 MB of reusable arrays after one
        // portfolio. These limits keep the request's peak about 200 MB lower,
        // at the cost of rebuilding cold profiles instead of risking a page
        // kill. Desktop keeps the full latency-oriented working set.
        costSlotCap = Math.min(costSlotCap, 2);
        floorSlotCap = Math.min(floorSlotCap, 2);
        potentialCap = Math.min(potentialCap, 3);
      }
    } else if (m.type === 'trim-caches') {
      postMessage({ type: 'trimmed', id: m.id, ...trimRoutingCaches() });
    } else if (m.type === 'routing-memory') {
      postMessage({ type: 'routing-memory', id: m.id, ...routingMemoryStats() });
    } else if (m.type === 'prewarm') {
      useWeights(m.weights);
      // The full working set: the 3-mode x 4-preference grid, then the three
      // discovery-lens keys the request's tail asks for (discover-quick uses
      // the rider's own preference combo; gentle and alternative always run
      // friendly). Grid first -- it serves every search; the lens keys only
      // serve the discovery phase. Chunked and cancellable. A caller may
      // narrow the sweep (tests warm one config to stay fast).
      let configs = Array.isArray(m.configs) && m.configs.length ? m.configs : null;
      if (!configs && m.lite) {
        // A phone browsing the map should not have 300+ MB of cost slots
        // allocated by an idle sweep (field: a crash-and-reload right after
        // an update, when both cache generations were also resident). Warm
        // only the rider's own preference combo -- three slots; a real
        // search allocates and warms the rest organically.
        configs = [];
        for (const mode of ['direct', 'balanced', 'low']) {
          configs.push({ mode, prefDesig: !!m.prefDesignated,
            prefResidential: !!m.prefResidential });
        }
      }
      if (!configs) {
        configs = [];
        for (const mode of ['direct', 'balanced', 'low']) {
          for (const prefDesig of [false, true]) {
            for (const prefResidential of [false, true]) {
              configs.push({ mode, prefDesig, prefResidential });
            }
          }
        }
        if (conservativeDiscoveryRules(m.rules || {})) {
          configs.push({ mode: 'direct', prefDesig: !!m.prefDesignated,
            prefResidential: !!m.prefResidential, lens: true });
          configs.push({ mode: 'low', prefDesig: true, prefResidential: true, lens: true });
          configs.push({ mode: 'balanced', prefDesig: true, prefResidential: true, lens: true });
        }
      }
      prewarmArcCosts(m.rules, configs, m.id);
    } else if (m.type === 'route-options') {
      beginFrontierRequest();
      // A real request outranks background warming; the search itself warms
      // whatever the cancelled sweep had not reached.
      prewarmToken++;
      useWeights(m.weights);
      const pts = m.points && m.points.length >= 2 ? m.points : [m.start, m.end];
      const progress = (detail, frac) => postMessage({ type: 'progress', phase: 'route', id: m.id,
        detail, frac: typeof frac === 'number' ? frac : undefined });
      progress('Testing faster, safer, and bike-friendly route profiles…', 0.02);
      // Everything that can change the portfolio goes into the signature.
      const signature = JSON.stringify([pts, m.rules, !!m.forceDesignated,
        !!m.forceResidential, m.weights || null, m.blocks || null]);
      const result = withRoadBlocks(m.blocks, m.rules, () => routeOptions(pts, m.rules,
        !!m.forceDesignated, !!m.forceResidential, m.preferredProfileId, !!m.debug, progress,
        signature, m.weights || null, m.directProbeWeights || null));
      // The engine's own count of blocks it searched with. A field report of
      // a removed block still steering routes (2026-08-27) could not be told
      // apart from a request that silently carried the stale block; echoing
      // the count lets the app compare against its markers and say which.
      if (m.debugUncontrolledCrossings && Array.isArray(result.options)) {
        for (const option of result.options) {
          option.uncontrolledCrossings = debugUncontrolledCrossingsFor(option.segs, m.rules);
        }
      }
      postMessage({ type: 'route-options', id: m.id, ...result,
        blocksApplied: Array.isArray(m.blocks) ? m.blocks.length : 0,
        frontierHits: publicFrontierHits() });
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
      beginFrontierRequest();
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
        ...publicCandidate({ ...r, _profile: profile }), frontierHits: publicFrontierHits() });
    } else if (m.type === 'edge-grade') {
      // The grade of a road the rider TAPPED, which is not on their route.
      //
      // The road card is built from map-tile properties, and the tiles carry no
      // elevation -- so tapping a street off the route showed every other fact
      // about it and stayed silent on how steep it is, which is one of the
      // things a rider most wants to know before committing to a corridor. The
      // routing graph is already in memory and does carry it, so ask that
      // instead of rebuilding the tiles.
      //
      // Reported UNSIGNED, unlike a route segment. A route segment knows which
      // way the rider is going; a tapped road does not, and "9% uphill" would
      // be a coin flip. The card says how steep the street is and leaves the
      // direction to the rider looking at it.
      //
      // `name` narrows the match when the tile feature has one: two streets can
      // pass within metres at a junction, and the nearest edge is then not
      // necessarily the one under the finger.
      const kx = 111320 * Math.cos((m.lat * Math.PI) / 180), ky = 110540;
      const want = typeof m.name === 'string' && m.name ? m.name.toLowerCase() : null;
      let best = -1, bestD = Infinity;
      for (let ei = 0; ei < E; ei++) {
        const start = eOff[ei], count = eCnt[ei];
        if (count < 2 || eLen[ei] < MIN_REPORTED_GRADE_M) continue;
        if (want && (edgeName(ei) || '').toLowerCase() !== want) continue;
        let px = (gLon[start] - m.lon) * kx, py = (gLat[start] - m.lat) * ky;
        if (Math.sqrt(px * px + py * py) - eLen[ei] > bestD) continue;
        for (let i = start + 1; i < start + count; i++) {
          const qx = (gLon[i] - m.lon) * kx, qy = (gLat[i] - m.lat) * ky;
          const dx = qx - px, dy = qy - py;
          const len2 = dx * dx + dy * dy;
          const t = len2 ? Math.max(0, Math.min(1, -(px * dx + py * dy) / len2)) : 0;
          const nx = px + t * dx, ny = py + t * dy;
          const d = Math.sqrt(nx * nx + ny * ny);
          if (d < bestD) { bestD = d; best = ei; }
          px = qx; py = qy;
        }
      }
      // Far enough away that the graph is answering about a different street.
      const grade = best >= 0 && bestD <= 40
        ? reportedGradePct(Math.max(eAsc[best], eDes[best]), eLen[best]) : null;
      postMessage({ type: 'edge-grade', id: m.id,
        gradePct: grade, metres: best >= 0 ? Math.round(bestD) : null,
        name: best >= 0 ? (edgeName(best) || null) : null });
    } else if (m.type === 'navigation-new-route') {
      beginFrontierRequest();
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
        postMessage({ type: 'navigation-new-route', id: m.id, ...primary,
          frontierHits: publicFrontierHits() });
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
        ms: portfolio?.ms || primary.ms, frontierHits: publicFrontierHits() });
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
