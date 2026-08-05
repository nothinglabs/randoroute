/*
 * Washington Bike Safety Visualizer
 *
 * All road, trail, ferry, restriction, and elevation data is baked into local
 * static files. Routing runs on-device in a web worker; optional runtime
 * network use is limited to rider-initiated place search and Street View.
 *
 * Architecture (built to let Phase 2's OSM source slot in with no rewrite):
 *   - Each data source has its own toggle, its own scorer, and its own layer.
 *   - A scorer maps that source's raw props to NORMALIZED props:
 *       baseScore, shoulder_width, maxspeed_num, prohibited, restricted, freeway,
 *       limited_access, good_facility
 *   - applyEffective() is source-agnostic: it reads only normalized props + the
 *     current riding-rules settings and writes an effective 1-4 level (or 0 = unknown)
 *     used for color. Re-scoring is instant and client-side (no refetch).
 */

const APP_VERSION = '2026-08-05.581';
// All three defined once in build-version.js, which sw.js importScripts() as
// well. The version numbers used to be spelled out separately here with
// comments pointing at the other file, and the URL still was -- in a spelling
// the worker's precache never matched.
const GRAPH_FORMAT_VERSION = self.GRAPH_FORMAT_VERSION;
const GRAPH_DATA_VERSION = self.GRAPH_DATA_VERSION;
const GRAPH_URL = self.GRAPH_URL;
// Segment bitfields, category keys, grade credibility, the shared formatters
// and predicates: all in route-common.js, shared with the Route Details page
// and the router worker so three copies cannot drift again.

/* ---------------------------------------------------------------- palette */
// One visual verdict system, defined once in palette.js and read here. The
// values, and the colour-blindness measurements behind them, live there and in
// docs/SAFETY-MODEL.md -- not in four places that have to be kept in step by
// hand, which is what they used to be.
const BIKE_NETWORK_COLOR = RoutePalette.bikeNetwork;
const DESIGNATED_COLOR = RoutePalette.designated;
const COLORS = RoutePalette.LEVEL;

// The background signed-route ribbon keeps ONE width, always. An earlier
// version widened this whole layer while a route was drawn, which fattened
// every signed corridor in the state rather than the stretch being ridden.
// The route's own designated band (route-designated-band) does that job now,
// from the route's own geometry.
function designatedRibbonWidth() {
  const at = (ncn, rcn) => ['match', ['get', 't'], 'ncn', ncn, rcn];
  // Wider than it used to be. This is now an underlay beneath the road, so its
  // whole visible contribution is what shows past the road line: too narrow and
  // it disappears under the road entirely. National corridors stay wider than
  // regional ones at every zoom.
  return ['interpolate', ['linear'], ['zoom'],
    6, at(7, 4.6), 10, at(13.5, 8.5), 14, at(23, 14.5)];
}

function opaqueColorOverWhite(hex, opacity) {
  const value = String(hex).replace('#', '');
  const channel = (offset) => parseInt(value.slice(offset, offset + 2), 16);
  const blend = (component) => Math.round(component * opacity + 255 * (1 - opacity));
  return `#${[channel(0), channel(2), channel(4)]
    .map((component) => blend(component).toString(16).padStart(2, '0')).join('')}`;
}
function routeSurfaceLabel(surface) {
  const value = Number(surface);
  return Number.isInteger(value) && value >= 0 && value < SURFACE_LABEL.length
    ? SURFACE_LABEL[value] : SURFACE_LABEL[0];
}

/* ------------------------------------------------- riding-rules state */
const DEFAULT_RULES = Object.freeze({
  // A routing permission, never a verdict: a freeway always fails. Off means
  // the router may not use one at all; on means it may, as a last resort, and
  // those segments still report as failing.
  allowFreeways: true,
  allowMtbTrails: false, // technical MTB paths are opt-in, not ordinary bike routing
  preferPaved: true,    // strongly prefer pavement by default; unpaved remains available
  minShoulder: 4,       // ft; below this a road gets penalized
  // On. It loosens the shoulder rule -- a road that recorded no shoulder can
  // clear it on derived evidence -- which is why it shipped off first and was
  // turned on deliberately once the effect had been measured.
  //
  // The case for on: an untagged shoulder is unconditionally 0 ft, and only
  // 7.5% of road features carry a shoulder tag, so without this the map asserts
  // failure from absence of data across most of the network. Where the county
  // logged edge space we have real evidence, and using it is strictly better
  // than treating the road as having nothing. It can only ever be kinder --
  // zero is already the floor -- and a recorded shoulder always wins.
  //
  // On for The Randonneur, which inherits DEFAULT_RULES wholesale -- keeping it
  // here is also what makes a fresh install match that preset. Weekend Wanderer
  // and Casual Cruiser switch it off: both exist to honour slower roads
  // literally, and Casual Cruiser filters routes to fully matching road, where a
  // guessed shoulder must not be what lets a road in.
  inferShoulderFromEdge: true,
  // mph; at/below this a road passes without a shoulder. One number, town or
  // country: a 35 mph lane with no shoulder is the same lane whether or not a
  // Census polygon contains it, and the old 30/35 split asked a rider to hold an
  // opinion about a distinction the road does not make. The urban flag is still
  // carried and still shown on the card; it just no longer forks this rule.
  maxSpeedNoShoulder: 35,
  // MORE lanes than this and a road must offer a shoulder or a bike lane.
  // Strictly greater, matching how the setting reads on screen.
  // MAX_LANES_NO_LIMIT disables it.
  lanesNoShoulderOver: 3,
  // How busy before a road needs space of its own, as an index into
  // SafetyModel.BUSY_LEVELS. 0 is off; 2 is "a neighborhood street", about
  // 2,000 vehicles a day or a major collector where there is no count.
  busyNoShoulder: 2,
  allowSidewalkFallback: true, // a mapped sidewalk can satisfy the shoulder rule, with caution
  upperMaxSpeed: 45,    // mph; roads above this absolute cutoff fail
  noUpperLimit: true,   // disable the upper-speed hard cap
  requireSafe: false,   // limit the portfolio to routes whose every edge matches the rules
});
const rules = { ...DEFAULT_RULES };
// Top of the lanes slider means "no limit" rather than a literal count. It
// stops at 6 because a "6 lanes without a shoulder is fine" rule is one nobody
// would pick over turning the rule off entirely.
const MAX_LANES_NO_LIMIT = 6;
const RULE_NUMBER_LIMITS = {
  minShoulder: [2, 10],
  lanesNoShoulderOver: [1, MAX_LANES_NO_LIMIT],
  busyNoShoulder: [0, 4],
  maxSpeedNoShoulder: [15, 45],
  upperMaxSpeed: [25, 65],
};

// Soft route-choice costs. These never make an edge legal or illegal; the
// rider-facing Limits remain the hard safety rules. Kept in one shared shape
// with router-worker.js so the advanced desktop editor is reproducible.
const DEFAULT_ROUTING_WEIGHTS = Object.freeze({
  failRoadDirect: 1.5, failRoadBalanced: 9, failRoadLowStress: 30,
  comfyRoadBalanced: 0.92, comfyRoadLowStress: 0.9,
  designated: 0.94, strongDesignated: 0.5, residential: 0.78,
  facilityShared: 0.82, facilityLane: 0.36, facilityBuffered: 0.32,
  facilitySeparated: 0.31, facilityPath: 0.21,
  mtbTrail: 6,
  freeway: 60,
  limitedAccessDirect: 1.05, limitedAccessBalanced: 1.35, limitedAccessLowStress: 1.75,
  speedOverBalanced: 0.01, speedOverLowStress: 0.02,
  speedBelowDirect: 0.005, speedBelowBalanced: 0.015, speedBelowLowStress: 0.03,
  curveDirect1: 1.08, curveDirect2: 1.16, curveDirect3: 1.3,
  curveBalanced1: 1.35, curveBalanced2: 1.8, curveBalanced3: 2.6,
  curveLowStress1: 1.8, curveLowStress2: 3.4, curveLowStress3: 6.5,
  busyLightDirect: 1.02, busyLightBalanced: 1.12, busyLightLowStress: 1.22,
  busyMediumDirect: 1.05, busyMediumBalanced: 1.28, busyMediumLowStress: 1.48,
  busyHeavyDirect: 1.1, busyHeavyBalanced: 1.5, busyHeavyLowStress: 1.85,
  useMeasuredTraffic: 1,
  wideRoadDirect: 1.03, wideRoadBalanced: 1.14, wideRoadLowStress: 1.24,
  stressedRoadDirect: 1.04, stressedRoadBalanced: 1.18, stressedRoadLowStress: 1.30,
  ferryWaitMin: 15, uphillFactor: 7, downhillFactor: 2.5, undulationSecPerM: 3,
  climbDirectSecPerM: 0.25, climbBalancedSecPerM: 0.9, climbLowStressSecPerM: 1.6,
  turnDirectSec: 6, turnBalancedSec: 11, turnLowStressSec: 15,
  diversityQuick: 1.3, diversityBalanced: 1.35, diversitySafer: 1.35, diversityWide: 1.6,
});
// Weights the rider tuned under the old names, so a saved custom set is
// carried across the rename instead of silently snapping back to defaults.
// Values are unchanged -- only the key moved -- so this is not a migration of
// behaviour and needs no version bump.
const RENAMED_ROUTING_WEIGHTS = Object.freeze({
  directFail: 'failRoadDirect', balancedFail: 'failRoadBalanced', lowFail: 'failRoadLowStress',
  balancedComfy: 'comfyRoadBalanced', lowComfy: 'comfyRoadLowStress',
  limitedDirect: 'limitedAccessDirect', limitedBalanced: 'limitedAccessBalanced',
  limitedLow: 'limitedAccessLowStress',
  speedBalanced: 'speedOverBalanced', speedLow: 'speedOverLowStress',
  speedBelowLow: 'speedBelowLowStress',
  hazardDirect1: 'curveDirect1', hazardDirect2: 'curveDirect2', hazardDirect3: 'curveDirect3',
  hazardBalanced1: 'curveBalanced1', hazardBalanced2: 'curveBalanced2', hazardBalanced3: 'curveBalanced3',
  hazardLow1: 'curveLowStress1', hazardLow2: 'curveLowStress2', hazardLow3: 'curveLowStress3',
  arterialTertiaryDirect: 'busyLightDirect', arterialTertiaryBalanced: 'busyLightBalanced',
  arterialTertiaryLow: 'busyLightLowStress',
  arterialSecondaryDirect: 'busyMediumDirect', arterialSecondaryBalanced: 'busyMediumBalanced',
  arterialSecondaryLow: 'busyMediumLowStress',
  arterialPrimaryDirect: 'busyHeavyDirect', arterialPrimaryBalanced: 'busyHeavyBalanced',
  arterialPrimaryLow: 'busyHeavyLowStress',
  measuredTraffic: 'useMeasuredTraffic',
  wideRoadLow: 'wideRoadLowStress', stressedRoadLow: 'stressedRoadLowStress',
  climbLowSecPerM: 'climbLowStressSecPerM', turnLowSec: 'turnLowStressSec',
});
const ROUTING_WEIGHTS_VERSION = 8;
function validRoutingWeights(source) {
  const clean = {};
  const zeroOkay = new Set(['ferryWaitMin', 'speedOverBalanced', 'speedOverLowStress',
    'speedBelowDirect', 'speedBelowBalanced', 'speedBelowLowStress', 'downhillFactor', 'undulationSecPerM',
    'climbDirectSecPerM', 'climbBalancedSecPerM', 'climbLowStressSecPerM',
    'turnDirectSec', 'turnBalancedSec', 'turnLowStressSec', 'useMeasuredTraffic']);
  if (!source || typeof source !== 'object') return clean;
  const renamed = {};
  for (const [was, now] of Object.entries(RENAMED_ROUTING_WEIGHTS)) {
    if (source[was] !== undefined && source[now] === undefined) renamed[now] = source[was];
  }
  for (const key of Object.keys(DEFAULT_ROUTING_WEIGHTS)) {
    const value = Number(source[key] !== undefined ? source[key] : renamed[key]);
    if (Number.isFinite(value) && value >= (zeroOkay.has(key) ? 0 : 0.1) && value <= 120) clean[key] = value;
  }
  return clean;
}

function validRuleOverrides(source) {
  const clean = {};
  if (!source || typeof source !== 'object') return clean;
  for (const [key, current] of Object.entries(rules)) {
    const value = source[key];
    if (typeof current === 'boolean' && typeof value === 'boolean') clean[key] = value;
    if (typeof current === 'number' && Number.isFinite(value)) {
      const [min, max] = RULE_NUMBER_LIMITS[key] || [-Infinity, Infinity];
      clean[key] = Math.min(max, Math.max(min, value));
    }
  }
  // Saved settings and shared links predating the collapse to one speed. Rural
  // wins over urban because the single default IS the old rural value, so a
  // rider who never touched either lands exactly where the new default is.
  // `freeMaxSpeed` predates even the urban/rural split.
  if (clean.maxSpeedNoShoulder == null) {
    const legacy = Number(source.ruralMaxSpeedNoShoulder)
      || Number(source.urbanMaxSpeedNoShoulder)
      || Number(source.freeMaxSpeed);
    if (Number.isFinite(legacy) && legacy > 0) {
      const [min, max] = RULE_NUMBER_LIMITS.maxSpeedNoShoulder;
      clean.maxSpeedNoShoulder = Math.min(max, Math.max(min, legacy));
    }
  }
  return clean;
}

/* --------------------------------------------------- display state */
// Pass/fail mode: an accessibility-friendly view that doesn't rely on telling
// colors apart. Instead of a 1-4 color ramp it shows ONLY roads that meet the
// criteria (effective level at/below passMax), painted a single green; every
// other road is hidden. Recomputes live as the riding rules change.
const PASS_COLOR = '#009E73';
const display = {
  passFail: false, // retained internally for backwards-compatible saved state; no UI toggle
  passMax: 2, // a road "passes" if its effective level is 1..passMax (Low & Moderate)
  offstreetTrails: true,
  bikeFacilities: true,
  meetRules: true,
  failRules: true,
  caution: true,
  designated: true,
  unpavedBackground: true,
  bikesProhibited: true,
};


// The background network is useful context, but the planned route needs to
// remain visually dominant.  Keep every non-route line at a consistent visual
// strength, then soften it again while a route is on the map.  Scaling from
// the former 0.95 baseline preserves the deliberately quieter designation and
// failure overlays without letting any of them compete with the route.
let routeIsDisplayed = false;
function backgroundLineOpacity(baseOpacity) {
  const targetOpacity = routeIsDisplayed ? 0.4 : 0.6;
  return Math.min(1, baseOpacity * (targetOpacity / 0.95));
}

// A road with a bike lane or better is the thing most riders are looking for,
// so it gets a stronger opacity than ordinary background roads. At the shared
// 0.9 base it pre-blended to about 0.57 over white and read as faint.
function bikeNetworkBackgroundLineOpacity() {
  return routeIsDisplayed ? 0.72 : 0.86;
}

// Caution has a specific semantic meaning, so keep it solid enough to avoid
// a dashed layer beneath showing through at the normal background opacity.
function cautionBackgroundLineOpacity() {
  return routeIsDisplayed ? 0.65 : 0.76;
}

/* ------------------------------------------------------- the scorers */
// Each returns normalized props. baseScore null => unknown (gray).

// The WSDOT stress data carries no motorway flag, so an Interstate express lane
// arrives looking like any other limited-access highway and was described as a
// caution -- "ride it with caution" on a road bikes may not use at all. WSDOT
// numbers Interstates with these seven route prefixes, so recover the fact from
// the route id: 11,098 of the 55,271 segments.
const INTERSTATE_ROUTE_PREFIXES = new Set(Region.interstateRoutePrefixes);
function isInterstateRoute(routeIdentifier) {
  const match = /^(\d{3})/.exec(String(routeIdentifier || ''));
  return !!match && INTERSTATE_ROUTE_PREFIXES.has(match[1]);
}

// WSDOT names its facility types; the rest of the app speaks the shared 0-5
// level. Without this the card could only ever say "there is something here",
// so a shared-use path and a painted lane scored alike.
function agencyFacilityLevel(type) {
  if (!type || type === 'nan') return 0;
  return Region.facilityLevels[type] || 0;
}

function scoreBLTS(p) {
  // WSDOT already computed LTS_Bicycle (1-4). It is a STRESS RATING, and it
  // belongs in stressRating alone.
  //
  // It used to be assigned to baseScore as well, which factsFrom maps to
  // `infraScore` -- the model's answer to "how good is this bike
  // infrastructure". Two unrelated meanings in one field. It was inert only
  // because `infra` is false for this source, so the infra rung never read it;
  // anything that ever set infra here would have turned a stress rating of 4
  // into a level-4 verdict by a route the ladder never intended.
  const lts = p.LTS_Bicycle;
  return {
    baseScore: null,
    stressRating: lts == null ? null : lts,
    lanes: p.LaneCount || 0,
    shoulder_width: p.ShoulderWidth == null ? null : p.ShoulderWidth,
    maxspeed_num: p.SpeedLimit == null ? null : p.SpeedLimit,
    prohibited: !!p.Prohibited, // overlaps a WSDOT permanent bike restriction
    wsdotBan: !!p.Prohibited,
    restricted: false,
    freeway: isInterstateRoute(p.RouteIdentifier),
    limited_access: !!p.LimitedAccess,
    // From the same grading as `facility`, not from the string's mere
    // presence: WSDOT's literal 'nan' placeholder has length, and reading
    // "non-empty" as "there is a lane here" made the card call three
    // placeholder segments bike network while the tiles refused them.
    good_facility: agencyFacilityLevel(p.BikeFacilityType) >= 2,
    facility: agencyFacilityLevel(p.BikeFacilityType),
    infra: false,
    desig: p.Designated === 1, // on a designated bike route (USBR / regional)
    urban: p.Urban === 1,
    // WSDOT carries its own AADT on 85% of segments, and the card has always
    // PRINTED it -- while the verdict ignored it, because scoreBLTS never put it
    // into the facts. So a state highway with 4,122 vehicles/day and no shoulder
    // read "nothing here demands space of its own" on the card while the road
    // tile, which does see the count, drew it as failing. Reported from the
    // field on SR 104 at Kingston.
    //
    // No functional class in this source; the count is the stronger signal
    // anyway and the model prefers it wherever both exist.
    measures: p.AADT == null ? null : { adt: Number(p.AADT) },
  };
}

// OSM bike infrastructure (Phase 2). Dedicated cycleways, bike lanes, shared
// paths. These aren't shared-with-traffic roads, so the speed/shoulder rules
// don't apply — the infrastructure TYPE is the rating (see effectiveLevel).
// Mirrors scripts/build_osm.py's classify().
const OSM_PROTECTED = new Set(['track', 'separated', 'opposite_track']);
const OSM_LANE = new Set(['lane', 'shared_lane']);
function osmCycleway(p) {
  return p.cycleway || p['cycleway:both'] || p['cycleway:right'] || p['cycleway:left'] || null;
}
// True when the way is in the bike-infrastructure layer only because someone
// painted sharrows on it: no separate path, no bike lane, no bike designation.
// Paint in a traffic lane on an ordinary road, with no facility of its own.
//
// `bicycle=designated` used to exempt a way from this, on the reasoning that a
// signed route is more than a sharrow. Two things make that wrong. Designation
// trust was removed from the model entirely -- a route number is an agency's
// recommendation, not a measurement of the road -- and scoreOSM never had a
// branch that scored one, so a designated sharrow fell through to
// `baseScore: null` while still claiming `infra: true`. The model's infra rung
// then returned level 0, and tapping 1st Avenue in downtown Seattle -- a
// secondary arterial whose speed, lanes and traffic count we hold -- answered
// "Insufficient data".
// Highway types that ARE a facility in their own right, whatever paint they
// happen to carry.
const DEDICATED_INFRA_HW = new Set(['cycleway', 'path', 'footway', 'bridleway',
  'track', 'service']);

function sharrowOnly(p) {
  if (!p) return false;
  if (osmCycleway(p) !== 'shared_lane') return false;
  const hw = p.highway;
  return !(hw === 'cycleway' || hw === 'path' || hw === 'footway'
    || hw === 'bridleway' || hw === 'track' || hw === 'service');
}

// The declarative twin of sharrowOnly(), for layer filters. MapLibre evaluates
// filters in the renderer and cannot call the predicate above, so the two have
// to be kept in step by hand; test_safety_model.mjs sweeps the expression
// against the shared model to catch them drifting.
// A sharrow-only way must never be a tap target on the bike-infrastructure
// layer. It is paint in a traffic lane, not a facility, and letting it win the
// hit test short-circuits the whole ladder: scoreOSM gives it baseScore null,
// the model's `infra` rung returns level 0, and a rider tapping a sharrowed
// downtown street gets "Insufficient data" for a road we know the speed, lane
// count and traffic volume of. Excluding it here lets the tap fall through to
// the roads layer underneath, which answers properly.
function osmHitFilter(src) {
  if (src.id !== 'osm') return null;
  return ['!', sharrowOnlyExpr()];
}

function sharrowOnlyExpr() {
  // Tag precedence mirrors osmCycleway(): right before left. The two readers
  // disagreed only on a way tagged differently per side, but that is exactly
  // the lane-one-way sharrow-the-other case where the answer matters.
  const cw = ['coalesce', ['get', 'cycleway'], ['get', 'cycleway:both'],
    ['get', 'cycleway:right'], ['get', 'cycleway:left'], ''];
  return ['all',
    ['==', cw, 'shared_lane'],
    ['!', ['in', ['coalesce', ['get', 'highway'], ''],
      ['literal', ['cycleway', 'path', 'footway', 'bridleway', 'track', 'service']]]]];
}

function scoreOSM(p) {
  const bike = p.bicycle;
  const hw = p.highway;
  const cw = osmCycleway(p);
  const bikeish = hw === 'cycleway' || hw === 'path' || hw === 'bridleway'
    || hw === 'track' || hw === 'service' || cw != null;
  let base = null;
  let prohibited = false;
  const dismount = bike === 'dismount';
  // The prohibition is checked FIRST. It used to sit at the end, after the
  // cycleway branches, so a way tagged `bicycle=no` that also carried a
  // `cycleway=shared_lane` marking hit the sharrow branch, took `base = null`
  // and reported "Insufficient data" instead of "bikes prohibited" -- the
  // strongest verdict we have, silently downgraded to the weakest.
  if (bike === 'no' && bikeish) {
    base = 4; prohibited = true;
  }
  else if (hw === 'cycleway' && bike !== 'no') base = 1;
  else if (hw === 'path' && (bike === 'designated' || bike === 'yes')) base = 1;
  // `yes` as well as `designated`, matching path/bridleway/track just above and
  // matching classify_way() in build_graph.py, which routes over a
  // `bicycle=yes` footway. The app was stricter than the graph, so a footway the
  // router will happily send you along scored baseScore null here and the card
  // called it "Insufficient data".
  else if (hw === 'footway' && (bike === 'designated' || bike === 'yes')) base = 2;
  else if (hw === 'bridleway' && (bike === 'designated' || bike === 'yes')) base = 2;
  else if (hw === 'track' && (bike === 'designated' || bike === 'yes')) base = 2;
  else if (hw === 'service' && bike === 'designated'
      && (p.motor_vehicle === 'no' || p.motor_vehicle === 'private'
        || p.access === 'no' || p.access === 'private')) base = 1;
  else if (OSM_PROTECTED.has(cw)) base = 1;
  else if (cw === 'shared_lane') base = null;   // sharrow: see sharrowOnly()
  else if (OSM_LANE.has(cw)) base = 2;
  // Last resort for a dedicated-infrastructure way that matched no branch above
  // -- most often a path or footway carrying a stray `cycleway=shared_lane`
  // marking. build_osm.py exports it (its LANE set still counts shared_lane as a
  // lane), so it reaches the layer and must be describable. A path with sharrow
  // paint on it is still a path; scoring it null made the card say
  // "Insufficient data" about dedicated infrastructure.
  if (base == null && !prohibited && DEDICATED_INFRA_HW.has(hw)) base = 2;
  const width = p.width != null ? parseFloat(p.width) : NaN;
  return {
    baseScore: base,
    shoulder_width: Number.isFinite(width) ? width : null,
    maxspeed_num: null,
    prohibited,
    restricted: false,
    freeway: false,
    limited_access: false,
    good_facility: base != null && !prohibited,
    infra: true,
    mountain_bike: p.mtb === 1,
    dismount,
  };
}

// Full OSM road network (Phase 3). Short property keys (see build_roads.py):
// h=class s=speed(mph) e=estimated f=facility b=bike-prohibited m=motorway
// w=shoulder(ft) n=name r=ref k=sidewalk state u=urban area. Speeds are always
// present — actual, or inferred from road class (BNA-style) with e=1 marking it.
function scoreRoad(p) {
  return {
    baseScore: null,
    shoulder_width: p.w == null ? null : p.w,
    maxspeed_num: p.s == null ? null : p.s,
    prohibited: p.b === 1,
    restricted: false,
    freeway: p.m === 1,
    limited_access: p.m === 1 || p.l === 1,
    // Paint in a shared lane is not space of your own, so a sharrow (ft 1)
    // must not satisfy a shoulder rule the way a bike lane (ft 2+) does.
    good_facility: p.ft >= 2 || (p.f === 1 && p.ft == null),
    // The LEVEL, not just the flag. factsOf read `n.facility` and no scorer
    // ever set it, so every card collapsed a separated path and a painted lane
    // into the same road.
    facility: p.ft == null ? 0 : p.ft,
    infra: false,
    lanes: p.ln || 0,
    ctl: p.ctl === 1,
    stressRating: p.lts || null,
    est: p.e === 1,
    desig: p.g === 1, // on a designated bike route (USBR / regional)
    sidewalk: p.k === 1 ? 'present' : p.k === 2 ? 'absent' : null,
    urban: p.u === 1,
    measures: tileMeasures(p),
  };
}

// The statewide road measurements, from a roads tile. Display only: nothing
// here reaches roadLevelExpr, so none of it can move a road's colour. Kept in
// one shape so the tap card and the route card read the same object.
function tileMeasures(p) {
  const out = {};
  if (p.adt) {
    out.adt = p.adt;
    if (p.ay) out.adty = p.ay;
    out.adtSrc = p.asrc || ADT_SOURCE_COUNTY;
  }
  if (p.es != null) {
    out.edge = p.es;
    if (p.ec) out.edgeClamp = 1;
  }
  if (p.cs != null) out.countySh = p.cs;
  if (p.csl) out.countySurface = p.csl;
  if (p.fc) out.fc = p.fc;
  if (p.ow) out.owner = p.ow;
  return Object.keys(out).length ? out : null;
}

// Designated-routes overlay (USBR / regional trails): informational, not
// scored — the underlying roads are judged by the other layers.
function scoreRouteOverlay() {
  return { baseScore: null, shoulder_width: null, maxspeed_num: null, prohibited: false,
           restricted: false, freeway: false, limited_access: false, good_facility: false, infra: false };
}

// WSDOT Permanent Bike Restrictions overlay: always prohibited, by definition.
function scoreRestrict() {
  return { baseScore: 4, shoulder_width: null, maxspeed_num: null, prohibited: true,
           restricted: true, freeway: false, limited_access: false, good_facility: false, infra: false };
}

/* --------------------------------------------- source-agnostic scorer */
// Every rule below lives in safety-model.js. These are thin wrappers so callers
// that hold a scored feature rather than a facts object keep reading naturally;
// none of them may contain a threshold of their own.
function noShoulderMaxSpeed(n) { return SafetyModel.noShoulderMaxSpeed(factsOf(n), rules); }
function sidewalkFallbackApplies(n) {
  const f = factsOf(n);
  return SafetyModel.sidewalkFallbackApplies(f, SafetyModel.effectiveShoulder(f, rules), rules);
}
function needsSpace(n) { return SafetyModel.needsSpace(factsOf(n), rules); }
function spaceReasons(n) { return SafetyModel.spaceReasons(factsOf(n), rules); }

// Normalised source props -> the shared ladder's facts shape. Every scorer
// (scoreOSM/scoreRoad/scoreBLTS/scoreRouteSeg) already produces this vocabulary;
// this is the single adapter between it and safety-model.js.
function factsOf(n) { return SafetyModel.factsFrom(n); }


function evaluateRoad(n) { return SafetyModel.evaluate(factsOf(n), rules); }
function effectiveLevel(n) { return evaluateRoad(n).level; }

/* ------------------------------------------------ data-source registry */
// zRank controls draw order: higher ranks render on top of lower ones.
const SOURCES = [
  {
    id: 'routes',
    name: 'Designated routes (USBR & regional)',
    url: 'data/bikeroutes.geojson.gz',
    scorer: scoreRouteOverlay,
    // An underlay, beneath everything. A signed route is CONTEXT -- it says a
    // corridor is recommended, not what the road under your wheels is like --
    // so it must never sit on top of the thing it is context for. At 2.5 it
    // drew over ordinary road and facility scoring, which put an advisory
    // ribbon above the safety verdict it does not determine.
    //
    // Below `roads` (0), so it is now the bottom of the data stack. It stays
    // visible because it is drawn far wider than a road line: it reads as a
    // band around the road rather than a stripe over it.
    zRank: -1,
    ribbon: true,  // informational overlay: identical in both display modes
    enabled: true,
    fc: null,
    loading: false,
  },
  {
    id: 'blts',
    name: Region.stressLayerName,
    // Vector tiles (shared archive with the OSM bike-infrastructure layer):
    // as GeoJSON these two overlays held ~440 MB of a ~1 GB renderer between
    // the retained parse, the map worker's serialized copy and its geojson-vt
    // index -- for data the rider only sees a viewport of. Same move, same
    // reasons as roads.geojson -> roads.pmtiles. Bump ?v= with sw.js VERSION
    // when the archive is rebuilt (scripts/build_overlay_tiles.py).
    vector: 'pmtiles://data/overlays.pmtiles?v=1',
    mapSourceId: 'overlays',
    sourceLayer: 'blts',
    count: 55271, // baked by build_overlay_tiles.py (tiles carry no global count)
    scorer: scoreBLTS,
    zRank: 1,
    minVisibleZoom: BikeBasemap.ROAD_MIN_ZOOM.major,
    alwaysOn: true, // permanent street-details source; not a Layers checkbox
    enabled: true,
    // This source PAINTS nothing: applyDisplayMode filters its visible layers
    // to false because state-highway verdicts are conflated onto the matching
    // centerline in roads.pmtiles. It exists for hit testing and the tap
    // card, which re-scores the tapped feature's properties directly. Yet it
    // was the one source whose per-feature `level` actually moves with the
    // rider's rules, so every rules change re-scored 55k features and
    // re-uploaded the whole 20 MB collection to the map worker -- the largest
    // single memory spike a slider drag produced, for zero visible change.
    // expr marks it "no precomputed levels": rescore skips it entirely.
    expr: true,
    fc: null,
    loading: false,
  },
  {
    id: 'osm',
    name: 'OSM bike infrastructure',
    vector: 'pmtiles://data/overlays.pmtiles?v=1',
    mapSourceId: 'overlays',
    sourceLayer: 'bikeinfra',
    count: 37788, // baked by build_overlay_tiles.py, after the sharrow-only drop
    scorer: scoreOSM,
    zRank: 2,
    minVisibleZoom: BikeBasemap.ROAD_MIN_ZOOM.major,
    enabled: true,
    expr: true,   // levels compile from osmTileFacts; tiles carry no `level`
    fc: null,
    loading: false,
  },
  {
    id: 'restrict',
    name: Region.restrictionLayerName,
    url: 'data/bike_restrictions.geojson.gz',
    scorer: scoreRestrict,
    zRank: 3,     // always on top
    fixed: true,  // fixed regulatory styling — identical in both display modes
    enabled: true,
    fc: null,
    loading: false,
  },
  {
    id: 'closures',
    name: 'Known route closures (OSM)',
    url: 'data/route_closures.geojson.gz',
    zRank: 4,     // always above roads, routes, and the active route line
    closure: true,
    expr: true,   // static GeoJSON; no riding-rule score to calculate
    enabled: true,
    fc: null,
    loading: false,
  },
  {
    id: 'roads',
    name: 'All roads (OSM, est. speeds)',
    // Vector tiles: the browser fetches only the small tiles in view, so this
    // layer no longer loads 78MB of GeoJSON into memory (it was crashing iOS).
    // The ?v= busts stale HTTP range caches when the tiles are rebuilt —
    // PMTiles bypasses the service worker, and mixing old/new byte ranges
    // silently breaks tile decoding. Bump alongside the sw.js VERSION.
    vector: 'pmtiles://data/roads.pmtiles?v=24',
    // The local basemap already opens this archive for its street geometry and
    // labels. Reuse that MapLibre source for safety coloring and hit testing so
    // iOS does not decode or retain the same vector tiles twice.
    mapSourceId: 'basemap-roads',
    sourceLayer: 'roads',
    count: 338650, // baked at build time (tiles don't carry a global count)
    scorer: scoreRoad,
    zRank: 0,      // above the designated underlay; authoritative layers draw on top
    expr: true,    // scored via map expressions (works identically on tiles)
    // Category-specific opacity still declutters ordinary roads by class.
    // Starting the layer at zero lets a bike facility appear whenever its
    // vector tile contains it, including before the ordinary road class.
    minVisibleZoom: 0,
    enabled: true,  // on by default; automatically decluttered when zoomed out
    fc: null,
    loading: false,
  },
];

// Layer toggles restore from the persisted state (before panels build).
try {
  const st = JSON.parse(localStorage.getItem('wa-bike-state-1') || 'null');
  if (st && st.sources) {
    for (const s of SOURCES) {
      if (!s.alwaysOn && st.sources[s.id] != null) s.enabled = st.sources[s.id];
    }
  }
} catch (e) { /* ignore */ }
// Closures and permanent information sources are not user-selectable layers.
// Keep them enabled even if an older saved preference disabled them.
for (const src of SOURCES) if (src.closure || src.alwaysOn) src.enabled = true;
// The pass/fail presentation was removed from the UI; use the normal
// low-to-high stress colors even for visitors with an older saved preference.
display.passFail = false;

// Rules are baked into the compiled expression as constants, so on any rule
// change we rebuild it and re-apply paint and filters -- instant at any data
// size, and the reason the renderer cannot simply call the model per feature.
/* How a roads.pmtiles feature answers the safety model's facts.
 *
 * This is the only place the road tile's schema is spelled out for painting,
 * and it sits beside scoreRoad(), which answers the same questions for the tap
 * card -- so the two are read together and a tile key that moves is caught in
 * one place. Everything past this point is SafetyModel.buildLadder: the rungs
 * are defined once and this record is the only thing the renderer supplies.
 *
 * A fact the road tiles cannot answer is a literal, and its rung folds out of
 * the compiled expression instead of shipping a dead branch to MapLibre.
 */
function roadTileFacts() {
  // Present-and-recorded. A tag the tile omits is unknown, not zero.
  const tagged = (key) => ({ val: ['get', key], known: ['has', key] });
  // Written only when non-zero, so absent and zero are the same statement:
  // no measurement. Mirrors tileMeasures() and scoreRoad()'s `p.lts || null`.
  const measured = (key) => ({
    val: ['coalesce', ['get', key], 0],
    known: ['>', ['coalesce', ['get', key], 0], 0],
  });
  const flag = (key) => ({ val: ['==', ['coalesce', ['get', key], 0], 1], known: true });
  const fixed = (value) => ({ val: value, known: true });
  return {
    prohibited: flag('b'),
    // Road tiles carry neither. Both rungs fold away.
    ferry: fixed(false),
    infra: fixed(false),
    infraScore: { val: 0, known: false },
    freeway: flag('m'),
    // scoreRoad(), exactly: the graded facility where the tile records one,
    // and otherwise the WSDOT join's coarse flag -- which carries no grade, so
    // it can only assert riding space. Reading `ft` alone left every
    // WSDOT-recorded facility invisible to the map while every card counted it.
    facility: fixed(['case',
      ['has', 'ft'], ['get', 'ft'],
      ['==', ['coalesce', ['get', 'f'], 0], 1], SafetyModel.FACILITY_RIDING_SPACE,
      0]),
    limitedAccess: fixed(['any',
      ['==', ['coalesce', ['get', 'm'], 0], 1],
      ['==', ['coalesce', ['get', 'l'], 0], 1]]),
    speed: tagged('s'),
    shoulder: tagged('w'),
    edgeSpace: tagged('es'),
    lanes: fixed(['coalesce', ['get', 'ln'], 0]),
    sidewalk: fixed(['case',
      ['==', ['coalesce', ['get', 'k'], 0], 1], 'present',
      ['==', ['coalesce', ['get', 'k'], 0], 2], 'absent',
      '']),
    urban: flag('u'),
    stressRating: measured('lts'),
    adt: measured('adt'),
    fc: measured('fc'),
  };
}

// The ladder, compiled for the renderer. MapLibre cannot call evaluate() per
// feature, so this is the one thing that has to cross the gap -- and it crosses
// it as a compilation of the same rungs, not a second transcription of them.
function roadLevelExpr() {
  return SafetyModel.levelExpr(rules, roadTileFacts);
}

// The same compile for whichever expression-scored source is asking. blts
// never asks -- applyDisplayMode() filters its painted layers off before the
// level is consulted -- so only the two sources that actually paint by level
// need a facts adapter here. osmTileFacts is defined with the lime-rule
// adapters below the map setup; by the time any layer paints it exists.
function levelExprFor(src) {
  if (src.id === 'osm') return SafetyModel.levelExpr(rules, osmTileFacts);
  return roadLevelExpr();
}

/* ------------------------------------------------------------- map */
/* ------------------------------------------------- persistence */
// Everything the rider set — rules, mode, layers, view, and the current
// route — survives refreshes and app updates via localStorage.
const STATE_KEY = 'wa-bike-state-1';
const SAVED_ROUTES_KEY = 'wa-bike-saved-routes-1';
let savedState = null;
try { savedState = JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); } catch (e) { /* ignore */ }
if (savedState) {
  if (savedState.rules) Object.assign(rules, validRuleOverrides(savedState.rules));
  if (typeof savedState.passFail === 'boolean') display.passFail = savedState.passFail;
  if (typeof savedState.unpavedBackground === 'boolean')
    display.unpavedBackground = savedState.unpavedBackground;
  if (savedState.mapLayers && typeof savedState.mapLayers === 'object') {
    for (const key of ['offstreetTrails', 'bikeFacilities', 'meetRules', 'failRules',
      'caution', 'designated', 'bikesProhibited']) {
      if (typeof savedState.mapLayers[key] === 'boolean') display[key] = savedState.mapLayers[key];
    }
  }
}
const savedRoutingWeights = validRoutingWeights(savedState?.weights);
const savedWeightsVersion = savedState?.weightsVersion || 0;
// Version 7 deliberately replaced every earlier advanced-weight set so the
// app and worker used the same safety defaults. Version 8 only softens the
// former default turn costs; preserve a rider's genuinely custom values.
if (savedWeightsVersion < 7) {
  Object.assign(savedRoutingWeights, DEFAULT_ROUTING_WEIGHTS);
} else if (savedWeightsVersion < 8) {
  const priorTurnDefaults = { turnDirectSec: 12, turnBalancedSec: 22, turnLowSec: 30 };
  for (const key of Object.keys(priorTurnDefaults)) {
    if (savedRoutingWeights[key] == null || savedRoutingWeights[key] === priorTurnDefaults[key]) {
      savedRoutingWeights[key] = DEFAULT_ROUTING_WEIGHTS[key];
    }
  }
}
const routingWeights = { ...DEFAULT_ROUTING_WEIGHTS, ...savedRoutingWeights };

// Chrome the rider can put away. Deliberately NOT part of any preset and not
// checked by activeRoutingPreset(): a preset describes how routes are chosen,
// and hiding a button changes nothing about that. Applying a preset must leave
// this alone, and turning it off must not knock the rider off their preset.
//
// Off hides the two advanced entry points on the map — the weights button and
// the "More" routes button — and nothing else. The weights panel itself stays
// reachable from Settings > Advanced, so this tidies the map rather than
// removing the feature.
const uiPrefs = {
  showAdvancedTools: typeof savedState?.showAdvancedTools === 'boolean'
    ? savedState.showAdvancedTools : true,
};

// Voice guidance is a local device preference, not part of a shared route.
// Automatic recovery is intentionally disabled for now. Keep the dormant mode
// parsing and recovery functions so the selector can be restored later without
// rebuilding the feature; riders can still request either recovery action from
// the off-route dialog.
const AUTOMATIC_OFF_ROUTE_RECOVERY_ENABLED = false;
const OFF_ROUTE_RECOVERY_MODES = new Set(['guidance', 'return', 'dynamic']);
const savedOffRouteRecoveryMode = OFF_ROUTE_RECOVERY_MODES.has(savedState?.navigationOffRouteMode)
  ? savedState.navigationOffRouteMode
  : savedState?.navigationAutoReroute ? 'return' : 'guidance';
const navVoice = {
  headings: !savedState || typeof savedState.voiceHeadings !== 'boolean'
    ? true : savedState.voiceHeadings,
  updateMin: savedState && Number.isFinite(savedState.voiceUpdateMin)
    ? Math.max(0, Math.min(30, savedState.voiceUpdateMin)) : 0,
  statusRoute: !savedState || typeof savedState.voiceStatusRoute !== 'boolean'
    ? true : savedState.voiceStatusRoute,
  statusSpeed: !savedState || typeof savedState.voiceStatusSpeed !== 'boolean'
    ? true : savedState.voiceStatusSpeed,
  statusMiles: !savedState || typeof savedState.voiceStatusMiles !== 'boolean'
    ? true : savedState.voiceStatusMiles,
  statusEta: !savedState || typeof savedState.voiceStatusEta !== 'boolean'
    ? true : savedState.voiceStatusEta,
  keepScreenAwake: !savedState || typeof savedState.keepScreenAwake !== 'boolean'
    ? true : savedState.keepScreenAwake,
  safetyLevels: !savedState || typeof savedState.voiceSafetyLevels !== 'boolean'
    ? true : savedState.voiceSafetyLevels,
  offRouteMode: AUTOMATIC_OFF_ROUTE_RECOVERY_ENABLED ? savedOffRouteRecoveryMode : 'guidance',
};

const DEFAULT_ROUTE_PREFERENCES = Object.freeze({ prefDesig: true, prefResidential: true });
const ROUTING_PRESETS = Object.freeze([
  {
    id: 'randonneur',
    label: 'The Randonneur',
    audience: 'For long-distance riders who want the widest range of route choices.',
    blurb: 'Widest choice of routes; looser rules, fewer roads flagged as failing.',
    rules: Object.freeze({ ...DEFAULT_RULES }),
    preferences: DEFAULT_ROUTE_PREFERENCES,
  },
  {
    id: 'weekend-wanderer',
    label: 'Weekend Wanderer',
    audience: 'For day riders who want slower roads with practical flexibility.',
    blurb: 'Slower roads, flexible; more roads come back as amber cautions.',
    rules: Object.freeze({
      ...DEFAULT_RULES,
      allowFreeways: false,
      maxSpeedNoShoulder: 25,
      upperMaxSpeed: 45,
      noUpperLimit: false,
      requireSafe: false,
      // Randonneur only. This preset is for riders who want slower roads honoured
      // literally, so a shoulder it infers rather than reads is not good enough.
      inferShoulderFromEdge: false,
    }),
    preferences: DEFAULT_ROUTE_PREFERENCES,
  },
  {
    id: 'casual-cruiser',
    label: 'Casual Cruiser',
    audience: 'For riders who want low-stress routes that fully honor their safety rules.',
    blurb: "Relaxed riding. Routes must follow rules.",
    rules: Object.freeze({
      ...DEFAULT_RULES,
      allowFreeways: false,
      maxSpeedNoShoulder: 25,
      upperMaxSpeed: 35,
      noUpperLimit: false,
      requireSafe: true,
      // Randonneur only -- and especially not here, where requireSafe means a
      // route is filtered to fully matching road. An inferred shoulder must not
      // be what lets a road into that set.
      inferShoulderFromEdge: false,
    }),
    preferences: DEFAULT_ROUTE_PREFERENCES,
  },
]);

function validRoutePoint(point) {
  return Array.isArray(point) && point.length === 2
    && Number.isFinite(point[0]) && Number.isFinite(point[1])
    && point[0] >= -180 && point[0] <= 180 && point[1] >= -90 && point[1] <= 90;
}

function normalizeEndpointName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  return name ? name.slice(0, 120) : null;
}

const MAX_ROUTE_STOPS = 8;
const MAX_ROAD_BLOCKS = 8;
const ROUTE_PROFILE_IDS = new Set([
  'quick', 'quick-bike', 'quick-residential', 'quick-friendly',
  'efficient', 'bike', 'residential', 'bike-residential',
  'gentle', 'gentle-bike', 'gentle-residential', 'friendly',
  'alt-quick', 'alt-balanced', 'alt-safer', 'alt-wide',
  'discover-quick', 'discover-gentle', 'discover-alternative', 'adaptive-corridor',
  'fully-matching',
]);
// Adaptive ferry itineraries carry UNIQUE suffixed ids (adaptive-corridor,
// adaptive-corridor-2, ...) because one portfolio can hold several and every
// structure downstream keys candidates by profile id. Validation accepts the
// family, not just the bare name.
function validRouteProfileId(id) {
  return ROUTE_PROFILE_IDS.has(id) || /^adaptive-corridor-\d+$/.test(String(id || ''));
}
function legacyRouteProfile(mode) {
  if (mode === 'direct') return 'quick';
  if (mode === 'low') return 'gentle';
  return 'efficient';
}

function normalizeStoredRoute(route) {
  if (!route || !validRoutePoint(route.s) || !validRoutePoint(route.e)) return null;
  const vias = Array.isArray(route.v) ? route.v : [];
  const blocks = Array.isArray(route.b) ? route.b : [];
  if (!vias.every(validRoutePoint) || !blocks.every(validRoutePoint)) return null;
  // Preserve plans created before the editor gained a stop limit. New edits
  // cannot add past the limit, but opening an old plan must not delete stops.
  return {
    s: route.s, e: route.e, v: [...vias], b: [...blocks],
    sn: normalizeEndpointName(route.sn), en: normalizeEndpointName(route.en),
    sd: route.sd === true,
  };
}

// A share link keeps the route entirely client-side. Its URL-safe payload is
// validated before it can override a visitor's locally saved route or rules.
function decodeSharedRouteToken(token) {
  try {
    if (!token || token.length > 6000) return null;
    const base64 = token.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((token.length + 3) % 4);
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (data.v !== 1 || !validRoutePoint(data.s) || !validRoutePoint(data.e)) return null;
    const vias = Array.isArray(data.x) ? data.x : [];
    const blocks = Array.isArray(data.z) ? data.z : [];
    if (!vias.every(validRoutePoint) || !blocks.every(validRoutePoint)) return null;
    const sharedRules = validRuleOverrides(data.r);
    return {
      // Version-1 links historically loaded their first eight stops. Preserve
      // that behavior so older links in messages continue to work.
      route: {
        s: data.s, e: data.e, v: vias.slice(0, MAX_ROUTE_STOPS), b: blocks.slice(0, MAX_ROAD_BLOCKS),
        sn: normalizeEndpointName(data.a), en: normalizeEndpointName(data.b),
      },
      mode: ['direct', 'balanced', 'low'].includes(data.m) ? data.m : null,
      profileId: validRouteProfileId(data.o) ? data.o : null,
      prefDesig: typeof data.p === 'boolean' ? data.p : null,
      prefResidential: typeof data.q === 'boolean' ? data.q : null,
      rules: sharedRules,
      weights: data.w && typeof data.w === 'object' && !Array.isArray(data.w) ? data.w : null,
    };
  } catch (e) {
    return null;
  }
}

function readSharedRoute(urlLike = location.href) {
  try {
    const raw = String(urlLike).trim();
    const hash = raw.startsWith('#') ? raw.slice(1) : new URL(raw, location.href).hash.slice(1);
    return decodeSharedRouteToken(new URLSearchParams(hash).get('route'));
  } catch (e) {
    return null;
  }
}

function consumeSharedRouteHash() {
  try {
    const url = new URL(location.href);
    const params = new URLSearchParams(url.hash.slice(1));
    if (!params.has('route')) return;
    params.delete('route');
    url.hash = params.toString();
    history.replaceState(history.state, '', url.toString());
  } catch (e) { /* address-bar cleanup is optional */ }
}

const sharedRoute = readSharedRoute();
// A shared link no longer overwrites the receiver's settings. Its recipe is
// kept aside and used only to rebuild the sender's exact route ("As Shared").

let saveTimer = null;
let stateDirty = false;
// A layer's rider-chosen visibility. While the solo preview is running, the
// live `display` flags are a temporary glance rather than a setting, so
// anything that persists or reports state must read through this.
function savedLayer(key) {
  return soloPreviewRestore ? soloPreviewRestore.flags[key] : display[key];
}
function saveStateNow() {
  flushStoreRouteDetails();
  clearTimeout(saveTimer);
  saveTimer = null;
  // An untouched older tab must not overwrite a newer tab's route when a
  // service-worker update reloads every open copy of the app.
  if (!stateDirty) return true;
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({
      rules, passFail: display.passFail,
      // savedLayer(), not display[], so a solo preview -- which dims every other
      // layer for half a second -- can never be written to disk as the rider's
      // choice. A save can land mid-preview from the debounce or from the tab
      // going to the background.
      unpavedBackground: savedLayer('unpavedBackground'),
      mapLayers: Object.fromEntries(['offstreetTrails', 'bikeFacilities', 'meetRules',
        'failRules', 'caution', 'designated', 'bikesProhibited']
        .map((key) => [key, savedLayer(key)])),
      mode: routing.mode, profileId: routing.profileId,
      prefDesig: routing.prefDesig, prefResidential: routing.prefResidential,
      remix: routing.remix,
      voiceHeadings: navVoice.headings, voiceUpdateMin: navVoice.updateMin,
      voiceStatusRoute: navVoice.statusRoute, voiceStatusSpeed: navVoice.statusSpeed,
      voiceStatusMiles: navVoice.statusMiles, voiceStatusEta: navVoice.statusEta,
      voiceSafetyLevels: navVoice.safetyLevels,
      keepScreenAwake: navVoice.keepScreenAwake,
      navigationOffRouteMode: navVoice.offRouteMode,
      weights: routingWeights, weightsVersion: ROUTING_WEIGHTS_VERSION,
      showAdvancedTools: uiPrefs.showAdvancedTools,
      sources: Object.fromEntries(SOURCES.map((s) => [s.id, !!s.enabled])),
      view: { c: map.getCenter().toArray().map((v) => +v.toFixed(5)), z: +map.getZoom().toFixed(2) },
      route: routing.start && routing.end
        ? {
            s: routing.start, e: routing.end, v: routing.vias.map((x) => x.pt),
            b: routing.blocks.map((x) => x.pt),
            sn: routing.startName, en: routing.endName,
            sd: routing.startFromDevice,
          } : null,
    }));
    stateDirty = false;
    return true;
  } catch (e) { /* storage full/blocked — nonfatal */ }
  return false;
}
function saveStateSoon() {
  stateDirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveStateNow, 800);
}
window.addEventListener('pagehide', saveStateNow);

window.__setAppLaunchStatus?.('Opening local map data…');
const map = new maplibregl.Map({
  container: 'map',
  style: BikeBasemap.createStyle(),
  center: (savedState && savedState.view && savedState.view.c) || Region.defaultCenter,
  zoom: (savedState && savedState.view && savedState.view.z) || 6.4,
  maxZoom: 17,
  maxPitch: 0,
  pitchWithRotate: false,
});
map.once('render', () => window.__setAppLaunchStatus?.('Drawing roads and trails…'));
const finishAppLaunch = () => {
  clearTimeout(window.__appLaunchFallback);
  window.__dismissAppLaunchScreen?.();
};
if (map.loaded()) finishAppLaunch();
else map.once('load', finishAppLaunch);
map.touchPitch?.disable();
// A double tap is too easy to trigger while placing or inspecting a point on
// a phone, and can leave the app looking brokenly zoomed-in. Desktop keeps the
// conventional double-click zoom; touch devices still support pinch zoom.
const COARSE_POINTER = window.matchMedia('(pointer: coarse)').matches;
if (COARSE_POINTER) map.doubleClickZoom.disable();
// Each road class's safety color appears at the same zoom as the corresponding
// locally rendered basemap street. Paint expressions update continuously
// during wheel, touch, keyboard, and programmatic zooms without rebuilding
// feature filters in JavaScript.
map.on('moveend', saveStateSoon);
map.addControl(
  new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserHeading: true,
  }),
  'top-right'
);
map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-right');
// Mouse/trackpad users benefit from explicit zoom buttons. Keep them out of
// phone-sized web layouts and the native shell, where pinch zoom is primary
// and the extra controls would crowd the map toolbar.
const desktopBrowserZoomMedia = window.matchMedia('(min-width: 721px)');
const desktopZoomControl = new maplibregl.NavigationControl({
  showCompass: false,
  showZoom: true,
});
let desktopZoomControlVisible = false;
function syncDesktopZoomControl() {
  const nativeShell = document.documentElement.dataset.appRuntime === 'native'
    || Boolean(window.Capacitor?.isNativePlatform?.());
  const shouldShow = desktopBrowserZoomMedia.matches && !nativeShell;
  if (shouldShow === desktopZoomControlVisible) return;
  if (shouldShow) {
    map.addControl(desktopZoomControl, 'top-right');
    // MapLibre stacks this under the geolocate control, which lands it on top
    // of the app's own floating Layers and Help buttons -- same corner, same
    // z-index, so whichever paints last wins and the zoom buttons vanish. Tag
    // the group so the stylesheet can drop it below them.
    desktopZoomControl._container?.classList.add('zoom-ctrl-group');
  }
  else map.removeControl(desktopZoomControl);
  desktopZoomControlVisible = shouldShow;
}
syncDesktopZoomControl();
if (desktopBrowserZoomMedia.addEventListener) {
  desktopBrowserZoomMedia.addEventListener('change', syncDesktopZoomControl);
} else {
  desktopBrowserZoomMedia.addListener(syncDesktopZoomControl);
}

let nativeMapLocationMarker = null;
let mapLocationRequest = null;
let lastMapLocationRequestAt = 0;

// The passive dot marks an approximate location outside navigation. It must
// vanish the instant navigation takes over: otherwise it stays frozen at its
// last resting place and reads as a second "you are here" beside the live
// rider marker (which snaps to the route and moves on without it).
function clearPassiveMapLocationMarker() {
  if (!nativeMapLocationMarker) return;
  nativeMapLocationMarker.remove();
  nativeMapLocationMarker = null;
}

function updatePassiveMapLocation(position, reason = 'foreground') {
  const lng = Number(position?.coords?.longitude);
  const lat = Number(position?.coords?.latitude);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
  const point = [lng, lat];

  // Navigation owns its live rider marker. Outside navigation, keep a simple
  // marker visible for locations obtained automatically or through the native
  // location button.
  if (turnNav.active) {
    clearPassiveMapLocationMarker();
  } else if (!nativeMapLocationMarker) {
    const element = document.createElement('div');
    element.className = 'native-location-marker';
    nativeMapLocationMarker = new maplibregl.Marker({ element }).setLngLat(point).addTo(map);
  } else nativeMapLocationMarker.setLngLat(point);

  if (turnNav.active) {
    clearTimeout(turnNav.followResumeTimer);
    turnNav.cameraFollow = true;
    turnNav.lastCameraAt = Date.now();
  }
  map.easeTo({
    center: point,
    zoom: reason === 'launch' ? Math.max(map.getZoom(), 14) : map.getZoom(),
    duration: reason === 'launch' ? 650 : 450,
    essential: true,
  });
  return true;
}

async function recenterMapOnCurrentLocation(reason = 'launch') {
  if (document.visibilityState === 'hidden') return false;
  if (mapLocationRequest) return mapLocationRequest;
  const now = Date.now();
  if (reason !== 'launch' && now - lastMapLocationRequestAt < 1200) return false;
  lastMapLocationRequestAt = now;
  mapLocationRequest = getDevicePosition({
    maximumAge: reason === 'launch' ? 30000 : 5000,
    timeout: 15000,
  }).then((position) => updatePassiveMapLocation(position, reason))
    // An automatic request should not replace useful app status with an error.
    // The location control remains available if permission or GPS is unavailable.
    .catch(() => false)
    .finally(() => { mapLocationRequest = null; });
  return mapLocationRequest;
}

function requestMapLocationRecenter(reason = 'launch') {
  if (map.loaded()) return recenterMapOnCurrentLocation(reason);
  map.once('load', () => recenterMapOnCurrentLocation(reason));
  return null;
}

// Ask for a usable location on each fresh app load. If permission is already
// granted this centers immediately; otherwise the platform can show its normal
// permission prompt and the Seattle default remains as a safe fallback.
requestMapLocationRecenter('launch');

// A user-initiated pan/zoom (originalEvent present) suspends navigation
// auto-follow; our own programmatic camera moves have no originalEvent.
map.on('movestart', (e) => { if (turnNav.active && e.originalEvent) turnNav.cameraFollow = false; });
map.on('moveend', (e) => { if (turnNav.active && e.originalEvent) scheduleNavigationFollowResume(); });
/* The geolocate control belongs to MapLibre, and left to itself it calls
 * navigator.geolocation. That is a SECOND location source, with its own
 * permission: on the native app the WebView asks '"localhost" would like to use
 * your current location' even though the plugin has been tracking the rider for
 * miles. Photographed mid-ride, 3.4 miles in.
 *
 * Capturing on the container preempts the control's own handler. This used to
 * cover two cases and fall through on a third -- navigating with the camera
 * ALREADY following, which is the ordinary state of the screen -- so the one
 * tap most likely to happen was the one that reached the web API.
 *
 * While navigating, the app has a live position and the button means "put me
 * back in the middle", on every platform. There is nothing MapLibre's own
 * geolocation could add, and a second GPS watcher costs battery for a fix the
 * app already has.
 */
map.getContainer().addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('.maplibregl-ctrl-geolocate');
  if (!btn) return;
  if (turnNav.active) {
    e.stopPropagation();
    e.preventDefault();
    recenterNavigationOnRider();
    return;
  }
  if (nativeNavigationPlugin()) {
    e.stopPropagation();
    e.preventDefault();
    btn.classList.add('maplibregl-ctrl-geolocate-waiting');
    getDevicePosition().then((position) => {
      updatePassiveMapLocation(position, 'launch');
      btn.classList.add('maplibregl-ctrl-geolocate-active');
    }).catch((error) => {
      const blocked = /blocked|denied|permission/i.test(String(error?.message || error));
      setStatus(blocked
        ? 'Location permission is blocked in your device Settings.'
        : 'Could not get your location.', true);
    }).finally(() => btn.classList.remove('maplibregl-ctrl-geolocate-waiting'));
  }
  // Off the native app and not navigating, the control's own behaviour is the
  // right one and its permission prompt is expected.
}, true);

// How the WSDOT BLTS tiles answer the lime rule's facts. The source stores
// its facility as a STRING (BikeFacilityType); the grade comes from
// Region.facilityLevels, the same table agencyFacilityLevel() gives the tap
// card -- built into the expression HERE rather than retyped, so the card and
// the tiles cannot disagree about what a facility type is worth. Unknown
// strings, '', and the literal 'nan' placeholder all fall to the match
// default of 0, exactly as agencyFacilityLevel() treats them.
//
// The old hand-written expression had no grade at all: any valid type on an
// LTS-4 road was refused lime, so a WSDOT "Two-Way Separated Bike Lane" on a
// worst-rated highway drew blue on the tiles while the card called it bike
// network. Compiling from the shared rule is what fixed that.
function bltsTileFacts() {
  const graded = ['match', ['coalesce', ['get', 'BikeFacilityType'], '']];
  for (const [type, level] of Object.entries(Region.facilityLevels)) {
    graded.push(type, level);
  }
  graded.push(0);
  return {
    infra: { val: false, known: true },
    facility: { val: graded, known: true },
    // Written only where WSDOT rated the segment; absent means "not rated",
    // which must read as unknown rather than as a rating of zero.
    stressRating: { val: ['coalesce', ['get', 'LTS_Bicycle'], 0],
      known: ['>', ['coalesce', ['get', 'LTS_Bicycle'], 0], 0] },
  };
}

// The OSM bike-infrastructure layer: every feature is dedicated infrastructure
// by construction except a sharrow, which is paint in a shared traffic lane.
// It carries no speed, traffic or lane data, so the whole needs-space family
// folds out of the compiled ladder and what remains is: prohibited, then the
// infrastructure's own score, then the shares-everything default.
//
// `infra` uses the MODEL'S sharrow test, not a blunter one. An earlier
// expression vetoed lime for any feature carrying a shared-lane value in ANY
// cycleway tag, which demoted 309 ways the card rightly calls bike network --
// mostly streets with a real painted lane one direction and a sharrow the
// other, plus dedicated paths tagged with stray sharrow paint. sharrowOnly()
// asks the model's question -- a sharrow AND no facility of its own -- and a
// pure sharrow still never gets here: it is dropped from the tiles at build
// (scripts/build_overlay_tiles.py) and earns no riding-space credit on the
// roads layer.
//
// `infraScore` is scoreOSM()'s if-chain compiled branch for branch, with -1
// standing in for its null ("dedicated infrastructure, type unscored"), so a
// tile feature and a tapped card cannot disagree about what a way is worth.
// test_safety_model.mjs sweeps the two against each other over the real data.
function osmTileFacts() {
  const bike = ['coalesce', ['get', 'bicycle'], ''];
  const hw = ['coalesce', ['get', 'highway'], ''];
  // Tag precedence mirrors osmCycleway(): right before left.
  const cw = ['coalesce', ['get', 'cycleway'], ['get', 'cycleway:both'],
    ['get', 'cycleway:right'], ['get', 'cycleway:left'], ''];
  const dedicated = ['in', hw,
    ['literal', ['cycleway', 'path', 'footway', 'bridleway', 'track', 'service']]];
  const bikeish = ['any',
    ['in', hw, ['literal', ['cycleway', 'path', 'bridleway', 'track', 'service']]],
    ['has', 'cycleway'], ['has', 'cycleway:both'],
    ['has', 'cycleway:right'], ['has', 'cycleway:left']];
  const prohibited = ['all', ['==', bike, 'no'], bikeish];
  const yesOrDesignated = ['in', bike, ['literal', ['designated', 'yes']]];
  const motorless = ['any',
    ['in', ['coalesce', ['get', 'motor_vehicle'], ''], ['literal', ['no', 'private']]],
    ['in', ['coalesce', ['get', 'access'], ''], ['literal', ['no', 'private']]]];
  // scoreOSM()'s final fallback: a null-scored dedicated way is still a
  // dedicated way. Reached from the sharrow branch and from no-branch-matched.
  const dedicatedOrNull = ['case', dedicated, 2, -1];
  const baseScore = ['case',
    prohibited, 4,
    ['all', ['==', hw, 'cycleway'], ['!=', bike, 'no']], 1,
    ['all', ['==', hw, 'path'], yesOrDesignated], 1,
    ['all', ['==', hw, 'footway'], yesOrDesignated], 2,
    ['all', ['==', hw, 'bridleway'], yesOrDesignated], 2,
    ['all', ['==', hw, 'track'], yesOrDesignated], 2,
    ['all', ['==', hw, 'service'], ['==', bike, 'designated'], motorless], 1,
    ['in', cw, ['literal', ['track', 'separated', 'opposite_track']]], 1,
    ['==', cw, 'shared_lane'], dedicatedOrNull,
    ['==', cw, 'lane'], 2,
    dedicatedOrNull];
  const unknownNum = { val: 0, known: false };
  return {
    prohibited: { val: prohibited, known: true },
    ferry: { val: false, known: true },
    freeway: { val: false, known: true },
    infra: { val: ['!', sharrowOnlyExpr()], known: true },
    infraScore: { val: baseScore, known: ['!=', baseScore, -1] },
    facility: unknownNum,
    limitedAccess: { val: false, known: true },
    speed: unknownNum,
    shoulder: unknownNum,
    edgeSpace: unknownNum,
    lanes: unknownNum,
    sidewalk: { val: '', known: false },
    urban: { val: false, known: true },
    stressRating: unknownNum,
    adt: unknownNum,
    fc: unknownNum,
  };
}

// One rule, three tile schemas. Each source answers the lime rule's facts in
// its own vocabulary and SafetyModel.bikeNetworkExpr() compiles the SAME rule
// over each -- the roads adapter is the one roadLevelExpr() also uses, so "is
// it lime" and "what level is it" cannot be answered from two different
// readings of one feature.
function bikeNetworkExpr(src) {
  if (src.id === 'osm') return SafetyModel.bikeNetworkExpr(osmTileFacts);
  if (src.id === 'roads') return SafetyModel.bikeNetworkExpr(roadTileFacts);
  if (src.id === 'blts') return SafetyModel.bikeNetworkExpr(bltsTileFacts);
  return ['boolean', false];
}

function verdictColorExpr(src, levelExpr = ['get', 'level']) {
  const passes = ['match', levelExpr, [1, 2], true, false];
  return ['case',
    ['all', passes, bikeNetworkExpr(src)], BIKE_NETWORK_COLOR,
    ['match', levelExpr, 1, COLORS[1], 2, COLORS[2], 3, COLORS[3],
      4, COLORS[4], COLORS[0]],
  ];
}

// The background safety network used to rely on translucent line paint. Tile
// features and graph-derived road segments overlap at junctions, so their
// round ends accumulated alpha into dark dots and colored wedges. Pre-blend
// the same muted colors over the white road interior, then paint them fully
// opaque so coincident features remain visually stable.
function opaqueBackgroundVerdictColorExpr(src, levelExpr = ['get', 'level']) {
  const normalOpacity = backgroundLineOpacity(0.9);
  const cautionOpacity = cautionBackgroundLineOpacity();
  const muted = (color, opacity = normalOpacity) => opaqueRoadColorExpr(src, color, opacity);
  const passes = ['match', levelExpr, [1, 2], true, false];
  return ['case',
    ['all', passes, bikeNetworkExpr(src)],
    muted(BIKE_NETWORK_COLOR, bikeNetworkBackgroundLineOpacity()),
    ['match', levelExpr,
      1, muted(COLORS[1]),
      2, muted(COLORS[2]),
      3, muted(COLORS[3], cautionOpacity),
      4, muted(COLORS[4]),
      muted(COLORS[0])],
  ];
}

// One definition, in safety-model.js, for the colour AND the percentage AND
// the tiles. This used to decide it here and get it wrong: it had no
// separated-lane exemption, so a separated lane on a road rated 4 of 4 read
// "not bike network" on the tap card while the tiles and the route line both
// drew it lime.
function isBikeNetworkVerdict(n) {
  return n ? SafetyModel.isBikeNetwork(SafetyModel.factsFrom(n)) : false;
}

/* -------------------------------------------------------- status UI */
const statusEl = document.getElementById('status');
let statusTimer = null;
function setStatus(msg, sticky = false) {
  statusEl.textContent = msg;
  statusEl.classList.remove('hidden');
  clearTimeout(statusTimer);
  if (!sticky) statusTimer = setTimeout(() => statusEl.classList.add('hidden'), 1400);
}

// PMTiles needs byte-range responses. A plain static server can otherwise make
// the statewide layer look like a zoom/rendering failure, even though the
// tiles never arrived. Make the recovery path explicit for local development.
let pmtilesRangeWarningShown = false;
map.on('error', (event) => {
  const message = String(event?.error?.message || '');
  if (pmtilesRangeWarningShown || !/byte serving|content-length|range/i.test(message)) return;
  pmtilesRangeWarningShown = true;
  setStatus('All roads could not load — use scripts/serve.py for byte-range support.', true);
});

/* ------------------------------------- scoring + pushing to the map */
// Compute normalized props once per feature (cached on _n), then effective level.
function rescore(src) {
  if (!src.fc) return;
  // setData() re-uploads the whole collection and re-tiles it on the worker:
  // 250 ms for the 38k OSM features, 130 ms for the 55k WSDOT ones. A rules
  // change ran that for EVERY source, whether or not the change could touch
  // them -- and a shoulder rule cannot move a designated-route ribbon. Scoring
  // the features is the cheap part (under 25 ms); re-uploading them is not, so
  // only do it when a verdict actually moved.
  //
  // The sources still here all score to RULES-INDEPENDENT levels (an OSM path
  // is judged by its type, a restriction is always prohibited), so after the
  // load-time pass `moved` stays false and no upload ever recurs. WSDOT BLTS
  // -- the one source whose levels do move with the rules -- paints nothing
  // and is expression-flagged, so a rules change now uploads no data at all.
  let moved = false;
  for (const f of src.fc.features) {
    if (!f.properties._n) f.properties._n = src.scorer(f.properties);
    const level = effectiveLevel(f.properties._n);
    if (level !== f.properties.level) { f.properties.level = level; moved = true; }
  }
  if (!moved) return;
  const mapSrc = map.getSource(src.id);
  if (mapSrc) mapSrc.setData(src.fc);
}

function rescoreAll(recomputeRoute = true) {
  const t0 = performance.now();
  for (const src of SOURCES) {
    if (src.expr) {
      // Expression-scored: rebuild paint/filter expressions (no data rewrite).
      if (map.getLayer(src.id)) applyDisplayMode(src);
    } else if (src.fc) {
      rescore(src);
    }
  }
  const ms = Math.round(performance.now() - t0);
  if (ms > 0) setStatus(`Recolored in ${ms} ms`);
  if (recomputeRoute && routing.ready && routing.start && routing.end) computeRoute();
}

// Rule sliders may update several large GeoJSON sources. Throttle map work and
// wait for the thumb to settle before routing again; otherwise Safari can queue
// enough style/data work during a drag to become unstable.
let _rescoreTimer = null;
let _ruleRouteTimer = null;
function scheduleRescore() {
  saveStateSoon();
  if (_rescoreTimer == null) {
    _rescoreTimer = setTimeout(() => {
      _rescoreTimer = null;
      rescoreAll(false);
    }, 180);
  }
  clearTimeout(_ruleRouteTimer);
  _ruleRouteTimer = setTimeout(() => {
    _ruleRouteTimer = null;
    if (routing.ready && routing.start && routing.end) computeRoute();
    else schedulePrewarm();
  }, 700);
}

// Routing weights are sent to the router and NOTHING else: no map layer reads
// them, so a weight change can never alter a road's color. Dragging one used to
// call scheduleRescore(), which every 180ms re-scored and re-uploaded every
// GeoJSON source to the map for no visible change -- enough main-thread and
// memory churn during a drag to get the tab killed on iOS. Weights now only
// save and re-route.
function scheduleReroute() {
  saveStateSoon();
  clearTimeout(_ruleRouteTimer);
  _ruleRouteTimer = setTimeout(() => {
    _ruleRouteTimer = null;
    if (routing.ready && routing.start && routing.end) computeRoute();
    else schedulePrewarm();
  }, 700);
}

// Ask the router to fill its per-arc cost cache for the current settings
// while nobody is waiting, so the FIRST search of a session runs at the
// speed a long-lived app reaches organically (field: fresh Mac tab 16.8 s
// vs warmed-up phone 3.5 s for the same trip). Only when no trip is set --
// an actual search warms the cache better than any sweep.
function schedulePrewarm() {
  if (!routing.ready || !routing.worker) return;
  if (routing.start && routing.end) return;
  routing.worker.postMessage({ type: 'prewarm', id: ++routing.reqId,
    rules: { ...rules }, weights: remixedRoutingWeights() });
}

const FAIL_COLOR = '#9aa0a6';
/* --------------------------------------------- colour-blind-safe patterns
 * Hue alone cannot carry these three verdicts. Simulated against deuteranopia
 * and protanopia, the fail red, the caution amber and the bike-network green
 * all collapse into one olive family; only the pass blue survives. So the
 * verdicts are separated by TEXTURE first and lightness second:
 *
 *   prohibited  white diagonal slashes on red (hazard tape)
 *   caution     perpendicular ticks (rungs across the road)
 *   passes      solid
 *
 * The colours themselves were chosen numerically: search for the pair that
 * maximises the SMALLEST CIELAB distance between any two roles, evaluated under
 * normal, deuteranope and protanope vision. The original amber and red left the
 * caution barely separated from the bike-network lime; #c25d05 with #a51c30
 * pulls it clear, and both keep the conventional warning/danger reading. The
 * governing pair and the measurements are recorded at COLORS above.
 *
 * Patterns are authored at pixelRatio 2 so they stay crisp on a phone, and
 * they only draw above PATTERN_MIN_ZOOM: below it a road is a few pixels wide
 * and any texture smears into a solid line, where lightness carries it alone.
 */
const PATTERN_MIN_ZOOM = 13;
const PATTERN_PROHIBITED = 'verdict-prohibited';
const PATTERN_CAUTION = 'verdict-caution';
function patternTile(size, colorAt) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const hex = colorAt(x, y).replace('#', '');
      const i = (y * size + x) * 4;
      data[i] = parseInt(hex.slice(0, 2), 16);
      data[i + 1] = parseInt(hex.slice(2, 4), 16);
      data[i + 2] = parseInt(hex.slice(4, 6), 16);
      data[i + 3] = 255;
    }
  }
  return { width: size, height: size, data, pixelRatio: 2 };
}
function addVerdictPatterns() {
  if (!map.hasImage(PATTERN_PROHIBITED)) {
    // Slashes shift 0.6 px per row so the 16 px tile repeats seamlessly.
    map.addImage(PATTERN_PROHIBITED, patternTile(16, (x, y) => (
      (((x + Math.round(y * 0.6)) % 8) + 8) % 8 < 3 ? '#ffffff' : COLORS[4])));
  }
  if (!map.hasImage(PATTERN_CAUTION)) {
    // The rungs are the DANGER red, not white: a cautioned road is one heading
    // toward a failure, and saying so in the same red ties the two together.
    // Red on this orange holds a 3.69 contrast ratio, above the 3:1 minimum for
    // a graphical object.
    map.addImage(PATTERN_CAUTION, patternTile(16, (x) => (x % 10 < 4 ? COLORS[4] : COLORS[3])));
  }
}

const failId = (src) => src.id + '__fail'; // gray-dashed "has data but fails" (pass/fail mode)
const vhId = (src) => src.id + '__vh';     // red-dashed "very high / avoid" (color-ramp mode)
const prohibitedId = (src) => src.id + '__prohibited';
const cautionId = (src) => src.id + '__caution';
const slashId = (src) => src.id + '__slash';
const hitId = (src) => src.id + '__hit';   // wide transparent line: easy hover target
const trailBaseId = (src) => src.id + '__trail-base'; // always-on neutral trail casing
const trailId = (src) => src.id + '__trail'; // lime base for off-street OSM bike paths/trails
const trailDotsId = (src) => src.id + '__trail-dots'; // fine dotted trail centerline
const trailHitId = (src) => src.id + '__trail-hit'; // dedicated wide target for dotted trails
const trailLabelId = (src) => src.id + '__trail-labels';
const backgroundUnpavedId = (src) => src.id + '__unpaved-slats';
const stateSidewalkProbeId = 'roads__state-sidewalk-probe';
// Match BikeBasemap's road-interior width exactly. Safety colors then replace
// the white street fill inside its gray casing instead of reading as a second,
// narrower line painted on top of the road.
const SAFETY_ROAD_INTERIOR_WIDTH = ['interpolate', ['linear'], ['zoom'],
  5, 0.6, 8, 1.1, 11, 2.2, 14, 4.7, 17, 9];
const ROAD_CLASS_EXPR = ['get', 'h'];
const ROAD_CLASS_MAJOR_EXPR = ['match', ROAD_CLASS_EXPR,
  BikeBasemap.ROAD_CLASSES.major, true, false];
const ROAD_CLASS_MEDIUM_EXPR = ['match', ROAD_CLASS_EXPR,
  BikeBasemap.ROAD_CLASSES.medium, true, false];
const ROAD_CLASS_LOCAL_EXPR = ['match', ROAD_CLASS_EXPR,
  BikeBasemap.ROAD_CLASSES.local, true, false];
const OSM_TRAIL_EXPR = ['match', ['get', 'highway'],
  ['cycleway', 'path', 'footway', 'bridleway', 'track', 'service'], true, false];
const OSM_NOT_TRAIL_EXPR = ['match', ['get', 'highway'],
  ['cycleway', 'path', 'footway', 'bridleway', 'track', 'service'], false, true];
const OSM_NOT_MTB_EXPR = ['!=', ['get', 'mtb'], 1];
// A hiking trail is not bike infrastructure. These features are `bicycle=no` on
// a path, track, bridleway or service way: build_graph.py drops them outright,
// so they are never routable and exist on the map only to be drawn. Around
// 4,700 of the 41,625 features in the infrastructure layer are these, mostly
// unnamed fragments, and they were the bulk of the clutter around parks.
//
// A prohibited ROAD is a different matter and stays: you might otherwise
// consider riding it, so being told you cannot is worth the ink.
const OSM_NOT_HIKING_EXPR = ['!', ['all',
  ['==', ['get', 'bicycle'], 'no'],
  ['match', ['get', 'highway'],
    ['path', 'footway', 'bridleway', 'track', 'service', 'steps'], true, false]]];

function safetyRoadWidth(src) {
  if (src.id !== 'roads') return SAFETY_ROAD_INTERIOR_WIDTH;
  // MapLibre requires `zoom` to be the input of the outermost
  // step/interpolate expression. Put the feature-dependent choice in each
  // stop rather than nesting a zoom interpolation inside a `case`.
  // A bike-network road is drawn a little wider than its neighbours; the
  // feature test lives in each stop because zoom must be the outermost input.
  const bike = bikeNetworkExpr(src);
  const w = (local, major, lane) => ['case', bike, lane,
    ROAD_CLASS_LOCAL_EXPR, local, major];
  return ['interpolate', ['linear'], ['zoom'],
    5, 0.6,
    8, 1.1,
    11, w(1.85, 2.2, 2.6),
    14, w(4.05, 4.7, 5.5),
    17, w(8.2, 9, 10.4),
  ];
}

// Local streets arrive in large batches at zoom 11. Keep their safety colors
// fully opaque (so overlaps cannot create dark seams), but preblend them a
// little more softly than larger roads.
function opaqueRoadColorExpr(src, color, opacity) {
  const normal = opaqueColorOverWhite(color, opacity);
  if (src.id !== 'roads') return normal;
  return ['case', ROAD_CLASS_LOCAL_EXPR,
    opaqueColorOverWhite(color, opacity * 0.82), normal];
}
// Match the compact surface classification in scripts/build_graph.py. The
// bike-infrastructure GeoJSON already carries the original OSM surface string,
// so this adds statewide context without adding another data file or property.
const OSM_CONFIRMED_UNPAVED_EXPR = ['match',
  ['downcase', ['coalesce', ['get', 'surface'], '']],
  ['gravel', 'fine_gravel', 'compacted', 'pebblestone', 'chipseal', 'wood',
    'ground', 'dirt', 'earth', 'sand', 'grass', 'mud', 'clay', 'rock',
    'rocks', 'unpaved', 'soil', 'ice', 'snow'],
  true, false];

// Insert this source's layers below any already-added layers of higher-zRank
// sources, so draw order follows zRank regardless of load order.
function beforeIdFor(src) {
  const style = map.getStyle();
  if (!style || !style.layers) return undefined;
  const higher = SOURCES.filter((s) => s.zRank > src.zRank).map((s) => s.id);
  const hit = style.layers.find((l) =>
    higher.some((id) => l.id === id || l.id.startsWith(id + '__')));
  if (hit) return hit.id;
  // Safety is the road's colored interior, so keep local road/place labels
  // above it. The active route is added later and remains above both.
  const firstBasemapLabel = style.layers.find((l) =>
    l.type === 'symbol' && l.id.startsWith('basemap-'));
  if (firstBasemapLabel) return firstBasemapLabel.id;
  // Hosted-style fallback: keep the route line above every data source.
  return map.getLayer('route-shadow') ? 'route-shadow' : undefined;
}

function ensureLayer(src) {
  if (map.getLayer(src.id)) return;
  addVerdictPatterns();
  const beforeId = beforeIdFor(src);
  const mapSourceId = src.mapSourceId || src.id;
  if (!map.getSource(mapSourceId)) {
    if (src.vector) map.addSource(mapSourceId, { type: 'vector', url: src.vector });
    else map.addSource(mapSourceId, { type: 'geojson', data: src.fc });
  }
  const SL = src.vector ? { 'source-layer': src.sourceLayer } : {};
  if (src.closure) {
    forgetStyleValues(); map.addLayer({
      id: src.id + '__line', type: 'line', source: mapSourceId,
      minzoom: 10,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: { 'line-color': COLORS[4], 'line-width': 7, 'line-opacity': backgroundLineOpacity(0.92),
               'line-dasharray': [1.2, 1.1] },
      filter: ['==', ['geometry-type'], 'LineString'],
    }, beforeId);
    forgetStyleValues(); map.addLayer({
      id: src.id, type: 'circle', source: mapSourceId,
      minzoom: 10,
      paint: { 'circle-radius': 9, 'circle-color': COLORS[4],
               'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
      filter: ['==', ['geometry-type'], 'Point'],
    }, beforeId);
    // The markers answer taps like everything else on the map: the circle and
    // the closed stretch itself both open the closure card.
    attachHover(src, src.id);
    attachHover(src, src.id + '__line');
    updateVisibility(src);
    return;
  }
  // Two dashed overlays are added first so the solid main layer draws on top
  // where lines overlap. Each is shown in only one display mode.
  forgetStyleValues(); map.addLayer({
    id: failId(src), // pass/fail mode: roads with data that don't qualify
    type: 'line',
    source: mapSourceId,
    ...SL,
    minzoom: src.minVisibleZoom || 0,
    layout: { 'line-cap': 'butt', 'line-join': 'round', visibility: 'none' },
    paint: {
      'line-color': FAIL_COLOR,
      'line-dasharray': [2, 2],
      'line-width': safetyRoadWidth(src),
      'line-opacity': backgroundLineOpacity(0.65),
    },
    filter: ['all', ['>=', ['get', 'level'], display.passMax + 1], ['<=', ['get', 'level'], 4]],
  }, beforeId);
  forgetStyleValues(); map.addLayer({
    id: vhId(src), // color-ramp mode: level 4 shown dashed to read as "not passable"
    type: 'line',
    source: mapSourceId,
    ...SL,
    minzoom: src.minVisibleZoom || 0,
    // Handed over to the slash pattern once roads are wide enough to show one.
    maxzoom: PATTERN_MIN_ZOOM,
    layout: { 'line-cap': 'butt', 'line-join': 'round', visibility: 'none' },
    paint: {
      // Solid below PATTERN_MIN_ZOOM, slashed above: the same red line gaining
      // detail as you zoom in. It used to be a chunky dash, which read as a
      // different symbol from the fine hatch and made the handover jarring.
      'line-color': COLORS[4],
      'line-width': safetyRoadWidth(src),
      'line-opacity': backgroundLineOpacity(0.9),
    },
    filter: ['==', ['get', 'level'], 4],
  }, beforeId);
  forgetStyleValues(); map.addLayer({
    id: src.id,
    type: 'line',
    source: mapSourceId,
    ...SL,
    minzoom: src.minVisibleZoom || 0,
    layout: {
      // Flat feature ends prevent independently segmented roads and route
      // relation members from alpha-stacking into dark dots where they meet.
      // Curves within a feature still use round joins.
      'line-cap': 'butt',
      'line-join': 'round',
    },
    paint: {
      'line-color': verdictColorExpr(src),
      'line-width': safetyRoadWidth(src),
      'line-opacity': backgroundLineOpacity(0.9),
    },
    // On-street OSM bike facilities are already encoded in roads.pmtiles and
    // therefore already color the exact basemap street interior. Keep this
    // detailed source for hit testing and for its dedicated off-street trail
    // layers, but do not paint a second, slightly different copy of the road.
    ...(src.id === 'osm' ? { filter: ['boolean', false] } : {}),
  }, beforeId);
  // Texture overlays. These carry the verdict for a rider who cannot rely on
  // hue; they sit directly over the solid colour and only above the zoom where
  // a road is wide enough to show a pattern at all.
  if (src.id === 'roads') {
    const levelExpr = src.expr ? roadLevelExpr() : ['get', 'level'];
    forgetStyleValues(); map.addLayer({
      id: cautionId(src),
      type: 'line',
      source: mapSourceId,
      ...SL,
      minzoom: PATTERN_MIN_ZOOM,
      layout: { 'line-cap': 'butt', 'line-join': 'round', visibility: 'none' },
      paint: {
        'line-pattern': PATTERN_CAUTION,
        'line-width': safetyRoadWidth(src),
        'line-opacity': backgroundLineOpacity(0.95),
      },
      filter: ['==', levelExpr, 3],
    }, beforeId);
    forgetStyleValues(); map.addLayer({
      id: slashId(src),
      type: 'line',
      source: mapSourceId,
      ...SL,
      minzoom: PATTERN_MIN_ZOOM,
      layout: { 'line-cap': 'butt', 'line-join': 'round', visibility: 'none' },
      paint: {
        'line-pattern': PATTERN_PROHIBITED,
        'line-width': safetyRoadWidth(src),
        'line-opacity': backgroundLineOpacity(0.95),
      },
      filter: ['==', levelExpr, 4],
    }, beforeId);
  }
  // Added last so the regulatory ribbon sits above this source's own colours
  // and textures rather than under them.
  if (src.id === 'roads' || src.id === 'osm') {
    forgetStyleValues(); map.addLayer({
      id: prohibitedId(src),
      type: 'line',
      source: mapSourceId,
      ...SL,
      minzoom: src.minVisibleZoom || 0,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      // A regulatory fact laid OVER the safety colouring, never instead of it:
      // wider than the road line and translucent, so the verdict underneath
      // still reads. Same visual grammar as the designated-route ribbon.
      paint: {
        'line-color': COLORS[4],
        'line-dasharray': [2, 1.4],
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 3.4, 10, 6.4, 14, 11, 17, 15],
        'line-opacity': backgroundLineOpacity(0.42),
      },
      // A prohibited ROAD is worth the ink; a prohibited hiking path is not,
      // and OSM_NOT_HIKING_EXPR removes those from every other osm layer.
      filter: src.id === 'roads'
        ? ['all', ['==', ['get', 'b'], 1], ['!=', ['get', 'd'], 1]]
        : ['all', ['==', ['get', 'bicycle'], 'no'], OSM_NOT_HIKING_EXPR],
    }, beforeId);
  }
  if (src.id === 'osm') {
    // The always-on neutral ghost of every trail. The basemap draws every
    // ROAD's grey casing no matter which safety layers are on, but it never
    // learned to draw paths -- so with "Off-street trails" switched off a
    // trail was a floating name over literally nothing (field report: the
    // Interurban Trail label over blank ground). Same rule as roads now:
    // toggles control the safety/network COLORING, never whether a way
    // exists. The lime treatment still draws over this when the layer is on.
    forgetStyleValues(); map.addLayer({
      id: trailBaseId(src),
      type: 'line',
      source: mapSourceId,
      ...SL,
      minzoom: BikeBasemap.ROAD_MIN_ZOOM.local,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        // The basemap's minor-road grey, a step narrower: reads as "a way
        // exists here", claims nothing about its quality.
        'line-color': '#c9c9c2',
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.1, 14, 2, 17, 3.2],
      },
      filter: OSM_TRAIL_EXPR,
    }, beforeId);
    forgetStyleValues(); map.addLayer({
      id: trailId(src),
      type: 'line',
      source: mapSourceId,
      ...SL,
      minzoom: 0,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': BIKE_NETWORK_COLOR,
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.9, 10, 3, 14, 5],
        'line-opacity': backgroundLineOpacity(0.95),
      },
      filter: ['boolean', false],
    }, beforeId);
    forgetStyleValues(); map.addLayer({
      id: trailDotsId(src),
      type: 'line',
      source: mapSourceId,
      ...SL,
      minzoom: 0,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        // Trails share the lime of an on-street bike lane deliberately -- both
        // are bike network -- so the difference has to be carried by this
        // centreline. A dash reads as "path" far more strongly than the fine
        // dots it replaced, and survives being small.
        'line-color': '#4c5c00',
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.9, 10, 1.5, 14, 2.4],
        'line-opacity': backgroundLineOpacity(0.95),
        'line-dasharray': [1.6, 1.5],
      },
      filter: ['boolean', false],
    }, beforeId);
    // Surface is already present on these OSM bike-infrastructure features.
    // Show the same cross-slat language used by an active route, but do not
    // imply anything about features whose surface is absent or unknown.
    ensureUnpavedSlatImage(map, 'background-unpaved-slats');
    forgetStyleValues(); map.addLayer({
      id: backgroundUnpavedId(src),
      type: 'symbol',
      source: mapSourceId,
      ...SL,
      minzoom: 0,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 10,
        'icon-image': 'background-unpaved-slats',
        'icon-size': ['interpolate', ['linear'], ['zoom'],
          5, 0.12, 7, 0.18, 9, 0.28, 11, 0.45, 13, 0.65, 15, 0.8],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-rotation-alignment': 'map',
        'icon-pitch-alignment': 'map',
        'icon-keep-upright': false,
      },
      paint: { 'icon-opacity': 0.7 },
      filter: ['all', OSM_CONFIRMED_UNPAVED_EXPR, OSM_NOT_MTB_EXPR],
    }, beforeId);
    // Keep dotted paths as easy to inspect as ordinary streets.  This sits
    // directly on the source geometry (not the gaps between rendered dots),
    // so a trail remains hoverable across its full length.
    forgetStyleValues(); map.addLayer({
      id: trailHitId(src),
      type: 'line',
      source: mapSourceId,
      ...SL,
      minzoom: 0,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#000',
        'line-opacity': 0,
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 12, 12, 18, 16, 26],
      },
      filter: OSM_TRAIL_EXPR,
    }, beforeId);
    forgetStyleValues(); map.addLayer({
      id: trailLabelId(src),
      type: 'symbol',
      source: mapSourceId,
      ...SL,
      minzoom: 12,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 400,
        'text-field': ['get', 'name'],
        'text-font': [BikeBasemap.FONT_STACK],
        'text-size': ['interpolate', ['linear'], ['zoom'], 12, 12, 16, 15],
        'text-padding': 5,
        'text-keep-upright': true,
      },
      paint: {
        'text-color': '#647600',
        'text-halo-color': '#f7f9ef',
        'text-halo-width': 1.7,
      },
      filter: ['all', OSM_TRAIL_EXPR, OSM_NOT_MTB_EXPR,
        ['has', 'name'], ['!=', ['get', 'name'], '']],
    }, beforeId);
  }
  // State highways are visually deduplicated beneath the richer WSDOT layer,
  // but their matching OSM tile still supplies sidewalk context for a WSDOT
  // road-info card.  This transparent layer is queried only on demand.
  if (src.id === 'roads') {
    forgetStyleValues(); map.addLayer({
      id: stateSidewalkProbeId,
      type: 'line',
      source: mapSourceId,
      ...SL,
      minzoom: src.minVisibleZoom || 0,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#000',
        'line-opacity': 0,
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 10, 12, 16, 16, 24],
      },
      filter: ['==', ['get', 'd'], 1],
    }, beforeId);
  }
  // Invisible wide line on top — a forgiving hover target so you don't have to
  // land pixel-perfect on the thin visible line. Transparent, so no visual change.
  forgetStyleValues(); map.addLayer({
    id: hitId(src),
    type: 'line',
    source: mapSourceId,
    ...SL,
    minzoom: src.minVisibleZoom || 0,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#000',
      'line-opacity': 0,
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 8, 12, 14, 16, 22],
    },
  }, beforeId);
  applyDisplayMode(src);
  attachHover(src, hitId(src));
  if (src.id === 'osm') attachHover(src, trailHitId(src));
}

// Checkboxes control painted lines only. Invisible hit targets remain active
// so hiding a visual layer never removes data from street-information popups.
// Setting a paint property, filter or layout property marks the layer dirty and
// makes MapLibre re-parse the expression and redraw -- whether or not the value
// actually changed. applyDisplayMode() rebuilds every expression for every
// source from scratch every time, so ONE layer toggle handed the renderer 94
// style changes of which 90 were identical to what was already there. The blink
// preview then does the whole thing five times over.
//
// So remember what was last written to each layer property and skip the rest.
// The comparison is against what this file last SET, not what MapLibre reports,
// because the map normalises expressions on the way in and a round-trip would
// compare two different shapes and never match.
const lastStyleValue = new Map();
function forgetStyleValues(layerId) {
  if (layerId == null) { lastStyleValue.clear(); return; }
  const prefix = `${layerId}\u0000`;
  for (const key of lastStyleValue.keys()) if (key.startsWith(prefix)) lastStyleValue.delete(key);
}
function styleValueChanged(layerId, prop, value) {
  const key = `${layerId}\u0000${prop}`;
  const next = JSON.stringify(value === undefined ? null : value);
  if (lastStyleValue.get(key) === next) return false;
  lastStyleValue.set(key, next);
  return true;
}
function setPaint(layerId, prop, value) {
  if (styleValueChanged(layerId, `paint.${prop}`, value)) map.setPaintProperty(layerId, prop, value);
}
function setLayout(layerId, prop, value) {
  if (styleValueChanged(layerId, `layout.${prop}`, value)) map.setLayoutProperty(layerId, prop, value);
}
function setLayerFilter(layerId, value) {
  if (styleValueChanged(layerId, 'filter', value)) map.setFilter(layerId, value);
}

function updateVisibility(src) {
  // Dense visual sources use the layers' native minzoom, which updates
  // reliably throughout wheel, trackpad, touch, keyboard, and programmatic
  // zoom gestures.
  const on = src.id === 'routes' ? display.designated
    : src.id === 'restrict' ? display.bikesProhibited
    : true;
  if (src.closure) {
    for (const id of [src.id, src.id + '__line']) {
      if (map.getLayer(id)) setLayout(id, 'visibility', on ? 'visible' : 'none');
    }
    return;
  }
  if (map.getLayer(src.id)) setLayout(src.id, 'visibility', on ? 'visible' : 'none');
  if (src.id === 'roads' && map.getLayer(stateSidewalkProbeId))
    setLayout(stateSidewalkProbeId, 'visibility', 'visible');
  if (map.getLayer(trailBaseId(src))) setLayout(trailBaseId(src), 'visibility', 'visible');
  if (map.getLayer(trailId(src))) setLayout(trailId(src), 'visibility',
    display.offstreetTrails ? 'visible' : 'none');
  if (map.getLayer(trailDotsId(src))) setLayout(trailDotsId(src), 'visibility',
    display.offstreetTrails ? 'visible' : 'none');
  if (map.getLayer(backgroundUnpavedId(src)))
    setLayout(backgroundUnpavedId(src), 'visibility',
      display.unpavedBackground ? 'visible' : 'none');
  if (map.getLayer(trailHitId(src))) setLayout(trailHitId(src), 'visibility', 'visible');
  if (src.fixed) { // overlay has no mode-specific layers to manage beyond the main one
    if (map.getLayer(hitId(src))) setLayout(hitId(src), 'visibility', 'visible');
    if (map.getLayer(failId(src))) setLayout(failId(src), 'visibility', 'none');
    if (map.getLayer(vhId(src))) setLayout(vhId(src), 'visibility', 'none');
    return;
  }
  if (map.getLayer(hitId(src))) setLayout(hitId(src), 'visibility', 'visible');
  if (map.getLayer(failId(src)))
    setLayout(failId(src), 'visibility',
      display.failRules && display.passFail ? 'visible' : 'none');
  if (map.getLayer(vhId(src)))
    setLayout(vhId(src), 'visibility',
      display.failRules && !display.passFail ? 'visible' : 'none');
  if (map.getLayer(prohibitedId(src)))
    setLayout(prohibitedId(src), 'visibility',
      display.bikesProhibited ? 'visible' : 'none');
}

// Switch a source between the color-ramp view (level 4 dashed) and the green
// pass/fail view (gray-dashed fail overlay). For setData sources the level
// lives on each feature; for expression sources it's computed inline, so this
// also serves as the "rescore" when rules change.
function visibleRoadCategoryFilter(src, lvl) {
  const filters = [];
  const passing = ['match', lvl, [1, 2], true, false];
  const facility = bikeNetworkExpr(src);
  if (display.bikeFacilities) filters.push(['all', passing, facility]);
  // Use an explicit boolean comparison here. It is accepted consistently as
  // a style expression in both the bundled iOS MapLibre runtime and browsers;
  // a rejected branch would invalidate this entire `any` filter, including
  // otherwise-independent bike-facility and caution branches.
  if (display.meetRules) filters.push(['all', passing, ['==', facility, false]]);
  if (display.caution) filters.push(['==', lvl, 3]);
  if (!filters.length) return ['boolean', false];
  return filters.length === 1 ? filters[0] : ['any', ...filters];
}

function applyDisplayMode(src) {
  if (!map.getLayer(src.id)) return;
  if (src.closure) {
    if (map.getLayer(src.id + '__line')) {
      setPaint(src.id + '__line', 'line-opacity', backgroundLineOpacity(0.92));
    }
    updateVisibility(src);
    return;
  }
  if (src.ribbon) {
    // Designation is useful context, not physical infrastructure: show it as
    // a translucent dashed corridor above ordinary safety/facility coloring.
    // Regulatory restrictions and closures retain the two higher z-ranks.
    setLayerFilter(src.id, null);
    // A relative of the bike-network lime, deliberately duller and translucent:
    // a signed route is a recommendation whose usability still depends on the
    // road passing the rider's own rules, so it reads as family with the lime
    // without claiming to BE bike infrastructure.
    setPaint(src.id, 'line-color', DESIGNATED_COLOR);
    setPaint(src.id, 'line-width', designatedRibbonWidth());
    setPaint(src.id, 'line-opacity', backgroundLineOpacity(0.4));
    setPaint(src.id, 'line-dasharray', [2, 1.4]);
    if (map.getLayer(failId(src))) setLayerFilter(failId(src), ['boolean', false]);
    if (map.getLayer(vhId(src))) setLayerFilter(vhId(src), ['boolean', false]);
    updateVisibility(src);
    return;
  }
  if (src.id === 'blts') {
    // WSDOT remains queryable for its detailed road-information cards, but
    // its increasing/decreasing inventory lines must not be painted on top of
    // one another. State-highway verdicts are conflated onto the matching OSM
    // road centerline in roads.pmtiles, producing one aligned visual road.
    for (const id of [src.id, failId(src), vhId(src)]) {
      if (map.getLayer(id)) setLayerFilter(id, ['boolean', false]);
    }
    if (map.getLayer(hitId(src))) setLayerFilter(hitId(src), osmHitFilter(src));
    updateVisibility(src);
    return;
  }
  if (src.fixed) {
    // Regulatory overlay: exempt from the rules, but drawn with the SAME
    // color coding as any failing road in the current display mode.
    setLayerFilter(src.id, null);
    if (display.passFail) {
      setPaint(src.id, 'line-color', FAIL_COLOR);
      setPaint(src.id, 'line-dasharray', [2, 2]);
      setPaint(src.id, 'line-width', ['interpolate', ['linear'], ['zoom'], 6, 0.8, 10, 1.4, 14, 2.6]);
      setPaint(src.id, 'line-opacity', backgroundLineOpacity(0.65));
    } else {
      setPaint(src.id, 'line-color', COLORS[4]);
      setPaint(src.id, 'line-dasharray', [2, 1.5]);
      setPaint(src.id, 'line-width', ['interpolate', ['linear'], ['zoom'], 6, 1.1, 10, 1.9, 14, 3.7]);
      setPaint(src.id, 'line-opacity', backgroundLineOpacity(0.9));
    }
    if (map.getLayer(failId(src))) setLayerFilter(failId(src), ['boolean', false]);
    if (map.getLayer(vhId(src))) setLayerFilter(vhId(src), ['boolean', false]);
    updateVisibility(src);
    return;
  }
  const lvl = src.expr ? levelExprFor(src) : ['get', 'level'];
  // These sources carry an OSM highway class, so their colored road interiors
  // can follow the exact same major/medium/local zoom thresholds as the
  // locally rendered street underneath.
  const alignRoadClasses = src.id === 'roads' || src.id === 'osm';
  const and = (f) => {
    const conds = [f];
    // Explicitly technical MTB paths stay out of the normal map view as well
    // as the normal router. They reappear immediately when the rider opts in.
    if (src.id === 'osm' && !rules.allowMtbTrails) conds.push(OSM_NOT_MTB_EXPR);
    if (src.id === 'osm') conds.push(OSM_NOT_HIKING_EXPR);
    return conds.length > 1 ? ['all', ...conds] : f;
  };
  // The shared vector-road source knows each OSM class. Reveal its safety fill
  // at exactly the zoom where BikeBasemap reveals that class's street casing.
  const opacity = (value) => {
    // Opaque aligned fills remove alpha-addition seams. Their color expression
    // is pre-blended to retain the previous muted visual strength.
    const backgroundOpacity = alignRoadClasses ? 1 : backgroundLineOpacity(value);
    const verdictOpacity = alignRoadClasses ? 1
      : ['case', ['==', lvl, 3], cautionBackgroundLineOpacity(), backgroundOpacity];
    if (!alignRoadClasses) return verdictOpacity;
    const visibleAtLocal = src.id === 'osm'
      ? ['any', ROAD_CLASS_MAJOR_EXPR, ROAD_CLASS_MEDIUM_EXPR,
        ROAD_CLASS_LOCAL_EXPR, OSM_TRAIL_EXPR]
      : ['any', ROAD_CLASS_MAJOR_EXPR, ROAD_CLASS_MEDIUM_EXPR, ROAD_CLASS_LOCAL_EXPR];
    const earlyBikeFacility = display.bikeFacilities ? bikeNetworkExpr(src) : ['boolean', false];
    // MapLibre permits zoom only as the input to a top-level step/interpolate.
    // Each output is therefore a feature-dependent class mask.
    return ['step', ['zoom'],
      ['case', earlyBikeFacility, verdictOpacity, 0],
      BikeBasemap.ROAD_MIN_ZOOM.major,
      ['case', ['any', earlyBikeFacility, ROAD_CLASS_MAJOR_EXPR], verdictOpacity, 0],
      BikeBasemap.ROAD_MIN_ZOOM.medium,
      ['case',
        ['any', earlyBikeFacility, ROAD_CLASS_MAJOR_EXPR, ROAD_CLASS_MEDIUM_EXPR],
        verdictOpacity, 0],
      BikeBasemap.ROAD_MIN_ZOOM.local,
      ['case', visibleAtLocal, verdictOpacity, 0],
    ];
  };
  // Keep background data present without competing with a planned route. The
  // broad invisible hit target below preserves easy road inspection even with
  // these deliberately fine visual strokes.
  if (display.passFail) {
    const passFilter = visibleRoadCategoryFilter(src, lvl);
    setLayerFilter(src.id, src.id === 'osm' ? ['boolean', false] : and(passFilter));
    setPaint(src.id, 'line-color', alignRoadClasses
      ? opaqueRoadColorExpr(src, PASS_COLOR, backgroundLineOpacity(0.95))
      : PASS_COLOR);
    setPaint(src.id, 'line-opacity', opacity(0.95));
    setPaint(src.id, 'line-width', safetyRoadWidth(src));
  } else {
    // Solid ramp for passing levels (and unknown); level 4 goes to the dashed vh layer.
    const verdictFilter = visibleRoadCategoryFilter(src, lvl);
    setLayerFilter(src.id, src.id === 'osm' ? ['boolean', false] : and(verdictFilter));
    setPaint(src.id, 'line-color', alignRoadClasses
      ? opaqueBackgroundVerdictColorExpr(src, lvl)
      : verdictColorExpr(src, lvl));
    setPaint(src.id, 'line-opacity', opacity(0.9));
    setPaint(src.id, 'line-width', safetyRoadWidth(src));
  }
  const visibleTrail = display.offstreetTrails
    ? (display.passFail
      ? ['all', ['>=', lvl, 1], ['<=', lvl, display.passMax], OSM_TRAIL_EXPR]
      : ['all', ['!=', lvl, 4], OSM_TRAIL_EXPR])
    : ['boolean', false];
  if (map.getLayer(trailId(src))) {
    setLayerFilter(trailId(src), and(visibleTrail));
    setPaint(trailId(src), 'line-color', display.passFail ? PASS_COLOR : BIKE_NETWORK_COLOR);
    setPaint(trailId(src), 'line-opacity', backgroundLineOpacity(0.95));
  }
  if (map.getLayer(trailDotsId(src))) {
    setLayerFilter(trailDotsId(src), and(visibleTrail));
    setPaint(trailDotsId(src), 'line-color', display.passFail ? '#3f5200' : '#4c5c00');
    setPaint(trailDotsId(src), 'line-opacity', backgroundLineOpacity(0.95));
  }
  if (map.getLayer(backgroundUnpavedId(src))) {
    setLayerFilter(backgroundUnpavedId(src), and(OSM_CONFIRMED_UNPAVED_EXPR));
  }
  // The neutral ghost keeps pace with the MTB/hiking exclusions but never
  // with the trails toggle: a way the router would not use stays off the
  // map entirely; a way it would use always at least exists.
  if (map.getLayer(trailBaseId(src))) {
    setLayerFilter(trailBaseId(src), and(OSM_TRAIL_EXPR));
  }
  if (map.getLayer(trailHitId(src))) setLayerFilter(trailHitId(src), and(visibleTrail));
  if (map.getLayer(failId(src))) {
    const failFilter = ['all', ['>=', lvl, display.passMax + 1], ['<=', lvl, 4]];
    setLayerFilter(failId(src), and(src.id === 'osm'
      ? ['all', failFilter, OSM_TRAIL_EXPR] : failFilter));
    setPaint(failId(src), 'line-color', alignRoadClasses
      ? opaqueRoadColorExpr(src, FAIL_COLOR, backgroundLineOpacity(0.65))
      : FAIL_COLOR);
    setPaint(failId(src), 'line-width', safetyRoadWidth(src));
    setPaint(failId(src), 'line-opacity', opacity(0.65));
  }
  // A prohibited road is a FAILING road -- the strongest kind -- so it keeps its
  // failure colouring and the prohibition rides on top as a translucent ribbon.
  // Suppressing one for the other left whole highway corridors with no safety
  // colour at all, which is the opposite of what a prohibition should convey.
  const failFilter = src.id === 'osm'
    ? ['all', ['==', lvl, 4], OSM_TRAIL_EXPR]
    : ['==', lvl, 4];
  if (map.getLayer(vhId(src))) {
    setLayerFilter(vhId(src), and(failFilter));
    setPaint(vhId(src), 'line-color', alignRoadClasses
      ? opaqueRoadColorExpr(src, COLORS[4], backgroundLineOpacity(0.9))
      : COLORS[4]);
    setPaint(vhId(src), 'line-width', safetyRoadWidth(src));
    setPaint(vhId(src), 'line-opacity', opacity(0.9));
  }
  // Texture overlays. They are decoration on the road below, so they take the
  // SAME filter, the same width and the same class-masked opacity as the line
  // they sit on -- a flat opacity here made a failing freeway and a failing
  // local street fade at different zooms, because only one of them was masked.
  // Above PATTERN_MIN_ZOOM the slash replaces the dash rather than stacking on
  // it, so exactly one representation of a failure draws at any zoom.
  if (map.getLayer(slashId(src))) {
    setLayerFilter(slashId(src), and(failFilter));
    setPaint(slashId(src), 'line-width', safetyRoadWidth(src));
    setPaint(slashId(src), 'line-opacity', opacity(0.95));
    setLayout(slashId(src), 'visibility',
      display.failRules ? 'visible' : 'none');
  }
  if (map.getLayer(cautionId(src))) {
    setLayerFilter(cautionId(src), and(['all', ['==', lvl, 3],
      visibleRoadCategoryFilter(src, lvl)]));
    setPaint(cautionId(src), 'line-width', safetyRoadWidth(src));
    setPaint(cautionId(src), 'line-opacity', opacity(0.95));
    setLayout(cautionId(src), 'visibility',
      display.caution ? 'visible' : 'none');
  }
  if (alignRoadClasses) {
    // At a junction, draw ordinary passing roads first and physical bicycle
    // facilities last. Their opaque flat-ended fills then meet cleanly instead
    // of leaving a blue spur on top of the lime corridor.
    setLayout(src.id, 'line-sort-key',
      ['case', bikeNetworkExpr(src), 3,
        ['match', lvl, 3, 2, [1, 2], 1, 0]]);
  }
  if (map.getLayer(hitId(src))) {
    // OSM trails use their purpose-built, wider hit layer above.  Keeping the
    // generic road target off them ensures the full-width trail target wins
    // instead of a thinner overlapping target being returned first.
    const mainHitFilter = src.id === 'osm'
      ? ['all', OSM_NOT_TRAIL_EXPR, ['!', sharrowOnlyExpr()]] : ['boolean', true];
    setLayerFilter(hitId(src), src.id === 'osm' ? and(mainHitFilter) : null);
    const normalHitWidth = ['interpolate', ['linear'], ['zoom'], 6, 8, 12, 14, 16, 22];
    const knownRoadClass = ['any',
      ROAD_CLASS_MAJOR_EXPR, ROAD_CLASS_MEDIUM_EXPR, ROAD_CLASS_LOCAL_EXPR];
    const classAlignedHitWidth = ['step', ['zoom'],
      0,
      BikeBasemap.ROAD_MIN_ZOOM.major,
      ['case', ROAD_CLASS_MAJOR_EXPR, 8, 0],
      BikeBasemap.ROAD_MIN_ZOOM.medium,
      ['case', ['any', ROAD_CLASS_MAJOR_EXPR, ROAD_CLASS_MEDIUM_EXPR], 10, 0],
      BikeBasemap.ROAD_MIN_ZOOM.local,
      ['case', knownRoadClass, 13, 0],
      14,
      ['case', knownRoadClass, 18, 0],
      16,
      ['case', knownRoadClass, 22, 0],
    ];
    setPaint(hitId(src), 'line-width',
      alignRoadClasses ? classAlignedHitWidth : normalHitWidth);
  }
  updateVisibility(src);
}

function applyDisplayModeAll() {
  for (const src of SOURCES) applyDisplayMode(src);
}

async function jsonAssetResponse(response, url) {
  if (!/\.gz(?:$|[?#])/.test(url)) return response.json();
  const bytes = new Uint8Array(await response.arrayBuffer());
  // Some web servers transparently decode a .gz resource. Accept both forms
  // so the same build works from GitHub Pages and inside the native shell.
  const compressed = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!compressed) return new Response(bytes).json();
  // The browser can gunzip and parse this itself, in native code, straight from
  // the bytes. Doing it in JS meant fflate inflating 5.7 MB to a 30 MB array,
  // strFromU8 turning that into a 30 MB string (60 MB of UTF-16), and only then
  // parsing -- half a second of blocked main thread during startup, for the
  // overlays alone. The routing graph has been decompressed this way for a
  // while; the map data had not caught up.
  if (typeof DecompressionStream === 'function') {
    const gunzipped = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(gunzipped).json();
  }
  if (!window.fflate?.gunzipSync || !window.fflate?.strFromU8) {
    throw new Error('compressed map-data decoder unavailable');
  }
  return JSON.parse(window.fflate.strFromU8(window.fflate.gunzipSync(bytes)));
}

// Deliberately quiet on progress: every source loads once at startup, so
// "Loading X…" / "X: N segments" toasts were startup chatter stacked on top
// of the routing-engine progress notice that already owns that moment. The
// Layers panel's per-source counts report the same numbers at leisure; only
// a FAILURE is worth a toast.
async function loadSource(src) {
  if (src.loaded || src.loading) return;
  if (src.vector) {
    // Vector tiles: nothing to prefetch — the map streams tiles on demand.
    ensureLayer(src);
    src.loaded = true;
    updateSourceCount(src);
    return;
  }
  src.loading = true;
  try {
    let fc;
    if (src.urlPattern) {
      // Multi-part source: fetch data/<name>-1.geojson, -2, ... until a part is missing.
      const features = [];
      for (let i = 1; i <= 20; i++) {
        let res;
        try {
          res = await fetch(src.urlPattern.replace('{i}', i));
        } catch (err) {
          if (i === 1) throw err;
          break; // offline: the end-of-parts probe can reject instead of 404
        }
        if (!res.ok) {
          if (i === 1) throw new Error('HTTP ' + res.status);
          break;
        }
        const partUrl = src.urlPattern.replace('{i}', i);
        const part = await jsonAssetResponse(res, partUrl);
        // (no spread: pushing 200k+ args at once overflows the call stack)
        for (const f of part.features) features.push(f);
      }
      fc = { type: 'FeatureCollection', features };
    } else {
      const res = await fetch(src.url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      fc = await jsonAssetResponse(res, src.url);
    }
    // The bike-infrastructure sharrow-only drop that used to happen here now
    // happens when the overlay tiles are built (scripts/build_overlay_tiles.py)
    // -- the source streams from vector tiles and never passes through this
    // path. sharrowOnly() stays above as the model's predicate: the hit-layer
    // filters compile from its expression twin.
    src.count = Number.isFinite(fc.routeCount) ? fc.routeCount : fc.features.length;
    src.fc = fc;
    if (!src.expr) rescore(src); // sets .level on every feature
    ensureLayer(src);
    if (src.expr) src.fc = null; // expression-scored: the map keeps its own copy
    src.loaded = true;
    updateSourceCount(src);
  } catch (e) {
    setStatus(`Failed to load ${src.name} (${e.message})`, true);
  } finally {
    src.loading = false;
  }
}

function setSourceVisible(src, on) {
  src.enabled = on;
  if (on && !src.loaded) loadSource(src);
  else if (on && !map.getLayer(src.id)) ensureLayer(src);
  else updateVisibility(src);
  saveStateSoon();
}

function setBackgroundUnpavedVisible(on) {
  display.unpavedBackground = !!on;
  const osm = SOURCES.find((src) => src.id === 'osm');
  if (osm && map.getLayer(backgroundUnpavedId(osm))) {
    setLayout(backgroundUnpavedId(osm), 'visibility',
      display.unpavedBackground ? 'visible' : 'none');
  }
  saveStateSoon();
}

/* ------------------------------------------- blink a layer on enable */
// Turning a layer ON blinks it -- off, on, off, on -- and drops the drawn route
// beneath every overlay while it does. Two things a rider wants to know at that
// moment: which lines on this busy map are the ones I just switched on, and
// does that layer run along my route? Blinking answers the first because only
// the new layer moves. Sinking the route answers the second: a signed state
// bike route is drawn under the route line and is invisible exactly where it
// matters most. The route stays on screen throughout -- it is the thing being
// compared against, so hiding it would defeat the comparison.
//
// Nothing else is touched. An earlier version dimmed every OTHER layer for half
// a second, which answered "which is new" by removing the context you needed to
// judge it against -- and the road network under your route is exactly that
// context.
//
// Only on enable. Turning a layer off needs no cue: the thing you wanted to see
// is the map without it, and you are already looking at that.
const BLINK_MS = 90;
// Ends on `true`, so the layer is left visible no matter where this stops.
const BLINK_STEPS = [false, true, false, true];
// The keys this can blink, in the order buildSourcePanel lists them.
const SOLO_LAYER_KEYS = ['offstreetTrails', 'bikeFacilities', 'meetRules', 'failRules',
  'caution', 'designated', 'bikesProhibited', 'unpavedBackground'];
let soloPreviewTimer = null;
// The true rider-chosen state, held while a blink is showing something else.
// Everything that persists or re-reads `display` must see THIS, never the
// mid-blink version -- a blink is a cue, not a setting.
let soloPreviewRestore = null;

// The DRAWN route's layers: 'route' and 'route-*'. The boundary matters -- the
// designated bike-route ribbon draws on a source called `routes`, whose layers
// ('routes', 'routes__hit', 'routes__fail', 'routes__vh') a bare /^route/ also
// matches. That bug hid the bike-route overlay during every preview, and when
// the rider enabled bike routes it hid the one layer they had just asked to
// see -- which is precisely the ribbon this effect now exists to reveal.
const DRAWN_ROUTE_LAYER = /^route($|-)/;
// Where each drawn-route layer sits in the stack, as (layer, the first
// non-route layer above it). Restoring against that anchor rather than against
// a neighbouring route layer means the whole group can be moved and put back
// exactly, in one pass, without the intermediate positions mattering.
function routeLayerOrder() {
  const ids = map.getStyle().layers.map((l) => l.id);
  const order = [];
  for (let i = 0; i < ids.length; i++) {
    if (!DRAWN_ROUTE_LAYER.test(ids[i])) continue;
    let j = i + 1;
    while (j < ids.length && DRAWN_ROUTE_LAYER.test(ids[j])) j++;
    order.push([ids[i], ids[j]]);   // undefined anchor = move to the very top
  }
  return order;
}

// Sink the drawn route beneath every overlay for the length of a blink. The
// route is NOT hidden -- a rider needs it there to judge whether the blinking
// layer follows it -- it just stops covering the thing it is being compared
// against. A signed bike route is drawn under the route line and is otherwise
// invisible exactly where it matters most.
function sinkRouteLayers(order) {
  const anchor = map.getStyle().layers.find((l) => !/^(background|basemap)/.test(l.id));
  if (!anchor) return;
  for (const [id] of order) if (map.getLayer(id)) map.moveLayer(id, anchor.id);
}
function restoreRouteLayers(order) {
  for (const [id, before] of order) if (map.getLayer(id)) map.moveLayer(id, before);
}

// Show or hide exactly what one layer key controls, without persisting it.
// unpavedBackground hangs off its own layer rather than the display filters.
function paintLayerKey(key, on) {
  if (key === 'unpavedBackground') {
    display.unpavedBackground = on;
    const osm = SOURCES.find((src) => src.id === 'osm');
    if (osm && map.getLayer(backgroundUnpavedId(osm))) {
      setLayout(backgroundUnpavedId(osm), 'visibility', on ? 'visible' : 'none');
    }
    return;
  }
  display[key] = on;
  applyDisplayModeAll();
}

function endSoloPreview() {
  if (!soloPreviewRestore) return;
  const { flags, routeOrder } = soloPreviewRestore;
  soloPreviewRestore = null;
  clearInterval(soloPreviewTimer);
  soloPreviewTimer = null;
  Object.assign(display, flags);
  applyDisplayModeAll();
  const osm = SOURCES.find((src) => src.id === 'osm');
  if (osm && map.getLayer(backgroundUnpavedId(osm))) {
    setLayout(backgroundUnpavedId(osm), 'visibility',
      display.unpavedBackground ? 'visible' : 'none');
  }
  restoreRouteLayers(routeOrder);
}

function startSoloPreview(key) {
  // A second toggle mid-blink restores the first before capturing, so the held
  // state is always the rider's, never a half-blinked snapshot.
  endSoloPreview();
  const flags = Object.fromEntries(SOLO_LAYER_KEYS.map((k) => [k, display[k]]));
  soloPreviewRestore = { flags, routeOrder: routeLayerOrder() };
  sinkRouteLayers(soloPreviewRestore.routeOrder);
  let step = 0;
  soloPreviewTimer = setInterval(() => {
    if (step >= BLINK_STEPS.length) { endSoloPreview(); return; }
    paintLayerKey(key, BLINK_STEPS[step++]);
  }, BLINK_MS);
}

function setMapLayerVisible(key, on) {
  // Read the rider's real setting, not whatever a running preview is showing.
  const wasOn = savedLayer(key);
  const enabling = !!on && !wasOn;
  endSoloPreview();
  if (key === 'unpavedBackground') {
    setBackgroundUnpavedVisible(on);
  } else {
    display[key] = !!on;
    applyDisplayModeAll();
    saveStateSoon();
  }
  if (enabling && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    startSoloPreview(key);
  }
}

/* --------------------------------------------------------- routing */
/* Route Remix: one knob over the whole portfolio's temperament.
 *
 * The weights are reasonable, and still a rider sometimes knows a route
 * exists that the portfolio is not offering -- or wants the safer detour the
 * pruning considers excessive. Remix answers that WITHOUT touching the
 * rules (verdicts and colours are untouched) and WITHOUT editing the tuned
 * weights: at request time every subjective safety multiplier is scaled in
 * log space (w^k), so under `direct` a 9× wall softens to ~1.6× and a 0.21
 * trail bonus flattens to ~0.7, while `safe` deepens both. The additive
 * per-mph speed rates scale linearly. Physics stays physics: climb and turn
 * seconds, ferry wait, elevation factors are untouched, as are the freeway
 * and mountain-bike last-resort walls.
 *
 * The knob is a per-trip nudge, not a setting: unless the rider pins it
 * with "always use this mode", changing start or destination snaps it back
 * to Recommended. Waypoints and road blocks refine the SAME trip, so they
 * keep it.
 */
// Labels complete the dialog's title, "Show me routes that are…".
const ROUTE_REMIX_MODES = Object.freeze({
  // 0.22 after field testing found 0.45 too timid: the 9× balanced failing
  // wall drops to ~1.6× and heavy-traffic pressure to ~1.1×, so the search is
  // mostly time and distance with mild nudges left.
  direct: { exponent: 0.22, label: 'More direct', hint: 'May be less safe' },
  recommended: { exponent: 1, label: 'Recommended', hint: 'The normal balance of safety and practicality' },
  // 1.2, down from 1.35: log-space scaling explodes the LARGE walls (the 30x
  // low-stress fail wall became ~99x), and on a cross-state trip that bought
  // forty-mile trail detours and ferry triangles. 1.2 keeps the lean
  // (30x -> ~59x) without pricing whole regions off the map.
  safe: { exponent: 1.2, label: 'More safety-focused', hint: 'May be longer' },
});
const REMIX_SCALED_MULTIPLIERS = Object.freeze([
  'failRoadDirect', 'failRoadBalanced', 'failRoadLowStress',
  'comfyRoadBalanced', 'comfyRoadLowStress',
  'designated', 'strongDesignated', 'residential',
  'facilityShared', 'facilityLane', 'facilityBuffered', 'facilitySeparated', 'facilityPath',
  'limitedAccessDirect', 'limitedAccessBalanced', 'limitedAccessLowStress',
  'curveDirect1', 'curveDirect2', 'curveDirect3',
  'curveBalanced1', 'curveBalanced2', 'curveBalanced3',
  'curveLowStress1', 'curveLowStress2', 'curveLowStress3',
  'busyLightDirect', 'busyLightBalanced', 'busyLightLowStress',
  'busyMediumDirect', 'busyMediumBalanced', 'busyMediumLowStress',
  'busyHeavyDirect', 'busyHeavyBalanced', 'busyHeavyLowStress',
  'wideRoadDirect', 'wideRoadBalanced', 'wideRoadLowStress',
  'stressedRoadDirect', 'stressedRoadBalanced', 'stressedRoadLowStress',
]);
const REMIX_SCALED_RATES = Object.freeze(['speedOverBalanced', 'speedOverLowStress',
  'speedBelowDirect', 'speedBelowBalanced', 'speedBelowLowStress']);
function remixedRoutingWeights(mode = routing.remix) {
  const k = ROUTE_REMIX_MODES[mode]?.exponent ?? 1;
  const weights = { ...routingWeights };
  if (k === 1) return weights;
  // Same bounds validRoutingWeights enforces on rider input, so a remix of an
  // already-extreme tuned weight cannot leave the worker's sane range.
  const bound = (value) => Math.min(120, Math.max(0.1, value));
  for (const key of REMIX_SCALED_MULTIPLIERS) {
    if (Number.isFinite(weights[key])) weights[key] = +bound(Math.pow(weights[key], k)).toFixed(4);
  }
  for (const key of REMIX_SCALED_RATES) {
    if (Number.isFinite(weights[key])) weights[key] = +(weights[key] * k).toFixed(5);
  }
  return weights;
}

// Fully client-side: A* over a prebuilt graph (data/graph.bin.gz) in a web
// worker. No routing server. Costs come from the CURRENT riding rules; the
// route recomputes when the rules change.
const routing = {
  arm: null,                 // 'start' | 'end' — next map tap sets that point
  start: null, end: null,    // [lng, lat]
  startName: null, endName: null, startFromDevice: false,
  vias: [],                  // intermediate stops: { pt: [lng,lat], marker }
  blocks: [],                // avoided road locations: { pt: [lng,lat], marker }
  startMarker: null, endMarker: null,
  worker: null, ready: false, loading: false, pendingRoute: false, routeRequestActive: false,
  loadedGraphVersion: null, // sha of the graph bytes the router actually has
  mode: ['direct', 'balanced', 'low'].includes(savedState?.mode)
    ? savedState.mode : 'balanced', // 'direct' | 'balanced' | 'low'
  profileId: validRouteProfileId(savedState?.profileId)
    ? savedState.profileId : legacyRouteProfile(savedState?.mode),
  prefDesig: savedState && typeof savedState.prefDesig === 'boolean'
    ? savedState.prefDesig : DEFAULT_ROUTE_PREFERENCES.prefDesig, // force this preference across every route option
  prefResidential: savedState && typeof savedState.prefResidential === 'boolean'
    ? savedState.prefResidential : DEFAULT_ROUTE_PREFERENCES.prefResidential,
  // See ROUTE_REMIX_MODES. Restored across restarts, but only until the next
  // start/destination change -- a remix is an inspection of this trip, not a
  // standing preference. (The "Make this the default" pin is gone: a rider
  // who wants a permanent temperament tunes the weights themselves.)
  remix: ['direct', 'recommended', 'safe'].includes(savedState?.remix)
    ? savedState.remix : 'recommended',
  reqId: 0,
  compareStartedAt: 0,
  selectRecommendedNext: false,
  // The trip's frozen chooser lineup: [{ letter, profileId }]. Created by each
  // fresh (re-lettering) search, held across refinements. missingLetters are
  // pinned recipes the latest refinement could not route.
  pinnedLetters: null,
  missingLetters: null,
  lastRequestPinned: false,
  options: [],
  // Summaries of every candidate the last portfolio built, offered or not, for
  // the "More" screen. Full geometry is fetched from the worker on tap.
  allCandidates: [], candidatesKey: null,
  last: null, // last successful result (for redraws)
  // Shared-route ("As Shared") state — the sender's recipe and whether the
  // shared route is currently the active option.
  sharedRecipe: sharedRoute ? {
    mode: sharedRoute.mode,
    profileId: sharedRoute.profileId || legacyRouteProfile(sharedRoute.mode),
    prefDesig: sharedRoute.prefDesig,
    prefResidential: sharedRoute.prefResidential,
    weights: sharedRoute.weights,
    rules: sharedRoute.rules,
  } : null,
  sharedActive: false,
  sharedLoading: false,
};

function setRouteStatus(t) {
  for (const id of ['route-status', 'rb-status']) {
    const el = document.getElementById(id);
    if (el) el.textContent = t;
  }
}

let routeActionToastTimer = null;
function showRouteActionToast(text, { busy = false, detail = '', duration = 2200 } = {}) {
  const toast = document.getElementById('routeActionToast');
  const label = document.getElementById('routeActionText');
  const detailLabel = document.getElementById('routeActionDetail');
  if (!toast || !label || !detailLabel) return;
  clearTimeout(routeActionToastTimer);
  label.textContent = text || '';
  detailLabel.textContent = detail || '';
  detailLabel.hidden = !detail;
  toast.classList.toggle('busy', busy);
  toast.classList.toggle('has-detail', !!detail);
  toast.hidden = !text;
  if (text && duration > 0) routeActionToastTimer = setTimeout(() => { toast.hidden = true; }, duration);
}

function showRouterProgress(detail, title = 'Loading routing engine') {
  setRouteStatus(detail || title);
  showRouteActionToast(title, { busy: true, detail, duration: 0 });
  // On a first install the routing data is the long wait, and on iOS it can
  // overlap the launch screen -- which then sat on a generic message with
  // nothing to say. This no-ops once the app has taken over the screen.
  window.__setAppLaunchStatus?.(detail || title);
}

// If the graph we want is not the one we last loaded, ask the worker to drop
// its cached copy before fetching. Without this the first load after a graph
// rebuild is still controlled by the PREVIOUS service worker, which serves
// /data/ ignoring the query string and returns the stale graph -- so the map
// and the cards pick up new data while the router keeps routing on the old.
const GRAPH_VERSION_KEY = 'jra.graphDataVersion';
async function purgeStaleGraphCache() {
  let seen = null;
  try { seen = localStorage.getItem(GRAPH_VERSION_KEY); } catch { /* private mode */ }
  if (seen === GRAPH_DATA_VERSION) return;
  const worker = navigator.serviceWorker?.controller;
  if (worker) {
    await new Promise((resolve) => {
      const done = (event) => {
        if (event.data?.type !== 'GRAPH_PURGED') return;
        navigator.serviceWorker.removeEventListener('message', done);
        resolve();
      };
      navigator.serviceWorker.addEventListener('message', done);
      worker.postMessage({ type: 'PURGE_GRAPH' });
      // An older worker does not know this message; do not hang on it.
      setTimeout(resolve, 1500);
    });
  }
}

// Marked only when a graph that genuinely carries the current data has loaded.
// Recording it at fetch time made the self-heal one-shot: an older worker
// ignores the purge, serves the stale graph anyway, and the flag then says the
// job is done forever.
function markGraphDataLoaded() {
  try { localStorage.setItem(GRAPH_VERSION_KEY, GRAPH_DATA_VERSION); } catch { /* ignore */ }
}

async function readRoutingGraphResponse(response) {
  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body?.getReader) return response.arrayBuffer();
  const reader = response.body.getReader();
  // GitHub Pages and the offline cache both provide Content-Length. Fill the
  // final buffer directly instead of retaining ~30 MB of chunks and then
  // allocating a second ~30 MB concatenation buffer.
  let bytes = total > 0 ? new Uint8Array(total) : null;
  const chunks = bytes ? null : [];
  let received = 0, announcedPercent = -10;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes) {
      if (received + value.byteLength > bytes.byteLength) {
        // A broken Content-Length should cost memory only on that exceptional
        // response, not on every normal graph load.
        const grown = new Uint8Array(Math.max(received + value.byteLength, bytes.byteLength * 2));
        grown.set(bytes);
        bytes = grown;
      }
      bytes.set(value, received);
    } else {
      chunks.push(value);
    }
    received += value.byteLength;
    if (total > 0) {
      const percent = Math.min(100, Math.floor((received / total) * 10) * 10);
      if (percent >= announcedPercent + 10) {
        announcedPercent = percent;
        showRouterProgress(`Downloading ${Region.name} roads and trails · ${percent}%`);
      }
    }
  }
  if (!bytes) {
    bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  }
  return received === bytes.byteLength ? bytes.buffer : bytes.slice(0, received).buffer;
}

// Off-network start/end pins matter, but not enough to hold route-card space
// permanently: surface them as a passing toast, with the full note kept in
// Route Details.
//
// 600 ft: under that, "your pin is a couple of blocks off the network" is
// normal life -- a pin in a park, a house up a driveway -- and warning about
// it on most routes made the toast furniture. It fires only where the walk
// to the route is long enough to genuinely surprise.
const SNAP_NOTE_MIN_M = 182.88; // 600 ft
function notifySnapDistance(m) {
  if (!m || !m.ok) return;
  const notes = [];
  if (Number(m.snapStartM) >= SNAP_NOTE_MIN_M) notes.push(`Start connects ${fmtDist(m.snapStartM)} away`);
  if (Number(m.snapEndM) >= SNAP_NOTE_MIN_M) notes.push(`Destination connects ${fmtDist(m.snapEndM)} away`);
  if (notes.length) showRouteActionToast(`⚠ ${notes.join(' · ')}`, { duration: 5000 });
}

function handleRouterFailure(message) {
  const detail = String(message || 'unknown error');
  const routeWasRequested = (routing.pendingRoute || routing.routeRequestActive)
    && routing.start && routing.end;
  const reason = routeWasRequested
    ? `Routing map could not load (${detail}). Tap a route point to try again.`
    : `Routing map could not load (${detail}). It will retry when you request a route.`;
  showRouteActionToast('Routing map could not load', {
    detail: routeWasRequested
      ? 'Your points are still set. Tap either one to retry after checking your connection.'
      : 'No route was attempted. The app will try again when both route points are set.',
    duration: 7000,
  });
  routing.reqId++; // invalidate any reply still queued by the failed worker
  routing.ready = false;
  routing.loading = false;
  routing.pendingRoute = false;
  routing.routeRequestActive = false;
  if (routing.worker) routing.worker.terminate();
  routing.worker = null;
  setRouteOptionsLoading(false);
  updateArmButtons();
  if (routeWasRequested) {
    routing.options = [];
    renderRouteOptionControls();
    stopTurnNavigation(false);
    routing.last = { ok: false, code: 'router-error', reason };
    clearStoredRouteDetails();
    renderRouteCard(routing.last);
    if (map.isStyleLoaded()) drawRoute([]);
  }
  setRouteStatus(reason);
}

async function ensureRouter() {
  if (routing.ready || routing.loading) return;
  routing.loading = true;
  // Endpoint editing is safe while the graph initializes: computeRoute()
  // records a pending request and runs it once the worker reports ready. Keep
  // the planner download from making a fresh native install look unresponsive.
  setRouteActionsOpen(false);
  updateArmButtons();
  try {
    showRouterProgress(`Downloading ${Region.name} roads, trails, ferries, and elevation data…`);
    await purgeStaleGraphCache();
    // The worker starts before the bytes arrive so it is warm when they do, and
    // so the ~94 MB the gzip container expands to is allocated and inflated
    // over there. Doing that here used to lock the UI thread for seconds during
    // startup -- the exact window in which a rider taps the search box.
    routing.worker = new Worker('router-worker.js');
    routing.worker.onmessage = onRouterMessage;
    routing.worker.onerror = (event) => {
      event.preventDefault?.();
      handleRouterFailure(event.message || 'routing worker stopped');
    };
    routing.worker.onmessageerror = () => handleRouterFailure('routing worker sent unreadable data');
    const res = await fetch(GRAPH_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = await readRoutingGraphResponse(res);
    // The version the router ACTUALLY loaded, from the bytes themselves --
    // GRAPH_DATA_VERSION only says what the shell asked for, and the one
    // failure worth diagnosing is precisely when an older service worker
    // serves stale bytes for the new URL. Hash before transfer neuters buf.
    try {
      const digest = await crypto.subtle.digest('SHA-256', buf);
      routing.loadedGraphVersion = 'sha-' + [...new Uint8Array(digest)].slice(0, 6)
        .map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch { routing.loadedGraphVersion = null; }
    syncGraphVersionLine();
    showRouterProgress('Starting the on-device route engine…');
    routing.worker.postMessage({ type: 'graph', buffer: buf }, [buf]);
  } catch (e) {
    handleRouterFailure(`routing data could not load: ${e.message}`);
  }
}

// The worker hands back segments carrying a `flags` bitfield; the map's tap
// layer carries the same facts already unpacked. Both shapes existed, and each
// grew its own adapter into the safety model — which is how a route card came
// to disagree with the road card about the same street. Unpack in exactly one
// place, so `scoreRouteSeg` -> `factsOf` is the only path from a segment to a
// verdict, and the map feature and the fallback level cannot drift apart.
function routeSegProps(s, routeIndex) {
  const flags = s.flags || 0;
  return {
    name: s.name, mph: s.mph, sh: s.sh, lenM: s.lenM,
    shBack: Number.isFinite(Number(s.shBack)) ? Number(s.shBack) : null,
    e: flags & 1 ? 1 : 0, fac: flags & 2 ? 1 : 0, fw: flags & 4 ? 1 : 0,
    lim: flags & 128 ? 1 : 0,
    hazard: s.hazard || 0, gradePct: s.gradePct || 0, crossing: s.crossing ? 1 : 0,
    lanes: s.lanes || 0, ctl: s.centerTurnLane ? 1 : 0, lts: s.lts || 0,
    ow: flags & 16 ? 1 : 0,
    infra: flags & 8 ? 1 : 0, ferry: flags & 32 ? 1 : 0, desig: flags & 64 ? 1 : 0,
    facility: s.facility || 0, official: s.official || 0, mtb: s.mtb ? 1 : 0,
    dismount: isDismountSegment(s) ? 1 : 0,
    surface: Number.isInteger(s.surface) ? s.surface : 0,
    roadClass: s.roadClass || 0,
    routeIndex,
    // Flattened onto the feature under the ROADS TILE's own key names, not
    // nested under a `measures` object. Two reasons, and the first is a bug
    // already shipped once: MapLibre serialises GeoJSON feature properties, so
    // a nested object comes back from the tap layer as a string and every
    // lookup on it silently reads undefined -- the route card lost its traffic
    // and edge-space rows while the road card kept them. The second is that
    // sharing the tile's key names lets one function, tileMeasures, serve both
    // cards, which is the only way they stay identical.
    ...measureProps(s.measures),
  };
}

// A worker segment's measurements as flat, tile-shaped scalars.
function measureProps(m) {
  if (!m) return {};
  const out = {};
  if (m.adt) {
    out.adt = m.adt;
    if (m.adty) out.ay = m.adty;
    if (m.adtSrc) out.asrc = m.adtSrc;
  }
  if (m.edge != null) {
    out.es = m.edge;
    if (m.edgeClamp) out.ec = 1;
  }
  if (m.countySh != null) out.cs = m.countySh;
  if (m.fc) out.fc = m.fc;
  if (m.owner) out.ow = m.owner;
  return out;
}
// A route segment the worker did not label (older payloads). Scores the segment
// through the same scorer the map and the card use.
function fallbackRouteLevel(s) { return effectiveLevel(scoreRouteSeg(routeSegProps(s))); }

// Preserve WHY a route segment is amber, not only the amber level. Route
// Details uses this to guarantee that every caution rendered on the route has
// a matching item under Concerns. New worker payloads provide the exact cause;
// the evaluation keeps older payloads useful.
function routeSegmentCautionCause(s) {
  if (s?.cautionCause) return s.cautionCause;
  const verdict = evaluateRoad(scoreRouteSeg(routeSegProps(s)));
  if (verdict.level === 3 && verdict.caution) return verdict.caution;
  if (s?.mtb) return 'mountain-bike';
  return routeSegmentDisplayCategory(s) === 'caution' ? 'other' : null;
}

function isHighwaySegment(s) {
  const flags = s.flags || 0;
  return !(flags & (4 | 8 | 32)) && (s.mph >= 45 || HIGHWAY_NAME.test(s.name || ''));
}

function routeSegmentDisplayCategory(s) {
  const level = s.level || fallbackRouteLevel(s);
  const props = routeSegProps(s);
  props.level = level;
  return routeVisualStyle(props);
}

function routeSummaryStats(m) {
  const levels = [0, 0, 0, 0, 0];
  let highwayM = 0, freewayM = 0, limitedAccessM = 0, bikeNetworkM = 0, mtbM = 0, dismountM = 0;
  let roadM = 0, roadSpeedM = 0, unpavedM = 0, inclineOver5M = 0;
  const categoryM = Object.fromEntries(ROUTE_CATEGORY_KEYS.map((key) => [key, 0]));
  for (const s of m.segs || []) {
    const flags = s.flags || 0;
    const len = Number(s.lenM) || 0;
    if (flags & 32) continue; // ferry is reported separately, not a riding safety level
    if (isConfirmedUnpavedSurface(s.surface)) unpavedM += len;
    if (credibleSegmentGradePct(s) > 5) inclineOver5M += len;
    const level = s.level || fallbackRouteLevel(s);
    if (level >= 1 && level <= 4) levels[level] += len;
    // Use the selected route's actual paint classifier. These five buckets are
    // mutually exclusive, so the percentages beside the map describe exactly
    // one visible style per metre instead of counting lime stretches again as
    // generic passing roads. Explicit level 0 from an older stored route is
    // rescored through the current ladder rather than creating a sixth row.
    const category = routeSegmentDisplayCategory(s);
    if (Object.prototype.hasOwnProperty.call(categoryM, category)) categoryM[category] += len;
    // Physical facilities only. A sharrow is paint in the shared travel lane,
    // so it is not part of this legacy aggregate either.
    if ((flags & 8) || (s.facility || 0) >= 2) bikeNetworkM += len;
    // Include every road speed, including roads with bike lanes. Dedicated
    // paths carry no motor-vehicle speed and are not part of this road average.
    const mph = Number(s.mph);
    if (!(flags & 8) && Number.isFinite(mph) && mph > 0) {
      roadM += len;
      roadSpeedM += mph * len;
    }
    if (s.mtb || ((s.official || 0) & 4)) mtbM += len;
    if (isTaggedDismountSegment(s)) dismountM += len;
    if (flags & 4) freewayM += len;
    else if (flags & 128) limitedAccessM += len;
    else if (isHighwaySegment(s)) highwayM += len;
  }
  return {
    levels, categoryM, highwayM, freewayM, limitedAccessM, bikeNetworkM, mtbM, dismountM,
    unpavedM, inclineOver5M,
    avgRoadSpeedMph: roadM > 0 ? Math.round(roadSpeedM / roadM) : null,
  };
}

function clearStoredRouteDetails() {
  try { localStorage.removeItem(ROUTE_DETAILS_KEY); } catch (e) { /* nonfatal */ }
}
function optimizationDescription(optimization) {
  if (!optimization) return '';
  const method = optimizationMethodDescription(optimization);
  const discovery = optimization.discoveryMaxSpeed
    ? ` Found with a ${optimization.discoveryMaxSpeed} mph no-shoulder search; map colors use your settings.`
    : '';
  const matching = optimization.fullyMatchingRules
    ? ' Every segment matches your safety rules.' : '';
  return `${optimization.reason ? `${optimization.reason} ` : ''}${method}${discovery}${matching}`;
}
function optimizationMethodDescription(optimization) {
  const base = optimization.mode === 'direct'
    ? 'Prioritizes a quicker trip.'
    : optimization.mode === 'low'
      ? 'Strongly avoids roads that fail your rules.'
      : 'Balances travel time against roads that fail your rules.';
  const preferences = [];
  if (optimization.prefDesignated) preferences.push('bike routes & trails');
  if (optimization.prefResidential) preferences.push('residential streets');
  return preferences.length ? `${base} Prefers ${preferences.join(' and ')}.` : base;
}
function routeDetailsOptimizationDescription(optimization) {
  if (!optimization) return '';
  const discovery = optimization.discoveryMaxSpeed
    ? ` Found using a ${optimization.discoveryMaxSpeed} mph no-shoulder search; safety results still use your settings.`
    : '';
  return `${optimizationMethodDescription(optimization)}${discovery}`;
}
// Downsampled elevation profile for the Route Details summary and expanded
// chart — enough points to draw crisply without bloating localStorage.
function compactRouteProfile(m) {
  const profile = m.profile || [];
  if (profile.length < 2) return null;
  const stride = Math.max(1, Math.ceil(profile.length / 1200));
  const out = [];
  for (let i = 0; i < profile.length; i += stride) {
    out.push([Math.round(profile[i][0]), Math.round(profile[i][1])]);
  }
  const last = profile[profile.length - 1];
  if (out[out.length - 1][0] !== Math.round(last[0])) {
    out.push([Math.round(last[0]), Math.round(last[1])]);
  }
  return out;
}

// Route Details also gets a lightweight map preview. Keep enough of the route
// shape to be recognizable without copying the full routing geometry into
// localStorage for every option.
function compactRouteCoords(m, includeIndices = false) {
  const coords = Array.isArray(m?.coords) ? m.coords : [];
  if (coords.length < 2) return null;
  const stride = Math.max(1, Math.ceil(coords.length / 600));
  const out = [], indices = [];
  const addPoint = (point, index) => {
    const lng = Number(point?.[0]), lat = Number(point?.[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    out.push([+lng.toFixed(6), +lat.toFixed(6)]);
    indices.push(index);
  };
  for (let i = 0; i < coords.length; i += stride) {
    addPoint(coords[i], i);
  }
  const last = coords[coords.length - 1];
  const lng = Number(last?.[0]), lat = Number(last?.[1]);
  if (Number.isFinite(lng) && Number.isFinite(lat)
      && (!out.length || out[out.length - 1][0] !== +lng.toFixed(6) || out[out.length - 1][1] !== +lat.toFixed(6))) {
    addPoint(last, coords.length - 1);
  }
  if (out.length < 2) return null;
  return includeIndices ? { coords: out, indices } : out;
}

function routeDetailsOptionTabs(selected) {
  if (turnNav.active || !Array.isArray(routing.options)) return [];
  const sharedInPlay = routing.options.some((option) => option?.asShared);
  return routing.options.map((option, index) => {
    if (!option?.ok) return null;
    const label = option.asShared ? 'Shared'
      : sharedInPlay ? String.fromCharCode(65 + index)
        : /^Route ([A-Z])$/.exec(option.optimization?.label || '')?.[1]
          || `Route ${index + 1}`;
    return { index, label, selected: option === selected };
  }).filter(Boolean);
}

let _storeDetailsTimer = null;
let _storeDetailsOption = null;
function scheduleStoreRouteDetails(option) {
  _storeDetailsOption = option;
  clearTimeout(_storeDetailsTimer);
  _storeDetailsTimer = setTimeout(flushStoreRouteDetails, 400);
}
function flushStoreRouteDetails() {
  clearTimeout(_storeDetailsTimer);
  _storeDetailsTimer = null;
  const option = _storeDetailsOption;
  _storeDetailsOption = null;
  if (option) storeRouteDetails(option);
}

function storeRouteDetails(m) {
  if (!m || !m.ok) return;
  try {
    const routeCoords = Array.isArray(m.coords) ? m.coords : [];
    const routePreview = compactRouteCoords(m, true);
    const directions = buildTurnInstructions(m).instructions
      .filter((instruction) => Number.isInteger(instruction.segmentIndex))
      .map((instruction) => ({
        segmentIndex: instruction.segmentIndex,
        text: instruction.text,
      }));
    // Route Details needs a real on-road point for its Google Maps and Street
    // View actions, but not the complete (potentially large) route geometry.
    const locationAt = (index) => {
      const point = routeCoords[Math.trunc(Number(index))];
      if (!Array.isArray(point) || point.length < 2) return null;
      const lng = Number(point[0]), lat = Number(point[1]);
      return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
    };
    localStorage.setItem(ROUTE_DETAILS_KEY, JSON.stringify({
      savedAt: Date.now(),
      profile: compactRouteProfile(m),
      routeCoords: routePreview?.coords || null,
      routeCoordIndices: routePreview?.indices || null,
      directions,
      routeOptions: routeDetailsOptionTabs(m),
      snapStartM: Number(m.snapStartM) || 0,
      snapEndM: Number(m.snapEndM) || 0,
      legs: (m.legs || []).map((l) => ({
        distM: Number(l.distM) || 0, timeS: Number(l.timeS) || 0, failM: Number(l.failM) || 0,
      })),
      mode: routing.mode,
      optimization: m.optimization ? {
        ...m.optimization,
        description: routeDetailsOptimizationDescription(m.optimization),
      } : null,
      rules: { ...rules },
      summary: {
        distM: m.distM, timeS: m.timeS, ascentM: m.ascentM, descentM: m.descentM,
        avgUphillPct: m.avgUphillPct || 0, maxGradePct: m.maxGradePct || 0,
        failM: m.failM, desigM: m.desigM, facilityM: m.facilityM, ferryM: m.ferryM,
        mtbM: m.mtbM || 0, dismountM: m.dismountM || 0, hazardM: m.hazardM || 0,
      },
      // Keep the detailed report compact, but retain every fact the shared
      // safety model needs so a concern card explains the same verdict the
      // router produced.
      segs: (m.segs || []).map((s) => ({
        name: s.name || '', mph: s.mph, sh: s.sh, flags: s.flags || 0,
        facility: s.facility || 0, official: s.official || 0, mtb: !!s.mtb,
        dismount: isDismountSegment(s),
        surface: Number.isInteger(s.surface) ? s.surface : 0,
        roadClass: s.roadClass || 0, lanes: Number(s.lanes) || 0,
        measures: s.measures || null, c0: s.c0, c1: s.c1,
        locationStart: locationAt(s.c0), locationEnd: locationAt(s.c1),
        crossing: s.crossing ? 1 : 0,
        hazard: s.hazard || 0,
        hazardLenM: s.hazardLenM || 0, hazC0: s.hazC0, hazC1: s.hazC1,
        hazardLocationStart: locationAt(s.hazC0), hazardLocationEnd: locationAt(s.hazC1),
        gradePct: s.gradePct || 0, timeS: Number(s.timeS) || 0,
        lts: Number(s.lts) || 0, cautionCause: routeSegmentCautionCause(s),
        level: s.level || fallbackRouteLevel(s), lenM: Number(s.lenM) || 0,
        displayCategory: routeSegmentDisplayCategory(s),
      })),
    }));
  } catch (e) { /* storage unavailable — the map still works normally */ }
}

/* --------------------------------------------------- turn navigation */
// This is deliberately a foreground navigation mode. It uses the browser's
// GPS, speech synthesis, and Screen Wake Lock API while the app is visible.
// A native iOS wrapper is still required for reliable background navigation.
// Set by buildRulesPanel; lets navigation force the Turn by Turn pane.
let settingsPaneSelect = null;
// Route Details can open over either the route chooser or active navigation.
// Restore the mobile panel to its prior state when a detail item returns to
// the map instead of assuming every Details launch came from the chooser.
let routeDetailsPanelWasOpen = false;

const turnNav = {
  active: false,
  watchId: null,
  nativeTracking: false,
  wakeLock: null,
  marker: null,
  route: null,
  plannedRoute: null,
  connectorRoute: null,
  followingConnector: false,
  // Progress on the planned route remains independent from a temporary
  // connector. This preserves the ridden portion while routing back.
  plannedRouteM: 0,
  plannedNearestSegment: 0,
  plannedNearestPoint: null,
  locationReady: false,
  screenMaySleep: false,
  joinDecision: 'pending',
  joinFix: null,
  connectorRequestId: null,
  connectorPurpose: 'start',
  newRouteRequestId: null,
  newRouteStart: null,
  newRouteVias: null,
  next: 0,
  nearest: 0,
  nearestSegment: 0,
  nearestPoint: null,
  routeM: 0,
  message: '',
  offRoute: false,
  offRouteInfo: null,        // { distM, dir, street } toward the nearest route point
  offRouteSpokenAt: 0,
  offRouteApproachSpoken: false,
  offRouteApproachText: '',
  offRouteSince: 0,
  offRouteCandidateAt: 0,
  offRouteCandidateFixes: 0,
  autoRecoveryAttempted: false,
  prevFix: null,             // previous GPS fix, for the rider's own heading
  lastPosition: null,
  arrived: false,
  destinationWasNear: false,
  lastDestinationM: Infinity,
  destinationAwayFixes: 0,
  initialCameraAt: 0,
  lastCameraAt: 0,
  cameraFollow: true,
  followResumeTimer: null,
};

function navDistanceM(a, b) {
  const rad = Math.PI / 180;
  const p1 = a[1] * rad, p2 = b[1] * rad;
  const dp = (b[1] - a[1]) * rad, dl = (b[0] - a[0]) * rad;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function navBearing(a, b) {
  const rad = Math.PI / 180;
  const p1 = a[1] * rad, p2 = b[1] * rad, dl = (b[0] - a[0]) * rad;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

function navDelta(inBearing, outBearing) {
  return ((outBearing - inBearing + 540) % 360) - 180;
}

function navRoadName(name) {
  const value = String(name || '').trim();
  return value && !/^unnamed|^ferry terminal connector$/i.test(value) ? value : '';
}

const COMPASS_WORDS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
function compassWord(bearing) {
  return COMPASS_WORDS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];
}

function navTurnText(delta, road, heading, staying) {
  const abs = Math.abs(delta);
  // "onto X" when joining a new road; "to stay on X" when the same road bends.
  const onto = road ? `${staying ? ' to stay on' : ' onto'} ${road}` : '';
  const toward = heading ? `, heading ${heading}` : '';
  if (abs >= 150) return `Make a U-turn${onto}${toward}`;
  if (abs >= 55) return `Turn ${delta > 0 ? 'right' : 'left'}${onto}${toward}`;
  if (abs >= 20) return `Bear ${delta > 0 ? 'right' : 'left'}${onto}${toward}`;
  return road ? `Continue ${staying ? 'on' : 'onto'} ${road}${toward}` : `Continue${toward}`;
}

function navDistanceText(m) {
  if (m < 160.934) return `${Math.max(25, Math.round(m / 25) * 25)} feet`;
  return `${(m / 1609.34).toFixed(m < 1609.34 ? 1 : 1)} miles`;
}

// Index of the route point at (or just past) a cumulative distance.
function coordIndexAtDistance(cumulative, m) {
  let lo = 0, hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] < m) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Bearings for turn detection are measured over ~20 m of travel, not two
// raw geometry points: inside a tiny traffic circle the point-to-point
// bearings swing wildly and produce "turn left" for straight-through.
const TURN_BEARING_SPAN_M = 20;
// Window for confirming that a maneuver is a real change of course rather than
// path jitter, and the smallest sustained change worth speaking.
const SUSTAINED_TURN_SPAN_M = 40;
const SUSTAINED_TURN_MIN_DEG = 25;
// A second maneuver naming the road just announced is a repeat unless the rider
// has travelled a real distance since, or it is a hard turn they could miss.
const SAME_ROAD_REPEAT_M = 300;
const HARD_TURN_DEG = 80;
// Interpolated position at a distance along the polyline. Snapping to the
// nearest vertex (the old approach) collapsed short edges: a turn's "incoming"
// window could land entirely on the post-turn segment, reporting a 0° delta and
// hiding a real turn. Interpolation measures the true direction over the window.
function pointAtDistanceAlong(coords, cumulative, d) {
  const lastIdx = coords.length - 1;
  if (!(d > 0)) return coords[0];
  if (d >= cumulative[lastIdx]) return coords[lastIdx];
  let i = 0;
  while (i + 1 < cumulative.length && cumulative[i + 1] <= d) i++;
  const segLen = cumulative[i + 1] - cumulative[i];
  const f = segLen > 0 ? (d - cumulative[i]) / segLen : 0;
  const a = coords[i], b = coords[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

function routeBearingOver(coords, cumulative, fromM, toM) {
  const lo = Math.max(0, Math.min(fromM, toM));
  const hi = Math.max(fromM, toM);
  return navBearing(pointAtDistanceAlong(coords, cumulative, lo),
    pointAtDistanceAlong(coords, cumulative, hi));
}

function navPathLike(seg) {
  return !!((Number(seg?.flags) || 0) & 8) || Number(seg?.facility) === 5;
}

// Resolve the route the rider actually enters after a maneuver, beyond tiny
// intersection stubs and trail-exit connectors. This is deliberately based on
// the outbound route, never the inbound name: otherwise a Burke-Gilman exit
// can be announced as "turn onto Burke-Gilman" even as the rider enters a road.
function navDestinationSegment(segs, currentIndex) {
  const current = segs[currentIndex];
  const incomingName = navRoadName(current?.name).toLowerCase();
  const leavingPath = navPathLike(current);
  let traveledM = 0;
  let fallback = null;
  for (let i = currentIndex + 1; i < segs.length && traveledM <= 120; i++) {
    const seg = segs[i];
    const name = navRoadName(seg?.name);
    const different = name && name.toLowerCase() !== incomingName;
    if (!fallback && name) fallback = { index: i, seg, name };
    if (leavingPath && !navPathLike(seg)) {
      return { index: i, seg, name: name || 'the road' };
    }
    if (different && !leavingPath) return { index: i, seg, name };
    // On ordinary streets, the immediate genuinely named outbound edge is the
    // destination. Continue looking only through an unnamed/very short stub.
    if (!leavingPath && i === currentIndex + 1 && name && (Number(seg.lenM) || 0) > 35) {
      return { index: i, seg, name };
    }
    traveledM += Number(seg?.lenM) || 0;
  }
  const immediate = segs[currentIndex + 1];
  return fallback || (immediate
    ? { index: currentIndex + 1, seg: immediate, name: navRoadName(immediate.name) }
    : null);
}

// The named road the rider is actually travelling as they reach a maneuver,
// looking back past unnamed stubs. A traffic circle (or a short intersection
// connector) splits a through road into "<road> → <unnamed circle> → <road>";
// read literally, the exit edge's origin is the blank circle, so continuing
// straight out the far side gets mis-announced as "onto <the same road>". This
// walks back to the last real name so that case is recognized as staying on it.
function navOriginName(segs, currentIndex) {
  let traveledM = 0;
  for (let i = currentIndex; i >= 0 && traveledM <= 120; i--) {
    const name = navRoadName(segs[i]?.name);
    if (name) return name;
    traveledM += Number(segs[i]?.lenM) || 0;
  }
  return '';
}

/* ------------------------------------------------------- traffic circles
 * A neighbourhood traffic circle is SMALLER than the 20 m the bearing sampler
 * looks across, and that single fact breaks guidance at both ends of it.
 *
 * Riding east into the circle at N 104th St and Fremont Ave N, a rider leaving
 * north is making a plain left turn. But US circles run counter-clockwise, so
 * the first thing they do is swing right; sampled 20 m ahead the geometry says
 * "bearing right", which disagrees with the road being joined and gets the
 * maneuver dropped by the guard below. Sampled 20 m BACK from the exit, the
 * chord runs straight across the island and says "no turn at all". Between
 * them the left turn onto Fremont disappeared -- reported from the road, with
 * nothing spoken and the banner already naming the turn after it.
 *
 * Announcing the circle edge by edge is not the answer either; that was the
 * earlier bug, and it produced a left and a right within a few metres of each
 * other while the rider was mid-circle and could act on neither.
 *
 * So a circle is ONE maneuver, and its direction is the only one that means
 * anything to a rider: from the road they arrive on to the road they leave on.
 * Nothing inside is ever announced.
 *
 * There is no roundabout flag in the graph -- build_graph.py reads
 * junction=roundabout for one-way only -- so this is recognised by shape: a run
 * of short unnamed edges whose length far exceeds the distance it covers. A
 * straight connector stub has a ratio near 1; going three quarters of the way
 * around an island has a ratio near 3.
 */
const CIRCLE_EDGE_MAX_M = 30;
const CIRCLE_RUN_MAX_M = 120;
const CIRCLE_RUN_MIN_M = 12;
const CIRCLE_CURL_RATIO = 1.4;

function findTrafficCircles(segs, coords) {
  const runs = [];
  const shortStub = (seg) => !navRoadName(seg?.name)
    && (Number(seg?.lenM) || 0) <= CIRCLE_EDGE_MAX_M;
  for (let i = 0; i < segs.length; i++) {
    if (!shortStub(segs[i])) continue;
    let end = i, total = 0;
    while (end < segs.length && shortStub(segs[end])
        && total + (Number(segs[end].lenM) || 0) <= CIRCLE_RUN_MAX_M) {
      total += Number(segs[end].lenM) || 0;
      end++;
    }
    end--;
    const entryIndex = Math.max(0, Math.min(coords.length - 1, segs[i].c0));
    const exitIndex = Math.max(0, Math.min(coords.length - 1, segs[end].c1));
    const across = navDistanceM(coords[entryIndex], coords[exitIndex]);
    if (total >= CIRCLE_RUN_MIN_M && total >= CIRCLE_CURL_RATIO * Math.max(across, 1)) {
      runs.push({ first: i, last: end, entryIndex, exitIndex });
    }
    i = end;
  }
  return runs;
}

// No "bear" here. A rider always physically turns out of a circle, and the
// angle they are being given is the one between two streets, not the one their
// wheel traces -- so it is a turn or it is straight through.
function navCircleText(delta, road, heading) {
  const onto = road ? ` onto ${road}` : '';
  const toward = heading ? `, heading ${heading}` : '';
  if (Math.abs(delta) >= 150) return `Go around the traffic circle${onto}${toward}`;
  if (Math.abs(delta) < 20) return `Continue through the traffic circle${onto}${toward}`;
  return `At the traffic circle, turn ${delta > 0 ? 'right' : 'left'}${onto}${toward}`;
}

function buildTurnInstructions(m) {
  const coords = m.coords || [];
  const cumulative = [0];
  for (let i = 1; i < coords.length; i++) cumulative.push(cumulative[i - 1] + navDistanceM(coords[i - 1], coords[i]));
  const instructions = [];
  let lastM = -Infinity;
  let lastRoad = '';
  let lastText = '';
  const segs = m.segs || [];
  const circles = findTrafficCircles(segs, coords);
  // Everything from entering a circle to leaving it belongs to the circle's own
  // maneuver, so the ordinary junction loop stays out of that span entirely.
  const insideCircle = (index) => circles.some((run) =>
    index >= run.entryIndex && index <= run.exitIndex);
  for (const run of circles) {
    const entryM = cumulative[run.entryIndex];
    const approach = routeBearingOver(coords, cumulative, entryM - TURN_BEARING_SPAN_M, entryM);
    const exit = navDestinationSegment(segs, run.last);
    const exitSeg = exit?.seg || segs[run.last + 1];
    const exitM = cumulative[Math.max(0, Math.min(coords.length - 1,
      exitSeg?.c0 ?? run.exitIndex))];
    const along = routeBearingOver(coords, cumulative, exitM, exitM + TURN_BEARING_SPAN_M);
    const road = navRoadName(exit?.name) || '';
    const delta = navDelta(approach, along);
    // Riding straight through on the street you were already on is not a
    // maneuver. Saying so at every circle would be exactly the flood of noise
    // that made per-edge announcements unusable.
    const arrivedOn = navOriginName(segs, Math.max(0, run.first - 1));
    if (Math.abs(delta) < 20 && road && arrivedOn
        && road.toLowerCase() === arrivedOn.toLowerCase()) continue;
    instructions.push({
      distanceM: entryM,
      coordIndex: run.entryIndex,
      segmentIndex: exit?.index ?? run.last + 1,
      text: navCircleText(delta, road, undefined),
      heading: compassWord(along),
    });
  }
  for (const seg of segs) {
    if (seg.hazard) {
      const at = Math.max(0, seg.hazC0 ?? seg.c0);
      instructions.push({ distanceM: cumulative[at] || 0, coordIndex: at,
        text: 'Caution: possible limited-visibility uphill curve ahead' });
    }
  }
  for (let i = 0; i + 1 < segs.length; i++) {
    const next = segs[i + 1];
    const at = Math.max(1, Math.min(coords.length - 2, next.c0));
    if (insideCircle(at)) continue;
    const junctionM = cumulative[at];
    const incoming = routeBearingOver(coords, cumulative, junctionM - TURN_BEARING_SPAN_M, junctionM);
    const outgoing = routeBearingOver(coords, cumulative, junctionM, junctionM + TURN_BEARING_SPAN_M);
    const delta = navDelta(incoming, outgoing);
    // Look back past unnamed circle/connector stubs so exiting a traffic circle
    // onto the same through road is recognized as staying on it, not a turn.
    const from = navOriginName(segs, i);
    const destination = navDestinationSegment(segs, i);
    const to = destination?.name || '';
    // Staying on the same road/path: a shared-use path (e.g. the Green Lake
    // Cycle Path) curves constantly, so calling out every gentle bend as "bear
    // onto <the path you're already on>" is noise and reads as a wrong turn.
    // Only announce a same-road bend when it's a genuine turn a rider could
    // miss (a fork), and phrase it as staying on, not turning onto.
    const sameRoad = !!to && !!from && to.toLowerCase() === from.toLowerCase();
    // Only announce an actual bend or turn. A road merely changing name while
    // the rider continues straight used to emit a "Continue onto X" prompt at
    // every name change; that flooded the voice guidance, interrupted itself,
    // and buried the real turns. A verified short road crossing is the
    // exception: it can look like a path choice even when the geometry is
    // straight, so explicitly tell the rider to continue across it. Likewise,
    // a straight entry to or exit from an off-street path is worth confirming.
    const pathTransition = navPathLike(segs[i]) !== navPathLike(next);
    const straightCrossing = !!next.crossing && Math.abs(delta) < 20;
    // "Continue onto X" is only meaningful when X starts here. navDestination-
    // Segment looks up to 120 m ahead, and on a straight transition that named
    // a road far past the junction: riding south on Fremont Avenue North, a
    // median cut-through 130 m short of the corner announced "Continue onto
    // North 104th Street", which then consumed the actual right turn onto it
    // through the same-road repeat window below. A turn may name a road it is
    // still approaching; going straight may not.
    const straightPathTransition = pathTransition && Math.abs(delta) < 20
      && (!destination || destination.index === i + 1);
    if (Math.abs(delta) < (sameRoad ? 50 : 20) && !straightCrossing && !straightPathTransition) continue;
    // A maneuver must never point the opposite way from the road it names. When
    // the named road is still a few edges ahead (a trail exit, a crossing, a
    // connector stub), the local bend can run one way while joining that road
    // needs the other: leaving the Interurban Trail, a 33 deg leftward jog was
    // announced as "Bear left onto North 155th Street" when the rider had to
    // turn right onto it. Staying silent here lets the real junction — where
    // the local bend and the named road agree — announce the true direction,
    // instead of this one consuming it through the repeat-suppression window
    // below. Destinations entered immediately measure the same bend twice, so
    // ordinary turns can never be suppressed by this.
    // A path is a chain of short graph edges whose geometry wanders by a few
    // metres. Sampled over 20 m that wander reads as a turn, so a rider riding
    // dead straight was told to "Bear right, heading south" while the route
    // carried on southeast. Where no new road is being named there is nothing
    // for the rider to identify the maneuver by, so it is only worth speaking
    // if their course actually changes: measure across the wiggle and drop it
    // when the route resumes the bearing it arrived on. Maneuvers that name a
    // road the rider is joining are never silenced by this.
    let effectiveDelta = delta;
    let sustainedBearing = null;
    if (!to || sameRoad) {
      const approach = routeBearingOver(
        coords, cumulative, junctionM - SUSTAINED_TURN_SPAN_M, junctionM);
      sustainedBearing = routeBearingOver(
        coords, cumulative, junctionM + SUSTAINED_TURN_SPAN_M, junctionM + 3 * SUSTAINED_TURN_SPAN_M);
      const sustained = navDelta(approach, sustainedBearing);
      if (Math.abs(sustained) < SUSTAINED_TURN_MIN_DEG) continue;
      // With no road name to identify the maneuver by, the short sample is not
      // just noisy but can be backwards: one junction sampled a 42 deg turn to
      // the right where the rider's course actually swings 38 deg left. Describe
      // the change they will really make.
      if (!to) effectiveDelta = sustained;
    }
    let alongDestination = null;
    if (destination) {
      const destinationM = cumulative[Math.min(coords.length - 1, destination.seg?.c0 ?? at)];
      alongDestination = routeBearingOver(
        coords, cumulative, destinationM, destinationM + TURN_BEARING_SPAN_M);
      const destinationDelta = navDelta(incoming, alongDestination);
      if (to && Math.abs(delta) >= 20 && Math.abs(destinationDelta) >= 20
          && Math.sign(delta) !== Math.sign(destinationDelta)) continue;
    }
    const distanceM = cumulative[at];
    // Do not speak a chain of tiny graph-edge transitions as separate turns --
    // but a maneuver onto a road the rider is not already on is not one of
    // those, and this rule was eating them. Turning right onto N 104th Street
    // 48 m before the traffic circle silenced the left onto Fremont Avenue
    // North entirely: the rider was told the first turn and then nothing.
    // Two real turns close together are two things a rider has to do.
    const joiningNewRoad = !!to && to !== lastRoad
      && (!from || to.toLowerCase() !== from.toLowerCase());
    if (distanceM - lastM < 70 && !joiningNewRoad) continue;
    const crossingRoad = navRoadName(next.name);
    const text = straightCrossing
      ? `Continue across ${crossingRoad || 'the road'}`
      : navTurnText(effectiveDelta, to, undefined, sameRoad);
    // One road, one maneuver. A winding street crosses the turn threshold at
    // several of its own graph edges, which produced runs like "Turn right onto
    // BPA Trail" twice 87 m apart, and left/right pairs on the same road within
    // a block. The rider was already told to ride this road; only a hard turn
    // they could genuinely miss is worth repeating before they leave it.
    if (to && to === lastRoad && distanceM - lastM < SAME_ROAD_REPEAT_M
        && Math.abs(delta) < HARD_TURN_DEG) continue;
    if (text === lastText && distanceM - lastM < SAME_ROAD_REPEAT_M) continue;
    instructions.push({
      distanceM,
      coordIndex: at,
      segmentIndex: destination?.index ?? i + 1,
      text,
      // Report the heading of the road being named, not the bearing through the
      // junction itself. Where the two differ the junction reading is the one
      // that misleads: it describes a connector the rider is passing through
      // rather than the street they are being told to ride.
      heading: compassWord(straightCrossing ? outgoing
        : !to && sustainedBearing != null ? sustainedBearing
        : alongDestination == null ? outgoing : alongDestination),
    });
    lastM = distanceM;
    lastRoad = to;
    lastText = text;
  }
  instructions.sort((a, b) => a.distanceM - b.distanceM);
  const segmentTimeS = segs.reduce((sum, seg) => sum + Math.max(0, Number(seg.timeS) || 0), 0);
  return {
    coords, cumulative, instructions, segs,
    safetyRuns: buildRouteSafetyRuns(segs, cumulative),
    totalM: cumulative[cumulative.length - 1] || 0,
    totalTimeS: segmentTimeS || Math.max(0, Number(m.timeS) || 0),
  };
}

/* ------------------------------------------- safety levels, spoken aloud
 * The five ways a stretch of route paints on the map, said out loud. A rider
 * hearing "use caution next 3.4 miles" is being told exactly what the amber
 * line already shows -- the point of the option is that they do not have to
 * look at the screen to learn it.
 */
// One short phrase per reason, and only ever one of them. A rider on a bike
// cannot hold a list: they need the single fact that changes what they do, and
// they need it before the road does. "Heavy traffic, no shoulder" is the most
// this says, and it says that only where the road is failing for a reason the
// speed alone does not already imply.
const SAFETY_REASON_SPEECH = Object.freeze({
  prohibited: 'Bikes not allowed',
  freeway: 'Freeway',
  'high-speed': 'High speed limit',
  'no-shoulder': 'No shoulder',
  'busy-no-shoulder': 'Heavy traffic, no shoulder',
  'wide-no-shoulder': 'Wide road, no shoulder',
  'heavy-traffic': 'Heavy traffic',
  'limited-access': 'Limited access road',
  'sidewalk-fallback': 'Sidewalk riding',
  dismount: 'Walk your bike',
  'mountain-bike': 'Mountain bike trail',
});

const SAFETY_RUN_HEAD = Object.freeze({
  // 'Road', not 'Normal road': the extra word says nothing a rider can act
  // on, and every syllable in a voice prompt competes with traffic.
  trail: 'Trail', bike: 'Bike lane', pass: 'Road',
  caution: 'Caution', fail: 'Warning',
});

// Near enough that saying how far off it is would be noise rather than help.
const SAFETY_RUN_HERE_M = 40;

/* A sentence a rider can act on has three parts, and only two of them fit:
 * WHAT is coming, WHEN it starts, and how LONG it lasts.
 *
 * It used to say what and how long -- "Trail for next 3.4 miles" -- which was
 * fine while the warning came 90 m out and the rider was practically there. It
 * is not fine now that it comes up to 400 m out: reported from the road, that
 * sentence arrived while the rider was on an overpass over the freeway, and it
 * read as a claim about the road under them rather than the one ahead.
 *
 * So when the stretch has not started, the sentence says when it does, and the
 * "next" is dropped because it is no longer describing what they are on. Once
 * they are in it -- joining a route mid-stretch -- the original wording is the
 * accurate one.
 *
 * The full stop after the alert word is deliberate: speech engines read it as
 * the pause a rider hears as "listen to the next bit", and some of them read a
 * dash aloud.
 */
function safetyRunSpeech(category, reason, lengthText, aheadText, hasLane = false) {
  // A road with a bike lane that draws blue -- because the agency rates it
  // worst-on-scale -- is still a road with a bike lane. Plain "Road" would be
  // false to the rider's eyes. The colour answers "would we recommend this";
  // the voice answers "what am I about to be riding on", and they are allowed
  // to differ.
  const head = category === 'pass' && hasLane ? 'Bike lane' : SAFETY_RUN_HEAD[category];
  if (!head) return null;
  const alert = category === 'caution' || category === 'fail';
  // An alert leads with the word that makes a rider listen and then names the
  // concern. A green stretch leads with what it is, and carries the concern as
  // an aside -- "bike lane, heavy traffic" is the whole point of trusting a
  // lane while still being told what it runs alongside.
  const what = alert
    ? `${head}. ${reason || (category === 'fail' ? 'Safety alert' : 'Ride with care')}`
    : `${head}${reason ? `, ${reason.toLowerCase()}` : ''}`;
  return aheadText ? `${what} in ${aheadText}, for ${lengthText}.`
    : `${what} for next ${lengthText}.`;
}

// Why this segment is amber or red, boiled down to one key. Null where there is
// nothing specific to say, which keeps the plain wording rather than inventing
// a reason.
function routeSegmentSafetyReason(s) {
  const scored = scoreRouteSeg(routeSegProps(s));
  const verdict = evaluateRoad(scored);
  if (verdict.level === 4) {
    if (verdict.rule === 'prohibited') return 'prohibited';
    if (verdict.rule === 'freeway') return 'freeway';
    if (verdict.rule === 'speed-cap') return 'high-speed';
    if (verdict.rule !== 'needs-space') return null;
    // It needs space and has none. Name the trigger only where it adds
    // something: a road fast enough to demand a shoulder is already understood
    // to be fast, but "25 mph, five lanes" is not obvious from "no shoulder".
    const reasons = SafetyModel.spaceReasons(factsOf(scored), rules);
    if (reasons.includes('speed')) return 'no-shoulder';
    if (reasons.includes('traffic') || reasons.includes('class')) return 'busy-no-shoulder';
    if (reasons.includes('lanes')) return 'wide-no-shoulder';
    return 'no-shoulder';
  }
  // Tagged dismounts only: a spoken "Walk your bike" at every synthesised
  // park-path connector would drown the ones a sign actually enforces.
  if (isTaggedDismountSegment(s)) return 'dismount';
  const cause = routeSegmentCautionCause(s);
  if (cause === 'high-stress') return 'heavy-traffic';
  if (SAFETY_REASON_SPEECH[cause]) return cause;
  // Green, and still worth a word. A trusted bike lane on a road the agency
  // rates worst-on-scale is not a caution -- the rider decided that -- but they
  // asked to be told, and `highStress` is reported at every level for exactly
  // this. Trusting a lane is a decision about the colour, not a reason to stop
  // saying what the road is.
  return verdict.highStress ? 'heavy-traffic' : null;
}

// The reason that covers the most of a stretch. A run can change its mind about
// why it is amber; the rider is told the one that dominates it.
function dominantRunReason(metresByReason) {
  let best = null, most = 0;
  for (const [reason, metres] of metresByReason) {
    if (metres > most) { best = reason; most = metres; }
  }
  return best;
}
// Short runs of ordinary road are not worth interrupting for; short runs of
// caution or rule failure are the whole reason a rider turned this on.
const SAFETY_RUN_MIN_M = 250;
// Far enough ahead to act on. Ninety metres was under fifteen seconds at riding
// speed, and a safety level almost always changes AT a junction -- you turn
// onto the trail, and the turn IS the change -- so the announcement was
// competing with the maneuver prompt for the same moment and losing. It landed
// after the road had already changed under the rider, which is no use to
// anyone. Scale it with how fast they are actually going.
const SAFETY_RUN_LEAD_S = 20;
const SAFETY_RUN_LEAD_MIN_M = 150;
const SAFETY_RUN_LEAD_MAX_M = 400;
function safetyRunLeadM() {
  const mph = Number(turnNav.speedMph);
  const metresPerSecond = Number.isFinite(mph) && mph > 1 ? mph * 0.44704 : 5;
  return Math.max(SAFETY_RUN_LEAD_MIN_M,
    Math.min(SAFETY_RUN_LEAD_MAX_M, metresPerSecond * SAFETY_RUN_LEAD_S));
}

// Consecutive segments that paint the same way, merged into runs, measured on
// the same cumulative clock navigation already uses for turns.
function buildRouteSafetyRuns(segs, cumulative) {
  const runs = [];
  for (const seg of segs || []) {
    const startM = cumulative[seg.c0], endM = cumulative[seg.c1];
    if (!Number.isFinite(startM) || !Number.isFinite(endM) || endM <= startM) continue;
    // A ferry has no riding safety level. It ends the run rather than carrying
    // "bike lane for the next four miles" across open water.
    const category = (seg.flags || 0) & 32 ? 'ferry' : routeSegmentDisplayCategory(seg);
    const last = runs[runs.length - 1];
    let run = last;
    if (last && last.category === category && Math.abs(last.endM - startM) < 1) {
      last.endM = endM;
    } else {
      run = { category, startM, endM, spoken: false, laneM: 0, reasons: new Map() };
      runs.push(run);
    }
    if (category === 'ferry') continue;
    if ((seg.facility || 0) >= 2 || (seg.flags || 0) & 8) run.laneM += endM - startM;
    // Synthesised walk links draw amber but stay out of the voice: the rider
    // chose that split deliberately, and a spoken "Caution" at every quiet
    // park connector is the noise the tagged-only rule exists to prevent.
    if (isDismountSegment(seg) && !isTaggedDismountSegment(seg)
        && (seg.level || 0) < 3 && !seg.mtb) {
      run.quietWalkM = (run.quietWalkM || 0) + (endM - startM);
    }
    const reason = routeSegmentSafetyReason(seg);
    if (reason) run.reasons.set(reason, (run.reasons.get(reason) || 0) + (endM - startM));
  }
  for (const run of runs) {
    run.reason = dominantRunReason(run.reasons);
    // Most of the stretch, not a token few metres of it.
    run.hasLane = run.laneM > (run.endM - run.startM) / 2;
    run.quietWalk = run.category === 'caution' && !run.reason
      && (run.quietWalkM || 0) > (run.endM - run.startM) / 2;
  }
  return runs;
}

// Returns true when it spoke, so the caller can hold the periodic status
// update rather than stacking two announcements on one fix. It no longer waits
// for a gap in the maneuver prompts: the speech queue keeps the two from
// cutting across each other, and waiting was what made this arrive late.
function maybeSpeakSafetyChange() {
  if (!navVoice.safetyLevels || turnNav.arrived) return false;
  const runs = turnNav.route?.safetyRuns;
  if (!runs || !runs.length) return false;
  const at = turnNav.routeM;
  // Anything already behind the rider is not news, however it got there.
  for (const run of runs) if (run.endM <= at) run.spoken = true;
  const run = runs.find((r) => !r.spoken);
  if (!run) return false;
  // How much of it is still ahead. Announced before the change these are the
  // same number; joining a route in the middle of a stretch, they are not, and
  // the honest one is what remains.
  const lengthM = run.endM - Math.max(at, run.startM);
  if (!SAFETY_RUN_HEAD[run.category] || run.quietWalk || (lengthM < SAFETY_RUN_MIN_M
      && run.category !== 'caution' && run.category !== 'fail')) {
    run.spoken = true;
    return false;
  }
  const aheadM = run.startM - at;
  if (aheadM > safetyRunLeadM()) return false;
  run.spoken = true;
  speakNavigation(safetyRunSpeech(run.category, SAFETY_REASON_SPEECH[run.reason],
    navDistanceText(lengthM),
    aheadM >= SAFETY_RUN_HERE_M ? navDistanceText(aheadM) : null, run.hasLane), 'safety');
  return true;
}

// Leaving the route no longer triggers rerouting. The rider gets the
// distance and compass direction back to the nearest route point, a concrete
// turn instruction as they close in on it, and normal guidance the moment
// they rejoin — anywhere along the route, ahead of or behind where they left.
const OFF_ROUTE_ENTER_M = 65;
const OFF_ROUTE_REJOIN_M = 40;
const OFF_ROUTE_APPROACH_M = 130;
const OFF_ROUTE_RESPEAK_MS = 30_000;
const OFF_ROUTE_GOOD_ACCURACY_M = 60;
const OFF_ROUTE_MAX_ACCURACY_M = 120;
const OFF_ROUTE_CANDIDATE_WINDOW_MS = 40_000;
const ROUTE_START_OFFER_M = 160.934; // 0.1 mile
const AUTO_OFF_ROUTE_DELAY_MS = 60_000;
let navigationConnectorRequestId = 0;
let navigationNewRouteRequestId = 0;

function clearOffRouteCandidate() {
  turnNav.offRouteCandidateAt = 0;
  turnNav.offRouteCandidateFixes = 0;
}

function recordOffRouteCandidate(fixAt, reportedAccuracyM) {
  const accuracyM = Number(reportedAccuracyM);
  // Truly unusable fixes neither trigger nor erase an otherwise consistent
  // candidate. Moderately coarse fixes still count, but need one extra sample.
  if (Number.isFinite(accuracyM) && accuracyM > OFF_ROUTE_MAX_ACCURACY_M) return false;
  const requiredFixes = Number.isFinite(accuracyM) && accuracyM > OFF_ROUTE_GOOD_ACCURACY_M ? 3 : 2;
  if (!turnNav.offRouteCandidateAt
      || fixAt < turnNav.offRouteCandidateAt
      || fixAt - turnNav.offRouteCandidateAt > OFF_ROUTE_CANDIDATE_WINDOW_MS) {
    turnNav.offRouteCandidateAt = fixAt;
    turnNav.offRouteCandidateFixes = 1;
  } else {
    turnNav.offRouteCandidateFixes += 1;
  }
  return turnNav.offRouteCandidateFixes >= requiredFixes;
}

function shouldOfferRouteStartConnector(startDistanceM, offRouteM) {
  // Distance from the original start alone is not enough: a rider already on
  // any later portion of the route should begin there without an interruption.
  return startDistanceM >= ROUTE_START_OFFER_M && offRouteM > OFF_ROUTE_REJOIN_M;
}

function navInstructionText(instruction) {
  return `${instruction.text}${navVoice.headings && instruction.heading
    ? `, heading ${instruction.heading}` : ''}`;
}

function routeRoadNameAt(index) {
  const segs = turnNav.route?.segs || [];
  let at = segs.findIndex((seg) => index >= seg.c0 && index < seg.c1);
  if (at < 0 && segs.length && index >= segs[segs.length - 1].c1) at = segs.length - 1;
  if (at < 0) return '';
  // Rejoin guidance describes the forward route. Look ahead through tiny
  // connectors first; only fall back to the containing segment when needed.
  const current = segs[at];
  const destination = navDestinationSegment(segs, Math.max(-1, at - 1));
  if (destination?.name) return destination.name;
  for (let i = at; i < Math.min(segs.length, at + 4); i++) {
    const name = navRoadName(segs[i]?.name);
    if (name) return name;
  }
  return navRoadName(current?.name);
}

// The route's direction of travel where the rider would rejoin it.
function routeForwardBearing(index) {
  const coords = turnNav.route.coords;
  const from = Math.min(index, coords.length - 2);
  const to = Math.min(from + 2, coords.length - 1);
  return navBearing(coords[from], coords[to]);
}

function offRouteDescription(nearest) {
  return {
    distM: nearest.offRouteM,
    dir: compassWord(navBearing(turnNav.lastPosition, nearest.point || turnNav.route.coords[nearest.index])),
    street: routeRoadNameAt(nearest.index),
    index: nearest.index,
    routeM: nearest.routeM,
  };
}

function offRouteSpeech(info) {
  return `Rejoin route ${navDistanceText(info.distM)} ${info.dir}${
    info.street ? ` on ${info.street}` : ''}.`;
}

function enterOffRoute(nearest) {
  if (!turnNav.offRouteSince) {
    turnNav.offRouteSince = Date.now();
    turnNav.autoRecoveryAttempted = false;
  }
  turnNav.offRoute = true;
  turnNav.offRouteApproachSpoken = false;
  turnNav.offRouteApproachText = '';
  turnNav.offRouteInfo = offRouteDescription(nearest);
  speakNavigation(offRouteSpeech(turnNav.offRouteInfo));
  turnNav.offRouteSpokenAt = Date.now();
}

function updateOffRouteGuidance(nearest, previousFix) {
  const info = offRouteDescription(nearest);
  turnNav.offRouteInfo = info;
  // Wandered away again after an approach announcement: allow a fresh one.
  if (turnNav.offRouteApproachSpoken && nearest.offRouteM > 250) {
    turnNav.offRouteApproachSpoken = false;
  }
  if (!turnNav.offRouteApproachSpoken && nearest.offRouteM <= OFF_ROUTE_APPROACH_M) {
    // Close to the route: one concrete instruction for joining it, using the
    // rider's own recent heading when we have one.
    const routeBearing = routeForwardBearing(nearest.index);
    const moved = previousFix
      && navDistanceM(previousFix.point, turnNav.lastPosition) >= 8;
    const routeHeading = navVoice.headings ? compassWord(routeBearing) : null;
    const text = moved
      ? navTurnText(navDelta(navBearing(previousFix.point, turnNav.lastPosition), routeBearing),
          info.street || 'the route', routeHeading)
      : `Ahead: rejoin ${info.street || 'the route'}${routeHeading ? `, heading ${routeHeading}` : ''}`;
    turnNav.offRouteApproachSpoken = true;
    turnNav.offRouteApproachText = text;
    speakNavigation(`${text}.`);
    turnNav.offRouteSpokenAt = Date.now();
  } else if (Date.now() - turnNav.offRouteSpokenAt >= OFF_ROUTE_RESPEAK_MS) {
    speakNavigation(offRouteSpeech(info));
    turnNav.offRouteSpokenAt = Date.now();
  }
}

function updateNavigationProgress() {
  const source = map.getSource('route-progress');
  if (!source) return;
  let coords = [];
  const route = turnNav.followingConnector ? turnNav.plannedRoute : turnNav.route;
  const nearestSegment = turnNav.followingConnector
    ? turnNav.plannedNearestSegment : turnNav.nearestSegment;
  const nearestPoint = turnNav.followingConnector
    ? turnNav.plannedNearestPoint : turnNav.nearestPoint;
  if (turnNav.active && route && nearestPoint) {
    const lastComplete = Math.max(0,
      Math.min(route.coords.length - 1, nearestSegment));
    coords = route.coords.slice(0, lastComplete + 1);
    const tail = coords[coords.length - 1];
    if (!tail || navDistanceM(tail, nearestPoint) > 0.25) coords.push(nearestPoint);
  }
  source.setData({ type: 'Feature', properties: {},
    geometry: { type: 'LineString', coordinates: coords.length >= 2 ? coords : [] } });
}

function rememberPlannedRouteProgress() {
  if (turnNav.followingConnector || turnNav.route !== turnNav.plannedRoute) return;
  turnNav.plannedRouteM = Math.max(0, Number(turnNav.routeM) || 0);
  turnNav.plannedNearestSegment = Math.max(0, Number(turnNav.nearestSegment) || 0);
  turnNav.plannedNearestPoint = Array.isArray(turnNav.nearestPoint)
    ? [...turnNav.nearestPoint] : null;
}

function rejoinRoute(nearest, previousFix, reachedText = 'Back on route') {
  turnNav.offRoute = false;
  turnNav.offRouteSince = 0;
  turnNav.autoRecoveryAttempted = false;
  turnNav.offRouteInfo = null;
  turnNav.offRouteApproachSpoken = false;
  turnNav.nearest = nearest.index;
  turnNav.nearestSegment = nearest.segmentIndex;
  turnNav.nearestPoint = nearest.point;
  turnNav.routeM = nearest.routeM;
  rememberPlannedRouteProgress();
  turnNav.arrived = false;
  // Re-aim guidance at the honestly-next maneuver — silently. Rejoining
  // behind the departure point re-arms the instructions in between.
  const instructions = turnNav.route.instructions;
  turnNav.next = 0;
  while (turnNav.next < instructions.length
      && instructions[turnNav.next].distanceM < turnNav.routeM - 35) {
    instructions[turnNav.next].approach = true;
    instructions[turnNav.next].now = true;
    turnNav.next++;
  }
  for (let i = turnNav.next; i < instructions.length; i++) {
    instructions[i].approach = false;
    instructions[i].now = false;
  }
  const road = routeRoadNameAt(nearest.index);
  const routeBearing = routeForwardBearing(nearest.index);
  const moved = previousFix
    && navDistanceM(previousFix.point, turnNav.lastPosition) >= 8;
  const heading = navVoice.headings ? compassWord(routeBearing) : null;
  const maneuver = moved
    ? navTurnText(navDelta(navBearing(previousFix.point, turnNav.lastPosition), routeBearing),
        road || 'the route', heading)
    : `Continue on ${road || 'the route'}${heading ? `, heading ${heading}` : ''}`;
  const alreadyAnnounced = turnNav.offRouteApproachText
    && maneuver.toLowerCase() === turnNav.offRouteApproachText.toLowerCase();
  turnNav.offRouteApproachText = '';
  if (reachedText !== 'Back on route') {
    speakNavigation(`${reachedText}. ${maneuver}.`);
  } else {
    speakNavigation(alreadyAnnounced
      ? `Back on route. Continue on ${road || 'the route'}.`
      : `${maneuver}. Back on route.`);
  }
}

function navigationBannerInfo() {
  if (!turnNav.active) return {
    headline: 'GPS voice guidance · keeps the screen awake when supported',
    meta: '',
    kicker: 'Turn-by-turn navigation',
  };
  const remainingRouteM = Math.max(0, (turnNav.route?.totalM || 0) - turnNav.routeM);
  const projectedS = remainingNavigationTimeS();
  const routeMeta = `${navDistanceText(Math.max(0, turnNav.routeM))} done · ${navDistanceText(remainingRouteM)} to go${
    projectedS >= 45 ? ` · ~${fmtDur(projectedS)}` : ''}`;
  if (turnNav.arrived) return { headline: 'You have arrived', meta: routeMeta, kicker: 'Destination reached' };
  if (turnNav.newRouteRequestId != null) return {
    headline: 'Finding a new route from your current location…',
    meta: 'Your current route stays active unless a replacement is found',
    kicker: 'Re-routing',
  };
  if (turnNav.joinDecision === 'offered') return {
    headline: 'Choose how to join the planned route',
    meta: 'Route to its start, or get directions toward the nearest point',
    kicker: 'Join route',
  };
  if (turnNav.joinDecision === 'loading') return {
    headline: turnNav.connectorPurpose === 'rejoin'
      ? 'Finding a route back to your current route…'
      : 'Finding a route to the planned start…',
    meta: 'Trying your safety rules and route preferences',
    kicker: 'Join route',
  };
  if (turnNav.offRoute) {
    const info = turnNav.offRouteInfo;
    return {
      headline: info
        ? `Off route — rejoin ${navDistanceText(info.distM)} ${info.dir}${info.street ? ` on ${info.street}` : ''}`
        : 'Off route',
      meta: 'Guidance resumes when you rejoin the route',
      kicker: 'Off route',
    };
  }
  const next = turnNav.route?.instructions[turnNav.next];
  if (turnNav.message) return {
    headline: turnNav.message,
    meta: !turnNav.locationReady
      ? 'Navigation begins after a usable GPS fix'
      : turnNav.followingConnector ? `${routeMeta} · Connector onto your route` : routeMeta,
    kicker: turnNav.followingConnector ? 'To your route' : 'Turn-by-turn navigation',
  };
  if (!next) return {
    headline: turnNav.followingConnector
      ? 'Continue to your route'
      : 'Continue to your destination',
    meta: routeMeta,
    kicker: turnNav.followingConnector ? 'To your route' : 'Turn-by-turn navigation',
  };
  const remaining = next.distanceM - turnNav.routeM;
  // A maneuver stays on the banner for 60 m after the rider reaches it, so that
  // a GPS fix arriving slightly late does not blank it mid-turn. Clamping the
  // distance to zero and printing it read "In 25 feet" -- navDistanceText's
  // floor -- so a turn the rider was already through still claimed to be a few
  // steps ahead. Photographed on the Interurban Trail: forty metres past the
  // junction, still promising the turn onto the street behind them.
  return {
    headline: remaining <= 5
      ? `Now · ${navInstructionText(next)}`
      : `In ${navDistanceText(remaining)} · ${navInstructionText(next)}`,
    meta: turnNav.followingConnector ? `${routeMeta} · Connector onto your route` : routeMeta,
    kicker: turnNav.followingConnector ? 'To your route' : 'Next maneuver',
  };
}

function navigationStatusText() {
  return navigationBannerInfo().headline;
}

function navigationElevationProgressM() {
  if (!turnNav.active || !turnNav.plannedRoute || !turnNav.locationReady) return null;
  const plannedM = turnNav.followingConnector ? turnNav.plannedRouteM : turnNav.routeM;
  const plannedTotalM = turnNav.plannedRoute.totalM;
  const profileTotalM = Number(routing.last?.distM) || 0;
  if (!(plannedTotalM > 0) || !(profileTotalM > 0)) return Math.max(0, plannedM);
  return Math.max(0, Math.min(profileTotalM, plannedM * profileTotalM / plannedTotalM));
}

function openRouteDetails(detailTab = null, concernId = null) {
  if (!routing.last?.ok) return;
  // Refresh the compact report before loading it. This lets an already-drawn
  // route gain its per-segment Google Maps and Street View locations as soon
  // as the app updates, without making the rider recalculate.
  storeRouteDetails(routing.last);
  const dialog = document.getElementById('routeDetailsDialog');
  const frame = document.getElementById('routeDetailsFrame');
  // While navigating there is only one active route, so drop the option label.
  const routeLabel = routing.last.optimization?.label || 'Route';
  const dialogTitle = turnNav.active ? 'Active Route Details' : `${routeLabel} Details`;
  const requestedTab = ['stats', 'concerns', 'steps'].includes(detailTab) ? `&tab=${detailTab}` : '';
  const requestedConcern = concernId === 'concern-unpaved' ? `&concern=${concernId}` : '';
  const detailsUrl = `route-details.html?embedded=1&t=${Date.now()}${requestedTab}${requestedConcern}`;
  if (!dialog || !frame || !dialog.showModal) {
    window.location.href = detailsUrl.replace('embedded=1&', '');
    return;
  }
  const title = document.getElementById('routeDetailsDialogTitle');
  if (title) title.textContent = dialogTitle;
  frame.title = dialogTitle;
  routeDetailsPanelWasOpen = mobileNavMedia.matches
    && document.body.classList.contains('panel-open');
  // Reload the embedded report so it always reflects the latest route data.
  // During navigation, hand over progress in the original elevation profile's
  // distance scale.
  let progress = '';
  const progressM = navigationElevationProgressM();
  if (Number.isFinite(progressM)) progress = `&navProgress=${Math.round(progressM)}`;
  frame.src = `${detailsUrl}${progress}`;
  if (!dialog.open) dialog.showModal();
}

function selectRouteDetailsOption(index, detailTab = null) {
  if (turnNav.active) return;
  const option = routing.options[Number(index)];
  if (!option?.ok || option === routing.last) return;
  // Keep the same shared-route safeguard as the map's route chooser.
  if (routing.sharedActive && !option.asShared) { openSharedSwitchDialog(); return; }
  activateRouteOption(option);
  // Keep the current Details tab open while its selected-route content reloads.
  // The map behind the dialog is already updated by activateRouteOption().
  openRouteDetails(detailTab);
}

const HELP_TOPIC_TITLES = {
  'getting-started': 'Getting started',
  routes: 'Routes',
  layers: 'Map layers & data',
  settings: 'Routing settings',
  'save-share': 'Save & share routes',
  technical: 'Technical details',
};

function initializeHelpCenter() {
  document.querySelectorAll('.help-panel[data-help-source]').forEach((panel) => {
    if (panel.childElementCount) return;
    const template = document.getElementById(panel.dataset.helpSource);
    if (!(template instanceof HTMLTemplateElement)) return;
    const sourceBody = template.content.querySelector('.full-help-body');
    const sourceElements = sourceBody
      ? [...sourceBody.children]
      : [...template.content.children].filter((child) => !child.matches('.dialog-head, .full-help-head'));
    panel.append(...sourceElements.map((child) => child.cloneNode(true)));
  });

  const tabs = [...document.querySelectorAll('[data-help-tab]')];
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => selectHelpTab(tab.dataset.helpTab));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = tabs.indexOf(tab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus();
      selectHelpTab(tabs[next].dataset.helpTab);
    });
  });
}

function selectHelpTab(topic) {
  const requested = HELP_TOPIC_TITLES[topic] ? topic : 'getting-started';
  if (requested === 'settings') buildCautionCauseHelp();
  const tabs = [...document.querySelectorAll('[data-help-tab]')];
  let selectedTab = null;
  tabs.forEach((tab) => {
    const selected = tab.dataset.helpTab === requested;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected) selectedTab = tab;
    const panel = document.getElementById(tab.getAttribute('aria-controls'));
    if (panel) panel.hidden = !selected;
  });
  document.getElementById('helpDialogTitle').textContent = HELP_TOPIC_TITLES[requested];
  const panels = document.getElementById('helpPanels');
  if (panels) panels.scrollTop = 0;
  requestAnimationFrame(() => selectedTab?.scrollIntoView({ block: 'nearest', inline: 'center' }));
}

function openHelp(topic = 'getting-started') {
  selectHelpTab(topic);
  const dialog = document.getElementById('helpDialog');
  if (dialog?.showModal && !dialog.open) dialog.showModal();
}

initializeHelpCenter();

function openRouteTips() {
  openHelp('routes');
}

window.addEventListener('message', (event) => {
  const frame = document.getElementById('routeDetailsFrame');
  if (event.origin !== window.location.origin || event.source !== frame?.contentWindow) return;
  if (event.data?.type === 'close-route-details') {
    document.getElementById('routeDetailsDialog')?.close();
    return;
  }
  if (event.data?.type === 'open-street-view') {
    const lat = Number(event.data.lat), lng = Number(event.data.lng);
    const heading = Number(event.data.heading);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      openStreetView(lat, lng, Number.isFinite(heading) ? heading : null);
    }
    return;
  }
  if (event.data?.type === 'select-route-details-option') {
    selectRouteDetailsOption(event.data.index, event.data.tab);
    return;
  }
  if (event.data?.type === 'highlight-route-step') {
    showRouteStepOnMap(event.data.startIndex, event.data.endIndex,
      event.data.coordStart, event.data.coordEnd);
    return;
  }
});

// Route Details can contain hundreds of road items plus its own MapLibre map.
// Release that embedded document after closing instead of retaining it behind
// the main map. Opening Details already reloads the latest selected route.
document.getElementById('routeDetailsDialog')?.addEventListener('close', () => {
  const frame = document.getElementById('routeDetailsFrame');
  if (frame) frame.src = 'about:blank';
});

function refreshNavigationUI() {
  const routeAvailable = !!(routing.last?.ok && routing.last.coords?.length > 1);
  const routeReady = routeAvailable && !routing.pendingRoute && !routing.routeRequestActive;
  document.body.classList.toggle('navigation-active', turnNav.active);
  const startButton = document.getElementById('navStartButton');
  if (startButton) {
    startButton.disabled = turnNav.active ? false : !routeReady;
    startButton.title = turnNav.active
      ? 'Stop navigation'
      : !routeAvailable ? 'Set a route to navigate'
      : !routeReady ? 'Wait for the updated route'
      : 'Start turn-by-turn navigation';
    startButton.setAttribute('aria-pressed', String(turnNav.active));
    startButton.classList.toggle('navigating', turnNav.active);
  }
  const startLabel = document.getElementById('navStartLabel');
  if (startLabel) startLabel.textContent = turnNav.active ? 'Stop' : 'Navigate';
  const startIcon = document.getElementById('navStartIcon');
  if (startIcon) startIcon.textContent = turnNav.active ? '■' : '▶';
  syncRouteOptionControls();
  const banner = document.getElementById('navBanner');
  const kicker = document.getElementById('navBannerKicker');
  const bannerText = document.getElementById('navBannerText');
  const bannerMeta = document.getElementById('navBannerMeta');
  const offRouteButton = document.getElementById('navOffRouteBtn');
  const info = navigationBannerInfo();
  const showOffRouteAction = !!(turnNav.active && turnNav.offRoute
    && turnNav.connectorRequestId == null && turnNav.newRouteRequestId == null);
  if (banner) banner.hidden = !turnNav.active;
  if (banner) banner.classList.toggle('off-route-action-visible', showOffRouteAction);
  if (offRouteButton) offRouteButton.hidden = !showOffRouteAction;
  if (kicker) kicker.textContent = info.kicker;
  if (bannerText) bannerText.textContent = info.headline;
  if (bannerMeta) bannerMeta.textContent = info.meta;
  updateNavCard();
}

// ---- Navigating Route panel (the Route tab, while turn-by-turn is active) ----
// The ridden portion is shaded green to echo the map's darkening of the route
// already covered; the remainder keeps the light-blue elevation fill.
const NAV_ELEV_DONE = 'rgba(0,121,92,0.30)';
const NAV_ELEV_AHEAD = 'rgba(44,123,182,0.18)';
const NAV_ELEV_LINE = '#2c7bb6';
const NAV_ELEV_POSITION = '#00795c';
let navCardStatsFor = null;

function drawNavElevation(canvas, profile, distM, progressM) {
  if (!canvas || !Array.isArray(profile) || profile.length < 2 || !(distM > 0)) return;
  const w = canvas.clientWidth || 0, h = canvas.clientHeight || 74;
  if (w < 2) return; // hidden panel: redraw once it becomes visible
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  let lo = Infinity, hi = -Infinity;
  for (const [, e] of profile) { if (e < lo) lo = e; if (e > hi) hi = e; }
  if (hi - lo < 30) { const mid = (hi + lo) / 2; lo = mid - 15; hi = mid + 15; }
  const padT = 12, padB = 13, padL = 4, padR = 4;
  const X = (d) => padL + (d / distM) * (w - padL - padR);
  const Y = (e) => padT + (1 - (e - lo) / (hi - lo)) * (h - padT - padB);
  const areaPath = () => {
    ctx.beginPath();
    ctx.moveTo(X(profile[0][0]), h - padB);
    for (const [d, e] of profile) ctx.lineTo(X(d), Y(e));
    ctx.lineTo(X(profile[profile.length - 1][0]), h - padB);
    ctx.closePath();
  };
  areaPath(); ctx.fillStyle = NAV_ELEV_AHEAD; ctx.fill();
  const hasPos = Number.isFinite(progressM) && progressM > 0 && progressM < distM;
  if (hasPos) {
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, X(progressM), h); ctx.clip();
    areaPath(); ctx.fillStyle = NAV_ELEV_DONE; ctx.fill();
    ctx.restore();
  }
  ctx.beginPath();
  ctx.moveTo(X(profile[0][0]), Y(profile[0][1]));
  for (const [d, e] of profile) ctx.lineTo(X(d), Y(e));
  ctx.strokeStyle = NAV_ELEV_LINE; ctx.lineWidth = 1.6; ctx.stroke();
  if (hasPos) {
    const px = X(progressM);
    ctx.beginPath(); ctx.moveTo(px, padT - 4); ctx.lineTo(px, h - padB);
    ctx.strokeStyle = NAV_ELEV_POSITION; ctx.lineWidth = 2.2; ctx.stroke();
    ctx.beginPath(); ctx.arc(px, padT - 4, 2.6, 0, Math.PI * 2);
    ctx.fillStyle = NAV_ELEV_POSITION; ctx.fill();
  }
  ctx.fillStyle = '#607482'; ctx.font = '700 9px system-ui';
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText(`${fmtFt(hi)} ft`, padL + 2, 1);
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${fmtFt(lo)} ft`, padL + 2, h - 1);
  ctx.textAlign = 'right';
  ctx.fillText(`${fmtMi(distM)} mi`, w - padR - 2, h - 1);
  ctx.textAlign = 'left';
}

// Tiny elevation sparkline for the route-selection card: the profile shape
// plus two glanceable labels — peak elevation (max footage) and total climb —
// with no axis clutter. Fits the footprint the climb text used, so the card
// height and the Details button stay put.
function drawMiniElevation(canvas, profile, distM, ascentM) {
  if (!canvas) return;
  const w = canvas.clientWidth || 0, h = canvas.clientHeight || 36;
  if (w < 2 || !Array.isArray(profile) || profile.length < 2 || !(distM > 0)) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  let lo = Infinity, hi = -Infinity;
  for (const [, e] of profile) { if (e < lo) lo = e; if (e > hi) hi = e; }
  if (hi - lo < 30) { const mid = (hi + lo) / 2; lo = mid - 15; hi = mid + 15; }
  const padT = 12, padB = 2, padL = 3, padR = 3;
  const X = (d) => padL + (d / distM) * (w - padL - padR);
  const Y = (e) => padT + (1 - (e - lo) / (hi - lo)) * (h - padT - padB);
  ctx.beginPath();
  ctx.moveTo(X(profile[0][0]), h - padB);
  for (const [d, e] of profile) ctx.lineTo(X(d), Y(e));
  ctx.lineTo(X(profile[profile.length - 1][0]), h - padB);
  ctx.closePath();
  ctx.fillStyle = NAV_ELEV_AHEAD; ctx.fill();
  ctx.beginPath();
  ctx.moveTo(X(profile[0][0]), Y(profile[0][1]));
  for (const [d, e] of profile) ctx.lineTo(X(d), Y(e));
  ctx.strokeStyle = NAV_ELEV_LINE; ctx.lineWidth = 1.4; ctx.stroke();
  ctx.font = '800 9.5px system-ui';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#607482';
  ctx.textAlign = 'left';
  ctx.fillText(`${fmtFt(hi)} ft`, padL + 1, 0);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#8a5a1a';
  ctx.fillText(`↗ ${fmtFt(ascentM)} ft`, w - padR - 1, 0);
  ctx.textAlign = 'left';
}

function drawRouteCardElevation() {
  const canvas = document.getElementById('rcElevCanvas');
  const m = routing.last;
  if (canvas && m && m.ok) {
    drawMiniElevation(canvas, compactRouteProfile(m), Number(m.distM) || 0, Number(m.ascentM) || 0);
  }
}

function navEscHTML(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// The route segment the rider is currently on, located by the live coordinate
// index (segments carry their coord range as [c0, c1)).
function navCurrentSegment() {
  const segs = turnNav.route?.segs || [];
  if (!segs.length) return null;
  const idx = turnNav.nearestSegment || 0;
  const seg = segs.find((s) => idx >= s.c0 && idx < s.c1);
  if (seg) return seg;
  return idx >= segs[segs.length - 1].c1 ? segs[segs.length - 1] : segs[0];
}

function navSegmentClassLabel(seg) {
  const flags = seg.flags || 0;
  if (flags & 32) return 'Ferry';
  if ((seg.facility || 0) >= 1) return FACILITY_NAME[seg.facility] || 'Bike facility';
  if (flags & 8) return 'Off-street path';
  return ROAD_CLASS_NAME[seg.roadClass] || 'Road';
}

function navShoulderText(seg) {
  if ((seg.flags || 0) & 8) return 'Shoulder: n/a'; // shoulder is meaningless on a path
  const sh = seg.sh;
  if (sh == null || sh < 0) return 'Shoulder: n/a';
  if (sh < 0.5) return 'Shoulder: none';
  return `Shoulder: ${+Number(sh).toFixed(1)} ft`;
}

function navSegInfoHTML() {
  if (!turnNav.locationReady) {
    return '<span class="nav-seg-label">Location</span><strong class="nav-seg-name">Waiting for GPS…</strong>';
  }
  const seg = navCurrentSegment();
  if (!seg) return '';
  const name = navRoadName(seg.name) || 'Unnamed road';
  const cls = navSegmentClassLabel(seg);
  const speed = seg.mph ? `${seg.mph} mph` : '';
  const line2 = [cls, speed].filter(Boolean).join(' · ');
  const line3 = [navShoulderText(seg), `${fmtDist(seg.lenM)} segment`].filter(Boolean).join(' · ');
  return `<span class="nav-seg-label">On now</span><strong class="nav-seg-name">${navEscHTML(name)}</strong><span class="nav-seg-line">${navEscHTML(line2)}</span><span class="nav-seg-line">${navEscHTML(line3)}</span>`;
}

function updateNavCard() {
  const card = document.getElementById('navCard');
  if (!card) return;
  if (!turnNav.active) { card.hidden = true; navCardStatsFor = null; return; }
  card.hidden = false;
  const m = routing.last;
  const progressRoute = turnNav.followingConnector ? turnNav.plannedRoute : turnNav.route;
  const totalM = progressRoute?.totalM || 0;
  const progressM = turnNav.followingConnector ? turnNav.plannedRouteM : turnNav.routeM;
  const doneM = turnNav.locationReady ? Math.max(0, Math.min(totalM, progressM)) : 0;
  const remainingM = Math.max(0, totalM - doneM);
  const pct = totalM > 0 ? Math.round(100 * doneM / totalM) : 0;
  const fill = document.getElementById('navProgressFill');
  if (fill) fill.style.width = `${pct}%`;
  const distEl = document.getElementById('navProgressDist');
  if (distEl) {
    distEl.textContent = turnNav.locationReady
      ? `${fmtMi(doneM)} mi done · ${fmtMi(remainingM)} mi left`
      : 'Waiting for a GPS fix…';
  }
  const remainingS = turnNav.followingConnector
    ? remainingNavigationTimeS() + remainingNavigationTimeS(turnNav.plannedRouteM, turnNav.plannedRoute)
    : remainingNavigationTimeS();
  const etaEl = document.getElementById('navProgressEta');
  if (etaEl) {
    if (!turnNav.locationReady) etaEl.textContent = '';
    else if (turnNav.arrived) etaEl.textContent = 'Arrived';
    else if (remainingS >= 30) {
      const eta = new Date(Date.now() + remainingS * 1000);
      etaEl.textContent = `ETA ${eta.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    } else etaEl.textContent = 'Almost there';
  }
  // Destination stays fixed for the route; refresh it only when the route changes.
  const destEl = document.getElementById('navDest');
  if (destEl && navCardStatsFor !== m) {
    const name = (routing.endName && routing.endName.trim()) || 'your destination';
    destEl.textContent = `To: ${name}`;
    navCardStatsFor = m;
  }
  const segEl = document.getElementById('navSegInfo');
  if (segEl) segEl.innerHTML = navSegInfoHTML();
  const canvas = document.getElementById('navElevationCanvas');
  if (canvas && m?.ok) {
    drawNavElevation(canvas, compactRouteProfile(m), Number(m.distM) || 0, navigationElevationProgressM());
  }
}

let lastSpokenText = '';
let lastSpokenAt = 0;

function nativeNavigationPlugin() {
  return window.Capacitor?.Plugins?.NativeNavigation || null;
}

let nativeNavigationListenersReady = null;
function nativePositionEvent(position) {
  return {
    coords: {
      longitude: Number(position?.longitude),
      latitude: Number(position?.latitude),
      accuracy: Number(position?.accuracy),
      altitude: position?.altitude == null ? null : Number(position.altitude),
      altitudeAccuracy: position?.altitudeAccuracy == null ? null : Number(position.altitudeAccuracy),
      heading: position?.heading == null ? null : Number(position.heading),
      speed: position?.speed == null ? null : Number(position.speed),
    },
    timestamp: Number(position?.timestamp) || Date.now(),
  };
}

function ensureNativeNavigationListeners() {
  const plugin = nativeNavigationPlugin();
  if (!plugin) return Promise.resolve(false);
  if (nativeNavigationListenersReady) return nativeNavigationListenersReady;
  nativeNavigationListenersReady = Promise.all([
    plugin.addListener('location', (position) => updateTurnNavigation(nativePositionEvent(position))),
    plugin.addListener('locationError', (error) => handleTurnNavigationLocationError(error)),
    // The native guide decides arrival for itself when the screen is locked --
    // this layer is suspended then and never sees the fixes that would let it
    // notice. Without this the ride ended natively and stayed live here.
    plugin.addListener('arrived', () => finishTurnNavigation()),
  ]).then(() => true).catch((error) => {
    nativeNavigationListenersReady = null;
    throw error;
  });
  return nativeNavigationListenersReady;
}

function nativeNavigationRoutePayload() {
  const route = turnNav.route;
  if (!route?.coords?.length || !route?.cumulative?.length) return {};
  // The native locked-screen guide needs the route shape, but not every graph
  // vertex. Samples about 25 m apart keep projection accurate while avoiding a
  // large Capacitor message on long-distance routes.
  const points = [];
  let lastSampleM = -Infinity;
  let segmentIndex = 0;
  route.coords.forEach((coord, index) => {
    const distanceM = Number(route.cumulative[index]) || 0;
    const endpoint = index === 0 || index === route.coords.length - 1;
    if (!endpoint && distanceM - lastSampleM < 25) return;
    while (segmentIndex + 1 < route.segs.length
        && index >= Number(route.segs[segmentIndex]?.c1)) segmentIndex++;
    points.push({
      longitude: Number(coord[0]),
      latitude: Number(coord[1]),
      distanceM,
      roadName: navRoadName(route.segs[segmentIndex]?.name),
    });
    lastSampleM = distanceM;
  });
  return {
    route: points,
    ...nativeVoiceStatusPayload(),
    routeTotalTimeS: Number(route.totalTimeS) || 0,
    instructions: route.instructions.map((instruction) => ({
      distanceM: Number(instruction.distanceM) || 0,
      text: navInstructionText(instruction),
    })),
    // The web layer speaks these itself, on the same GPS path as the turn
    // prompts. They are sent so the native guide can too, for the case the web
    // path cannot cover -- a locked screen. See docs/IOS-HANDOFF.md.
    safetyRuns: (route.safetyRuns || []).filter((run) => SAFETY_RUN_HEAD[run.category] && !run.quietWalk)
      .map((run) => ({
        startM: Number(run.startM) || 0,
        endM: Number(run.endM) || 0,
        text: safetyRunSpeech(run.category, SAFETY_REASON_SPEECH[run.reason],
          navDistanceText(run.endM - run.startM), null, run.hasLane),
      })),
  };
}

function nativeVoiceStatusPayload() {
  return {
    speakHeadings: navVoice.headings,
    statusUpdateMin: navVoice.updateMin,
    statusRoute: navVoice.statusRoute,
    statusSpeed: navVoice.statusSpeed,
    statusMiles: navVoice.statusMiles,
    statusEta: navVoice.statusEta,
    safetyLevels: navVoice.safetyLevels,
  };
}

function syncNativeVoiceStatusPreferences() {
  const plugin = nativeNavigationPlugin();
  if (!plugin || !turnNav.active || !turnNav.nativeTracking) return;
  plugin.updateVoiceSettings(nativeVoiceStatusPayload()).catch(() => {});
}

async function startNativeNavigationTracking() {
  const plugin = nativeNavigationPlugin();
  if (!plugin) return false;
  try {
    await ensureNativeNavigationListeners();
    const status = await plugin.startTracking(nativeNavigationRoutePayload());
    if (!turnNav.active) {
      await plugin.stopTracking().catch(() => {});
      return false;
    }
    turnNav.nativeTracking = true;
    if (status?.accuracy === 'reduced') {
      turnNav.message = 'Precise Location is off; navigation accuracy may be reduced';
      refreshNavigationUI();
    }
    return true;
  } catch (error) {
    turnNav.nativeTracking = false;
    handleTurnNavigationLocationError({
      code: /blocked|denied|permission/i.test(String(error?.message || error)) ? 1 : 2,
      message: String(error?.message || error || ''),
    });
    return false;
  }
}

async function getDevicePosition(options = {}) {
  const plugin = nativeNavigationPlugin();
  if (plugin) {
    const position = await plugin.getCurrentPosition();
    return nativePositionEvent(position);
  }
  if (!navigator.geolocation) throw new Error('No location access on this device');
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
    resolve,
    reject,
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000, ...options },
  ));
}

// Planning a route from "my location" must use a fix the device has actually
// just taken, not a cached one. iOS (and the native plugin's last-known cache)
// can return a fix from a previous place or session the instant it is asked,
// before the GPS has updated — which is how a start pin lands somewhere the
// rider no longer is. Force a new reading and reject anything stale or wildly
// imprecise so the caller can ask the rider to wait a moment.
const FRESH_FIX_MAX_AGE_MS = 45000;
const FRESH_FIX_MAX_ACCURACY_M = 250;

async function getFreshDevicePosition(options = {}) {
  // maximumAge:0 makes the web geolocation path take a new reading instead of
  // returning a cached one. The timestamp/accuracy checks below additionally
  // cover the native plugin, whose getCurrentPosition can hand back a last-known
  // fix regardless of the option.
  const position = await getDevicePosition({ maximumAge: 0, timeout: 20000, ...options });
  const fixAt = Number(position?.timestamp);
  if (Number.isFinite(fixAt) && Date.now() - fixAt > FRESH_FIX_MAX_AGE_MS) {
    const error = new Error('Location is still updating');
    error.code = 'STALE_FIX';
    throw error;
  }
  const accuracy = Number(position?.coords?.accuracy);
  if (Number.isFinite(accuracy) && accuracy > FRESH_FIX_MAX_ACCURACY_M) {
    const error = new Error('Location is still updating');
    error.code = 'IMPRECISE_FIX';
    throw error;
  }
  return position;
}

const NAVIGATION_SPEECH_RATE = 0.96;
let preferredNavigationVoice = null;

function navigationVoiceScore(voice, requestedLanguage) {
  const requested = String(requestedLanguage || 'en-US').toLowerCase();
  const requestedBase = requested.split('-')[0];
  const language = String(voice?.lang || '').toLowerCase();
  const name = `${voice?.name || ''} ${voice?.voiceURI || ''}`.toLowerCase();
  if (!language.startsWith(requestedBase)) return -Infinity;

  let score = language === requested ? 40 : 20;
  if (voice.localService !== false) score += 25;
  if (voice.default) score += 20;

  // Web Speech exposes names but no quality tier. On Apple devices these are
  // the commonly exposed natural system voices; explicit quality wording wins
  // if a browser includes it. Other platforms retain their own default voice.
  const appleDevice = /Macintosh|Mac OS X|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (appleDevice && /\b(ava|samantha|alex|allison|susan|tom|nathan|siri)\b/i.test(name)) score += 15;
  if (/\b(premium|enhanced|natural)\b/i.test(name)) score += 60;
  if (/\b(bad news|bahh|bells|boing|bubbles|cellos|jester|organ|superstar|trinoids|whisper|wobble|zarvox)\b/i.test(name)) {
    score -= 200;
  }
  return score;
}

function refreshPreferredNavigationVoice(language = navigator.language || 'en-US') {
  if (!('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  preferredNavigationVoice = voices.reduce((best, voice) =>
    navigationVoiceScore(voice, language) > navigationVoiceScore(best, language) ? voice : best, null);
  return preferredNavigationVoice;
}

function navigationSpeechUtterance(text, language = navigator.language || 'en-US') {
  const utterance = new SpeechSynthesisUtterance(text);
  const voice = refreshPreferredNavigationVoice(language);
  utterance.rate = NAVIGATION_SPEECH_RATE;
  utterance.lang = voice?.lang || language;
  if (voice) utterance.voice = voice;
  return utterance;
}

if ('speechSynthesis' in window) {
  refreshPreferredNavigationVoice();
  window.speechSynthesis.addEventListener?.('voiceschanged', () => {
    refreshPreferredNavigationVoice();
  });
}

/* ------------------------------------------------- one voice, one queue
 * Every prompt used to cut off whatever was mid-word. Both engines were told
 * to: `synth.cancel()` here, `stopSpeaking(at: .immediate)` in the iOS plugin.
 * It was called latest-wins, and on a ride it reads as the app talking over
 * itself -- a maneuver truncated by a safety warning, a safety warning
 * truncated by a status update, and the rider hearing neither of them whole.
 *
 * So nothing is handed to an engine while that engine is still speaking, and
 * neither engine's own interrupt is reached. The queue lives here because it
 * has to serve both, and because only this side knows which prompt matters
 * more: a maneuver outranks a safety change, which outranks a status update.
 * A higher-ranked prompt arriving mid-sentence is the one case where cutting in
 * is right, and it is the only case that still does.
 *
 * Pacing differs by engine and cannot be made uniform. The web engine reports
 * when an utterance ends. The iOS plugin's speak() resolves as soon as speech
 * has STARTED -- `call.resolve()` sits directly after `speakText` -- so there
 * the queue advances on an estimate, deliberately generous: a prompt a moment
 * late beats a prompt cut in half.
 */
const SPEECH_RANK = { turn: 3, safety: 2, status: 1 };
// A prompt that has waited this long is no longer about where the rider is.
const SPEECH_STALE_MS = 15000;
const speechQueue = [];
let speechActive = null;
let speechTimer = 0;

// Roughly 2.6 words a second, which is where both engines are set, plus a beat
// for the pause at the end.
function speechDurationMs(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1400, words * 380 + 400);
}

function stopSpeechEngine() {
  clearTimeout(speechTimer);
  speechTimer = 0;
  speechActive = null;
  const plugin = nativeNavigationPlugin();
  if (plugin?.stopSpeaking) { plugin.stopSpeaking().catch(() => {}); return; }
  try { window.speechSynthesis?.cancel(); } catch (e) { /* nothing to stop */ }
}

function clearSpeechQueue() {
  speechQueue.length = 0;
  stopSpeechEngine();
}

function speakInBrowser(text, finish) {
  if (!('speechSynthesis' in window)) {
    turnNav.message = 'Voice is unavailable in this browser';
    refreshNavigationUI();
    finish();
    return;
  }
  try {
    const synth = window.speechSynthesis;
    const utterance = navigationSpeechUtterance(text);
    utterance.onend = finish;
    utterance.onerror = finish;
    synth.speak(utterance);
    // resume() works around the mobile Safari/Chrome bug where the queue
    // silently pauses.
    synth.resume();
    // An engine that never reports the end must not wedge the queue for the
    // rest of the ride.
    speechTimer = setTimeout(finish, speechDurationMs(text) + 4000);
  } catch (e) { finish(); }
}

function speakThrough(text, done) {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(speechTimer);
    speechTimer = 0;
    done();
  };
  const plugin = nativeNavigationPlugin();
  if (plugin) {
    speechTimer = setTimeout(finish, speechDurationMs(text));
    plugin.speak({ text, language: navigator.language || 'en-US' }).catch(() => {
      clearTimeout(speechTimer);
      speechTimer = 0;
      speakInBrowser(text, finish);
    });
    return;
  }
  speakInBrowser(text, finish);
}

function pumpSpeech() {
  if (speechActive || !speechQueue.length) return;
  const now = Date.now();
  for (let i = speechQueue.length - 1; i >= 0; i--) {
    if (now - speechQueue[i].queuedAt > SPEECH_STALE_MS) speechQueue.splice(i, 1);
  }
  if (!speechQueue.length) return;
  // Highest rank first, and among equals the one that has waited longest --
  // which is queue order, so a plain scan for the best rank is enough.
  let pick = 0;
  for (let i = 1; i < speechQueue.length; i++) {
    if (speechQueue[i].rank > speechQueue[pick].rank) pick = i;
  }
  const item = speechQueue.splice(pick, 1)[0];
  speechActive = item;
  speakThrough(item.text, () => {
    speechActive = null;
    pumpSpeech();
  });
}

function speakNavigation(text, kind = 'turn') {
  if (!text) return;
  const now = Date.now();
  // Guard against re-speaking the same phrase on back-to-back GPS fixes (the
  // announcement window spans several fixes), which otherwise stutters and can
  // starve the next real maneuver.
  if (text === lastSpokenText && now - lastSpokenAt < 5000) return;
  lastSpokenText = text;
  lastSpokenAt = now;
  turnNav.lastVoiceAt = now;
  const rank = SPEECH_RANK[kind] || SPEECH_RANK.turn;
  speechQueue.push({ text, rank, queuedAt: now });
  // A maneuver does not wait behind a safety note or a status update: it is
  // about something the rider must do in the next few seconds. That is the
  // ONLY interrupt left. A safety change is content to wait its turn -- it is
  // raised far enough ahead to afford the second or two -- and cutting across a
  // status update to deliver it would be the same talking-over, one rung down.
  if (speechActive && rank === SPEECH_RANK.turn && speechActive.rank < SPEECH_RANK.turn) {
    stopSpeechEngine();
  }
  pumpSpeech();
}

async function requestNavigationWakeLock() {
  if (!turnNav.active || !navVoice.keepScreenAwake) return;
  if (!navigator.wakeLock || document.visibilityState !== 'visible') return;
  try {
    turnNav.wakeLock = await navigator.wakeLock.request('screen');
    turnNav.screenMaySleep = false;
    turnNav.wakeLock.addEventListener('release', () => {
      if (turnNav.active && document.visibilityState === 'visible') requestNavigationWakeLock();
    }, { once: true });
    if (turnNav.locationReady) turnNav.message = '';
  } catch (e) {
    turnNav.screenMaySleep = true;
    if (turnNav.locationReady) turnNav.message = 'Screen may sleep on this device';
  }
  refreshNavigationUI();
}

function releaseNavigationWakeLock() {
  const lock = turnNav.wakeLock;
  turnNav.wakeLock = null;
  if (lock) lock.release().catch(() => {});
}

// Project a GPS fix onto a route segment in a local meter-scale coordinate
// system. Navigation previously compared fixes only with route vertices. A
// long, straight rural edge can have vertices hundreds of meters apart, so a
// rider directly on that edge could be reported off-route and progress could
// jump from one endpoint to the other.
function projectNavigationSegment(point, a, b) {
  const metersPerDegree = 111_320;
  const cosLat = Math.cos(point[1] * Math.PI / 180);
  const ax = (a[0] - point[0]) * cosLat * metersPerDegree;
  const ay = (a[1] - point[1]) * metersPerDegree;
  const bx = (b[0] - point[0]) * cosLat * metersPerDegree;
  const by = (b[1] - point[1]) * metersPerDegree;
  const dx = bx - ax, dy = by - ay;
  const denom = dx * dx + dy * dy;
  const fraction = denom > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / denom)) : 0;
  const px = ax + fraction * dx, py = ay + fraction * dy;
  return {
    fraction,
    distanceM: Math.hypot(px, py),
    point: [a[0] + fraction * (b[0] - a[0]), a[1] + fraction * (b[1] - a[1])],
  };
}

function nearestNavigationPoint(lon, lat, fullRoute = false, routeOverride = null) {
  const route = routeOverride || turnNav.route;
  if (!route?.coords?.length) return null;
  const point = [lon, lat];
  if (route.coords.length === 1) {
    return { index: 0, segmentIndex: 0, point: route.coords[0],
      offRouteM: navDistanceM(point, route.coords[0]), routeM: 0 };
  }
  // While on route, a bounded forward/backward window prevents jumps where a
  // route crosses itself. Once off route, scan the complete line so the rider
  // can legitimately rejoin at any later or earlier point.
  const hasPosition = !routeOverride && !fullRoute && (turnNav.routeM > 0 || turnNav.nearest > 0);
  let lo = hasPosition ? Math.max(0, turnNav.nearest - 80) : 0;
  let hi = hasPosition ? Math.min(route.coords.length - 2, turnNav.nearest + 500) : route.coords.length - 2;
  let bestSegment = lo, bestProjection = null;
  for (let i = lo; i <= hi; i++) {
    const projection = projectNavigationSegment(point, route.coords[i], route.coords[i + 1]);
    if (!bestProjection || projection.distanceM < bestProjection.distanceM) {
      bestProjection = projection;
      bestSegment = i;
    }
  }
  // If the rider has jumped well beyond the local search window (for example,
  // restarting navigation farther along the route), do one complete recovery scan.
  if (hasPosition && bestProjection.distanceM > 250) {
    lo = 0; hi = route.coords.length - 2; bestProjection = null;
    for (let i = lo; i <= hi; i++) {
      const projection = projectNavigationSegment(point, route.coords[i], route.coords[i + 1]);
      if (!bestProjection || projection.distanceM < bestProjection.distanceM) {
        bestProjection = projection;
        bestSegment = i;
      }
    }
  }
  const startM = route.cumulative[bestSegment] || 0;
  const endM = route.cumulative[bestSegment + 1] ?? startM;
  return {
    index: bestProjection.fraction < 0.5 ? bestSegment : bestSegment + 1,
    segmentIndex: bestSegment,
    point: bestProjection.point,
    offRouteM: bestProjection.distanceM,
    routeM: startM + bestProjection.fraction * Math.max(0, endM - startM),
  };
}

function setRouteStartDialogBusy(busy, status = '') {
  if (busy) stopRouteStartCountdown(); // the rider chose an option; stop auto-dismiss
  const routeButton = document.getElementById('navRouteToStartBtn');
  const nearestButton = document.getElementById('navUseNearestBtn');
  const statusElement = document.getElementById('routeStartDialogStatus');
  if (routeButton) routeButton.disabled = busy;
  if (nearestButton) nearestButton.disabled = busy;
  if (statusElement) statusElement.textContent = status;
}

// If the rider ignores the "how to join" offer, default to letting them find
// their own way (distance/direction only, guidance resumes automatically) after
// a short countdown rather than blocking navigation on a modal.
const ROUTE_START_AUTO_DISMISS_S = 15;
let routeStartCountdownTimer = null;

function stopRouteStartCountdown() {
  if (routeStartCountdownTimer) { clearInterval(routeStartCountdownTimer); routeStartCountdownTimer = null; }
  const el = document.getElementById('routeStartCountdown');
  if (el) el.textContent = '';
}

function startRouteStartCountdown() {
  stopRouteStartCountdown();
  let remaining = ROUTE_START_AUTO_DISMISS_S;
  const el = document.getElementById('routeStartCountdown');
  if (el) el.textContent = `${remaining}s`;
  routeStartCountdownTimer = setInterval(() => {
    remaining -= 1;
    const node = document.getElementById('routeStartCountdown');
    if (node) node.textContent = `${Math.max(0, remaining)}s`;
    if (remaining <= 0) {
      stopRouteStartCountdown();
      useNearestPlannedRoute(); // the "I'll find my own way" default
    }
  }, 1000);
}

function showRouteStartOffer(startDistanceM) {
  const dialog = document.getElementById('routeStartDialog');
  const text = document.getElementById('routeStartDialogText');
  if (!dialog?.showModal || !text) return false;
  text.textContent = `You're ${navDistanceText(startDistanceM)} from your planned route. `
    + 'Choose how to get onto it.';
  setRouteStartDialogBusy(false);
  if (!dialog.open) dialog.showModal();
  // Default the selection to "I'll find my own way" so Enter (and the timeout)
  // pick the non-intrusive option.
  document.getElementById('navUseNearestBtn')?.focus();
  startRouteStartCountdown();
  return true;
}

function closeRouteStartDialog() {
  stopRouteStartCountdown();
  const dialog = document.getElementById('routeStartDialog');
  if (dialog?.open) dialog.close();
  setRouteStartDialogBusy(false);
}

function drawNavigationConnector(coords = []) {
  const source = map.getSource('route-connector');
  if (!source) return;
  source.setData({
    type: 'Feature', properties: {},
    geometry: { type: 'LineString', coordinates: coords.length >= 2 ? coords : [] },
  });
}

function useNearestPlannedRoute(reason = '', purpose = turnNav.connectorPurpose) {
  if (!turnNav.active || !turnNav.plannedRoute) return;
  closeRouteStartDialog();
  const offRouteDialog = document.getElementById('offRouteDialog');
  if (offRouteDialog?.open) offRouteDialog.close();
  turnNav.connectorRequestId = null;
  turnNav.joinDecision = 'nearest';
  turnNav.message = turnNav.screenMaySleep ? 'Screen may sleep on this device' : '';
  turnNav.route = turnNav.plannedRoute;
  turnNav.followingConnector = false;
  turnNav.connectorRoute = null;
  drawNavigationConnector([]);
  const point = turnNav.lastPosition;
  const nearest = point ? nearestNavigationPoint(point[0], point[1], true) : null;
  if (nearest?.offRouteM > OFF_ROUTE_REJOIN_M) enterOffRoute(nearest);
  if (reason) {
    const target = purpose === 'rejoin' ? 'current route' : 'planned start';
    setRouteStatus(`No route to the ${target} was found; using nearest-route guidance.`);
    showRouteActionToast(`Could not route to the ${target}`, {
      detail: `${reason} Guidance will point toward the nearest place on the planned route.`,
      duration: 8000,
    });
  }
  refreshNavigationUI();
}

function requestNavigationConnector(target, purpose = 'start', automatic = false) {
  if (!turnNav.active || !turnNav.lastPosition || !turnNav.plannedRoute
      || turnNav.connectorRequestId != null || turnNav.newRouteRequestId != null) return;
  if (!routing.worker) {
    useNearestPlannedRoute('The routing engine is unavailable.', purpose);
    return;
  }
  const id = ++navigationConnectorRequestId;
  turnNav.connectorRequestId = id;
  turnNav.connectorPurpose = purpose;
  turnNav.joinDecision = 'loading';
  turnNav.message = '';
  if (purpose === 'start') {
    setRouteStartDialogBusy(true, 'Finding a bike route to the planned start…');
  } else {
    closeRouteStartDialog();
    const offRouteDialog = document.getElementById('offRouteDialog');
    if (offRouteDialog?.open) offRouteDialog.close();
    showRouteActionToast(automatic ? 'Automatically routing back' : 'Finding a route back', {
      busy: true,
      detail: 'Trying your safety rules and route preferences…',
      duration: 0,
    });
  }
  refreshNavigationUI();
  routing.worker.postMessage({
    type: 'route-connector', id,
    points: [turnNav.lastPosition, target],
    blocks: routing.blocks?.map((block) => block.pt) || [],
    rules: { ...rules, requireSafe: false },
    prefDesignated: routing.prefDesig,
    prefResidential: routing.prefResidential,
    weights: { ...routingWeights },
  });
}

function requestRouteStartConnector() {
  if (turnNav.joinDecision !== 'offered' || !turnNav.plannedRoute) return;
  requestNavigationConnector(turnNav.plannedRoute.coords[0], 'start');
}

function requestRouteBackToCurrentRoute({ automatic = false } = {}) {
  if (!turnNav.active || !turnNav.lastPosition || !turnNav.plannedRoute) return;
  const nearest = nearestNavigationPoint(
    turnNav.lastPosition[0], turnNav.lastPosition[1], true, turnNav.plannedRoute);
  if (!nearest) {
    showRouteActionToast('Could not locate the current route', { duration: 5000 });
    return;
  }
  turnNav.autoRecoveryAttempted = true;
  requestNavigationConnector(nearest.point, 'rejoin', automatic);
}

function activateNavigationConnector(result) {
  if (!turnNav.active || result.id !== turnNav.connectorRequestId) return;
  if (!result.ok || !Array.isArray(result.coords) || result.coords.length < 2) {
    useNearestPlannedRoute(result.reason || 'No connected bike route was available.', turnNav.connectorPurpose);
    return;
  }
  const purpose = turnNav.connectorPurpose;
  closeRouteStartDialog();
  const offRouteDialog = document.getElementById('offRouteDialog');
  if (offRouteDialog?.open) offRouteDialog.close();
  turnNav.connectorRequestId = null;
  turnNav.connectorRoute = buildTurnInstructions(result);
  turnNav.route = turnNav.connectorRoute;
  turnNav.followingConnector = true;
  turnNav.joinDecision = 'connector';
  turnNav.next = 0;
  turnNav.nearest = 0;
  turnNav.nearestSegment = 0;
  turnNav.nearestPoint = null;
  turnNav.routeM = 0;
  turnNav.offRoute = false;
  turnNav.offRouteSince = 0;
  turnNav.offRouteInfo = null;
  turnNav.offRouteApproachSpoken = false;
  turnNav.offRouteApproachText = '';
  turnNav.destinationWasNear = false;
  turnNav.lastDestinationM = Infinity;
  turnNav.destinationAwayFixes = 0;
  turnNav.message = 'Follow the connector onto your route';
  drawNavigationConnector(result.coords);
  updateNavigationProgress();
  showRouteActionToast('Routing you onto your route', {
    detail: 'Follow the connector; your planned route stays unchanged.',
    duration: 5000,
  });
  speakNavigation('Follow the connector onto your route.');
  refreshNavigationUI();
}

function finishNavigationConnector(point, previousFix) {
  if (!turnNav.plannedRoute) return;
  const purpose = turnNav.connectorPurpose;
  turnNav.route = turnNav.plannedRoute;
  turnNav.connectorRoute = null;
  turnNav.followingConnector = false;
  turnNav.joinDecision = 'nearest';
  turnNav.joinFix = null;
  turnNav.nearest = 0;
  turnNav.nearestSegment = 0;
  turnNav.nearestPoint = null;
  turnNav.routeM = 0;
  turnNav.destinationWasNear = false;
  turnNav.lastDestinationM = Infinity;
  turnNav.destinationAwayFixes = 0;
  drawNavigationConnector([]);
  const nearest = nearestNavigationPoint(point[0], point[1], true);
  if (nearest && nearest.offRouteM <= OFF_ROUTE_REJOIN_M) {
    turnNav.offRoute = true;
    rejoinRoute(nearest, previousFix, 'On your route');
  } else if (nearest) {
    enterOffRoute(nearest);
  }
  showRouteActionToast('You are on your route', { duration: 3500 });
  updateNavigationProgress();
  refreshNavigationUI();
}

function openOffRouteDialog() {
  if (!turnNav.active || !turnNav.offRoute) return;
  const dialog = document.getElementById('offRouteDialog');
  const text = document.getElementById('offRouteDialogText');
  if (!dialog?.showModal || !text) return;
  const info = turnNav.offRouteInfo;
  text.textContent = info
    ? `The nearest point on your current route is ${navDistanceText(info.distM)} ${info.dir}${info.street ? ` on ${info.street}` : ''}. Choose how navigation should continue.`
    : 'Choose how navigation should continue.';
  if (!dialog.open) dialog.showModal();
  // Default to "I'll find my own way" — that is the state the rider is already
  // in when they open this from the off-route button.
  document.getElementById('navKeepRouteBtn')?.focus();
}

const PASSED_WAYPOINT_TOLERANCE_M = 25;
function remainingNavigationVias(route = routing.last,
  progressM = turnNav.offRouteInfo?.routeM ?? turnNav.routeM) {
  if (!routing.vias.length) return [];
  const legs = route?.legs;
  // If an older stored/shared result lacks leg boundaries, preserving every
  // waypoint is safer than silently deleting one or guessing it was passed.
  if (!Array.isArray(legs) || legs.length !== routing.vias.length + 1) return [...routing.vias];
  const routeTotalM = legs.reduce((sum, leg) => sum + (Number(leg.distM) || 0), 0);
  const navigationTotalM = Number(turnNav.plannedRoute?.totalM) || Number(route?.distM) || routeTotalM;
  const scaledProgressM = navigationTotalM > 0
    ? Math.max(0, Number(progressM) || 0) * routeTotalM / navigationTotalM : 0;
  let boundaryM = 0;
  return routing.vias.filter((via, index) => {
    boundaryM += Number(legs[index]?.distM) || 0;
    return scaledProgressM < boundaryM + PASSED_WAYPOINT_TOLERANCE_M;
  });
}

function requestNewRouteFromCurrentLocation({ automatic = false } = {}) {
  if (!turnNav.active || !turnNav.lastPosition || !routing.end
      || turnNav.newRouteRequestId != null || turnNav.connectorRequestId != null) return;
  const offRouteDialog = document.getElementById('offRouteDialog');
  if (offRouteDialog?.open) offRouteDialog.close();
  turnNav.autoRecoveryAttempted = true;
  if (!routing.worker) {
    showRouteActionToast('Could not calculate a new route', {
      detail: 'The routing engine is unavailable. Your current route is unchanged.', duration: 7000,
    });
    return;
  }
  const selected = routing.last?.optimization || {};
  const remainingVias = remainingNavigationVias();
  const id = ++navigationNewRouteRequestId;
  turnNav.newRouteRequestId = id;
  turnNav.newRouteStart = [...turnNav.lastPosition];
  turnNav.newRouteVias = remainingVias;
  showRouteActionToast(automatic ? 'Automatically creating a new route' : 'Finding a new route', {
    busy: true, detail: 'Using your current location, safety rules, and route preferences…', duration: 0,
  });
  refreshNavigationUI();
  routing.worker.postMessage({
    type: 'navigation-new-route', id,
    points: [turnNav.newRouteStart, ...remainingVias.map((via) => via.pt), routing.end],
    blocks: routing.blocks?.map((block) => block.pt) || [],
    rules: { ...rules }, mode: selected.mode || routing.mode,
    profileId: selected.profileId || routing.profileId,
    profileLabel: 'Route A',
    prefDesignated: routing.prefDesig,
    prefResidential: routing.prefResidential,
    weights: { ...routingWeights },
  });
}

function activateNewRouteFromCurrentLocation(result) {
  if (!turnNav.active || result.id !== turnNav.newRouteRequestId) return;
  const start = turnNav.newRouteStart;
  const remainingVias = turnNav.newRouteVias || [...routing.vias];
  turnNav.newRouteRequestId = null;
  turnNav.newRouteStart = null;
  turnNav.newRouteVias = null;
  const options = Array.isArray(result.options) ? result.options.filter((option) => option?.ok) : [];
  const selected = options.find((option) => option.optimization?.recommended)
    || options.find((option) => option.optimization?.label === 'Route A') || options[0];
  if (!result.ok || !selected || !Array.isArray(selected.coords) || selected.coords.length < 2) {
    showRouteActionToast('Could not calculate a new route', {
      detail: `${result.reason || 'No connected route was available.'} Your current route is unchanged.`,
      duration: 8000,
    });
    refreshNavigationUI();
    return;
  }
  routing.start = start;
  routing.startName = 'Current location';
  routing.startFromDevice = true;
  routing.arm = null;
  routing.startMarker?.setLngLat(start);
  for (const via of routing.vias) {
    if (!remainingVias.includes(via)) via.marker.remove();
  }
  routing.vias = remainingVias;
  // Keep the portfolio from the reroute. Navigation starts immediately on
  // its recommended option, but the rider can compare the other meaningful corridors after
  // stopping instead of being left with a single locked-in choice.
  routing.options = options;
  turnNav.followingConnector = false;
  turnNav.connectorRoute = null;
  turnNav.connectorRequestId = null;
  turnNav.connectorPurpose = 'start';
  turnNav.joinDecision = 'nearest';
  turnNav.offRoute = false;
  turnNav.offRouteInfo = null;
  turnNav.offRouteApproachSpoken = false;
  turnNav.offRouteApproachText = '';
  turnNav.offRouteSpokenAt = 0;
  turnNav.offRouteSince = 0;
  turnNav.autoRecoveryAttempted = false;
  turnNav.message = '';
  drawNavigationConnector([]);
  activateRouteOption(selected);
  turnNav.plannedRoute = buildTurnInstructions(selected);
  turnNav.route = turnNav.plannedRoute;
  turnNav.next = 0;
  turnNav.nearest = 0;
  turnNav.nearestSegment = 0;
  turnNav.nearestPoint = null;
  turnNav.routeM = 0;
  turnNav.destinationWasNear = false;
  turnNav.lastDestinationM = Infinity;
  turnNav.destinationAwayFixes = 0;
  const nearest = nearestNavigationPoint(start[0], start[1], true);
  if (nearest) {
    turnNav.nearest = nearest.index;
    turnNav.nearestSegment = nearest.segmentIndex;
    turnNav.nearestPoint = nearest.point;
    turnNav.routeM = nearest.routeM;
  }
  rememberPlannedRouteProgress();
  updateArmButtons();
  updateNavigationProgress();
  saveStateSoon();
  showRouteActionToast('New route ready', {
    detail: 'Navigation now starts from your current location.', duration: 5000,
  });
  speakNavigation('New route ready. Continue to your destination.');
  refreshNavigationUI();
}

function automaticOffRouteModeDue(now = Date.now()) {
  const mode = navVoice.offRouteMode;
  if (mode !== 'return' && mode !== 'dynamic') return null;
  return turnNav.active && turnNav.offRoute
    && !turnNav.followingConnector && !turnNav.autoRecoveryAttempted
    && turnNav.connectorRequestId == null && turnNav.newRouteRequestId == null
    && turnNav.offRouteSince
    && now - turnNav.offRouteSince >= AUTO_OFF_ROUTE_DELAY_MS ? mode : null;
}

function maybeAutomaticallyRecoverOffRoute() {
  const mode = automaticOffRouteModeDue();
  if (mode === 'return') requestRouteBackToCurrentRoute({ automatic: true });
  else if (mode === 'dynamic') requestNewRouteFromCurrentLocation({ automatic: true });
}

function updateNavigationCamera(point) {
  if (!turnNav.initialCameraAt) {
    const plannedStart = routing.last?.coords?.[0] || turnNav.route?.coords?.[0] || point;
    const bounds = new maplibregl.LngLatBounds(point, point).extend(plannedStart);
    const mobile = mobileNavMedia.matches;
    map.fitBounds(bounds, {
      padding: mobile
        ? { top: 92, right: 38, bottom: 180, left: 38 }
        : { top: 90, right: 75, bottom: 125, left: 75 },
      maxZoom: 15,
      duration: 800,
    });
    turnNav.initialCameraAt = Date.now();
    turnNav.lastCameraAt = turnNav.initialCameraAt;
    return;
  }
  // Suspended while the rider is panning to look around (auto-resumes 30 s
  // after they stop touching the map).
  if (!turnNav.cameraFollow) return;
  // Hold the contextual start view briefly, then keep the rider centered as
  // GPS fixes arrive. The marker remains live during this short hold.
  if (Date.now() - turnNav.initialCameraAt < 5000
      || Date.now() - turnNav.lastCameraAt < 900) return;
  turnNav.lastCameraAt = Date.now();
  map.easeTo({ center: point, duration: 450, essential: true });
}

// The rider may pan/zoom freely during navigation; auto-follow pauses while
// they interact and eases back onto the rider 30 s after they stop.
const CAMERA_RESUME_MS = 30000;
function scheduleNavigationFollowResume() {
  clearTimeout(turnNav.followResumeTimer);
  turnNav.followResumeTimer = setTimeout(() => {
    if (!turnNav.active) return;
    turnNav.cameraFollow = true;
    turnNav.lastCameraAt = 0;
    if (turnNav.lastPosition) map.easeTo({ center: turnNav.lastPosition, duration: 550, essential: true });
    refreshNavigationUI();
  }, CAMERA_RESUME_MS);
}
function recenterNavigationOnRider() {
  clearTimeout(turnNav.followResumeTimer);
  turnNav.cameraFollow = true;
  turnNav.lastCameraAt = 0;
  if (turnNav.lastPosition) map.easeTo({ center: turnNav.lastPosition, duration: 450, essential: true });
  refreshNavigationUI();
}

function remainingNavigationTimeS(routeM = turnNav.routeM, routeOverride = null) {
  const route = routeOverride || turnNav.route;
  if (!route) return 0;
  let remainingS = 0;
  let hasSegmentTimes = false;
  for (const seg of route.segs || []) {
    const segTimeS = Math.max(0, Number(seg.timeS) || 0);
    if (!segTimeS) continue;
    hasSegmentTimes = true;
    const startM = route.cumulative[Math.max(0, seg.c0)] || 0;
    const endM = route.cumulative[Math.min(route.cumulative.length - 1, seg.c1)] || startM;
    if (endM <= routeM) continue;
    const fraction = endM > startM
      ? (endM - Math.max(startM, routeM)) / (endM - startM) : 1;
    remainingS += segTimeS * Math.max(0, Math.min(1, fraction));
  }
  if (hasSegmentTimes) return remainingS;
  const remainingM = Math.max(0, route.totalM - routeM);
  return (Number(route.totalTimeS) || Number(routing.last?.timeS) || 0)
    * remainingM / Math.max(1, route.totalM);
}

function navigationHasArrived(point, nearest) {
  const route = turnNav.route;
  const destination = route?.coords?.[route.coords.length - 1];
  if (!destination) return false;
  const destinationM = navDistanceM(point, destination);
  const remainingM = Math.max(0, route.totalM - nearest.routeM);
  const nearRouteEnd = remainingM <= 160;
  if (nearRouteEnd && destinationM <= 60) turnNav.destinationWasNear = true;
  if (turnNav.destinationWasNear && nearRouteEnd
      && destinationM > 70 && destinationM > turnNav.lastDestinationM + 6) {
    turnNav.destinationAwayFixes++;
  } else if (destinationM <= turnNav.lastDestinationM + 3) {
    turnNav.destinationAwayFixes = 0;
  }
  turnNav.lastDestinationM = destinationM;
  return (nearRouteEnd && destinationM <= 45)
    || (turnNav.destinationWasNear && nearRouteEnd && turnNav.destinationAwayFixes >= 2);
}

function finishTurnNavigation() {
  if (!turnNav.active || turnNav.arrived) return;
  turnNav.arrived = true;
  stopTurnNavigation(false);
  turnNav.arrived = true;
  setRouteStatus('Destination reached — navigation ended');
  showRouteActionToast('Destination reached · Navigation ended', { duration: 6000 });
  speakNavigation('You have arrived at your destination. Navigation has ended.');
}

function updateTurnNavigation(pos) {
  if (!turnNav.active || !turnNav.route) return;
  const { longitude, latitude } = pos.coords;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    handleTurnNavigationLocationError({ code: 2 });
    return;
  }
  turnNav.locationReady = true;
  turnNav.lastPosition = [longitude, latitude];
  if (!turnNav.marker) {
    const element = document.createElement('div');
    element.className = 'nav-bike-marker';
    // Recumbent rider silhouette (no emoji exists for one).
    element.innerHTML = `<svg viewBox="0 0 34 22" width="26" height="17" aria-hidden="true">
      <g fill="none" stroke="#0b3d2e" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="8" cy="15.5" r="4.8"/>
        <circle cx="26.5" cy="15.5" r="4.8"/>
        <path d="M8 15.5 L15.5 13 L26.5 15.5"/>
        <path d="M11.5 6.5 L15.5 12.5 L23 9 M15.5 12.5 L24.5 13.5"/>
      </g>
      <circle cx="10" cy="4.5" r="3" fill="#0b3d2e"/>
      <circle cx="24" cy="10.5" r="1.6" fill="#0b3d2e"/>
    </svg>`;
    turnNav.marker = new maplibregl.Marker({ element })
      .setLngLat([longitude, latitude]).addTo(map);
  } else turnNav.marker.setLngLat([longitude, latitude]);
  updateNavigationCamera([longitude, latitude]);

  const previousFix = turnNav.prevFix;
  const fixAt = Number.isFinite(pos.timestamp) ? pos.timestamp : Date.now();
  turnNav.prevFix = { point: [longitude, latitude], at: fixAt };
  const reportedMps = Number(pos.coords.speed);
  let mps = Number.isFinite(reportedMps) && reportedMps >= 0 ? reportedMps : null;
  if (mps == null && previousFix) {
    const dt = (fixAt - previousFix.at) / 1000;
    if (dt > 0 && dt < 30) mps = navDistanceM(previousFix.point, [longitude, latitude]) / dt;
  }
  if (mps != null) turnNav.speedMph = mps * 2.23694;

  // Off route, the nearest point is searched over the WHOLE route so the
  // rider can rejoin anywhere — ahead of or behind where they left it.
  const nearest = nearestNavigationPoint(longitude, latitude, turnNav.offRoute);
  if (!nearest) return;

  // Arrival is checked before off-route recovery so riding through the
  // destination cannot trigger guidance back to it.
  if (navigationHasArrived([longitude, latitude], nearest)) {
    if (turnNav.followingConnector) {
      finishNavigationConnector([longitude, latitude], previousFix);
      return;
    }
    finishTurnNavigation();
    return;
  }

  // On the first fix, offer a temporary route to the original start only when
  // the rider is both at least 0.1 mi from that start AND off the planned route.
  // Someone already on the route—at any point along it—starts right there.
  if (turnNav.joinDecision === 'pending') {
    const startDistanceM = navDistanceM([longitude, latitude], turnNav.plannedRoute.coords[0]);
    if (shouldOfferRouteStartConnector(startDistanceM, nearest.offRouteM)) {
      turnNav.joinDecision = 'offered';
      turnNav.joinFix = { point: [longitude, latitude], nearest, startDistanceM };
      turnNav.message = '';
      if (!showRouteStartOffer(startDistanceM)) useNearestPlannedRoute();
      refreshNavigationUI();
      return;
    }
    turnNav.joinDecision = 'nearest';
  } else if (turnNav.joinDecision === 'offered' || turnNav.joinDecision === 'loading') {
    const startDistanceM = navDistanceM([longitude, latitude], turnNav.plannedRoute.coords[0]);
    turnNav.joinFix = { point: [longitude, latitude], nearest, startDistanceM };
    return;
  }

  // Declining the connector—or leaving either route later—uses ordinary
  // nearest-point guidance, including compass direction and road/path name.
  if (!turnNav.offRoute && nearest.offRouteM > OFF_ROUTE_ENTER_M) {
    // Confirm a sustained departure without making urban GPS an all-or-nothing
    // gate: two reliable fixes suffice; moderately coarse fixes need three.
    if (!recordOffRouteCandidate(fixAt, pos.coords.accuracy)) {
      refreshNavigationUI();
      return;
    }
    clearOffRouteCandidate();
    enterOffRoute(nearest);
    refreshNavigationUI();
    return;
  }
  clearOffRouteCandidate();
  if (turnNav.offRoute) {
    if (nearest.offRouteM > OFF_ROUTE_REJOIN_M) {
      updateOffRouteGuidance(nearest, previousFix);
      maybeAutomaticallyRecoverOffRoute();
      refreshNavigationUI();
      return;
    }
    rejoinRoute(nearest, previousFix);
  }

  // On-route position follows the nearest point directly — including small
  // backward corrections; the windowed search bounds any jumps.
  turnNav.nearest = nearest.index;
  turnNav.nearestSegment = nearest.segmentIndex;
  turnNav.nearestPoint = nearest.point;
  turnNav.routeM = nearest.routeM;
  rememberPlannedRouteProgress();
  turnNav.message = turnNav.screenMaySleep ? 'Screen may sleep on this device' : '';
  updateNavigationProgress();
  const instructions = turnNav.route.instructions;
  // Passed maneuvers advance silently; announcing them late is noise.
  while (turnNav.next < instructions.length
      && instructions[turnNav.next].distanceM - turnNav.routeM < -60) {
    instructions[turnNav.next].approach = true;
    instructions[turnNav.next].now = true;
    turnNav.next++;
  }
  const next = instructions[turnNav.next];
  if (!next) {
    if (!maybeSpeakSafetyChange()) maybeSpeakPeriodicUpdate(null, Infinity);
    refreshNavigationUI();
    return;
  }
  const remaining = next.distanceM - turnNav.routeM;
  let spoke = false;
  if (!next.now && remaining <= 90) {
    // Inside the immediate window: speak only the turn itself, never both
    // the approach and the turn back-to-back.
    next.now = true;
    next.approach = true;
    speakNavigation(`${navInstructionText(next)}.`);
    spoke = true;
  } else if (!next.approach && remaining <= 350) {
    next.approach = true;
    speakNavigation(`In ${navDistanceText(remaining)}, ${navInstructionText(next).toLowerCase()}.`);
    spoke = true;
  }
  // The safety change gets its own schedule. It used to be reachable only when
  // no maneuver prompt was due, which on a route where the road changes AT the
  // junction meant it never got the moment it needed. Queued behind the
  // maneuver, it can be raised whenever it comes due without cutting in.
  if (maybeSpeakSafetyChange()) spoke = true;
  // A safety change is news; the periodic status is a summary. The summary
  // yields to both.
  if (!spoke) maybeSpeakPeriodicUpdate(next, remaining);
  refreshNavigationUI();
}

function speakDuration(seconds) {
  const min = Math.max(1, Math.round(seconds / 60));
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.floor(min / 60), rest = min % 60;
  return `${h} hour${h === 1 ? '' : 's'}${rest ? ` ${rest} minutes` : ''}`;
}

// Optional status update on the rider's cadence (Settings -> Voice): any
// combination of next maneuver, speed, distance remaining, and time left.
function maybeSpeakPeriodicUpdate(next, remainingToTurnM) {
  // The native guide owns the cadence on iOS in both foreground and
  // background. Its timer keeps working even when the rider is stopped and
  // CLLocationManager does not deliver a fresh fix; letting this GPS-driven
  // web path speak too would create duplicate status announcements.
  if (turnNav.nativeTracking) return;
  if (!navVoice.updateMin || turnNav.arrived) return;
  if (Date.now() - (turnNav.lastVoiceAt || 0) < navVoice.updateMin * 60000) return;
  if (next && remainingToTurnM <= 350) return; // a turn prompt is imminent anyway
  const parts = [];
  if (navVoice.statusRoute) {
    parts.push(next
      ? `In ${navDistanceText(remainingToTurnM)}, ${navInstructionText(next).toLowerCase()}`
      : 'Continue to your destination');
  }
  if (navVoice.statusSpeed && Number.isFinite(turnNav.speedMph)) {
    parts.push(`Speed ${Math.round(turnNav.speedMph)} miles per hour`);
  }
  const remainingRouteM = Math.max(0, (turnNav.route?.totalM || 0) - turnNav.routeM);
  if (navVoice.statusMiles) parts.push(`${navDistanceText(remainingRouteM)} remaining`);
  if (navVoice.statusEta) {
    const remainS = remainingNavigationTimeS();
    if (remainS >= 45) parts.push(`about ${speakDuration(remainS)} left`);
  }
  if (parts.length) speakNavigation(`${parts.join('. ')}.`, 'status');
}

function handleTurnNavigationLocationError(error) {
  if (!turnNav.active) return;
  // A navigation watch can time out while the map's own location watch still
  // has a usable (possibly cached) fix.  Treat only an explicit denial as an
  // access problem; the other geolocation errors are normally transient GPS
  // acquisition issues and the watch remains active to recover on its own.
  if (Number(error?.code) === 1) {
    turnNav.message = 'Location permission is blocked';
  } else if (Number(error?.code) === 3) {
    turnNav.message = 'Waiting for a GPS fix';
  } else {
    turnNav.message = 'Location signal is temporarily unavailable';
  }
  refreshNavigationUI();
}

function startTurnNavigation() {
  if (routing.pendingRoute || routing.routeRequestActive) {
    setStatus('Wait for the updated route before starting navigation.', true);
    return;
  }
  if (!routing.last?.ok || routing.last.coords?.length < 2
      || (!nativeNavigationPlugin() && !navigator.geolocation)) {
    setStatus('Set a route and allow location access to start navigation.', true);
    return;
  }
  turnNav.plannedRoute = buildTurnInstructions(routing.last);
  turnNav.route = turnNav.plannedRoute;
  turnNav.connectorRoute = null;
  turnNav.followingConnector = false;
  turnNav.plannedRouteM = 0;
  turnNav.plannedNearestSegment = 0;
  turnNav.plannedNearestPoint = null;
  turnNav.locationReady = false;
  turnNav.screenMaySleep = false;
  turnNav.joinDecision = 'pending';
  turnNav.joinFix = null;
  turnNav.connectorRequestId = null;
  turnNav.connectorPurpose = 'start';
  turnNav.newRouteRequestId = null;
  turnNav.newRouteStart = null;
  turnNav.newRouteVias = null;
  turnNav.active = true;
  // The live rider marker is the only "you are here" during navigation.
  clearPassiveMapLocationMarker();
  turnNav.next = 0;
  turnNav.nearest = 0;
  turnNav.nearestSegment = 0;
  turnNav.nearestPoint = null;
  turnNav.routeM = 0;
  turnNav.arrived = false;
  turnNav.offRoute = false;
  turnNav.offRouteInfo = null;
  turnNav.offRouteApproachSpoken = false;
  turnNav.offRouteApproachText = '';
  turnNav.offRouteSpokenAt = 0;
  turnNav.offRouteSince = 0;
  clearOffRouteCandidate();
  turnNav.autoRecoveryAttempted = false;
  turnNav.prevFix = null;
  turnNav.lastPosition = null;
  turnNav.destinationWasNear = false;
  turnNav.lastDestinationM = Infinity;
  turnNav.destinationAwayFixes = 0;
  turnNav.initialCameraAt = 0;
  turnNav.lastCameraAt = 0;
  turnNav.lastVoiceAt = Date.now();
  turnNav.nativeTracking = false;
  drawNavigationConnector([]);
  updateNavigationProgress();
  turnNav.message = 'Getting your location';
  settingsPaneSelect?.('voice');
  // Navigation replaces the planning card with the live route card. If the
  // mobile menu is open on Layers or Settings, show that new navigation UI
  // immediately instead of leaving the rider in the old tab.
  selectPanelTab('route');
  refreshNavigationUI();
  speakNavigation('Navigation started. Getting your location.');
  if (nativeNavigationPlugin()) {
    startNativeNavigationTracking();
  } else {
    turnNav.watchId = navigator.geolocation.watchPosition(
      updateTurnNavigation,
      handleTurnNavigationLocationError,
      // Accept a recent fix and allow GPS a little longer to acquire one. This
      // avoids a false "needs location access" warning on phones whose map
      // marker is already working but whose second watcher has not updated yet.
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 }
    );
  }
  requestNavigationWakeLock();
}

function stopTurnNavigation(announce = true) {
  if (!turnNav.active) return;
  // Whatever was still waiting to be said is about a ride that has ended.
  clearSpeechQueue();
  if (turnNav.watchId != null) navigator.geolocation?.clearWatch(turnNav.watchId);
  turnNav.watchId = null;
  nativeNavigationPlugin()?.stopTracking().catch(() => {});
  turnNav.nativeTracking = false;
  releaseNavigationWakeLock();
  if (turnNav.marker) { turnNav.marker.remove(); turnNav.marker = null; }
  turnNav.active = false;
  turnNav.route = null;
  turnNav.plannedRoute = null;
  turnNav.connectorRoute = null;
  turnNav.followingConnector = false;
  turnNav.plannedRouteM = 0;
  turnNav.plannedNearestSegment = 0;
  turnNav.plannedNearestPoint = null;
  turnNav.locationReady = false;
  turnNav.screenMaySleep = false;
  turnNav.joinDecision = 'pending';
  turnNav.joinFix = null;
  turnNav.connectorRequestId = null;
  turnNav.connectorPurpose = 'start';
  turnNav.newRouteRequestId = null;
  turnNav.newRouteStart = null;
  turnNav.newRouteVias = null;
  turnNav.message = '';
  turnNav.offRoute = false;
  turnNav.offRouteInfo = null;
  turnNav.offRouteApproachSpoken = false;
  turnNav.offRouteApproachText = '';
  turnNav.offRouteSince = 0;
  clearOffRouteCandidate();
  turnNav.autoRecoveryAttempted = false;
  turnNav.prevFix = null;
  turnNav.lastPosition = null;
  turnNav.nearestSegment = 0;
  turnNav.nearestPoint = null;
  turnNav.destinationWasNear = false;
  turnNav.lastDestinationM = Infinity;
  turnNav.destinationAwayFixes = 0;
  turnNav.initialCameraAt = 0;
  turnNav.lastCameraAt = 0;
  closeRouteStartDialog();
  const offRouteDialog = document.getElementById('offRouteDialog');
  if (offRouteDialog?.open) offRouteDialog.close();
  drawNavigationConnector([]);
  updateNavigationProgress();
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  if (announce) speakNavigation('Navigation stopped.');
  refreshNavigationUI();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (turnNav.active) requestNavigationWakeLock();
});

function renderRouteCard(m) {
  const card = document.getElementById('routeCard');
  const controls = document.getElementById('routeControls');
  const details = document.getElementById('routeDetailsBtn');
  const moveControls = () => {
    const slot = card.querySelector('#routeControlsSlot');
    if (slot && controls) slot.replaceWith(controls);
  };
  const moveDetails = () => {
    const slot = card.querySelector('#routeDetailsSlot');
    if (slot && details) slot.replaceWith(details);
  };
  const showRouteMessage = (title, message, hint = '', error = false) => {
    card.innerHTML = `<div id="routeControlsSlot"></div>
      <div class="rc-route-message${error ? ' error' : ''}">
        <strong></strong><span></span><small></small>
      </div>
      <div class="rc-details-hidden"><div id="routeDetailsSlot"></div></div>`;
    const box = card.querySelector('.rc-route-message');
    box.querySelector('strong').textContent = title;
    box.querySelector('span').textContent = message;
    // Hidden when empty, the same way the hint is. The empty state is a title
    // on its own now, and an empty <span> still takes a line box.
    box.querySelector('span').hidden = !message;
    box.querySelector('small').textContent = hint;
    box.querySelector('small').hidden = !hint;
    moveControls();
    moveDetails();
    refreshNavigationUI();
  };
  if (!card) return;
  syncRouteDetailsWarningState(m);
  if (!m) {
    // Title only. This used to add "Use search or tap the map", which reads as
    // an instruction that works -- and it does not: a map tap sets a point only
    // once FROM or TO has been armed, so a rider following it taps and nothing
    // happens. Telling someone how to drive the interface here is also the
    // wrong job for an empty state; saying what is missing is enough.
    showRouteMessage('Choose a start and destination');
    return;
  }
  if (!m.ok) {
    let reason = String(m.reason || 'No route was found.');
    if (reason === 'A route point is too far from a routable road or path.') {
      reason = 'Move the route point closer to a road or path, then try again.';
    } else if (reason.startsWith('No route fully matching your safety rules exists')) {
      reason = 'No route fully matches your safety rules.';
    } else if (reason === 'Start and destination snap to the same road point. Move one of them farther away.') {
      reason = 'Move the start or destination farther away.';
    }
    const hint = reason === 'No route fully matches your safety rules.'
      ? 'Adjust a rule, or turn off “Only show routes fully matching safety rules”.'
      : '';
    showRouteMessage('Route unavailable', reason, hint, true);
    return;
  }
  const stats = routeSummaryStats(m);
  const ridingM = Math.max(1, ROUTE_CATEGORY_KEYS.reduce((sum, key) => sum + stats.categoryM[key], 0));
  const categoryPct = routeCategoryPercentages(stats.categoryM);
  const inclineOver5Pct = routePercent(stats.inclineOver5M, ridingM, true);
  const unpavedMiles = `${fmtMiles(stats.unpavedM)} mi`;
  const hasSignificantUnpaved = stats.unpavedM > SIGNIFICANT_UNPAVED_M;
  const hasSteepGradeWarning = Number(m.maxGradePct) > STEEP_GRADE_WARNING_PCT;
  const unpavedMetric = hasSignificantUnpaved
    ? `<button class="rc-secondary-item rc-ride-unpaved-warning" id="rcUnpavedWarningLink" type="button" aria-label="Review unpaved route concerns"><span class="rc-unpaved-swatch" aria-hidden="true"></span><b>${unpavedMiles}</b><span class="rc-secondary-label">Unpaved</span><span class="rc-unpaved-alert-mark" aria-hidden="true">!</span></button>`
    : `<span class="rc-secondary-item"><span class="rc-unpaved-swatch" aria-hidden="true"></span><b>${unpavedMiles}</b><span class="rc-secondary-label">Unpaved</span></span>`;
  const categoryRows = ROUTE_CATEGORY_LABELS
    .map(([key, label]) => `<span class="rc-category-item rc-category-${key}"><span class="rc-category-swatch ${key}" aria-hidden="true"></span><b>${categoryPct[key]}%</b><span>${label}</span></span>`).join('');
  card.innerHTML = `
    <div id="routeControlsSlot"></div>
    <div class="rc-route-summary">
      <div class="rc-overview">
        <div class="rc-main"><span class="rc-distance">${fmtMi(m.distM)} mi</span><span class="rc-duration">Est. ${fmtDur(m.timeS)}</span></div>
        <div id="routeDetailsSlot"></div>
      </div>
      <div class="rc-elevation-column">
        <div class="rc-elev-wrap"><canvas id="rcElevCanvas" class="rc-elev-canvas"></canvas><button id="rcElevGradeWarning" class="rc-elev-grade-warning" type="button" aria-label="Route has a sustained grade over ${STEEP_GRADE_WARNING_PCT} percent. View route details." ${hasSteepGradeWarning ? '' : 'hidden'}><span aria-hidden="true">!</span> Details</button></div>
        <div class="rc-secondary-metrics">
          <span class="rc-secondary-item rc-incline-item"><span class="rc-incline-swatch" aria-hidden="true">↗</span><b>${inclineOver5Pct}</b><span class="rc-secondary-label">Incline over 5%</span></span>
          <span class="rc-secondary-divider" aria-hidden="true"></span>
          ${unpavedMetric}
        </div>
      </div>
      <div class="rc-category-list" title="Percent of non-ferry riding distance; categories match the selected route and total 100%">${categoryRows}</div>
    </div>`;
  moveControls();
  moveDetails();
  document.getElementById('rcElevGradeWarning')?.addEventListener('click', () => openRouteDetails('stats'));
  document.getElementById('rcUnpavedWarningLink')?.addEventListener('click', () => {
    openRouteDetails('concerns', 'concern-unpaved');
  });
  refreshNavigationUI();
  drawRouteCardElevation();
}

function routeHasDetailsWarning(route) {
  if (!route?.ok) return false;
  const stats = routeSummaryStats(route);
  return Number(route.maxGradePct) > STEEP_GRADE_WARNING_PCT
    || stats.unpavedM > SIGNIFICANT_UNPAVED_M;
}

function syncRouteDetailsWarningState(route, { flash = false } = {}) {
  const warning = routeHasDetailsWarning(route);
  const buttons = ['routeDetailsBtn', 'navCardDetailsBtn']
    .map((id) => document.getElementById(id)).filter(Boolean);
  buttons.forEach((button) => button.classList.toggle('route-details-warning', warning));
  if (!warning || !flash || turnNav.active) return;
  const button = document.getElementById('routeDetailsBtn');
  if (!button) return;
  button.classList.remove('route-details-attention');
  void button.offsetWidth;
  button.classList.add('route-details-attention');
  button.addEventListener('animationend',
    () => button.classList.remove('route-details-attention'), { once: true });
}

function flashRouteCardWarnings(route) {
  if (turnNav.active || !route?.ok) return;
  const stats = routeSummaryStats(route);
  const targets = [];
  if (Number(route.maxGradePct) > STEEP_GRADE_WARNING_PCT) targets.push(document.getElementById('rcElevGradeWarning'));
  if (stats.unpavedM > SIGNIFICANT_UNPAVED_M) {
    targets.push(document.querySelector('#routeCard .rc-ride-unpaved-warning'));
  }
  targets.filter(Boolean).forEach((target) => {
    target.classList.add('rc-warning-cue-attention');
    target.addEventListener('animationend',
      () => target.classList.remove('rc-warning-cue-attention'), { once: true });
  });
}

function showPointTooFarPopup(m) {
  const dialog = document.getElementById('routeProblemDialog');
  const text = document.getElementById('routeProblemText');
  if (!dialog || !text) return;
  const pointName = (index) => {
    if (index === 0) return 'Start';
    if (index === m.pointCount - 1) return 'Destination';
    return `Stop ${index}`;
  };
  const points = (m.farPoints || []).map((p) =>
    `${pointName(p.pointIndex)} is ${fmtDist(p.distanceM)} from the nearest routable road or path.`);
  text.textContent = `${points.join(' ')} Move ${points.length === 1 ? 'it' : 'them'} closer and try again.`;
  if (!dialog.open) dialog.showModal();
}

function refreshedRouteSelection(options) {
  if (!options.length) return null;
  const recommended = options.find((option) => option.optimization?.recommended);
  if (routing.selectRecommendedNext) return recommended || options[0];
  const previous = routing.last?.optimization;
  const profileId = previous?.profileId || routing.profileId;
  const exact = profileId
    ? options.find((option) => option.optimization?.profileId === profileId)
    : null;
  if (!previous) return recommended || options[0];
  if (exact) return exact;

  // A settings change can legitimately remove the old profile from the
  // portfolio. In that case, keep the closest search method and preferences
  // instead of falling all the way back to the newly recommended route.
  const mismatch = (option) => {
    const next = option.optimization || {};
    let score = 0;
    if (next.mode !== previous.mode) score += 8;
    if (!!next.prefDesignated !== !!previous.prefDesignated) score += 3;
    if (!!next.prefResidential !== !!previous.prefResidential) score += 3;
    if (!!next.alternativeCorridor !== !!previous.alternativeCorridor) score += 2;
    if (!!next.fullyMatchingRules !== !!previous.fullyMatchingRules) score += 2;
    if ((next.discoveryMaxSpeed || null) !== (previous.discoveryMaxSpeed || null)) score += 1;
    return score;
  };
  return options.reduce((best, option) =>
    mismatch(option) < mismatch(best) ? option : best, options[0]);
}

function onRouterMessage(ev) {
  const m = ev.data;
  if (m.type === 'route-connector') {
    activateNavigationConnector(m);
  } else if (m.type === 'navigation-new-route') {
    activateNewRouteFromCurrentLocation(m);
  } else if (m.type === 'progress') {
    if (m.id != null && m.id !== routing.reqId) return;
    const title = m.phase === 'engine' ? 'Loading routing engine'
      : m.phase === 'reroute' ? 'Updating route' : 'Calculating route options';
    showRouterProgress(m.detail || 'Working…', title);
  } else if (m.type === 'ready') {
    // Only a graph whose BYTES match the expected stamp counts as loaded;
    // marking a stale one done is what made the self-heal one-shot before.
    // No hash (crypto unavailable) keeps the old always-mark behaviour.
    if (!routing.loadedGraphVersion || routing.loadedGraphVersion === GRAPH_DATA_VERSION) {
      markGraphDataLoaded();
    }
    routing.ready = true;
    routing.loading = false;
    routing.pendingRoute = false;
    updateArmButtons();
    setRouteStatus(routing.start && routing.end ? 'Routing…' : '');
    if (!(routing.start && routing.end)) {
      setRouteOptionsLoading(false);
      showRouteActionToast('');
    }
    renderRouteCard(routing.last);
    computeRoute();
    schedulePrewarm();
  } else if (m.type === 'route-options') {
    if (m.id !== routing.reqId) return;
    const remaining = 400 - (performance.now() - routing.compareStartedAt);
    if (!m.displayDelayApplied && remaining > 0) {
      setTimeout(() => onRouterMessage({ data: { ...m, displayDelayApplied: true } }), remaining);
      return;
    }
    routing.routeRequestActive = false;
    document.body.dataset.routeOptionsMs = String(Math.round(Number(m.ms) || 0));
    // The per-phase breakdown, for diagnosing a slow platform: which phase
    // ate the time is the fact that matters, and it cannot be reconstructed
    // after the fact. Held on routing state and shown on the Settings page
    // (syncGraphVersionLine) -- the console.log alone proved unfindable in
    // the field -- and mirrored onto the body dataset for tests and DevTools.
    if (m.timings) {
      console.log('[route-options] phase timings (ms)', m.timings);
      routing.lastTimings = m.timings;
      document.body.dataset.routeOptionsTimings = JSON.stringify(m.timings);
      syncGraphVersionLine();
    }
    setRouteOptionsLoading(false);
    if (!m.ok || !Array.isArray(m.options) || !m.options.length) {
      showRouteActionToast('Could not calculate that route', { duration: 2600 });
      routing.options = [];
      stopTurnNavigation(false);
      clearStoredRouteDetails();
      const failure = { ...m, ok: false, reason: m.reason || 'No useful route options were found.' };
      routing.last = failure;
      renderRouteOptionControls();
      renderRouteCard(failure);
      drawRoute([]);
      setRouteStatus(failure.reason);
      if (m.code === 'point-too-far') showPointTooFarPopup(m);
      return;
    }
    routing.options = m.options;
    routing.allCandidates = Array.isArray(m.allCandidates) ? m.allCandidates : [];
    routing.candidatesKey = m.candidatesKey || null;
    if (routing.lastRequestPinned) {
      // A refinement under a frozen lineup: same letters, same recipes. A
      // recipe that found nothing keeps its letter in the chooser, greyed --
      // an honest empty slot, never a silently substituted route.
      routing.missingLetters = Array.isArray(m.missing) ? m.missing : [];
      const previous = routing.last?.optimization?.profileId;
      const lost = previous
        && routing.missingLetters.find((entry) => entry.profileId === previous);
      if (lost) {
        showRouteActionToast(`Route ${lost.letter} found no route with your changes`,
          { duration: 3200 });
      }
    } else if (!routing.sharedActive) {
      // A fresh search re-letters: pin the new lineup for this trip's
      // refinements. See the chooser policy note in computeRoute().
      // Duplicate profile ids are dropped defensively -- the lineup keys by
      // id, and a worker from before adaptive itineraries carried unique
      // suffixes could hand back two candidates under one id.
      const seenProfiles = new Set();
      routing.pinnedLetters = m.options.map((option) => ({
        letter: (option.optimization?.label || '').replace(/^Route /, ''),
        profileId: option.optimization?.profileId,
      })).filter((entry) => entry.letter.length === 1 && entry.profileId
        && !seenProfiles.has(entry.profileId) && seenProfiles.add(entry.profileId));
      routing.missingLetters = [];
    }
    let selected;
    if (routing.sharedActive) {
      // The sender's exact route is the option matching their profile; it goes
      // in the first (A) slot, relabeled "As Shared".
      const sp = routing.sharedRecipe?.profileId;
      selected = (sp && m.options.find((o) => o.optimization?.profileId === sp)) || m.options[0];
      selected.asShared = true;
      // "As Shared" gets its own dedicated slot after the lettered options.
      routing.options = [...m.options.filter((o) => o !== selected), selected];
    } else {
      selected = refreshedRouteSelection(m.options);
    }
    routing.selectRecommendedNext = false;
    activateRouteOption(selected);
    notifySnapDistance(selected);
  } else if (m.type === 'route-candidate') {
    if (m.id !== routing.candidateReqId) return; // stale reply
    showRouteActionToast('');
    if (!m.ok) {
      showRouteActionToast(m.reason || 'That route is no longer available', { duration: 2800 });
      return;
    }
    // Park it alongside the offered routes so the chooser can show it as the
    // active selection and the rider can switch back without re-opening More.
    routing.options = [...(routing.options || []).filter((o) =>
      o.optimization?.profileId !== m.option.optimization?.profileId), m.option];
    // An explicitly chosen candidate joins the trip's frozen lineup under its
    // own letter, so refinements keep re-running it like any pinned recipe.
    const chosenId = m.option.optimization?.profileId;
    const chosenLetter = (m.option.optimization?.label || '').replace(/^Route /, '');
    if (routing.pinnedLetters && chosenId && chosenLetter
        && !routing.pinnedLetters.some((entry) => entry.profileId === chosenId)) {
      routing.pinnedLetters.push({ letter: chosenLetter, profileId: chosenId });
    }
    activateRouteOption(m.option, true);
    renderRouteOptionControls();
  } else if (m.type === 'route') {
    if (m.id !== routing.reqId) return; // stale reply
    routing.routeRequestActive = false;
    setRouteOptionsLoading(false);
    if (!m.ok) {
      showRouteActionToast('Could not calculate that route', { duration: 2600 });
      routing.options = [];
      routing.last = m;
      renderRouteOptionControls();
      stopTurnNavigation(false);
      clearStoredRouteDetails();
      renderRouteCard(m);
      drawRoute([]);
      setRouteStatus(m.reason);
      if (m.code === 'point-too-far') showPointTooFarPopup(m);
      return;
    }
    routing.options = [m];
    activateRouteOption(m, true);
  } else if (m.type === 'error') {
    if (m.id != null && m.id !== routing.reqId) return;
    handleRouterFailure(m.message);
  }
}

function computeRoute() {
  if (!routing.start || !routing.end) return;
  if (!routing.ready) { // re-runs once the graph is ready
    routing.pendingRoute = true;
    setRouteOptionsLoading(true);
    ensureRouter();
    showRouterProgress('Finishing the statewide routing map; your route will start automatically…',
      'Preparing route');
    return;
  }
  routing.pendingRoute = false;
  routing.routeRequestActive = true;
  routing.reqId++;
  setRouteStatus('Routing…');
  // The route chooser shows its own "Comparing routes…" pill while it loads.
  // When that pill is on screen -- panel open on the Route tab, which is how
  // every startup restore and most pin drops look -- a floating banner saying
  // the same thing is a second spinner, so it only shows when the chooser
  // cannot (panel closed, mid-navigation reroutes).
  if (!document.getElementById('routeOptions')?.offsetParent) {
    showRouteActionToast(routing.last?.ok ? 'Recalculating route' : 'Calculating route options', {
      busy: true,
      detail: routing.last?.ok
        ? 'Reapplying your safety rules and route preferences…'
        : 'Testing safer, quicker, and bike-friendly alternatives…',
      duration: 0,
    });
  }
  setRouteOptionsLoading(true);
  saveStateSoon();
  const points = [routing.start, ...routing.vias.map((v) => v.pt), routing.end];
  const selected = routing.last?.optimization;
  if (turnNav.active) {
    routing.worker.postMessage({
      type: 'route', id: routing.reqId, points, rules: { ...rules },
      blocks: routing.blocks?.map((block) => block.pt) || [],
      mode: selected?.mode || routing.mode,
      profileId: selected?.profileId || routing.profileId,
      profileLabel: selected?.label,
      prefDesignated: routing.prefDesig || !!selected?.prefDesignated,
      prefResidential: routing.prefResidential || !!selected?.prefResidential,
      weights: remixedRoutingWeights(),
    });
  } else {
    routing.compareStartedAt = performance.now();
    // While the shared route is active, search with the SENDER's recipe so the
    // path reproduces exactly. The map still colors it with the receiver's
    // current rules (colors are re-scored client-side).
    const rec = routing.sharedActive ? routing.sharedRecipe : null;
    // The chooser policy: a trip's lettered lineup is FROZEN between explicit
    // re-searches. A refinement -- waypoint, road block, settings change --
    // re-runs the same recipes and keeps the same letters, so the rider sees
    // what their change did to the routes they were already comparing. Only a
    // start/destination change (reverse included) or a pick in the ⋮ dialog
    // re-ranks and re-letters; both set selectRecommendedNext.
    const pinned = !rec && !routing.selectRecommendedNext && routing.pinnedLetters?.length
      ? routing.pinnedLetters.map((entry) => ({ ...entry })) : null;
    routing.lastRequestPinned = !!pinned;
    routing.worker.postMessage({
      type: 'route-options', id: routing.reqId, points,
      blocks: routing.blocks?.map((block) => block.pt) || [],
      rules: { ...(rec?.rules || rules) },
      forceDesignated: rec ? !!rec.prefDesig : routing.prefDesig,
      forceResidential: rec ? !!rec.prefResidential : routing.prefResidential,
      preferredProfileId: rec ? (rec.profileId || routing.profileId) : routing.profileId,
      pinned,
      // A shared route reproduces the SENDER's search exactly; remix applies
      // only to searches made with the rider's own weights.
      weights: rec?.weights ? { ...rec.weights } : remixedRoutingWeights(),
    });
  }
}

// Pseudo-source for tapping the route line itself: segments carry their graph
// attributes, so the route is inspectable even with every data layer off.
const ROUTESEG_SRC = { id: 'routeseg', name: 'Your route', scorer: scoreRouteSeg };
// facility 1 is a sharrow. It is paint in a shared travel lane, so the route
// line must not draw it as bike network any more than the map does.
const ROUTE_SEG_BIKE_EXPR = ['any', ['==', ['get', 'infra'], 1],
  ['>=', ['get', 'facility'], 2]];
const ROUTE_SEG_TRAIL_EXPR = ['==', ['get', 'facility'], 5];
const ROUTE_SEG_NOT_TRAIL_EXPR = ['!=', ['get', 'facility'], 5];
const ROUTE_SEG_NOT_BIKE_EXPR = ['all', ['!=', ['get', 'infra'], 1],
  ['<', ['get', 'facility'], 2]];
const ROUTE_SEG_DESIGNATED_EXPR = ['==', ['get', 'desig'], 1];
const ROUTE_SEG_NOT_DESIGNATED_EXPR = ['!=', ['get', 'desig'], 1];
const ROUTE_SEG_PASS_EXPR = ['any', ['==', ['get', 'level'], 1],
  ['==', ['get', 'level'], 2]];
function scoreRouteSeg(p) {
  const facility = p.facility || 0;
  const official = p.official || 0;
  return {
    baseScore: facility >= 4 || p.infra === 1 ? 1 : facility >= 1 ? 2 : null,
    shoulder_width: p.sh >= 0 ? p.sh : null,
    maxspeed_num: p.ferry ? null : p.mph,
    prohibited: false, restricted: false,
    // The ladder has its own rung for a crossing by boat. Carry the fact, or a
    // ferry leg is judged as though it were a road with no shoulder.
    ferry: p.ferry === 1,
    freeway: p.fw === 1,
    limited_access: p.lim === 1 || p.fw === 1,
    good_facility: facility >= 2,
    facility,
    infra: p.infra === 1 || facility >= 4,
    lanes: p.lanes || 0,
    ctl: p.centerTurnLane === true || p.ctl === 1,
    oneway: p.ow === 1,
    stressRating: p.lts || null,
    est: p.e === 1,
    desig: p.desig === 1,
    dismount: p.dismount === 1,
    sidewalk: official & OFFICIAL_SIDEWALK ? 'present'
      : official & OFFICIAL_SIDEWALK_NO ? 'absent' : null,
    urban: !!(official & OFFICIAL_URBAN),
    // The very same reader the roads tiles use. One function, so a road and the
    // route over it cannot describe themselves differently.
    measures: tileMeasures(p),
  };
}

// Graph edges are deliberately short: that gives the router reliable snapping
// and accurate safety reporting, but MapLibre restarts a dash pattern at every
// GeoJSON feature.  Drawing those raw edges made a continuous trail look like
// a series of big, zoom-dependent blobs.  Keep the raw per-edge source for
// tapping/highlighting, and build a separate, merged source for visible route
// strokes.  A new stroke begins only when its visual safety/facility category
// changes.
function routeVisualStyle(p) {
  if (p.ferry === 1) return null;
  // The worker has verified this as one short crossing bounded by passing
  // segments. Preserve that semantic result when the map re-evaluates the
  // selected route under live rules; otherwise the crossing turns red again
  // even though route totals and Route Details count it as passing.
  if (p.crossing === 1) return 'pass';
  if (effectiveLevel(scoreRouteSeg(p)) === 4) return 'fail';
  // Walking is a caution wherever the route is shown. A dismount stretch --
  // tagged or synthesised -- used to draw as lime trail, which read as the
  // best riding on the route while actually being a hike. Amber makes a long
  // walked section obvious at every zoom; the walker chain says why.
  if (p.dismount === 1) return 'caution';
  if (p.level === 3) return 'caution';
  // Allowed mountain-bike trails are a caution everywhere the route is shown.
  // Route Details already rendered them this way; keep the main map and its
  // five-category totals in the same visual vocabulary.
  if (p.mtb === 1) return 'caution';
  if (p.level === 0) return 'unknown';
  // The shared rule, so the drawn route cannot disagree with the tap card or
  // the tiles about the same road. A sharrow (facility 1) is paint in a shared
  // traffic lane and earns no lime from it.
  const bike = SafetyModel.isBikeNetwork(SafetyModel.sealFacts({
    infra: p.infra === 1,
    facility: Number(p.facility) || 0,
    stressRating: p.lts == null ? null : Number(p.lts),
  }));
  if (bike && p.facility === 5) return 'trail';
  if (bike) return 'bike';
  // A signed bike route no longer changes the drawn route. It used to draw as
  // dashed pass-blue, which a rider reasonably read as a distinct verdict when
  // it only ever meant "passes, and there is a route number on a sign". The
  // designated ribbon underneath already says that, in green, on the road
  // itself -- one indicator instead of two saying different things.
  return 'pass';
}

function sameRouteCoordinate(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1];
}

function buildRouteRenderData(sdata) {
  const features = [];
  let current = null;
  for (const feature of sdata.features) {
    const style = routeVisualStyle(feature.properties);
    const coordinates = feature.geometry.coordinates;
    if (!style || coordinates.length < 2) {
      current = null;
      continue;
    }
    const previous = current?.geometry.coordinates.at(-1);
    if (current && current.properties.style === style && sameRouteCoordinate(previous, coordinates[0])) {
      current.geometry.coordinates.push(...coordinates.slice(1));
      continue;
    }
    current = {
      type: 'Feature', properties: { style },
      geometry: { type: 'LineString', coordinates: coordinates.slice() },
    };
    features.push(current);
  }
  return { type: 'FeatureCollection', features };
}

// The stretches of THIS route that follow a signed bike route, merged into runs.
//
// Deliberately built from the route's own segments rather than by widening the
// background ribbon layer: that layer covers every signed corridor in the
// state, and widening it made unrelated corridors fatten across the whole map
// whenever any route was drawn. Only the part you are actually riding should
// stand out.
function buildRouteDesignatedData(sdata) {
  const features = [];
  let current = null;
  for (const feature of sdata.features) {
    const coordinates = feature.geometry?.coordinates;
    if (feature.properties?.desig !== 1 || !(coordinates?.length >= 2)) {
      current = null;
      continue;
    }
    const previous = current?.geometry.coordinates.at(-1);
    if (current && sameRouteCoordinate(previous, coordinates[0])) {
      current.geometry.coordinates.push(...coordinates.slice(1));
      continue;
    }
    current = {
      type: 'Feature', properties: {},
      geometry: { type: 'LineString', coordinates: coordinates.slice() },
    };
    features.push(current);
  }
  return { type: 'FeatureCollection', features };
}

// Surface is an independent, rider-preference attribute rather than a safety
// verdict. Keep the normal lime/blue/amber/red route color intact and draw
// repeated cross-slats over only the edges OSM positively tags as gravel or
// rough/unpaved. Unknown surface data never enters this source.
function buildRouteUnpavedData(sdata) {
  const features = [];
  let current = null;
  for (const feature of sdata.features) {
    const coordinates = feature.geometry?.coordinates;
    if (!isConfirmedUnpavedSurface(feature.properties?.surface) || coordinates?.length < 2) {
      current = null;
      continue;
    }
    const previous = current?.geometry.coordinates.at(-1);
    if (current && sameRouteCoordinate(previous, coordinates[0])) {
      current.geometry.coordinates.push(...coordinates.slice(1));
      continue;
    }
    current = {
      type: 'Feature', properties: {},
      geometry: { type: 'LineString', coordinates: coordinates.slice() },
    };
    features.push(current);
  }
  return {
    type: 'FeatureCollection',
    features,
  };
}

/* Route markers: one vocabulary, one planner. Five things a rider wants
 * flagged on the line itself -- walking (any dismount), a 10%+ wall, heavy
 * traffic, unpaved surface, and a technical/odd way -- share one spacing
 * clock (~700 m) so the map never drowns in icons. Where several apply to
 * the same stretch, ONE is picked per slot, deterministically pseudo-random
 * by slot index so a redraw never reshuffles and long shared stretches show
 * a mix rather than a single kind winning everywhere.
 */
const ROUTE_MARKER_SPACING_M = 700;
// Below these run lengths a signal is a blip (or a DEM/data artefact), not a
// stretch worth an icon. Traffic and surface need real length; walking and
// technical ways matter even when short.
const ROUTE_MARKER_MIN_RUN_M = { walk: 60, steep: 100, traffic: 400, unpaved: 400, odd: 60 };
const ROUTE_MARKER_KINDS = ['walk', 'steep', 'traffic', 'unpaved', 'odd'];
// No mountain within this distance of a ferry leg: dockside DEM is artifact.
const FERRY_GRADE_BLACKOUT_M = 250;
// Badges grow as the rider zooms in, so they stay readable up close without
// dominating a statewide view.
const ROUTE_MARKER_SIZE_BY_ZOOM = ['interpolate', ['linear'], ['zoom'],
  9, 0.98, 12, 1.3, 14, 1.66, 16.5, 2.2];
// The car flags traffic at the tier that starts driving cautions and rule
// failures -- the safety model's "busy through road" (6,000/day) -- not just
// full main-highway volumes.
const HEAVY_TRAFFIC_ADT = SafetyModel.BUSY_LEVELS[3].adt;
// The ! on a rules-failing stretch: one at the middle of a contiguous failed
// area (two on a long one), only where no other badge is already telling a
// story. Its job is to draw the tap that opens the card naming the rule.
const FAIL_MARKER_MIN_RUN_M = 120;
const FAIL_MARKER_SECOND_AT_M = 2500;
function routeMarkerKinds(p, style) {
  const kinds = [];
  if (p.ferry === 1) return kinds;
  if (p.dismount === 1) kinds.push('walk');
  const grade = Number(p.gradePct);
  if (Number.isFinite(grade) && grade >= STEEP_MARKER_GRADE_PCT
      && grade <= MAX_CREDIBLE_GRADE_PCT) kinds.push('steep');
  if (Number(p.adt) >= HEAVY_TRAFFIC_ADT) {
    // The car marks traffic the rider actually bears. A stretch still earning
    // trusted bike/trail paint keeps its lime unbadged, however busy the road
    // beside the lane; the car appears where the road is a caution, or where
    // that traffic is part of why it draws as a bare pass instead.
    if (style === 'caution' || style === 'pass') kinds.push('traffic');
  }
  if (isConfirmedUnpavedSurface(p.surface)) kinds.push('unpaved');
  if (p.mtb === 1) kinds.push('odd');
  return kinds;
}
function buildRouteMarkerData(sdata) {
  const feats = (sdata.features || []).map((feature) => {
    const p = feature.properties || {};
    const coords = feature.geometry?.coordinates || [];
    let lenM = 0;
    for (let i = 1; i < coords.length; i++) lenM += markerSpanM(coords[i - 1], coords[i]);
    const style = p.ferry === 1 ? null : routeVisualStyle(p);
    return { kinds: routeMarkerKinds(p, style), coords, lenM,
      ferry: p.ferry === 1, fail: style === 'fail' };
  });
  // A dock reads steep when it is not: the z12 DEM smears the shoreline bluff
  // onto the flats at a slip, and Clinton's flat terminal road booked 11%
  // over 116 m of pier. Grades measured this close to a ferry leg are
  // artifact, so the mountain is blind there.
  let at = 0;
  const spans = feats.map((f) => { const span = { startM: at, endM: at + f.lenM }; at = span.endM; return span; });
  const ferries = spans.filter((span, i) => feats[i].ferry);
  if (ferries.length) {
    feats.forEach((f, i) => {
      const steep = f.kinds.indexOf('steep');
      if (steep < 0) return;
      const near = ferries.some((ferry) => spans[i].startM < ferry.endM + FERRY_GRADE_BLACKOUT_M
        && spans[i].endM > ferry.startM - FERRY_GRADE_BLACKOUT_M);
      if (near) f.kinds.splice(steep, 1);
    });
  }
  // A kind qualifies on a feature when its CONTIGUOUS run is long enough --
  // a 15 m sliver inside a long climb still counts as climb.
  const qualified = feats.map(() => []);
  for (const kind of ROUTE_MARKER_KINDS) {
    let start = 0;
    while (start < feats.length) {
      if (!feats[start].kinds.includes(kind)) { start++; continue; }
      let end = start, total = 0;
      while (end < feats.length && feats[end].kinds.includes(kind)) { total += feats[end].lenM; end++; }
      if (total >= ROUTE_MARKER_MIN_RUN_M[kind]) {
        for (let i = start; i < end; i++) qualified[i].push(kind);
      }
      start = end;
    }
  }
  const walk = [], other = [];
  // Knuth's multiplicative hash over the slot index: stable across redraws,
  // uncorrelated enough that mixed stretches show mixed icons.
  const pick = (slot, kinds) => kinds[((slot * 2654435761) >>> 0) % kinds.length];
  let pos = 0, minNext = ROUTE_MARKER_SPACING_M / 4;
  feats.forEach((f, index) => {
    const active = qualified[index];
    for (let i = 1; i < f.coords.length; i++) {
      const a = f.coords[i - 1], b = f.coords[i];
      const d = markerSpanM(a, b);
      if (active.length) {
        while (true) {
          const target = Math.max(minNext, pos);
          if (target > pos + d) break;
          const t = d > 0 ? (target - pos) / d : 0;
          const slot = Math.round(target / ROUTE_MARKER_SPACING_M);
          const kind = pick(slot, active);
          // `slot` doubles as the collision priority: with a stable sort key
          // the placer culls the SAME markers at every zoom, so zooming thins
          // a chain monotonically instead of toggling which icon a spot shows.
          const point = { type: 'Feature', properties: { kind, slot },
            geometry: { type: 'Point',
              coordinates: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] } };
          (kind === 'walk' ? walk : other).push(point);
          minNext = target + ROUTE_MARKER_SPACING_M;
          if (!(d > 0)) break;
        }
      }
      pos += d;
    }
  });
  // The ! for rules failures sits outside the spacing clock: one per
  // contiguous failed area (two on a long one), placed only where no chained
  // badge already invites the tap. Slot -1 gives it top collision priority.
  const pointAt = (f, span, m) => {
    let at = span.startM;
    for (let i = 1; i < f.coords.length; i++) {
      const a = f.coords[i - 1], b = f.coords[i], d = markerSpanM(a, b);
      if (m <= at + d || i === f.coords.length - 1) {
        const t = d > 0 ? Math.min(1, Math.max(0, (m - at) / d)) : 0;
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      }
      at += d;
    }
    return f.coords[0] || null;
  };
  const placeFailMarks = (startIdx, endIdx) => {
    const runStartM = spans[startIdx].startM, runLenM = spans[endIdx].endM - runStartM;
    if (runLenM < FAIL_MARKER_MIN_RUN_M) return;
    const targets = runLenM >= FAIL_MARKER_SECOND_AT_M
      ? [runStartM + runLenM / 3, runStartM + 2 * runLenM / 3]
      : [runStartM + runLenM / 2];
    for (const target of targets) {
      const index = spans.findIndex((span) => target >= span.startM && target <= span.endM);
      if (index < 0 || qualified[index].length) continue;
      const at = pointAt(feats[index], spans[index], target);
      if (!at) continue;
      other.push({ type: 'Feature', properties: { kind: 'fail', slot: -1 },
        geometry: { type: 'Point', coordinates: at } });
    }
  };
  let failStart = -1;
  feats.forEach((f, i) => {
    if (f.fail && failStart < 0) failStart = i;
    if (!f.fail && failStart >= 0) { placeFailMarks(failStart, i - 1); failStart = -1; }
  });
  if (failStart >= 0) placeFailMarks(failStart, feats.length - 1);
  return { walk: { type: 'FeatureCollection', features: walk },
    other: { type: 'FeatureCollection', features: other } };
}

const STEEP_MARKER_GRADE_PCT = 10;
function markerSpanM(a, b) {
  const kx = 111320 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * 111320);
}

// One marker per ferry leg, placed near its visual midpoint. The dashed ferry
// line remains useful at a glance; the boat makes its meaning explicit.
function buildRouteFerryMarkerData(ferrySegs) {
  const features = [];
  for (const coordinates of ferrySegs || []) {
    if (!Array.isArray(coordinates) || !coordinates.length) continue;
    const point = coordinates[Math.floor((coordinates.length - 1) / 2)];
    if (!Array.isArray(point) || point.length < 2) continue;
    features.push({ type: 'Feature', properties: {},
      geometry: { type: 'Point', coordinates: point.slice(0, 2) } });
  }
  return { type: 'FeatureCollection', features };
}

// The badge painters themselves live in marker-icons.js, shared with the
// route preview so both surfaces draw one vocabulary. These constants size
// the LAYERS around the walker badge (halo, tap target), not the bitmap.
const DISMOUNT_MARKER_SCALE = 3;
const DISMOUNT_MARKER_PX = 18 * DISMOUNT_MARKER_SCALE / 2;   // 27 CSS px
// The halo behind it, which is also what a tap is measured against. A little
// wider than the icon so its edges are comfortably inside it.
const DISMOUNT_MARKER_HIT_PX = Math.round(DISMOUNT_MARKER_PX / 2) + 4;   // 18 px radius

function ensureFerryMarkerImage(targetMap, imageId = 'route-ferry-marker-icon') {
  if (targetMap.hasImage(imageId)) return;
  // A wide, unbadged side-view ferry. A rounded transit badge made the boat
  // feel like a tiny face or app icon; the white keyline here lets the actual
  // vessel silhouette sit directly on any basemap while remaining legible.
  // Draw at 2x for clean edges on Retina displays while staying fully offline.
  const width = 80, height = 52;
  const data = new Uint8Array(width * height * 4);
  const blue = [10, 102, 167, 255], white = [255, 255, 255, 255];
  const paint = (x, y, color) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const offset = (y * width + x) * 4;
    data[offset] = color[0]; data[offset + 1] = color[1];
    data[offset + 2] = color[2]; data[offset + 3] = color[3];
  };
  const roundedRect = (left, top, right, bottom, radius, color) => {
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        const cx = Math.max(left + radius, Math.min(right - radius, x));
        const cy = Math.max(top + radius, Math.min(bottom - radius, y));
        if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) paint(x, y, color);
      }
    }
  };
  const rect = (left, top, right, bottom, color) => {
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) paint(x, y, color);
    }
  };
  const polygon = (points, color) => {
    const minY = Math.max(0, Math.floor(Math.min(...points.map((point) => point[1]))));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(...points.map((point) => point[1]))));
    const minX = Math.max(0, Math.floor(Math.min(...points.map((point) => point[0]))));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(...points.map((point) => point[0]))));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        let inside = false;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
          const [xi, yi] = points[i], [xj, yj] = points[j];
          if ((yi > y) !== (yj > y)
              && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) paint(x, y, color);
      }
    }
  };

  // White outer silhouette first, then a slightly inset blue vessel. The long
  // horizontal cabin and four-window row are unmistakably a ferry side view.
  rect(35, 2, 40, 10, white);
  roundedRect(22, 6, 50, 17, 4, white);
  roundedRect(11, 13, 59, 31, 5, white);
  polygon([[5, 27], [75, 27], [65, 43], [18, 43]], white);

  rect(37, 3, 38, 10, blue);
  roundedRect(25, 9, 47, 18, 2, blue);
  roundedRect(14, 16, 57, 29, 3, blue);
  polygon([[10, 30], [70, 30], [62, 39], [21, 39]], blue);
  rect(18, 19, 25, 23, white);
  rect(29, 19, 36, 23, white);
  rect(40, 19, 47, 23, white);
  rect(51, 19, 55, 23, white);
  rect(13, 27, 66, 29, white);

  // Two broken wave rows keep the symbol nautical without putting it inside
  // another enclosing shape.
  for (const [left, right] of [[11, 25], [30, 45], [50, 67]]) rect(left, 45, right, 47, white);
  for (const [left, right] of [[13, 25], [31, 45], [51, 65]]) rect(left, 45, right, 45, blue);
  targetMap.addImage(imageId, { width, height, data }, { pixelRatio: 2 });
}

/* ------------------------------------------- the two route-line motions */
// Motion has two axes on a line: ACROSS it and ALONG it. There are exactly two
// verdicts that move, so each gets one axis and never the other. That is the
// whole mechanism -- a rider tells them apart by the KIND of motion, with no
// amplitude to compare.
//
// The two effects are written below as effects, named for what they do and
// taking the layer they drive. Which verdict gets which is decided in
// setRoutePulses() and nowhere else, so swapping them is one edit there rather
// than a rename through this whole block. They have been swapped once already.
//
// Neither animates the verdict line's own opacity: fading translucent red or
// amber over the basemap turns it muddy, which is how a rule failure ends up
// looking like an unpaved or designated-route pattern. The halo is its own
// layer under the white casing so its opacity never crosses the line colour.
let detailSelectionPulseTimer = null;
// Radians per 80 ms tick. A full throb is half a sine period, so this is about
// 1.6 s end to end.
const ROUTE_PULSE_STEP = 0.165;

/* --- effect one: a halo that swells sideways out of a still, solid line --- */
// Resting geometry in one place so the pulse and the stop-the-pulse path cannot
// drift apart.
const HALO_REST = { width: 15, opacity: 0.34, blur: 3.5 };
let haloPulseTimer = null;
// Whether the halo has been moved off its resting values. Under reduced motion
// it gets widened without a timer ever existing, so the timer cannot be the
// thing that says "there is something to put back" -- and a route with no such
// segment should not have that layer painted at all.
let haloRaised = false;
function stopHalo(layerId) {
  haloRaised = false;
  if (!map.getLayer(layerId)) return;
  setPaint(layerId, 'line-width', HALO_REST.width);
  setPaint(layerId, 'line-opacity', HALO_REST.opacity);
  setPaint(layerId, 'line-blur', HALO_REST.blur);
}
function setHaloPulse(layerId, on) {
  if (on && !haloPulseTimer) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // The halo is the verdict, not decoration on top of it: hold it wide and
      // steady so the segment still reads without anything moving.
      if (map.getLayer(layerId)) {
        setPaint(layerId, 'line-width', 19);
        setPaint(layerId, 'line-opacity', 0.48);
        setPaint(layerId, 'line-blur', 4);
        haloRaised = true;
      }
      return;
    }
    haloRaised = true;
    let t = 0;
    haloPulseTimer = setInterval(() => {
      t += ROUTE_PULSE_STEP;
      if (!map.getLayer(layerId)) return;
      // Hold still while a solo preview is fading layers. Both write
      // line-opacity, and an 80 ms throb would out-run the eased fade and make
      // this one layer pop back while everything else eases in.
      if (soloPreviewRestore) return;
      const p = Math.abs(Math.sin(t)); // 0..1 throb
      // Width, opacity and blur all rise together, so the halo reads as one
      // thing swelling outward rather than as an edge sliding around.
      setPaint(layerId, 'line-width', 13 + 13 * p);
      setPaint(layerId, 'line-opacity', 0.28 + 0.34 * p);
      // Blur grows more slowly than width on purpose. Matching them spread the
      // halo thin enough to disappear against a busy basemap at full swell.
      setPaint(layerId, 'line-blur', 3 + 4 * p);
    }, 80);
  } else if (!on && (haloPulseTimer || haloRaised)) {
    // Not gated on the timer alone: under reduced motion there is no timer, but
    // the halo was still widened and has to be put back. Gated on something,
    // though -- a clean route should leave the layer untouched rather than
    // painting resting values over it.
    if (haloPulseTimer) clearInterval(haloPulseTimer);
    haloPulseTimer = null;
    // Leave the halo at its resting size rather than wherever the last tick
    // happened to stop.
    stopHalo(layerId);
  }
}

/* --- effect two: perpendicular ticks that travel along the line ---------- */
// Movement comes from cycling the dash pattern rather than a dash offset, which
// MapLibre has no paint property for. Each frame shifts the gap a little
// further along, and the pattern repeats seamlessly at the end of the cycle.
const TICK_FRAMES = (() => {
  const frames = [];
  const period = 4;      // tick + gap, in line widths
  const tick = 1;        // the tick itself
  const steps = 8;
  for (let i = 0; i < steps; i++) {
    const lead = (period * i) / steps;   // grows, walking the tick forward
    frames.push([lead, tick, Math.max(0.01, period - tick - lead)]);
  }
  return frames;
})();
let tickCrawlTimer = null;
function setTickCrawl(layerId, on) {
  if (on && !tickCrawlTimer) {
    let frame = 0;
    tickCrawlTimer = setInterval(() => {
      if (!map.getLayer(layerId)) return;
      if (soloPreviewRestore) return;   // see setHaloPulse
      setPaint(layerId, 'line-dasharray',
        TICK_FRAMES[frame % TICK_FRAMES.length]);
      frame++;
    }, 110);
  } else if (!on && tickCrawlTimer) {
    clearInterval(tickCrawlTimer);
    tickCrawlTimer = null;
    if (map.getLayer(layerId)) {
      // At rest it keeps the ticks -- the texture carries the verdict whether or
      // not anything is moving, which is what makes it legible in a screenshot.
      setPaint(layerId, 'line-dasharray', TICK_FRAMES[0]);
    }
  }
}

/* --- which verdict gets which -------------------------------------------- */
// A CAUTION radiates: solid amber line, still, with a halo breathing out of it.
// A FAILURE marches: red ticks travelling along the line.
//
// One call site for both, so a route can never leave one animating and the
// other stopped. The layers referenced here must match the caps and dash set on
// them where they are added -- ticks need butt caps or a short tick smears into
// a lozenge, and a solid line wants round caps.
const HALO_LAYER = 'route-caution-glow';
const TICK_LAYER = 'route-fail';
function setRoutePulses(renderData) {
  const features = (renderData && renderData.features) || [];
  const has = (style) => features.some((f) => f.properties.style === style);
  setHaloPulse(HALO_LAYER, has('caution'));
  setTickCrawl(TICK_LAYER, has('fail'));
}

// A report-item selection should retain the segment's own safety color. Pulse
// a warm halo underneath the route rather than masking its center with white;
// the latter made unpaved cross-slats resemble railway sleepers.
function setDetailSelectionPulse(on) {
  if (on && !detailSelectionPulseTimer) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      if (map.getLayer('route-detail-highlight')) {
        setPaint('route-detail-highlight', 'line-opacity', 0.55);
      }
      return;
    }
    let t = 0;
    detailSelectionPulseTimer = setInterval(() => {
      if (!map.getLayer('route-detail-highlight')) return;
      t += 0.16;
      const p = Math.abs(Math.sin(t));
      setPaint('route-detail-highlight', 'line-opacity', 0.35 + 0.35 * p);
      setPaint('route-detail-highlight', 'line-width', 15 + 4 * p);
    }, 80);
  } else if (!on) {
    if (detailSelectionPulseTimer) clearInterval(detailSelectionPulseTimer);
    detailSelectionPulseTimer = null;
    if (map.getLayer('route-detail-highlight')) {
      setPaint('route-detail-highlight', 'line-opacity', 0.45);
      setPaint('route-detail-highlight', 'line-width', 16);
    }
  }
}

function drawRoute(coords, ferrySegs, segs) {
  routeIsDisplayed = Array.isArray(coords) && coords.length >= 2;
  clearRouteHighlight();
  const data = { type: 'Feature', properties: {},
    geometry: { type: 'LineString', coordinates: coords } };
  // Ferry legs are drawn as white dashes on top of the route line, so the
  // crossing reads as "not riding" at a glance.
  const fdata = { type: 'FeatureCollection', features: (ferrySegs || []).map((c) => ({
    type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c } })) };
  // Per-edge segments with graph attrs feed the invisible tap target.
  const sdata = { type: 'FeatureCollection', features: (segs || []).map((s, routeIndex) => {
    const props = routeSegProps(s, routeIndex);
    // Score the very properties the card will read, so the level baked into the
    // feature is the level the card recomputes from it.
    props.level = s.level ?? effectiveLevel(scoreRouteSeg(props));
    props.hwy = isHighwaySegment(s) ? 1 : 0;
    return {
      type: 'Feature',
      properties: props,
      geometry: { type: 'LineString', coordinates: coords.slice(s.c0, s.c1 + 1) },
    };
  }) };
  const renderData = buildRouteRenderData(sdata);
  const unpavedData = buildRouteUnpavedData(sdata);
  const routeMarkers = buildRouteMarkerData(sdata);
  const ferryMarkerData = buildRouteFerryMarkerData(ferrySegs);
  // Failing portions (scored live against the current rules) pulse red on top.
  // These use the same merged geometry as the visible route so their dashes
  // remain continuous rather than restarting at every graph edge.
  const failData = { type: 'FeatureCollection',
    features: renderData.features.filter((f) => f.properties.style === 'fail') };
  const emptyHighlights = { type: 'FeatureCollection', features: [] };
  const emptyLine = { type: 'FeatureCollection', features: [] };
  const designatedData = buildRouteDesignatedData(sdata);
  const srcExisting = map.getSource('route');
  if (srcExisting) {
    srcExisting.setData(data);
    map.getSource('route-ferry').setData(fdata);
    map.getSource('route-seg').setData(sdata);
    map.getSource('route-render').setData(renderData);
    map.getSource('route-fail').setData(failData);
    map.getSource('route-unpaved').setData(unpavedData);
    map.getSource('route-designated').setData(designatedData);
    map.getSource('route-dismount').setData(routeMarkers.walk);
    map.getSource('route-marker').setData(routeMarkers.other);
    map.getSource('route-ferry-marker').setData(ferryMarkerData);
    map.getSource('route-highlight-marker').setData(emptyHighlights);
    map.getSource('route-detail-marker').setData(emptyHighlights);
    map.getSource('route-detail-selection').setData(emptyLine);
    map.getSource('route-progress').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } });
    setRoutePulses(renderData);
    applyDisplayModeAll();
    return;
  }
  map.addSource('route', { type: 'geojson', data });
  map.addSource('route-ferry', { type: 'geojson', data: fdata });
  map.addSource('route-seg', { type: 'geojson', data: sdata });
  map.addSource('route-render', { type: 'geojson', data: renderData });
  map.addSource('route-fail', { type: 'geojson', data: failData });
  map.addSource('route-unpaved', { type: 'geojson', data: unpavedData });
  map.addSource('route-designated', { type: 'geojson', data: designatedData });
  map.addSource('route-dismount', { type: 'geojson', data: routeMarkers.walk });
  map.addSource('route-marker', { type: 'geojson', data: routeMarkers.other });
  map.addSource('route-ferry-marker', { type: 'geojson', data: ferryMarkerData });
  map.addSource('route-highlight-marker', { type: 'geojson', data: emptyHighlights });
  map.addSource('route-detail-marker', { type: 'geojson', data: emptyHighlights });
  map.addSource('route-detail-selection', { type: 'geojson', data: emptyLine });
  map.addSource('route-connector', { type: 'geojson', data: {
    type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] },
  } });
  map.addSource('route-progress', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } } });
  // The optional route-to-start remains a separate violet line. It sits under
  // the planned route so their meeting point reads as a clean handoff rather
  // than changing the planned route's safety colors.
  forgetStyleValues(); map.addLayer({
    id: 'route-connector-casing', type: 'line', source: 'route-connector',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 10, 'line-opacity': 0.96 },
  });
  forgetStyleValues(); map.addLayer({
    id: 'route-connector', type: 'line', source: 'route-connector',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#7b2cbf', 'line-width': 6, 'line-opacity': 1,
             'line-dasharray': [2.2, 1.15] },
  });
  forgetStyleValues(); map.addLayer({
    id: 'route-shadow', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    // This is also an opaque-enough mask for background safety sources. State
    // highway geometry comes from WSDOT while the route follows OSM, and tiny
    // centerline differences otherwise leave a confusing second colored line
    // peeking out alongside the selected route.
    paint: { 'line-color': '#102a43', 'line-width': 17, 'line-opacity': 0.78,
             'line-blur': 0.55 },
  });
  // Between the shadow and the white casing, deliberately.
  //
  // Added after the verdict layers it was previously ahead of, it was still
  // beneath them -- but it was also drawn over route-casing, the 12.5 px white
  // line that separates the route from whatever it crosses. At 26 px it
  // swallowed that casing whole, so on a signed stretch the route line sat
  // straight on dark green and read as darkened. It was an underlay in stacking
  // order and an overlay to the eye.
  //
  // Here the casing draws back over it, so the route looks the same as it does
  // anywhere else and the green shows only beyond the casing's edge -- which is
  // the whole of what a band should be.
  forgetStyleValues(); map.addLayer({
    id: 'route-designated-band', type: 'line', source: 'route-designated',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': DESIGNATED_COLOR,
      'line-opacity': 0.85,
      // Narrower than it was. The visible green is whatever exceeds the 12.5 px
      // casing, so 20 px leaves a ~3.75 px edge each side: enough to read, not
      // enough to compete with the verdict colour it is context for.
      'line-width': ['interpolate', ['linear'], ['zoom'],
        6, 7, 10, 12, 14, 20],
    },
  });
  forgetStyleValues(); map.addLayer({
    id: 'route-casing', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 12.5, 'line-opacity': 0.99 },
  });
  const routeVerdictPaint = (color) => ({
    'line-color': color, 'line-width': 6.5, 'line-opacity': 1,
  });
  forgetStyleValues(); map.addLayer({
    id: 'route-pass', type: 'line', source: 'route-render',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: routeVerdictPaint(COLORS[1]),
    filter: ['==', ['get', 'style'], 'pass'],
  });
  forgetStyleValues(); map.addLayer({
    id: 'route-bike', type: 'line', source: 'route-render',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: routeVerdictPaint(BIKE_NETWORK_COLOR),
    filter: ['==', ['get', 'style'], 'bike'],
  });
  forgetStyleValues(); map.addLayer({
    id: 'route-bike-trail', type: 'line', source: 'route-render',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { ...routeVerdictPaint(BIKE_NETWORK_COLOR), 'line-width': 7.2 },
    filter: ['==', ['get', 'style'], 'trail'],
  });
  forgetStyleValues(); map.addLayer({
    id: 'route-bike-trail-dots', type: 'line', source: 'route-render',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#687d00', 'line-width': 2.2, 'line-opacity': 0.96,
             'line-dasharray': [0.05, 2.1] },
    filter: ['==', ['get', 'style'], 'trail'],
  });
  // A white casing under the caution line, pulsed with it. Width alone on an
  // amber line over a busy basemap was too easy to miss; the casing is most of
  // why the failure throb reads from across the screen.
  // The breathing halo, under the white casing so it rings the line rather than
  // washing over it. This is the whole of the caution animation -- see
  // setHaloPulse for why the line itself does not move.
  forgetStyleValues(); map.addLayer({
    id: 'route-caution-glow', type: 'line', source: 'route-render',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': COLORS[3], 'line-width': HALO_REST.width,
             'line-opacity': HALO_REST.opacity, 'line-blur': HALO_REST.blur },
    filter: ['==', ['get', 'style'], 'caution'],
  });
  forgetStyleValues(); map.addLayer({
    id: 'route-caution-casing', type: 'line', source: 'route-render',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    // Solid and still. The casing is what the halo is read against, so it must
    // not move with it.
    paint: { 'line-color': '#ffffff', 'line-width': 10.5, 'line-opacity': 0.9 },
    filter: ['==', ['get', 'style'], 'caution'],
  });
  forgetStyleValues(); map.addLayer({
    id: 'route-caution', type: 'line', source: 'route-render',
    // Round caps for a solid line. Butt caps were here for the travelling
    // ticks; the ticks now belong to the failure.
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: routeVerdictPaint(COLORS[3]),
    filter: ['==', ['get', 'style'], 'caution'],
  });
  forgetStyleValues(); map.addLayer({
    id: 'route-unknown', type: 'line', source: 'route-render',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: routeVerdictPaint(COLORS[0]),
    filter: ['==', ['get', 'style'], 'unknown'],
  });
  forgetStyleValues(); map.addLayer({
    id: 'route-fail-casing', type: 'line', source: 'route-fail',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    // Solid and still: the casing is what the travelling ticks are read
    // against, so it must not move with them.
    paint: { 'line-color': '#ffffff', 'line-width': 12, 'line-opacity': 0.8 },
  });
  forgetStyleValues(); map.addLayer({
    id: 'route-fail', type: 'line', source: 'route-fail',
    // Butt caps, not round: round caps smear a short tick into a lozenge and
    // the pattern stops reading as rungs across the road.
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: { 'line-color': COLORS[4], 'line-width': 6.5, 'line-opacity': 0.96,
             'line-dasharray': TICK_FRAMES[0] },
  });
  ensureUnpavedSlatImage(map);
  ensureDismountMarkerImage(map);
  ensureRouteMarkerImages(map);
  ensureFerryMarkerImage(map);
  forgetStyleValues(); map.addLayer({
    id: 'route-unpaved-slats', type: 'symbol', source: 'route-unpaved',
    layout: {
      'symbol-placement': 'line', 'symbol-spacing': 10,
      'icon-image': 'route-unpaved-slats',
      'icon-size': ['interpolate', ['linear'], ['zoom'],
        5, 0.55, 7, 0.6, 9, 0.68, 11, 0.76, 13, 0.84, 15, 0.9],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true, 'icon-rotation-alignment': 'map',
      'icon-pitch-alignment': 'map', 'icon-keep-upright': false,
    },
    paint: { 'icon-opacity': 0.7 },
  });
  // Below the walk marker: where a stretch is both walked and something
  // else, the planner already picked one kind per slot; layer order only
  // decides rare exact overlaps, and the access instruction wins those.
  forgetStyleValues(); map.addLayer({
    id: 'route-marker', type: 'symbol', source: 'route-marker',
    layout: {
      'icon-image': ['concat', 'route-marker-', ['get', 'kind']],
      'icon-size': ROUTE_MARKER_SIZE_BY_ZOOM,
      // allow-overlap false is the crowding control: the symbol placer culls
      // whatever would collide, so zooming out thins the chain instead of
      // piling badges on badges. The slot sort key keeps the culling stable
      // across zooms -- without it, which marker survives is arbitrary and a
      // spot flickers between kinds as the rider zooms.
      'icon-allow-overlap': false, 'icon-ignore-placement': false,
      'symbol-sort-key': ['get', 'slot'],
    },
  });
  forgetStyleValues(); map.addLayer({
    id: 'route-dismount-halo', type: 'circle', source: 'route-dismount',
    // The marker's TAP TARGET, not a visual: featureAt() widens its search
    // when a tap lands inside this circle. The cream disc it used to draw
    // made the walker read twice the size of its sibling badges.
    paint: { 'circle-radius': DISMOUNT_MARKER_HIT_PX, 'circle-color': '#fff7d6',
      'circle-opacity': 0, 'circle-stroke-width': 0 },
  });
  forgetStyleValues(); map.addLayer({
    id: 'route-dismount-marker', type: 'symbol', source: 'route-dismount',
    layout: { 'icon-image': 'route-dismount-marker-icon',
      'icon-size': ROUTE_MARKER_SIZE_BY_ZOOM,
      'icon-allow-overlap': false, 'icon-ignore-placement': false,
      'symbol-sort-key': ['get', 'slot'] },
  });
  forgetStyleValues(); map.addLayer({
    id: 'route-ferry', type: 'line', source: 'route-ferry',
    paint: { 'line-color': '#ffffff', 'line-width': 5, 'line-opacity': 0.9,
             'line-dasharray': [0.6, 1.8] },
  });
  forgetStyleValues(); map.addLayer({
    id: 'route-ferry-marker', type: 'symbol', source: 'route-ferry-marker',
    layout: { 'icon-image': 'route-ferry-marker-icon', 'icon-size': 1,
      'icon-allow-overlap': true, 'icon-ignore-placement': true },
  });
  setRoutePulses(renderData);
  // Ridden portion of the route darkens during navigation.
  forgetStyleValues(); map.addLayer({
    id: 'route-progress', type: 'line', source: 'route-progress',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#17262f', 'line-width': 7.6, 'line-opacity': 0.26 },
  });
  forgetStyleValues(); map.addLayer({
    id: 'route-highlight-halo', type: 'line', source: 'route-seg',
    layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
    paint: { 'line-color': '#fff4a3', 'line-width': 16, 'line-opacity': 0.78,
             'line-blur': 2 },
  });
  forgetStyleValues(); map.addLayer({
    id: 'route-highlight', type: 'line', source: 'route-seg',
    layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
    paint: { 'line-color': '#ffd400', 'line-width': 8, 'line-opacity': 1 },
  });
  forgetStyleValues(); map.addLayer({
    id: 'route-detail-highlight', type: 'line', source: 'route-detail-selection',
    layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
    paint: { 'line-color': '#ffd45c', 'line-width': 16, 'line-opacity': 0.45,
             'line-blur': 1.4 },
  }, 'route-pass');
  // A short highlighted edge can be less than a pixel long at the current
  // zoom. One marker per contiguous highlighted stretch gives it an obvious
  // location without filling long stretches with repeated dots.
  forgetStyleValues(); map.addLayer({
    id: 'route-highlight-marker-halo', type: 'circle', source: 'route-highlight-marker',
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 12, 10, 14, 14, 17],
      'circle-color': '#fff4a3', 'circle-opacity': 0.92, 'circle-blur': 0.18,
    },
  });
  forgetStyleValues(); map.addLayer({
    id: 'route-detail-marker-halo', type: 'circle', source: 'route-detail-marker',
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 11, 10, 13, 14, 16],
      'circle-color': '#1f2933', 'circle-opacity': 0.86,
    },
  });
  forgetStyleValues(); map.addLayer({
    id: 'route-detail-marker', type: 'circle', source: 'route-detail-marker',
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 6, 10, 7, 14, 9],
      'circle-color': '#ffffff', 'circle-opacity': 1,
    },
  });
  forgetStyleValues(); map.addLayer({
    id: 'route-highlight-marker', type: 'circle', source: 'route-highlight-marker',
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 7, 10, 8, 14, 10],
      'circle-color': '#ffd400', 'circle-stroke-color': '#735b00',
      'circle-stroke-width': 2, 'circle-opacity': 1,
    },
  });
  // Invisible wide tap target over the route — topmost, so tapping the route
  // inspects the route segment rather than whatever layer is underneath.
  forgetStyleValues(); map.addLayer({
    id: 'route-seg-hit', type: 'line', source: 'route-seg',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#000', 'line-opacity': 0,
             'line-width': ['interpolate', ['linear'], ['zoom'], 6, 8, 12, 14, 16, 22] },
  });
  attachHover(ROUTESEG_SRC, 'route-seg-hit');
  applyDisplayModeAll();
}

let routeHighlightKey = null;
const ROUTE_HIGHLIGHT_FILTERS = {
  'bike-network': ['any', ['==', ['get', 'desig'], 1], ['==', ['get', 'infra'], 1], ['>=', ['get', 'facility'], 2]],
  highway: ['==', ['get', 'hwy'], 1],
  freeway: ['==', ['get', 'fw'], 1],
  'limited-access': ['==', ['get', 'lim'], 1],
  'curve-hazard': ['>', ['get', 'hazard'], 0],
  'level-1': ['==', ['get', 'level'], 1],
  'level-3': ['==', ['get', 'level'], 3],
  'level-4': ['==', ['get', 'level'], 4],
};

function routeSegmentMatchesHighlight(seg, key) {
  const flags = seg.flags || 0;
  const level = seg.level || fallbackRouteLevel(seg);
  if (key === 'bike-network') return !!(flags & (8 | 64)) || (seg.facility || 0) >= 1;
  if (key === 'highway') return isHighwaySegment(seg);
  if (key === 'freeway') return !!(flags & 4);
  if (key === 'limited-access') return !!(flags & 128);
  if (key === 'curve-hazard') return !!seg.hazard;
  const levelMatch = /^level-(\d)$/.exec(key);
  return !!levelMatch && level === Number(levelMatch[1]);
}

function routeHighlightMarkers(key) {
  const route = routing.last;
  if (!route?.coords?.length || !route.segs?.length) return [];
  const groups = [];
  let group = null;
  for (let index = 0; index < route.segs.length; index++) {
    const seg = route.segs[index];
    if (!routeSegmentMatchesHighlight(seg, key)) {
      group = null;
      continue;
    }
    if (group && group.lastIndex === index - 1 && seg.c0 <= group.c1 + 1) {
      group.c1 = seg.c1;
      group.lastIndex = index;
      continue;
    }
    group = { c0: seg.c0, c1: seg.c1, lastIndex: index };
    groups.push(group);
  }
  return groups.map((g) => ({
    type: 'Feature', properties: {},
    geometry: { type: 'Point', coordinates: route.coords[Math.round((g.c0 + g.c1) / 2)] },
  })).filter((f) => Array.isArray(f.geometry.coordinates));
}

function clearRouteHighlight() {
  setDetailSelectionPulse(false);
  routeHighlightKey = null;
  for (const id of ['route-highlight-halo', 'route-highlight', 'route-detail-highlight-halo',
    'route-detail-highlight', 'route-highlight-marker-halo', 'route-highlight-marker',
    'route-detail-marker-halo', 'route-detail-marker']) {
    if (map.getLayer(id)) setLayout(id, 'visibility', 'none');
  }
  document.querySelectorAll('[data-highlight]').forEach((b) => {
    b.classList.remove('active');
    b.setAttribute('aria-pressed', 'false');
  });
}

function toggleRouteHighlight(key) {
  if (!ROUTE_HIGHLIGHT_FILTERS[key] || !map.getLayer('route-highlight')) return;
  if (routeHighlightKey === key) { clearRouteHighlight(); return; }
  routeHighlightKey = key;
  for (const id of ['route-highlight-halo', 'route-highlight']) {
    setLayerFilter(id, ROUTE_HIGHLIGHT_FILTERS[key]);
    setLayout(id, 'visibility', 'visible');
  }
  const markerFeatures = routeHighlightMarkers(key);
  const markerSource = map.getSource('route-highlight-marker');
  if (markerSource) markerSource.setData({ type: 'FeatureCollection', features: markerFeatures });
  for (const id of ['route-highlight-marker-halo', 'route-highlight-marker']) {
    if (map.getLayer(id)) setLayout(id, 'visibility', markerFeatures.length ? 'visible' : 'none');
  }
  document.querySelectorAll('[data-highlight]').forEach((b) => {
    const active = b.dataset.highlight === key;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
}

function showRouteStepOnMap(startIndex, endIndex, coordStart = null, coordEnd = null) {
  const route = routing.last;
  startIndex = Math.trunc(Number(startIndex));
  endIndex = Math.trunc(Number(endIndex));
  if (!route?.ok || !route.segs?.length || !map.getLayer('route-highlight')
      || !Number.isFinite(startIndex) || !Number.isFinite(endIndex)) return;
  startIndex = Math.max(0, Math.min(startIndex, route.segs.length - 1));
  endIndex = Math.max(startIndex, Math.min(endIndex, route.segs.length - 1));
  clearRouteHighlight();
  routeHighlightKey = `step:${startIndex}:${endIndex}`;
  const first = route.segs[startIndex];
  const last = route.segs[endIndex];
  // A report item only supplies a narrowed coordinate range when it has one
  // (for example, an uphill-curve concern).  `Number(null)` is 0, so testing
  // Number.isFinite alone used to turn ordinary report items into a selection
  // of the very first route coordinate.  Fall back to the selected graph-edge
  // range instead, then make even a one-point range visibly selectable.
  const suppliedStart = coordStart != null && coordStart !== '' && Number.isFinite(Number(coordStart));
  const suppliedEnd = coordEnd != null && coordEnd !== '' && Number.isFinite(Number(coordEnd));
  let selectedStart = suppliedStart ? Math.trunc(Number(coordStart)) : first.c0;
  let selectedEnd = suppliedEnd ? Math.trunc(Number(coordEnd)) : last.c1;
  selectedStart = Math.max(0, Math.min(selectedStart, route.coords.length - 1));
  selectedEnd = Math.max(selectedStart, Math.min(selectedEnd, route.coords.length - 1));
  if (selectedEnd === selectedStart && route.coords.length > 1) {
    if (selectedEnd < route.coords.length - 1) selectedEnd++;
    else selectedStart--;
  }
  const selected = route.coords.slice(selectedStart, selectedEnd + 1);
  const selectionSource = map.getSource('route-detail-selection');
  if (selectionSource && selected.length >= 2) selectionSource.setData({
    type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: selected },
  });
  for (const id of ['route-detail-highlight-halo', 'route-detail-highlight']) {
    if (map.getLayer(id)) setLayout(id, 'visibility', selected.length >= 2 ? 'visible' : 'none');
  }
  const markerPoint = selected[Math.floor(selected.length / 2)];
  const markerSource = map.getSource('route-detail-marker');
  if (markerSource && markerPoint) markerSource.setData({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: markerPoint } }],
  });
  for (const id of ['route-detail-marker-halo', 'route-detail-marker']) {
    if (map.getLayer(id)) setLayout(id, 'visibility', markerPoint ? 'visible' : 'none');
  }
  setDetailSelectionPulse(selected.length >= 2);

  const dialog = document.getElementById('routeDetailsDialog');
  if (dialog?.open) dialog.close();
  suppressRoadInfo(900);
  // Restore the panel state from before Details opened. This keeps Choose
  // Route open during route comparison without opening it over active
  // navigation when Details came from the navigation banner.
  if (mobileNavMedia.matches) setPanelOpen(routeDetailsPanelWasOpen);
  if (!selected.length) return;
  requestAnimationFrame(() => {
    const openPanelHeight = mobileNavMedia.matches && document.body.classList.contains('panel-open')
      ? Math.ceil(document.getElementById('panel')?.getBoundingClientRect().height || 0) : 0;
    if (selected.length === 1) {
      map.easeTo({ center: selected[0], zoom: Math.max(map.getZoom(), 15), duration: 450 });
      return;
    }
    const bounds = new maplibregl.LngLatBounds(selected[0], selected[0]);
    for (const coordinate of selected.slice(1)) bounds.extend(coordinate);
    map.fitBounds(bounds, {
      padding: mobileNavMedia.matches
        ? { top: 90, right: 45, bottom: Math.max(90, openPanelHeight + 45), left: 45 }
        : { top: 80, right: 70, bottom: 80, left: 470 },
      maxZoom: 16,
      duration: 500,
    });
  });
}

function consumePendingRouteStepHighlight() {
  let pending = null;
  try {
    pending = JSON.parse(sessionStorage.getItem('wa-bike-step-highlight') || 'null');
    if (pending) sessionStorage.removeItem('wa-bike-step-highlight');
  } catch (e) { /* nonfatal */ }
  if (pending?.type === 'highlight-route-step') {
    requestAnimationFrame(() => showRouteStepOnMap(pending.startIndex, pending.endIndex,
      pending.coordStart, pending.coordEnd));
  }
}

function routeEndpointDisplayName(kind) {
  if (!routing[kind]) return kind === 'start' ? 'Choose start' : 'Choose destination';
  return normalizeEndpointName(routing[`${kind}Name`]) || 'Point on map';
}

function clearWaypointsForEndpointChange(kind, lngLat) {
  const previous = routing[kind];
  const changed = Array.isArray(previous)
    && (previous[0] !== lngLat.lng || previous[1] !== lngLat.lat);
  if (!changed || !routing.vias.length) return false;
  for (const via of routing.vias) via.marker.remove();
  routing.vias = [];
  if (routing.arm === 'via') routing.arm = null;
  return true;
}

function setRoutePoint(kind, lngLat, name = 'Point on map', { fromDevice = false } = {}) {
  exitSharedRoute();
  const previous = routing[kind];
  if (!Array.isArray(previous) || previous[0] !== lngLat.lng || previous[1] !== lngLat.lat) {
    routing.selectRecommendedNext = true;
    // A new start or destination is a new trip, and a remix does not survive
    // it. Waypoints and road blocks never come through here -- they refine
    // the same trip and keep both the remix and the selected route.
    routing.remix = 'recommended';
  }
  clearWaypointsForEndpointChange(kind, lngLat);
  routing[kind] = [lngLat.lng, lngLat.lat];
  routing[`${kind}Name`] = normalizeEndpointName(name) || 'Point on map';
  // A start taken from the device is a statement about where the rider IS. A
  // start they tapped or searched for is a place they chose, and must not move
  // under them. Only the first kind follows.
  if (kind === 'start') routing.startFromDevice = !!fromDevice;
  const mk = kind + 'Marker';
  if (routing[mk]) routing[mk].setLngLat(lngLat);
  else {
    const touchEndpoint = window.matchMedia('(pointer: coarse)').matches;
    routing[mk] = new maplibregl.Marker({
      color: kind === 'start' ? '#0072B2' : '#D55E00', draggable: !touchEndpoint,
    }).setLngLat(lngLat).addTo(map);
    if (touchEndpoint) enableLongPressEndpointMove(kind, routing[mk]);
    else routing[mk].on('dragend', () => {
        const ll = routing[mk].getLngLat();
        setRoutePoint(kind, ll);
      });
  }
  computeRoute();
  updateArmButtons();
  if (kind === 'end') refreshDeviceStartForNewDestination();
}

/* A start set from "use my location" goes stale the moment the rider moves,
 * and nothing used to notice. Stop a ride that began where you were standing,
 * pick a new destination an hour later and twenty miles away, and the route is
 * drawn from where you were standing -- a plan with no relation to the rider,
 * offered without a word.
 *
 * So choosing a new destination re-reads the position, and only for a start
 * that came from the device in the first place. A start the rider tapped or
 * searched for is a decision, and decisions are not overwritten.
 *
 * The route from the old start is still calculated straight away rather than
 * waiting: a fix can take fifteen seconds or never arrive, and an immediate
 * answer that corrects itself beats a blank screen that might not.
 */
const DEVICE_START_MOVED_M = 30;
let deviceStartRequest = 0;
async function refreshDeviceStartForNewDestination() {
  // Navigation owns the origin while it is running, and a shared link is
  // someone else's plan.
  if (!routing.startFromDevice || turnNav.active || routing.sharedLoading) return;
  const request = ++deviceStartRequest;
  // The toast rather than the status line: computeRoute() owns the status line
  // and writes over it the moment the route comes back, which is exactly when
  // this has something to report.
  showRouteActionToast('Updating start to your location…', { busy: true, duration: 0 });
  try {
    const pos = await getFreshDevicePosition();
    if (request !== deviceStartRequest || !routing.startFromDevice) return;
    const lngLat = { lng: pos.coords.longitude, lat: pos.coords.latitude };
    if (Array.isArray(routing.start)
        && navDistanceM(routing.start, [lngLat.lng, lngLat.lat]) <= DEVICE_START_MOVED_M) {
      showRouteActionToast('');
      return;
    }
    setRoutePoint('start', lngLat, 'My location', { fromDevice: true });
    showRouteActionToast('Start moved to your location', { duration: 4000 });
  } catch (e) {
    if (request !== deviceStartRequest) return;
    // Say so. Silence here is what produced the original fault: a route from
    // somewhere the rider no longer was, presented as though it were current.
    showRouteActionToast('Could not update your location', {
      detail: 'The route still starts from the pin on the map.', duration: 7000 });
  }
}

function enableLongPressEndpointMove(kind, marker) {
  const el = marker.getElement();
  el.classList.add('endpoint-marker');
  let gesture = null;
  const setMapGesturesEnabled = (enabled, state = {}) => {
    const handlers = [
      ['dragPan', state.dragPan],
      ['touchZoomRotate', state.touchZoomRotate],
    ];
    for (const [name, wasEnabled] of handlers) {
      const handler = map[name];
      if (!handler) continue;
      if (enabled) {
        if (wasEnabled) handler.enable();
      } else if (handler.isEnabled()) {
        handler.disable();
      }
    }
  };
  const pointAt = (x, y) => {
    const rect = map.getCanvas().getBoundingClientRect();
    marker.setLngLat(map.unproject([x - rect.left, y - rect.top]));
  };
  const stop = (commit) => {
    if (!gesture) return;
    const finished = gesture;
    clearTimeout(gesture.timer);
    el.classList.remove('endpoint-moving');
    setMapGesturesEnabled(true, finished.mapGestures);
    if (finished.active && commit) {
      const ll = marker.getLngLat();
      setRoutePoint(kind, ll);
      setRouteStatus(`${kind === 'start' ? 'Start' : 'Destination'} moved`);
      saveStateSoon();
    } else if (finished.active) {
      marker.setLngLat(finished.original);
    }
    gesture = null;
  };
  el.addEventListener('pointerdown', (e) => {
    if (gesture || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    e.stopPropagation();
    const mapGestures = {
      dragPan: map.dragPan?.isEnabled() ?? false,
      touchZoomRotate: map.touchZoomRotate?.isEnabled() ?? false,
    };
    // MapLibre listens above the marker container. Suspend its handlers for
    // the whole press so a held endpoint can never turn into a map pan.
    setMapGesturesEnabled(false);
    map.stop();
    el.setPointerCapture(e.pointerId);
    gesture = {
      id: e.pointerId, x: e.clientX, y: e.clientY,
      lastX: e.clientX, lastY: e.clientY, active: false,
      original: marker.getLngLat(), mapGestures, timer: null,
    };
    gesture.timer = setTimeout(() => {
      if (!gesture) return;
      gesture.active = true;
      el.classList.add('endpoint-moving');
      pointAt(gesture.lastX, gesture.lastY);
      navigator.vibrate?.(20);
      setRouteStatus(`Move ${kind === 'start' ? 'START' : 'DESTINATION'} marker`);
    }, 550);
  }, { capture: true });
  el.addEventListener('pointermove', (e) => {
    if (!gesture || e.pointerId !== gesture.id) return;
    e.preventDefault();
    e.stopPropagation();
    gesture.lastX = e.clientX;
    gesture.lastY = e.clientY;
    if (!gesture.active) {
      // Allow for the small amount a finger naturally wanders while held.
      // A deliberate early drag cancels the long press but still must not pan
      // the map from underneath an endpoint marker.
      if (Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > 24) stop(false);
      return;
    }
    pointAt(e.clientX, e.clientY);
  }, { capture: true });
  el.addEventListener('pointerup', (e) => {
    if (!gesture || e.pointerId !== gesture.id) return;
    e.preventDefault();
    e.stopPropagation();
    stop(true);
  }, { capture: true });
  el.addEventListener('pointercancel', () => stop(false));
  el.addEventListener('lostpointercapture', () => stop(false));
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

let pendingRouteMarkerRemoval = null;

function promptRemoveRouteMarker(kind, item) {
  const label = kind === 'via' ? 'waypoint' : 'road block';
  const dialog = document.getElementById('removeRouteMarkerDialog');
  if (dialog?.showModal) {
    pendingRouteMarkerRemoval = { kind, item };
    document.getElementById('removeRouteMarkerTitle').textContent = `Remove ${label}?`;
    document.getElementById('removeRouteMarkerText').textContent = kind === 'via'
      ? 'This waypoint will be removed and the route recalculated.'
      : 'This road block will be removed and the route recalculated.';
    document.getElementById('confirmRemoveRouteMarker').textContent = `Remove ${label}`;
    if (!dialog.open) dialog.showModal();
    return;
  }
  if (confirm(`Remove this ${label}?`)) {
    if (kind === 'via') removeVia(item);
    else removeRoadBlock(item);
  }
}

function bindRouteConstraintMarker(marker, kind, item) {
  const label = kind === 'via' ? 'waypoint' : 'road block';
  const el = marker.getElement();
  el.classList.add('route-constraint-marker');
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.setAttribute('aria-label', `Remove ${label}`);
  const prompt = (event) => {
    // A marker sits over the map canvas. Suppress the road inspector before
    // opening its confirmation so the same tap cannot also inspect the road
    // beneath it.
    suppressRoadInfo(1000);
    event.preventDefault();
    event.stopPropagation();
    promptRemoveRouteMarker(kind, item);
  };
  let press = null;
  let suppressClickUntil = 0;
  el.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (event.pointerType === 'touch') suppressRoadInfo(1000);
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  }, { capture: true });
  el.addEventListener('pointermove', (event) => {
    if (!press || event.pointerId !== press.id) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 12) press.moved = true;
  }, { capture: true });
  el.addEventListener('pointerup', (event) => {
    if (!press || event.pointerId !== press.id) return;
    const wasTap = !press.moved;
    press = null;
    if (!wasTap) return; // preserve MapLibre's deliberate marker drag behavior
    // MapLibre can suppress click after a tiny touch movement. Handling the
    // release directly makes a normal phone tap reliably open confirmation.
    suppressClickUntil = Date.now() + 600;
    prompt(event);
  }, { capture: true });
  el.addEventListener('pointercancel', () => { press = null; }, { capture: true });
  el.addEventListener('lostpointercapture', () => { press = null; }, { capture: true });
  // Prevent the canvas's touch handler from seeing the same marker gesture.
  // This is intentionally not preventDefault(), so MapLibre can still drag a
  // marker when the rider moves it deliberately.
  const stopMarkerTouch = (event) => {
    suppressRoadInfo(1000);
    event.stopPropagation();
  };
  el.addEventListener('touchstart', stopMarkerTouch, { passive: true });
  el.addEventListener('touchend', stopMarkerTouch, { passive: true });
  el.addEventListener('click', (event) => {
    if (Date.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    prompt(event);
  });
}

function waypointMarkerElement() {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'waypoint-marker';
  element.innerHTML = '<svg viewBox="0 0 28 42" aria-hidden="true" focusable="false"><path d="M14 1C6.82 1 1 6.82 1 14c0 9.75 13 27 13 27s13-17.25 13-27C27 6.82 21.18 1 14 1Z"/><circle cx="14" cy="14" r="5"/></svg>';
  return element;
}

function addVia(lngLat, { allowPastLimit = false } = {}) {
  exitSharedRoute();
  if (!allowPastLimit && routing.vias.length >= MAX_ROUTE_STOPS) {
    routing.arm = null;
    updateArmButtons();
    setRouteStatus(`A route can have up to ${MAX_ROUTE_STOPS} waypoints`);
    return false;
  }
  const marker = new maplibregl.Marker({
    element: waypointMarkerElement(), anchor: 'bottom', draggable: true,
  })
    .setLngLat(lngLat).addTo(map);
  const via = { pt: [lngLat.lng, lngLat.lat], marker };
  routing.vias.push(via);
  bindRouteConstraintMarker(marker, 'via', via);
  marker.on('dragend', () => {
    const ll = marker.getLngLat();
    via.pt = [ll.lng, ll.lat];
    computeRoute();
  });
  computeRoute();
  updateArmButtons();
  return true;
}

function removeVia(via) {
  const index = routing.vias.indexOf(via);
  if (index < 0) return;
  exitSharedRoute();
  routing.vias.splice(index, 1);
  via.marker.remove();
  if (routing.arm === 'via') routing.arm = null;
  updateArmButtons();
  computeRoute();
  showRouteActionToast('Waypoint removed · recalculating…', { busy: true, duration: 0 });
  saveStateSoon();
}

function roadBlockMarkerElement() {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'road-block-marker';
  element.innerHTML = '<span class="road-block-icon" aria-hidden="true">🚧</span>';
  return element;
}

// A road block is an instruction about the route you are looking at: "not this
// way". A tap a few pixels off the line still means that road, so snap onto the
// drawn route when the tap is within a finger's reach of it. Measured in SCREEN
// pixels, not degrees, so the tolerance is the same at every zoom -- a fixed
// distance in degrees is a city block at z11 and a doorway at z17.
//
// A tap that is genuinely somewhere else is left where it landed: blocking a
// road you are not currently routed over is legitimate, and dragging every
// block onto the route would make that impossible.
const BLOCK_SNAP_PX = 34;
function snapToDrawnRoute(lngLat) {
  const coords = routing.last?.ok ? routing.last.coords : null;
  if (!Array.isArray(coords) || coords.length < 2) return lngLat;
  const point = map.project(lngLat);
  let best = null;
  let bestDistance = Infinity;
  for (let i = 1; i < coords.length; i++) {
    const a = map.project(coords[i - 1]);
    const b = map.project(coords[i]);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    // Projection of the tap onto this segment, clamped to its ends so a tap
    // beyond a segment snaps to its nearer endpoint rather than off into the
    // line's infinite extension.
    let t = lengthSq ? ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq : 0;
    t = Math.max(0, Math.min(1, t));
    const x = a.x + t * dx;
    const y = a.y + t * dy;
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance < bestDistance) { bestDistance = distance; best = { x, y }; }
  }
  if (!best || bestDistance > BLOCK_SNAP_PX) return lngLat;
  return map.unproject([best.x, best.y]);
}

// The block a press of the card's button would land on, if any. Measured from
// the point Add would actually place -- the snapped one -- so the question the
// button answers is exactly "would pressing this again put a second block on
// top of the first?", which is what makes Add/Remove the right pair.
function roadBlockNear(lngLat, withinPx = 30) {
  const target = map.project(snapToDrawnRoute(lngLat));
  let found = null;
  let best = Infinity;
  for (const block of routing.blocks) {
    const p = map.project(block.pt);
    const distance = Math.hypot(p.x - target.x, p.y - target.y);
    if (distance < best && distance <= withinPx) { best = distance; found = block; }
  }
  return found;
}

function addRoadBlock(lngLat, { allowPastLimit = false, snap = true } = {}) {
  if (snap) lngLat = snapToDrawnRoute(lngLat);
  exitSharedRoute();
  if (!allowPastLimit && routing.blocks.length >= MAX_ROAD_BLOCKS) {
    routing.arm = null;
    updateArmButtons();
    setRouteStatus(`A route can have up to ${MAX_ROAD_BLOCKS} road blocks`);
    return false;
  }
  const marker = new maplibregl.Marker({
    element: roadBlockMarkerElement(), anchor: 'bottom', draggable: true,
  }).setLngLat(lngLat).addTo(map);
  const block = { pt: [lngLat.lng, lngLat.lat], marker };
  routing.blocks.push(block);
  bindRouteConstraintMarker(marker, 'block', block);
  marker.on('dragend', () => {
    const ll = marker.getLngLat();
    block.pt = [ll.lng, ll.lat];
    computeRoute();
    saveStateSoon();
  });
  computeRoute();
  updateArmButtons();
  return true;
}

function removeRoadBlock(block) {
  const index = routing.blocks.indexOf(block);
  if (index < 0) return;
  exitSharedRoute();
  routing.blocks.splice(index, 1);
  block.marker.remove();
  if (routing.arm === 'block') routing.arm = null;
  updateArmButtons();
  computeRoute();
  showRouteActionToast('Road block removed · recalculating…', { busy: true, duration: 0 });
  saveStateSoon();
}

function reverseRoute() {
  if (!(routing.start && routing.end)) return;
  exitSharedRoute();
  stopTurnNavigation(false);
  routing.arm = null;
  closePlacePicker(false);
  setRouteActionsOpen(false);

  const start = routing.start;
  const startName = routing.startName;
  routing.start = routing.end;
  routing.startName = routing.endName;
  routing.end = start;
  routing.endName = startName;
  // The position that was the rider's own is now the destination, and the new
  // start is a place. Neither follows the device any more.
  routing.startFromDevice = false;
  routing.vias.reverse();
  routing.startMarker?.setLngLat(routing.start);
  routing.endMarker?.setLngLat(routing.end);
  // Reversing changes both endpoints, and the policy for endpoint changes is
  // a fresh recommendation: the best route northbound is not "whatever letter
  // was selected southbound" -- rankings legitimately differ by direction,
  // and holding a profile across the flip relabeled it mid-air (the rider
  // watched E become D). Waypoints, road blocks and settings changes keep the
  // current choice instead, so their impact on the SAME route stays visible.
  routing.selectRecommendedNext = true;

  clearRouteHighlight();
  updateArmButtons();
  setRouteStatus('Route reversed');
  computeRoute();
  saveStateSoon();
}

function clearRoute() {
  routeIsDisplayed = false;
  exitSharedRoute();
  showRouteActionToast('');
  stopTurnNavigation(false);
  routing.arm = null;
  closePlacePicker(false);
  setRouteActionsOpen(false);
  routing.start = routing.end = null;
  routing.startName = routing.endName = null;
  routing.startFromDevice = false;
  routing.remix = 'recommended';
  routing.pendingRoute = false;
  routing.routeRequestActive = false;
  routing.reqId++; // a route already being calculated must not reappear after clear
  for (const v of routing.vias) v.marker.remove();
  routing.vias = [];
  for (const block of routing.blocks) block.marker.remove();
  routing.blocks = [];
  pendingRouteMarkerRemoval = null;
  for (const k of ['startMarker', 'endMarker']) {
    if (routing[k]) { routing[k].remove(); routing[k] = null; }
  }
  drawRoute([]);
  routing.last = null;
  routing.options = [];
  routing.pinnedLetters = null;
  schedulePrewarm();
  routing.missingLetters = null;
  clearStoredRouteDetails();
  renderRouteOptionControls();
  renderRouteCard(null);
  setRouteStatus('');
  updateArmButtons();
  saveStateSoon();
}

function requestClearRoute() {
  if (!routing.start && !routing.end && routing.vias.length === 0 && routing.blocks.length === 0) return;
  setRouteActionsOpen(false);
  const dialog = document.getElementById('clearRouteDialog');
  if (dialog && !dialog.open) dialog.showModal();
}

function setRouteActionsOpen(open) {
  const menu = document.getElementById('routeActionsMenu');
  const button = document.getElementById('rb-more');
  if (!menu || !button) return;
  const next = Boolean(open && !button.disabled);
  menu.hidden = !next;
  button.setAttribute('aria-expanded', String(next));
}

function updateArmButtons() {
  for (const kind of ['start', 'end', 'via', 'block']) {
    for (const prefix of ['rt-', 'rb-']) {
      const b = document.getElementById(prefix + kind);
      if (b) b.classList.toggle('active', routing.arm === kind);
    }
  }
  for (const kind of ['start', 'end']) {
    const button = document.getElementById(`rb-${kind}`);
    if (!button) continue;
    const isSet = Boolean(routing[kind]);
    const isActive = routing.arm === kind;
    const endpointName = kind === 'start' ? 'start' : 'destination';
    button.classList.toggle('set', isSet);
    if (isActive) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
    button.title = isActive ? `Choosing ${endpointName} — tap the map or search`
      : `${isSet ? 'Change' : 'Set'} ${endpointName}`;
    button.setAttribute('aria-label', button.title);
    button.disabled = false;
    const value = button.querySelector('[data-endpoint-value]');
    if (value) value.textContent = routeEndpointDisplayName(kind);
  }
  const add = document.getElementById('rb-via');
  const block = document.getElementById('rb-road-block');
  const reverse = document.getElementById('rb-reverse');
  const clear = document.getElementById('rb-clear');
  const more = document.getElementById('rb-more');
  if (add) {
    add.disabled = !(routing.start && routing.end) || routing.vias.length >= MAX_ROUTE_STOPS;
    add.title = routing.vias.length >= MAX_ROUTE_STOPS
      ? `Maximum of ${MAX_ROUTE_STOPS} waypoints reached` : 'Add waypoint';
  }
  if (block) {
    block.disabled = !(routing.start && routing.end) || routing.blocks.length >= MAX_ROAD_BLOCKS;
    block.title = routing.blocks.length >= MAX_ROAD_BLOCKS
      ? `Maximum of ${MAX_ROAD_BLOCKS} road blocks reached` : 'Add a road block';
  }
  if (reverse) reverse.disabled = !(routing.start && routing.end);
  if (clear) clear.disabled = !(routing.start || routing.end || routing.vias.length || routing.blocks.length);
  // Keep the menu discoverable before the route is complete. Its individual
  // actions remain disabled until their own requirements are met.
  if (more) more.disabled = false;
}

function syncRoutePreferenceControls() {
  const designated = document.getElementById('r-prefDesig');
  const residential = document.getElementById('r-prefResidential');
  if (designated) designated.checked = routing.prefDesig;
  if (residential) residential.checked = routing.prefResidential;
}

function syncRouteOptionControls() {
  const host = document.getElementById('routeOptions');
  const busy = host?.classList.contains('loading');
  document.querySelectorAll('#routeOptions button[data-route-option]').forEach((button) => {
    const active = Number(button.dataset.routeOption) === routing.options.indexOf(routing.last);
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    button.disabled = busy || turnNav.active;
    button.classList.toggle('nav-locked', turnNav.active);
    button.setAttribute('aria-disabled', String(turnNav.active || busy));
  });
}

function setRouteOptionsLoading(loading) {
  const host = document.getElementById('routeOptions');
  if (!host) return;
  host.classList.toggle('loading', loading);
  host.setAttribute('aria-busy', String(loading));
  const current = host.querySelector('.route-options-loading');
  if (loading && !current) {
    const indicator = document.createElement('span');
    indicator.className = 'route-options-loading';
    indicator.setAttribute('role', 'status');
    indicator.innerHTML = '<span aria-hidden="true"></span>Comparing routes…';
    host.append(indicator);
  } else if (!loading && current) {
    current.remove();
  }
  host.querySelectorAll('button[data-route-option], #routeRemixBtn').forEach((button) => {
    button.disabled = loading || turnNav.active;
  });
  refreshNavigationUI();
}

function renderRouteOptionControls() {
  const host = document.getElementById('routeOptions');
  if (!host) return;
  const detailsButton = document.getElementById('routeDetailsBtn');
  if (detailsButton) detailsButton.disabled = !routing.last?.ok;
  if (!routing.options.length) {
    host.innerHTML = '<span class="route-options-empty">Route choices</span>';
    return;
  }
  // The shared route sits in its own slot after the lettered options, which
  // stay sequential A, B, C, D… by position.
  const sharedInPlay = routing.options.some((o) => o.asShared);
  const buttonHtml = (option, index) => {
    const optimization = option.optimization || {};
    const label = option.asShared ? 'As Shared' : (optimization.label || `Option ${index + 1}`);
    const only = routing.options.length === 1;
    const shortLabel = option.asShared ? 'As Shared'
      : sharedInPlay ? String.fromCharCode(65 + index)
      : /^Route [A-Z]$/.test(label)
        ? (only ? `${label.slice(-1)} (Only route)` : label.slice(-1))
        : label;
    const active = option === routing.last;
    const classes = [active ? 'active' : '', option.asShared ? 'route-option-shared' : '',
      turnNav.active ? 'nav-locked' : ''].filter(Boolean).join(' ');
    const title = option.asShared
      ? 'The route exactly as shared. Colors use your settings; switching routes uses your settings.'
      : optimizationDescription(optimization);
    return `<button type="button" data-route-option="${index}"${classes ? ` class="${classes}"` : ''}
      aria-pressed="${active}" aria-label="${option.asShared ? 'Shared route' : `Choose route ${index + 1}: ${label}`}"
      title="${title}"${turnNav.active ? ' aria-disabled="true"' : ''}>
      <span>${shortLabel}</span></button>`;
  };
  let cells;
  if (routing.pinnedLetters?.length && !sharedInPlay) {
    // A frozen lineup renders in PIN order. A pinned recipe the latest
    // refinement could not route keeps its letter as a greyed, disabled slot:
    // the honest statement of what the rider's change did to that route.
    const byProfile = new Map(routing.options.map((option, index) =>
      [option.optimization?.profileId, index]));
    const unroutable = new Set((routing.missingLetters || []).map((e) => e.profileId));
    cells = [];
    for (const entry of routing.pinnedLetters) {
      const index = byProfile.get(entry.profileId);
      if (index != null) {
        cells.push(buttonHtml(routing.options[index], index));
        byProfile.delete(entry.profileId);
      } else if (unroutable.has(entry.profileId)) {
        cells.push(`<button type="button" class="route-option-missing" disabled
          title="Route ${entry.letter} found no route with your current changes"
          aria-label="Route ${entry.letter}: no route with your current changes">
          <span>${entry.letter}</span></button>`);
      }
    }
    // Anything outside the pin (a candidate parked from the considered-routes
    // screen mid-reply) still renders rather than vanishing.
    for (const [, index] of byProfile) cells.push(buttonHtml(routing.options[index], index));
  } else {
    cells = routing.options.map(buttonHtml);
  }
  host.innerHTML = cells.join('') + remixButtonHtml();
}

// "More" opens the remix dialog -- "Show me routes that are…". Tinted
// whenever a non-default mode is active, so a remixed portfolio can never
// look like the normal one. (The all-candidates troubleshooting screen this
// button's name used to open now lives on the weights page, where the rest
// of the router's workings already are.)
function remixButtonHtml() {
  const active = routing.remix !== 'recommended';
  const mode = ROUTE_REMIX_MODES[routing.remix] || ROUTE_REMIX_MODES.recommended;
  return `<button type="button" id="routeRemixBtn" class="route-option-remix${active ? ' remix-active' : ''}"
    title="Show me routes that are… (currently: ${mode.label})"
    aria-label="More route choices — currently showing ${mode.label}"><span>⋮</span></button>`;
}

function openRouteRemix() {
  const dialog = document.getElementById('remixDialog');
  if (!dialog) return;
  buildRemixChoices();
  if (!dialog.open) dialog.showModal();
}

// Rebuilt on every open so the "Current" badge is always the live state.
function buildRemixChoices() {
  const host = document.getElementById('remixChoices');
  if (!host) return;
  host.replaceChildren();
  for (const [id, mode] of Object.entries(ROUTE_REMIX_MODES)) {
    const current = routing.remix === id;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `remix-choice${current ? ' current' : ''}`;
    button.dataset.remix = id;
    button.setAttribute('aria-pressed', String(current));
    button.innerHTML = `<span class="remix-choice-label">${mode.label}`
      + `${current ? '<span class="remix-current-badge">Current</span>' : ''}</span>`
      + `<span class="remix-choice-hint">${mode.hint}</span>`;
    button.addEventListener('click', () => applyRouteRemix(id));
    host.appendChild(button);
  }
}

function applyRouteRemix(id) {
  if (!ROUTE_REMIX_MODES[id]) return;
  routing.remix = id;
  saveStateSoon();
  document.getElementById('remixDialog')?.close();
  renderRouteOptionControls();
  // Tapping a mode -- INCLUDING the one already current -- rebuilds the
  // portfolio and takes its recommendation afresh. Picking a mode is asking
  // "what would you offer me?", and the honest answer to that question is
  // never "whatever letter you already had selected". Closing with the X is
  // the way out that changes nothing.
  routing.selectRecommendedNext = true;
  computeRoute();
}

// The stage that removed a candidate, in the order the pipeline applies them.
// Each is a plain-language answer to "why am I not being offered this?".
const CANDIDATE_STAGES = {
  offered: { label: 'Offered', tone: 'offered' },
  'not-chosen': { label: 'Not chosen', tone: 'near' },
  dominated: { label: 'Dominated', tone: 'cut' },
  duplicate: { label: 'Duplicate', tone: 'cut' },
  'too-slow': { label: 'Too slow', tone: 'cut' },
  considered: { label: 'Considered', tone: 'cut' },
};

// A thumbnail sketch of where each route goes.
//
// Every candidate is drawn in ONE shared bounding box, not auto-fitted
// individually. These are all routes between the same two points, so the
// question the picture answers is "how does this one differ from that one" --
// and per-row autoscaling would normalise exactly the difference worth seeing.
//
// Web Mercator y, so north-south distances are not stretched relative to
// east-west at Washington's latitude; a plain lat/lon plot would squash every
// route by about a third.
// Both axes must be in the SAME units or the sketch is sheared. mercatorY
// returns natural-log units (radians of a unit sphere), so longitude has to be
// radians too -- feeding it degrees stretched every route by 180/pi across,
// which drew Seattle-Mukilteo, a 0.34 degree north-south trip, as a horizontal
// sliver.
function mercatorX(lng) {
  return lng * Math.PI / 180;
}
function mercatorY(lat) {
  const clamped = Math.max(-85, Math.min(85, lat));
  return Math.log(Math.tan(Math.PI / 4 + clamped * Math.PI / 360));
}

function candidateShapeBounds(all) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of all) {
    for (const [lng, lat] of c.shape?.pts || []) {
      const x = mercatorX(lng), y = mercatorY(lat);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  // A dead-straight route has zero extent on one axis; give it something to
  // divide by rather than producing NaN coordinates.
  const padX = (maxX - minX) * 0.06 || 1e-5;
  const padY = (maxY - minY) * 0.06 || 1e-5;
  return { minX: minX - padX, maxX: maxX + padX, minY: minY - padY, maxY: maxY + padY };
}

// The route-preview sketch. The SVG viewBox and the CSS box have to scale
// together -- that is what keeps the stroke weights a constant weight on screen
// while the drawing grows -- so the CSS reads these rather than repeating them.
// A comment asking a human to keep two numbers in step is not a mechanism.
const THUMB_W = 124, THUMB_H = 93;
// Narrow phones give width back to the text. One factor, applied to both axes,
// so the aspect ratio cannot drift from the viewBox.
const THUMB_PHONE_SCALE = 0.76;
(function publishThumbSize() {
  const style = document.documentElement.style;
  style.setProperty('--thumb-w', `${THUMB_W}px`);
  style.setProperty('--thumb-h', `${THUMB_H}px`);
  style.setProperty('--thumb-phone-scale', String(THUMB_PHONE_SCALE));
}());
function candidateThumbSvg(c, bounds) {
  if (!c.shape?.pts?.length || !bounds) {
    return `<svg class="all-route-thumb" viewBox="0 0 ${THUMB_W} ${THUMB_H}" aria-hidden="true"></svg>`;
  }
  const spanX = bounds.maxX - bounds.minX, spanY = bounds.maxY - bounds.minY;
  // One scale for both axes keeps the shape's proportions honest; the smaller
  // fit wins so nothing overflows the box.
  const scale = Math.min(THUMB_W / spanX, THUMB_H / spanY);
  const offX = (THUMB_W - spanX * scale) / 2, offY = (THUMB_H - spanY * scale) / 2;
  const project = ([lng, lat]) => [
    offX + (mercatorX(lng) - bounds.minX) * scale,
    // SVG y grows downward; Mercator y grows north.
    THUMB_H - offY - (mercatorY(lat) - bounds.minY) * scale,
  ];
  const pts = c.shape.pts.map(project);
  const lv = c.shape.lv || [];
  // Base line first, then the failing and caution spans on top, so a short bad
  // stretch is visible against the whole rather than hidden under it.
  const path = (indices) => indices.map((seg) =>
    'M' + seg.map((i) => `${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)}`).join('L')).join('');
  const runs = (test) => {
    const out = [];
    let run = null;
    for (let i = 0; i < pts.length; i++) {
      if (test(lv[i] || 0)) {
        if (!run) { run = i > 0 ? [i - 1, i] : [i]; out.push(run); }
        else run.push(i);
      } else run = null;
    }
    return out.filter((r) => r.length > 1);
  };
  const all = [[...pts.keys()]];
  return `<svg class="all-route-thumb" viewBox="0 0 ${THUMB_W} ${THUMB_H}" aria-hidden="true">
    <path class="thumb-base" d="${path(all)}"/>
    <path class="thumb-caution" d="${path(runs((l) => l === 3))}"/>
    <path class="thumb-fail" d="${path(runs((l) => l === 4))}"/>
    <circle class="thumb-start" cx="${pts[0][0].toFixed(1)}" cy="${pts[0][1].toFixed(1)}" r="3.4"/>
    <circle class="thumb-end" cx="${pts[pts.length - 1][0].toFixed(1)}" cy="${pts[pts.length - 1][1].toFixed(1)}" r="3.4"/>
  </svg>`;
}

function candidateStatLine(c) {
  const mi = c.distM / 1609.344;
  const ridingM = Math.max(1, c.distM - (c.ferryM || 0));
  const levels = c.levelM || [];
  const pct = (m) => Math.round((m || 0) / ridingM * 100);
  const pass = pct((levels[1] || 0) + (levels[2] || 0));
  const caution = pct(levels[3] || 0);
  const fail = pct(levels[4] || 0);
  const facility = pct(c.facilityM);
  return { mi, hours: c.timeS / 3600, pass, caution, fail, facility };
}

function renderAllRoutesList() {
  const host = document.getElementById('allRoutesList');
  if (!host) return;
  const all = routing.allCandidates || [];
  host.replaceChildren();
  if (!all.length) {
    const empty = document.createElement('p');
    empty.className = 'all-routes-empty';
    empty.textContent = 'No routes have been calculated yet.';
    host.append(empty);
    return;
  }
  const bounds = candidateShapeBounds(all);
  for (const c of all) {
    const stage = CANDIDATE_STAGES[c.stage] || CANDIDATE_STAGES.considered;
    const s = candidateStatLine(c);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `all-route-row tone-${stage.tone}${c.presented ? ' is-offered' : ''}`;
    row.dataset.profileId = c.profileId;
    const active = routing.last?.optimization?.profileId === c.profileId;
    if (active) row.classList.add('active');
    row.setAttribute('aria-label', `${c.label}: ${s.mi.toFixed(1)} miles, `
      + `${s.pass}% pass, ${s.caution}% caution, ${s.fail}% fail. ${stage.label}. ${c.why}`);
    row.innerHTML = `
      ${candidateThumbSvg(c, bounds)}
      <div class="all-route-head">
        <strong>${c.label}</strong>
        ${c.recommended ? '<span class="all-route-badge rec">Recommended</span>' : ''}
        <span class="all-route-badge stage-${stage.tone}">${stage.label}</span>
        ${active ? '<span class="all-route-badge cur">Showing</span>' : ''}
      </div>
      <div class="all-route-stats">
        <span><b>${s.mi.toFixed(1)}</b> mi</span>
        <span><b>${Math.floor(s.hours)}h${String(Math.round(s.hours % 1 * 60)).padStart(2, '0')}</b></span>
        <span class="lvl-pass"><b>${s.pass}%</b> pass</span>
        <span class="lvl-caution"><b>${s.caution}%</b> caution</span>
        <span class="lvl-fail"><b>${s.fail}%</b> fail</span>
        <span class="lvl-fac"><b>${s.facility}%</b> trails / lanes</span>
      </div>
      <p class="all-route-why"><b>Built as:</b> ${c.why}</p>
      ${c.stageWhy ? `<p class="all-route-stage-why"><b>${stage.label}:</b> ${c.stageWhy}</p>` : ''}`;
    row.addEventListener('click', () => chooseCandidate(c));
    host.append(row);
  }
}

// Tapping a row loads that route. Offered routes are already in hand; the rest
// are fetched whole from the worker's portfolio cache.
function chooseCandidate(c) {
  const dialog = document.getElementById('allRoutesDialog');
  const existing = (routing.options || []).find((o) =>
    o.optimization?.profileId === c.profileId);
  if (existing) {
    dialog.close();
    activateRouteOption(existing, true);
    renderRouteOptionControls();
    return;
  }
  if (!routing.worker || !routing.candidatesKey) return;
  routing.candidateReqId = (routing.candidateReqId || 0) + 1;
  routing.worker.postMessage({ type: 'route-candidate', id: routing.candidateReqId,
    candidatesKey: routing.candidatesKey, profileId: c.profileId });
  dialog.close();
  showRouteActionToast(`Loading ${c.label}…`, { busy: true, duration: 8000 });
}

function openAllRoutes() {
  renderAllRoutesList();
  document.getElementById('allRoutesDialog').showModal();
}

function activateRouteOption(option, updateNavigation = false) {
  if (!option?.ok) return;
  showRouteActionToast('');
  const warningWasActive = routeHasDetailsWarning(routing.last);
  routing.last = option;
  // The shared route must not push the sender's profile onto the receiver.
  if (option.optimization && !option.asShared) {
    routing.profileId = option.optimization.profileId || routing.profileId;
    routing.mode = option.optimization.mode || routing.mode;
  }
  if (updateNavigation && turnNav.active) {
    turnNav.plannedRoute = buildTurnInstructions(option);
    if (!turnNav.followingConnector) {
      turnNav.route = turnNav.plannedRoute;
      turnNav.next = 0;
      turnNav.nearest = 0;
      turnNav.routeM = 0;
      turnNav.arrived = false;
      turnNav.offRoute = false;
      turnNav.offRouteInfo = null;
      turnNav.offRouteApproachSpoken = false;
      turnNav.message = 'Route updated';
    }
  }
  renderRouteOptionControls();
  renderRouteCard(option);
  const shouldFlashWarning = !warningWasActive && routeHasDetailsWarning(option);
  syncRouteDetailsWarningState(option, { flash: shouldFlashWarning });
  if (shouldFlashWarning) flashRouteCardWarnings(option);
  // Deferred: the compact report re-derives a verdict for every segment and
  // stringifies the lot (~60 ms of a ~100 ms letter switch on a long route).
  // A rider flipping A-B-C-D pays it once at settle instead of per tap, and
  // nothing can read it stale -- openRouteDetails() re-stores before loading.
  scheduleStoreRouteDetails(option);
  drawRoute(option.coords, option.ferrySegs, option.segs);
  consumePendingRouteStepHighlight();
  setRouteStatus(`${fmtMi(option.distM)} mi · ${option.optimization?.label || 'route choice'}`);
  saveStateSoon();
}

function buildRoutingPanel() {
  const choices = document.getElementById('routeOptions');
  choices.addEventListener('click', (event) => {
    if (turnNav.active) {
      showRouteActionToast('Pause navigation before choosing a different route', { duration: 2600 });
      return;
    }
    const button = event.target.closest('[data-route-option]');
    if (!button || button.disabled || choices.classList.contains('loading')) return;
    const option = routing.options[Number(button.dataset.routeOption)];
    if (!option || option === routing.last) return;
    // Leaving the shared route recomputes with the receiver's own settings.
    if (routing.sharedActive && !option.asShared) { openSharedSwitchDialog(); return; }
    activateRouteOption(option);
  });
  renderRouteOptionControls();

  document.getElementById('routeDetailsBtn').addEventListener('click', () => openRouteDetails());
  document.getElementById('routeTipsBtn').addEventListener('click', openRouteTips);

  renderRouteCard(null);

  for (const kind of ['start', 'end']) {
    document.getElementById('rb-' + kind).addEventListener('click', () => openPlacePicker(kind));
  }
  document.getElementById('rb-more').addEventListener('click', () => {
    const menu = document.getElementById('routeActionsMenu');
    setRouteActionsOpen(menu.hidden);
  });
  document.getElementById('rb-via').addEventListener('click', () => openPlacePicker('via'));
  document.getElementById('rb-road-block').addEventListener('click', () => armRoutePoint('block'));
  document.getElementById('rb-reverse').addEventListener('click', reverseRoute);
  document.getElementById('navStartButton').addEventListener('click', () => {
    if (turnNav.active) stopTurnNavigation();
    else startTurnNavigation();
  });
  document.getElementById('navCardDetailsBtn').addEventListener('click', () => openRouteDetails());
  document.getElementById('navUseNearestBtn').addEventListener('click', () => useNearestPlannedRoute());
  document.getElementById('navRouteToStartBtn').addEventListener('click', () => {
    stopRouteStartCountdown();
    requestRouteBackToCurrentRoute();
  });
  document.getElementById('routeStartDialog').addEventListener('cancel', (event) => {
    event.preventDefault();
    useNearestPlannedRoute();
  });
  document.getElementById('navOffRouteBtn').addEventListener('click', openOffRouteDialog);
  document.getElementById('navNewRouteBtn').addEventListener('click', () => requestNewRouteFromCurrentLocation());
  document.getElementById('navRouteBackBtn').addEventListener('click', () => requestRouteBackToCurrentRoute());
  document.getElementById('navKeepRouteBtn').addEventListener('click', () =>
    document.getElementById('offRouteDialog').close());
  // Tapping outside either "how to join" dialog closes it defaulting to the
  // non-intrusive "I'll find my own way" (for the off-route dialog, closing is
  // that same keep-going choice).
  document.getElementById('routeStartDialog').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) useNearestPlannedRoute();
  });
  document.getElementById('offRouteDialog').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  document.getElementById('rb-clear').addEventListener('click', requestClearRoute);
  document.getElementById('confirmClearRoute').addEventListener('click', () => {
    document.getElementById('clearRouteDialog').close();
    clearRoute();
  });
  document.getElementById('confirmRemoveRouteMarker').addEventListener('click', () => {
    const pending = pendingRouteMarkerRemoval;
    pendingRouteMarkerRemoval = null;
    document.getElementById('removeRouteMarkerDialog').close();
    if (!pending) return;
    if (pending.kind === 'via') removeVia(pending.item);
    else removeRoadBlock(pending.item);
  });
  document.getElementById('confirmSharedSwitch').addEventListener('click', () => confirmSharedSwitch());
  document.addEventListener('click', (event) => {
    if (!document.getElementById('routeBar').contains(event.target)) setRouteActionsOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setRouteActionsOpen(false);
  });
  updateArmButtons();
  buildPlacePicker();
  buildSavedRoutes();

  // A shared link wins over the receiver's locally persisted route.
  if (sharedRoute) {
    const rt = sharedRoute.route;
    routing.sharedLoading = true;         // suppress the exit-shared hooks below
    routing.sharedActive = !!routing.sharedRecipe;
    setRoutePoint('start', { lng: rt.s[0], lat: rt.s[1] }, rt.sn);
    for (const p of rt.v || []) addVia({ lng: p[0], lat: p[1] });
    for (const p of rt.b || []) addRoadBlock({ lng: p[0], lat: p[1] });
    setRoutePoint('end', { lng: rt.e[0], lat: rt.e[1] }, rt.en);
    routing.sharedLoading = false;
    fitRouteBounds(rt);
    setStatus('Shared route loaded');
    // The route is now persisted like any other plan. Removing the consumed
    // token prevents Clear/Edit + refresh from resurrecting the original link.
    saveStateSoon();
    if (saveStateNow()) consumeSharedRouteHash();
  } else if (savedState && normalizeStoredRoute(savedState.route)) {
    const rt = normalizeStoredRoute(savedState.route);
    setRoutePoint('start', { lng: rt.s[0], lat: rt.s[1] }, rt.sn, { fromDevice: rt.sd });
    for (const p of rt.v || []) addVia({ lng: p[0], lat: p[1] }, { allowPastLimit: true });
    for (const p of rt.b || []) addRoadBlock({ lng: p[0], lat: p[1] }, { allowPastLimit: true });
    setRoutePoint('end', { lng: rt.e[0], lat: rt.e[1] }, rt.en);
  }
}

/* --------------------------------------------------- saved routes */
function shareRouteUrl() {
  if (!(routing.start && routing.end)) return null;
  const point = (p) => p.map((v) => +Number(v).toFixed(5));
  const payload = {
    v: 1,
    s: point(routing.start),
    e: point(routing.end),
    a: routing.startName,
    b: routing.endName,
    x: routing.vias.map((via) => point(via.pt)),
    z: routing.blocks.map((block) => point(block.pt)),
    m: routing.mode,
    o: routing.profileId,
    p: routing.prefDesig,
    q: routing.prefResidential,
    r: { ...rules },
    w: { ...routingWeights },
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const token = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const url = new URL(location.href);
  url.search = '';
  url.hash = 'route=' + token;
  return url.toString();
}

function fitRouteBounds(route) {
  const lons = [route.s[0], route.e[0], ...(route.v || []).map((p) => p[0]), ...(route.b || []).map((p) => p[0])];
  const lats = [route.s[1], route.e[1], ...(route.v || []).map((p) => p[1]), ...(route.b || []).map((p) => p[1])];
  map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
    { padding: 60, maxZoom: 13 });
}

function loadSharedRouteIntoPlanner(shared) {
  if (!shared || !shared.route) return false;
  routing.sharedLoading = true;           // keep the exit-shared hooks quiet during load
  clearRoute();
  // The receiver's own settings stay untouched; the sender's recipe is kept
  // aside and used only to rebuild the exact shared route.
  routing.sharedRecipe = {
    mode: shared.mode,
    profileId: shared.profileId || legacyRouteProfile(shared.mode),
    prefDesig: shared.prefDesig,
    prefResidential: shared.prefResidential,
    weights: shared.weights,
    rules: shared.rules,
  };
  routing.sharedActive = true;
  const route = shared.route;
  setRoutePoint('start', { lng: route.s[0], lat: route.s[1] }, route.sn);
  for (const p of route.v || []) addVia({ lng: p[0], lat: p[1] });
  for (const p of route.b || []) addRoadBlock({ lng: p[0], lat: p[1] });
  setRoutePoint('end', { lng: route.e[0], lat: route.e[1] }, route.en);
  routing.sharedLoading = false;
  fitRouteBounds(route);
  saveStateSoon();
  return true;
}

// Leaving the shared route (an endpoint edit, a new route, or confirming the
// switch dialog) drops "As Shared" so the rider's own settings take over.
function exitSharedRoute() {
  if (routing.sharedLoading || !routing.sharedActive) return;
  routing.sharedActive = false;
  routing.sharedRecipe = null;
  routing.options.forEach((o) => { o.asShared = false; });
}

function openSharedSwitchDialog() {
  const dialog = document.getElementById('sharedSwitchDialog');
  if (dialog?.showModal) { if (!dialog.open) dialog.showModal(); return; }
  if (confirm('Switching routes uses your own settings and may not match the shared route exactly. Continue?')) confirmSharedSwitch();
}

function confirmSharedSwitch() {
  document.getElementById('sharedSwitchDialog')?.close();
  routing.sharedActive = false;
  routing.sharedRecipe = null;
  routing.options.forEach((o) => { o.asShared = false; });
  computeRoute(); // rebuild with the receiver's own settings
}

function loadSavedRoutes() {
  try {
    const value = JSON.parse(localStorage.getItem(SAVED_ROUTES_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch (e) { return []; }
}
function storeSavedRoutes(list) {
  try { localStorage.setItem(SAVED_ROUTES_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
}

function buildSavedRoutes() {
  const dialog = document.getElementById('routesDialog');
  const host = document.getElementById('savedRoutes');
  const copyShare = document.getElementById('copyShareRouteBtn');
  const nativeShare = document.getElementById('nativeShareRouteBtn');
  const shareUrlInput = document.getElementById('shareRouteUrl');
  const shareStatus = document.getElementById('shareRouteStatus');
  const importUrlInput = document.getElementById('importShareUrl');
  const loadShareRoute = document.getElementById('loadShareRouteBtn');
  const importStatus = document.getElementById('importRouteStatus');
  const deleteDialog = document.getElementById('deleteSavedRouteDialog');
  let pendingDelete = null;
  if (!host) return;

  const setShareAvailability = () => {
    const hasRoute = !!(routing.start && routing.end);
    copyShare.disabled = !hasRoute;
    nativeShare.disabled = !hasRoute;
    nativeShare.hidden = !navigator.share;
    shareUrlInput.hidden = true;
    shareStatus.textContent = hasRoute ? 'Send this route to another device.' : 'Set a route to share it.';
    importStatus.textContent = 'Paste a route link sent from another device.';
  };
  const showShareUrl = (url, message) => {
    shareUrlInput.hidden = false;
    shareUrlInput.value = url;
    shareStatus.textContent = message;
    shareUrlInput.focus({ preventScroll: true });
    shareUrlInput.select();
  };

  const render = () => {
    setShareAvailability();
    const list = loadSavedRoutes();
    host.replaceChildren();
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'hint';
      empty.textContent = 'No saved routes yet. Saved routes stay on this device.';
      host.appendChild(empty);
    }
    list.forEach((saved, index) => {
      const route = normalizeStoredRoute(saved);
      const name = String(saved?.name || `Saved route ${index + 1}`);
      const row = document.createElement('div');
      row.className = 'saved-row';
      const load = document.createElement('button');
      load.className = 'saved-load';
      load.type = 'button';
      const savedName = document.createElement('span');
      savedName.className = 'saved-route-name';
      savedName.textContent = name;
      const loadAction = document.createElement('span');
      loadAction.className = 'saved-route-action';
      loadAction.textContent = 'Load ›';
      load.append(savedName, loadAction);
      load.disabled = !route;
      load.addEventListener('click', () => {
        const current = loadSavedRoutes()[index];
        const currentRoute = normalizeStoredRoute(current);
        if (!current || !currentRoute) return;
        clearRoute();
        if (current.rules) {
          Object.assign(rules, validRuleOverrides(current.rules));
          buildRulesPanel();
          rescoreAll(false);
        }
        routing.mode = ['direct', 'balanced', 'low'].includes(current.mode) ? current.mode : routing.mode;
        routing.profileId = validRouteProfileId(current.profileId)
          ? current.profileId : legacyRouteProfile(current.mode || routing.mode);
        routing.prefDesig = typeof current.prefDesig === 'boolean' ? current.prefDesig : routing.prefDesig;
        routing.prefResidential = typeof current.prefResidential === 'boolean'
          ? current.prefResidential : routing.prefResidential;
        renderRouteOptionControls();
        syncRoutePreferenceControls();
        setRoutePoint('start', { lng: currentRoute.s[0], lat: currentRoute.s[1] }, currentRoute.sn);
        for (const point of currentRoute.v) addVia(
          { lng: point[0], lat: point[1] }, { allowPastLimit: true });
        for (const point of currentRoute.b || []) addRoadBlock(
          { lng: point[0], lat: point[1] }, { allowPastLimit: true });
        setRoutePoint('end', { lng: currentRoute.e[0], lat: currentRoute.e[1] }, currentRoute.en);
        fitRouteBounds(currentRoute);
        saveStateSoon();
        dialog.close();
      });
      const remove = document.createElement('button');
      remove.className = 'saved-del';
      remove.type = 'button';
      remove.title = `Delete ${name}`;
      remove.setAttribute('aria-label', `Delete ${name}`);
      remove.textContent = '✕';
      remove.addEventListener('click', () => {
        pendingDelete = { index, name };
        document.getElementById('deleteSavedRouteText').textContent =
          `Delete “${name}” from the saved routes on this device?`;
        if (!deleteDialog.open) deleteDialog.showModal();
      });
      row.append(load, remove);
      host.appendChild(row);
    });
  };
  document.getElementById('confirmDeleteSavedRoute').addEventListener('click', () => {
    const request = pendingDelete;
    pendingDelete = null;
    deleteDialog.close();
    if (!request) return;
    const current = loadSavedRoutes();
    current.splice(request.index, 1);
    storeSavedRoutes(current);
    render();
    document.getElementById('savedRoutesStatus').textContent = `Deleted ${request.name}.`;
  });
  document.getElementById('routeLibraryBtn').addEventListener('click', () => {
    render();
    dialog.showModal();
    // Avoid the browser focusing the first control (the help button), which
    // makes it look selected before the rider has chosen anything.
    dialog.focus({ preventScroll: true });
  });
  copyShare.addEventListener('click', async () => {
    const url = shareRouteUrl();
    if (!url) return;
    // Show the actual link immediately. This remains useful on browsers that
    // delay or deny clipboard permission, particularly in an installed PWA.
    showShareUrl(url, 'Share link ready — copy it or send it to your phone.');
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(url);
      shareStatus.textContent = 'Share link copied — open it on your phone.';
    } catch (e) {
      shareStatus.textContent = 'Copy this link and open it on your phone.';
    }
  });
  nativeShare.addEventListener('click', async () => {
    const url = shareRouteUrl();
    if (!url || !navigator.share) return;
    try {
      await navigator.share({
        title: 'Bike route',
        text: 'Open this bike route in Just Rolling Along.',
        url,
      });
      shareStatus.textContent = 'Share link sent.';
    } catch (e) {
      if (e && e.name !== 'AbortError') showShareUrl(url, 'Copy this link and open it on your phone.');
    }
  });
  const importSharedRoute = () => {
    const shared = readSharedRoute(importUrlInput.value);
    if (!shared) {
      importStatus.textContent = 'That does not look like a valid shared Just Rolling Along route link.';
      return;
    }
    loadSharedRouteIntoPlanner(shared);
    importUrlInput.value = '';
    importStatus.textContent = 'Shared route loaded.';
    dialog.close();
    setStatus('Shared route loaded');
  };
  loadShareRoute.addEventListener('click', importSharedRoute);
  importUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') importSharedRoute();
  });
  document.getElementById('saveRouteBtn').addEventListener('click', () => {
    if (!(routing.start && routing.end)) { setStatus('Set a route first', true); return; }
    const input = document.getElementById('savedRouteName');
    const name = input.value.trim() || `Route ${new Date().toLocaleDateString()}`;
    const list = loadSavedRoutes();
    list.unshift({ name: name.slice(0, 60), s: routing.start, e: routing.end,
      sn: routing.startName, en: routing.endName,
      v: routing.vias.map((x) => x.pt), b: routing.blocks.map((x) => x.pt),
      mode: routing.mode, profileId: routing.profileId,
      prefDesig: routing.prefDesig,
      prefResidential: routing.prefResidential, rules: { ...rules },
      ts: Date.now() });
    storeSavedRoutes(list.slice(0, 30));
    input.value = '';
    render();
    document.getElementById('savedRoutesStatus').textContent = `Saved ${name.slice(0, 60)}.`;
  });
  render();
}

/* --------------------------------------- start/end location dialog */
// Offline place search over a baked OSM index (data/places.json).
let placesIndex = null, placesPromise = null;
function ensurePlaces() {
  if (!placesPromise) {
    placesPromise = fetch('data/places.json')
      .then((res) => (res.ok ? res.json() : []))
      .then((j) => { placesIndex = j; })
      .catch(() => { placesPromise = null; }); // offline pre-cache: retry next time
  }
  return placesPromise;
}

let placeTarget = null;
let placeSearchRequestId = 0;
let placePickerViewportRestoreTimers = [];
let placePickerMapFrameTimer = null;
const onlinePlaceCache = new Map();
let onlinePlaceLastRequestAt = 0;
const ONLINE_PLACE_SEARCH_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const ONLINE_PLACE_SEARCH_MIN_INTERVAL_MS = 1100;
const ONLINE_PLACE_RESULT_LIMIT = 6;
// The router only covers the region this build ships; drop any hit outside it
// so a search result is always somewhere a route can reach.

// Bias the search toward wherever the map is currently looking so a generic
// query ("Fred Meyer", "hardware store") returns nearby matches rather than
// the most "important" ones statewide.
function placeSearchReference() {
  const c = map.getCenter();
  return [c.lng, c.lat];
}

async function searchOnlinePlaces(query) {
  const normalized = query.trim().replace(/\s+/g, ' ').toLowerCase();
  if (normalized.length < 2) return [];
  const [refLon, refLat] = placeSearchReference();

  let matches = onlinePlaceCache.get(normalized);
  if (!matches) {
    if (navigator.onLine === false) throw new Error('offline');
    const waitMs = Math.max(0, ONLINE_PLACE_SEARCH_MIN_INTERVAL_MS - (Date.now() - onlinePlaceLastRequestAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    onlinePlaceLastRequestAt = Date.now();

    const url = new URL(ONLINE_PLACE_SEARCH_ENDPOINT);
    // A local viewbox biases results toward the current view; it is not a hard
    // bound (so a store a bit farther out still comes back), and we then keep
    // only Washington hits ourselves.
    const halfLon = 1.1, halfLat = 0.7;
    url.search = new URLSearchParams({
      format: 'jsonv2', q: query.trim(), limit: '30', countrycodes: 'us', addressdetails: '1',
      viewbox: `${refLon - halfLon},${refLat + halfLat},${refLon + halfLon},${refLat - halfLat}`,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let response;
    try {
      response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`search failed (${response.status})`);
    const data = await response.json();
    matches = (Array.isArray(data) ? data : [])
      .map((item) => ({
        name: onlinePlaceResultName(item),
        lon: Number(item.lon), lat: Number(item.lat), source: 'online',
      }))
      .filter((item) => item.name && Number.isFinite(item.lon) && Number.isFinite(item.lat))
      .filter((item) => Region.contains(item.lon, item.lat));
    if (onlinePlaceCache.size >= 50) onlinePlaceCache.delete(onlinePlaceCache.keys().next().value);
    onlinePlaceCache.set(normalized, matches);
  }

  // Sort by distance from the current view and keep the nearest handful.
  return matches
    .map((m) => ({ ...m, distanceM: navDistanceM([refLon, refLat], [m.lon, m.lat]) }))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, ONLINE_PLACE_RESULT_LIMIT);
}

function onlinePlaceResultName(item) {
  const address = item?.address || {};
  const displayParts = String(item?.display_name || '').split(',').map((part) => part.trim()).filter(Boolean);
  const houseNumber = String(address.house_number || '').trim();
  const road = String(address.road || address.pedestrian || address.footway || address.path || '').trim();
  const streetAddress = [houseNumber, road].filter(Boolean).join(' ');
  // A named POI keeps its name. For a plain street address Nominatim sets
  // `name` to just the house number and puts the street only in display_name,
  // so "520 N 61st St" would collapse to "520" — rebuild it from house number
  // plus road instead. Fall back to the first display_name part.
  let primary = String(item?.name || '').trim();
  if (!primary || primary === houseNumber) primary = streetAddress || displayParts[0] || '';
  const city = String(address.city || address.town || address.village || address.municipality
    || address.hamlet || '').trim();
  const state = String(address.state || Region.name).trim();
  const parts = [primary];
  if (city && city.toLowerCase() !== primary.toLowerCase()) parts.push(city);
  if (state && !parts.some((part) => part.toLowerCase() === state.toLowerCase())) parts.push(state);
  return parts.filter(Boolean).join(', ').slice(0, 180);
}

function restoreViewportAfterPlacePicker() {
  for (const timer of placePickerViewportRestoreTimers) clearTimeout(timer);
  placePickerViewportRestoreTimers = [];
  const restore = () => {
    // iOS completes its keyboard/visual-viewport animation after focus is
    // released. Restore once immediately and again after that animation.
    window.scrollTo(0, 0);
    syncVisibleViewport();
    map.resize();
  };
  requestAnimationFrame(restore);
  placePickerViewportRestoreTimers.push(setTimeout(restore, 180), setTimeout(restore, 480));
}

function frameMapAfterPlacePicker(lngLat) {
  clearTimeout(placePickerMapFrameTimer);
  placePickerMapFrameTimer = setTimeout(() => {
    map.resize();
    if (routing.start && routing.end) {
      fitRouteBounds({
        s: routing.start,
        e: routing.end,
        v: routing.vias.map((via) => via.pt),
        b: routing.blocks.map((block) => block.pt),
      });
    } else {
      map.flyTo({ center: [lngLat.lng, lngLat.lat], zoom: 13 });
    }
  }, 500);
}

function closePlacePicker(cancelArm = false) {
  placeSearchRequestId++;
  const picker = document.getElementById('placePicker');
  if (document.activeElement && picker.contains(document.activeElement)) document.activeElement.blur();
  picker.hidden = true;
  document.body.classList.remove('place-picker-open');
  restoreViewportAfterPlacePicker();
  document.getElementById('placeResults').replaceChildren();
  document.getElementById('placeResults').classList.remove('show');
  if (cancelArm && (routing.arm === 'start' || routing.arm === 'end'
    || routing.arm === 'via' || routing.arm === 'block')) {
    routing.arm = null;
    updateArmButtons();
    setRouteStatus('');
  }
}

function openPlacePicker(kind) {
  // A road block is intentionally map-only: routing uses the exact point the
  // rider picks, so a place-search result would add unnecessary indirection.
  if (kind === 'block') {
    armRoutePoint('block');
    return;
  }
  const isConstraint = kind === 'via' || kind === 'block';
  if (isConstraint && (!(routing.start && routing.end)
    || (kind === 'via' ? routing.vias.length >= MAX_ROUTE_STOPS : routing.blocks.length >= MAX_ROAD_BLOCKS))) return;
  setRouteActionsOpen(false);
  placeTarget = kind;
  routing.arm = kind;
  suppressRoadInfo();
  updateArmButtons();
  ensureRouter();
  setPanelOpen(false);
  document.getElementById('placePickerTitle').textContent = kind === 'start' ? 'Choose start'
    : kind === 'via' ? 'Add waypoint'
      : kind === 'block' ? 'Add road block' : 'Choose destination';
  document.getElementById('placePickerHint').innerHTML = kind === 'via'
    ? '<strong>Search</strong> for a place below, or <strong>tap the map</strong> to add it.'
    : kind === 'block'
      ? '<strong>Search</strong> for a road or place below, or <strong>tap the map</strong> to block it.'
      : `<strong>Tap on map</strong> to set ${kind === 'start' ? 'start' : 'destination'} or <strong>search</strong> below.`;
  document.getElementById('useLoc').hidden = kind !== 'start';
  const onlineButton = document.getElementById('onlinePlaceSearch');
  onlineButton.disabled = false;
  onlineButton.classList.remove('searching');
  const searchInput = document.getElementById('placeSearch');
  searchInput.placeholder = kind === 'start' ? 'Search for a start…'
    : kind === 'via' ? 'Search for a waypoint…'
      : kind === 'block' ? 'Search for a road block…' : 'Search for a destination…';
  const currentEndpointName = !isConstraint && routing[kind]
    ? (normalizeEndpointName(routing[`${kind}Name`]) || 'Point on map') : '';
  searchInput.value = currentEndpointName;
  searchInput.classList.toggle('current-endpoint-preview', Boolean(currentEndpointName));
  searchInput.setAttribute('aria-label', searchInput.placeholder.replace('…', ''));
  document.getElementById('placeResults').replaceChildren();
  document.getElementById('placeResults').classList.remove('show');
  document.getElementById('placePicker').hidden = false;
  document.body.classList.add('place-picker-open');
  setRouteStatus(kind === 'via' ? 'Search or tap the map to add a WAYPOINT'
    : kind === 'block' ? 'Search or tap the map to add a ROAD BLOCK'
      : `Tap the map or search to set the ${kind === 'start' ? 'START' : 'DESTINATION'}`);
}

function armRoutePoint(kind) {
  const isConstraint = kind === 'via' || kind === 'block';
  if (isConstraint && !(routing.start && routing.end)) return;
  if (kind === 'via' && routing.vias.length >= MAX_ROUTE_STOPS) {
    setRouteStatus(`A route can have up to ${MAX_ROUTE_STOPS} waypoints`);
    return;
  }
  if (kind === 'block' && routing.blocks.length >= MAX_ROAD_BLOCKS) {
    setRouteStatus(`A route can have up to ${MAX_ROAD_BLOCKS} road blocks`);
    return;
  }
  // Constraint actions begin directly on the map, so collapse the overflow
  // menu before the rider chooses a point.
  setRouteActionsOpen(false);
  closePlacePicker(false);
  routing.arm = routing.arm === kind ? null : kind;
  if (routing.arm) suppressRoadInfo();
  updateArmButtons();
  ensureRouter();
  if (routing.arm) {
    setPanelOpen(false);
    setRouteStatus(kind === 'via' ? 'Tap the map to add a waypoint'
      : kind === 'block' ? 'Tap the map to add a road block'
        : `Tap the map to set the ${kind === 'start' ? 'START' : 'DESTINATION'}`);
    if (kind === 'via') showRouteActionToast('Tap the map to add a waypoint', { duration: 3200 });
    if (kind === 'block') showRouteActionToast('Tap the map to add a road block', { duration: 3200 });
  } else {
    setRouteStatus('');
  }
}

function buildPlacePicker() {
  const input = document.getElementById('placeSearch');
  const results = document.getElementById('placeResults');
  const onlineButton = document.getElementById('onlinePlaceSearch');
  const TYPE_LABEL = { city: 'city', town: 'town', village: 'village', hamlet: 'hamlet',
    suburb: 'suburb', neighbourhood: 'neighborhood', ferry: 'ferry terminal' };

  const uniqueMatches = (items) => {
    const unique = [];
    for (const item of items) {
      const label = item.name.split(',')[0].trim().toLowerCase();
      const duplicate = unique.some((prior) => prior.name.split(',')[0].trim().toLowerCase() === label
        && navDistanceM([prior.lon, prior.lat], [item.lon, item.lat]) < 10_000);
      if (!duplicate) unique.push(item);
    }
    return unique;
  };

  const render = (items, message = '') => {
    results.replaceChildren();
    if (message) {
      const notice = document.createElement('p');
      notice.className = 'place-results-message';
      notice.setAttribute('role', 'status');
      notice.textContent = message;
      results.append(notice);
    }
    for (const item of items) {
      const hit = document.createElement('button');
      hit.className = 'place-hit';
      hit.dataset.lon = String(item.lon);
      hit.dataset.lat = String(item.lat);
      hit.dataset.name = item.name;
      hit.append(document.createTextNode(item.name + ' '));
      const detail = document.createElement('small');
      detail.textContent = item.source === 'online'
        ? (Number.isFinite(item.distanceM)
          ? `${fmtMi(item.distanceM)} mi from map center · online`
          : 'online · OpenStreetMap')
        : (TYPE_LABEL[item.type] || item.type || 'place');
      hit.append(detail);
      results.append(hit);
    }
    results.classList.toggle('show', items.length > 0 || Boolean(message));
  };

  const localMatches = () => {
    const q = input.value.trim().toLowerCase();
    if (!q || !placesIndex) return [];
    const starts = [], contains = [];
    for (const p of placesIndex) {
      const n = p[0].toLowerCase();
      if (n.startsWith(q)) starts.push(p);
      else if (n.includes(q)) contains.push(p);
      if (starts.length >= 8) break;
    }
    return starts.concat(contains).slice(0, 8).map(([name, lon, lat, type]) =>
      ({ name, lon, lat, type, source: 'local' }));
  };

  const showLocalMatches = () => render(localMatches());
  const searchOnline = async () => {
    const query = input.value.trim();
    if (query.length < 2) {
      setRouteStatus('Enter at least two characters to search online');
      return;
    }
    const requestId = ++placeSearchRequestId;
    onlineButton.disabled = true;
    onlineButton.classList.add('searching');
    showLocalMatches();
    try {
      const onlineMatches = await searchOnlinePlaces(query);
      if (requestId !== placeSearchRequestId || input.value.trim() !== query) return;
      const local = localMatches();
      const combined = uniqueMatches([...onlineMatches, ...local]);
      const noNetMessage = !onlineMatches.length
        ? (local.length
          ? `No Net results for “${query}”. Showing offline place matches.`
          : `No Net results for “${query}”. Try a city, address, or landmark.`)
        : '';
      render(combined, noNetMessage);
      setRouteStatus(onlineMatches.length
        ? `${onlineMatches.length} Net ${onlineMatches.length === 1 ? 'result' : 'results'} found`
        : 'No Net search results');
    } catch (e) {
      if (requestId === placeSearchRequestId) {
        const local = localMatches();
        render(local, local.length
          ? 'Net search is unavailable. Showing offline place matches.'
          : 'Net search is unavailable, and there are no offline matches.');
        setRouteStatus('Online search unavailable — showing local places');
      }
    } finally {
      if (requestId === placeSearchRequestId) {
        onlineButton.disabled = false;
        onlineButton.classList.remove('searching');
      }
    }
  };

  input.addEventListener('focus', () => {
    ensurePlaces();
    if (input.classList.contains('current-endpoint-preview')) {
      input.value = '';
      input.classList.remove('current-endpoint-preview');
    }
  });
  input.addEventListener('input', () => {
    input.classList.remove('current-endpoint-preview');
    placeSearchRequestId++;
    const query = input.value;
    ensurePlaces().then(() => { if (input.value === query) showLocalMatches(); });
    showLocalMatches();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      searchOnline();
    }
  });
  onlineButton.addEventListener('click', searchOnline);
  results.addEventListener('click', (e) => {
    const hit = e.target.closest('.place-hit');
    if (!hit) return;
    const lngLat = { lng: Number(hit.dataset.lon), lat: Number(hit.dataset.lat) };
    if (placeTarget === 'via') addVia(lngLat);
    else if (placeTarget === 'block') addRoadBlock(lngLat);
    else setRoutePoint(placeTarget, lngLat, hit.dataset.name);
    routing.arm = null;
    updateArmButtons();
    if (placeTarget === 'via') {
      setRouteStatus('Waypoint added');
      showRouteActionToast('Waypoint added — route recalculating', { duration: 2200 });
    } else if (placeTarget === 'block') {
      setRouteStatus('Road block added');
      showRouteActionToast('Road block added — route recalculating', { duration: 2200 });
    } else {
      setRouteStatus(placeTarget === 'start' ? 'Start set' : 'Destination set');
    }
    closePlacePicker(false);
    frameMapAfterPlacePicker(lngLat);
    input.value = '';
    render([]);
  });

  document.getElementById('placePickerClose').addEventListener('click', () => closePlacePicker(true));
  document.getElementById('useLoc').addEventListener('click', () => {
    setRouteStatus('Locating…');
    getFreshDevicePosition().then((pos) => {
      const lngLat = { lng: pos.coords.longitude, lat: pos.coords.latitude };
      setRoutePoint(placeTarget, lngLat, 'My location', { fromDevice: true });
      routing.arm = null;
      updateArmButtons();
      closePlacePicker(false);
      frameMapAfterPlacePicker(lngLat);
      setRouteStatus(placeTarget === 'start' ? 'Start set to your location' : 'Destination set');
    }).catch((error) => {
      // GeolocationPositionError.TIMEOUT is 3; our own gate throws string codes.
      const code = error?.code;
      let message;
      if (code === 'STALE_FIX' || code === 'IMPRECISE_FIX' || code === 3) {
        message = 'Still getting a GPS fix — try again in a moment';
      } else if (/blocked|denied|permission/i.test(String(error?.message || error))) {
        message = 'Location permission is blocked in your device Settings';
      } else {
        message = 'Could not get your location';
      }
      setRouteStatus(message);
    });
  });
}

/* ---------------------------------------------- hover/click readout */
const readoutEl = document.getElementById('readout');
// The road card repeats the one shared map/route verdict vocabulary.
// Every reason a road can be amber. Keyed by SafetyModel.CAUTION_CAUSES, and
// the help section is built from the same table so it cannot go stale.
// The agency that publishes the traffic-stress rating for this build's data.
// The safety model never learns this: it only sees `stressRating` on the
// published 1-4 Level of Traffic Stress scale. Adding another state means
// filling that field from their DOT and changing this label. Nothing else.
const STRESS_AGENCY = Region.stressAgency;

// Headline form, e.g. "Caution — limited-access highway".
const CAUTION_CAUSE_NAME = {
  'limited-access': 'limited-access highway',
  'sidewalk-fallback': 'sidewalk instead of a shoulder',
  'high-stress': 'officially rated high stress',
  dismount: 'you must walk your bike',
};
// Sentence form, e.g. "... — but it is a limited-access highway, so ...".
const CAUTION_CAUSE_PHRASE = {
  'limited-access': 'a limited-access highway',
  'high-stress': 'officially rated high stress',
};
const CAUTION_CAUSE_DETAIL = {
  'limited-access': 'Bikes are legal and the road meets your speed and shoulder rules, but it is a '
    + 'limited-access highway: shoulder riding past on- and off-ramps.',
  'sidewalk-fallback': 'The road does not meet your shoulder rule, but a sidewalk is mapped along it '
    + 'and you allow that as a fallback. Routes avoid it strongly.',
  'high-stress': 'The state transportation department rates this road at the top of the Level of '
    + 'Traffic Stress scale (4 of 4). It can only ever caution, never fail: most rated highway '
    + 'miles score 4, so failing on it would be indiscriminate. A road with a bike lane is never '
    + 'cautioned for this — you have space of your own — though a painted lane on a road rated '
    + 'this high draws blue rather than lime.',
  dismount: 'Bicycles are allowed, but you have to get off and walk.',
};

// Help is generated from SafetyModel.CAUTION_CAUSES rather than hand-written,
// so a new cause cannot be added without appearing here.
function buildCautionCauseHelp() {
  const host = document.getElementById('cautionCauseList');
  if (!host) return;
  host.replaceChildren();
  for (const cause of SafetyModel.CAUTION_CAUSES) {
    const item = document.createElement('li');
    const name = document.createElement('b');
    name.textContent = cause === 'dismount'
      ? 'Dismount required'
      : `Caution — ${CAUTION_CAUSE_NAME[cause]}`;
    item.append(name, ` — ${CAUTION_CAUSE_DETAIL[cause]}`);
    host.appendChild(item);
  }
}

// The verdict headline names the rung that actually decided, so it can never
// describe a different rule than the "Why" line beneath it. Level 3 in
// particular has several quite different causes.
function readoutVerdict(n, level, verdict = evaluateRoad(n)) {
  if (n.dismount) return 'Dismount required';
  if (level === 4) return 'Fails your rules';
  if (level === 3) return `Caution — ${CAUTION_CAUSE_NAME[verdict.caution] || 'ride with care'}`;
  if (level === 0) return 'Insufficient data';
  if (isBikeNetworkVerdict(n)) return 'Bike network — passes your rules';
  if (n.desig) return 'Designated bike route — passes your rules';
  return 'Passes your rules';
}
function readoutVerdictColor(n, level) {
  if (n.dismount) return COLORS[3];
  if (level === 4) return COLORS[4];
  if (level === 3) return COLORS[3];
  if (level === 0) return COLORS[0];
  if (isBikeNetworkVerdict(n)) return BIKE_NETWORK_COLOR;
  return COLORS[1];
}
const FACILITY_NAME = {
  1: 'Shared-lane marking (sharrow) — no dedicated space',
  2: 'Bike lane',
  3: 'Buffered bike lane',
  4: 'Separated bike lane',
  5: 'Shared-use path',
};
const ROAD_CLASS_NAME = {
  1: 'Residential', 2: 'Living street', 3: 'Unclassified/local',
  4: 'Tertiary road', 5: 'Tertiary link', 6: 'Secondary road',
  7: 'Secondary link', 8: 'Primary road', 9: 'Primary link',
  10: 'Trunk road', 11: 'Trunk link', 12: 'Motorway', 13: 'Motorway link',
};
// OSM's highway tag and FHWA's functional system answer the same question --
// what job does this road do in the network -- on two scales, so the card used
// to show both and leave the rider to reconcile "Secondary road" with "Minor
// arterial". They are normalised onto the FHWA scale, because that one is
// federally standardised and therefore the one that survives leaving
// Washington.
//
// The correspondence is the conventional US tagging one and it is approximate.
// Trunk and primary both land on principal arterial; nothing here can tell an
// Interstate from another freeway, so OSM motorway reports as freeway rather
// than claiming class 1. Where an official class exists it wins, and the card
// says which of the two it is showing.
const OSM_CLASS_TO_FUNCTIONAL = {
  1: 7, 2: 7,          // residential, living street -> local
  3: 6,                // unclassified               -> minor collector
  4: 5, 5: 5,          // tertiary                   -> major collector
  6: 4, 7: 4,          // secondary                  -> minor arterial
  8: 3, 9: 3,          // primary                    -> principal arterial
  10: 3, 11: 3,        // trunk                      -> principal arterial
  12: 2, 13: 2,        // motorway                   -> freeway or expressway
};
// ------------------------------------------- statewide road measurements
// FHWA functional class: a road's job in the network, assigned by the local
// agency, reviewed by WSDOT, approved by FHWA. Nationally standardised, which
// is what lets any of this generalise past Washington.
const FUNCTIONAL_CLASS_NAME = {
  1: 'Interstate', 2: 'Freeway or expressway', 3: 'Principal arterial',
  4: 'Minor arterial', 5: 'Major collector', 6: 'Minor collector',
  7: 'Local street',
};
const ROAD_OWNER_NAME = { 1: 'State', 2: 'County', 3: 'Town', 4: 'City' };
// Which inventory a traffic count came from. Mirrors ADT_SOURCE_* in
// scripts/roadmeasure.py and the decoder in router-worker.js.
//
// The label matters as much as the number. A county or state count was
// measured; HPMS models its non-state volumes rather than counting them, so
// "hpms" is a weaker claim than the other two and the card must not let them
// read alike. Where sources overlap the most recent wins, and on a tie a
// measured count beats a modelled one.
const ADT_SOURCE_COUNTY = 1;
const ADT_SOURCE_STATE = 2;
const ADT_SOURCE_HPMS = 3;
const ADT_SOURCE_NAME = {
  [ADT_SOURCE_COUNTY]: 'county',
  [ADT_SOURCE_STATE]: 'state',
  [ADT_SOURCE_HPMS]: 'HPMS est',
};

// Rows for the measurements imported from the CRAB road log, WSDOT's functional
// class layer and WSDOT's traffic counts.
//
// Each value carries a short provenance tag in parentheses, and that tag is the
// whole safeguard: these are three different kinds of claim and reading them as
// one is how a designated bike route came to look like a safety guarantee.
//   (county 2016) / (state 2025)  a MEASUREMENT, with who counted and when
//   (derived)                     computed from widths, not a ridable shoulder
//   (FHWA)                        a class, a proxy for volume, never a count
// The full reasoning lives in docs/SAFETY-MODEL.md; a card is not the place for
// it. Rows must fit a phone without turning the popup into a scroll.
//
// Display only. None of this reaches roadLevelExpr or the router.
function measurementRows(measures) {
  if (!measures) return [];
  const rows = [];
  if (measures.adt != null) {
    // The tag says which inventory the count came from, and for HPMS that it is
    // an estimate. The year does the work of flagging an old count -- "1977"
    // needs no adjective.
    const source = ADT_SOURCE_NAME[measures.adtSrc] || 'county';
    const when = measures.adty ? ` ${measures.adty}` : '';
    rows.push(['Traffic', `${measures.adt.toLocaleString()}/day (${source}${when})`]);
  }
  if (measures.edge != null) {
    rows.push(['Edge space', `~${measures.edge} ft `
      + `(derived${measures.edgeClamp ? ', capped' : ''})`]);
  }
  if (measures.countySh != null) {
    rows.push(['Shoulder', `${measures.countySh} ft (county)`]);
  }
  // The county's certified surface type. Display only, like every measurement
  // here: it earns model influence after field-testing, not before.
  if (measures.countySurface) {
    rows.push(['Surface', `${measures.countySurface} (county road log)`]);
  }
  return rows;
}

// The road's job in the network, from whichever source knows it, on one scale.
// `osmClass` is our numeric OSM highway class; `fallback` is the raw tag for the
// handful of types the numeric table does not cover.
function roadClassRow(measures, osmClass, fallback) {
  const official = measures && measures.fc;
  const level = official || OSM_CLASS_TO_FUNCTIONAL[osmClass];
  if (!level) return fallback ? [['Class', fallback]] : [];
  // An official class carries who maintains the road; an inferred one carries
  // only that it was inferred. Either way the tag says which, because these are
  // not equally strong claims: FHWA's is assigned by an agency and reviewed,
  // OSM's is whatever a mapper typed.
  const owner = official ? ROAD_OWNER_NAME[measures.owner] : null;
  const source = official
    ? `FHWA${owner ? ', ' + owner.toLowerCase() : ''}`
    : 'OSM';
  return [['Class', `${FUNCTIONAL_CLASS_NAME[level] || level} (${source})`]];
}

function routeClassNote(p) {
  if (p.infra || p.ferry || p.facility >= 1 || !p.roadClass) return null;
  if (p.roadClass >= 8 && p.roadClass <= 11)
    return 'Major-road proxy adds a strong soft cost because no bike facility is recorded.';
  if (p.roadClass >= 6 && p.roadClass <= 7)
    return 'Major-road proxy adds a moderate soft cost because no bike facility is recorded.';
  if (p.roadClass >= 4 && p.roadClass <= 5)
    return 'Tertiary-road proxy adds a small soft cost because no bike facility is recorded.';
  return null;
}
// Incline for a planned-route segment. The router bakes a signed grade into each
// segment relative to the direction of travel (positive = climbing), already
// gated to credible values (>=20 m long, <=40%). Because a tapped route segment
// is always part of the planned line, that direction is known, so the reading
// can name uphill vs downhill rather than only its steepness.
function routeSegmentGrade(gradePct, lenM) {
  const grade = Number(gradePct);
  if (!Number.isFinite(grade)) return null;
  if (grade === 0) {
    // The router reports 0 both for genuinely flat riding and for segments too
    // short to measure. Only call it level when the segment is long enough.
    return Number(lenM) >= 20 ? 'Level (under 0.1%)' : null;
  }
  const magnitude = (Math.round(Math.abs(grade) * 10) / 10).toString();
  return grade > 0 ? `${magnitude}% uphill ↗` : `${magnitude}% downhill ↘`;
}
// Plain-language reason for a segment's verdict, generated from the SAME
// evaluation that produced the level. It switches on the rung that actually
// fired, so the Verdict line and the Why line cannot describe different rules —
// which is exactly what they used to do.
function explainLevel(n, verdict = evaluateRoad(n)) {
  const spd = n.maxspeed_num;
  const shUnknown = n.shoulder_width == null;
  const sh = verdict.shoulder;
  // A rider who reads "5 ft shoulder" has to know whether that was surveyed or
  // derived from the county's operational width. Never present an inference as
  // a measurement.
  const shFacts = factsOf(n);
  const shInferred = SafetyModel.shoulderWasInferred(shFacts, rules);
  const shSource = shInferred
    ? ` (inferred from ${shFacts.edgeSpace} ft of county edge space, less ${SafetyModel.EDGE_SPACE_MARGIN_FT} ft)`
    : '';
  const spdTxt = spd != null ? `${spd} mph${n.est ? ' (est.)' : ''}` : 'This road';
  const area = n.urban ? 'urban' : 'rural';
  // The Why row explains; the Verdict row directly above it already states the
  // outcome. So this text never re-states the verdict -- no "Fails:" prefix, no
  // "passes your rules", and a caution clause that adds something the Verdict
  // line did not already say rather than repeating its own words back.
  const cautionNote = verdict.caution && verdict.caution !== 'sidewalk-fallback'
    ? (verdict.caution === 'high-stress'
        ? ` ${STRESS_AGENCY} rates it ${n.stressRating} of 4 for traffic stress.`
        : verdict.caution === 'limited-access'
          ? ' Ride the shoulder past on- and off-ramps.'
          : ` Take care: ${CAUTION_CAUSE_NAME[verdict.caution]}.`)
    : '';
  const shoulderTxt = shInferred
    ? `${sh} ft shoulder${shSource}, under your ${rules.minShoulder} ft minimum`
    : shUnknown
      ? `no shoulder recorded, so it counts as 0 ft against your ${rules.minShoulder} ft minimum`
      : `${sh} ft shoulder, under your ${rules.minShoulder} ft minimum`;

  // Access facts sit outside the ladder: they describe how you may use the
  // road, not how it scores.
  if (n.dismount) return 'Bikes are allowed, but you have to get off and walk.';

  switch (verdict.rule) {
    case 'prohibited':
      return n.wsdotBan
        ? `Bikes are banned here — a permanent ${Region.restrictionAgency} restriction.`
        : 'Bikes are banned here — the road is mapped as closed to cycling.';
    case 'ferry':
      return 'Crossing by ferry — road rules don’t apply on the boat.';
    case 'freeway':
      return rules.allowFreeways
        ? 'Limited-access freeway. You allow these as a last resort, so a route may use one,'
          + ' but it still counts as failing.'
        : 'Limited-access freeway. Your settings never route over one.';
    case 'infra':
      // The Verdict row already says "Bike network — passes your rules", so
      // this only has to name what kind of infrastructure it is.
      return verdict.level === 1
        ? 'Dedicated or protected bike path.'
        : verdict.level === 2
        ? 'Bike lane or shared path.'
        : 'Bike infrastructure, with no type recorded.';
    case 'speed-cap':
      return `${spdTxt} is over your ${rules.upperMaxSpeed} mph limit.`;
    case 'slow-street':
      return `${spdTxt} — slow enough to share the lane, so the shoulder and`
        + ` traffic rules don't apply.${cautionNote}`;
    case 'needs-space': {
      // Name every trigger that fired, not just the first. A road can be too
      // fast AND too busy, and being told only one of them invites a rider to
      // change the wrong setting.
      const why = spaceReasons(n).map((reason) => {
        if (reason === 'speed') return `${n.maxspeed_num} mph`;
        if (reason === 'lanes') {
          return `${n.lanes} lanes${n.ctl ? ' (incl. a centre turn lane)' : ''}`;
        }
        if (reason === 'traffic') return `${n.measures.adt.toLocaleString()} vehicles/day`;
        return `${FUNCTIONAL_CLASS_NAME[n.measures.fc] || 'major road'}, no count`;
      });
      return `Needs a bike lane or a safe-ish-width shoulder: ${why.join(', ')}.`;
    }
    case 'shares-lane':
      // This rung means none of the space triggers fired -- not fast, not wide,
      // not busy -- so all three are true and "slow and quiet" is accurate.
      return spd != null
        ? `${spdTxt} and light traffic, so no shoulder is needed.${cautionNote}`
        : `Slow and quiet enough to share the lane, so no shoulder is needed.${cautionNote}`;
    case 'sidewalk-fallback':
      return `${spdTxt} with ${shoulderTxt}. A sidewalk is mapped alongside and you`
        + ' allow that as a fallback, so routes avoid this road rather than reject it.';

    case 'unknown':
      return 'No speed or shoulder recorded here — not enough to judge it.';
    default:
      break;
  }

  // 'default': nothing failed and nothing shortcut it. Say what it met.
  const met = [];
  if ((n.facility || 0) >= 2 || n.good_facility) met.push('Has a bike lane or better');
  else if (!shUnknown) met.push(`${sh} ft shoulder, over your ${rules.minShoulder} ft minimum`);
  else if (shInferred) met.push(`${sh} ft shoulder${shSource}, over your ${rules.minShoulder} ft minimum`);
  else met.push(`No shoulder recorded, and this road is not fast or busy enough to need one`);
  if (spd != null)
    met.push(rules.noUpperLimit
      ? `${spdTxt}, and you have set no speed limit`
      : `${spdTxt}, under your ${rules.upperMaxSpeed} mph limit`);
  return `${met.join('; ')}.${cautionNote}`;
}

const HIT_LAYERS = [];  // hit-layer ids, registered as sources attach
const HIT_SRC = {};     // hit-layer id -> its source
// Clicking/tapping PINS the readout (so its links are clickable); hovering
// only previews and never replaces a pinned readout.
let readoutPinned = false;
let roadInfoSuppressedUntil = 0;

function dismissRoadInfo() {
  readoutPinned = false;
  readoutEl.classList.remove('show');
}

function suppressRoadInfo(ms = 1200) {
  roadInfoSuppressedUntil = Math.max(roadInfoSuppressedUntil, Date.now() + ms);
  dismissRoadInfo();
}

function attachHover(src, layerId) {
  HIT_LAYERS.push(layerId);
  HIT_SRC[layerId] = src;
}

// Topmost feature within a small tolerance box around the pointer/tap —
// forgiving for touch, and deterministic where several layers overlap.
//
// With one exception: an informational RIBBON never hides the road beneath it.
// The designated-route ribbon draws above roads by design, so tapping the
// Olympic Discovery Trail returned the ribbon's own card — a name, a network,
// and a note saying "the scored road supplies the safety verdict" — while
// showing nothing whatsoever about that road. On the ODT of all places, which
// runs 58.8 miles along ordinary road including US 101 at 60 mph with no
// shoulder. The card that mattered was the one being covered up.
//
// A scored feature therefore wins over a ribbon regardless of draw order, and
// the road card names the route anyway via routeBadgeAt. A ribbon still answers
// when nothing scored is under the tap.
// True when the tap landed inside a dismount marker's halo. A circle layer is
// hit-tested against its rendered radius, so this asks the question the rider
// is asking: "did I tap the warning triangle?"
function dismountMarkerAt(point) {
  if (!map.getLayer('route-dismount-halo')) return false;
  return map.queryRenderedFeatures([[point.x, point.y], [point.x, point.y]],
    { layers: ['route-dismount-halo'] }).length > 0;
}

function featureAt(point) {
  const layers = HIT_LAYERS.filter(
    (id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none'
  );
  if (!layers.length) return null;
  // Tapping the dismount marker has to answer, and the marker is wider than the
  // route line under it -- a tap on the triangle's corner would otherwise miss
  // the line and return whatever road happened to be behind it.
  const pad = dismountMarkerAt(point) ? DISMOUNT_MARKER_HIT_PX : 6;
  const feats = map.queryRenderedFeatures(
    [[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]],
    { layers }
  );
  if (!feats.length) return null;
  const isRibbon = (f) => !!(HIT_SRC[f.layer.id] || {}).ribbon;
  // queryRenderedFeatures returns topmost first, so the first non-ribbon is the
  // topmost scored feature.
  return feats.find((f) => !isRibbon(f)) || feats[0];
}

// Designated-route labels under a screen point (e.g. "US Bicycle Route 10"),
// deduped across overlapping relations; null when none or the layer is off.
function routeBadgeAt(point) {
  const lyr = 'routes__hit';
  if (!map.getLayer(lyr)) return null;
  const pad = 6;
  const fs = map.queryRenderedFeatures(
    [[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]], { layers: [lyr] });
  const labels = new Set();
  for (const f of fs) {
    const p = f.properties;
    const label = p.t === 'ncn' && /^\d+$/.test(p.r || '')
      ? 'US Bicycle Route ' + p.r
      : p.n || p.r;
    if (label) labels.add(label);
  }
  return labels.size ? [...labels].join(' · ') : null;
}

// WSDOT's BLTS layer does not carry OSM sidewalk tags.  Its coincident OSM
// state-road feature is still available in the vector tile, even though it is
// hidden from the normal road drawing to avoid duplicate lines.  Query that
// transparent probe at the tap so the WSDOT card can expose the same sidewalk
// context used by graph routing.
function wsdotSidewalkAt(lngLat) {
  if (!map.getLayer(stateSidewalkProbeId)) return 'not mapped';
  const point = map.project(lngLat);
  const pad = 7;
  const matches = map.queryRenderedFeatures(
    [[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]],
    { layers: [stateSidewalkProbeId] }
  );
  const props = matches[0]?.properties;
  return Number(props?.k) === 1 ? 'present'
    : Number(props?.k) === 2 ? 'absent' : 'not mapped';
}

function resetRoadInfoPosition() {
  readoutEl.classList.remove('near-tap');
  for (const property of ['left', 'right', 'top', 'bottom']) {
    readoutEl.style.removeProperty(property);
  }
}

// Put a tapped road card around the tap instead of always sending it to the
// top of the screen. Work in viewport coordinates for clamping, then convert
// back to the card's offset-parent coordinates for its absolute positioning.
function positionRoadInfoNear(point) {
  const edgeGap = 10;
  const mapRect = map.getContainer().getBoundingClientRect();
  const parentRect = readoutEl.offsetParent?.getBoundingClientRect() || { left: 0, top: 0 };
  readoutEl.classList.add('near-tap');
  readoutEl.style.left = '0px';
  readoutEl.style.right = 'auto';
  readoutEl.style.top = '0px';
  readoutEl.style.bottom = 'auto';

  // Reading the dimensions after showing the card forces one layout pass and
  // lets the final placement account for the actual amount of road data.
  const cardRect = readoutEl.getBoundingClientRect();
  const minLeft = mapRect.left + edgeGap;
  const minTop = mapRect.top + edgeGap;
  const maxLeft = Math.max(minLeft, mapRect.right - edgeGap - cardRect.width);
  const maxTop = Math.max(minTop, mapRect.bottom - edgeGap - cardRect.height);
  const tapX = mapRect.left + point.x;
  const tapY = mapRect.top + point.y;
  const viewportLeft = Math.min(maxLeft, Math.max(minLeft, tapX - cardRect.width / 2));
  const viewportTop = Math.min(maxTop, Math.max(minTop, tapY - cardRect.height / 2));
  readoutEl.style.left = `${Math.round(viewportLeft - parentRect.left)}px`;
  readoutEl.style.top = `${Math.round(viewportTop - parentRect.top)}px`;
}

// Google otherwise chooses an arbitrary initial panorama direction, which is
// often toward a building or ditch. Find the feature segment nearest the tap
// and use its bearing so Street View starts looking along the road instead.
function streetViewRoadHeading(feature, lngLat) {
  const geometry = feature?.geometry;
  const lines = geometry?.type === 'LineString' ? [geometry.coordinates]
    : geometry?.type === 'MultiLineString' ? geometry.coordinates : [];
  if (!lines.length) return null;

  const lat0 = lngLat.lat;
  const lng0 = lngLat.lng;
  const longitudeScale = Math.cos(lat0 * Math.PI / 180);
  let nearest = null;
  let nearestDistance = Infinity;

  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const start = line[i - 1];
      const end = line[i];
      if (!Array.isArray(start) || !Array.isArray(end)) continue;
      const ax = (start[0] - lng0) * longitudeScale;
      const ay = start[1] - lat0;
      const bx = (end[0] - lng0) * longitudeScale;
      const by = end[1] - lat0;
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSquared = dx * dx + dy * dy;
      if (!lengthSquared) continue;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
      const distanceSquared = (ax + t * dx) ** 2 + (ay + t * dy) ** 2;
      if (distanceSquared < nearestDistance) {
        nearestDistance = distanceSquared;
        nearest = [start, end];
      }
    }
  }
  if (!nearest) return null;

  const [start, end] = nearest;
  const lat1 = start[1] * Math.PI / 180;
  const lat2 = end[1] * Math.PI / 180;
  const deltaLng = (end[0] - start[0]) * Math.PI / 180;
  const y = Math.sin(deltaLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2)
    - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// WSDOT surveys each DIRECTION of a state highway separately, and the two
// genuinely disagree: on SR 104 at Kingston the same point carries 0 ft one way
// and 5-6 ft the other. Across the graph, 58,995 edges have a
// direction-dependent shoulder and 2,564 pass one way while failing the other.
//
// The route line has always been right about this -- the worker scores each
// segment with edgeShoulder(edge, forward), in the direction of travel. The
// CARD was not: it printed whichever of the two features the tap happened to
// hit, with nothing saying a second answer existed.
//
// The direction is in the route id: WSDOT suffixes `i` for increasing milepost
// and `d` for decreasing. Two features sharing a route number but differing in
// that suffix are the two sides of one road.
const routeDirectionLabel = (routeIdentifier) => Region.routeDirection(routeIdentifier);
const routeBaseId = (routeIdentifier) => Region.routeBase(routeIdentifier);
// The opposite-direction segment under the same screen point, when it reports a
// different shoulder. Returns null when there is no sibling or they agree.
function wsdotOppositeShoulder(point, p) {
  if (!point || !map.getLayer('blts__hit')) return null;
  const base = routeBaseId(p.RouteIdentifier);
  if (!base) return null;
  const pad = 8;
  const feats = map.queryRenderedFeatures(
    [[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]],
    { layers: ['blts__hit'] });
  for (const f of feats) {
    const q = f.properties;
    if (routeBaseId(q.RouteIdentifier) !== base) continue;
    if (String(q.RouteIdentifier) === String(p.RouteIdentifier)) continue;
    if (q.ShoulderWidth == null || q.ShoulderWidth === p.ShoulderWidth) continue;
    return q;
  }
  return null;
}
// "6 ft" when both directions agree or only one is known; otherwise both, each
// named, because a single number would be a claim the data does not support.
function wsdotShoulderText(point, p) {
  if (p.ShoulderWidth == null) return null;
  const other = wsdotOppositeShoulder(point, p);
  if (!other) return `${p.ShoulderWidth} ft`;
  const here = routeDirectionLabel(p.RouteIdentifier);
  const there = routeDirectionLabel(other.RouteIdentifier);
  if (!here || !there) return `${p.ShoulderWidth} ft here, ${other.ShoulderWidth} ft the other way`;
  return `${p.ShoulderWidth} ft (${here}), ${other.ShoulderWidth} ft (${there})`;
}

function renderReadout(feature, lngLat, anchorPoint = null) {
  resetRoadInfoPosition();
  const src = HIT_SRC[feature.layer.id];
  const p = feature.properties;
  if (src.closure) {
    // The one overlay that cannot be switched off must be able to explain
    // itself: these circles were the only marks on the map a tap ignored,
    // which is how a bus loop in Everett became a field mystery.
    const rows = [
      ['Name', p.name || 'Closed route segment'],
      ['Why', p.reason || null],
      ['Affects', p.routes || null],
      ['Source', 'Reported in OpenStreetMap — the router already avoids it'],
    ].filter(([, value]) => value != null && value !== '');
    readoutEl.replaceChildren();
    const closeBtn = document.createElement('button');
    closeBtn.className = 'readout-close';
    closeBtn.setAttribute('aria-label', 'Close road information');
    closeBtn.textContent = '✕';
    const head = document.createElement('div');
    head.className = 'rt-title';
    const dot = document.createElement('span');
    dot.className = 'rt-swatch';
    dot.setAttribute('role', 'img');
    dot.style.backgroundColor = COLORS[4];
    dot.setAttribute('aria-label', 'Route closure map color');
    const headText = document.createElement('span');
    headText.textContent = 'Route closure (OSM)';
    head.append(dot, headText);
    const tbl = document.createElement('table');
    for (const [key, value] of rows) {
      const tr = document.createElement('tr');
      const keyCell = document.createElement('td');
      keyCell.className = 'k';
      keyCell.textContent = key;
      const valueCell = document.createElement('td');
      valueCell.textContent = String(value);
      tr.append(keyCell, valueCell);
      tbl.appendChild(tr);
    }
    readoutEl.append(closeBtn, head, tbl);
    readoutEl.classList.add('show');
    if (anchorPoint) positionRoadInfoNear(anchorPoint);
    return;
  }
  const n = src.scorer(p);            // recompute normalized props from this feature
  // One evaluation drives the headline, the reason, and the colour. It used to
  // read p.level (the router's answer) for the headline and re-derive the
  // reason, so a card could say "Passes your rules" above "Fails: ...". Both
  // sides now ask safety-model.js, and asking once here means the card cannot
  // disagree with itself even if they ever diverge again.
  const verdict = evaluateRoad(n);
  const lvl = verdict.level;
  const common = [
    ['Verdict', readoutVerdict(n, lvl, verdict)],
    ['Why', explainLevel(n, verdict)],
  ];
  let title, rows;
  if (src.id === 'routeseg') {
    title = 'Your route — segment';
    if (p.ferry === 1) {
      rows = [
        ['Name', p.name || 'Ferry crossing'],
        ['Result', '⛴ Ferry'],
        ['Why', 'Crossing by ferry — road rules don’t apply on the boat.'],
        ['Speed', p.mph ? `~${p.mph} mph crossing` : null],
      ];
    } else {
      const routeVerdict = p.crossing === 1 ? [
        ['Verdict', 'Blue — Intersection crossing'],
        ['Why', 'Short crossing between passing route segments; treated as crossing the road, not riding along it.'],
      ] : common;
      rows = [
        ['Name', p.name || '(unnamed road)'],
        ['Access', p.dismount === 1 ? 'Dismount required — walk your bike.' : null],
        ...routeVerdict,
        ['Speed limit', p.mph != null && !p.infra ? `${p.mph} mph${p.e ? ' (estimated from class)' : ''}` : null],
        ['Speed source', p.official & 1 ? `${Region.speedAgency} legal speed` : null],
        ['Shoulder', p.sh >= 0 ? `${p.sh} ft${p.shBack != null && p.shBack >= 0
          && p.shBack !== p.sh
          ? ` your direction (${p.shBack} ft the other way)` : ''}` : null],
        ['Lanes', p.lanes ? `${p.lanes}${p.ctl ? ', incl. centre turn lane' : ''}` : null],
        ['Traffic stress', p.lts ? `${STRESS_AGENCY} rates it ${p.lts} of 4 (Level of Traffic Stress)` : null],
        // One builder, so the route card and the tap card cannot describe the
        // same road with different numbers.
        ...measurementRows(n.measures),
        ...roadClassRow(n.measures, p.roadClass, null),
        ['Grade', routeSegmentGrade(p.gradePct, p.lenM)],
        ['Area', n.urban ? 'Urban (Census)' : 'Rural (Census)'],
        ['Sidewalk (OSM)', n.sidewalk || 'not mapped'],
        ['Rule override', sidewalkFallbackApplies(n) ? 'Sidewalk fallback — strongly deprioritized' : null],
        ['Bike facility', FACILITY_NAME[p.facility] || null],
        ['Facility source', p.official & 2 ? Region.facilitySourceName : null],
        ['Surface (OSM)', routeSurfaceLabel(p.surface)],
        ['Route choice', routeClassNote(p)],
        ['Type', p.infra ? 'Dedicated bike infrastructure' : (p.fw || p.lim) ? 'Limited-access highway' : null],
        ['Trail type', p.mtb ? 'Mountain-bike trail — allowed by your Settings option' : null],
        ['Curve caution', p.hazard ? `Possible limited-visibility uphill curve${p.gradePct ? ` (${p.gradePct}% net grade)` : ''}; inferred, not measured sight distance` : null],
      ];
    }
  } else if (src.id === 'routes') {
    title = 'Designated bike route';
    const isUSBR = p.t === 'ncn' && /^\d+$/.test(p.r || '');
    rows = [
      ['Name', p.n || null],
      ['Route', isUSBR ? 'US Bicycle Route ' + p.r : p.r || null],
      ['Network', p.t === 'ncn' ? 'National (AASHTO-designated)' : 'Regional trail / route'],
      ['Map symbol', 'Blue dashed — designated cycling corridor'],
      ['Note', 'A designation is not necessarily a bike facility. The scored road or facility supplies the safety verdict and takes visual precedence.'],
    ];
  } else if (src.id === 'restrict') {
    title = Region.restrictionLayerName;
    rows = [
      ['Route', p.Route ? 'SR ' + String(p.Route).replace(/^0+/, '') : p.RouteIdentifier],
      ['Verdict', 'Red dashed — Fails your rules'],
      ['Why', `Permanent bicycle restriction by official ${Region.restrictionAgency} traffic action.`],
      ['Direction', p.Direction],
      ['Mileposts', p.BeginMile != null ? `${p.BeginMile} – ${p.EndMile}` : null],
      ['Note', p.Comment],
    ];
  } else if (src.id === 'osm') {
    title = 'Bike infrastructure (OSM)';
    rows = [
      ['Name', p.name],
      ...common,
      ['Type', [p.highway, p.bicycle ? `bicycle=${p.bicycle}` : null].filter(Boolean).join(', ')],
      ['Cycleway', osmCycleway(p)],
      ['Trail type', p.mtb === 1 ? 'Mountain-bike trail — hidden and not routed unless enabled in Settings' : null],
      ['Surface', p.surface],
      ['Width', p.width != null ? `${p.width} m` : null],
    ];
  } else if (src.id === 'roads') {
    title = p.d ? `Road (OSM geometry + ${Region.speedAgency} data)` : 'Road (OSM)';
    rows = [
      ['Name', p.n],
      ...common,
      // Tapping a road off the route and a segment of the route describe the
      // same street, so they use one vocabulary. Grade and curve caution stay
      // exclusive to the route card: both need elevation along a direction of
      // travel, which the map tiles do not carry.
      ['Speed limit', p.s != null ? `${p.s} mph${p.e ? ' (estimated from class)' : ''}` : null],
      // `w` keeps the WORSE direction (it is what the map paints); `w2` is
      // the better one when the inventory recorded the two sides differently.
      // An unlabelled collapse reads as this card contradicting a route card
      // that shows the direction actually ridden.
      ['Shoulder', p.w != null
        ? `${p.w} ft${p.w2 != null ? `–${p.w2} ft, varies by direction` : ''}`
          + `${p.wsh ? ` (${Region.stressAgency} inventory)` : ''}`
        : null],
      // Where a city has signed its arterials at the same limit as its side
      // streets, lane count is the thing that still tells them apart.
      ['Lanes', p.ln ? `${p.ln}${p.ctl ? ', incl. centre turn lane' : ''}` : null],
      ['Traffic stress', p.lts ? `${STRESS_AGENCY} rates it ${p.lts} of 4 (Level of Traffic Stress)` : null],
      ...measurementRows(n.measures),
      ...roadClassRow(n.measures, p.rc, p.h ? p.h + (p.r ? ` (${p.r})` : '') : null),
      // Off the state highway system this is often the only inventory there is.
      ['Area', n.urban ? 'Urban (Census)' : 'Rural (Census)'],
      ['Sidewalk (OSM)', n.sidewalk || 'not mapped'],
      ['Rule override', sidewalkFallbackApplies(n) ? 'Sidewalk fallback — strongly deprioritized' : null],
      // Typed from OSM or the official WSDOT registry (fo=1); the registry's
      // construction detail rides along when it recorded any.
      ['Bike facility', FACILITY_NAME[p.ft]
        ? FACILITY_NAME[p.ft]
          + [p.fbw ? `${p.fbw} ft buffer` : null, p.fsm || null,
            p.fsd ? `${String(p.fsd).toLowerCase()} side(s)` : null]
            .filter(Boolean).map((part) => `, ${part}`).join('')
          + (p.fo ? ` (${Region.facilitySourceName})` : '')
        : (p.f ? 'Recorded bike facility' : null)],
      ['Surface (OSM)', routeSurfaceLabel(p.su)],
      ['Route choice', routeClassNote({ roadClass: p.rc, facility: p.ft || (p.f ? 1 : 0) })],
      ['Road data', p.d ? `${Region.speedAgency} directions combined conservatively for map display` : null],
      ['Limited access', p.m || p.l ? 'yes' : null],
      ['Bikes prohibited', p.b ? (p.d ? `yes (OSM or ${Region.restrictionAgency})` : 'yes (OSM tag)') : null],
    ];
  } else {
    title = `Road segment (${Region.stressAgency})`;
    rows = [
      ['Route', p.RouteIdentifier],
      ...common,
      ['BLTS (WSDOT)', p.LTS_Bicycle],
      ['Speed limit', p.SpeedLimit != null ? p.SpeedLimit + ' mph' : null],
      ['Lanes', p.LaneCount],
      ['AADT', p.AADT != null ? Number(p.AADT).toLocaleString() : null],
      ['Shoulder', wsdotShoulderText(anchorPoint, p)],
      ['Area', n.urban ? 'Urban (Census)' : 'Rural (Census)'],
      ['Sidewalk (OSM)', wsdotSidewalkAt(lngLat)],
      ['Bike facility', p.BikeFacilityType],
      ['Designated bike route', p.Designated === 1 ? 'yes' : null],
      ['Limited access', p.LimitedAccess ? 'yes' : null],
      ['Bikes prohibited', p.Prohibited ? 'yes (WSDOT restriction)' : null],
    ];
  }
  // If a designated route runs through this spot, include its designation in
  // the road details even though the ribbon is already visible on the map.
  if (src.id !== 'routes') {
    // routeBadgeAt can only name the route while its ribbon layer is switched
    // on. The road itself records that it belongs to one, so fall back to that
    // rather than silently dropping the fact when the layer is hidden.
    const badge = routeBadgeAt(map.project(lngLat));
    if (badge) rows.push(['Bike route', badge]);
    else if (p.g) rows.push(['Bike route', 'On a designated route (USBR / regional trail)']);
  }
  rows = rows.filter(([, v]) => v != null && v !== '');
  const svLat = lngLat.lat, svLng = lngLat.lng;
  const svHeading = streetViewRoadHeading(feature, lngLat);
  readoutEl.replaceChildren();
  const close = document.createElement('button');
  close.className = 'readout-close';
  close.setAttribute('aria-label', 'Close road information');
  close.textContent = '✕';
  const heading = document.createElement('div');
  heading.className = 'rt-title';
  const swatch = document.createElement('span');
  swatch.className = 'rt-swatch';
  swatch.setAttribute('role', 'img');
  swatch.style.backgroundColor = src.id === 'routes' ? COLORS[1]
    : src.id === 'restrict' ? COLORS[4]
      : p.ferry === 1 ? COLORS[0] : readoutVerdictColor(n, lvl);
  swatch.setAttribute('aria-label', src.id === 'routes'
    ? 'Designated route map color' : `Map color: ${readoutVerdict(n, lvl, verdict)}`);
  const headingText = document.createElement('span');
  headingText.textContent = title;
  heading.append(swatch, headingText);
  const table = document.createElement('table');
  for (const [key, value] of rows) {
    const tr = document.createElement('tr');
    const keyCell = document.createElement('td');
    keyCell.className = 'k';
    keyCell.textContent = key;
    const valueCell = document.createElement('td');
    valueCell.textContent = String(value);
    tr.append(keyCell, valueCell);
    table.appendChild(tr);
  }
  const mapActions = document.createElement('div');
  mapActions.className = 'road-map-actions';
  const streetViewBtn = document.createElement('button');
  streetViewBtn.type = 'button';
  streetViewBtn.className = 'streetview-launch';
  streetViewBtn.setAttribute('aria-label', STREET_VIEW_IN_APP
    ? 'Open Street View in this app' : 'Open Street View in Google Maps');
  streetViewBtn.textContent = 'Google Street View';
  streetViewBtn.addEventListener('click', () => openStreetView(svLat, svLng, svHeading));

  const mapLink = document.createElement('a');
  mapLink.href = googleMapsPointUrl(svLat, svLng);
  mapLink.target = '_blank';
  mapLink.rel = 'noopener';
  mapLink.className = 'road-map-link';
  mapLink.textContent = 'Google Maps ↗';
  mapLink.setAttribute('aria-label', 'Open this location in Google Maps');
  mapActions.append(streetViewBtn, mapLink);
  // Add or remove a road block on the road being read about, without dismissing
  // the card, finding the arm button and tapping the map again.
  //
  // Pinned to the card's bottom-right corner, mirroring the ✕ in the top-right.
  //
  // Three earlier placements and why each was wrong: in the action row's normal
  // order it sat among Street View and Google Maps, the two links OUT of the
  // app, so an action on your route read as a third destination. Under the ✕ it
  // was set apart but silent -- a 34 px gutter has no room for a word. At the
  // row's right end it was still inside the card's 43 px right padding, so it
  // stopped short of the corner and read as trailing the links rather than
  // owning its own place.
  //
  // Absolute, so it escapes that padding and sits flush. It cannot collide with
  // the links: the card already reserves that 43 px gutter for the close
  // button, and the action row never reaches into it.
  const existingBlock = roadBlockNear({ lng: svLng, lat: svLat });
  // Removing is always offered when there is something to remove. Adding is
  // offered only when it would work: a block needs both endpoints set, and a
  // route may carry at most MAX_ROAD_BLOCKS.
  const canAdd = routing.start && routing.end && routing.blocks.length < MAX_ROAD_BLOCKS;
  if (existingBlock || canAdd) {
    const toggle = document.createElement('div');
    toggle.className = 'road-block-toggle';
    const label = document.createElement('span');
    label.className = 'road-block-toggle-label';
    label.textContent = existingBlock ? 'Remove' : 'Add';
    const blockBtn = document.createElement('button');
    blockBtn.type = 'button';
    blockBtn.className = 'road-block-add';
    blockBtn.innerHTML = '<span aria-hidden="true">🚧</span>';
    blockBtn.title = existingBlock
      ? 'Remove the road block here' : 'Add a road block here and route around it';
    blockBtn.setAttribute('aria-label', blockBtn.title);
    blockBtn.addEventListener('click', () => {
      if (existingBlock) {
        removeRoadBlock(existingBlock);
        dismissRoadInfo();
        return;
      }
      // The point that opened the card, snapped onto the route the same way a
      // placement tapped on the map is.
      if (addRoadBlock({ lng: svLng, lat: svLat })) {
        dismissRoadInfo();
        setRouteStatus('Road block added — routing around it');
      }
    });
    toggle.append(label, blockBtn);
    readoutEl.append(toggle);
  }
  readoutEl.append(close, heading, table, mapActions);
  readoutEl.classList.add('show');
  if (anchorPoint) positionRoadInfoNear(anchorPoint);
}

readoutEl.addEventListener('click', (e) => {
  if (!e.target.closest('.readout-close')) return;
  dismissRoadInfo();
});

// In-app Street View. With a Google Maps Embed API key the panorama opens in a
// dialog iframe so the PWA is never left; without one it opens Google Maps in a
// new tab as before. The key is a public, HTTP-referrer-restricted Embed API
// key (that API has no usage charges); set it here to enable the in-app view.
const GOOGLE_MAPS_EMBED_KEY = 'AIzaSyBQZNQ4jPlLjOH3efOD228wOjayupCfa6Y';
const NATIVE_STREET_VIEW_BRIDGE = 'https://nothinglabs.github.io/clauding/street-view-embed.html';
// iOS kills the whole web process rather than let a page hold two WebGL
// scenes this heavy: Google's panorama stacked on the map's own context took
// the app down at launch. On any iOS device Street View opens in the OS
// browser sheet instead -- one tap back, and it cannot take the app with it.
const IOS_DEVICE = /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const STREET_VIEW_IN_APP = Boolean(GOOGLE_MAPS_EMBED_KEY) && !IOS_DEVICE;

function googleMapsPointUrl(lat, lng) {
  return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

let streetViewLoadTimer = null;
function setStreetViewLoadStatus(message = '', warning = false) {
  const status = document.getElementById('streetViewLoadStatus');
  if (!status) return;
  status.textContent = message;
  status.hidden = !message;
  status.classList.toggle('warning', warning);
}

function openStreetView(lat, lng, heading = null) {
  const external = googleStreetViewUrl(lat, lng, heading);
  if (!STREET_VIEW_IN_APP) {
    // A real link click (not window.open with a features string, which iOS
    // turns into a chrome-laden popup window) so the OS opens its clean in-app
    // browser — on an installed PWA that comes with a Done button back to here.
    const a = document.createElement('a');
    a.href = external;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  const dialog = document.getElementById('streetViewDialog');
  const frame = document.getElementById('streetViewFrame');
  const externalLink = document.getElementById('streetViewExternal');
  if (externalLink) externalLink.href = googleMapsPointUrl(lat, lng);
  const headingParam = Number.isFinite(heading) ? `&heading=${Math.round(heading)}` : '';
  const nativeRuntime = document.documentElement.dataset.appRuntime === 'native'
    || window.location.protocol === 'capacitor:'
    || Boolean(window.Capacitor?.isNativePlatform?.());
  clearTimeout(streetViewLoadTimer);
  frame.dataset.streetViewActive = '1';
  frame.dataset.streetViewBridge = nativeRuntime ? '1' : '0';
  setStreetViewLoadStatus('Loading Street View…');
  streetViewLoadTimer = setTimeout(() => {
    if (frame.dataset.streetViewActive === '1') {
      setStreetViewLoadStatus('Street View is taking longer than expected. Try Open in Google Maps.', true);
    }
  }, 12000);
  frame.src = nativeRuntime
    ? `${NATIVE_STREET_VIEW_BRIDGE}?lat=${lat.toFixed(6)}&lng=${lng.toFixed(6)}${headingParam}`
    : `https://www.google.com/maps/embed/v1/streetview?key=${encodeURIComponent(GOOGLE_MAPS_EMBED_KEY)}&location=${lat.toFixed(6)},${lng.toFixed(6)}&radius=250${headingParam}&fov=90`;
  if (!dialog.open) dialog.showModal();
}

document.getElementById('streetViewFrame').addEventListener('load', (event) => {
  if (event.currentTarget.dataset.streetViewActive !== '1') return;
  // The native frame first loads the hosted bridge. Wait for its inner Google
  // panorama to report ready instead of hiding feedback on this outer load.
  if (event.currentTarget.dataset.streetViewBridge === '1') return;
  clearTimeout(streetViewLoadTimer);
  streetViewLoadTimer = null;
  setStreetViewLoadStatus();
});
document.getElementById('streetViewFrame').addEventListener('error', (event) => {
  if (event.currentTarget.dataset.streetViewActive !== '1') return;
  clearTimeout(streetViewLoadTimer);
  streetViewLoadTimer = null;
  setStreetViewLoadStatus('Street View could not load. Try Open in Google Maps.', true);
});
window.addEventListener('message', (event) => {
  if (event.origin !== 'https://nothinglabs.github.io'
    || event.data?.type !== 'jra-street-view') return;
  const frame = document.getElementById('streetViewFrame');
  if (frame.dataset.streetViewActive !== '1' || frame.dataset.streetViewBridge !== '1') return;
  clearTimeout(streetViewLoadTimer);
  streetViewLoadTimer = null;
  setStreetViewLoadStatus(event.data.state === 'ready'
    ? '' : 'Street View could not load. Try Open in Google Maps.', event.data.state !== 'ready');
});

// Stop the panorama streaming (and free the connection) when the dialog closes.
document.getElementById('streetViewDialog').addEventListener('close', () => {
  clearTimeout(streetViewLoadTimer);
  streetViewLoadTimer = null;
  const frame = document.getElementById('streetViewFrame');
  frame.dataset.streetViewActive = '0';
  frame.dataset.streetViewBridge = '0';
  frame.src = 'about:blank';
  setStreetViewLoadStatus();
});

// A pinned road card belongs to the map inspection interaction. Any click on
// the app UI outside the map dismisses it, while clicks on the map can inspect
// another road and clicks inside the card can still use Street View or Close.
document.addEventListener('click', (e) => {
  if (!readoutEl.classList.contains('show')) return;
  if (e.target.closest('#map') || e.target.closest('#readout')) return;
  dismissRoadInfo();
});

// ONE global handler pair (per-layer handlers raced where layers overlap).
const roadInfoHoverMedia = window.matchMedia('(hover: hover) and (pointer: fine)');
// Road information opens on a CLICK, never on hover. A hover preview meant the
// card followed the pointer across the map and rewrote itself continuously,
// which made it impossible to read one road while moving toward its controls.
// Hovering still says a road is there, by changing the cursor, and nothing else.
map.on('mousemove', (e) => {
  if (!roadInfoHoverMedia.matches) return;
  if (routing.arm || Date.now() < roadInfoSuppressedUntil) return;
  map.getCanvas().style.cursor = featureAt(e.point) ? 'pointer' : '';
});
let lastPlacementTs = 0;
let lastRoadInfoTouchAt = 0;

function inspectRoadAt(point, lngLat = null) {
  if (Date.now() < roadInfoSuppressedUntil) return false;
  const feature = featureAt(point);
  if (!feature) {
    dismissRoadInfo();
    return false;
  }
  // The road readout sits at the top of the screen, clear of the bottom panel,
  // so tapping a road no longer dismisses an open menu.
  renderReadout(feature, lngLat || map.unproject([point.x, point.y]), point);
  readoutPinned = true;
  return true;
}

function placeArmedPoint(lngLat) {
  const kind = routing.arm;
  if (!kind) return false;
  lastPlacementTs = Date.now();
  suppressRoadInfo(1500);
  routing.arm = null;
  updateArmButtons();
  closePlacePicker(false);
  if (kind === 'via') {
    const added = addVia(lngLat);
    if (added) setRouteStatus(routing.vias.length >= MAX_ROUTE_STOPS
      ? `Waypoint added — maximum of ${MAX_ROUTE_STOPS} reached`
      : 'Waypoint added — use ⋮ to add another');
    return true;
  }
  if (kind === 'block') {
    const added = addRoadBlock(lngLat);
    if (added) setRouteStatus(routing.blocks.length >= MAX_ROAD_BLOCKS
      ? `Road block added — maximum of ${MAX_ROAD_BLOCKS} reached`
      : 'Road block added — use ⋮ to add another');
    return true;
  }
  setRoutePoint(kind, lngLat);
  if (!(routing.start && routing.end)) {
    // Confirm the placement; riders choose the next endpoint themselves.
    setRouteStatus(kind === 'start' ? 'Start set' : 'Destination set');
  }
  return true;
}

// Handle deliberate taps directly on touch devices. A tap during map momentum
// does not always produce MapLibre's later `click`, so this is the dependable
// path for both endpoint placement and pinned road information.
(() => {
  const canvas = map.getCanvasContainer();
  let t0 = null;
  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { t0 = null; return; }
    const t = e.touches[0];
    t0 = { x: t.clientX, y: t.clientY, ts: Date.now() };
  }, { passive: true });
  canvas.addEventListener('touchend', (e) => {
    if (!t0) return;
    const t = e.changedTouches[0];
    const moved = Math.hypot(t.clientX - t0.x, t.clientY - t0.y);
    const dur = Date.now() - t0.ts;
    t0 = null;
    if (moved >= 12 || dur >= 700) return;
    const rect = map.getCanvas().getBoundingClientRect();
    const point = { x: t.clientX - rect.left, y: t.clientY - rect.top };
    const lngLat = map.unproject([point.x, point.y]);
    if (routing.arm) {
      // Consume the placement tap. Otherwise iOS/MapLibre can emit a later
      // synthetic click that opens the road-information card underneath it.
      e.preventDefault();
      e.stopPropagation();
      placeArmedPoint(lngLat);
      return;
    }
    if (inspectRoadAt(point, lngLat)) {
      lastRoadInfoTouchAt = Date.now();
      e.preventDefault();
      e.stopPropagation();
    }
  }, { passive: false });
})();

map.on('click', (e) => {
  if (routing.arm) {
    placeArmedPoint(e.lngLat);
    return;
  }
  if (Date.now() < roadInfoSuppressedUntil
      || Date.now() - lastPlacementTs < 600
      || Date.now() - lastRoadInfoTouchAt < 600) return;
  inspectRoadAt(e.point, e.lngLat);
});

/* ----------------------------------------------------- build panels */
function updateSourceCount(src) {
  const el = document.querySelector(`#src-${src.id} .count`);
  const count = src.count != null ? src.count : src.fc && src.fc.features.length;
  if (el && count != null) el.textContent = count.toLocaleString();
}

function buildSourcePanel() {
  const host = document.getElementById('sources');
  // Clear first. Every other panel builder does; this one appended, so a second
  // call would stack a duplicate set of eight toggles carrying duplicate DOM
  // ids, and getElementById would then answer with a stale row whose checkbox
  // no longer tracks the layer. Only called once today, which is exactly why it
  // had never shown up.
  host.replaceChildren();
  host.className = 'layer-toggle-grid';
  const items = [
    ['offstreetTrails', 'Off-street trails', 'trail'],
    ['bikeFacilities', 'Trusted bike lanes', 'facility'],
    ['meetRules', 'Road meets safety rules', 'meets'],
    ['failRules', 'Road fails safety rules', 'fails'],
    ['caution', 'Caution — ride with care', 'caution'],
    ['designated', 'State & national bike routes', 'designated'],
    ['unpavedBackground', 'Unpaved surfaces', 'unpaved'],
    ['bikesProhibited', 'Bikes prohibited', 'prohibited'],
  ];
  for (const [key, label, swatch] of items) {
    const row = document.createElement('div');
    row.className = 'layer-toggle';
    row.id = `layer-${key}`;
    row.innerHTML = `
      <input type="checkbox" id="chk-layer-${key}" ${savedLayer(key) ? 'checked' : ''}>
      <label for="chk-layer-${key}"><span class="layer-toggle-swatch ${swatch}" aria-hidden="true"></span><span>${label}</span></label>`;
    host.appendChild(row);
    row.querySelector('input').addEventListener('change', (e) =>
      setMapLayerVisible(key, e.target.checked)
    );
  }
}

// The editor used to list every weight as its own row, so a single cost showed
// up three times with near-identical labels ("Tertiary . direct", "Tertiary .
// balanced", "Tertiary . friendly"). That buried the one idea a reader needs:
// most costs exist once and are simply priced differently by the three riding
// modes. Here a cost is described once, and its three mode sliders sit under
// that description.
//
// An entry is either a single weight ({ key }) or a mode triple ({ base }),
// where the three keys are base + 'Direct' / 'Balanced' / 'LowStress'.
const WEIGHT_MODES = [
  ['Direct', 'Direct', 'Shortest sensible ride.'],
  ['Balanced', 'Balanced', 'The default trade-off.'],
  ['LowStress', 'Low stress', 'Takes real detours to avoid unpleasant road.'],
];
const ROUTING_WEIGHT_GROUPS = [
  ['Roads that fail your rules', 'How far out of the way to go to avoid road your Limits already reject, and how much to seek out road that clears them comfortably.', [
    { base: 'failRoad', label: 'Avoid a failing road', min: 1, max: 60, step: .1,
      hint: 'Multiplies time on any road your Limits fail. Higher = longer detours to dodge it. Never a ban: if failing pavement is unavoidable the route still returns, with those stretches flagged.' },
    { base: 'comfyRoad', label: 'Seek out a comfortable road', min: .5, max: 1.2, step: .01, modes: ['Balanced', 'LowStress'],
      hint: 'Below 1 rewards road that clears your rules with room to spare. Direct mode does not use this.' },
    { key: 'freeway', label: 'Freeway, absolute last resort', min: 5, max: 100, step: 1,
      hint: 'Only reachable where a freeway shoulder is legally open to bikes and nothing else connects.' },
  ]],
  ['Bike infrastructure and quiet streets', 'Bonuses, not rules. Below 1 makes a mile feel shorter to the router, so it will ride further to use one.', [
    // The floors sit below the defaults on purpose. When the shipped default IS
    // the floor the slider only moves one way, so a rider who wants trails
    // sought out even harder has no control left to move.
    { key: 'facilityPath', label: 'Shared-use path or trail', min: .1, max: 1.1, step: .01,
      hint: 'Fully separated from traffic. The strongest bonus there is.' },
    { key: 'facilitySeparated', label: 'Separated bike lane', min: .15, max: 1.1, step: .01,
      hint: 'Physical barrier between you and the traffic lane.' },
    { key: 'facilityBuffered', label: 'Buffered bike lane', min: .2, max: 1.1, step: .01,
      hint: 'Painted buffer, no barrier.' },
    { key: 'facilityLane', label: 'Bike lane', min: .25, max: 1.1, step: .01,
      hint: 'An ordinary striped lane.' },
    { key: 'facilityShared', label: 'Sharrow / shared-lane marking', min: .4, max: 1.2, step: .01,
      hint: 'Paint in the traffic lane. Almost no protection, so almost no bonus.' },
    { key: 'residential', label: 'Residential street', min: .4, max: 1.1, step: .01,
      hint: 'Applies to the OSM residential and living-street classes, not to anything merely signed 25 mph.' },
    { key: 'designated', label: 'Signed bike route, no infrastructure', min: .25, max: 1.2, step: .01,
      hint: 'A route number on a sign. Deliberately a small bonus: signage is context, not protection.' },
    { key: 'strongDesignated', label: 'Signed bike route, when you asked to prefer them', min: .2, max: 1, step: .01,
      hint: 'Replaces the value above while "Heavily prefer bike routes & trails" is on.' },
    { key: 'mtbTrail', label: 'Mountain-bike trail, when your rules allow one', min: 1, max: 30, step: .5,
      hint: 'Above 1: rideable on a mountain bike, avoided unless it is the only link.' },
  ]],
  ['Traffic volume', 'Priced from a measured vehicle count where the state or county has one, the FHWA functional class where it does not, and the OSM road tag only as a last resort. Thresholds match the "Road is busier than" setting in Limits. Any recorded bike facility clears these entirely.', [
    { key: 'useMeasuredTraffic', label: 'Trust measurements over OSM road tags', min: 0, max: 1, step: .05,
      hint: 'Set to 0 to price traffic purely from OSM tags, exactly as the app did before the statewide counts were imported. 1 lets a real count or official class override the tag. Useful for telling whether the data is helping you.' },
    { base: 'busyLight', label: 'Light traffic', min: 1, max: 3, step: .01,
      hint: 'Over 2,000 vehicles/day, or an FHWA major collector.' },
    { base: 'busyMedium', label: 'Medium traffic', min: 1, max: 4, step: .01,
      hint: 'Over 6,000 vehicles/day, or an FHWA minor arterial.' },
    { base: 'busyHeavy', label: 'Heavy traffic', min: 1, max: 5, step: .01,
      hint: 'Over 15,000 vehicles/day, or an FHWA principal arterial and up.' },
  ]],
  ['Road size and stress rating', 'Two signals for roads where the speed limit has stopped telling you anything. Physical separation exempts an edge; paint halves the cost. The two are combined by taking the larger, not by multiplying.', [
    { base: 'wideRoad', label: 'Four or more lanes', min: 1, max: 4, step: .01,
      hint: 'Counts a centre turn lane, so three through lanes plus one qualifies.' },
    { base: 'stressedRoad', label: 'WSDOT rates it high stress', min: 1, max: 4, step: .01,
      hint: 'The state bicycle level of traffic stress rating. Applies at full weight to a 4 and half weight to a 3. State highways only, which is the only place the rating exists.' },
  ]],
  ['Speed', 'Both are per mile-per-hour, so they accumulate: 10 mph over comfort at 0.02 is a 20% cost.', [
    { base: 'speedOver', label: 'Each mph above your comfort speed', min: 0, max: .1, step: .002, modes: ['Balanced', 'LowStress'],
      hint: 'Direct mode ignores this. Trails and ferries are always exempt.' },
    { base: 'speedBelow', label: 'Each mph below comfort, with no shoulder or bike lane', min: 0, max: .1, step: .001,
      hint: 'A slow road with nowhere to ride is still a road with nowhere to ride. Bounded so it can never discount an edge below 25%.' },
  ]],
  ['Limited access and curves', null, [
    { base: 'limitedAccess', label: 'Limited-access highway', min: 1, max: 8, step: .05,
      hint: 'Ramps and interchanges rather than driveways. Priced separately from the traffic tiers above, which it is exempt from.' },
    { base: 'curve', label: 'Sightline-limiting curve', min: 1, max: 20, step: .01, levels: [1, 2, 3],
      levelLabels: ['Gentle', 'Moderate', 'Sharp'],
      hint: 'Severity measured from the road geometry. Compounds along a winding road, so the low-stress figures climb steeply.' },
  ]],
  ['Effort: hills, turns and ferries', 'These change estimated time as well as route choice.', [
    { key: 'uphillFactor', label: 'Uphill effort', min: 1, max: 15, step: .25,
      hint: 'How much climbing slows you. Affects the time estimate.' },
    { key: 'downhillFactor', label: 'Downhill benefit', min: 0, max: 5, step: .1,
      hint: 'How much descending speeds you up. 0 = descents are no faster than flat.' },
    { key: 'undulationSecPerM', label: 'Rolling-hill cost (sec per m climbed)', min: 0, max: 10, step: .25,
      hint: 'Charges repeated small climbs that a net-elevation figure hides.' },
    { base: 'climb', suffix: 'SecPerM', label: 'Detour to avoid climbing (sec per m)', min: 0, max: 5, step: .05,
      hint: 'Above and beyond the time climbing costs. This is how much you dislike it.' },
    { base: 'turn', suffix: 'Sec', label: 'Cost of a turn (seconds)', min: 0, max: 90, step: 1,
      hint: 'Discourages zig-zag routes through a street grid.' },
    { key: 'ferryWaitMin', label: 'Ferry boarding wait (minutes)', min: 0, max: 60, step: 1,
      hint: 'Added once per ferry leg.' },
  ]],
  ['Alternative routes', 'Applied to edges an already-chosen option used, to push the next option onto genuinely different roads. Higher = more different, and more likely to be a worse route.', [
    { key: 'diversityQuick', label: 'Second option, quick', min: 1.05, max: 3, step: .05 },
    { key: 'diversityBalanced', label: 'Second option, balanced', min: 1.05, max: 3, step: .05 },
    { key: 'diversitySafer', label: 'Second option, safer', min: 1.05, max: 3, step: .05 },
    { key: 'diversityWide', label: 'Wide search', min: 1.05, max: 4, step: .05 },
  ]],
];

// Every weight the editor can reach, so a test can prove none was orphaned by
// the rename.
function editorWeightKeys() {
  const keys = [];
  for (const [, , items] of ROUTING_WEIGHT_GROUPS) {
    for (const item of items) keys.push(...weightKeysFor(item));
  }
  return keys;
}
function weightKeysFor(item) {
  if (item.key) return [item.key];
  const suffix = item.suffix || '';
  const modes = item.modes || WEIGHT_MODES.map(([id]) => id);
  if (item.levels) {
    const out = [];
    for (const mode of modes) for (const lvl of item.levels) out.push(item.base + mode + lvl);
    return out;
  }
  return modes.map((mode) => item.base + mode + suffix);
}

function weightSlider(key, label, min, max, step) {
  const row = document.createElement('label');
  row.className = 'weight-row';
  const dflt = DEFAULT_ROUTING_WEIGHTS[key];
  row.innerHTML = `<span class="weight-row-label">${label}</span>
    <output></output>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${routingWeights[key]}" data-weight="${key}">
    <button type="button" class="weight-revert" title="Back to the default, ${dflt}" aria-label="Reset ${label} to default">↺</button>`;
  const input = row.querySelector('input');
  const out = row.querySelector('output');
  const revert = row.querySelector('.weight-revert');
  const paint = () => {
    const value = Number(input.value);
    out.textContent = value === dflt ? String(value) : `${value} (was ${dflt})`;
    row.classList.toggle('changed', value !== dflt);
    revert.hidden = value === dflt;
  };
  const commit = () => {
    routingWeights[key] = Number(input.value);
    paint();
    syncWeightsTunedBadge();
    suppressRoadInfo(1200);
    // Route-only, never the full map re-score: weights are read by the router
    // and by nothing that paints the map, so re-scoring every source mid-drag
    // is guaranteed churn. Not currently pinned by a test -- the check that
    // claimed to was matching source text, and the real behaviour needs the
    // browser (see test_weights_panel_ui.mjs for where it would belong).
    scheduleReroute();
  };
  input.addEventListener('input', commit);
  revert.addEventListener('click', (e) => {
    e.preventDefault();
    input.value = String(dflt);
    commit();
  });
  paint();
  return row;
}

function buildRoutingWeightsEditor() {
  const host = document.getElementById('routingWeightsEditor');
  host.replaceChildren();
  for (const [title, blurb, items] of ROUTING_WEIGHT_GROUPS) {
    const group = document.createElement('section');
    group.className = 'weights-group';
    const heading = document.createElement('h3');
    heading.textContent = title;
    group.append(heading);
    if (blurb) {
      const note = document.createElement('p');
      note.className = 'weights-group-note';
      note.textContent = blurb;
      group.append(note);
    }
    for (const item of items) {
      const cost = document.createElement('div');
      cost.className = 'weight-cost';
      const name = document.createElement('h4');
      name.textContent = item.label;
      cost.append(name);
      if (item.hint) {
        const hint = document.createElement('p');
        hint.className = 'weight-hint';
        hint.textContent = item.hint;
        cost.append(hint);
      }
      if (item.key) {
        cost.append(weightSlider(item.key, 'Value', item.min, item.max, item.step));
      } else {
        const suffix = item.suffix || '';
        const modes = item.modes || WEIGHT_MODES.map(([id]) => id);
        for (const mode of modes) {
          const [, modeLabel] = WEIGHT_MODES.find(([id]) => id === mode);
          if (item.levels) {
            for (let i = 0; i < item.levels.length; i++) {
              cost.append(weightSlider(item.base + mode + item.levels[i],
                `${modeLabel} · ${item.levelLabels[i].toLowerCase()}`, item.min, item.max, item.step));
            }
          } else {
            cost.append(weightSlider(item.base + mode + suffix, modeLabel,
              item.min, item.max, item.step));
          }
        }
      }
      group.append(cost);
    }
    host.append(group);
  }
}

function activeRoutingPreset() {
  return ROUTING_PRESETS.find((preset) =>
    Object.entries(preset.rules).every(([key, value]) => rules[key] === value)
    && Object.entries(preset.preferences).every(([key, value]) => routing[key] === value)
  ) || null;
}

function syncPresetSelection() {
  const active = activeRoutingPreset();
  document.querySelectorAll('[data-routing-preset]').forEach((button) => {
    const selected = button.dataset.routingPreset === active?.id;
    const card = button.closest('.preset-card');
    card?.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
    const badge = card?.querySelector('.preset-badge');
    if (badge) badge.hidden = !selected;
  });
  const status = document.getElementById('settingsPresetStatus');
  if (status) {
    status.textContent = active
      ? `${active.label} is active.`
      : 'Custom rules are being used instead of a preset.';
    status.classList.toggle('custom', !active);
  }
}

function presetInfoRows(preset) {
  const presetRules = preset.rules;
  const preferenceText = [
    preset.preferences.prefDesig ? 'bike routes' : null,
    preset.preferences.prefResidential ? 'residential streets' : null,
  ].filter(Boolean).join(' and ');
  return [
    ['Never allow speed', presetRules.noUpperLimit
      ? 'No cutoff.' : `Ordinary roads over ${presetRules.upperMaxSpeed} mph fail; dedicated bike infrastructure is exempt.`],
    ['Speed without shoulder or bike lane', `Up to ${presetRules.maxSpeedNoShoulder} mph.`],
    ['Minimum shoulder', `${presetRules.minShoulder} ft on faster roads, unless the road has a bike lane.`],
    ['Lanes of traffic more than', presetRules.lanesNoShoulderOver >= MAX_LANES_NO_LIMIT
      ? 'No limit.'
      : `More than ${presetRules.lanesNoShoulderOver} lanes with neither fails your rules. Lanes are counted as tagged, turn lanes included.`],
    ['Road is busier than', (() => {
      const lvl = SafetyModel.busyLevel(presetRules);
      return lvl.id
        ? `${lvl.label}, about ${lvl.adt.toLocaleString()} vehicles a day, needs a bike lane or a safe-ish-width shoulder. Where no count exists the road's class stands in.`
        : 'Traffic volume is not used.';
    })()],
    ['Official stress rating', `A ${STRESS_AGENCY} Level of Traffic Stress of 4 always marks a road`
      + ' as caution. It never fails one.'],
    ['Sidewalk fallback', presetRules.allowSidewalkFallback
      ? 'Mapped sidewalks can satisfy the shoulder rule, but are strongly deprioritized and called out as a concern.'
      : 'Mapped sidewalks do not satisfy the shoulder rule.'],
    ['Freeways', presetRules.allowFreeways
      ? 'Always fail your rules. Bike-legal segments may still be routed over as a last resort,'
        + ' and are reported as failing; strict matching excludes them entirely.'
      : 'Never routed over.'],
    ['Rule matching', presetRules.requireSafe
      ? 'Required, except short access blocks (~1,000 ft) at your start, waypoints, and destination; no route is shown otherwise.'
      : 'Not required; a route may include rule-failing segments to complete it.'],
    ['Guess shoulder width when undocumented', presetRules.inferShoulderFromEdge
      ? `Where no shoulder is recorded but the county logged edge space, ${SafetyModel.EDGE_SPACE_MARGIN_FT} ft is subtracted and the rest counts as shoulder.`
      : 'Off. Only a recorded shoulder counts.'],
    ['Mountain-bike trails', presetRules.allowMtbTrails ? 'Available with a strong penalty.' : 'Not used.'],
    ['Surface', presetRules.preferPaved === true
      ? 'Strongly prefers paved roads and trails; unpaved routes remain available.'
      : 'Slightly prefers known paved roads and trails.'],
    ['Route preferences', preferenceText ? `Strongly prefer ${preferenceText}.` : 'No additional preference.'],
  ];
}

function openPresetInfo(presetId) {
  const preset = ROUTING_PRESETS.find((item) => item.id === presetId);
  if (!preset) return;
  document.getElementById('presetInfoTitle').textContent = preset.label;
  document.getElementById('presetInfoAudience').textContent = preset.audience;
  const details = document.getElementById('presetInfoDetails');
  details.replaceChildren();
  for (const [label, value] of presetInfoRows(preset)) {
    const item = document.createElement('li');
    const heading = document.createElement('strong');
    heading.textContent = `${label}: `;
    item.append(heading, value);
    details.appendChild(item);
  }
  const dialog = document.getElementById('presetInfoDialog');
  if (!dialog.open) dialog.showModal();
}

function buildPresetPanel() {
  const host = document.getElementById('settingsPresets');
  if (!host) return;
  host.replaceChildren();
  for (const preset of ROUTING_PRESETS) {
    const card = document.createElement('article');
    card.className = 'preset-card';

    const head = document.createElement('div');
    head.className = 'preset-card-head';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'preset-select';
    button.dataset.routingPreset = preset.id;
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', `Apply ${preset.label}`);
    const badge = document.createElement('span');
    badge.className = 'preset-badge';
    badge.textContent = 'Active';
    badge.hidden = true;
    const title = document.createElement('span');
    title.className = 'preset-title';
    title.textContent = preset.label;
    const titleRow = document.createElement('span');
    titleRow.className = 'preset-title-row';
    titleRow.append(title, badge);
    button.appendChild(titleRow);

    const actions = document.createElement('div');
    actions.className = 'preset-card-actions';
    const info = document.createElement('button');
    info.type = 'button';
    info.className = 'preset-info';
    info.setAttribute('aria-label', `${preset.label} rules`);
    info.title = `${preset.label} rules`;
    info.textContent = 'Rules';
    info.addEventListener('click', () => openPresetInfo(preset.id));
    actions.append(info);
    head.append(button, actions);

    const blurb = document.createElement('p');
    blurb.className = 'preset-audience';
    blurb.textContent = preset.blurb;
    // The whole card is a tap target, not just the title text; the Rules
    // button inside keeps its own action.
    card.addEventListener('click', (e) => {
      if (e.target.closest('.preset-info')) return;
      applyRoutingPreset(preset.id);
    });
    card.append(head, blurb);
    host.appendChild(card);
  }
  syncPresetSelection();
}

function applyRoutingPreset(presetId) {
  const preset = ROUTING_PRESETS.find((item) => item.id === presetId);
  if (!preset) return;
  const active = activeRoutingPreset();
  // A fast double tap on the selected card used to rebuild every Settings
  // control, rescore the statewide overlays, and start another portfolio
  // search for no change at all. On iOS that needless burst can be enough for
  // WebKit to terminate the page under memory pressure.
  if (active?.id === preset.id) return;
  if (!active && !window.confirm(
    `Apply ${preset.label}?\n\nThis will replace your custom routing rules and route preferences. Those custom settings will be lost.`
  )) return;

  clearTimeout(_rescoreTimer);
  clearTimeout(_ruleRouteTimer);
  _rescoreTimer = null;
  _ruleRouteTimer = null;
  Object.assign(rules, preset.rules);
  Object.assign(routing, preset.preferences);
  suppressRoadInfo(900);
  buildRulesPanel();
  refreshNavigationUI();
  // Presets can move thousands of road features between verdict colors.
  // Re-uploading those statewide collections synchronously for every tap, then
  // immediately queuing a route search, was the same kind of main-thread and
  // map-worker burst that made weight-slider drags unstable on iOS. The shared
  // scheduler coalesces rapid preset changes into one recolor and one reroute.
  scheduleRescore();
  showRouteActionToast(`${preset.label} applied`, { duration: 2200 });
}

function buildRulesPanel() {
  const slidersHost = document.getElementById('settingsSliders');
  const optionsHost = document.getElementById('settingsOptions');
  slidersHost.replaceChildren();
  optionsHost.replaceChildren();
  buildPresetPanel();

  // Safari can emit a delayed synthetic click after a range-thumb drag. Keep
  // that gesture owned by Settings so it cannot reach the map and dismiss the
  // panel as though the rider had tapped a road.
  const protectSliderGesture = (input) => {
    const protect = () => suppressRoadInfo(1800);
    input.addEventListener('pointerdown', protect);
    input.addEventListener('pointermove', protect);
    input.addEventListener('pointerup', protect);
    input.addEventListener('pointercancel', protect);
    input.addEventListener('touchstart', protect, { passive: true });
    input.addEventListener('touchmove', protect, { passive: true });
    input.addEventListener('touchend', protect, { passive: true });
    input.addEventListener('touchcancel', protect, { passive: true });
  };

  const slider = (key, label, min, max, step, unit, extraClass = '') => {
    const wrap = document.createElement('div');
    wrap.className = `rule rule-card${extraClass ? ' ' + extraClass : ''}`;
    wrap.innerHTML = `
      <div class="rule-head">
        <label for="r-${key}">${label}</label>
        <span class="val" id="v-${key}">${rules[key]}${unit}</span>
      </div>
      <input type="range" id="r-${key}" min="${min}" max="${max}" step="${step}" value="${rules[key]}">`;
    slidersHost.appendChild(wrap);
    const input = wrap.querySelector('input');
    protectSliderGesture(input);
    input.addEventListener('input', () => {
      rules[key] = Number(input.value);
      document.getElementById(`v-${key}`).textContent = rules[key] + unit;
      // A delayed synthetic map click after a mobile range drag must never
      // open road info and dismiss the Settings panel.
      suppressRoadInfo(1800);
      syncPresetSelection();
      scheduleRescore();
    });
  };

  const check = (key, label, state = rules, onChange = scheduleRescore, hint = '') => {
    const wrap = document.createElement('div');
    wrap.className = 'check-rule rule-card';
    wrap.innerHTML = `
      <label class="rule-check" for="r-${key}">
        <input type="checkbox" id="r-${key}" ${state[key] ? 'checked' : ''}>
        <span>${label}</span>
      </label>${hint ? `<p class="hint rule-check-hint">${hint}</p>` : ''}`;
    optionsHost.appendChild(wrap);
    wrap.querySelector('input').addEventListener('change', (e) => {
      state[key] = e.target.checked;
      suppressRoadInfo(900);
      syncPresetSelection();
      onChange();
    });
  };

  const updateRoutePreference = () => {
    saveStateSoon();
    computeRoute();
  };
  check('prefDesig', 'Heavily prefer bike routes & trails', routing, updateRoutePreference);
  check('prefResidential', 'Prefer residential streets', routing, updateRoutePreference);
  check('allowFreeways', 'Route over freeway as last resort (still shows as failing)');
  check('allowMtbTrails', 'Allow mountain bike trails', rules, () => {
    // This option affects both eligibility in the graph and the OSM layer's
    // feature filter. Repaint immediately, then recompute after the usual
    // small debounce used for all rider settings.
    const osm = SOURCES.find((source) => source.id === 'osm');
    if (osm && map.getLayer(osm.id)) applyDisplayMode(osm);
    scheduleRescore();
  });
  check('preferPaved', 'Strongly prefer paved surfaces');
  check('allowSidewalkFallback', 'Allow sidewalk fallback');
  check('requireSafe', 'Only show routes fully matching safety rules');
  check('inferShoulderFromEdge', 'Guess shoulder width from other data when it isn’t documented');

  // Deliberately below the rules and visually separated: everything above
  // decides where the route goes and overrides a preset in doing so. This only
  // decides what the map shows, so it must not call syncPresetSelection() --
  // hiding a button is not a departure from a preset.
  const advancedToolsCard = document.createElement('div');
  advancedToolsCard.className = 'check-rule rule-card rule-standalone';
  advancedToolsCard.innerHTML = `
    <label class="rule-check" for="r-showAdvancedTools">
      <input type="checkbox" id="r-showAdvancedTools" ${uiPrefs.showAdvancedTools ? 'checked' : ''}>
      <span>Show weights and considered routes (advanced settings)</span>
    </label>`;
  optionsHost.appendChild(advancedToolsCard);
  advancedToolsCard.querySelector('input').addEventListener('change', (e) => {
    uiPrefs.showAdvancedTools = e.target.checked;
    suppressRoadInfo(900);
    syncAdvancedToolsVisibility();
    saveStateSoon();
  });
  // Lanes slider: its TOP position means "no limit" rather than a count, the
  // same idiom the upper-speed cutoff uses. The setting reads "more lanes
  // than", so the number shown is the widest road that still passes.
  const lanesSlider = () => {
    const key = 'lanesNoShoulderOver';
    const wrap = document.createElement('div');
    wrap.className = 'rule rule-card rule-sub';
    const label = (v) => (v >= MAX_LANES_NO_LIMIT ? 'No limit' : `${v} lanes`);
    wrap.innerHTML = `
      <div class="rule-head">
        <label for="r-${key}">Lanes of traffic more than</label>
        <span class="val" id="v-${key}">${label(rules[key])}</span>
      </div>
      <input type="range" id="r-${key}" min="1" max="${MAX_LANES_NO_LIMIT}" step="1" value="${rules[key]}">`;
    slidersHost.appendChild(wrap);
    const input = wrap.querySelector('input');
    protectSliderGesture(input);
    input.addEventListener('input', () => {
      rules[key] = Number(input.value);
      document.getElementById(`v-${key}`).textContent = label(rules[key]);
      suppressRoadInfo(1800);
      syncPresetSelection();
      scheduleRescore();
    });
  };

  // How busy before a road needs space of its own. The choices are road types,
  // not numbers: nobody has an intuition for "3,000 vehicles a day", but
  // everyone knows what a neighbourhood street feels like. The figure rides
  // along as supporting detail for anyone who wants it.
  const busySlider = () => {
    const key = 'busyNoShoulder';
    const levels = SafetyModel.BUSY_LEVELS;
    const wrap = document.createElement('div');
    wrap.className = 'rule rule-card rule-sub';
    const label = (v) => {
      const lvl = levels[v] || levels[0];
      return lvl.id ? `${lvl.label} (~${lvl.adt.toLocaleString()}/day)` : 'Not used';
    };
    wrap.innerHTML = `
      <div class="rule-head">
        <label for="r-${key}">Road is busier than</label>
        <span class="val" id="v-${key}">${label(rules[key])}</span>
      </div>
      <input type="range" id="r-${key}" min="0" max="${levels.length - 1}" step="1" value="${rules[key]}">`;
    slidersHost.appendChild(wrap);
    const input = wrap.querySelector('input');
    protectSliderGesture(input);
    input.addEventListener('input', () => {
      rules[key] = Number(input.value);
      document.getElementById(`v-${key}`).textContent = label(rules[key]);
      suppressRoadInfo(1800);
      syncPresetSelection();
      scheduleRescore();
    });
  };

  // The three conditions read as one sentence, so they are introduced as one
  // and indented under it. They are ORed: any of them means the road needs
  // space of its own.
  const spaceHeading = document.createElement('p');
  spaceHeading.className = 'rule-group-head';
  spaceHeading.textContent = 'Require a bike lane or safe-ish width shoulder.';
  slidersHost.appendChild(spaceHeading);
  slider('maxSpeedNoShoulder', 'Speed limit is over', 15, 45, 5, ' mph', 'rule-sub');
  lanesSlider();
  busySlider();
  slider('minShoulder', 'Minimum shoulder width to count as safe-ish', 2, 10, 1, ' ft');

  // Upper speed cutoff: one slider, whose TOP position means "no cutoff"
  // (replaces the old separate "No speed cutoff" checkbox).
  {
    const NONE_AT = 70;
    const wrap = document.createElement('div');
    wrap.className = 'rule rule-card';
    const cur = rules.noUpperLimit ? NONE_AT : rules.upperMaxSpeed;
    wrap.innerHTML = `
      <div class="rule-head">
        <label for="r-upperMaxSpeed">Never allow roads faster than</label>
        <span class="val" id="v-upperMaxSpeed"></span>
      </div>
      <input type="range" id="r-upperMaxSpeed" min="25" max="${NONE_AT}" step="5" value="${cur}">`;
    slidersHost.appendChild(wrap);
    const input = wrap.querySelector('input');
    protectSliderGesture(input);
    const valEl = wrap.querySelector('#v-upperMaxSpeed');
    const render = (v) => { valEl.textContent = v >= NONE_AT ? 'no cutoff' : v + ' mph'; };
    render(cur);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      if (v >= NONE_AT) {
        rules.noUpperLimit = true;
      } else {
        rules.noUpperLimit = false;
        rules.upperMaxSpeed = v;
      }
      render(v);
      suppressRoadInfo(1800);
      syncPresetSelection();
      scheduleRescore();
    });
  }

  const settingsTabs = document.getElementById('settingsTabs');
  if (!settingsTabs.dataset.bound) {
    const paneButtons = [...document.querySelectorAll('[data-settings-pane]')];
    const selectSettingsPane = (pane) => {
      paneButtons.forEach((button) => {
        const active = button.dataset.settingsPane === pane;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
      });
      document.querySelectorAll('.settings-pane').forEach((panel) => {
        panel.hidden = panel.id !== `settings-${pane}`;
      });
      if (pane === 'presets') syncPresetSelection();
    };
    settingsPaneSelect = selectSettingsPane;
    const paneLockedByNavigation = (pane) => turnNav.active && pane !== 'voice';
    paneButtons.forEach((button) => {
      button.addEventListener('click', () => {
        if (paneLockedByNavigation(button.dataset.settingsPane)) {
          flashSettingsNavLock();
          return;
        }
        selectSettingsPane(button.dataset.settingsPane);
      });
      button.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const current = paneButtons.indexOf(button);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? paneButtons.length - 1
          : (current + (event.key === 'ArrowRight' ? 1 : -1) + paneButtons.length) % paneButtons.length;
        paneButtons[next].focus();
        if (!paneLockedByNavigation(paneButtons[next].dataset.settingsPane)) {
          selectSettingsPane(paneButtons[next].dataset.settingsPane);
        }
      });
    });
    document.getElementById('settingsHelpBtn').addEventListener('click', () => {
      buildCautionCauseHelp();
      openHelp('settings');
    });
    document.getElementById('settingsAdvancedWeightsBtn').addEventListener('click', () => {
      const helpDialog = document.getElementById('helpDialog');
      if (helpDialog.open) helpDialog.close();
      openRoutingWeights();
    });
    document.getElementById('resetRoutingWeights').addEventListener('click', () => {
      Object.assign(routingWeights, DEFAULT_ROUTING_WEIGHTS);
      buildRoutingWeightsEditor();
      syncWeightsTunedBadge();
      scheduleReroute();
      showRouteActionToast('Routing weights reset to defaults', { duration: 2200 });
    });
    selectSettingsPane(document.querySelector('[data-settings-pane].active')?.dataset.settingsPane || 'limits');
    settingsTabs.dataset.bound = 'true';
  }
}

// Placed just above the settings panes (not as a top-of-screen toast) so a
// rider who taps a route-settings tab during navigation sees why it is locked
// right where they are looking. Re-flashes on every tap.
let settingsNavLockTimer = null;
function flashSettingsNavLock() {
  const note = document.getElementById('settingsNavLockNotice');
  if (!note) return;
  note.hidden = false;
  note.classList.remove('flash');
  void note.offsetWidth; // restart the flash animation on repeat taps
  note.classList.add('flash');
  clearTimeout(settingsNavLockTimer);
  settingsNavLockTimer = setTimeout(() => { note.hidden = true; }, 4200);
}

function buildVoicePanel() {
  const host = document.getElementById('settingsVoice');
  if (!host) return;
  host.replaceChildren();

  const headings = document.createElement('div');
  headings.className = 'check-rule rule-card';
  headings.innerHTML = `<label class="rule-check"><input type="checkbox" id="v-voiceHeadings"
    ${navVoice.headings ? 'checked' : ''}><span>Speak compass directions (N/S/E/W)</span></label>`;
  headings.querySelector('input').addEventListener('change', (e) => {
    navVoice.headings = e.target.checked;
    syncNativeVoiceStatusPreferences();
    saveStateSoon();
  });
  host.appendChild(headings);

  const awake = document.createElement('div');
  awake.className = 'check-rule rule-card';
  awake.innerHTML = `<label class="rule-check"><input type="checkbox" id="v-keepScreenAwake"
    ${navVoice.keepScreenAwake ? 'checked' : ''}><span>Keep the screen awake while navigating</span></label>
    <p class="hint voice-safety-hint">Off saves battery.</p>`;
  awake.querySelector('input').addEventListener('change', (e) => {
    navVoice.keepScreenAwake = e.target.checked;
    if (e.target.checked) requestNavigationWakeLock();
    else {
      releaseNavigationWakeLock();
      // The rider asked for this, so it is not a problem to warn them about.
      turnNav.screenMaySleep = false;
      if (turnNav.active) refreshNavigationUI();
    }
    saveStateSoon();
  });
  host.appendChild(awake);

  const safety = document.createElement('div');
  safety.className = 'check-rule rule-card';
  safety.innerHTML = `<label class="rule-check"><input type="checkbox" id="v-voiceSafetyLevels"
    ${navVoice.safetyLevels ? 'checked' : ''}><span>Announce route safety levels</span></label>
    <p class="hint voice-safety-hint">"Bike lane in 500 feet, for 2.1 miles."</p>`;
  safety.querySelector('input').addEventListener('change', (e) => {
    navVoice.safetyLevels = e.target.checked;
    syncNativeVoiceStatusPreferences();
    saveStateSoon();
  });
  host.appendChild(safety);

  const choices = [[0, 'Never'], [1, 'Every minute'], [2, 'Every 2 minutes'],
    [3, 'Every 3 minutes'], [5, 'Every 5 minutes'], [10, 'Every 10 minutes'],
    [15, 'Every 15 minutes'], [20, 'Every 20 minutes'], [30, 'Every 30 minutes']];
  // Snap any previously stored in-between value onto the closest choice.
  navVoice.updateMin = choices.reduce((best, [value]) =>
    Math.abs(value - navVoice.updateMin) < Math.abs(best - navVoice.updateMin) ? value : best, 0);
  const cadence = document.createElement('div');
  cadence.className = 'rule rule-card';
  const items = [['statusRoute', 'Route status'], ['statusSpeed', 'Current speed'],
    ['statusMiles', 'Miles remaining'], ['statusEta', 'Est. time left']];
  cadence.innerHTML = `
    <div class="rule-head voice-inline-head"><label for="r-voiceUpdate">Status update</label>
      <select id="r-voiceUpdate" class="voice-select voice-select-inline">${choices.map(([value, label]) =>
        `<option value="${value}"${value === navVoice.updateMin ? ' selected' : ''}>${label}</option>`).join('')}</select></div>
    <div class="voice-status-grid">${items.map(([key, label]) =>
      `<label class="rule-check"><input type="checkbox" data-voice-status="${key}"
        ${navVoice[key] ? 'checked' : ''}><span>${label}</span></label>`).join('')}</div>`;
  cadence.querySelector('select').addEventListener('change', (e) => {
    navVoice.updateMin = Number(e.target.value);
    syncNativeVoiceStatusPreferences();
    saveStateSoon();
  });
  cadence.querySelectorAll('[data-voice-status]').forEach((input) =>
    input.addEventListener('change', () => {
      navVoice[input.dataset.voiceStatus] = input.checked;
      syncNativeVoiceStatusPreferences();
      saveStateSoon();
    }));
  host.appendChild(cadence);
}

/* ------------------------------------------------------------- boot */
buildSourcePanel();
buildRulesPanel();
buildVoicePanel();
buildRoutingPanel();
// Start the on-device routing graph before route editing is available. This
// keeps endpoint, waypoint, and road-block actions from racing initialization.
ensureRouter();

// On phones, Menu and Navigate share the lower-left thumb zone. Navigate sits
// beside Menu while the map is unobstructed, then shifts to the sheet's left
// edge when it opens; desktop keeps the existing top-toolbar arrangement.
const mobileNavMedia = window.matchMedia('(max-width: 720px)');
let _mobileDockFrame = null;
function syncMobileNavDock() {
  if (!mobileNavMedia.matches) return;
  const dock = document.getElementById('mobileNavDock');
  const panel = document.getElementById('panel');
  const height = document.body.classList.contains('panel-open')
    ? Math.ceil(panel.getBoundingClientRect().height) : 0;
  // The dock and the banner are siblings, so put the shared measurement on
  // <body> rather than only on the dock. Both elements then rise together.
  document.body.style.setProperty('--mobile-panel-height', `${height}px`);
}
function scheduleMobileNavDock() {
  if (!mobileNavMedia.matches || _mobileDockFrame != null) return;
  _mobileDockFrame = requestAnimationFrame(() => {
    _mobileDockFrame = null;
    syncMobileNavDock();
  });
}
function placeNavigationControl() {
  const nav = document.getElementById('navStartButton');
  const topToolbar = document.getElementById('topToolbar');
  const dock = document.getElementById('mobileNavDock');
  if (mobileNavMedia.matches) {
    if (nav.parentElement !== dock) dock.appendChild(nav);
  } else if (nav.parentElement !== topToolbar) {
    topToolbar.insertBefore(nav, topToolbar.firstChild);
  }
  syncPanelInteractivity();
  scheduleMobileNavDock();
}
placeNavigationControl();
if (mobileNavMedia.addEventListener) mobileNavMedia.addEventListener('change', placeNavigationControl);
else mobileNavMedia.addListener(placeNavigationControl);
if (window.ResizeObserver) {
  new ResizeObserver(scheduleMobileNavDock).observe(document.getElementById('panel'));
}

// Tabs.
function syncPanelInteractivity() {
  const panel = document.getElementById('panel');
  const hidden = mobileNavMedia.matches && !document.body.classList.contains('panel-open');
  panel.inert = hidden;
  if (hidden) panel.setAttribute('aria-hidden', 'true');
  else panel.removeAttribute('aria-hidden');
}

function setPanelOpen(open) {
  document.body.classList.toggle('panel-open', open);
  syncLayersToggle();
  syncPanelInteractivity();
  refreshNavigationUI();
  scheduleMobileNavDock();
  // The route tab is display:none while the panel is closed, so its elevation
  // canvas has no width to draw into. Redraw once the panel (and the canvas)
  // is laid out, otherwise the chart stays blank until the next route render.
  if (open) {
    requestAnimationFrame(drawRouteCardElevation);
    syncRouteDetailsWarningState(routing.last, { flash: true });
  }
}

function selectPanelTab(tabId) {
  document.body.classList.toggle('settings-panel-active', tabId === 'settings');
  document.querySelectorAll('#tabs button[data-tab]').forEach((b) => {
    const active = b.dataset.tab === tabId;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('.tab').forEach((t) =>
    t.classList.toggle('active', t.id === 'tab-' + tabId));
  syncLayersToggle();
  scheduleMobileNavDock();
  if (tabId === 'route') { updateNavCard(); drawRouteCardElevation(); } // redraw elevation once visible
}

document.querySelectorAll('#tabs button[data-tab]').forEach((b) => {
  b.addEventListener('click', () => {
    selectPanelTab(b.dataset.tab);
    setPanelOpen(true);
  });
});
selectPanelTab('route');
document.getElementById('panelClose').addEventListener('click', () => {
  setPanelOpen(false);
  document.getElementById('panelOpen').focus({ preventScroll: true });
});
document.getElementById('panelOpen').addEventListener('click', () => {
  closePlacePicker(true);
  dismissRoadInfo();
  selectPanelTab('route');
  setPanelOpen(true);
  document.getElementById('panelClose').focus({ preventScroll: true });
});

function layersMenuIsOpen() {
  const selected = document.getElementById('tab-layers').classList.contains('active');
  return selected && (!mobileNavMedia.matches || document.body.classList.contains('panel-open'));
}

function syncLayersToggle() {
  const toggle = document.getElementById('layersToggle');
  if (!toggle) return;
  const open = layersMenuIsOpen();
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Hide map layers' : 'Show map layers');
  toggle.title = open ? 'Hide map layers' : 'Show map layers';
}

document.getElementById('layersToggle').addEventListener('click', () => {
  const open = layersMenuIsOpen();
  closePlacePicker(true);
  dismissRoadInfo();
  if (open) {
    if (mobileNavMedia.matches) setPanelOpen(false);
    else selectPanelTab('route');
  } else {
    selectPanelTab('layers');
    setPanelOpen(true);
  }
  syncLayersToggle();
});

// Dialog close buttons and the version shown inside Getting Started help.
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () =>
  document.getElementById(b.dataset.close).close()));
// One line answers both "what app is this" and "what map is it routing on".
// The map half reports the hash of the bytes the router loaded, so a stale
// service-worker cache shows up as STALE here instead of as a weird route.
// A third line appears once a route has been compared: the last search's
// per-phase timings, so a "why is my laptop slower than my phone" report
// can be read straight off the Settings page on any device -- the console
// line logging the same numbers proved unfindable in the field.
function syncGraphVersionLine() {
  const el = document.getElementById('appVersion');
  if (!el) return;
  const loaded = routing.loadedGraphVersion;
  const graph = !loaded ? `map ${GRAPH_DATA_VERSION} (loading)`
    : loaded === GRAPH_DATA_VERSION ? `map ${loaded}`
    : `map ${loaded} — STALE, expected ${GRAPH_DATA_VERSION}`;
  const t = routing.lastTimings;
  const phases = t ? ['snap', 'profiles', 'corridors', 'discovery', 'ferries',
    'matching', 'ranking'].filter((k) => t[k] >= 50)
    .map((k) => `${k} ${(t[k] / 1000).toFixed(1)}`).join(', ') : '';
  el.textContent = `v${APP_VERSION} · ${graph}`
    + (t ? `\nlast route search ${(t.totalMs / 1000).toFixed(1)}s`
      + (phases ? ` (${phases})` : '') : '');
}
syncGraphVersionLine();
const nativeAppVersionOnly = document.documentElement.dataset.appRuntime === 'native'
  || window.location.protocol === 'capacitor:'
  || Boolean(window.Capacitor?.isNativePlatform?.());
if (nativeAppVersionOnly) {
  document.getElementById('checkUpdatesBtn').hidden = true;
  document.getElementById('iosAppVersionLabel').hidden = false;
  document.getElementById('updateCheckStatus').hidden = true;
}
document.getElementById('appHelpBtn').addEventListener('click', () =>
  openHelp('getting-started'));
document.getElementById('techDetailsBtn').addEventListener('click', () => openHelp('technical'));
// The weights panel is reachable two ways on purpose: from Settings > Advanced,
// where a reader finds it while reading about what it does, and from the map,
// where it gets used -- tuning a weight is only meaningful while you can watch
// the route it changes.
function openRoutingWeights() {
  buildRoutingWeightsEditor();
  syncWeightsTunedBadge();
  // The considered-routes screen only has something to say once a trip has
  // been routed; until then the button explains itself instead of opening
  // an empty list.
  const considered = document.getElementById('moreRoutesBtn');
  if (considered) considered.disabled = !(routing.allCandidates || []).length;
  document.getElementById('weightsDialog').showModal();
}

// The map's two advanced entry points appear and disappear together, because
// they are the same decision: whether the rider wants the router's workings on
// screen. The considered-routes screen rides along: its button lives on the
// weights page, so hiding that page hides it too.
function syncAdvancedToolsVisibility() {
  const weightsButton = document.getElementById('appWeightsBtn');
  if (weightsButton) weightsButton.hidden = !uiPrefs.showAdvancedTools;
  renderRouteOptionControls();
}
// A weight left off its default silently changes every route, and the panel is
// several taps away from wherever the surprise shows up. Mark the button.
function syncWeightsTunedBadge() {
  const button = document.getElementById('appWeightsBtn');
  const off = Object.keys(DEFAULT_ROUTING_WEIGHTS)
    .filter((key) => routingWeights[key] !== DEFAULT_ROUTING_WEIGHTS[key]);
  if (button) {
    button.classList.toggle('tuned', off.length > 0);
    button.title = off.length
      ? `Advanced routing weights (${off.length} changed from default)`
      : 'Advanced routing weights';
  }
  const notice = document.getElementById('weightsModifiedNotice');
  if (notice) {
    notice.hidden = off.length === 0;
    notice.textContent = off.length === 1
      ? 'Weights have been modified (1 change)'
      : `Weights have been modified (${off.length} changes)`;
  }
}
document.getElementById('appWeightsBtn').addEventListener('click', openRoutingWeights);
// Delegated: #routeRemixBtn is rebuilt every time the chooser re-renders.
document.getElementById('routeOptions').addEventListener('click', (e) => {
  if (e.target.closest('#routeRemixBtn')) openRouteRemix();
});
// Static markup on the weights page; openRoutingWeights() keeps its
// disabled state in step with whether a trip is currently routed.
document.getElementById('moreRoutesBtn')?.addEventListener('click', openAllRoutes);
syncWeightsTunedBadge();
syncAdvancedToolsVisibility();
document.getElementById('layersHelpBtn').addEventListener('click', () =>
  openHelp('layers'));
document.getElementById('routesHelpBtn').addEventListener('click', () => {
  document.getElementById('routesDialog').close();
  openHelp('save-share');
});

function isStandaloneApp() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.matchMedia('(display-mode: fullscreen)').matches
    || window.navigator.standalone === true;
}

// Safari's layout viewport can extend beneath its URL bar. Keep the app's
// canvas tied to the visible viewport so map controls and the bottom sheet
// remain reachable in a shared link opened in a normal browser tab.
function syncVisibleViewport() {
  if (isStandaloneApp()) {
    document.documentElement.style.removeProperty('--app-height');
    return;
  }
  const vv = window.visualViewport;
  const height = Math.round(vv ? vv.height : window.innerHeight);
  document.documentElement.style.setProperty('--app-height', `${height}px`);
}
syncVisibleViewport();
window.visualViewport?.addEventListener('resize', syncVisibleViewport);
window.visualViewport?.addEventListener('scroll', syncVisibleViewport);
window.addEventListener('resize', syncVisibleViewport);
window.addEventListener('resize', scheduleMobileNavDock);
window.addEventListener('resize', drawRouteCardElevation);

function offerSharedRouteTip() {
  if (!sharedRoute || isStandaloneApp() || !window.matchMedia('(pointer: coarse)').matches) return;
  try {
    if (sessionStorage.getItem('wa-bike-shared-route-tip')) return;
    sessionStorage.setItem('wa-bike-shared-route-tip', '1');
  } catch (e) { /* private browsing may block session storage */ }
  const dialog = document.getElementById('sharedRouteTip');
  if (dialog && !dialog.open) dialog.showModal();
}
offerSharedRouteTip();

let pendingUpdateWorker = null;
let deferredUpdateWorker = null;
// Set the moment the rider takes an update, so the handover that follows is
// known to be one they asked for even on a page that started uncontrolled.
let updateAccepted = false;
function offerUpdate(worker) {
  if (!worker || worker === deferredUpdateWorker || !navigator.serviceWorker.controller) return;
  pendingUpdateWorker = worker;
  document.getElementById('updatePrompt').hidden = false;
}

async function setupAutomaticUpdates() {
  if (!window.__swReady) return;
  try {
    const reg = await window.__swReady;
    const watch = (worker) => {
      if (!worker) return;
      const checkState = () => {
        if (worker.state === 'installed') offerUpdate(worker);
      };
      worker.addEventListener('statechange', checkState);
      checkState();
    };
    if (reg.waiting) offerUpdate(reg.waiting);
    watch(reg.installing);
    reg.addEventListener('updatefound', () => watch(reg.installing));

    // Reload when a new worker takes over a page that was ALREADY being driven
    // by one, or when the rider just asked for the update. On a first install
    // the worker calls clients.claim(), which fires controllerchange too --
    // reloading there threw away a freshly started app for nothing and cost
    // every first visit a second full load.
    const wasControlled = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading || !(wasControlled || updateAccepted)) return;
      reloading = true;
      saveStateNow();
      location.reload();
    });

    const check = async () => {
      try {
        await reg.update();
        if (reg.waiting) offerUpdate(reg.waiting);
      } catch (e) { /* offline — try again later */ }
    };
    check();
    setInterval(check, 30 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
  } catch (e) {
    // Service worker unavailable — app still works online.
    console.warn('Automatic updates unavailable:', e);
  }
}

document.getElementById('getUpdateBtn').addEventListener('click', () => {
  saveStateNow();
  updateAccepted = true;
  // Take the banner down on the way out. Leaving it up through the handover
  // made a successful update look like it was being offered all over again.
  document.getElementById('updatePrompt').hidden = true;
  if (pendingUpdateWorker) pendingUpdateWorker.postMessage({ type: 'SKIP_WAITING' });
});
document.getElementById('updateLaterBtn').addEventListener('click', () => {
  deferredUpdateWorker = pendingUpdateWorker;
  document.getElementById('updatePrompt').hidden = true;
});
setupAutomaticUpdates();

// Manual "Check for updates" in the help dialog. Wired independently of
// setupAutomaticUpdates so a slow or stalled service-worker registration
// never leaves the button dead.
async function publishedAppVersion() {
  // The unique query is deliberate: an older cache-first service worker will
  // miss this URL and retrieve the current release marker from the network.
  const response = await fetch(`./version.json?update-check=${Date.now()}`, {
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`version check failed (${response.status})`);
  const release = await response.json();
  if (!release?.version) throw new Error('invalid version marker');
  return String(release.version);
}

function waitForUpdateWorker(reg, timeoutMs = 2500) {
  if (reg.waiting || reg.installing) return Promise.resolve(reg.waiting || reg.installing);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (worker = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reg.removeEventListener('updatefound', onUpdate);
      resolve(worker);
    };
    const onUpdate = () => finish(reg.waiting || reg.installing);
    const timer = setTimeout(() => finish(), timeoutMs);
    reg.addEventListener('updatefound', onUpdate);
  });
}

// Poll the registration for a worker that arrived after update() resolved.
// Installing the shell is real work, and on a phone it can land a second or two
// after the promise settles; reading the registration once was reporting "could
// not install yet" for updates that were on their way in.
function settledUpdateWorker(reg, timeoutMs = 12000, stepMs = 400) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = () => {
      const worker = reg.waiting || reg.installing;
      if (worker) return resolve(worker);
      if (Date.now() >= deadline) return resolve(null);
      setTimeout(poll, stepMs);
    };
    poll();
  });
}

document.getElementById('checkUpdatesBtn').addEventListener('click', async () => {
  if (nativeAppVersionOnly) return;
  const btn = document.getElementById('checkUpdatesBtn');
  const status = document.getElementById('updateCheckStatus');
  btn.disabled = true;
  status.textContent = 'Checking…';
  try {
    let reg = await Promise.race([
      window.__swReady,
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]);
    // A fresh register() can be slow; any returning device already has a
    // registration that resolves immediately.
    if (!reg && navigator.serviceWorker) reg = await navigator.serviceWorker.getRegistration();
    if (!reg) throw new Error('service worker unavailable');
    // An update already sitting on the registration needs no network at all.
    if (reg.waiting) {
      // An explicit check is fresh consent to be asked: without clearing the
      // deferral, a rider who once tapped "Not now" got "Update ready." as
      // dead-end text with no button anywhere -- ready how? do what?
      deferredUpdateWorker = null;
      status.textContent = 'Update ready — tap “Restart to update”.';
      offerUpdate(reg.waiting);
      document.getElementById('helpDialog')?.close();
      return;
    }
    const publishedVersion = await publishedAppVersion();
    // The usual answer is "you are up to date", and it is one small fetch away.
    // Waiting on the whole install dance to say so left the rider watching an
    // unchanging "Checking..." for the better part of a minute on a phone.
    // Still ask the browser to look, in the background, in case a worker
    // changed without the marker moving.
    if (publishedVersion === APP_VERSION) {
      reg.update().catch(() => {});
      status.textContent = `You have the latest version (v${APP_VERSION}).`;
      return;
    }
    status.textContent = `Version v${publishedVersion} found — fetching it…`;
    // Revalidate the worker script at its real URL first. Safari can hold
    // sw.js in the HTTP cache, and reg.update() then byte-compares the new
    // release against that stale copy, concludes nothing changed, and reports
    // an update it can never install. `cache: 'reload'` replaces the cached
    // entry, so the update below sees the bytes that are actually published.
    try {
      await fetch('./sw.js', { cache: 'reload' });
    } catch { /* offline; reg.update() will fail the same way and be reported */ }
    const updateWorker = waitForUpdateWorker(reg);
    await reg.update();
    status.textContent = `Version v${publishedVersion} found — installing…`;
    // reg.update() resolving does not guarantee the new worker has appeared on
    // the registration yet, and a phone on a slow connection routinely needs
    // longer than one event turn. Poll rather than read once.
    //
    // There used to be a second attempt here that re-registered the worker
    // under `./sw.js?release=<version>`, to get past a CDN still serving the
    // old plain URL. It worked, and it is why every update asked twice: the
    // registration was left on a versioned URL, the next load registered the
    // NEXT version's URL, and a changed script URL is an update in its own
    // right. `updateViaCache: 'none'` plus the revalidation above covers the
    // staleness without renaming the script.
    const fresh = reg.waiting || reg.installing || await updateWorker
      || await settledUpdateWorker(reg);
    if (fresh) {
      status.textContent = 'Update found — installing…';
      if (reg.waiting) offerUpdate(reg.waiting);
      else fresh.addEventListener('statechange', () => {
        if (fresh.state === 'installed') offerUpdate(fresh);
      });
      // The update prompt renders under this modal dialog; close it so the
      // "Get update?" banner is visible.
      document.getElementById('helpDialog')?.close();
    } else if (publishedVersion !== APP_VERSION) {
      status.textContent = `Version v${publishedVersion} is published but has not reached this device yet.`
        + ' A release can take a couple of minutes to propagate. Try again shortly,'
        + ' or fully close and reopen the app.';
    } else {
      status.textContent = `You have the latest version (v${APP_VERSION}).`;
    }
  } catch (e) {
    status.textContent = 'Could not check right now — make sure you are online and try again.';
  } finally {
    // In a finally, because the quick answers above return early: without it
    // the button re-enabled only on the slow path, so the first check left it
    // dead for the rest of the session.
    btn.disabled = false;
  }
});



// Run cb as soon as the style spec is loaded. Polling avoids a styledata-event
// race, and isStyleLoaded flips true independent of basemap TILE loading, so a
// slow or unreachable basemap never blocks the data layers.
function onStyleReady(cb) {
  const check = () => (map.isStyleLoaded() ? cb() : setTimeout(check, 120));
  check();
}

onStyleReady(() => {
  // Visual toggles must not create holes in street-information popups. Load
  // every source once; updateVisibility() independently hides painted lines.
  for (const src of SOURCES) loadSource(src);
});

// Debug handle (harmless; used for local verification).
window.VIS = { map, SOURCES, rules, rescoreAll, effectiveLevel };
