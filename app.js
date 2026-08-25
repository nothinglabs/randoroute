/*
 * Just Rolling Along -- bicycle safety and routing
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

const APP_VERSION = '2026-08-25.829';
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

function isRoutinePavedSurface(surface) {
  return /^(?:paved|asphalt|concrete(?::(?:lanes|plates))?|unknown)$/i
    .test(String(surface || '').trim());
}

/* ------------------------------------------------- riding-rules state */
// Expert route-shaping switches live beside the numerical weights and are
// deliberately independent of safety presets. Applying a preset must preserve
// them; the Advanced page's reset button is their one shared reset surface.
const ADVANCED_ROUTE_OPTION_DEFAULTS = Object.freeze({
  prefDesig: true,
  alwaysPreferBikeRoutes: false,
  prefResidential: true,
  allowSidewalkFallback: true,
  allowMtbTrails: false,
  allowFerries: true,
});
const ADVANCED_ROUTE_RULE_KEYS = Object.freeze([
  'alwaysPreferBikeRoutes', 'allowSidewalkFallback', 'allowMtbTrails', 'allowFerries',
]);
const ADVANCED_ROUTE_PREFERENCE_KEYS = Object.freeze(['prefDesig', 'prefResidential']);
const DEFAULT_RULES = Object.freeze({
  // A routing permission, never a verdict: a freeway always fails. Off means
  // the router may not use one at all; on means it may, as a last resort, and
  // those segments still report as failing.
  allowFreeways: true,
  allowMtbTrails: ADVANCED_ROUTE_OPTION_DEFAULTS.allowMtbTrails,
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
  // SafetyModel.BUSY_LEVELS. 0 is retained for old data; the selectable top
  // value is No limit. The Randonneur starts at 3, "a through street", about
  // 6,000 vehicles a day or a minor arterial where there is no count.
  busyNoShoulder: 3,
  allowSidewalkFallback: ADVANCED_ROUTE_OPTION_DEFAULTS.allowSidewalkFallback,
  upperMaxSpeed: 45,    // mph; roads above this absolute cutoff fail
  noUpperLimit: true,   // disable the upper-speed hard cap
  requireSafe: false,   // limit the portfolio to routes whose every edge matches the rules
});
// Ferries and the strong signed-route lens are routing choices rather than
// safety limits. Sidewalk fallback and MTB admission must exist in the rules
// object because the verdict/router reads them, but all four are explicitly
// excluded when presets are matched or applied. Their home and reset surface
// is Advanced routing. `alwaysPreferBikeRoutes` changes COST only, so a signed
// route that fails still draws and speaks as a failure.
const rules = {
  ...DEFAULT_RULES,
  allowFerries: ADVANCED_ROUTE_OPTION_DEFAULTS.allowFerries,
  alwaysPreferBikeRoutes: ADVANCED_ROUTE_OPTION_DEFAULTS.alwaysPreferBikeRoutes,
};
// Top of the lanes slider means "no limit" rather than a literal count. It
// stops at 6 because a "6 lanes without a shoulder is fine" rule is one nobody
// would pick over turning the rule off entirely.
const MAX_LANES_NO_LIMIT = 6;
const RULE_NUMBER_LIMITS = {
  minShoulder: [2, 10],
  lanesNoShoulderOver: [2, MAX_LANES_NO_LIMIT],
  busyNoShoulder: [1, SafetyModel.BUSY_LEVELS.length - 1],
  maxSpeedNoShoulder: [20, 45],
  upperMaxSpeed: [25, 65],
};

// Soft route-choice costs. These never make an edge legal or illegal; the
// rider-facing Limits remain the hard safety rules. Kept in one shared shape
// with router-worker.js so the advanced desktop editor is reproducible.
const DEFAULT_ROUTING_WEIGHTS = Object.freeze({
  failRoadDirect: 1.5, failRoadBalanced: 9, failRoadLowStress: 30,
  comfyRoadBalanced: 0.92, comfyRoadLowStress: 0.9,
  designated: 0.94, strongDesignated: 0.5, preferredRoute: 0.1, residential: 0.78,
  // Regraded from field riding: full separation pulls hardest
  // (path 0.20, separated 0.29) while paint alone pulls
  // less (buffered 0.32 -> 0.36, lane 0.36 -> 0.40) -- the rider's tuned
  // values applied as shipped defaults.
  facilityShared: 0.75, facilityLane: 0.4, facilityBuffered: 0.36,
  facilitySeparated: 0.29, facilityPath: 0.20,
  mtbTrail: 6,
  freeway: 12,
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
  // The shape of the climb curve: nothing extra below the knee, and this much
  // per metre climbed at 10%. 4 / 7.84 reproduces the curve exactly as shipped.
  climbKneePct: 4, climbCostAt10Pct: 7.84,
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
// Most weights share the legacy sanity range below. Values with narrower,
// semantic domains live here so malformed saved/shared input cannot turn a
// blend into extrapolation (and, for traffic, a negative edge cost).
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
});
const ZERO_ROUTING_WEIGHTS = new Set(['ferryWaitMin', 'speedOverBalanced', 'speedOverLowStress',
  'speedBelowDirect', 'speedBelowBalanced', 'speedBelowLowStress', 'downhillFactor', 'undulationSecPerM',
  'climbDirectSecPerM', 'climbBalancedSecPerM', 'climbLowStressSecPerM',
  'turnDirectSec', 'turnBalancedSec', 'turnLowStressSec', 'useMeasuredTraffic']);
function validatedRoutingWeight(key, sourceValue) {
  const value = Number(sourceValue);
  if (!Number.isFinite(value)) return null;
  const bounds = ROUTING_WEIGHT_BOUNDS[key];
  if (bounds) return Math.min(bounds[1], Math.max(bounds[0], value));
  const minimum = ZERO_ROUTING_WEIGHTS.has(key) ? 0 : 0.1;
  return value >= minimum && value <= 120 ? value : null;
}
function validRoutingWeights(source) {
  const clean = {};
  if (!source || typeof source !== 'object') return clean;
  const renamed = {};
  for (const [was, now] of Object.entries(RENAMED_ROUTING_WEIGHTS)) {
    if (source[was] !== undefined && source[now] === undefined) renamed[now] = source[was];
  }
  for (const key of Object.keys(DEFAULT_ROUTING_WEIGHTS)) {
    const value = validatedRoutingWeight(key,
      source[key] !== undefined ? source[key] : renamed[key]);
    if (value !== null) clean[key] = value;
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

// A failure is the STRONGEST verdict the map carries, and it was the faintest
// thing on it. Sharing the ordinary background ramp meant 0.9 * (0.4/0.95) =
// 0.38 with a route displayed, pre-blended over white and multiplied by another
// 0.82 on a local street -- so a deliberately dark red rendered as pale grey
// pink (field report: "still light gray red"). Caution already has this
// exemption for the same reason, one rung lower; a failure gets a stronger one.
function failBackgroundLineOpacity() {
  return routeIsDisplayed ? 0.82 : 0.92;
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

// Translate OSM's machine vocabulary for the rider-facing Details panel. The
// exact tags remain available in Debug view; strings such as
// "cycleway, bicycle=designated" do not belong loose in an ordinary card.
function osmInfrastructureType(p) {
  const names = {
    cycleway: 'Dedicated bike path',
    path: 'Shared-use or other path',
    footway: 'Foot path',
    bridleway: 'Bridleway',
    track: 'Track',
    service: 'Service road',
  };
  return names[p?.highway] || (p?.highway
    ? String(p.highway).replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase())
    : null);
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
    id: 'ferries',
    name: 'Ferry routes',
    url: Region.dataUrl('ferries.geojson.gz'),
    // Permanent geographic context, underneath roads and every safety layer.
    // This is a tiny graph-derived overlay rather than a routing-worker reply:
    // a blank native planner can show the boats without retaining the 142 MB
    // expanded graph before the rider asks for a route.
    zRank: -2,
    ferryContext: true,
    alwaysOn: true,
    enabled: true,
    expr: true,
    fc: null,
    loading: false,
  },
  {
    id: 'routes',
    name: 'Designated routes (USBR & regional)',
    url: Region.dataUrl('bikeroutes.geojson.gz'),
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
    vector: `pmtiles://${Region.dataUrl('overlays.pmtiles')}?v=2`,
    mapSourceId: 'overlays',
    sourceLayer: 'blts',
    count: Region.sourceCounts.blts, // build_overlay_tiles.py -> region.json
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
    vector: `pmtiles://${Region.dataUrl('overlays.pmtiles')}?v=2`,
    mapSourceId: 'overlays',
    sourceLayer: 'bikeinfra',
    count: Region.sourceCounts.bikeinfra, // after the sharrow-only drop
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
    url: Region.dataUrl('bike_restrictions.geojson.gz'),
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
    url: Region.dataUrl('route_closures.geojson.gz'),
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
    vector: `pmtiles://${Region.dataUrl('roads.pmtiles')}?v=24`,
    // The local basemap already opens this archive for its street geometry and
    // labels. Reuse that MapLibre source for safety coloring and hit testing so
    // iOS does not decode or retain the same vector tiles twice.
    mapSourceId: 'basemap-roads',
    sourceLayer: 'roads',
    count: Region.sourceCounts.roads, // baked at build time; tiles carry no total
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

// A state's folder decides which of these there are anything to draw. Every
// entry above is a fetch or a tile archive in maps/<state>/, and a state still
// being built may ship only some of them -- keeping a layer whose file is not
// there means a toggle in the layer list that turns on a 404, and (for the
// tiled ones) a MapLibre source that never loads.
const SOURCE_DATASET = {
  ferries: 'ferries', routes: 'bikeroutes', blts: 'overlays', osm: 'overlays',
  restrict: 'restrictions', closures: 'closures', roads: 'roads',
};
for (let i = SOURCES.length - 1; i >= 0; i--) {
  if (!Region.datasets[SOURCE_DATASET[SOURCES[i].id]]) SOURCES.splice(i, 1);
}

// Layer toggles restore from the persisted state (before panels build). The
// whole stored map is kept, not just the layers this state has: saveStateNow()
// writes it back underneath the current ones so a state with no scored linework
// cannot erase the rider's choices for the states that do.
let storedSourcePreferences = {};
try {
  const st = JSON.parse(localStorage.getItem('wa-bike-state-1') || 'null');
  if (st && st.sources) {
    storedSourcePreferences = { ...st.sources };
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
// Rules, layers and voice settings are the rider's, and follow them between
// states. A map view and a route are a pair of coordinates, and coordinates
// belong to the state they were taken in: restoring Washington's saved view
// after a switch to Oregon opens the map on Seattle, in the middle of a state
// whose data is not loaded, with a route drawn across a graph that is gone.
// Drop both when the saved blob came from a different folder.
const savedStateIsThisState = !savedState || savedState.stateId === Region.id
  // Written before there was more than one state: that data is about whichever
  // state the app used to open on, so the rider keeps their view there.
  || (savedState.stateId === undefined && Region.id === Region.defaultStateId);
if (savedState && !savedStateIsThisState) {
  savedState = { ...savedState, view: null, route: null };
}
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
// Routes the rider marked Preferred (Settings → Routes / the route tap card),
// keyed BY STATE: route names are coordinates in a state's data the same way
// a viewport is, so Washington's picks must survive a trip to Oregon and be
// waiting on return -- never applied to the wrong state's routes.
const preferredRoutesByState = savedState?.preferredRoutesByState
  && typeof savedState.preferredRoutesByState === 'object'
  ? { ...savedState.preferredRoutesByState } : {};
function preferredRouteNames() {
  const names = preferredRoutesByState[Region.id];
  return Array.isArray(names) ? names : [];
}
function isPreferredRoute(name) { return preferredRouteNames().includes(name); }
// The routing rules carry only a compact selection KEY -- the worker gets the
// geometry separately -- so every cost cache, bound and portfolio signature
// distinguishes selections without hauling coordinates through them.
function preferredRoutesRuleKey(names) { return names.slice().sort().join(''); }
function applyPreferredRoutesRuleKey() {
  const names = preferredRouteNames();
  if (names.length) rules.preferredRoutes = preferredRoutesRuleKey(names);
  else delete rules.preferredRoutes;
}
applyPreferredRoutesRuleKey();

// Switched-off route sources, keyed BY STATE for the same reason Preferred
// routes are: a source id belongs to one state's data. Only NON-OSM sources
// can be switched off -- OSM relations are the baseline the app is built on,
// not an opinion a rider opts into.
const suppressedRouteSourcesByState = savedState?.suppressedRouteSourcesByState
  && typeof savedState.suppressedRouteSourcesByState === 'object'
  ? { ...savedState.suppressedRouteSourcesByState } : {};
function suppressedRouteSourceIds() {
  const ids = suppressedRouteSourcesByState[Region.id];
  return Array.isArray(ids) ? ids : [];
}
function isRouteSourceSuppressed(id) { return suppressedRouteSourceIds().includes(id); }
// Like the Preferred key: the rules carry a compact string, the worker gets the
// geometry separately. rulesSignature() hashes every key in `rules`, so putting
// it here is what makes each cost cache, A* bound and portfolio signature
// distinguish a board built with a source on from one built with it off.
function applySuppressedRouteSourcesRuleKey() {
  const ids = suppressedRouteSourceIds();
  if (ids.length) rules.suppressedRouteSources = ids.slice().sort().join('\u0001');
  else delete rules.suppressedRouteSources;
}
applySuppressedRouteSourcesRuleKey();

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
// Off hides the optional Advanced routing weights tab. The route-shaping
// values themselves are preserved, so turning the editor back on restores the
// rider's previous tuning instead of silently resetting it.
const uiPrefs = {
  showAdvancedTools: typeof savedState?.showAdvancedTools === 'boolean'
    ? savedState.showAdvancedTools : true,
  // Stops always remain in the route; this preference only controls whether
  // their editable rows occupy the compact Start/Destination trip bar.
  showRouteStops: typeof savedState?.showRouteStops === 'boolean'
    ? savedState.showRouteStops : true,
  // Display only: the warnings still exist in Route Details and the voice
  // guidance; this hides their badges on the map line.
  hideRouteWarningIcons: savedState?.hideRouteWarningIcons === true,
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
  hillTaunt: !savedState || typeof savedState.voiceHillTaunt !== 'boolean'
    ? true : savedState.voiceHillTaunt,
  offRouteMode: AUTOMATIC_OFF_ROUTE_RECOVERY_ENABLED ? savedOffRouteRecoveryMode : 'guidance',
};

const DEFAULT_ROUTE_PREFERENCES = Object.freeze({
  prefDesig: ADVANCED_ROUTE_OPTION_DEFAULTS.prefDesig,
  prefResidential: ADVANCED_ROUTE_OPTION_DEFAULTS.prefResidential,
});
const ROUTING_PRESETS = Object.freeze([
  {
    id: 'randonneur',
    label: 'The Randonneur',
    audience: 'For long-distance riders who want the widest range of route choices.',
    blurb: 'Best for long-distance rides and maximum route choice, with looser safety limits.',
    rules: Object.freeze({ ...DEFAULT_RULES }),
  },
  {
    id: 'weekend-wanderer',
    label: 'Weekend Wanderer',
    audience: 'For day riders who want slower roads with practical flexibility.',
    blurb: 'Best for everyday rides on slower roads; practical compromises show as amber cautions.',
    rules: Object.freeze({
      ...DEFAULT_RULES,
      allowFreeways: false,
      maxSpeedNoShoulder: 25,
      busyNoShoulder: 2,
      upperMaxSpeed: 45,
      noUpperLimit: false,
      requireSafe: false,
      // Randonneur only. This preset is for riders who want slower roads honoured
      // literally, so a shoulder it infers rather than reads is not good enough.
      inferShoulderFromEdge: false,
    }),
  },
  {
    id: 'casual-cruiser',
    label: 'Casual Cruiser',
    audience: 'For riders who want low-stress routes that fully honor their safety rules.',
    blurb: 'Best for relaxed, low-stress riding. Only routes that fully match your safety rules are shown.',
    rules: Object.freeze({
      ...DEFAULT_RULES,
      allowFreeways: false,
      maxSpeedNoShoulder: 25,
      busyNoShoulder: 2,
      upperMaxSpeed: 35,
      noUpperLimit: false,
      requireSafe: true,
      // Randonneur only -- and especially not here, where requireSafe means a
      // route is filtered to fully matching road. An inferred shoulder must not
      // be what lets a road into that set.
      inferShoulderFromEdge: false,
    }),
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
  'combined-corridor', 'section-frontier', 'fully-matching',
  'forward-progress',
]);
// Adaptive ferry, combined land, and section-frontier itineraries carry UNIQUE suffixed ids
// because one portfolio can hold several and every structure downstream keys
// candidates by profile id. Validation accepts each family, not just its bare
// name.
function validRouteProfileId(id) {
  return ROUTE_PROFILE_IDS.has(id) || String(id || '').startsWith('direct-lens')
    || /^(?:adaptive|combined)-corridor-\d+$/.test(String(id || ''))
    || /^section-frontier-\d+$/.test(String(id || ''));
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
  const viaNames = Array.isArray(route.vn) ? route.vn : [];
  const blockNames = Array.isArray(route.bn) ? route.bn : [];
  // Preserve plans created before the editor gained a stop limit. New edits
  // cannot add past the limit, but opening an old plan must not delete stops.
  return {
    s: route.s, e: route.e, v: [...vias], b: [...blocks],
    vn: vias.map((_, index) => normalizeEndpointName(viaNames[index]) || 'Point on map'),
    bn: blocks.map((_, index) => normalizeEndpointName(blockNames[index])),
    sn: normalizeEndpointName(route.sn), en: normalizeEndpointName(route.en),
    sd: route.sd === true,
    ss: typeof route.ss === 'string' ? route.ss : null,
    es: typeof route.es === 'string' ? route.es : null,
    vs: vias.map((_, index) => typeof route.vs?.[index] === 'string' ? route.vs[index] : null),
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
        vn: vias.slice(0, MAX_ROUTE_STOPS).map((_, index) =>
          normalizeEndpointName(Array.isArray(data.y) ? data.y[index] : null) || 'Point on map'),
        bn: blocks.slice(0, MAX_ROAD_BLOCKS).map((_, index) =>
          normalizeEndpointName(Array.isArray(data.zn) ? data.zn[index] : null)),
        sn: normalizeEndpointName(data.a), en: normalizeEndpointName(data.b),
      },
      mode: ['direct', 'balanced', 'low'].includes(data.m) ? data.m : null,
      profileId: validRouteProfileId(data.o) ? data.o : null,
      prefDesig: typeof data.p === 'boolean' ? data.p : null,
      prefResidential: typeof data.q === 'boolean' ? data.q : null,
      rules: sharedRules,
      weights: data.w && typeof data.w === 'object' && !Array.isArray(data.w)
        ? validRoutingWeights(data.w) : null,
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
      // Which state the `view` and `route` below are coordinates in. Without
      // it a switch reopens the map on the previous state's saved viewport.
      stateId: Region.id,
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
      // Whole map, every state's picks -- the same non-destructive rule as
      // storedSourcePreferences: saving from Oregon must not erase Washington's.
      preferredRoutesByState,
      suppressedRouteSourcesByState,
      voiceHeadings: navVoice.headings, voiceUpdateMin: navVoice.updateMin,
      voiceStatusRoute: navVoice.statusRoute, voiceStatusSpeed: navVoice.statusSpeed,
      voiceStatusMiles: navVoice.statusMiles, voiceStatusEta: navVoice.statusEta,
      voiceSafetyLevels: navVoice.safetyLevels,
      voiceHillTaunt: navVoice.hillTaunt,
      keepScreenAwake: navVoice.keepScreenAwake,
      navigationOffRouteMode: navVoice.offRouteMode,
      weights: routingWeights, weightsVersion: ROUTING_WEIGHTS_VERSION,
      showAdvancedTools: uiPrefs.showAdvancedTools,
      showRouteStops: uiPrefs.showRouteStops,
      hideRouteWarningIcons: uiPrefs.hideRouteWarningIcons,
      // Layered over whatever was already stored, not replacing it: a state
      // that ships no scored linework has no SOURCES, and writing its empty
      // set would reset the rider's layer toggles for every other state the
      // moment they looked at that one.
      sources: { ...storedSourcePreferences,
        ...Object.fromEntries(SOURCES.map((s) => [s.id, !!s.enabled])) },
      view: Region.localDataAvailable
        ? { c: map.getCenter().toArray().map((v) => +v.toFixed(5)),
            z: +map.getZoom().toFixed(2) }
        : null,
      route: routing.start && routing.end
        ? {
            s: routing.start, e: routing.end, v: routing.vias.map((x) => x.pt),
            vn: routing.vias.map((x) => x.name),
            b: routing.blocks.map((x) => x.pt),
            bn: routing.blocks.map((x) => x.ferryName || null),
            sn: routing.startName, en: routing.endName,
            sd: routing.startFromDevice,
            ss: routing.startStateId, es: routing.endStateId,
            vs: routing.vias.map((x) => x.stateId || null),
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
const constrainedMapRuntime = isConstrainedDevice() && !isMacDesktopSafari();
const map = new maplibregl.Map({
  container: 'map',
  style: BikeBasemap.createStyle({ constrainedRenderer: constrainedMapRuntime }),
  // The full attribution sentence can span most of a phone and used to paint
  // over Navigate when the Route sheet raised both controls into one band.
  // Keep the required attribution one tap away behind MapLibre's own info
  // disclosure on every viewport; desktop users can expand it too.
  attributionControl: { compact: true },
  center: Region.localDataAvailable
    ? ((savedState && savedState.view && savedState.view.c) || Region.defaultCenter)
    : [-104, 39],
  zoom: Region.localDataAvailable
    ? ((savedState && savedState.view && savedState.view.z) || 6.4) : 2.25,
  // Detailed statewide archives remain above the WebKit-safe handoff, while
  // the lightweight regional archive now carries coastline-correct land and
  // water below it. Phones can therefore use the full regional range without
  // decoding the oversized low-zoom context tiles. Desktop remains at z5.
  minZoom: Region.localDataAvailable ? (constrainedMapRuntime ? 4 : 5) : 1.5,
  maxZoom: Region.localDataAvailable ? 17 : 6,
  // Retained-tile budget. The default keeps ~5 zoom levels of decoded tiles
  // per source; with two state archives plus seven route GeoJSON pyramids on
  // a long trip, zooming in and out measured multi-GB renderer growth from
  // retained tiles alone — on iOS unified memory that spend counts straight
  // against the same ceiling that kills the page. Two levels keeps
  // pinch-reversal smooth while capping retention; desktop keeps the default.
  ...(constrainedMapRuntime ? { maxTileCacheZoomLevels: 2 } : {}),
  // Cross-fading holds both tile generations during the exact gesture where
  // WebKit is under the most memory pressure. A direct swap is fine on phone.
  fadeDuration: constrainedMapRuntime ? 0 : 300,
  maxPitch: 0,
  pitchWithRotate: false,
  // NO maxTileCacheSize override. A 16-tile cap shipped briefly (v.592) on
  // the theory that retained tiles were the zoom-out memory spike -- and the
  // field verdict was immediate: "constant crashes, seems to be about when I
  // zoom, used to not". Bounding retention forces every zoom to re-fetch,
  // re-parse and RE-BUCKET tiles the default cache would have kept, and that
  // per-zoom allocation spike is worse for WebKit than the retention it
  // saved. The real zoom-out fix is upstream: the overlay archive keeps only
  // trails below z9 and the invisible tap layers floor at z9, so low-zoom
  // tiles are small enough for the default cache policy to handle.
});
function collapseMapAttribution() {
  const attribution = document.querySelector('.maplibregl-ctrl-attrib.maplibregl-compact');
  if (!attribution) return;
  // MapLibre deliberately initializes compact attribution expanded until the
  // first map drag. That puts the full credit line over Navigate on a route
  // that has not been dragged yet. Match its own collapsed-state bookkeeping.
  attribution.setAttribute('open', '');
  attribution.classList.remove('maplibregl-compact-show');
}
collapseMapAttribution();
map.once('load', collapseMapAttribution);
// iOS reclaims WebGL contexts under memory pressure. MapLibre halts its frame
// loop on webglcontextlost and resumes only if the BROWSER restores the
// context -- which memory-pressured WebKit frequently never does -- leaving a
// permanently frozen map that a rider reports as a crash. Give the browser a
// moment to restore on its own, then reboot the shell once behind a hash
// guard, the same self-heal the archive verifier uses. A healthy boot clears
// the guard so a later loss can heal again; a loss that survives its own
// reboot stays lost rather than reload-looping.
const CONTEXT_HEAL_MARK = '#jra-context-heal';
map.once('load', () => {
  if (location.hash === CONTEXT_HEAL_MARK) {
    history.replaceState(null, '', location.pathname + location.search);
  }
});
map.on('webglcontextlost', () => {
  let restored = false;
  map.once('webglcontextrestored', () => { restored = true; });
  setTimeout(() => {
    if (restored || location.hash === CONTEXT_HEAL_MARK) return;
    // One self-reload is a heal. Repeated ones are a crash loop with extra
    // steps: context losses recurring within minutes mean sustained memory
    // pressure (a heavy saved-trip recompute, WebKit reclaiming GPU memory),
    // and each reload restarts the same pressure — from the outside the app
    // just "crashes over and over after boot" (field report, 2026-08-25).
    // Two auto-heals per ten minutes; past that, stop and tell the rider.
    const HEAL_LOG_KEY = 'jra-context-heals-1';
    let heals = [];
    try {
      heals = JSON.parse(sessionStorage.getItem(HEAL_LOG_KEY) || '[]');
    } catch (e) { /* fresh log */ }
    const now = Date.now();
    heals = (Array.isArray(heals) ? heals : [])
      .filter((t) => Number.isFinite(t) && now - t < 10 * 60 * 1000);
    if (heals.length >= 2) {
      showRouteActionToast('The map lost its graphics context', {
        detail: 'If the map stays blank, close and reopen the app.',
        duration: 0,
      });
      return;
    }
    heals.push(now);
    try { sessionStorage.setItem(HEAL_LOG_KEY, JSON.stringify(heals)); } catch (e) { /* best effort */ }
    location.hash = CONTEXT_HEAL_MARK;
    location.reload();
  }, 3000);
});
map.once('render', () => window.__setAppLaunchStatus?.('Drawing roads and trails…'));
// Slow tile fills used to be invisible work: the map just sat there part
// drawn with nothing saying why (field, 2026-08-25 — "super slow to fill
// in"). The pill appears only after the renderer has been waiting on tiles
// for a continuous stretch, and leaves the moment the map goes idle. The
// launch screen narrates its own phase, so the pill stays out of boot.
const MAP_LOADING_PILL_DELAY_MS = 2500;
const MAP_LOADING_PILL_QUIET_MS = 5000;
let mapLoadingPillTimer = null;
let mapLoadingPillRecheck = null;
let mapLoadingLastEventAt = 0;
function armMapLoadingPill() {
  mapLoadingLastEventAt = Date.now();
  if (mapLoadingPillTimer != null || mapLoadingPillRecheck != null) return;
  mapLoadingPillTimer = setTimeout(() => {
    mapLoadingPillTimer = null;
    const pill = document.getElementById('mapLoadingPill');
    if (!pill || !document.documentElement.classList.contains('app-ready')) return;
    if (map.areTilesLoaded?.() !== false && map.loaded()) return;
    pill.hidden = false;
    // 'idle' is not a reliable exit: a request that hangs (rather than
    // failing) leaves its tile 'loading' forever, so neither idle nor
    // areTilesLoaded ever recovers in that world. The pill therefore means
    // "map data is actively being fetched": it stays while loading events
    // keep arriving and leaves once the stream has been quiet for a beat.
    mapLoadingPillRecheck = setInterval(() => {
      const tilesDone = map.areTilesLoaded?.() !== false && map.loaded();
      const quiet = Date.now() - mapLoadingLastEventAt > MAP_LOADING_PILL_QUIET_MS;
      if (tilesDone || quiet) settleMapLoadingPill();
    }, 1500);
  }, MAP_LOADING_PILL_DELAY_MS);
}
function settleMapLoadingPill() {
  clearTimeout(mapLoadingPillTimer);
  mapLoadingPillTimer = null;
  clearInterval(mapLoadingPillRecheck);
  mapLoadingPillRecheck = null;
  const pill = document.getElementById('mapLoadingPill');
  if (pill) pill.hidden = true;
}
map.on('dataloading', armMapLoadingPill);
map.on('sourcedataloading', armMapLoadingPill);
map.on('idle', settleMapLoadingPill);
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
const visibleStateSafetySignatures = new Map();

function visibleStateSafetyLayers() {
  const layers = map.getStyle?.()?.layers || [];
  return layers.filter((layer) =>
    (layer.source === 'basemap-roads'
      && (layer.id === 'roads' || layer.id.startsWith('roads__')))
    || (layer.source === 'overlays'
      && (layer.id === 'osm' || layer.id.startsWith('osm__'))));
}

function syncVisibleStateSafetyLayers(stateIds, { force = false } = {}) {
  if (!map.getStyle?.()) return;
  const templates = visibleStateSafetyLayers();
  if (!templates.length) return;
  const templateSignature = JSON.stringify(templates);
  const active = new Set(stateIds || []);
  for (const stateId of [...visibleStateSafetySignatures.keys()]) {
    if (!active.has(stateId)) visibleStateSafetySignatures.delete(stateId);
  }
  for (const stateId of active) {
    const prefix = `state-${stateId}-safety-`;
    const expectedLayerIds = templates
      .filter((template) => map.getSource(template.source === 'basemap-roads'
        ? `state-${stateId}-basemap-roads`
        : `state-${stateId}-basemap-overlays`))
      .map((template) => `${prefix}${template.id}`);
    if (!force && visibleStateSafetySignatures.get(stateId) === templateSignature
      && expectedLayerIds.every((id) => map.getLayer(id))) continue;
    for (const layer of [...(map.getStyle().layers || [])].reverse()) {
      if (layer.id.startsWith(prefix) && map.getLayer(layer.id)) map.removeLayer(layer.id);
    }
    for (const template of templates) {
      const source = template.source === 'basemap-roads'
        ? `state-${stateId}-basemap-roads`
        : `state-${stateId}-basemap-overlays`;
      if (!map.getSource(source)) continue;
      const layer = JSON.parse(JSON.stringify(template));
      layer.id = `${prefix}${template.id}`;
      layer.source = source;
      // Keep labels and the active route above both states' safety colors by
      // placing every clone immediately below its home-state counterpart.
      map.addLayer(layer, map.getLayer(template.id) ? template.id : undefined);
      // A cloned tap target must ANSWER taps: featureAt queries the layers
      // registered here, and without this a tap on a neighbor state's road
      // dropped a bare point instead of opening the road card (field
      // report). Same source object, so scoring and the card read the clone
      // exactly like its home template. Stale ids after a detach are
      // harmless -- featureAt filters on map.getLayer.
      if (HIT_SRC[template.id] && !HIT_SRC[layer.id]) {
        attachHover(HIT_SRC[template.id], layer.id);
      }
    }
    visibleStateSafetySignatures.set(stateId, templateSignature);
  }
}

// A relative of the bike-network lime, deliberately duller and translucent:
// a signed route is a recommendation whose usability still depends on the
// road passing the rider's own rules, so it reads as family with the lime
// without claiming to BE bike infrastructure. Shared by the home overlay and
// every visible neighbor's mirror so the ribbon means one thing everywhere.
function applyDesignatedRibbonPaint(layerId) {
  setPaint(layerId, 'line-color', DESIGNATED_COLOR);
  setPaint(layerId, 'line-width', designatedRibbonWidth());
  setPaint(layerId, 'line-opacity', ['case', ['==', ['get', 'pr'], 1],
    backgroundLineOpacity(0.52), backgroundLineOpacity(0.4)]);
  setPaint(layerId, 'line-dasharray', [2, 1.4]);
}

// Neighbor states' designated-route ribbons. The home overlay is a scored
// GeoJSON fetch (bikeroutes.geojson.gz), not a tile archive, so the
// visible-state source sync cannot mirror it the way it mirrors the roads
// and overlays archives -- and without a mirror, signed routes existed only
// in the home state (field report). Each attached visible state fetches its
// own file once and draws it with the identical ribbon styling, under the
// same Designated-routes toggle. Preferred routing and per-route hide
// toggles remain home-scoped: this is display context, not controls.
const visibleStateRouteOverlays = new Map();
const visibleStateRouteRibbonId = (stateId) => `state-${stateId}-routes-ribbon`;
function visibleStateRouteRibbonIds() {
  return [...visibleStateRouteOverlays.keys()].map(visibleStateRouteRibbonId)
    .filter((id) => map.getLayer(id));
}
function attachVisibleStateRouteRibbon(stateId, fc) {
  const sourceId = `state-${stateId}-routes`;
  if (!map.getSource(sourceId)) {
    map.addSource(sourceId, { type: 'geojson', data: fc });
  }
  const layerId = visibleStateRouteRibbonId(stateId);
  if (!map.getLayer(layerId)) {
    // Directly beneath the home ribbon, so both states' route context shares
    // one stratum at the bottom of the data stack.
    const anchor = map.getLayer('routes') ? 'routes'
      : map.getLayer('roads') ? 'roads' : undefined;
    forgetStyleValues(); map.addLayer({
      id: layerId, type: 'line', source: sourceId, minzoom: 0,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
    }, anchor);
  }
  applyDesignatedRibbonPaint(layerId);
  setLayout(layerId, 'visibility', display.designated ? 'visible' : 'none');
}
function syncVisibleStateRouteOverlays(stateIds) {
  if (!map.getStyle?.()) return;
  const active = new Set(stateIds || []);
  for (const [stateId, entry] of [...visibleStateRouteOverlays]) {
    if (active.has(stateId)) continue;
    visibleStateRouteOverlays.delete(stateId);
    entry.detached = true;
    const layerId = visibleStateRouteRibbonId(stateId);
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(`state-${stateId}-routes`)) {
      map.removeSource(`state-${stateId}-routes`);
    }
  }
  for (const stateId of active) {
    const entry = visibleStateRouteOverlays.get(stateId);
    if (entry) {
      // Re-ensure after a style rebuild. Source intact: re-add the layer
      // without refetching. Source gone too: forget the attachment so the
      // creation path below runs again.
      if (entry.loaded && !map.getLayer(visibleStateRouteRibbonId(stateId))) {
        if (map.getSource(`state-${stateId}-routes`)) {
          attachVisibleStateRouteRibbon(stateId, null);
        } else {
          entry.detached = true;
          visibleStateRouteOverlays.delete(stateId);
        }
      }
      if (visibleStateRouteOverlays.has(stateId)) continue;
    }
    const state = Region.states.find((item) => item.id === stateId);
    if (!state?.datasets?.bikeroutes) continue;
    const next = { loaded: false, detached: false };
    visibleStateRouteOverlays.set(stateId, next);
    (async () => {
      try {
        const url = `maps/${stateId}/bikeroutes.geojson.gz`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const fc = await jsonAssetResponse(res, url);
        if (next.detached) return;
        attachVisibleStateRouteRibbon(stateId, fc);
        next.loaded = true;
      } catch (error) {
        // Offline before first cache fill, or a state pack without the file:
        // forget the attempt so a later pan can retry.
        if (visibleStateRouteOverlays.get(stateId) === next) {
          visibleStateRouteOverlays.delete(stateId);
        }
      }
    })();
  }
}

function syncVisibleDetailedMapSources() {
  if (!Region.localDataAvailable || !map.getStyle?.()) return;
  const installed = Region.states.filter((state) =>
    !window.MapStore || MapStore.availability(state.id) !== 'remote');
  const visible = BikeBasemap.syncVisibleStateSources(map, installed, Region.id);
  syncVisibleStateSafetyLayers(visible);
  syncVisibleStateRouteOverlays(visible);
  document.body.dataset.visibleMapStateIds = [Region.id, ...visible].join(',');
}
map.on('moveend', syncVisibleDetailedMapSources);
// The error hook's detach retry re-enters through this entry point rather
// than waiting for the rider's next pan.
map.__visibleStateResync = syncVisibleDetailedMapSources;
if (map.loaded()) syncVisibleDetailedMapSources();
else map.once('load', syncVisibleDetailedMapSources);
// On a phone, a completed route can leave hundreds of megabytes of reusable
// worker caches alive. Give those back before MapLibre widens its tile set;
// the graph, displayed routes, and the worker's More-route geometries remain.
map.on('zoomstart', () => trimRouterCachesSoon());
// MapLibre's control probes the browser geolocation stack as soon as it is
// added. In WKWebView that can raise iOS's permission sheet even though the
// native location plugin is deliberately waiting for an explicit rider
// action. Use one app-owned, retryable button everywhere rather than letting
// MapLibre permanently disable its control after a transient permission/API
// probe. The click handler below chooses NativeNavigation or web geolocation.
class AppGeolocateControl {
  onAdd() {
    this.container = document.createElement('div');
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'maplibregl-ctrl-geolocate';
    this.button.dataset.appLocationControl = 'true';
    this.button.disabled = false;
    this.button.title = 'Find my location';
    this.button.setAttribute('aria-label', 'Find my location');
    const icon = document.createElement('span');
    icon.className = 'maplibregl-ctrl-icon';
    icon.setAttribute('aria-hidden', 'true');
    this.button.appendChild(icon);
    this.container.appendChild(this.button);
    return this.container;
  }

  onRemove() {
    this.container?.remove();
    this.container = null;
    this.button = null;
  }
}

const mapLocationControl = new AppGeolocateControl();
map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-right');
map.addControl(mapLocationControl, 'bottom-right');
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

  // A fix outside the selected state's coverage must never become the camera
  // target: the graph, the tiles and the places all stop at the state line,
  // so flying there shows a void. Say so instead, and make sure the rider is
  // looking at the map they selected -- an in-state saved view is left alone;
  // a camera that is ALSO outside the state goes to the state's own center.
  if (!Region.contains(lng, lat)) {
    clearPassiveMapLocationMarker();
    const center = map.getCenter();
    if (!Region.contains(center.lng, center.lat)) {
      map.easeTo({ center: Region.defaultCenter, zoom: Region.defaultZoom,
        duration: 650, essential: true });
    }
    showRouteActionToast('GPS location outside selected map',
      { duration: 3600, answer: true });
    return false;
  }

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
  // Location acquisition does not depend on map tiles or style data. Waiting
  // for MapLibre's one-shot `load` event introduced a race: `loaded()` flips
  // back to false while tiles are pending, even after that event has passed,
  // so an authorized returning rider could wait forever. Markers and camera
  // state are safe to set while the style is still arriving.
  return recenterMapOnCurrentLocation(reason);
}

// Recenter silently when the native app already has permission, but do not put
// a system permission sheet over the first map a rider ever sees. A fresh
// install asks in context — when they tap the locate control or choose "my
// location" — while returning riders still open centered where they are.
async function requestInitialMapLocation() {
  const plugin = nativeNavigationPlugin();
  if (plugin?.getStatus) {
    try {
      const status = await plugin.getStatus();
      if (!status?.servicesEnabled
          || ['prompt', 'denied', 'restricted'].includes(status.authorization)) return false;
    } catch (e) {
      return false;
    }
  }
  requestMapLocationRecenter('launch');
  return true;
}
requestInitialMapLocation();

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
  e.stopPropagation();
  e.preventDefault();
  btn.disabled = false;
  btn.classList.add('maplibregl-ctrl-geolocate-waiting');
  btn.setAttribute('aria-busy', 'true');
  getDevicePosition({ timeout: 15000 }).then((position) => {
    updatePassiveMapLocation(position, 'launch');
    btn.classList.add('maplibregl-ctrl-geolocate-active');
  }).catch((error) => {
    const blocked = /blocked|denied|permission/i.test(String(error?.message || error));
    setStatus(blocked
      ? 'Location permission is blocked in your device Settings.'
      : 'Could not get your location. Tap the location button to try again.', true);
  }).finally(() => {
    btn.disabled = false;
    btn.classList.remove('maplibregl-ctrl-geolocate-waiting');
    btn.setAttribute('aria-busy', 'false');
  });
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
  // A timing readout is for the console, not the rider -- this used to flash
  // "Recolored in 11 ms" on screen after every rules change (field report).
  if (ms > 0) console.debug(`[rescore] recolored in ${ms} ms`);
  if (recomputeRoute && routeEngineReady() && routing.start && routing.end) computeRoute();
}

// Rule sliders may update several large GeoJSON sources. Throttle map work and
// wait for the thumb to settle before routing again; otherwise Safari can queue
// enough style/data work during a drag to become unstable.
let _rescoreTimer = null;
let _ruleRouteTimer = null;
// Settings is a full-screen editing session. The map and route are hidden
// behind it, so doing heavyweight work after every thumb movement or checkbox
// tap buys the rider nothing and can overwhelm mobile WebKit. Remember the
// work instead; leaving Settings applies the final state once.
let settingsRouteChangesPending = false;
let settingsRescorePending = false;

function deferSettingsRouteChange({ rescore = false } = {}) {
  if (!settingsMenuIsOpen()) return false;
  settingsRouteChangesPending = true;
  settingsRescorePending ||= rescore;
  saveStateSoon();
  return true;
}

function beginSettingsEditSession() {
  // If the rider opens Settings while a previous control's debounce is still
  // pending, carry that work into this session rather than canceling it.
  settingsRouteChangesPending = _ruleRouteTimer != null;
  settingsRescorePending = _rescoreTimer != null;
  clearTimeout(_rescoreTimer);
  clearTimeout(_ruleRouteTimer);
  _rescoreTimer = null;
  _ruleRouteTimer = null;
}

function finishSettingsEditSession() {
  const reroute = settingsRouteChangesPending;
  const rescore = settingsRescorePending;
  settingsRouteChangesPending = false;
  settingsRescorePending = false;
  if (!reroute && !rescore) return;
  saveStateSoon();
  if (rescore) rescoreAll(false);
  if (!reroute) return;
  if (routing.start && routing.end) computeRoute({ revealPanel: false });
  else schedulePrewarm();
}

function scheduleRescore() {
  if (deferSettingsRouteChange({ rescore: true })) return;
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
    // revealPanel: false -- the rider is IN Settings, mid-adjustment, and the
    // default reveal switched the sheet to the Route tab 700ms after every
    // slider settled, yanking the panel out from under them (field report).
    // The recompute happens either way; the toast in computeRoute says so.
    if (routeEngineReady() && routing.start && routing.end) computeRoute({ revealPanel: false });
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
  if (deferSettingsRouteChange()) return;
  saveStateSoon();
  clearTimeout(_ruleRouteTimer);
  _ruleRouteTimer = setTimeout(() => {
    _ruleRouteTimer = null;
    // Same reveal suppression as scheduleRescore, same reason.
    if (routeEngineReady() && routing.start && routing.end) computeRoute({ revealPanel: false });
    else schedulePrewarm();
  }, 700);
}

// Ask the router to fill its per-arc cost cache for the current settings
// while nobody is waiting, so the FIRST search of a session runs at the
// speed a long-lived app reaches organically (field: fresh Mac tab 16.8 s
// vs warmed-up phone 3.5 s for the same trip). Only when no trip is set --
// an actual search warms the cache better than any sweep.
// One answer for every memory decision. Phones and iPads (iPadOS reports
// itself as MacIntel with touch, hence the maxTouchPoints check), low-RAM
// Android via deviceMemory -- and EVERY Safari, desktop included: WebKit
// enforces a per-tab memory ceiling that Chromium does not, and a Mac
// Safari tab was reloaded "because it was using significant memory" with
// the full cache complement. Drives the worker's cache caps, the lite
// prewarm, and the tile-cache cap; a wrong "true" costs a few seconds of
// re-derived cache on repeat searches, a wrong "false" risks the kill.
function isConstrainedDevice() {
  return isNativeAppRuntime()
    || /iPad|iPhone|iPod|Android/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    || (navigator.deviceMemory > 0 && navigator.deviceMemory <= 4)
    || /^Apple/.test(navigator.vendor || '');
}

// Renderer class follows the RENDERER, not the WebKit brand. Mac desktop
// Safari shares the per-tab memory ceiling (so it keeps every worker cap and
// routing budget above), but it drives a desktop GPU and a desktop screen:
// the constrained tile bands — the z9 context floor that hides lakes, green
// and land detail at regional zoom, the retained-tile cap, the z6 minimum
// zoom, the disabled cross-fade — exist for phone renderers dropping
// oversized tiles, and on a Mac they read as the map losing its geography
// (field: desktop screenshots of lake labels with no lakes). iPads keep the
// phone renderer: same ceiling, tablet GPU.
function isMacDesktopSafari() {
  return /^Apple/.test(navigator.vendor || '')
    && !/iPad|iPhone|iPod/i.test(navigator.userAgent)
    && !(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    && !isNativeAppRuntime();
}

// The sweep has its own counter. routing.reqId is what every route reply is
// matched against, so spending one here would silently discard an in-flight
// route -- today that cannot happen only because of the early return above,
// which is too far from the postMessage to be a guarantee.
let prewarmRequestId = 0;
function schedulePrewarm() {
  if (!routing.ready || !routing.worker) return;
  if (routing.start && routing.end) return;
  routing.worker.postMessage({ type: 'prewarm', id: `prewarm-${++prewarmRequestId}`,
    rules: { ...rules }, weights: { ...routingWeights }, lite: isConstrainedDevice(),
    // The discovery-lens sweep warms discover-quick under the rider's own
    // preference combo -- the same one a real request would search with.
    prefDesignated: routing.prefDesig, prefResidential: routing.prefResidential });
}

const FAIL_COLOR = '#9aa0a6';
/* --------------------------------------------- colour-blind-safe patterns
 * Hue alone cannot carry these three verdicts. Simulated against deuteranopia
 * and protanopia, the fail red, the caution amber and the bike-network green
 * all collapse into one olive family; only the pass blue survives. So the
 * verdicts are separated by TEXTURE first and lightness second:
 *
 *   fails       dark red DASH, with the map showing through the gaps
 *   caution     perpendicular ticks (rungs across the road)
 *   passes      solid
 *
 * The failure used to be white diagonal slashes on red, and that was wrong
 * twice over. It was the same image the bikes-prohibited layer draws, so above
 * z13 a failing road and a road bicycles may not legally use were the same
 * symbol; and it only existed above z13, so a failing road changed appearance
 * as the rider zoomed -- solid below, hatched above. A dash is authored in
 * line-width multiples, so it scales with the road and reads identically at
 * every zoom. The white also lightened the line by nearly 40% of its pixels,
 * which is why removing it reads as darker without touching the palette.
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
const PATTERN_CAUTION = 'verdict-caution';
// Level 4's dash.
//
// `line-dasharray` is measured in LINE-WIDTH multiples, so a fixed pair does
// not hold its size on screen -- it holds its size relative to the road, and
// safetyRoadWidth runs 0.6 px at z5 to 10.4 px at z17. A flat [2.6, 1.3] was
// therefore a 1.6 px dash out at state level and a 27 px slab up close, which
// is the opposite of the "same symbol at every zoom" this was meant to deliver
// (field report: "too much, and it should be consistent at various zoom
// levels").
//
// So the multiplier steps DOWN as the line widens, holding the drawn dash at
// roughly 8 px of ink and 4.5 px of gap throughout.
//
// It has to be the legacy `{ stops }` function, NOT a `['step', ['zoom'], ...]`
// expression. `line-dasharray` is a cross-faded property: a bare map.addLayer()
// accepts the expression form without complaint, which is what made this look
// settled, but in the app's real layer stack the layer is silently DROPPED --
// roads__vh and roads__prohibited both vanished and the style went from 57
// layers to 50, with no page error anywhere. Do not "modernise" this.
//
// The dash held its drawn size, but the LINE under it did not: at the shared
// road width a failing road was a 0.6-2 px hairline below z11, and a dashed
// hairline at county scale reads as nothing at all (field report: the dashes
// disappear when you zoom out). A failure is the strongest verdict on the
// map, so it keeps a visible width floor when zoomed out and converges back
// to the shared road-interior width by z13, where the roads are wide enough
// to carry the dash themselves. The dash multiples below are recomputed for
// THESE widths -- change one and you must change the other.
const FAIL_ROAD_WIDTH = ['interpolate', ['linear'], ['zoom'],
  5, 1.8, 8, 2.2, 11, 2.8, 13, 3.9, 15, 6.2, 17, 9];
const FAIL_DASH = { stops: [
  [5, [4.6, 2.5]], [8, [3.7, 2.0]], [11, [3.0, 1.6]],
  [13, [2.1, 1.15]], [15, [1.3, 0.73]],
] };
// The prohibition ribbon is wider than the road and rides over it, so the same
// flat-dasharray problem showed up there first and worst: at z17 its 15 px
// line turned [2, 1.4] into a 30 px block. Same rule, sized for its own width.
const PROHIBITED_DASH = { stops: [
  [6, [3.2, 2.2]], [10, [1.7, 1.2]], [14, [1.0, 0.7]], [17, [0.75, 0.5]],
] };
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
const hitId = (src) => src.id + '__hit';   // wide transparent line: easy hover target
// Invisible tap targets draw nothing yet bucket every feature their tiles
// carry -- and the overlay archive deliberately carries the FULL statewide
// bike network in each low-zoom tile. Bucketing all of it several zoom
// levels over, purely so a statewide tap could return a card about a road a
// mile from the finger, is what tipped phones into the zoom-out crash. Below
// this zoom the visible layers still paint; taps just don't resolve.
const TAP_TARGET_MIN_ZOOM = 9;
const trailBaseId = (src) => src.id + '__trail-base'; // always-on neutral trail casing
const trailId = (src) => src.id + '__trail'; // lime base for off-street OSM bike paths/trails
const trailDotsId = (src) => src.id + '__trail-dots'; // fine dotted trail centerline
const trailHitId = (src) => src.id + '__trail-hit'; // dedicated wide target for dotted trails
const trailLabelId = (src) => src.id + '__trail-labels';
const backgroundUnpavedId = (src) => src.id + '__unpaved-slats';
const stateSidewalkProbeId = 'roads__state-sidewalk-probe';
const ferryContextCasingId = (src) => src.id + '__casing';
const ferryContextLabelId = (src) => src.id + '__labels';
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
const ROAD_CLASS_MINOR_EXPR = ['match', ROAD_CLASS_EXPR,
  BikeBasemap.ROAD_CLASSES.minor, true, false];
const ROAD_CLASS_LOCAL_EXPR = ['match', ROAD_CLASS_EXPR,
  BikeBasemap.ROAD_CLASSES.local, true, false];
// On-street bicycle facilities are valuable city context, but revealing every
// bike-lane block at statewide/county scale produces nearly as much confetti as
// the full local-road grid. Off-street trails have their own layers below and
// stay visible earlier; painted/separated facilities join the hierarchy once a
// rider is looking at a city, shortly before all local streets appear.
const BIKE_FACILITY_MIN_ZOOM = 11.25;
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

// Local streets arrive in large batches at the neighborhood-detail threshold.
// Keep their safety colors fully opaque (so overlaps cannot create dark
// seams), but preblend them a little more softly than larger roads.
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
  if (src.ferryContext) {
    // Ferry routes are water context, not a safety verdict. Put their line
    // beneath the street network; the labels remain with the other basemap
    // labels so terminal roads do not cover the text.
    const roadAnchor = map.getLayer('basemap-major-casing')
      ? 'basemap-major-casing' : beforeId;
    forgetStyleValues(); map.addLayer({
      id: ferryContextCasingId(src), type: 'line', source: mapSourceId,
      minzoom: 7.5,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#f1f8fa',
        'line-width': ['interpolate', ['linear'], ['zoom'],
          7.5, 1.7, 10, 2.1, 13, 2.8, 16, 3.6],
        'line-opacity': 0.72,
      },
    }, roadAnchor);
    forgetStyleValues(); map.addLayer({
      id: src.id, type: 'line', source: mapSourceId,
      minzoom: 7.5,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': '#4f7f92',
        'line-width': ['interpolate', ['linear'], ['zoom'],
          7.5, 0.75, 10, 1, 13, 1.45, 16, 2],
        'line-opacity': 0.78,
        'line-dasharray': [1.1, 1.65],
      },
    }, roadAnchor);
    // The visible ferry line is intentionally fine and dashed. Give it the
    // same forgiving invisible tap target as roads and trails, and register
    // that target with the shared feature-details system. Without this, the
    // visible line highlighted but renderReadout had no source to describe.
    forgetStyleValues(); map.addLayer({
      id: hitId(src), type: 'line', source: mapSourceId,
      minzoom: 7.5,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#000',
        'line-opacity': 0,
        'line-width': ['interpolate', ['linear'], ['zoom'], 7.5, 12, 12, 18, 16, 26],
      },
    }, roadAnchor);
    forgetStyleValues(); map.addLayer({
      id: ferryContextLabelId(src), type: 'symbol', source: mapSourceId,
      minzoom: 10,
      filter: ['all', ['has', 'n'], ['!=', ['get', 'n'], '']],
      layout: {
        'symbol-placement': 'line', 'symbol-spacing': 520,
        'text-field': ['get', 'n'], 'text-font': [BikeBasemap.FONT_STACK],
        'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10.5, 14, 12.5],
        'text-max-angle': 30, 'text-padding': 7, 'text-keep-upright': true,
      },
      paint: {
        'text-color': '#416c7d', 'text-halo-color': '#eaf5f8',
        'text-halo-width': 1.4, 'text-halo-blur': 0.3,
      },
    }, beforeId);
    attachHover(src, hitId(src));
    updateVisibility(src);
    return;
  }
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
    filter: ['all', ['>=', ['get', 'level'], display.passMax + 1], ['<=', ['get', 'level'], 3]],
  }, beforeId);
  forgetStyleValues(); map.addLayer({
    id: vhId(src), // level 4: the single representation of a failing road
    type: 'line',
    source: mapSourceId,
    ...SL,
    minzoom: src.minVisibleZoom || 0,
    layout: { 'line-cap': 'butt', 'line-join': 'round', visibility: 'none' },
    paint: {
      // No maxzoom and no pattern handover: this one layer carries level 4 at
      // every zoom. The gaps are genuinely transparent -- the main layer's
      // filter (visibleRoadCategoryFilter) never matches level 4 -- so the map
      // shows through, which is what makes it read as a dashed line rather than
      // a textured one. Width comes from FAIL_ROAD_WIDTH, not the shared road
      // width: the floor is what keeps the dash legible when zoomed out.
      'line-color': COLORS[4],
      'line-dasharray': FAIL_DASH,
      'line-width': FAIL_ROAD_WIDTH,
      'line-opacity': failBackgroundLineOpacity(),
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
        'line-dasharray': PROHIBITED_DASH,
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
        // centreline. It speaks the SAME dot language as the active route's
        // trail rendering (route-bike-trail-dots: [0.05, 2.1] under round
        // caps draws circles): the map and a drawn route must not disagree
        // about what an off-street trail looks like. The width floor is what
        // keeps the dots legible where the old fine dots vanished.
        'line-color': '#687d00',
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.3, 10, 1.8, 14, 2.4],
        'line-opacity': backgroundLineOpacity(0.95),
        'line-dasharray': [0.05, 2.1],
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
      minzoom: TAP_TARGET_MIN_ZOOM,
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
      minzoom: Math.max(TAP_TARGET_MIN_ZOOM, src.minVisibleZoom || 0),
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
    minzoom: Math.max(TAP_TARGET_MIN_ZOOM, src.minVisibleZoom || 0),
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
  if (src.ferryContext) {
    for (const id of [ferryContextCasingId(src), src.id, ferryContextLabelId(src)]) {
      if (map.getLayer(id)) setLayout(id, 'visibility', 'visible');
    }
    return;
  }
  if (src.closure) {
    for (const id of [src.id, src.id + '__line']) {
      if (map.getLayer(id)) setLayout(id, 'visibility', on ? 'visible' : 'none');
    }
    return;
  }
  if (map.getLayer(src.id)) setLayout(src.id, 'visibility', on ? 'visible' : 'none');
  if (src.id === 'routes') {
    // Neighbor states' mirrored ribbons follow the same Designated toggle.
    for (const id of visibleStateRouteRibbonIds()) {
      setLayout(id, 'visibility', on ? 'visible' : 'none');
    }
  }
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
  // Level 4 is the same dark red dash in BOTH display modes now, so this no
  // longer defers to the grey pass/fail dash. failId stops at level 3 for the
  // same reason: exactly one layer draws a failing road.
  if (map.getLayer(vhId(src)))
    setLayout(vhId(src), 'visibility', display.failRules ? 'visible' : 'none');
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
  if (src.ferryContext) {
    updateVisibility(src);
    return;
  }
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
    applyDesignatedRibbonPaint(src.id);
    for (const id of visibleStateRouteRibbonIds()) applyDesignatedRibbonPaint(id);
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
  // can follow the same major/secondary/tertiary/local zoom ladder as the
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
  const earlyBikeFacility = display.bikeFacilities ? bikeNetworkExpr(src) : ['boolean', false];
  const classMaskedOpacity = (verdictOpacity) => {
    if (!alignRoadClasses) return verdictOpacity;
    const visibleAtLocal = src.id === 'osm'
      ? ['any', ROAD_CLASS_MAJOR_EXPR, ROAD_CLASS_MEDIUM_EXPR,
        ROAD_CLASS_MINOR_EXPR, ROAD_CLASS_LOCAL_EXPR, OSM_TRAIL_EXPR]
      : ['any', ROAD_CLASS_MAJOR_EXPR, ROAD_CLASS_MEDIUM_EXPR,
        ROAD_CLASS_MINOR_EXPR, ROAD_CLASS_LOCAL_EXPR];
    // MapLibre permits zoom only as the input to a top-level step/interpolate.
    // Each output is therefore a feature-dependent class mask.
    return ['step', ['zoom'],
      0,
      BikeBasemap.ROAD_MIN_ZOOM.major,
      ['case', ROAD_CLASS_MAJOR_EXPR, verdictOpacity, 0],
      BikeBasemap.ROAD_MIN_ZOOM.medium,
      ['case',
        ['any', ROAD_CLASS_MAJOR_EXPR, ROAD_CLASS_MEDIUM_EXPR],
        verdictOpacity, 0],
      BikeBasemap.ROAD_MIN_ZOOM.minor,
      ['case',
        ['any', ROAD_CLASS_MAJOR_EXPR, ROAD_CLASS_MEDIUM_EXPR, ROAD_CLASS_MINOR_EXPR],
        verdictOpacity, 0],
      BIKE_FACILITY_MIN_ZOOM,
      ['case',
        ['any', earlyBikeFacility, ROAD_CLASS_MAJOR_EXPR, ROAD_CLASS_MEDIUM_EXPR,
          ROAD_CLASS_MINOR_EXPR],
        verdictOpacity, 0],
      BikeBasemap.ROAD_MIN_ZOOM.local,
      ['case', visibleAtLocal, verdictOpacity, 0],
    ];
  };
  const opacity = (value) => {
    // Opaque aligned fills remove alpha-addition seams. Their color expression
    // is pre-blended to retain the previous muted visual strength.
    const backgroundOpacity = alignRoadClasses ? 1 : backgroundLineOpacity(value);
    const verdictOpacity = alignRoadClasses ? 1
      : ['case', ['==', lvl, 3], cautionBackgroundLineOpacity(), backgroundOpacity];
    return classMaskedOpacity(verdictOpacity);
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
    setPaint(trailDotsId(src), 'line-color', display.passFail ? '#3f5200' : '#687d00');
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
  // The tap target follows trailBaseId, NOT the trails toggle. The neutral
  // ghost above already says a trail exists whether or not its lime colouring
  // is switched on, and the same rule has to reach the tap: with the toggle
  // off, this filter was `false`, so the layer was visible and matched nothing
  // and a tap on the Willamette Greenway Trail fell through to the generic
  // "point on map" card (field report). A toggle controls COLOURING, never
  // whether a way is there.
  if (map.getLayer(trailHitId(src))) setLayerFilter(trailHitId(src), and(OSM_TRAIL_EXPR));
  if (map.getLayer(failId(src))) {
    // Stops at 3: level 4 is the dark red dash on vhId, in either display mode.
    const failFilter = ['all', ['>=', lvl, display.passMax + 1], ['<=', lvl, 3]];
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
    // Not opaqueRoadColorExpr: that pre-blends over white to stop coincident
    // features stacking alpha into dark dots, and it costs this layer most of
    // its darkness. The dash has transparent gaps now, so there is far less ink
    // to stack, and reading as the strongest verdict matters more here.
    setPaint(vhId(src), 'line-color', COLORS[4]);
    setPaint(vhId(src), 'line-width', FAIL_ROAD_WIDTH);
    // Failures used to bypass the class mask used by every other road color.
    // That painted thousands of failing residential fragments at metro zoom,
    // visually merging into a solid red field and doing avoidable renderer
    // work. Keep the strong failure opacity, but reveal each road at the same
    // zoom as the basemap street beneath it.
    setPaint(vhId(src), 'line-opacity',
      classMaskedOpacity(failBackgroundLineOpacity()));
  }
  if (map.getLayer(prohibitedId(src))) {
    setPaint(prohibitedId(src), 'line-opacity', opacity(0.42));
  }
  // Texture overlay. It is decoration on the road below, so it takes the SAME
  // filter, the same width and the same class-masked opacity as the line it
  // sits on -- a flat opacity here made a failing freeway and a failing local
  // street fade at different zooms, because only one of them was masked.
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
      ROAD_CLASS_MAJOR_EXPR, ROAD_CLASS_MEDIUM_EXPR, ROAD_CLASS_MINOR_EXPR,
      ROAD_CLASS_LOCAL_EXPR];
    const classAlignedHitWidth = ['step', ['zoom'],
      0,
      BikeBasemap.ROAD_MIN_ZOOM.major,
      ['case', ROAD_CLASS_MAJOR_EXPR, 8, 0],
      BikeBasemap.ROAD_MIN_ZOOM.medium,
      ['case', ['any', ROAD_CLASS_MAJOR_EXPR, ROAD_CLASS_MEDIUM_EXPR], 10, 0],
      BikeBasemap.ROAD_MIN_ZOOM.minor,
      ['case',
        ['any', ROAD_CLASS_MAJOR_EXPR, ROAD_CLASS_MEDIUM_EXPR, ROAD_CLASS_MINOR_EXPR],
        11, 0],
      BIKE_FACILITY_MIN_ZOOM,
      ['case',
        ['any', earlyBikeFacility, ROAD_CLASS_MAJOR_EXPR, ROAD_CLASS_MEDIUM_EXPR,
          ROAD_CLASS_MINOR_EXPR],
        13, 0],
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
  const visible = (document.body.dataset.visibleMapStateIds || '')
    .split(',').filter((stateId) => stateId && stateId !== Region.id);
  syncVisibleStateSafetyLayers(visible, { force: true });
  // Covers a home region without its own routes overlay, where no ribbon
  // branch above repaints the mirrors on a display-mode flip.
  for (const id of visibleStateRouteRibbonIds()) applyDesignatedRibbonPaint(id);
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
    if (src.id === 'routes') syncRouteOverlayDisplay();
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


function setBackgroundUnpavedVisible(on) {
  display.unpavedBackground = !!on;
  const osm = SOURCES.find((src) => src.id === 'osm');
  if (osm && map.getLayer(backgroundUnpavedId(osm))) {
    setLayout(backgroundUnpavedId(osm), 'visibility',
      display.unpavedBackground ? 'visible' : 'none');
  }
  saveStateSoon();
}

/* --------------------------- the state's signed routes, by name */
// The overlay concatenates overlapping routes into one feature name
// ("10 (Washington) / 97 (Washington)"), so a FEATURE belongs to every route
// its name lists. Splitting here is what turns 166 features into a readable
// list of actual routes -- and what lets one route be Preferred without
// dragging along everything it briefly shares pavement with.
function routeOverlayNames(p) {
  const names = String(p?.n || '').split(' / ').map((part) => part.trim()).filter(Boolean);
  if (names.length) return names;
  return String(p?.r || '').split(/[;,]/).map((part) => part.trim()).filter(Boolean)
    .map((ref) => `Route ${ref}`);
}

/** A route the rider has switched this state's source off for. */
function routeOverlayHidden(feature) {
  const ids = suppressedRouteSourceIds();
  return ids.length > 0 && ids.includes(feature?.properties?.s);
}

// ONE place that turns the route overlay's data into what the map draws.
//
// Two rider choices rewrite the same collection: a Preferred route gets a
// modest opacity lift (`pr`) so it stays legible when it is not the active
// route, and a switched-off source is left out entirely. Applying those from
// two places means whichever ran last wins -- switching a source off and then
// marking a route Preferred would put the source back.
//
// `src.fc` keeps every feature: it is also the catalogue's backing data and
// what answers "which routes run under this tap". Only the copy handed to the
// map is filtered. This is display context only; the worker receives the
// actual route geometry separately below.
function routeOverlayDisplayData(src) {
  const preferred = new Set(preferredRouteNames());
  const features = [];
  for (const feature of src.fc.features || []) {
    feature.properties ||= {};
    feature.properties.pr = routeOverlayNames(feature.properties)
      .some((name) => preferred.has(name)) ? 1 : 0;
    if (routeOverlayHidden(feature)) continue;
    features.push(feature);
  }
  return { type: 'FeatureCollection', features };
}
function syncRouteOverlayDisplay() {
  const src = SOURCES.find((source) => source.id === 'routes');
  if (!src?.fc) return;
  const mapSource = map.getSource(src.id);
  if (mapSource?.setData) mapSource.setData(routeOverlayDisplayData(src));
}

// The signed routes running under a tapped point, from the overlay DATA
// rather than the rendered ribbon: the ribbon layer may be toggled off, and
// where a route follows a road the road above it wins the tap -- which is
// every practical tap on a route. This is what puts the Preferred checkbox
// on whichever card the tap actually opened.
function routeNamesNear(lngLat, toleranceM = 40) {
  const src = SOURCES.find((source) => source.id === 'routes');
  const names = [];
  if (!src?.fc) return names;
  const point = [Number(lngLat.lng), Number(lngLat.lat)];
  // A fixed radius, stated by each caller: the zoom-scaled radius this once
  // had served the retired tap-anywhere-near-the-route design, and is exactly
  // what dressed unrelated streets in a neighbouring route's controls.
  const kx = 111320 * Math.cos(point[1] * Math.PI / 180), ky = 111320;
  const segDistM = (a, b) => {
    const ax = (a[0] - point[0]) * kx, ay = (a[1] - point[1]) * ky;
    const bx = (b[0] - point[0]) * kx, by = (b[1] - point[1]) * ky;
    const dx = bx - ax, dy = by - ay;
    const spanSq = dx * dx + dy * dy;
    const t = spanSq ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / spanSq)) : 0;
    return Math.hypot(ax + t * dx, ay + t * dy);
  };
  for (const feature of src.fc.features || []) {
    // A switched-off source is not drawn and is not routed, so it must not
    // offer a Preferred checkbox on a tapped road either -- ticking it would
    // do nothing, because the worker no longer treats those edges as
    // designated.
    if (routeOverlayHidden(feature)) continue;
    const geometry = feature.geometry;
    const lines = geometry?.type === 'LineString' ? [geometry.coordinates]
      : geometry?.type === 'MultiLineString' ? geometry.coordinates : [];
    let near = false;
    for (const line of lines) {
      for (let i = 1; i < line.length && !near; i++) {
        near = segDistM(line[i - 1], line[i]) <= toleranceM;
      }
      if (near) break;
    }
    if (!near) continue;
    for (const name of routeOverlayNames(feature.properties)) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

// name -> { name, national, lines, lengthM } for every signed route in the
// loaded state, built once from the bikeroutes overlay. Both consumers -- the
// Settings → Routes list and the worker geometry sync -- read this one map.
let stateRouteCatalogPromise = null;
function ensureStateRouteCatalog() {
  if (stateRouteCatalogPromise) return stateRouteCatalogPromise;
  const src = SOURCES.find((source) => source.id === 'routes');
  if (!src) return Promise.resolve(new Map());
  stateRouteCatalogPromise = (async () => {
    // loadSource() returns immediately when a load is already in flight (the
    // startup load usually is), so wait on the source's own flags rather
    // than the call; a failed earlier load gets one retry per attempt here.
    const deadline = Date.now() + 20000;
    while (!src.fc && Date.now() < deadline) {
      if (!src.loading) {
        if (src.loaded) break; // loaded with no fc: nothing to read
        await loadSource(src);
      }
      if (!src.fc) await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!src.fc) {
      // Offline before first cache fill: allow a later retry instead of
      // pinning an empty catalog for the session.
      stateRouteCatalogPromise = null;
      return new Map();
    }
    const catalog = new Map();
    const sourceLabels = new Map((src.fc.routeSources || [])
      .map((source) => [source.id, source.label]));
    // New route packs carry a canonical catalogue. It is built from OSM plus
    // the small set of human-approved supplemental sources, with duplicates
    // already reconciled and full per-route geometry retained for Preferred
    // routing. Old packs keep using the feature-derived fallback below.
    if (Array.isArray(src.fc.routeCatalog)) {
      for (const route of src.fc.routeCatalog) {
        if (!route?.name || !Array.isArray(route.lines) || !route.lines.length) continue;
        const entry = {
          id: route.id || route.name,
          name: route.name,
          national: route.network === 'national',
          network: route.network || 'regional',
          sourceIds: Array.isArray(route.sourceIds) && route.sourceIds.length
            ? route.sourceIds.slice() : ['osm'],
          sourceLabels: [],
          lines: route.lines,
          lengthM: Number.isFinite(route.lengthM) ? route.lengthM : 0,
        };
        entry.sourceLabels = entry.sourceIds.map((id) => sourceLabels.get(id) || id);
        if (!(entry.lengthM > 0)) {
          for (const line of entry.lines) {
            for (let i = 1; i < line.length; i++) {
              entry.lengthM += markerSpanM(line[i - 1], line[i]);
            }
          }
        }
        catalog.set(entry.name, entry);
      }
      return catalog;
    }
    for (const feature of src.fc.features || []) {
      const geometry = feature.geometry;
      const lines = geometry?.type === 'LineString' ? [geometry.coordinates]
        : geometry?.type === 'MultiLineString' ? geometry.coordinates : [];
      if (!lines.length) continue;
      const p = feature.properties || {};
      for (const name of routeOverlayNames(p)) {
        let entry = catalog.get(name);
        if (!entry) catalog.set(name, entry = {
          id: `osm:${name}`, name, national: false, network: 'regional',
          sourceIds: ['osm'], sourceLabels: ['OSM routes'], lines: [], lengthM: 0,
        });
        if (p.t === 'ncn') entry.national = true;
        for (const line of lines) {
          entry.lines.push(line);
          for (let i = 1; i < line.length; i++) entry.lengthM += markerSpanM(line[i - 1], line[i]);
        }
      }
    }
    return catalog;
  })();
  return stateRouteCatalogPromise;
}

// Hand the worker the Preferred routes' geometry. The graph only knows an
// anonymous on-a-signed-route bit, so the worker matches these lines onto its
// own edges; rules.preferredRoutes (the key) makes every search signature
// honest about which selection priced it. postMessage order does the rest: a
// recompute posted after this sync always sees the new set.
let preferredRoutesAckRecompute = false;
// Resolves once the geometry message has actually been POSTED -- a caller
// that recomputes must await this, because the worker prices with whatever
// selection it has when the route request arrives, and a recompute posted
// first is priced against the OLD selection (field: toggling Preferred
// recalculated but nothing changed until the route was redone).
function syncPreferredRoutesToWorker({ recomputeOnAck = false } = {}) {
  if (!routing.worker) return Promise.resolve();
  const names = preferredRouteNames();
  const key = names.length ? preferredRoutesRuleKey(names) : '';
  if (!key) {
    routing.worker.postMessage({ type: 'preferred-routes', key: '', lines: [] });
    return Promise.resolve();
  }
  preferredRoutesAckRecompute = recomputeOnAck;
  return ensureStateRouteCatalog().then((catalog) => {
    const lines = [];
    for (const name of names) {
      const entry = catalog.get(name);
      if (entry) for (const line of entry.lines) lines.push(line);
    }
    routing.worker?.postMessage({ type: 'preferred-routes', key, lines });
  }).catch(() => {});
}

// Hand the worker the geometry of routes whose EVERY source is switched off,
// plus the geometry of everything still standing.
//
// Both halves matter. The graph stamps reviewed supplemental sources into the
// same designated-route bit OSM uses and records nothing about which source did
// it, so the worker re-derives the suppressed edges from linework -- and two
// catalogue entries can run down the same pavement, so it has to subtract the
// routes that survive. Measured: suppressing Island County matches 762 edges
// and 103 of them are also OSM-designated; Oregon's Scenic Bikeways matches
// 12,300 with 1,578 shared. Without the subtraction, switching off a county map
// would quietly un-designate roads OSM designates too.
let suppressedRoutesAckRecompute = false;
function syncSuppressedRoutesToWorker({ recomputeOnAck = false } = {}) {
  if (!routing.worker) return Promise.resolve();
  const ids = suppressedRouteSourceIds();
  const key = ids.slice().sort().join('\u0001');
  if (!key) {
    routing.worker.postMessage({ type: 'suppressed-routes', key: '', lines: [], keepLines: [] });
    return Promise.resolve();
  }
  suppressedRoutesAckRecompute = recomputeOnAck;
  return ensureStateRouteCatalog().then((catalog) => {
    const lines = [], keepLines = [];
    for (const entry of catalog.values()) {
      const sources = entry.sourceIds?.length ? entry.sourceIds : ['osm'];
      // Switched off only when NO surviving source still claims it. A route
      // carried by both OSM and a county map stays, whatever the county says.
      const gone = sources.every((id) => ids.includes(id));
      for (const line of (entry.lines || [])) (gone ? lines : keepLines).push(line);
    }
    routing.worker?.postMessage({ type: 'suppressed-routes', key, lines, keepLines });
  }).catch(() => {});
}

// Toggle one non-OSM route source. Route CHOICE changes and so does what the
// map draws, so this recomputes a live trip the same quiet way a rules change
// does.
function setRouteSourceSuppressed(id, suppressed) {
  if (id === 'osm') return false;
  const ids = new Set(suppressedRouteSourceIds());
  if (suppressed) ids.add(id); else ids.delete(id);
  if (ids.size) suppressedRouteSourcesByState[Region.id] = [...ids].sort();
  else delete suppressedRouteSourcesByState[Region.id];
  applySuppressedRouteSourcesRuleKey();
  syncRouteOverlayDisplay();
  saveStateSoon();
  const synced = syncSuppressedRoutesToWorker();
  if (deferSettingsRouteChange()) return true;
  if (routeEngineReady() && routing.start && routing.end) {
    routing.quietRecalcToast = true;
    showRouteActionToast('Updating routes…', { duration: 6000 });
    // AFTER the geometry message, for the same reason the Preferred toggle
    // waits: the worker prices with whatever set it holds when the request
    // arrives, so a recompute posted first is priced against the old one.
    synced.then(() => computeRoute({ revealPanel: false }));
  }
  return true;
}

// Toggle one route, from either entry path (the Routes screen or the tap
// card). Route CHOICE changes, so a live trip recomputes -- quietly, with the
// same unobtrusive toast a Settings rules change uses, because the rider is
// mid-dialog rather than watching the route panel.
function setRoutePreferred(name, on) {
  if (turnNav.active) {
    showRouteActionToast('Stop navigation before changing a preferred route.', {
      duration: 3200,
      answer: true,
    });
    return false;
  }
  const names = new Set(preferredRouteNames());
  if (on) names.add(name); else names.delete(name);
  if (names.size) preferredRoutesByState[Region.id] = [...names].sort();
  else delete preferredRoutesByState[Region.id];
  applyPreferredRoutesRuleKey();
  syncRouteOverlayDisplay();
  saveStateSoon();
  const synced = syncPreferredRoutesToWorker();
  if (deferSettingsRouteChange()) return true;
  if (routeEngineReady() && routing.start && routing.end) {
    routing.quietRecalcToast = true;
    showRouteActionToast('Updating routes…', { duration: 6000 });
    // AFTER the geometry message: the worker handles messages in order, so
    // this is what makes the recompute price the toggle just made.
    synced.then(() => computeRoute({ revealPanel: false }));
  }
  return true;
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
/* Automatic direct lens.
 *
 * Every ordinary portfolio gets one deliberately more-direct search in
 * addition to the normal safety-first searches. It scales subjective routing
 * multipliers in log space without changing the rider's rules, saved weights,
 * road verdicts, or colors. The 0.22 exponent turns the default 9× failing-road
 * wall into about 1.6×, strong enough to expose a genuinely different corridor
 * while still leaving a small safety preference.
 */
const DIRECT_LENS_EXPONENT = 0.22;
const DIRECT_LENS_SCALED_MULTIPLIERS = Object.freeze([
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
const DIRECT_LENS_SCALED_RATES = Object.freeze(['speedOverBalanced', 'speedOverLowStress',
  'speedBelowDirect', 'speedBelowBalanced', 'speedBelowLowStress']);
function directLensRoutingWeights() {
  const k = DIRECT_LENS_EXPONENT;
  const weights = { ...routingWeights };
  // Same bounds validRoutingWeights enforces on rider input, so a lens over an
  // already-extreme tuned weight cannot leave the worker's sane range.
  const bound = (value) => Math.min(120, Math.max(0.1, value));
  for (const key of DIRECT_LENS_SCALED_MULTIPLIERS) {
    if (Number.isFinite(weights[key])) weights[key] = +bound(Math.pow(weights[key], k)).toFixed(4);
  }
  for (const key of DIRECT_LENS_SCALED_RATES) {
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
  startStateId: null, endStateId: null,
  startDefaultsToDevice: true,
  vias: [],                  // ordered stops: { pt: [lng,lat], name, marker }
  blocks: [],                // avoided road locations: { pt: [lng,lat], marker }
  startMarker: null, endMarker: null,
  worker: null, ready: false, loading: false, pendingRoute: false, routeRequestActive: false,
  restoringRoute: false, pendingPanelReveal: false,
  // True while a recompute runs with the route sheet hidden behind Settings:
  // progress and completion then speak through the shared toast.
  quietRecalcToast: false,
  loadedGraphVersion: null, // sha of the graph bytes the router actually has
  mode: ['direct', 'balanced', 'low'].includes(savedState?.mode)
    ? savedState.mode : 'balanced', // 'direct' | 'balanced' | 'low'
  profileId: validRouteProfileId(savedState?.profileId)
    ? savedState.profileId : legacyRouteProfile(savedState?.mode),
  prefDesig: savedState && typeof savedState.prefDesig === 'boolean'
    ? savedState.prefDesig : DEFAULT_ROUTE_PREFERENCES.prefDesig, // force this preference across every route option
  prefResidential: savedState && typeof savedState.prefResidential === 'boolean'
    ? savedState.prefResidential : DEFAULT_ROUTE_PREFERENCES.prefResidential,
  reqId: 0,
  compareStartedAt: 0,
  selectRecommendedNext: false,
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

let routerCacheTrimTimer = null;
let routerCacheTrimId = 0;
function trimRouterCachesSoon(delay = 0) {
  // The home worker may be released entirely while a partition session owns
  // routing (releaseHomeRouterForPartitionSession); the session's own router
  // still deserves its trims — it holds the composite plus the same caches.
  const bridgeRouter = () => (routing.multiStateActive
    ? activeMultiStateRouting.bridge?.router : null);
  if (!isConstrainedDevice() || (!(routing.worker && routing.ready) && !bridgeRouter())
      || routing.loading || routing.pendingRoute || routing.routeRequestActive) return;
  clearTimeout(routerCacheTrimTimer);
  routerCacheTrimTimer = setTimeout(() => {
    routerCacheTrimTimer = null;
    if (routing.loading || routing.pendingRoute || routing.routeRequestActive) return;
    if (routing.worker && routing.ready) {
      routing.worker.postMessage({ type: 'trim-caches', id: ++routerCacheTrimId });
    }
    // The partition session's router holds the same full-size graph plus its
    // own caches; a finished cross-state portfolio must not keep them warm
    // while the renderer is at its hungriest.
    bridgeRouter()?.postMessage({ type: 'trim-caches', id: ++routerCacheTrimId });
  }, Math.max(0, Number(delay) || 0));
}

// Two sinks: the screen-reader live region always hears the message; the
// route bar's visible span shows it unless the caller says the calculation
// banner is already narrating (bar: false also clears a stale notice, so
// the banner takes over cleanly).
function setRouteStatus(t, { bar = true } = {}) {
  const live = document.getElementById('route-status');
  if (live) live.textContent = t;
  const span = document.getElementById('rb-status');
  if (span) span.textContent = bar ? t : '';
}

let routeActionToastTimer = null;
// An ANSWER the rider asked for holds this toast against background chatter.
//
// One toast is shared by everything that narrates: route calculation phases,
// the routing engine loading, and the results of things the rider clicked. A
// rider who tapped "check for updates" during startup got their answer for
// 170 ms and then "Loading routing engine" on top of it -- measured, and the
// reason a test asserting the answer reached the toast failed whenever the box
// was loaded enough for startup to still be talking.
//
// So a reply marks itself, and ambient progress messages yield to it for a
// couple of seconds. They keep updating the status line and the progress bar;
// they simply do not overwrite an answer with a status nobody asked for.
const ANSWER_HOLD_MS = 2600;
let routeActionAnswerUntil = 0;
function showRouteActionToast(text, { busy = false, detail = '', duration = 2200,
  progress = null, answer = false } = {}) {
  const toast = document.getElementById('routeActionToast');
  const label = document.getElementById('routeActionText');
  const detailLabel = document.getElementById('routeActionDetail');
  if (!toast || !label || !detailLabel) return;
  if (!answer && Date.now() < routeActionAnswerUntil) return;
  routeActionAnswerUntil = answer ? Date.now() + ANSWER_HOLD_MS : 0;
  clearTimeout(routeActionToastTimer);
  label.textContent = text || '';
  detailLabel.textContent = detail || '';
  detailLabel.hidden = !detail;
  // The percentage bar rides in the same toast the phase text uses, so the
  // rider sees one notice, not two. Only the route calculation supplies a
  // fraction; every other caller leaves the bar hidden.
  const bar = document.getElementById('routeActionProgress');
  const showBar = typeof progress === 'number' && progress >= 0;
  if (bar) {
    bar.hidden = !showBar;
    if (showBar) {
      const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
      const fill = document.getElementById('routeActionProgressFill');
      if (fill) fill.style.width = `${pct}%`;
      const pctLabel = document.getElementById('routeActionProgressPct');
      if (pctLabel) pctLabel.textContent = `${pct}%`;
    }
  }
  toast.classList.toggle('busy', busy);
  toast.classList.toggle('has-detail', !!detail || showBar);
  // While the bar shows, the toast keeps ONE size: phase messages wrap to
  // one line or two, and letting the box grow and shrink with each message
  // made the whole dialog jitter through a calculation.
  toast.classList.toggle('has-progress', showBar);
  toast.hidden = !text;
  if (text && duration > 0) routeActionToastTimer = setTimeout(() => { toast.hidden = true; }, duration);
}

// A compute that is working and one that is stuck look identical once the
// current phase message stops changing. The banner carries its own clock:
// past 90 seconds the detail line gains a climbing elapsed marker,
// re-rendered every 15 seconds even when no new progress message arrives,
// so a long search reads as "still at it" rather than frozen.
const CALC_ELAPSED_NOTE_MS = 90000;
let calcShownAt = 0;
let calcElapsedTimer = null;
let calcLastDetail = '';
function calcElapsedSuffix() {
  const elapsed = Date.now() - calcShownAt;
  if (!calcShownAt || elapsed < CALC_ELAPSED_NOTE_MS) return '';
  return ` · working for ${Math.max(1, Math.round(elapsed / 60000))} min`;
}

function showRouteCalculationStatus(title = 'Calculating route options', detail = '', progress = null) {
  const tab = document.getElementById('tab-route');
  const status = document.getElementById('routeCalculationStatus');
  const titleLabel = document.getElementById('routeCalculationTitle');
  const detailLabel = document.getElementById('routeCalculationDetail');
  if (!tab || !status || !titleLabel || !detailLabel) return;
  if (!calcShownAt) {
    calcShownAt = Date.now();
    clearInterval(calcElapsedTimer);
    calcElapsedTimer = setInterval(() => {
      if (!calcShownAt) return;
      const label = document.getElementById('routeCalculationDetail');
      if (label) label.textContent = calcLastDetail + calcElapsedSuffix();
    }, 15000);
  }
  titleLabel.textContent = title;
  calcLastDetail = detail || 'Comparing safer, quicker, and bike-friendly routes…';
  detailLabel.textContent = calcLastDetail + calcElapsedSuffix();
  const bar = document.getElementById('routeCalculationProgress');
  const fill = document.getElementById('routeCalculationProgressFill');
  const showBar = typeof progress === 'number' && progress >= 0;
  if (bar) bar.hidden = !showBar;
  if (showBar && fill) {
    fill.style.width = `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
  }
  status.hidden = false;
  tab.classList.add('route-calculating');
  scheduleMobileNavDockAfterInit();
}

function hideRouteCalculationStatus() {
  calcShownAt = 0;
  clearInterval(calcElapsedTimer);
  calcElapsedTimer = null;
  document.getElementById('tab-route')?.classList.remove('route-calculating');
  const status = document.getElementById('routeCalculationStatus');
  if (status) status.hidden = true;
  scheduleMobileNavDockAfterInit();
}

// computeRoute() can run synchronously while a restored trip is being built,
// before the phone-panel constants later in this script have initialized.
// Deferring the panel/layout work also lets the search sheet finish closing
// before the Route sheet opens and the map measures its final height.
function scheduleMobileNavDockAfterInit() {
  queueMicrotask(() => {
    if (typeof scheduleMobileNavDock === 'function') scheduleMobileNavDock();
  });
}

function fitItineraryForCalculation() {
  const points = [routing.start, ...routing.vias.map((via) => via.pt), routing.end]
    .filter((point) => Array.isArray(point) && point.length >= 2
      && Number.isFinite(point[0]) && Number.isFinite(point[1]));
  if (points.length < 2 || !map) return;
  const fit = () => {
    const onPhone = window.matchMedia('(max-width: 720px)').matches;
    const panelRect = document.getElementById('panel')?.getBoundingClientRect();
    const routeBarRect = document.getElementById('routeBar')?.getBoundingClientRect();
    const panelHeight = onPhone && document.body.classList.contains('panel-open')
      ? Math.ceil(panelRect?.height || 0) : 0;
    // The itinerary bar is deliberately wider/taller on a phone. Measure it:
    // a fixed top inset put the northern pin underneath that bar on longer
    // trips even though MapLibre correctly considered it "inside" the map.
    const topPadding = Math.max(onPhone ? 105 : 80,
      Math.ceil(routeBarRect?.bottom || 0) + 24);
    const bounds = new maplibregl.LngLatBounds(points[0], points[0]);
    for (const point of points.slice(1)) bounds.extend(point);
    map.fitBounds(bounds, {
      padding: onPhone
        ? { top: topPadding, right: 42, bottom: Math.max(95, panelHeight + 42), left: 42 }
        : { top: topPadding, right: 70, bottom: 80,
          left: Math.max(470, Math.ceil(panelRect?.right || 0) + 28) },
      maxZoom: 14,
      // An animated city-to-region zoom allocates intermediate tile
      // generations at the same moment iOS is expanding the routing graph.
      // Jump directly to the final frame there; desktop keeps the smooth fit.
      duration: constrainedMapRuntime ? 0 : 550,
    });
  };
  requestAnimationFrame(() => requestAnimationFrame(fit));
}

function revealRouteCalculation() {
  // Never pull the map or controls away from an active navigation session.
  if (turnNav.active) return;
  queueMicrotask(() => {
    selectPanelTab('route');
    setPanelOpen(true);
    fitItineraryForCalculation();
  });
}

function showRouterProgress(detail, title = 'Loading routing engine', progress = null) {
  const calculating = routing.start && routing.end
    && (routing.pendingRoute || routing.routeRequestActive);
  // The calculation banner narrates this stream; the route bar's span must
  // not echo the same phase text beside it (desktop showed both at once).
  setRouteStatus(detail || title, { bar: !calculating });
  if (calculating) {
    showRouteCalculationStatus(title, detail, progress);
    // A previous short-lived notice must not sit over the calculation sheet --
    // except during a quiet (settings-held) recompute, where the calc sheet is
    // hidden behind Settings and the "Updating routes…" pill IS the status, so
    // it rides out the progress stream untouched.
    if (!routing.quietRecalcToast) showRouteActionToast('');
  } else {
    showRouteActionToast(title, { busy: true, detail, duration: 0, progress });
  }
  // On a first install the routing data is the long wait, and on iOS it can
  // overlap the launch screen -- which then sat on a generic message with
  // nothing to say. This no-ops once the app has taken over the screen.
  //
  // A route COMPUTE is different: a relaunch with a saved trip starts its
  // recompute as soon as the camera settles, and on a phone that can be
  // before the map's first load event -- so corridor-search progress played
  // on the launch screen and the whole app stayed hidden behind a route it
  // had not been asked to show (field report, 2026-08-25). The map is
  // already drawing and the calculation banner narrates the same stream:
  // hand the screen over instead of narrating on the splash.
  if (calculating) window.__dismissAppLaunchScreen?.();
  else window.__setAppLaunchStatus?.(detail || title);
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

// A pocket re-snap moved a tapped endpoint off a spot bikes can leave but
// never enter (a ramp, a downhill-only trail): say where the trip really
// starts or ends, in the same voice as the snap-distance note above.
function notifyPocketSnaps(snapNotes) {
  if (!Array.isArray(snapNotes) || !snapNotes.length) return;
  const notes = snapNotes.map((note) => `${note.last ? 'Destination' : 'Start'} `
    + `moved ${fmtDist(Math.max(1, note.movedM))} — the tapped spot is `
    + `${note.last ? 'exit-only' : 'entry-only'} by bike`);
  showRouteActionToast(`⚠ ${notes.join(' · ')}`, { duration: 6500 });
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
  routing.pendingPanelReveal = false;
  routing.routeRequestActive = false;
  if (routing.worker) routing.worker.terminate();
  routing.worker = null;
  setRouteOptionsLoading(false);
  updateArmButtons();
  if (routeWasRequested) {
    routing.options = [];
    clearCandidatePortfolio();
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
  // A state whose folder has no graph cannot route, and it never will by
  // retrying: there is nothing at the URL. Say so once, plainly, instead of
  // downloading a 404 and reporting it as a connection problem.
  if (!Region.datasets.graph) {
    setRouteStatus(`${Region.name} has no routing map yet. `
      + 'Search and browse work; pick another state on the Maps screen to plan a ride.');
    return;
  }
  // A graph bigger than the device budget never loads in one piece — trips
  // in this state route through the partition session instead (computeRoute
  // branches there), so there is nothing for the monolithic worker to do.
  // Guards the desktop background prewarm as well as direct calls.
  if (homeGraphExceedsDeviceBudget()) return;
  routing.loading = true;
  // Endpoint editing is safe while the graph initializes: computeRoute()
  // records a pending request and runs it once the worker reports ready. Keep
  // the planner download from making a fresh native install look unresponsive.
  updateArmButtons();
  try {
    showRouterProgress(`Downloading ${Region.name} roads, trails, ferries, and elevation data…`);
    await purgeStaleGraphCache();
    // The worker starts before the bytes arrive so it is warm when they do, and
    // so the ~94 MB the gzip container expands to is allocated and inflated
    // over there. Doing that here used to lock the UI thread for seconds during
    // startup -- the exact window in which a rider taps the search box.
    routing.worker = new Worker('router-worker.js');
    // Before anything can allocate: a phone's startup computes the saved trip
    // while the map renderer is also at its hungriest, and the worker's full
    // cache complement tipped WebKit into killing the page over and over
    // ("a problem repeatedly occurred"). Capped caches re-derive instead.
    if (isConstrainedDevice()) routing.worker.postMessage({ type: 'configure', constrained: true });
    routing.worker.onmessage = onRouterMessage;
    routing.worker.onerror = (event) => {
      event.preventDefault?.();
      handleRouterFailure(event.message || 'routing worker stopped');
    };
    routing.worker.onmessageerror = () => handleRouterFailure('routing worker sent unreadable data');
    // A partition session can release this worker while the graph bytes are
    // still downloading (releaseHomeRouterForPartitionSession). That is a
    // deliberate hand-off, not a failure: abandon quietly and let the next
    // single-state request start a fresh load.
    const startedWorker = routing.worker;
    const res = await fetch(GRAPH_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = await readRoutingGraphResponse(res);
    if (routing.worker !== startedWorker) return;
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
    routing.worker.postMessage({ type: 'graph', buffer: buf,
      stateIds: [Region.id] }, [buf]);
  } catch (e) {
    handleRouterFailure(`routing data could not load: ${e.message}`);
  }
}

let routerMapSettleTimer = null;
let routerMapSettlePending = false;
function ensureRouterAfterMapSettles() {
  if (!constrainedMapRuntime) {
    ensureRouter();
    return;
  }
  if (routing.ready || routing.loading || routerMapSettlePending) return;
  routerMapSettlePending = true;
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    clearTimeout(routerMapSettleTimer);
    routerMapSettleTimer = null;
    routerMapSettlePending = false;
    // The rider may clear a point while the camera is settling. In that case
    // keep the graph unloaded until a complete trip is requested again.
    if (!routing.start || !routing.end) return;
    ensureRouter();
  };
  // fitItineraryForCalculation() queued its fit just before this helper. Arm
  // the idle listener after that same two-frame boundary so an already-idle
  // map cannot start the graph in the tiny gap before the fit begins.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    map.once('idle', start);
    // The timeout keeps an unusually slow tile source from blocking routing
    // indefinitely.
    routerMapSettleTimer = setTimeout(start, 1800);
  }));
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
    stateId: s.stateId || (typeof Region !== 'undefined' ? Region.id : null),
    partitionId: s.partitionId || null,
    localEdgeIndex: Number.isInteger(s.localEdgeIndex) ? s.localEdgeIndex : null,
    shBack: Number.isFinite(Number(s.shBack)) ? Number(s.shBack) : null,
    e: flags & 1 ? 1 : 0, fac: flags & 2 ? 1 : 0, fw: flags & 4 ? 1 : 0,
    lim: flags & 128 ? 1 : 0,
    hazard: s.hazard || 0, gradePct: s.gradePct || 0, crossing: s.crossing ? 1 : 0,
    lanes: s.lanes || 0, ctl: s.centerTurnLane ? 1 : 0, lts: s.lts || 0,
    ow: flags & 16 ? 1 : 0,
    infra: flags & 8 ? 1 : 0, ferry: flags & 32 ? 1 : 0, desig: flags & 64 ? 1 : 0,
    facility: s.facility || 0,
    // The other direction's facility, same contract as shBack: a lane on one
    // side of a two-way street belongs to one direction of travel, and the
    // card says so instead of contradicting what the rider sees.
    facilityOther: Number.isFinite(Number(s.facilityOther)) ? Number(s.facilityOther) : null,
    official: s.official || 0, mtb: s.mtb ? 1 : 0,
    dismount: isDismountSegment(s) ? 1 : 0,
    dismountEscalated: s.dismountEscalated ? 1 : 0,
    facilityGap: s.facilityGap ? 1 : 0,
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
function fallbackRouteLevel(s) {
  // The worker can only identify a long continuous tagged-dismount run after
  // assembling the route. Preserve that explicit structural fact, not an
  // otherwise opaque and potentially stale stored level byte.
  if (s?.dismountEscalated) return 4;
  const level = effectiveLevel(scoreRouteSeg(routeSegProps(s)));
  return s?.facilityGap && level < 3 ? 3 : level;
}

// Preserve WHY a route segment is amber, not only the amber level. Route
// Details uses this to guarantee that every caution rendered on the route has
// a matching item under Concerns. New worker payloads provide the exact cause;
// the evaluation keeps older payloads useful.
function routeSegmentCautionCause(s) {
  if (s?.facilityGap && fallbackRouteLevel(s) === 3) return 'facility-gap';
  const verdict = evaluateRoad(scoreRouteSeg(routeSegProps(s)));
  if (verdict.level === 3 && verdict.caution) return verdict.caution;
  if (s?.mtb) return 'mountain-bike';
  return routeSegmentDisplayCategory(s) === 'caution' ? 'other' : null;
}

function isHighwaySegment(s) {
  const flags = s.flags || 0;
  return !(flags & (4 | 8 | 32)) && (s.mph >= 45 || stateHighwayName(s.name, s.stateId));
}

function routeSegmentDisplayCategory(s) {
  // A stored worker byte is a cache, not truth. Re-evaluate the segment facts
  // under the rider's live rules so the route line, summary, voice and Details
  // cannot inherit a stale verdict from an older build or saved route.
  const level = fallbackRouteLevel(s);
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
    const level = fallbackRouteLevel(s);
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

// Give each lettered choice one plain-language reason to exist, using the
// recommended option as the reference point. The worker's `aggression` value
// is the same normalized stress measure used to compare route candidates; the
// fallback keeps old/shared routes useful when that newer field is absent.
function routeStressIndex(route) {
  const workerValue = route?.aggression;
  const workerIndex = Number(workerValue);
  if (workerValue != null && Number.isFinite(workerIndex)) return workerIndex;
  const stats = routeSummaryStats(route);
  const ridingM = Math.max(1,
    ROUTE_CATEGORY_KEYS.reduce((sum, key) => sum + stats.categoryM[key], 0));
  return (stats.categoryM.pass * 0.18 + stats.categoryM.caution * 0.75
    + stats.categoryM.fail * 3.5 - stats.categoryM.trail * 0.12
    - stats.categoryM.bike * 0.08) / ridingM;
}

function routeRelationship(route) {
  const options = (routing.options || []).filter((option) => option?.ok);
  const suggested = options.find((option) => option.optimization?.recommended);
  if (!suggested || route === suggested || route?.optimization?.recommended) {
    return { label: 'Suggested', description: 'Suggested route' };
  }

  // Ignore block-end and rounding noise. On a long trip, half a percent is
  // still a useful human-scale distinction; on a short trip, require 50 m.
  const distanceThresholdM = Math.max(50, Number(suggested.distM || 0) * 0.005);
  const distanceDeltaM = Number(route?.distM || 0) - Number(suggested.distM || 0);
  if (distanceDeltaM < -distanceThresholdM) {
    return { label: 'Shorter', description: 'Shorter than the Suggested route' };
  }

  // Roughly two hundredths of the normalized stress scale is enough to
  // describe a route as meaningfully lower-stress without promoting tiny
  // data noise.
  if (routeStressIndex(route) < routeStressIndex(suggested) - 0.02) {
    return { label: 'Lower Stress', description: 'Lower stress than the Suggested route' };
  }
  if (distanceDeltaM > distanceThresholdM) {
    return { label: 'Longer', description: 'Longer than the Suggested route' };
  }
  return { label: 'Alternative', description: 'An alternative to the Suggested route' };
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
  const lens = optimization.directLens
    ? ' Found with a more-direct search; safety results still use your settings.'
    : '';
  const progress = optimization.forwardProgress
    ? ' Found by avoiding a large backtrack away from the destination; safety results still use your settings.'
    : '';
  const matching = optimization.fullyMatchingRules
    ? ' Every segment matches your safety rules.' : '';
  return `${optimization.reason ? `${optimization.reason} ` : ''}${method}${discovery}${lens}${progress}${matching}`;
}
function optimizationMethodDescription(optimization) {
  if (optimization.sectionFrontier) {
    return 'Combines strong sections already found at exact shared road junctions, '
      + 'favoring safety while keeping time, distance, hills, and surface practical.';
  }
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
  // The navigation card rebuilds its chart on every GPS fix; compacting the
  // full per-coordinate profile each time allocated a fresh ~1200-entry array
  // per fix for the whole ride. The route object is immutable once received —
  // cache the compaction on it.
  if (m._compactProfile && m._compactProfileFrom === profile) return m._compactProfile;
  const stride = Math.max(1, Math.ceil(profile.length / 1200));
  const out = [];
  for (let i = 0; i < profile.length; i += stride) {
    out.push([Math.round(profile[i][0]), Math.round(profile[i][1])]);
  }
  const last = profile[profile.length - 1];
  if (out[out.length - 1][0] !== Math.round(last[0])) {
    out.push([Math.round(last[0]), Math.round(last[1])]);
  }
  m._compactProfile = out;
  m._compactProfileFrom = profile;
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

function routeDependencyMetadata(route) {
  if (route?.routeDependencies) return route.routeDependencies;
  const stateIds = Array.isArray(route?.stateIds) && route.stateIds.length
    ? route.stateIds : [Region.id];
  return {
    states: stateIds.map((stateId) => {
      const state = routeStateConfig(stateId) || Region;
      return { stateId, graphVersion: state?.versions?.graph || null };
    }),
    partitions: [],
  };
}

async function createInstalledMultiStateRouteSession({ routeStateIds, resolveStateId,
  onProgress = () => {}, budgetBytes = MultiStateRouting.MAX_DETAILED_GRAPH_INPUT_BYTES } = {}) {
  const context = await MapStore.routingContext(routeStateIds);
  const bridge = new MultiStateRouteCoordinator.BrowserPartitionRouteBridge({
    catalogue: context.catalogue, baseUrl: context.baseUrl, budgetBytes, onProgress,
    constrained: isConstrainedDevice(),
  });
  const session = new MultiStateRouteCoordinator.MultiStateRouteSession({
    catalogue: context.catalogue,
    catalogueIdentity: context.catalogueIdentity,
    installedStateIds: context.installedStateIds,
    resolveStateId,
    budgetBytes,
    onProgress,
    loadComposite: bridge.loadComposite.bind(bridge),
    search: bridge.search.bind(bridge),
    retainActiveRoute: bridge.retainActiveRoute.bind(bridge),
    cancel: bridge.cancel.bind(bridge),
  });
  return { session, bridge, context };
}

const activeMultiStateRouting = {
  key: null, session: null, bridge: null, context: null, creating: null,
};

function orderedRoutePointStateIds() {
  return [routing.startStateId || Region.id,
    ...routing.vias.map((via) => via.stateId || Region.id),
    routing.endStateId || Region.id];
}

function needsMultiStateRouting() {
  return orderedRoutePointStateIds().some((stateId) => stateId !== Region.id);
}

// The largest single graph allocation this device may hold — one number with
// one meaning, governing both the composite admission ceiling and whether the
// home state's monolithic graph is loadable at all. The native shell (which
// knows the physical device) or a test can lower it via the override; the
// web default is the contract ceiling, which the released Washington graph
// meets exactly.
function deviceRoutingBudgetBytes() {
  const override = Number(window.JRA_ROUTING_BUDGET_BYTES);
  if (Number.isFinite(override) && override > 0) return override;
  return MultiStateRouting.MAX_DETAILED_GRAPH_INPUT_BYTES;
}

// A state whose full graph exceeds the device budget cannot use the
// monolithic home worker — California-scale graphs never fit a phone in one
// piece. Its own trips route through the partition session, which admits a
// corridor under the same budget. States imported before graphRawBytes was
// recorded keep the monolith path.
function homeGraphExceedsDeviceBudget() {
  const rawBytes = Number(Region.graphRawBytes);
  return Number.isFinite(rawBytes) && rawBytes > deviceRoutingBudgetBytes();
}

function routingRequiresPartitionSession() {
  return needsMultiStateRouting() || homeGraphExceedsDeviceBudget();
}

// "Can a settings change recompute the current trip right now?" On a
// cross-state trip the partition session is the engine; routing.ready only
// describes the home worker, which a phone may never have loaded (or has
// released for the session). Gating recomputes on routing.ready alone made
// rules changes silently keep a stale multi-state portfolio.
function routeEngineReady() {
  return routing.ready || (routing.multiStateActive && !!activeMultiStateRouting.bridge);
}

function stateNames(stateIds) {
  return [...new Set(stateIds || [])].map((stateId) => placeStateConfig(stateId)?.name || stateId);
}

async function installedMultiStateRouteSession(routeStateIds) {
  const ids = [...new Set(routeStateIds)].sort((a, b) => a.localeCompare(b));
  const acquisition = MapStore.routingAcquisitionForStates(ids);
  if (!acquisition.available) {
    const error = new Error(acquisition.reason || 'Required routing maps are unavailable.');
    error.code = 'routing-acquisition-unavailable';
    error.detail = acquisition;
    throw error;
  }
  const key = `${acquisition.compatibility.catalogueSha256}|${ids.join('|')}`;
  if (activeMultiStateRouting.key === key && activeMultiStateRouting.session) {
    activeMultiStateRouting.session.setInstalledStateIds(MapStore.installedStateIds());
    return activeMultiStateRouting;
  }
  activeMultiStateRouting.session?.cancel();
  activeMultiStateRouting.key = key;
  const creating = createInstalledMultiStateRouteSession({
    routeStateIds: ids,
    budgetBytes: deviceRoutingBudgetBytes(),
    resolveStateId: async (point) => placeStateIdAt(point[0], point[1]),
    onProgress: (progress) => {
      const names = stateNames(progress.routeStateIds || ids).join(' and ');
      const phase = progress.phase === 'expanding' ? 'Checking another route area'
        : progress.type === 'partition-progress' ? 'Loading route data'
          : progress.type === 'progress' ? (progress.detail || 'Calculating route')
            : 'Preparing route maps';
      const detail = progress.type === 'progress' && progress.detail
        ? `${progress.detail} (${names})` : `${phase} for ${names}…`;
      showRouterProgress(detail, progress.type === 'progress'
        ? 'Calculating multi-state route' : 'Preparing multi-state route',
      Number.isFinite(progress.frac) ? progress.frac : null);
    },
  });
  activeMultiStateRouting.creating = creating;
  const created = await creating;
  if (activeMultiStateRouting.creating !== creating || activeMultiStateRouting.key !== key) {
    created.session.cancel();
    throw new DOMException('Route request was cancelled.', 'AbortError');
  }
  Object.assign(activeMultiStateRouting, created, { key, creating: null });
  return activeMultiStateRouting;
}

function multiStateWorkerRequest(type, id, points) {
  const selected = routing.last?.optimization;
  if (type === 'route') {
    return {
      type, id, points, rules: { ...rules },
      blocks: routing.blocks?.map(routeBlockPayload) || [],
      mode: selected?.mode || routing.mode,
      profileId: selected?.profileId || routing.profileId,
      profileLabel: selected?.label,
      prefDesignated: routing.prefDesig || !!selected?.prefDesignated,
      prefResidential: routing.prefResidential || !!selected?.prefResidential,
      weights: { ...routingWeights },
    };
  }
  const rec = routing.sharedActive ? routing.sharedRecipe : null;
  return {
    type, id, points, blocks: routing.blocks?.map(routeBlockPayload) || [],
    rules: { ...(rec?.rules || rules) },
    forceDesignated: rec ? !!rec.prefDesig : routing.prefDesig,
    forceResidential: rec ? !!rec.prefResidential : routing.prefResidential,
    preferredProfileId: rec ? (rec.profileId || routing.profileId) : routing.profileId,
    weights: rec?.weights ? { ...rec.weights } : { ...routingWeights },
    directProbeWeights: rec ? null : directLensRoutingWeights(),
  };
}

async function promptForRequiredRouteStates(result) {
  const required = [...new Set(result.requiredStateIds || [])];
  if (!required.length) return;
  const names = stateNames(required);
  const routeNames = stateNames(result.routeStateIds?.length
    ? result.routeStateIds : required);
  const message = `Required for this trip: ${names.join(', ')}. This route passes through ${routeNames.join(' and ')}.`;
  setRouteStatus(message);
  showRouteActionToast(message, { answer: true, duration: 8000 });
  saveStateSoon();
  saveStateNow();
  try {
    localStorage.setItem(PENDING_MAP_ROUTE_INTENT_KEY, JSON.stringify({
      version: 1, createdAt: Date.now(), action: 'resume-route',
      stateId: required[0], requiredStateIds: required,
    }));
  } catch (error) { return; }
  await openNationalStateCard(required[0]);
}

// A phone cannot hold two statewide graphs. Once a partition session owns
// routing, the idle home worker's graph (~142 MB expanded, plus derived
// arrays) is the single largest reclaimable allocation in the page, and
// keeping it warm "for the return trip" left every cross-state calculation
// running beside it. Terminate the worker outright: ensureRouter() rebuilds
// it lazily the next time a single-state route asks, with its normal
// progress copy, and the ready handler re-sends preferred/suppressed routes
// and the pending request. Desktop keeps the warm worker.
function releaseHomeRouterForPartitionSession() {
  if (!isConstrainedDevice() || !routing.worker) return;
  routing.worker.terminate();
  routing.worker = null;
  routing.ready = false;
  routing.loading = false;
}

let multiStateSettleDeferred = false;
async function computeMultiStateRoute({ revealPanel = !routing.restoringRoute } = {}) {
  // Relaunch with a saved cross-state trip: the composite load (catalogue,
  // partitions, compose) must not run inside the launch camera's tile burst —
  // that pairing is the same WebKit kill the single-state path already defers
  // around via the ready handler's idle wait. First call on a constrained
  // device with an unsettled map waits for idle (8 s stop) and re-enters.
  if (isConstrainedDevice() && typeof map?.loaded === 'function' && !map.loaded()
      && !turnNav.active && !multiStateSettleDeferred) {
    multiStateSettleDeferred = true;
    setRouteStatus('Preparing multi-state route…');
    setRouteOptionsLoading(true);
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      computeRoute({ revealPanel });
    };
    map.once('idle', start);
    setTimeout(start, 8000);
    return;
  }
  const shouldRevealPanel = Boolean(revealPanel) && !turnNav.active;
  routing.pendingRoute = false;
  routing.pendingPanelReveal = false;
  routing.routeRequestActive = true;
  const requestId = ++routing.reqId;
  // The home worker idles under the partition session but keeps its graph for
  // the return trip; on a phone its cache complement must not stay warm while
  // a second full-size composite loads beside it.
  if (isConstrainedDevice()) {
    routing.worker?.postMessage({ type: 'trim-caches', id: ++routerCacheTrimId });
  }
  setRouteStatus('Preparing multi-state route…');
  setRouteOptionsLoading(true);
  if (shouldRevealPanel) {
    revealRouteCalculation();
    showRouteCalculationStatus('Preparing multi-state route',
      `Loading only the route maps needed through ${stateNames(orderedRoutePointStateIds()).join(' and ')}…`);
  }
  saveStateSoon();
  const points = [routing.start, ...routing.vias.map((via) => via.pt), routing.end];
  const pointStateIds = orderedRoutePointStateIds();
  // Installed partition maps use the same route portfolio as the home graph.
  // The coordinator expands only competitive frontiers that fit the hard graph
  // input ceiling, so a valid portfolio is retained instead of being replaced
  // by an avoidable memory error at the edge of the loaded corridor. A reroute
  // during turn navigation asks for one route under the selected profile, the
  // same request the single-state path sends mid-ride — an off-route rider
  // needs the next instruction, not a fresh portfolio.
  const request = multiStateWorkerRequest(turnNav.active ? 'route' : 'route-options',
    requestId, points);
  request.pointStateIds = pointStateIds;
  try {
    const runtime = await installedMultiStateRouteSession(pointStateIds);
    if (requestId !== routing.reqId) return;
    releaseHomeRouterForPartitionSession();
    const result = await runtime.session.route(request);
    if (requestId !== routing.reqId) return;
    if (result.code === 'required-states') {
      routing.routeRequestActive = false;
      setRouteOptionsLoading(false);
      await promptForRequiredRouteStates(result);
      return;
    }
    routing.multiStateActive = true;
    document.body.dataset.loadedPartitionCount = String(result.loadedPartitionIds?.length || 0);
    document.body.dataset.routeStateIds = (result.routeStateIds || []).join(',');
    const partitionInputBytes = Number(result.routingDiagnostics?.partitionInput?.rawInputBytes);
    const attempts = result.routingDiagnostics?.attempts;
    if (Number.isFinite(partitionInputBytes)) {
      document.body.dataset.routePartitionInputBytes = String(partitionInputBytes);
    }
    if (Array.isArray(attempts)) {
      document.body.dataset.routePartitionRetries = String(Math.max(0, attempts.length - 1));
    }
    onRouterMessage({ data: result });
  } catch (error) {
    if (error?.name === 'AbortError' || requestId !== routing.reqId) return;
    routing.routeRequestActive = false;
    setRouteOptionsLoading(false);
    const missingRouting = error.code === 'routing-acquisition-unavailable';
    const missingIds = [...new Set([...(error.detail?.missingStateIds || []),
      ...(error.detail?.missingRoutingStateIds || [])])];
    // A worker exception's raw message is not rider copy; the coordinator's
    // own verdicts (route-state-limit, budget, disconnected corridor) are.
    const internalFailure = ['worker', 'partition-runtime'].includes(error.code);
    const reason = missingRouting
      ? `Multi-state routing data is not installed for ${stateNames(missingIds.length ? missingIds : pointStateIds).join(' and ')}. Update the required maps and try again.`
      : internalFailure ? 'Could not prepare the required route maps.'
        : error.message || 'Could not prepare the required route maps.';
    onRouterMessage({ data: { type: request.type, id: requestId, ok: false,
      options: request.type === 'route-options' ? [] : undefined, reason,
      // The card offers the Maps screen directly: the cure for a missing
      // state map is a download, not rephrasing the route.
      needsMaps: missingRouting } });
  }
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
        stateId: instruction.stateId || null,
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
      routeStateIds: Array.isArray(m.stateIds) ? [...m.stateIds] : [],
      jurisdictions: Array.isArray(m.jurisdictions) ? m.jurisdictions : [],
      routeDependencies: routeDependencyMetadata(m),
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
        stateId: s.stateId || (typeof Region !== 'undefined' ? Region.id : null),
        partitionId: s.partitionId || null,
        localEdgeIndex: Number.isInteger(s.localEdgeIndex) ? s.localEdgeIndex : null,
        facility: s.facility || 0, official: s.official || 0, mtb: !!s.mtb,
        dismount: isDismountSegment(s), dismountEscalated: !!s.dismountEscalated,
        surface: Number.isInteger(s.surface) ? s.surface : 0,
        roadClass: s.roadClass || 0, lanes: Number(s.lanes) || 0,
        measures: s.measures || null, c0: s.c0, c1: s.c1,
        locationStart: locationAt(s.c0), locationEnd: locationAt(s.c1),
        crossing: s.crossing ? 1 : 0,
        hazard: s.hazard || 0,
        hazardLenM: s.hazardLenM || 0, hazC0: s.hazC0, hazC1: s.hazC1,
        hazardLocationStart: locationAt(s.hazC0), hazardLocationEnd: locationAt(s.hazC1),
        gradePct: s.gradePct || 0, timeS: Number(s.timeS) || 0,
        lts: Number(s.lts) || 0, lenM: Number(s.lenM) || 0,
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
  orientationSpoken: false,  // the set-off heading, once per navigation start
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

function navTurnText(delta, road, heading, staying, thenDelta) {
  const abs = Math.abs(delta);
  // "onto X" when joining a new road; "to stay on X" when the same road bends.
  const onto = road ? `${staying ? ' to stay on' : ' onto'} ${road}` : '';
  const toward = heading ? `, heading ${heading}` : '';
  // A dogleg: the rider steers twice within a few seconds, so both go in one
  // prompt and in the order they happen. Told only the second, a rider hears
  // "turn left" while the thing in front of them is a right -- reported from
  // the Sammamish River Trail, where two corners sit 15 m apart.
  // Just the direction: the leading verb already set the scale, and "bear
  // right, then bear left" is two words a rider has to hear past to reach the
  // one that matters. The trailing comma keeps the road clause from reading as
  // part of the second steer.
  const then = thenDelta == null ? ''
    : `, then ${thenDelta > 0 ? 'right' : 'left'}${staying && onto ? ',' : ''}`;
  // "Hairpin", not "U-turn": these are planned switchbacks on the route, and
  // "make a U-turn" sounded like the app correcting a rider who was fine.
  if (abs >= 150) return `Make a hairpin turn${then}${onto}${toward}`;
  if (abs >= 55) return `Turn ${delta > 0 ? 'right' : 'left'}${then}${onto}${toward}`;
  if (abs >= 20) return `Bear ${delta > 0 ? 'right' : 'left'}${then}${onto}${toward}`;
  return road ? `Continue ${staying ? 'on' : 'onto'} ${road}${toward}` : `Continue${toward}`;
}

// Distances arrive in METRES. Under a tenth of a mile they are spoken in feet,
// and the conversion used to be missing entirely: the metre count was rounded
// to 25 and labelled "feet", so a turn a full block away (about 100 m, 330 ft)
// was announced as "in 100 feet" and the rider braked for a corner that was
// not there yet. Everything under 0.1 mi was understated by 3.28x.
function navDistanceText(m) {
  if (m < 160.934) return `${Math.max(25, Math.round(m * 3.28084 / 25) * 25)} feet`;
  return `${(m / 1609.34).toFixed(1)} miles`;
}

// Close in, a figure is false precision: the fix that triggered the prompt is
// already a second or two old, and "in 75 feet" invites a rider to measure a
// distance they cannot judge at speed. Past this the prompt says "ahead"
// instead of a number. Only the SPOKEN line does this -- the maneuver card can
// afford the figure, because reading it is optional.
const SPEAK_DISTANCE_MIN_M = 60;
function navSpokenApproach(remainingM, instruction) {
  const text = navInstructionText(instruction);
  // Only the leading verb is lowercased to sit mid-sentence. Lowercasing the
  // whole line flattened road names with it, and a speech engine reads letter
  // pairs by their case: "NE 45th Street" became "ne 45th street".
  const midSentence = text.charAt(0).toLowerCase() + text.slice(1);
  return remainingM < SPEAK_DISTANCE_MIN_M
    ? `${text} ahead.`
    : `In ${navDistanceText(remainingM)}, ${midSentence}.`;
}

function navSpokenAhead(instruction) {
  const text = navInstructionText(instruction);
  return `Ahead, ${text.charAt(0).toLowerCase()}${text.slice(1)}.`;
}

// Once the rider has completed a maneuver, release it quickly enough that the
// following turn can become visible and audible. The old fixed 60 m hold kept
// a just-completed turn on screen for most of a city block; close consecutive
// turns were therefore hidden until the rider was nearly at the second one.
// Keep a small buffer for GPS projection jitter, scaled down further when the
// next maneuver is close.
const MANEUVER_PASSED_HOLD_MIN_M = 8;
const MANEUVER_PASSED_HOLD_MAX_M = 15;
function maneuverPassedHoldM(instruction, following) {
  if (!following) return MANEUVER_PASSED_HOLD_MAX_M;
  const gapM = Math.max(0,
    (Number(following.distanceM) || 0) - (Number(instruction?.distanceM) || 0));
  return Math.min(MANEUVER_PASSED_HOLD_MAX_M,
    Math.max(MANEUVER_PASSED_HOLD_MIN_M, gapM * 0.2));
}

function advancePassedNavigationManeuvers(instructions, startIndex, routeM) {
  let index = Math.max(0, Number(startIndex) || 0);
  const progressM = Number(routeM) || 0;
  while (index < instructions.length) {
    const instruction = instructions[index];
    const holdM = maneuverPassedHoldM(instruction, instructions[index + 1]);
    if (progressM - (Number(instruction.distanceM) || 0) <= holdM) break;
    // Mark every speech stage handled. If a coarse fix skipped the junction,
    // announcing the completed turn late is worse than omitting it.
    instruction.approach = true;
    instruction.ahead = true;
    instruction.now = true;
    index++;
  }
  return index;
}

function plannedRouteDistanceTitle(distanceM) {
  const distance = navDistanceText(distanceM).replace(/^1\.0 miles$/, '1 mile');
  return `You're ${distance} from your planned route`;
}


// Bearings for turn detection are measured over ~20 m of travel, not two
// raw geometry points: inside a tiny traffic circle the point-to-point
// bearings swing wildly and produce "turn left" for straight-through.
const TURN_BEARING_SPAN_M = 20;
// Window for confirming that a maneuver is a real change of course rather than
// path jitter, and the smallest sustained change worth speaking.
const SUSTAINED_TURN_SPAN_M = 40;
const SUSTAINED_TURN_MIN_DEG = 25;
// How hard a turn must be to announce leaving a named road for an unnamed one
// even when the course afterwards comes back around. Sits above the "bear"
// band (20-55 deg), where trail wander lives, and below the 67 deg the
// Rainier Vista overpass ramp actually turns.
const LEAVING_TURN_MIN_DEG = 60;
// A second maneuver naming the road just announced is a repeat unless the rider
// has travelled a real distance since, or it is a hard turn they could miss.
const SAME_ROAD_REPEAT_M = 300;
const HARD_TURN_DEG = 80;
// A DOGLEG: two corners so close together that the rider steers twice in a few
// seconds. Reported from the Sammamish River Trail, where the trail jogs across
// a bridge -- the rider was told "turn left" while the thing 50 feet in front
// of them was a right, because the first corner was silently dropped.
//
// It is dropped by the sustained-course test, which asks what the rider's
// heading is 40-120 m past a junction and stays quiet when that has barely
// changed. That test exists to kill trail wander, and it is right to: a trail
// weaving +/-30 deg every 30 m throws the same 60 deg local readings a real
// corner does, so no local-angle threshold can separate them. What separates
// them is COMPANY. Wander is a train of corners; a dogleg is a PAIR with
// straight running on both sides. So a junction is only rescued from the veto
// when exactly one other junction is close by and nothing follows it.
const TURN_CHAIN_M = 70;
// Both halves must be real steers. Below this a jog is a kink in the pavement,
// not something a rider has to do anything about.
const JOG_TURN_MIN_DEG = 40;
// A short chicane on the same named road or trail is pavement geometry, not a
// navigation decision. If the second bend restores the rider's course within
// roughly 200 ft, suppress both instructions; the route line is sufficient.
const MINOR_REJOIN_MAX_M = 61;
const MINOR_REJOIN_MAX_DEG = 20;
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
  // Which way the last maneuver turned, so the next one can tell "the same
  // bend counted twice" from "an S-bend the rider steers through twice".
  let lastDelta = 0;
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
      stateId: exitSeg?.stateId || null,
      text: navCircleText(delta, road, undefined),
      heading: compassWord(along),
    });
  }
  for (const seg of segs) {
    if (seg.hazard) {
      const at = Math.max(0, seg.hazC0 ?? seg.c0);
      instructions.push({ distanceM: cumulative[at] || 0, coordIndex: at,
        stateId: seg.stateId || null,
        text: 'Caution: possible limited-visibility uphill curve ahead' });
    }
  }
  // Where the junction after segs[i + 1] falls, and how sharply the route turns
  // there. Both are needed to tell a dogleg from wander before deciding whether
  // this junction may speak.
  const junctionAt = (index) => (index + 1 < segs.length
    ? Math.max(1, Math.min(coords.length - 2, segs[index + 1].c0)) : -1);
  // Clamped to the neighbouring corners. The ordinary 20 m bearing window is
  // right for a corner standing alone, but across a 15 m stub it necessarily
  // spans the NEXT corner too, and the two swings average each other away: a
  // 45 deg jog measures 30 and reads as nothing worth saying. Measuring each
  // corner only as far as its neighbour gives the swing the rider actually
  // makes there.
  const localDeltaAt = (at, backLimit = Infinity, aheadLimit = Infinity) => {
    const back = Math.max(4, Math.min(TURN_BEARING_SPAN_M, backLimit));
    const ahead = Math.max(4, Math.min(TURN_BEARING_SPAN_M, aheadLimit));
    return navDelta(
      routeBearingOver(coords, cumulative, cumulative[at] - back, cumulative[at]),
      routeBearingOver(coords, cumulative, cumulative[at], cumulative[at] + ahead));
  };
  // Set when a dogleg has spoken for the corner that follows it, so that corner
  // does not then repeat itself as a maneuver of its own.
  let foldedIntoJog = -1;

  for (let i = 0; i + 1 < segs.length; i++) {
    const next = segs[i + 1];
    const at = Math.max(1, Math.min(coords.length - 2, next.c0));
    if (insideCircle(at)) continue;
    if (i === foldedIntoJog) continue;
    const junctionM = cumulative[at];
    // The corner after this one, if it is close enough to be the other half of
    // a dogleg -- and only if nothing follows IT within the same window, which
    // is what makes this a pair rather than the head of a wandering train.
    const partnerAt = junctionAt(i + 1);
    const followingAt = junctionAt(i + 2);
    const partnerM = partnerAt >= 0 ? cumulative[partnerAt] : Infinity;
    const partnerIsPair = partnerAt >= 0 && partnerM - junctionM < TURN_CHAIN_M
      && (followingAt < 0 || cumulative[followingAt] - partnerM >= TURN_CHAIN_M);
    const gap = partnerM - junctionM;
    const partnerDelta = partnerIsPair
      ? localDeltaAt(partnerAt, gap, followingAt >= 0 ? cumulative[followingAt] - partnerM : Infinity)
      : 0;
    // Where the pair leaves the rider. When the two corners are 15 m apart the
    // road between them is a stub they are on for three seconds; the road that
    // matters is the one they come out on.
    const partnerTo = partnerIsPair
      ? (navDestinationSegment(segs, i + 1)?.name || '') : '';
    const localDelta = localDeltaAt(at, Infinity, partnerIsPair ? gap : Infinity);
    // Two real steers, in opposite directions, with straight running on both
    // sides of the pair. Decided here rather than after the filters below,
    // because a dogleg has to survive them: on the road the rider is already
    // on, an ordinary bend must clear 50 deg before it is worth a word, and a
    // 45 deg jog left-then-right is two things to do even though neither half
    // would rate a prompt alone.
    const doglegCandidate = partnerIsPair
      && Math.abs(localDelta) >= JOG_TURN_MIN_DEG
      && Math.abs(partnerDelta) >= JOG_TURN_MIN_DEG
      && Math.sign(partnerDelta) !== Math.sign(localDelta);
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
    const rejoinsSameRoute = doglegCandidate && gap <= MINOR_REJOIN_MAX_M
      && !!from && !!partnerTo && from.toLowerCase() === partnerTo.toLowerCase();
    if (rejoinsSameRoute) {
      const afterPair = routeBearingOver(coords, cumulative, partnerM,
        partnerM + MINOR_REJOIN_MAX_M);
      if (Math.abs(navDelta(incoming, afterPair)) < MINOR_REJOIN_MAX_DEG) {
        // The next loop iteration is the other half of this same chicane.
        foldedIntoJog = i + 1;
        continue;
      }
    }
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
    if (Math.abs(delta) < (sameRoad && !doglegCandidate ? 50 : 20)
        && !straightCrossing && !straightPathTransition) continue;
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
      // A ramp that doubles back defeats this test, and defeats it exactly
      // where the rider most needs telling. Leaving the Burke-Gilman onto the
      // unnamed ramp up to the Rainier Vista overpass is a 67 deg left, but
      // the ramp loops around and rejoins the original heading, so the course
      // 40-120 m later has changed by 3 deg: "no real turn", and the one
      // instruction that mattered was dropped. A point further along the ramp
      // then passed the same test and was announced as "turn right" -- the
      // loop's exit -- so the rider was told to turn the opposite way, after
      // the turn. Reported twice from the road.
      //
      // Leaving a NAMED road for an unnamed way is a decision point in itself:
      // the rider has to recognise an unmarked ramp or connector as theirs.
      // With a hard local turn it is announced whatever the course does
      // afterwards. Wiggle cannot reach this -- it stays on one way, so the
      // veto still applies there.
      const loopedRamp = !to && !!from && Math.abs(delta) >= LEAVING_TURN_MIN_DEG
        && Math.abs(sustained) < SUSTAINED_TURN_MIN_DEG;
      // A dogleg defeats the same test for the same reason and needs the same
      // rescue: the course 40-120 m on is measured PAST the second corner, back
      // on the bearing the rider arrived on, so the first corner reads as "no
      // real turn" and the rider hears only the second one -- the wrong way
      // round, and after they have already had to steer.
      if (Math.abs(sustained) < SUSTAINED_TURN_MIN_DEG && !loopedRamp
          && !doglegCandidate) continue;
      // With no road name to identify the maneuver by, the short sample is not
      // just noisy but can be backwards: one junction sampled a 42 deg turn to
      // the right where the rider's course actually swings 38 deg left. Describe
      // the change they will really make -- except on a looped ramp, where the
      // 120 m sample reports the heading it exits on rather than the turn.
      if (!to) effectiveDelta = loopedRamp ? delta : sustained;
      if (loopedRamp) sustainedBearing = null;
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
    // A folded pair names the road it ENDS on, not the stub between the two
    // corners: "Bear right, then left onto Northeast 55th Street". Naming the
    // stub told the rider about a road they are on for three seconds and left
    // the one they need unnamed.
    const chainRoad = doglegCandidate && partnerTo ? partnerTo : to;
    const chainStaying = doglegCandidate && partnerTo
      ? (!!from && partnerTo.toLowerCase() === from.toLowerCase()) : sameRoad;
    const text = straightCrossing
      ? `Continue across ${crossingRoad || 'the road'}`
      : navTurnText(effectiveDelta, chainRoad, undefined, chainStaying,
        doglegCandidate ? partnerDelta : undefined);
    // One road, one maneuver. A winding street crosses the turn threshold at
    // several of its own graph edges, which produced runs like "Turn right onto
    // BPA Trail" twice 87 m apart, and left/right pairs on the same road within
    // a block. The rider was already told to ride this road; only a hard turn
    // they could genuinely miss is worth repeating before they leave it.
    // ...unless it turns the OTHER way. Two sharp corners in opposite
    // directions are an S-bend, not one bend counted twice, and the rider
    // steers at both. Too far apart to fold into one prompt (that is a
    // dogleg, above), so they get one each.
    const sBend = Math.abs(localDelta) >= JOG_TURN_MIN_DEG
      && Math.abs(lastDelta) >= JOG_TURN_MIN_DEG
      && Math.sign(localDelta) !== Math.sign(lastDelta);
    if (to && to === lastRoad && distanceM - lastM < SAME_ROAD_REPEAT_M
        && Math.abs(delta) < HARD_TURN_DEG && !sBend) continue;
    if (text === lastText && distanceM - lastM < SAME_ROAD_REPEAT_M) continue;
    instructions.push({
      distanceM,
      coordIndex: at,
      segmentIndex: destination?.index ?? i + 1,
      stateId: destination?.seg?.stateId || next.stateId || null,
      text,
      // Report the heading of the road being named, not the bearing through the
      // junction itself. Where the two differ the junction reading is the one
      // that misleads: it describes a connector the rider is passing through
      // rather than the street they are being told to ride.
      // A folded pair leaves the rider pointing where the SECOND corner sends
      // them, so that is the heading worth saying. Reporting the first corner's
      // would name a direction they hold for three seconds.
      heading: compassWord(straightCrossing ? outgoing
        : doglegCandidate ? routeBearingOver(coords, cumulative,
          cumulative[partnerAt], cumulative[partnerAt] + TURN_BEARING_SPAN_M)
        : !to && sustainedBearing != null ? sustainedBearing
        : alongDestination == null ? outgoing : alongDestination),
    });
    lastM = distanceM;
    lastRoad = to;
    lastText = text;
    lastDelta = doglegCandidate ? partnerDelta : localDelta;
    // This prompt already told the rider about the corner after it, so that
    // corner must not come round again as a maneuver of its own -- otherwise a
    // dogleg is announced twice, the second time contradicting the first.
    if (doglegCandidate) foldedIntoJog = i + 1;
  }
  instructions.sort((a, b) => a.distanceM - b.distanceM);
  const segmentTimeS = segs.reduce((sum, seg) => sum + Math.max(0, Number(seg.timeS) || 0), 0);
  return {
    coords, cumulative, instructions, segs,
    safetyRuns: buildRouteSafetyRuns(segs, cumulative),
    climbRuns: buildRouteClimbRuns(segs, cumulative),
    totalM: cumulative[cumulative.length - 1] || 0,
    totalTimeS: segmentTimeS || Math.max(0, Number(m.timeS) || 0),
  };
}

/* --------------------------------------------------- hill taunt
 * A voice option that lightly needles the rider on a real climb. Not
 * guidance: it ranks below every maneuver and safety announcement, fires at
 * most twice per route with a five-minute gap, and only on a sustained hill
 * — a driveway lip must never spend one of the two taunts.
 */
const HILL_TAUNT_GRADE_PCT = 6;
// A real hill, not a blip: at least this much continuous 6%+ climbing.
const HILL_TAUNT_MIN_RUN_M = 200;
// Sub-runs separated by less than this much easier ground are one hill.
const HILL_TAUNT_MERGE_GAP_M = 80;
// Speak only once the rider is demonstrably ON the climb...
const HILL_TAUNT_MIN_INTO_M = 60;
// ...and not when it is effectively over.
const HILL_TAUNT_MIN_LEFT_M = 40;
const HILL_TAUNT_COOLDOWN_MS = 5 * 60_000;
const HILL_TAUNT_MAX_PER_ROUTE = 2;
const HILL_TAUNT_LINES = Object.freeze([
  'It looks like you are going up a hill right now. Hope you are enjoying your hill.',
  'Still climbing. The hill is very impressed with you. Probably.',
  'This hill was your idea. Just so we are clear.',
  'Good news: the top of this hill exists. You will see it eventually.',
  'You could have taken a flatter route. Anyway, enjoy.',
  'Gravity is winning on points, but you have heart.',
  'The hill does not care how you feel about it. Keep pedaling.',
  'Your legs voted no, and yet here we are.',
]);

// Contiguous stretches of credible 6%+ uphill, in route meters. Small easier
// interruptions merge, so a flat driveway crossing does not split one hill
// into two; ferries end a run outright.
function buildRouteClimbRuns(segs, cumulative) {
  const runs = [];
  for (const seg of segs || []) {
    const startM = cumulative[seg.c0], endM = cumulative[seg.c1];
    if (!Number.isFinite(startM) || !Number.isFinite(endM) || endM <= startM) continue;
    const steep = !((seg.flags || 0) & 32)
      && credibleSegmentGradePct(seg) > HILL_TAUNT_GRADE_PCT;
    const last = runs[runs.length - 1];
    if (steep && last && startM - last.endM < HILL_TAUNT_MERGE_GAP_M
        && !((seg.flags || 0) & 32)) {
      last.endM = endM;
    } else if (steep) {
      runs.push({ startM, endM, taunted: false });
    }
  }
  return runs.filter((run) => run.endM - run.startM >= HILL_TAUNT_MIN_RUN_M);
}

function maybeSpeakHillTaunt() {
  if (!navVoice.hillTaunt || turnNav.arrived) return false;
  if ((turnNav.hillTauntCount || 0) >= HILL_TAUNT_MAX_PER_ROUTE) return false;
  const now = Date.now();
  if (now - (turnNav.hillTauntAt || 0) < HILL_TAUNT_COOLDOWN_MS) return false;
  const runs = turnNav.route?.climbRuns;
  if (!runs || !runs.length) return false;
  const at = turnNav.routeM;
  const run = runs.find((r) => !r.taunted
    && at >= r.startM + HILL_TAUNT_MIN_INTO_M && at < r.endM - HILL_TAUNT_MIN_LEFT_M);
  if (!run) return false;
  run.taunted = true;
  turnNav.hillTauntCount = (turnNav.hillTauntCount || 0) + 1;
  turnNav.hillTauntAt = now;
  speakNavigation(
    HILL_TAUNT_LINES[Math.floor(Math.random() * HILL_TAUNT_LINES.length)], 'status');
  return true;
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
  'facility-gap': 'Bike space ends in traffic',
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
        && fallbackRouteLevel(seg) < 3 && !seg.mtb) {
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
// 60s, field-tuned down from 30s: the repeated "Rejoin route…" while riding
// deliberately off the line was twice as chatty as wanted. Entry and
// approach announcements are unchanged; only the periodic reminder halved.
const OFF_ROUTE_RESPEAK_MS = 60_000;
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

// The native shell keeps streaming background location fixes, and the whole
// per-fix render pipeline — camera eases, canvas redraws, progress re-tiling,
// DOM writes — used to run with the phone in a pocket. A backgrounded WebKit
// content process doing sustained allocation work is the canonical jetsam
// target, and the kill is only discovered when the phone comes back out.
// Voice guidance and all navigation logic keep running; only rendering waits,
// and one catch-up paints the current state when the app returns.
let navRenderPending = false;
function navRenderSuppressed() {
  if (!turnNav.active || document.visibilityState !== 'hidden') return false;
  navRenderPending = true;
  return true;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !navRenderPending) return;
  navRenderPending = false;
  if (turnNav.active) {
    if (turnNav.lastPosition) updateNavigationCamera(turnNav.lastPosition);
    updateNavigationProgress();
  }
  refreshNavigationUI();
});

let lastProgressSent = null;
let lastProgressSentRouteM = 0;
let lastProgressSentAt = 0;
function updateNavigationProgress() {
  if (navRenderSuppressed()) return;
  const source = map.getSource('route-progress');
  if (!source) return;
  let coords = [];
  const route = turnNav.followingConnector ? turnNav.plannedRoute : turnNav.route;
  const nearestSegment = turnNav.followingConnector
    ? turnNav.plannedNearestSegment : turnNav.nearestSegment;
  const nearestPoint = turnNav.followingConnector
    ? turnNav.plannedNearestPoint : turnNav.nearestPoint;
  // The ridden line grows with the ride and re-tiles on every send — late in
  // a long ride, tens of thousands of coordinates per GPS fix. A rider at a
  // light produced an identical payload every second, and a moving rider a
  // near-identical one; only a real advance (or a few seconds) earns a send.
  // The line's tail trails the marker by at most ~25 m, within GPS accuracy.
  const signature = turnNav.active && route && nearestPoint
    ? `${route === turnNav.plannedRoute ? 'p' : 'r'}:${nearestSegment}:${nearestPoint[0]},${nearestPoint[1]}`
    : 'off';
  if (signature === lastProgressSent) return;
  if (signature !== 'off' && lastProgressSent && lastProgressSent !== 'off') {
    const advancedM = Math.abs((Number(turnNav.routeM) || 0) - lastProgressSentRouteM);
    if (advancedM < 25 && Date.now() - lastProgressSentAt < 5000) return;
  }
  lastProgressSent = signature;
  lastProgressSentRouteM = Number(turnNav.routeM) || 0;
  lastProgressSentAt = Date.now();
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
  // Passed maneuvers are advanced by updateTurnNavigation after a short GPS
  // jitter buffer. While still inside that buffer, say "Now" rather than
  // inventing a minimum "In 25 feet" distance to a turn already reached.
  return {
    headline: remaining <= 5
      ? `Now · ${navInstructionText(next)}`
      : `In ${navDistanceText(remaining)} · ${navInstructionText(next)}`,
    meta: turnNav.followingConnector ? `${routeMeta} · Connector onto your route` : routeMeta,
    kicker: turnNav.followingConnector ? 'To your route' : 'Next maneuver',
  };
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

// Who to credit for the loaded state's data. The OSM extract and the agency
// services behind the enrichment both change with the state, so they come from
// the region rather than being written into the HTML -- one state's agency
// listed on every state's credits screen is a false attribution, not a typo.
// A state with no agency data at all shows no section rather than an empty one.
function renderRegionCredits() {
  const credit = Region.attribution || {};
  for (const host of document.querySelectorAll('#creditsExtract')) {
    host.replaceChildren();
    if (!credit.extractUrl) continue;
    const link = document.createElement('a');
    link.href = credit.extractUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Geofabrik';
    host.append(`The ${credit.extractName || Region.name} extract comes from `, link, '.');
  }
  const sources = credit.agencySources || [];
  for (const section of document.querySelectorAll('#creditsAgency')) {
    section.hidden = !sources.length;
    const heading = section.querySelector('#creditsAgencyHeading');
    const list = section.querySelector('#creditsAgencyList');
    if (heading) heading.textContent = credit.agencyHeading || `${Region.name} transportation data`;
    if (!list) continue;
    list.replaceChildren(...sources.map((source) => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noopener';
      const strong = document.createElement('b');
      strong.textContent = source.title;
      link.append(strong);
      item.append(link, ` ${source.note}`);
      return item;
    }));
  }
}

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
  renderRegionCredits();

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

/* ------------------------------------------------------------- app tour */
// The tour's pictures are CURATED screenshots shipped with the app, not live
// UI: they must look right before the rider has a location fix, a route, or
// any preset chosen. Reshoot with the capture script when the UI they show
// changes materially (see docs in onboarding/).
// One-phrase meaning per route category, for the tour's color legend. The
// keys, labels, and swatch styling come from ROUTE_CATEGORY_LABELS and the
// shared .rc-category-swatch classes — only these glosses live here.
const ONBOARDING_CATEGORY_NOTES = {
  trail: 'Dedicated paths away from traffic.',
  bike: 'Streets with real bike infrastructure.',
  pass: 'Ordinary roads that meet your rules.',
  caution: 'Meets your rules, with a caveat.',
  fail: 'Breaks at least one of your rules.',
};

const ONBOARDING_STEPS = [
  {
    img: 'onboarding/tour-welcome.jpg',
    alt: 'A green route descending through a gulch to the waterfront',
    title: 'Welcome to Just Rolling Along',
    copy: 'Bike routing that takes safety seriously. Every road and trail is scored against rules you control — and the whole map works offline. Here’s the quick tour.',
  },
  {
    img: 'onboarding/tour-plan.jpg',
    alt: 'The trip bar with a start and destination filled in',
    title: 'Set up your ride',
    copy: 'Tap Destination and pick where you’re going — Start is your current location unless you change it. Find searches for places, or tap anywhere on the map and choose Destination, Start, or Add stop.',
  },
  {
    img: 'onboarding/tour-routes.jpg',
    alt: 'The route chooser: lettered options with distance, climb, and route makeup',
    title: 'Compare your options',
    copy: 'Each search offers up to six routes with a Suggested pick — the letters are names, not grades. Every option shows distance, climbing, and its makeup: trails, bike lanes, roads that pass your rules, and any that fail them. Route Details breaks it down road by road.',
  },
  {
    img: 'onboarding/tour-fast.jpg',
    alt: 'The fastest route riding an arterial, with red dashed stretches and warning badges',
    title: 'The fast way…',
    copy: 'The quickest option often rides the big arterial. Nothing is forbidden — but every stretch that fails your rules is dashed dark red and badged, so you can see exactly what the shortcut costs.',
  },
  {
    img: 'onboarding/tour-safer.jpg',
    alt: 'The same trip on a safer route: designated bike routes and trails nearly the whole way',
    title: '…or the safer way',
    copy: 'The same trip, a few minutes more: designated bike routes and trails nearly the whole way. Every search offers both ends of this trade — you pick.',
  },
  {
    legend: 'levels',
    title: 'What the colors mean',
    copy: 'Every road and trail — on a route or not — is scored against your rules and drawn in one of five colors. Change a rule in Settings and the whole map recolors.',
  },
  {
    legend: 'icons',
    title: 'Warning icons on your route',
    copy: 'Badges along a route flag the spots worth knowing about before you reach them:',
  },
  {
    img: 'onboarding/tour-road.jpg',
    alt: 'A road card naming the broken rule: heavy traffic with no shoulder recorded',
    title: 'Tap it to see why',
    copy: 'Tap any road — especially a red one. The card names the exact rule it breaks and the numbers behind it, and Street View lets you eyeball the road before deciding for yourself.',
  },
  {
    img: 'onboarding/tour-navigate.jpg',
    alt: 'Turn-by-turn navigation showing the next maneuver and the route ahead',
    title: 'Ride it',
    copy: 'Navigate starts GPS turn-by-turn with voice guidance, including heads-up warnings for dismounts, heavy traffic, and steep hills as you approach them.',
  },
  {
    preset: true,
    title: 'How do you like to ride?',
    copy: 'Pick a starting style — it sets your safety rules. Advanced route options and weights stay independent. Every rule remains adjustable in Settings.',
  },
];
let onboardingIndex = 0;

function syncOnboardingPresetSelection() {
  const activeId = activeRoutingPreset()?.id ?? null;
  document.querySelectorAll('.onboarding-preset').forEach((card) => {
    const selected = card.dataset.presetId === activeId;
    card.classList.toggle('selected', selected);
    card.setAttribute('aria-pressed', String(selected));
  });
}

function buildOnboarding() {
  const body = document.getElementById('onboardingBody');
  const dots = document.getElementById('onboardingDots');
  if (!body || body.childElementCount) { syncOnboardingPresetSelection(); return; }
  for (const step of ONBOARDING_STEPS) {
    const section = document.createElement('section');
    section.className = 'onboarding-step';
    section.hidden = true;
    if (step.img) {
      const image = document.createElement('img');
      image.src = step.img;
      image.alt = step.alt;
      image.decoding = 'async';
      section.appendChild(image);
    }
    const title = document.createElement('h3');
    title.textContent = step.title;
    const copy = document.createElement('p');
    copy.textContent = step.copy;
    section.append(title, copy);
    if (step.legend === 'levels') {
      const host = document.createElement('div');
      host.className = 'onboarding-legend';
      for (const [key, label] of ROUTE_CATEGORY_LABELS) {
        const row = document.createElement('div');
        row.className = 'onboarding-legend-row';
        const swatch = document.createElement('span');
        swatch.className = `rc-category-swatch ${key}`;
        swatch.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span');
        const name = document.createElement('strong');
        name.textContent = label;
        const note = document.createElement('small');
        note.textContent = ONBOARDING_CATEGORY_NOTES[key] || '';
        text.append(name, note);
        row.append(swatch, text);
        host.appendChild(row);
      }
      section.appendChild(host);
    }
    if (step.legend === 'icons') {
      const host = document.createElement('div');
      host.className = 'onboarding-legend onboarding-icon-legend';
      renderActiveRouteIconItems(host);
      section.appendChild(host);
    }
    if (step.preset) {
      const host = document.createElement('div');
      host.className = 'onboarding-presets';
      for (const preset of ROUTING_PRESETS) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'onboarding-preset';
        card.dataset.presetId = preset.id;
        const label = document.createElement('strong');
        label.textContent = preset.label;
        const blurb = document.createElement('span');
        blurb.textContent = preset.blurb;
        card.append(label, blurb);
        card.addEventListener('click', () => {
          applyRoutingPreset(preset.id);
          syncOnboardingPresetSelection();
        });
        host.appendChild(card);
      }
      section.appendChild(host);
    }
    body.appendChild(section);
    const dot = document.createElement('span');
    dot.className = 'onboarding-dot';
    dots.appendChild(dot);
  }
  // The single h3 the dialog is labelled by tracks the visible step.
  body.firstElementChild?.querySelector('h3')?.setAttribute('id', 'onboardingStepTitle');
  syncOnboardingPresetSelection();
}

function showOnboardingStep(index) {
  onboardingIndex = Math.max(0, Math.min(ONBOARDING_STEPS.length - 1, index));
  const steps = [...document.querySelectorAll('.onboarding-step')];
  steps.forEach((step, i) => {
    step.hidden = i !== onboardingIndex;
    step.querySelector('h3')?.removeAttribute('id');
  });
  steps[onboardingIndex]?.querySelector('h3')?.setAttribute('id', 'onboardingStepTitle');
  document.querySelectorAll('.onboarding-dot').forEach((dot, i) =>
    dot.classList.toggle('active', i === onboardingIndex));
  const back = document.getElementById('onboardingBack');
  back.disabled = onboardingIndex === 0;
  document.getElementById('onboardingNext').textContent =
    onboardingIndex === ONBOARDING_STEPS.length - 1 ? 'Finish' : 'Next';
  document.getElementById('onboardingBody').scrollTop = 0;
}

function openOnboarding() {
  buildOnboarding();
  showOnboardingStep(0);
  const dialog = document.getElementById('onboardingDialog');
  if (dialog?.showModal && !dialog.open) dialog.showModal();
}

function stepOnboarding(delta) {
  if (onboardingIndex + delta >= ONBOARDING_STEPS.length) {
    document.getElementById('onboardingDialog')?.close();
    return;
  }
  showOnboardingStep(onboardingIndex + delta);
}

{
  const dialog = document.getElementById('onboardingDialog');
  document.getElementById('onboardingNext').addEventListener('click', () => stepOnboarding(1));
  document.getElementById('onboardingBack').addEventListener('click', () => stepOnboarding(-1));
  document.getElementById('onboardingClose').addEventListener('click', () => dialog.close());
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') stepOnboarding(1);
    if (event.key === 'ArrowLeft') stepOnboarding(-1);
  });
  // Swipe between steps; a mostly-vertical drag stays a scroll.
  let touchOrigin = null;
  dialog.addEventListener('touchstart', (event) => {
    touchOrigin = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  }, { passive: true });
  dialog.addEventListener('touchend', (event) => {
    if (!touchOrigin) return;
    const dx = event.changedTouches[0].clientX - touchOrigin.x;
    const dy = event.changedTouches[0].clientY - touchOrigin.y;
    touchOrigin = null;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) stepOnboarding(dx < 0 ? 1 : -1);
  }, { passive: true });
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
  if (navRenderSuppressed()) return;
  const routeAvailable = !!(routing.last?.ok && routing.last.coords?.length > 1);
  const routeReady = routeAvailable && Boolean(routing.start && routing.end)
    && !routing.pendingRoute && !routing.routeRequestActive;
  document.body.classList.toggle('navigation-active', turnNav.active);
  syncSettingsNavigationLock();
  const startButton = document.getElementById('navStartButton');
  if (startButton) {
    // A hidden control is clearer than an unavailable action: only offer
    // Navigate once a finished route exists. Keep it visible while navigating
    // because the same control becomes Stop.
    startButton.hidden = !turnNav.active && !routeReady;
    startButton.disabled = false;
    startButton.title = turnNav.active
      ? 'Stop navigation'
      : routeReady ? 'Start turn-by-turn navigation'
        : 'A finished route is required to navigate';
    startButton.setAttribute('aria-pressed', String(turnNav.active));
    startButton.classList.toggle('navigating', turnNav.active);
    startButton.classList.remove('route-needs-endpoints');
    if (!startButton.hidden) collapseMapAttribution();
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
  syncRoutePaneVisibility();
}

let navigationEndpointGuidanceTimer = null;
function promptForNavigationEndpoint() {
  const kind = !routing.end ? 'end' : !routing.start ? 'start' : null;
  if (!kind) return false;
  const message = kind === 'end'
    ? 'Choose a destination to start navigating.'
    : 'Choose a starting point before navigating.';
  showRouteActionToast(message, { duration: 2600 });

  const endpoint = document.getElementById(`rb-${kind}`);
  if (!endpoint) return true;
  clearTimeout(navigationEndpointGuidanceTimer);
  document.querySelectorAll('.route-endpoint.navigation-guidance-flash')
    .forEach((item) => item.classList.remove('navigation-guidance-flash'));
  requestAnimationFrame(() => requestAnimationFrame(() => {
    endpoint.classList.add('navigation-guidance-flash');
    navigationEndpointGuidanceTimer = setTimeout(() => {
      endpoint.classList.remove('navigation-guidance-flash');
    }, 2400);
  }));
  return true;
}

// ---- Navigating Route panel (the Route tab, while turn-by-turn is active) ----
// The ridden portion is shaded green to echo the map's darkening of the route
// already covered; the remainder keeps the light-blue elevation fill.
const NAV_ELEV_DONE = 'rgba(0,121,92,0.30)';
const NAV_ELEV_AHEAD = 'rgba(44,123,182,0.18)';
const NAV_ELEV_LINE = '#2c7bb6';
const NAV_ELEV_POSITION = '#00795c';
const ROUTE_ELEV_SELECTION = '#7b2cbf';
let navCardStatsFor = null;
let navEtaShowsTimeLeft = false;
let navEtaFlipTimer = null;
let navDetailsButtonAnchor = null;
let routeElevationSelection = null;
const NAV_ETA_FLIP_MS = 6000;

function navigationEstimateText(remainingS, showTimeLeft = navEtaShowsTimeLeft,
    nowMs = Date.now()) {
  if (!(remainingS >= 30)) return 'Almost there';
  if (showTimeLeft) {
    const minutes = Math.max(1, Math.round(remainingS / 60));
    if (minutes < 60) return `~${minutes} min left`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `~${hours} hr${rest ? ` ${rest} min` : ''} left`;
  }
  const eta = new Date(nowMs + remainingS * 1000);
  return `ETA ${eta.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function toggleNavigationEstimate() {
  navEtaShowsTimeLeft = !navEtaShowsTimeLeft;
  updateNavCard();
}

function syncNavigationEstimateTimer(shouldRun) {
  if (!shouldRun) {
    if (navEtaFlipTimer != null) clearInterval(navEtaFlipTimer);
    navEtaFlipTimer = null;
    navEtaShowsTimeLeft = false;
    return;
  }
  if (navEtaFlipTimer == null) {
    navEtaFlipTimer = setInterval(toggleNavigationEstimate, NAV_ETA_FLIP_MS);
  }
}

function selectedRouteElevationM(route = routing.last) {
  return routeElevationSelection?.route === route
    && Number.isFinite(routeElevationSelection.distanceM)
    ? Math.max(0, Math.min(Number(route.distM) || 0, routeElevationSelection.distanceM))
    : null;
}

function syncElevationSelectionMetadata(canvas, selectionM) {
  if (!canvas) return;
  const baseLabel = canvas.dataset.baseAriaLabel
    || canvas.getAttribute('aria-label') || 'Route elevation';
  canvas.dataset.baseAriaLabel = baseLabel;
  if (Number.isFinite(selectionM)) {
    canvas.dataset.selectedDistanceM = String(Math.round(selectionM));
    canvas.setAttribute('aria-label', `${baseLabel}; selected segment at ${fmtMi(selectionM)} miles`);
  } else {
    delete canvas.dataset.selectedDistanceM;
    canvas.setAttribute('aria-label', baseLabel);
  }
}

function drawRouteElevationSelection(ctx, x, h, padT, padB) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x, Math.max(2, padT - 5));
  ctx.lineTo(x, h - padB);
  ctx.strokeStyle = 'rgba(255,255,255,.94)';
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, Math.max(2, padT - 5));
  ctx.lineTo(x, h - padB);
  ctx.strokeStyle = ROUTE_ELEV_SELECTION;
  ctx.lineWidth = 2.4;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, Math.max(3, padT - 5), 3.2, 0, Math.PI * 2);
  ctx.fillStyle = ROUTE_ELEV_SELECTION;
  ctx.fill();
  ctx.restore();
}

function drawNavElevation(canvas, profile, distM, progressM) {
  const selectionM = selectedRouteElevationM();
  syncElevationSelectionMetadata(canvas, selectionM);
  if (!canvas || !Array.isArray(profile) || profile.length < 2 || !(distM > 0)) return;
  const w = canvas.clientWidth || 0, h = canvas.clientHeight || 74;
  if (w < 2) return; // hidden panel: redraw once it becomes visible
  const dpr = window.devicePixelRatio || 1;
  // Setting canvas.width discards and reallocates the backing store — at
  // dpr 3 nearly a megabyte of surface — and this redraws on EVERY GPS fix
  // for the whole ride. WebKit reclaims discarded canvas stores slowly, and
  // hours of per-fix churn is a documented Safari page-kill class. Reallocate
  // only when the size actually changed; otherwise clear and reuse.
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr; canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
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
  if (Number.isFinite(selectionM)) {
    drawRouteElevationSelection(ctx, X(selectionM), h, padT, padB);
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
  const selectionM = selectedRouteElevationM();
  syncElevationSelectionMetadata(canvas, selectionM);
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
  if (Number.isFinite(selectionM)) {
    drawRouteElevationSelection(ctx, X(selectionM), h, padT, padB);
  }
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

function routeDistanceAtTappedSegment(route, routeIndex, lngLat) {
  const coords = route?.coords || [];
  const seg = route?.segs?.[routeIndex];
  if (!seg || coords.length < 2 || !lngLat) return null;
  const point = [Number(lngLat.lng ?? lngLat[0]), Number(lngLat.lat ?? lngLat[1])];
  if (!point.every(Number.isFinite)) return null;
  const cumulative = [0];
  for (let i = 1; i < coords.length; i++) {
    cumulative.push(cumulative[i - 1] + navDistanceM(coords[i - 1], coords[i]));
  }
  const first = Math.max(0, Math.min(coords.length - 2, Number(seg.c0) || 0));
  const last = Math.max(first, Math.min(coords.length - 2,
    Math.max(first, Number(seg.c1) - 1 || first)));
  let bestIndex = first;
  let bestProjection = null;
  for (let i = first; i <= last; i++) {
    const projection = projectNavigationSegment(point, coords[i], coords[i + 1]);
    if (!bestProjection || projection.distanceM < bestProjection.distanceM) {
      bestProjection = projection;
      bestIndex = i;
    }
  }
  if (!bestProjection) return null;
  const geometryM = cumulative[bestIndex]
    + bestProjection.fraction * (cumulative[bestIndex + 1] - cumulative[bestIndex]);
  const geometryTotalM = cumulative[cumulative.length - 1] || 0;
  const profileTotalM = Number(route.distM) || geometryTotalM;
  return geometryTotalM > 0 ? geometryM * profileTotalM / geometryTotalM : geometryM;
}

function routeSegmentIndexNearTap(route, lngLat, toleranceM) {
  const coords = route?.coords || [];
  const segs = route?.segs || [];
  const point = [Number(lngLat?.lng ?? lngLat?.[0]), Number(lngLat?.lat ?? lngLat?.[1])];
  if (coords.length < 2 || !segs.length || !point.every(Number.isFinite)
      || !(toleranceM > 0)) return null;
  let bestCoordIndex = -1;
  let bestDistanceM = Infinity;
  for (let i = 0; i + 1 < coords.length; i++) {
    const projection = projectNavigationSegment(point, coords[i], coords[i + 1]);
    if (projection.distanceM < bestDistanceM) {
      bestDistanceM = projection.distanceM;
      bestCoordIndex = i;
    }
  }
  if (bestCoordIndex < 0 || bestDistanceM > toleranceM) return null;
  const index = segs.findIndex((seg) => bestCoordIndex >= Number(seg.c0)
    && bestCoordIndex < Number(seg.c1));
  return index >= 0 ? index : null;
}

// Match the visible route casing, not the much wider invisible route hit
// target. The latter is useful for opening a road card with a finger, but it
// made an elevation selection appear after taps that were visibly off-route.
// Resolving from the itinerary geometry also makes overlaps deterministic;
// MapLibre's feature ordering at a crossing is not a route-order contract.
const ROUTE_ELEVATION_TAP_RADIUS_PX = 6.5;
function routeSegmentIndexAtMapTap(route, lngLat, screenPoint) {
  if (!route?.ok || !lngLat || !screenPoint) return null;
  const onePixelAway = map.unproject([screenPoint.x + 1, screenPoint.y]);
  const metresPerPixel = navDistanceM(
    [lngLat.lng, lngLat.lat], [onePixelAway.lng, onePixelAway.lat]);
  return routeSegmentIndexNearTap(route, lngLat,
    Math.max(1, metresPerPixel * ROUTE_ELEVATION_TAP_RADIUS_PX));
}

function selectRouteElevationSegment(routeIndex, lngLat) {
  const route = routing.last;
  const distanceM = routeDistanceAtTappedSegment(route, routeIndex, lngLat);
  routeElevationSelection = Number.isFinite(distanceM) ? { route, distanceM } : null;
  drawRouteCardElevation();
  updateNavCard();
}

function clearRouteElevationSelection() {
  if (!routeElevationSelection) return;
  routeElevationSelection = null;
  drawRouteCardElevation();
  updateNavCard();
}

function readNavigationDetailsAnchor() {
  const tab = document.getElementById('tab-route');
  const button = document.getElementById('routeDetailsBtn');
  if (!tab || !button) return null;
  const tabRect = tab.getBoundingClientRect();
  const buttonRect = button.getBoundingClientRect();
  if (!(buttonRect.width > 0 && buttonRect.height > 0)) return null;
  return {
    left: buttonRect.left - tabRect.left,
    bottom: tabRect.bottom - buttonRect.bottom,
    width: buttonRect.width,
    height: buttonRect.height,
  };
}

// The live Details button is placed from a rect of the PLANNING card, and the
// planning card is destroyed the moment navigation starts -- so an anchor
// captured mid-transition (panel scrollbar toggling, --app-height syncing)
// misplaced the button for the whole session, with nothing left to re-derive
// it from (long-standing rare flake, ~1 in 8 under load). Keep the last rect
// that held still across two separate layout passes during planning;
// navigation prefers that settled anchor and falls back to the instant read
// only before the first one settles.
let settledNavDetailsAnchor = null;
let pendingNavDetailsAnchor = null;
function anchorsAgree(a, b) {
  return Math.abs(a.left - b.left) <= 1 && Math.abs(a.bottom - b.bottom) <= 1
    && Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1;
}
function observePlanningDetailsAnchor() {
  if (turnNav.active) return;
  const next = readNavigationDetailsAnchor();
  if (!next) { pendingNavDetailsAnchor = null; return; }
  if (pendingNavDetailsAnchor && anchorsAgree(pendingNavDetailsAnchor, next)) {
    settledNavDetailsAnchor = next;
  }
  pendingNavDetailsAnchor = next;
}

function captureNavigationDetailsButtonAnchor() {
  const instant = readNavigationDetailsAnchor();
  if (!instant) {
    navDetailsButtonAnchor = settledNavDetailsAnchor || navDetailsButtonAnchor;
    return;
  }
  // Trust a rect that has been seen twice. The instant read wins when it
  // matches the settled anchor (no news) or the pending one (a real move the
  // settle simply had not committed yet); a value matching NEITHER is the
  // mid-transition frame this exists to reject, so the settled anchor stands.
  if (settledNavDetailsAnchor && !anchorsAgree(instant, settledNavDetailsAnchor)
      && !(pendingNavDetailsAnchor && anchorsAgree(instant, pendingNavDetailsAnchor))) {
    navDetailsButtonAnchor = settledNavDetailsAnchor;
    return;
  }
  navDetailsButtonAnchor = instant;
}

function positionNavigationDetailsButton() {
  const button = document.getElementById('navCardDetailsBtn');
  if (!button) return;
  if (!turnNav.active || !navDetailsButtonAnchor) {
    for (const property of ['position', 'left', 'bottom', 'width', 'height', 'minHeight', 'transform', 'zIndex']) {
      button.style[property] = '';
    }
    navDetailsChartObserver?.disconnect();
    navDetailsChartObserver = null;
    return;
  }
  button.style.position = 'absolute';
  button.style.left = `${navDetailsButtonAnchor.left}px`;
  button.style.bottom = `${navDetailsButtonAnchor.bottom}px`;
  button.style.width = `${navDetailsButtonAnchor.width}px`;
  button.style.height = `${navDetailsButtonAnchor.height}px`;
  button.style.minHeight = `${navDetailsButtonAnchor.height}px`;
  button.style.transform = 'none';
  button.style.zIndex = '2';
  correctNavDetailsAnchorSoon(button);
}

// The anchor is one instantaneous rect of the planning card, captured the
// frame before that card is destroyed. A transient layout at that exact
// frame — an --app-height sync, a panel scrollbar mid-change — bakes a bad
// anchor for the whole navigation session and the elevation labels run into
// the button (field/test signature: a ~4.5 px overlap). The capture cannot
// be retried, so verify against live geometry instead: whenever the
// navigation card or its elevation chart lays out, if the button intrudes
// into the chart, lower the session's anchor by the deficit. The chart also
// grows after the button is first placed (the profile renders once data
// arrives), so the check follows the chart's size, not just the first frame.
let navDetailsChartObserver = null;
function correctNavDetailsAnchorSoon(button) {
  let framesUntilChart = 90;
  const correct = () => {
    if (!turnNav.active || !navDetailsButtonAnchor || !button.isConnected) return;
    const chart = document.querySelector('.nav-elevation-wrap');
    if (!chart) {
      // The chart enters the card after the button is first placed; keep
      // looking briefly so the observer attaches to it when it arrives.
      if (framesUntilChart-- > 0) requestAnimationFrame(correct);
      return;
    }
    if (typeof ResizeObserver === 'function' && !navDetailsChartObserver) {
      navDetailsChartObserver = new ResizeObserver(() => requestAnimationFrame(apply));
      navDetailsChartObserver.observe(chart);
    }
    apply();
  };
  const apply = () => {
    if (!turnNav.active || !navDetailsButtonAnchor || !button.isConnected) return;
    const chart = document.querySelector('.nav-elevation-wrap');
    if (!chart) return;
    const chartRect = chart.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    if (!(chartRect.height > 0) || !(buttonRect.height > 0)) return;
    const clearance = buttonRect.top - chartRect.bottom;
    if (clearance >= 2) return;
    const corrected = Math.max(8, navDetailsButtonAnchor.bottom - (2 - clearance));
    if (corrected === navDetailsButtonAnchor.bottom) return;
    navDetailsButtonAnchor.bottom = corrected;
    button.style.bottom = `${corrected}px`;
  };
  requestAnimationFrame(correct);
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
  if (!turnNav.active) {
    card.hidden = true;
    navCardStatsFor = null;
    syncNavigationEstimateTimer(false);
    positionNavigationDetailsButton();
    return;
  }
  card.hidden = false;
  positionNavigationDetailsButton();
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
  syncNavigationEstimateTimer(turnNav.locationReady && !turnNav.arrived && remainingS >= 30);
  if (etaEl) {
    if (!turnNav.locationReady) etaEl.textContent = '';
    else if (turnNav.arrived) etaEl.textContent = 'Arrived';
    else etaEl.textContent = navigationEstimateText(remainingS);
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
    plugin.addListener('speechFinished', (event) => handleNativeSpeechFinished(event)),
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
    // The native bridge owns its own CLLocationManager request, so browser
    // geolocation's timeout option cannot protect it. Pass the same deadline
    // across the bridge; otherwise a dismissed/interrupted permission flow can
    // leave this promise pending for the lifetime of the app.
    const position = await plugin.getCurrentPosition({
      timeoutMs: Number.isFinite(Number(options.timeout)) ? Number(options.timeout) : 15000,
    });
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
const FRESH_FIX_RETRY_DELAY_MS = 750;

function freshFixProblem(position) {
  const fixAt = Number(position?.timestamp);
  if (Number.isFinite(fixAt) && Date.now() - fixAt > FRESH_FIX_MAX_AGE_MS) {
    const error = new Error('Location is still updating');
    error.code = 'STALE_FIX';
    return error;
  }
  const accuracy = Number(position?.coords?.accuracy);
  if (Number.isFinite(accuracy) && accuracy > FRESH_FIX_MAX_ACCURACY_M) {
    const error = new Error('Location is still updating');
    error.code = 'IMPRECISE_FIX';
    return error;
  }
  return null;
}

function isFinalLocationError(error) {
  return Number(error?.code) === 1
    || /blocked|denied|permission|disabled|restricted/i.test(String(error?.message || error));
}

async function getFreshDevicePosition(options = {}) {
  const retryUntilUsable = Boolean(options.retryUntilUsable);
  const requestedTimeout = Number(options.timeout);
  const totalTimeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(1000, requestedTimeout) : 20000;
  const deadline = Date.now() + totalTimeoutMs;
  const deviceOptions = { ...options };
  delete deviceOptions.retryUntilUsable;
  let lastError = null;
  // maximumAge:0 makes the web geolocation path take a new reading instead of
  // returning a cached one. The timestamp/accuracy checks below additionally
  // cover the native plugin, whose getCurrentPosition can hand back a last-known
  // fix regardless of the option.
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1000, deadline - Date.now());
    try {
      const position = await getDevicePosition({
        ...deviceOptions,
        maximumAge: 0,
        timeout: retryUntilUsable ? Math.min(15000, remainingMs) : totalTimeoutMs,
      });
      lastError = freshFixProblem(position);
      if (!lastError) return position;
    } catch (error) {
      lastError = error;
      // Permission and disabled-services failures need rider action; waiting
      // longer cannot repair them. GPS warm-up failures usually can.
      if (!retryUntilUsable || isFinalLocationError(error)) throw error;
    }
    if (!retryUntilUsable) throw lastError;
    const waitMs = Math.min(FRESH_FIX_RETRY_DELAY_MS, deadline - Date.now());
    if (waitMs <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  throw lastError || new Error('Timed out waiting for a usable location');
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

// The native shell speaks through AVSpeechSynthesizer. Enumerating Web Speech
// voices as well is a second, unused voice client and makes iOS query/download
// voice assets during every map-only launch.
if (!nativeNavigationPlugin() && 'speechSynthesis' in window) {
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
 * A higher-ranked prompt goes next, but never cuts off the sentence already
 * being spoken. Road reports are short and turn warnings are raised early
 * enough to queue; a whole sentence a moment later is safer than two fragments
 * spoken on top of one another.
 *
 * Pacing differs by engine and cannot be made uniform. The browser reports
 * `onend`; the iOS delegate reports `speechFinished` with the utterance ID.
 * Both are authoritative. Long watchdogs exist only for an engine/bridge that
 * never reports completion, and the browser watchdog still checks
 * `synth.speaking` before advancing so a delayed callback cannot create
 * overlap.
 */
const SPEECH_RANK = { turn: 3, safety: 2, status: 1 };
// A prompt that has waited this long is no longer about where the rider is.
const SPEECH_STALE_MS = 15000;
const speechQueue = [];
let speechActive = null;
let speechTimer = 0;
// iOS Safari garbage-collects an unreferenced utterance MID-SPEECH, which
// silently kills its onend and can garble overlapping speech. Held here until
// its finish runs.
let activeBrowserUtterance = null;
let nativeSpeechSequence = 0;
let nativeSpeechCompletion = null;
// Explicitly ending navigation cancels the engine. A late callback from that
// cancelled session must not release a prompt in a newer session.
let speechGeneration = 0;

function handleNativeSpeechFinished(event) {
  const speechId = Number(event?.speechId);
  if (!nativeSpeechCompletion || speechId !== nativeSpeechCompletion.speechId) return;
  nativeSpeechCompletion.finish();
}

// Roughly 2.6 words a second, which is where both engines are set, plus a beat
// for the pause at the end.
function speechDurationMs(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1400, words * 380 + 400);
}

function stopSpeechEngine() {
  speechGeneration++;
  clearTimeout(speechTimer);
  speechTimer = 0;
  speechActive = null;
  activeBrowserUtterance = null;
  nativeSpeechCompletion = null;
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
    activeBrowserUtterance = utterance;
    utterance.onend = finish;
    utterance.onerror = finish;
    synth.speak(utterance);
    // resume() works around the mobile Safari/Chrome bug where the queue
    // silently pauses.
    synth.resume();
    // An engine that never reports the end must not wedge the queue for the
    // rest of the ride — but advancing while the engine is still AUDIBLY
    // speaking is how the next prompt lands on top of this one. So past the
    // estimate, keep believing synth.speaking. A long main-thread pause can
    // make any absolute deadline expire while the old utterance is still
    // audible; advancing then recreates the exact talking-over bug this queue
    // exists to prevent. If onend was lost, the engine's speaking flag still
    // falls when playback actually ends and the poll safely releases the queue.
    const watchdog = () => {
      let speaking = false;
      try { speaking = synth.speaking; } catch (e) { /* engine gone */ }
      if (speaking) {
        speechTimer = setTimeout(watchdog, 1000);
        return;
      }
      finish();
    };
    speechTimer = setTimeout(watchdog, speechDurationMs(text) + 4000);
  } catch (e) { finish(); }
}

function speakThrough(text, done) {
  const generation = ++speechGeneration;
  let finished = false;
  const finish = () => {
    if (finished || generation !== speechGeneration) return;
    finished = true;
    clearTimeout(speechTimer);
    speechTimer = 0;
    activeBrowserUtterance = null;
    nativeSpeechCompletion = null;
    done();
  };
  const plugin = nativeNavigationPlugin();
  if (plugin) {
    const speechId = ++nativeSpeechSequence;
    nativeSpeechCompletion = { speechId, finish };
    // The delegate event is authoritative. The long watchdog exists only for
    // a bridge/process failure; unlike the old duration estimate, it cannot
    // advance the queue while a normal sentence is still being spoken.
    speechTimer = setTimeout(finish, speechDurationMs(text) + 14000);
    ensureNativeNavigationListeners().then(() => {
      if (!nativeSpeechCompletion || nativeSpeechCompletion.speechId !== speechId) return;
      return plugin.speak({
        text,
        language: navigator.language || 'en-US',
        speechId,
      });
    }).catch(() => {
      if (!nativeSpeechCompletion || nativeSpeechCompletion.speechId !== speechId) return;
      nativeSpeechCompletion = null;
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
  // A queued status line is disposable once a maneuver supersedes it. Do not
  // cancel what is already audible; just keep obsolete summaries from delaying
  // the next instruction.
  if (rank === SPEECH_RANK.turn) {
    for (let index = speechQueue.length - 1; index >= 0; index--) {
      if (speechQueue[index].rank < SPEECH_RANK.turn) speechQueue.splice(index, 1);
    }
  }
  speechQueue.push({ text, rank, queuedAt: now });
  pumpSpeech();
}

// The sleep notice must inform, not narrate the whole ride. It is the one
// banner status with no clearing event -- screenMaySleep never flips back on
// a device without wake-lock support -- and the message slot outranks turn
// guidance, so left alone it replaced every maneuver instruction for the
// entire session (measured in a simulated ride: the headline never showed a
// single turn). Show it long enough to read, then hand the banner back.
const SCREEN_SLEEP_NOTICE = 'Screen may sleep on this device';
let screenSleepNoticeTimer = null;
function showScreenMaySleepNotice() {
  turnNav.message = SCREEN_SLEEP_NOTICE;
  clearTimeout(screenSleepNoticeTimer);
  screenSleepNoticeTimer = setTimeout(() => {
    if (turnNav.message === SCREEN_SLEEP_NOTICE) {
      turnNav.message = '';
      refreshNavigationUI();
    }
  }, 8000);
}

async function requestNavigationWakeLock() {
  if (!turnNav.active || !navVoice.keepScreenAwake) return;
  const plugin = nativeNavigationPlugin();
  if (plugin?.setScreenAwake) {
    try {
      await plugin.setScreenAwake({ enabled: true });
      turnNav.screenMaySleep = false;
      if (turnNav.locationReady) turnNav.message = '';
      refreshNavigationUI();
      return;
    } catch (e) {
      // A bridge from an older/native-mismatched shell may reject this. The
      // standard wake lock remains a useful fallback where WebKit exposes it.
    }
  }
  if (!navigator.wakeLock || document.visibilityState !== 'visible') {
    turnNav.screenMaySleep = true;
    if (turnNav.locationReady) showScreenMaySleepNotice();
    refreshNavigationUI();
    return;
  }
  try {
    turnNav.wakeLock = await navigator.wakeLock.request('screen');
    turnNav.screenMaySleep = false;
    turnNav.wakeLock.addEventListener('release', () => {
      if (turnNav.active && document.visibilityState === 'visible') requestNavigationWakeLock();
    }, { once: true });
    if (turnNav.locationReady) turnNav.message = '';
  } catch (e) {
    turnNav.screenMaySleep = true;
    if (turnNav.locationReady) showScreenMaySleepNotice();
  }
  refreshNavigationUI();
}

function releaseNavigationWakeLock() {
  nativeNavigationPlugin()?.setScreenAwake?.({ enabled: false }).catch(() => {});
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

// Both join options now hand off to a toast and close this dialog, so it is
// never left open in a busy state -- this only restores it for the next time
// it is shown.
function resetRouteStartDialog() {
  const routeButton = document.getElementById('navRouteToStartBtn');
  const nearestButton = document.getElementById('navUseNearestBtn');
  const statusElement = document.getElementById('routeStartDialogStatus');
  if (routeButton) routeButton.disabled = false;
  if (nearestButton) nearestButton.disabled = false;
  if (statusElement) statusElement.textContent = '';
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
  const title = document.getElementById('routeStartDialogTitle');
  const text = document.getElementById('routeStartDialogText');
  if (!dialog?.showModal || !title || !text) return false;
  title.textContent = plannedRouteDistanceTitle(startDistanceM);
  text.textContent = 'Choose how to get onto it.';
  resetRouteStartDialog();
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
  resetRouteStartDialog();
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
  if (turnNav.screenMaySleep) showScreenMaySleepNotice();
  else turnNav.message = '';
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

// Mid-ride recovery searches go to whichever engine holds the active route's
// graph. On a cross-state route that is the partition session's composite
// router — the home worker may hold a different state entirely, or (on a
// phone) have been released when the session took over. Falls back to the
// home worker, and reports false when neither engine is available.
function postNavigationRouteRequest(request, onUnavailable = null) {
  if (routing.multiStateActive && activeMultiStateRouting.bridge) {
    activeMultiStateRouting.bridge.search({ request, signal: new AbortController().signal })
      .then((result) => onRouterMessage({ data: result }))
      .catch(() => onUnavailable?.());
    return true;
  }
  if (!routing.worker) return false;
  routing.worker.postMessage(request);
  return true;
}

function requestNavigationConnector(target, purpose = 'start', automatic = false) {
  if (!turnNav.active || !turnNav.lastPosition || !turnNav.plannedRoute
      || turnNav.connectorRequestId != null || turnNav.newRouteRequestId != null) return;
  if (!routing.worker && !(routing.multiStateActive && activeMultiStateRouting.bridge)) {
    useNearestPlannedRoute('The routing engine is unavailable.', purpose);
    return;
  }
  const id = ++navigationConnectorRequestId;
  turnNav.connectorRequestId = id;
  turnNav.connectorPurpose = purpose;
  turnNav.joinDecision = 'loading';
  turnNav.message = '';
  // Every connector request routes to the NEAREST point on the planned route,
  // including the one offered at the start -- which is what its button says.
  // The old join-at-the-planned-start variant kept the offer dialog open with
  // a busy message; nothing requests it any more, so the dialog closes and the
  // toast carries the progress for all of them.
  closeRouteStartDialog();
  const offRouteDialog = document.getElementById('offRouteDialog');
  if (offRouteDialog?.open) offRouteDialog.close();
  showRouteActionToast(automatic ? 'Automatically routing back' : 'Finding a route back', {
    busy: true,
    detail: 'Trying your safety rules and route preferences…',
    duration: 0,
  });
  refreshNavigationUI();
  postNavigationRouteRequest({
    type: 'route-connector', id,
    points: [turnNav.lastPosition, target],
    blocks: routing.blocks?.map(routeBlockPayload) || [],
    rules: { ...rules, requireSafe: false },
    prefDesignated: routing.prefDesig,
    prefResidential: routing.prefResidential,
    weights: { ...routingWeights },
  }, () => useNearestPlannedRoute('The routing engine is unavailable.', purpose));
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
  // The connector prompt is the orientation for this start; a second
  // "Head …" on the next fix would be the talking-over this queue exists
  // to prevent.
  turnNav.orientationSpoken = true;
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
  const title = document.getElementById('offRouteDialogTitle');
  const text = document.getElementById('offRouteDialogText');
  if (!dialog?.showModal || !title || !text) return;
  const info = turnNav.offRouteInfo;
  title.textContent = info
    ? plannedRouteDistanceTitle(info.distM)
    : "You've left your route";
  text.textContent = info
    ? `The nearest point on your current route is ${info.dir}${info.street ? ` on ${info.street}` : ''}. Choose how navigation should continue.`
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
  const engineUnavailable = () => {
    turnNav.newRouteRequestId = null;
    turnNav.newRouteStart = null;
    turnNav.newRouteVias = null;
    showRouteActionToast('Could not calculate a new route', {
      detail: 'The routing engine is unavailable. Your current route is unchanged.', duration: 7000,
    });
    refreshNavigationUI();
  };
  if (!routing.worker && !(routing.multiStateActive && activeMultiStateRouting.bridge)) {
    engineUnavailable();
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
  postNavigationRouteRequest({
    type: 'navigation-new-route', id,
    points: [turnNav.newRouteStart, ...remainingVias.map((via) => via.pt), routing.end],
    blocks: routing.blocks?.map(routeBlockPayload) || [],
    rules: { ...rules }, mode: selected.mode || routing.mode,
    profileId: selected.profileId || routing.profileId,
    profileLabel: 'Route A',
    prefDesignated: routing.prefDesig,
    prefResidential: routing.prefResidential,
    weights: { ...routingWeights },
  }, engineUnavailable);
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
  turnNav.hillTauntCount = 0;
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
  // Announces its own fresh start; the set-off orientation must not repeat.
  turnNav.orientationSpoken = true;
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
  if (navRenderSuppressed()) return;
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
  if (turnNav.screenMaySleep) showScreenMaySleepNotice();
  else turnNav.message = '';
  updateNavigationProgress();
  const instructions = turnNav.route.instructions;
  // Passed maneuvers advance silently; announcing them late is noise. This is
  // intentionally a short, next-turn-aware buffer rather than the former 60 m
  // hold that obscured closely spaced city turns.
  turnNav.next = advancePassedNavigationManeuvers(
    instructions, turnNav.next, turnNav.routeM);
  const next = instructions[turnNav.next];
  if (!next) {
    if (!maybeSpeakSafetyChange() && !maybeSpeakHillTaunt()) {
      maybeSpeakPeriodicUpdate(null, Infinity);
    }
    refreshNavigationUI();
    return;
  }
  const remaining = next.distanceM - turnNav.routeM;
  // The windows grow with speed: 90 m is eleven seconds at neighborhood pace
  // but arrives mid-junction on a descent. Bounded so a freeway-speed GPS
  // glitch cannot announce a turn from a mile out.
  const paceMps = Number.isFinite(turnNav.speedMph) ? Math.max(0, turnNav.speedMph) / 2.23694 : 0;
  // The former "immediate" window was really an advance window: at the 90 m
  // floor a rider can still be a city block away. Keep that useful warning,
  // but say "Ahead" there; reserve the bare imperative for roughly the final
  // four seconds before the maneuver.
  const aheadM = Math.min(220, Math.max(90, paceMps * 12));
  const immediateM = Math.min(55, Math.max(25, paceMps * 4));
  const approachM = Math.min(700, Math.max(350, paceMps * 45));
  let spoke = false;
  if (!turnNav.orientationSpoken) {
    // The first fix of a ride: say which way to set off. GPS heading needs
    // movement the rider has not made yet, so the direction comes from the
    // route's own geometry at the joined point — and folds in the first
    // maneuver, which could otherwise go unmentioned until its 350 m window.
    turnNav.orientationSpoken = true;
    if (!next.now && remaining > aheadM) {
      const heading = compassWord(routeForwardBearing(nearest.index));
      const road = routeRoadNameAt(nearest.index);
      speakNavigation(`Head ${heading}${road ? ` on ${road}` : ''}. `
        + navSpokenApproach(remaining, next));
      if (remaining <= approachM) next.approach = true;
      spoke = true;
    }
    // Inside the immediate window the turn prompt below says it all.
  }
  if (!next.now && remaining <= immediateM) {
    // Inside the immediate window: speak only the turn itself, never both
    // the approach and the turn back-to-back.
    next.now = true;
    next.ahead = true;
    next.approach = true;
    speakNavigation(`${navInstructionText(next)}.`);
    spoke = true;
  } else if (!next.ahead && remaining <= aheadM) {
    next.ahead = true;
    next.approach = true;
    speakNavigation(navSpokenAhead(next));
    spoke = true;
  } else if (!next.approach && remaining <= approachM) {
    next.approach = true;
    speakNavigation(navSpokenApproach(remaining, next));
    spoke = true;
  }
  // The safety change gets its own schedule. It used to be reachable only when
  // no maneuver prompt was due, which on a route where the road changes AT the
  // junction meant it never got the moment it needed. Queued behind the
  // maneuver, it can be raised whenever it comes due without cutting in.
  if (maybeSpeakSafetyChange()) spoke = true;
  // The taunt is entertainment: it waits for a fix with no real news on it.
  if (!spoke && maybeSpeakHillTaunt()) spoke = true;
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
  // Navigation owns the location stack from here. Cancel the planning-time
  // start-refinement poller NOW, not at its next tick: on iOS its one-shot
  // fixes ride the same CLLocationManager as the background watch, and one
  // landing mid-ride is what silenced background voice guidance (the native
  // side also defends itself, but not queueing the request is better).
  deviceStartRefineToken++;
  // The planning card is the visual reference for this shared action. Capture
  // its exact inset before the live card replaces it; anchoring from the
  // sheet's bottom also survives the live elevation chart being taller.
  captureNavigationDetailsButtonAnchor();
  turnNav.plannedRoute = buildTurnInstructions(routing.last);
  turnNav.route = turnNav.plannedRoute;
  turnNav.connectorRoute = null;
  turnNav.followingConnector = false;
  turnNav.hillTauntCount = 0;
  turnNav.hillTauntAt = 0;
  turnNav.plannedRouteM = 0;
  turnNav.plannedNearestSegment = 0;
  turnNav.plannedNearestPoint = null;
  turnNav.locationReady = false;
  turnNav.screenMaySleep = false;
  turnNav.joinDecision = 'pending';
  turnNav.joinFix = null;
  turnNav.orientationSpoken = false;
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
  positionNavigationDetailsButton();
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
  turnNav.orientationSpoken = false;
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
  if (!nativeNavigationPlugin() && 'speechSynthesis' in window) window.speechSynthesis.cancel();
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
  const showRouteMessage = (title, message, hint = '', error = false, action = null) => {
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
    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = 'routeMessageAction';
      button.className = 'rc-route-message-action';
      button.textContent = action.label;
      button.addEventListener('click', action.onClick);
      box.append(button);
    }
    moveControls();
    moveDetails();
    refreshNavigationUI();
  };
  if (!card) return;
  syncRouteDetailsWarningState(m);
  if (!m) {
    const missing = !routing.start && !routing.end ? 'Choose start and destination'
      : !routing.start ? 'Choose a start' : 'Choose a destination';
    showRouteMessage(missing,
      'Tap the map, or use search above.');
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
    showRouteMessage('Route unavailable', reason, hint, true,
      m.needsMaps ? { label: 'Open the Maps screen', onClick: openMapsDialog } : null);
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
  const relationship = routeRelationship(m);
  card.innerHTML = `
    <div id="routeControlsSlot"></div>
    <div class="rc-route-summary">
      <div class="rc-overview">
        <span class="rc-route-context" title="${relationship.description}" aria-label="${relationship.description}">${relationship.label}</span>
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
  // Selection continuity is by LETTER, not recipe. Letters are rank positions
  // in a freshly sorted portfolio, so "the new C" is a route of similar
  // standing to the old C rather than the old C's recipe re-run -- the field
  // decision that replaced the frozen-lineup system. A letter past the end of
  // a shorter lineup falls to the last (closest) one.
  const previousLetter = (routing.last?.optimization?.label || '').replace(/^Route /, '');
  if (!previousLetter || previousLetter.length !== 1) return recommended || options[0];
  const sameLetter = options.find((option) =>
    (option.optimization?.label || '').replace(/^Route /, '') === previousLetter);
  return sameLetter || options[options.length - 1];
}

function onRouterMessage(ev) {
  const m = ev.data;
  if (m.type === 'trimmed') {
    // Exposed for field diagnosis and browser regression tests. It contains
    // counts only -- no route, location, or graph data.
    document.body.dataset.routerCacheTrim = JSON.stringify(m);
  } else if (m.type === 'edge-grade') {
    applyTappedRoadGrade(m);
  } else if (m.type === 'route-connector') {
    activateNavigationConnector(m);
    trimRouterCachesSoon();
  } else if (m.type === 'navigation-new-route') {
    activateNewRouteFromCurrentLocation(m);
    trimRouterCachesSoon();
  } else if (m.type === 'progress') {
    if (m.id != null && m.id !== routing.reqId) return;
    const title = m.phase === 'engine' ? 'Loading routing engine'
      : m.phase === 'reroute' ? 'Updating route' : 'Calculating route options';
    // The worker's fractions are monotone by construction; clamp anyway so a
    // re-ordered delivery can never make the bar step backward.
    let frac = typeof m.frac === 'number' ? m.frac : null;
    if (frac != null) {
      if (routing.progressReq !== m.id) { routing.progressReq = m.id; routing.progressFrac = 0; }
      frac = routing.progressFrac = Math.max(routing.progressFrac, frac);
    }
    showRouterProgress(m.detail || 'Working…', title, frac);
  } else if (m.type === 'ready') {
    // Only a graph whose BYTES match the expected stamp counts as loaded;
    // marking a stale one done is what made the self-heal one-shot before.
    // No hash (crypto unavailable) keeps the old always-mark behaviour.
    if (!routing.loadedGraphVersion || routing.loadedGraphVersion === GRAPH_DATA_VERSION) {
      markGraphDataLoaded();
    }
    routing.ready = true;
    routing.loading = false;
    // The Preferred-routes geometry rides behind an async overlay fetch, so
    // the restored trip below may compute first; the applied-ack recomputes
    // it quietly in that case.
    if (preferredRouteNames().length) {
      syncPreferredRoutesToWorker({ recomputeOnAck: true });
    }
    // Same race, same remedy: a source the rider switched off is stored with
    // the trip, and the worker only learns which EDGES it covers once the
    // route overlay has been fetched and matched.
    if (suppressedRouteSourceIds().length) {
      syncSuppressedRoutesToWorker({ recomputeOnAck: true });
    }
    const revealPendingCalculation = routing.pendingPanelReveal;
    routing.pendingRoute = false;
    updateArmButtons();
    setRouteStatus(routing.start && routing.end ? 'Routing…' : '');
    if (!(routing.start && routing.end)) {
      setRouteOptionsLoading(false);
      showRouteActionToast('');
    }
    renderRouteCard(routing.last);
    // One peak at a time on a phone. Boot restores the camera -- often the
    // statewide view, the renderer's hungriest tile burst -- at the same
    // moment the saved trip would start allocating search caches, and the
    // two peaks TOGETHER kept killing the page even after the caches alone
    // were capped (field: crash on boot, zoomed out, twice). Let the
    // renderer land its opening tiles first; the route follows within
    // seconds either way, and the 8 s stop means a slow tile server can
    // never hold routing hostage.
    if (isConstrainedDevice() && typeof map?.loaded === 'function' && !map.loaded()) {
      let started = false;
      const startRouting = () => {
        if (started) return;
        started = true;
        computeRoute({ revealPanel: revealPendingCalculation });
        schedulePrewarm();
      };
      map.once('idle', startRouting);
      setTimeout(startRouting, 8000);
    } else {
      computeRoute({ revealPanel: revealPendingCalculation });
      schedulePrewarm();
    }
  } else if (m.type === 'preferred-routes-applied') {
    // Startup ordering only: a trip restored before the geometry landed was
    // priced without the preference; bring it up to date once, quietly.
    if (preferredRoutesAckRecompute && m.key && rules.preferredRoutes === m.key
        && routing.start && routing.end) {
      routing.quietRecalcToast = true;
      showRouteActionToast('Updating routes…', { duration: 6000 });
      computeRoute({ revealPanel: false });
    }
    preferredRoutesAckRecompute = false;
  } else if (m.type === 'suppressed-routes-applied') {
    if (suppressedRoutesAckRecompute && m.key && rules.suppressedRouteSources === m.key
        && routing.start && routing.end) {
      routing.quietRecalcToast = true;
      showRouteActionToast('Updating routes…', { duration: 6000 });
      computeRoute({ revealPanel: false });
    }
    suppressedRoutesAckRecompute = false;
  } else if (m.type === 'route-options') {
    if (m.id !== routing.reqId) return;
    const remaining = 400 - (performance.now() - routing.compareStartedAt);
    if (!m.displayDelayApplied && remaining > 0) {
      setTimeout(() => onRouterMessage({ data: { ...m, displayDelayApplied: true } }), remaining);
      return;
    }
    routing.routeRequestActive = false;
    trimRouterCachesSoon();
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
      clearCandidatePortfolio();
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
    syncConsideredRoutesButton();
    // Every search letters its portfolio fresh. Lineups used to FREEZE per
    // trip -- refinements re-ran the same recipes under pinned letters, with
    // greyed slots for recipes that stopped routing -- and the cost was that
    // regenerating could never produce the natural current lineup (field
    // decision: generate normally, sort normally, re-select by LETTER).
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
    notifyPocketSnaps(m.snapNotes);
    // A quiet recompute (Settings holding the panel) ends with an answer, not
    // a vanishing spinner.
    if (routing.quietRecalcToast && !turnNav.active) {
      showRouteActionToast('Routes updated', { duration: 1600 });
    }
    routing.quietRecalcToast = false;
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
    activateRouteOption(m.option, true);
    renderRouteOptionControls();
  } else if (m.type === 'route') {
    if (m.id !== routing.reqId) return; // stale reply
    routing.routeRequestActive = false;
    trimRouterCachesSoon();
    setRouteOptionsLoading(false);
    if (!m.ok) {
      showRouteActionToast('Could not calculate that route', { duration: 2600 });
      routing.options = [];
      clearCandidatePortfolio();
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

function computeRoute({ revealPanel = !routing.restoringRoute } = {}) {
  if (!routing.start || !routing.end) return;
  if (routingRequiresPartitionSession()) {
    computeMultiStateRoute({ revealPanel });
    return;
  }
  // Cancel any partition session unconditionally, not only after one has
  // delivered a result: an in-flight cross-state search whose endpoint just
  // moved home would otherwise keep searching and keep writing its progress
  // over this request's status.
  activeMultiStateRouting.session?.cancel();
  if (routing.multiStateActive) {
    routing.multiStateActive = false;
    document.body.removeAttribute('data-loaded-partition-count');
    document.body.removeAttribute('data-route-state-ids');
    document.body.removeAttribute('data-route-partition-input-bytes');
    document.body.removeAttribute('data-route-partition-retries');
  }
  const shouldRevealPanel = Boolean(revealPanel) && !turnNav.active;
  if (!routing.ready) { // re-runs once the graph is ready
    routing.pendingRoute = true;
    routing.pendingPanelReveal ||= shouldRevealPanel;
    setRouteOptionsLoading(true);
    showRouteCalculationStatus('Preparing route',
      'Loading the on-device routing map…');
    if (shouldRevealPanel) revealRouteCalculation();
    ensureRouterAfterMapSettles();
    showRouterProgress('Finishing the statewide routing map; your route will start automatically…',
      'Preparing route');
    return;
  }
  routing.pendingRoute = false;
  routing.pendingPanelReveal = false;
  routing.routeRequestActive = true;
  routing.reqId++;
  setRouteStatus('Routing…');
  if (shouldRevealPanel) {
    revealRouteCalculation();
    showRouteCalculationStatus(routing.last?.ok ? 'Updating route options' : 'Calculating route options',
      routing.last?.ok
        ? 'Reapplying your safety rules and route preferences…'
        : 'Comparing safer, quicker, and bike-friendly routes…');
    showRouteActionToast('');
  } else if (turnNav.active) {
    showRouteActionToast(routing.last?.ok ? 'Recalculating route' : 'Calculating route options', {
      busy: true,
      detail: routing.last?.ok
        ? 'Reapplying your safety rules and route preferences…'
        : 'Testing safer, quicker, and bike-friendly alternatives…',
      duration: 0,
    });
  } else if (!routing.restoringRoute) {
    // A settings-held recompute runs QUIETLY -- it does not block the rider,
    // so no spinner and no progress (field decision); just "Updating routes…"
    // now and "Routes updated" when the portfolio lands. Startup restore
    // stays silent. The duration is a backstop: the completion toast usually
    // replaces this one well before it expires.
    routing.quietRecalcToast = true;
    showRouteActionToast('Updating routes…', { duration: 6000 });
  }
  setRouteOptionsLoading(true);
  saveStateSoon();
  const points = [routing.start, ...routing.vias.map((v) => v.pt), routing.end];
  const selected = routing.last?.optimization;
  if (turnNav.active) {
    routing.worker.postMessage({
      type: 'route', id: routing.reqId, points, rules: { ...rules },
      blocks: routing.blocks?.map(routeBlockPayload) || [],
      mode: selected?.mode || routing.mode,
      profileId: selected?.profileId || routing.profileId,
      profileLabel: selected?.label,
      prefDesignated: routing.prefDesig || !!selected?.prefDesignated,
      prefResidential: routing.prefResidential || !!selected?.prefResidential,
      weights: { ...routingWeights },
    });
  } else {
    routing.compareStartedAt = performance.now();
    // While the shared route is active, search with the SENDER's recipe so the
    // path reproduces exactly. The map still colors it with the receiver's
    // current rules (colors are re-scored client-side).
    const rec = routing.sharedActive ? routing.sharedRecipe : null;
    // The chooser policy: every search is a fresh portfolio, sorted and
    // lettered normally. Selection continuity is by LETTER, in
    // refreshedRouteSelection().
    routing.worker.postMessage({
      type: 'route-options', id: routing.reqId, points,
      blocks: routing.blocks?.map(routeBlockPayload) || [],
      rules: { ...(rec?.rules || rules) },
      forceDesignated: rec ? !!rec.prefDesig : routing.prefDesig,
      forceResidential: rec ? !!rec.prefResidential : routing.prefResidential,
      preferredProfileId: rec ? (rec.profileId || routing.profileId) : routing.profileId,
      // A shared route reproduces the SENDER's search exactly. Ordinary
      // searches use the rider's current weights without a hidden mode.
      weights: rec?.weights ? { ...rec.weights } : { ...routingWeights },
      // The direct-lens candidate: every ordinary portfolio also searches
      // once under the "More direct" flattening, so its variety shows up
      // without the rider knowing to ask. Not for shared routes -- those
      // reproduce the sender's exact search.
      directProbeWeights: rec ? null : directLensRoutingWeights(),
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
  if (p.dismountEscalated === 1) return 'fail';
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

/* Route markers: one vocabulary, one planner. Four things a rider wants
 * flagged on the line itself -- walking (any dismount), a 10%+ wall, heavy
 * traffic, and unpaved surface -- share one spacing
 * clock (~700 m) so the map never drowns in icons. Where several apply to
 * the same stretch, ONE is picked per slot, deterministically pseudo-random
 * by slot index so a redraw never reshuffles and long shared stretches show
 * a mix rather than a single kind winning everywhere.
 */
const ROUTE_MARKER_SPACING_M = 700;
// Offset separating the hill band from everything else in the collision sort
// key; any value above the largest possible slot index works.
const ROUTE_MARKER_SLOT_SPAN = 1e6;
// Below these run lengths a signal is a blip (or a DEM/data artefact), not a
// stretch worth an icon. Traffic and surface need real length; walking matters
// even when short. Technical-trail context remains in the road card, rather
// than using the ambiguous standalone question-mark badge.
// `steep` is not governed from here -- see STEEP_MARKER_TIERS, which needs a
// run length per grade rather than one for the kind. The entry stays so the
// table reads completely and so a future kind cannot silently inherit nothing.
const ROUTE_MARKER_MIN_RUN_M = { walk: 60, steep: 60, traffic: 400, unpaved: 400 };
const ROUTE_MARKER_KINDS = ['walk', 'steep', 'traffic', 'unpaved'];
// No mountain within this distance of a ferry leg: dockside DEM is artifact.
const FERRY_GRADE_BLACKOUT_M = 250;
// Badges grow as the rider zooms in, so they stay readable up close without
// dominating a statewide view.
const ROUTE_MARKER_SIZE_BY_ZOOM = ['interpolate', ['linear'], ['zoom'],
  9, 0.98, 12, 1.3, 14, 1.66, 16.5, 2.2];
// The car flags traffic at the tier that starts driving cautions and rule
// failures -- the safety model's "through street" (6,000/day) -- not just
// full main-highway volumes.
const HEAVY_TRAFFIC_ADT = SafetyModel.BUSY_LEVELS[3].adt;
// The ! on a rules-failing stretch: one at the middle of every contiguous
// failed area (two on a long one). Even a short failure matters, and the fail
// badge is allowed to coexist with a hill/traffic badge so neither warning can
// accidentally erase the other.
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
  return kinds;
}
function buildRouteMarkerData(sdata) {
  const feats = (sdata.features || []).map((feature, routeIndex) => {
    const p = feature.properties || {};
    const coords = feature.geometry?.coordinates || [];
    let lenM = 0;
    for (let i = 1; i < coords.length; i++) lenM += markerSpanM(coords[i - 1], coords[i]);
    const style = p.ferry === 1 ? null : routeVisualStyle(p);
    return { kinds: routeMarkerKinds(p, style), coords, lenM, routeIndex,
      // The run loop below tests the steep TIERS, and needs each feature's own
      // grade to do it -- a run qualifies at 7.5% over one block, or at a
      // gentler grade held for much longer.
      gradePct: Number(p.gradePct) || 0,
      ferry: p.ferry === 1, fail: style === 'fail', designated: p.desig === 1 };
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
      const longEnough = kind === 'steep'
        ? steepRunQualifies(feats, start, end)
        : total >= ROUTE_MARKER_MIN_RUN_M[kind];
      if (longEnough) {
        for (let i = start; i < end; i++) qualified[i].push(kind);
      }
      start = end;
    }
  }
  const walk = [], other = [];
  // Canonical order for a clustered badge id: marker-icons composites every
  // combination joined with '+' in exactly this order.
  const comboOrder = { steep: 0, traffic: 1, unpaved: 2 };
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
          // EVERY active kind shows: one clustered badge instead of a hash
          // pick per slot, which let a car hide the hill sharing its spot
          // (field report). Where a walk chain overlaps other kinds, slots
          // alternate so both stay visible along the run.
          const others = active.filter((k) => k !== 'walk');
          const combined = others.slice()
            .sort((k1, k2) => comboOrder[k1] - comboOrder[k2]).join('+');
          const kind = active.includes('walk')
            ? (others.length && slot % 2 === 1 ? combined : 'walk')
            : combined;
          // `sort` is the collision priority: stable, so the placer culls the
          // SAME markers at every zoom and zooming thins a chain monotonically
          // instead of toggling which icon a spot shows. Hills sort ahead of
          // every other kind -- the one climb on a route full of cars and
          // gravel used to be the marker that vanished at overview zoom, and
          // it is the one the rider routes around -- so thinning narrows the
          // chain TOWARD mountains; slot order settles ties within a kind.
          const sort = (kind === 'steep' || kind.startsWith('steep+')
            ? 0 : ROUTE_MARKER_SLOT_SPAN) + slot;
          const point = { type: 'Feature', properties: { kind, slot, sort,
            routeIndex: f.routeIndex },
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
  // The ! (or the bike-! badge when a signed route itself fails) sits outside
  // the spacing clock: one per contiguous failed area (two on a long one).
  // Runs split when designation changes so a normal failure cannot hide an
  // adjacent bike-! (or vice versa). A separate always-overlap layer below
  // guarantees these points survive collision placement even beside another
  // explanatory badge.
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
  const placeFailMarks = (startIdx, endIdx, kind) => {
    const runStartM = spans[startIdx].startM, runLenM = spans[endIdx].endM - runStartM;
    const targets = runLenM >= FAIL_MARKER_SECOND_AT_M
      ? [runStartM + runLenM / 3, runStartM + 2 * runLenM / 3]
      : [runStartM + runLenM / 2];
    for (const target of targets) {
      const index = spans.findIndex((span) => target >= span.startM && target <= span.endM);
      if (index < 0) continue;
      const at = pointAt(feats[index], spans[index], target);
      if (!at) continue;
      other.push({ type: 'Feature', properties: { kind, slot: -1,
        routeIndex: feats[index].routeIndex },
        geometry: { type: 'Point', coordinates: at } });
    }
  };
  let failStart = -1, failKind = null;
  feats.forEach((f, i) => {
    const kind = !f.fail ? null : (f.designated ? 'fail-designated' : 'fail');
    if (kind !== failKind) {
      if (failStart >= 0) placeFailMarks(failStart, i - 1, failKind);
      failStart = kind ? i : -1;
      failKind = kind;
    }
  });
  if (failStart >= 0) placeFailMarks(failStart, feats.length - 1, failKind);
  return { walk: { type: 'FeatureCollection', features: walk },
    other: { type: 'FeatureCollection', features: other } };
}

// A hill is worth flagging for two different reasons, and one threshold cannot
// express both: a short wall, and a long grind that never gets steep. Measured
// as the longest CONSECUTIVE run at each grade on real trips --
//
//                              3%     4%     5%     6%   7.5%
//   Phinney Ridge             266    266    266    133     70
//   Ballard -> Capitol Hill   107     76     66     66     66
//   Queen Anne -> Fremont      91      0      0      0      0
//   Downtown -> Magnolia      177    177    177    177    177
//   North Bend -> the Pass   1468   1468    600    281    281
//
// Phinney Ridge holds 5% for 266 m and never reaches 7.5% for more than 70:
// a sustained climb a single steep threshold cannot see. North Bend holds 4%
// for nearly a mile and a half, which is a different experience again. Queen
// Anne -> Fremont has nothing above 4% and must stay unmarked.
//
// So three tiers, any of which qualifies a run. The gentler the grade, the
// longer it has to be held to mean anything.
const STEEP_MARKER_TIERS = [
  { gradePct: 7.5, runM: 60 },    // a steep block
  { gradePct: 5, runM: 250 },     // a sustained climb
  { gradePct: 4, runM: 800 },     // a long grind
];
// The lowest tier decides which features are candidates at all; the tier test
// below then decides whether the run they form actually qualifies.
const STEEP_MARKER_GRADE_PCT = Math.min(...STEEP_MARKER_TIERS.map((t) => t.gradePct));

// Does feats[start..end) contain a stretch steep enough for long enough under
// ANY tier? Each tier is measured on its own contiguous sub-run, because a
// gentle stretch does not interrupt a grind but does interrupt a wall.
function steepRunQualifies(feats, start, end) {
  for (const tier of STEEP_MARKER_TIERS) {
    let run = 0;
    for (let i = start; i < end; i++) {
      if (feats[i].gradePct >= tier.gradePct) {
        run += feats[i].lenM;
        if (run >= tier.runM) return true;
      } else run = 0;
    }
  }
  return false;
}
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
  // The existing artwork is 40 x 26 CSS px. Supersample its 2x painter once
  // more and register at 4x so the logical size stays fixed while curves and
  // diagonals remain crisp on high-density displays.
  const s = 2, pixelRatio = 4;
  const width = 80 * s, height = 52 * s;
  const data = new Uint8Array(width * height * 4);
  const blue = [10, 102, 167, 255], white = [255, 255, 255, 255];
  const paint = (x, y, color) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const offset = (y * width + x) * 4;
    data[offset] = color[0]; data[offset + 1] = color[1];
    data[offset + 2] = color[2]; data[offset + 3] = color[3];
  };
  const roundedRect = (left, top, right, bottom, radius, color) => {
    left *= s; top *= s; right *= s; bottom *= s; radius *= s;
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        const cx = Math.max(left + radius, Math.min(right - radius, x));
        const cy = Math.max(top + radius, Math.min(bottom - radius, y));
        if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) paint(x, y, color);
      }
    }
  };
  const rect = (left, top, right, bottom, color) => {
    left *= s; top *= s; right *= s; bottom *= s;
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) paint(x, y, color);
    }
  };
  const polygon = (points, color) => {
    points = points.map(([x, y]) => [x * s, y * s]);
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
  targetMap.addImage(imageId, { width, height, data }, { pixelRatio });
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

function routeSegmentMapFeature(coords, segment, routeIndex) {
  if (!segment || !Array.isArray(coords)) return null;
  const props = routeSegProps(segment, routeIndex);
  // Score the very properties the card will read, so the level baked into the
  // feature is the level the card recomputes from it.
  props.level = fallbackRouteLevel(segment);
  props.hwy = isHighwaySegment(segment) ? 1 : 0;
  return {
    type: 'Feature',
    properties: props,
    geometry: { type: 'LineString', coordinates: coords.slice(segment.c0, segment.c1 + 1) },
  };
}

// A letter flip on a long route used to push thirteen full-route geojson
// payloads through MapLibre's tiling in one frame: ~2.7 s from tap to paint
// on a Seattle–Spokane portfolio (measured), all main-thread serialization.
// The eye needs the geometry, safety colors, fails and ferries immediately;
// the decorations — the invisible per-edge tap targets (the largest payload),
// the surface/designated bands and the walk/ferry markers — coalesce onto a
// short settle so a rider flipping A-B-C-D pays them once. Stale decorations
// are cleared instantly rather than shown against the wrong route; a route
// tap inside the settle window falls through to the ordinary road card.
let routeDecorationTimer = null;
let pendingRouteDecorations = null;
function scheduleRouteDecorations(apply) {
  pendingRouteDecorations = apply;
  clearTimeout(routeDecorationTimer);
  routeDecorationTimer = setTimeout(() => {
    routeDecorationTimer = null;
    const run = pendingRouteDecorations;
    pendingRouteDecorations = null;
    if (run) run();
  }, 250);
}

function drawRoute(coords, ferrySegs, segs) {
  const wasDisplayed = routeIsDisplayed;
  routeIsDisplayed = Array.isArray(coords) && coords.length >= 2;
  clearRouteHighlight();
  const data = { type: 'Feature', properties: {},
    geometry: { type: 'LineString', coordinates: coords } };
  // Ferry legs are drawn as white dashes on top of the route line, so the
  // crossing reads as "not riding" at a glance.
  const fdata = { type: 'FeatureCollection', features: (ferrySegs || []).map((c) => ({
    type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c } })) };
  // Per-edge segments with graph attrs feed the invisible tap target.
  const sdata = { type: 'FeatureCollection', features: (segs || [])
    .map((segment, routeIndex) => routeSegmentMapFeature(coords, segment, routeIndex))
    .filter(Boolean) };
  const renderData = buildRouteRenderData(sdata);
  const routeMarkers = buildRouteMarkerData(sdata);
  const ferryMarkerData = buildRouteFerryMarkerData(ferrySegs);
  // Failing portions (scored live against the current rules) pulse red on top.
  // These use the same merged geometry as the visible route so their dashes
  // remain continuous rather than restarting at every graph edge.
  const failData = { type: 'FeatureCollection',
    features: renderData.features.filter((f) => f.properties.style === 'fail') };
  const emptyHighlights = { type: 'FeatureCollection', features: [] };
  const emptyLine = { type: 'FeatureCollection', features: [] };
  const srcExisting = map.getSource('route');
  if (srcExisting) {
    srcExisting.setData(data);
    map.getSource('route-ferry').setData(fdata);
    map.getSource('route-render').setData(renderData);
    map.getSource('route-fail').setData(failData);
    map.getSource('route-seg').setData(emptyLine);
    map.getSource('route-unpaved').setData(emptyLine);
    map.getSource('route-designated').setData(emptyLine);
    map.getSource('route-dismount').setData(emptyHighlights);
    map.getSource('route-marker').setData(emptyHighlights);
    map.getSource('route-ferry-marker').setData(emptyHighlights);
    map.getSource('route-highlight-marker').setData(emptyHighlights);
    map.getSource('route-detail-marker').setData(emptyHighlights);
    map.getSource('route-detail-selection').setData(emptyLine);
    map.getSource('route-progress').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } });
    lastProgressSent = null;
    setRoutePulses(renderData);
    // Background dimming follows whether A route shows, not which one: only
    // the transition needs the full display-mode pass, never a letter flip.
    if (wasDisplayed !== routeIsDisplayed) applyDisplayModeAll();
    scheduleRouteDecorations(() => {
      if (!map.getSource('route-seg')) return;
      map.getSource('route-seg').setData(sdata);
      map.getSource('route-unpaved').setData(buildRouteUnpavedData(sdata));
      map.getSource('route-designated').setData(buildRouteDesignatedData(sdata));
      map.getSource('route-dismount').setData(routeMarkers.walk);
      map.getSource('route-marker').setData(routeMarkers.other);
      map.getSource('route-ferry-marker').setData(ferryMarkerData);
    });
    return;
  }
  const unpavedData = buildRouteUnpavedData(sdata);
  const designatedData = buildRouteDesignatedData(sdata);
  // maxzoom 14 on the line sources: a route line overzooms cleanly past its
  // deepest tiles, and stopping the pyramid four levels early does a third of
  // the tiling work per setData — which also runs on every GPS fix for the
  // progress line during navigation.
  const routeLineSource = (value) => ({ type: 'geojson', data: value, maxzoom: 14 });
  map.addSource('route', routeLineSource(data));
  map.addSource('route-ferry', routeLineSource(fdata));
  map.addSource('route-seg', routeLineSource(sdata));
  map.addSource('route-render', routeLineSource(renderData));
  map.addSource('route-fail', routeLineSource(failData));
  map.addSource('route-unpaved', routeLineSource(unpavedData));
  map.addSource('route-designated', routeLineSource(designatedData));
  map.addSource('route-dismount', { type: 'geojson', data: routeMarkers.walk });
  map.addSource('route-marker', { type: 'geojson', data: routeMarkers.other });
  map.addSource('route-ferry-marker', { type: 'geojson', data: ferryMarkerData });
  map.addSource('route-highlight-marker', { type: 'geojson', data: emptyHighlights });
  map.addSource('route-detail-marker', { type: 'geojson', data: emptyHighlights });
  map.addSource('route-detail-selection', { type: 'geojson', data: emptyLine });
  map.addSource('route-connector', routeLineSource({
    type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] },
  }));
  map.addSource('route-progress', routeLineSource({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } }));
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
      // The active route's 12.5 px white casing deliberately covers the middle
      // of this band. Leave a broad green shoulder on both sides so a rider can
      // still see, at a glance, which portions follow a designated cycle route;
      // the safety verdict remains the narrower line in the centre.
      'line-width': ['interpolate', ['linear'], ['zoom'],
        6, 17.5, 10, 22, 14, 29],
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
    filter: ['!', ['in', ['get', 'kind'], ['literal', ['fail', 'fail-designated']]]],
    layout: {
      'icon-image': ['concat', 'route-marker-', ['get', 'kind']],
      'icon-size': ROUTE_MARKER_SIZE_BY_ZOOM,
      // allow-overlap false is the crowding control: the symbol placer culls
      // whatever would collide, so zooming out thins the chain instead of
      // piling badges on badges. The sort key keeps the culling stable across
      // zooms -- without it, which marker survives is arbitrary and a spot
      // flickers between kinds as the rider zooms -- and it ranks hills ahead
      // of every other kind so they stay visible at overview zoom.
      'icon-allow-overlap': false, 'icon-ignore-placement': false,
      'symbol-sort-key': ['get', 'sort'],
    },
  });
  // Fail badges are promises, not decoration: never let collision placement
  // remove one because a hill, traffic badge, label, or very short geometry is
  // nearby. The normal marker layer remains decluttered independently.
  forgetStyleValues(); map.addLayer({
    id: 'route-fail-marker', type: 'symbol', source: 'route-marker',
    filter: ['in', ['get', 'kind'], ['literal', ['fail', 'fail-designated']]],
    layout: {
      'icon-image': ['concat', 'route-marker-', ['get', 'kind']],
      'icon-size': ROUTE_MARKER_SIZE_BY_ZOOM,
      'icon-allow-overlap': true, 'icon-ignore-placement': true,
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
  syncRouteWarningIconVisibility();
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
    // Wider than the route's own 12.5 px painted casing at EVERY zoom: the
    // old 8 px at z6 was narrower than the line itself, so zoomed out there
    // was no finger slack at all and the street beneath took the tap.
    paint: { 'line-color': '#000', 'line-opacity': 0,
             'line-width': ['interpolate', ['linear'], ['zoom'], 6, 18, 12, 20, 16, 26] },
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
  const level = fallbackRouteLevel(seg);
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
  if (kind === 'start' && (routing.startFromDevice
      || (!routing.start && routing.startDefaultsToDevice))) {
    return 'Current location (tap here to change).';
  }
  if (!routing[kind]) return kind === 'start'
    ? 'Tap here to set start.' : 'Tap here to set destination.';
  return normalizeEndpointName(routing[`${kind}Name`]) || 'Point on map';
}

let defaultStartRequest = 0;
async function resolveDefaultStartFromDevice() {
  if (routing.start || !routing.startDefaultsToDevice || !routing.end) return;
  const request = ++defaultStartRequest;
  try {
    const pos = await getFreshDevicePosition();
    if (request !== defaultStartRequest || routing.start || !routing.end
        || !routing.startDefaultsToDevice) return;
    setDeviceStart(pos);
  } catch {
    if (request !== defaultStartRequest || !routing.startDefaultsToDevice) return;
    // Current location is a convenient default, not a required step. If the
    // device cannot provide it, quietly return Start to an ordinary unset
    // state and let the rider search or tap the map.
    routing.startDefaultsToDevice = false;
    updateArmButtons();
    renderRouteCard(null);
    saveStateSoon();
  }
}

function setRoutePoint(kind, lngLat, name = 'Point on map', {
  fromDevice = false, refreshDeviceStart = true, stateId = null,
} = {}) {
  exitSharedRoute();
  const previous = routing[kind];
  const firstDestination = kind === 'end' && !Array.isArray(previous);
  if (!Array.isArray(previous) || previous[0] !== lngLat.lng || previous[1] !== lngLat.lat) {
    routing.selectRecommendedNext = true;
  }
  routing[kind] = [lngLat.lng, lngLat.lat];
  routing[`${kind}Name`] = normalizeEndpointName(name) || 'Point on map';
  // A point placed with no declared state — a map tap, a marker drag, a shared
  // link, a loaded saved route — resolves its state from where it actually is.
  // Defaulting to the home state made every such point route single-state, so
  // a tap on a visible installed neighbor failed with "move it closer".
  routing[`${kind}StateId`] = stateId
    || placeStateIdAt(lngLat.lng, lngLat.lat) || Region.id;
  // A start taken from the device is a statement about where the rider IS. A
  // start they tapped or searched for is a place they chose, and must not move
  // under them. Only the first kind follows.
  if (kind === 'start') {
    routing.startFromDevice = !!fromDevice;
    routing.startDefaultsToDevice = false;
    defaultStartRequest++;
  } else if (firstDestination && !routing.start) {
    // If Destination is chosen while Start is still blank, resolve the
    // one-time Current location default. Both endpoint rows remain visible;
    // this is a convenience, not a required order of entry.
    routing.startDefaultsToDevice = true;
  }
  const mk = kind + 'Marker';
  if (routing[mk]) routing[mk].setLngLat(lngLat);
  else {
    const touchEndpoint = window.matchMedia('(pointer: coarse)').matches;
    routing[mk] = new maplibregl.Marker({
      color: kind === 'start' ? '#0072B2' : '#D55E00', draggable: !touchEndpoint,
    }).setLngLat(lngLat).addTo(map);
    if (touchEndpoint) enableLongPressEndpointMove(kind, routing[mk]);
    else {
      // A pointer marker drags rather than long-presses, so the tap that opens
      // its card is a click that did NOT follow a drag.
      let dragged = false;
      routing[mk].on('dragstart', () => { dragged = true; });
      routing[mk].on('dragend', () => {
        const ll = routing[mk].getLngLat();
        setRoutePoint(kind, ll);
      });
      routing[mk].getElement().addEventListener('click', (event) => {
        event.stopPropagation();
        if (dragged) { dragged = false; return; }
        openEndpointCard(kind);
      });
    }
  }
  computeRoute();
  updateArmButtons();
  if (kind === 'end') {
    if (refreshDeviceStart) refreshDeviceStartForNewDestination();
    resolveDefaultStartFromDevice();
  }
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
    setDeviceStart(pos);
    showRouteActionToast('Start moved to your location', { duration: 4000 });
  } catch (e) {
    if (request !== deviceStartRequest) return;
    // Say so. Silence here is what produced the original fault: a route from
    // somewhere the rider no longer was, presented as though it were current.
    showRouteActionToast('Could not update your location', {
      detail: 'The route still starts from the pin on the map.', duration: 7000 });
  }
}

/* A fix that passes the freshness gate can still be an indoor WiFi/cell guess
 * hundreds of metres out -- the OS CLAIMS 150 m and delivers 800 (field
 * report: the start pin landed half a mile up the trail while the live
 * location dot walked to the right place moments later). Nothing ever
 * corrected the pin: the gate ran once, at planning time.
 *
 * So a device-set start keeps LISTENING for a while. Any later fix that is
 * meaningfully more accurate than the one that placed the pin, and lands a
 * real distance away, moves the start through the same visible flow the
 * new-destination refresh uses. Each improvement restarts the window, and
 * the accuracy ratchet means the pin converges instead of wandering.
 * Navigation is untouched -- it owns the origin while running -- and a start
 * the rider CHOSE never moves (startFromDevice gates every tick). */
const DEVICE_START_REFINE_WINDOW_MS = 45000;
let DEVICE_START_REFINE_POLL_MS = 4000; // let: tests shrink the wait
let deviceStartRefineToken = 0;
async function refineDeviceStartWhilePlanning() {
  const token = ++deviceStartRefineToken;
  const deadline = Date.now() + DEVICE_START_REFINE_WINDOW_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, DEVICE_START_REFINE_POLL_MS));
    if (token !== deviceStartRefineToken || !routing.startFromDevice
        || turnNav.active || !Array.isArray(routing.start)) return;
    let position = null;
    try {
      position = await getDevicePosition({ maximumAge: 0, timeout: 8000 });
    } catch (e) { continue; }
    if (token !== deviceStartRefineToken || !routing.startFromDevice
        || turnNav.active || !Array.isArray(routing.start)) return;
    if (freshFixProblem(position)) continue;
    const accuracy = Number(position.coords.accuracy);
    const placedAccuracy = Number(routing.deviceStartAccuracyM);
    // Meaningfully better than what placed the pin, never merely different:
    // trading one 200 m guess for another only makes the pin wander.
    if (Number.isFinite(placedAccuracy) && Number.isFinite(accuracy)
        && !(accuracy < placedAccuracy * 0.7)) continue;
    const next = [position.coords.longitude, position.coords.latitude];
    if (navDistanceM(routing.start, next) <= DEVICE_START_MOVED_M) {
      // Same place, better fix: the pin was right. Ratchet and stop chasing.
      if (Number.isFinite(accuracy)) routing.deviceStartAccuracyM = accuracy;
      continue;
    }
    setDeviceStart(position);
    showRouteActionToast('Start moved to your location', { duration: 4000 });
  }
}

// The one funnel for "the device says the rider is HERE" becoming the trip
// start: records the fix's claimed accuracy (the refinement ratchet) and
// keeps listening for a better one.
function setDeviceStart(position) {
  const accuracy = Number(position?.coords?.accuracy);
  routing.deviceStartAccuracyM = Number.isFinite(accuracy) ? accuracy : null;
  setRoutePoint('start', {
    lng: position.coords.longitude, lat: position.coords.latitude,
  }, 'My location', { fromDevice: true,
    stateId: placeStateIdAt(position.coords.longitude, position.coords.latitude) || Region.id });
  refineDeviceStartWhilePlanning();
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
    } else if (commit && !finished.moved) {
      // Pressed and released without ever becoming a move: that is a tap, and
      // a tap on an endpoint asks what this point is.
      openEndpointCard(kind);
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
      if (Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > 24) {
        gesture.moved = true;
        stop(false);
      }
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
  const label = kind === 'via' ? 'stop' : 'road block';
  const dialog = document.getElementById('removeRouteMarkerDialog');
  if (dialog?.showModal) {
    pendingRouteMarkerRemoval = { kind, item };
    document.getElementById('removeRouteMarkerTitle').textContent = `Remove ${label}?`;
    document.getElementById('removeRouteMarkerText').textContent = kind === 'via'
      ? 'This stop will be removed and the route recalculated.'
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
  const label = kind === 'via' ? 'stop' : 'road block';
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

let nextViaUiId = 1;
let routeStopsRenderKey = null;

function waypointMarkerElement() {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'waypoint-marker';
  element.innerHTML = '<svg viewBox="0 0 28 42" aria-hidden="true" focusable="false"><path d="M14 1C6.82 1 1 6.82 1 14c0 9.75 13 27 13 27s13-17.25 13-27C27 6.82 21.18 1 14 1Z"/><circle cx="14" cy="14" r="5"/></svg><span class="waypoint-marker-number" aria-hidden="true"></span>';
  return element;
}

function refreshWaypointMarkers() {
  routing.vias.forEach((via, index) => {
    const element = via.marker?.getElement();
    const number = element?.querySelector('.waypoint-marker-number');
    if (number) number.textContent = String(index + 1);
    if (element) element.setAttribute('aria-label',
      `Stop ${index + 1}: ${via.name || 'Point on map'}. Tap to remove`);
  });
}

function renderRouteStops() {
  const host = document.getElementById('routeStops');
  if (!host) return;
  host.hidden = !uiPrefs.showRouteStops || routing.vias.length === 0;
  const renderKey = `${Boolean(routing.start)}:${Boolean(routing.end)}:${turnNav.active}:${uiPrefs.showRouteStops}|${routing.vias.map((via) =>
    `${via._uiId}:${via.name}:${via.pt.join(',')}`).join('|')}`;
  if (renderKey === routeStopsRenderKey) {
    refreshWaypointMarkers();
    return;
  }
  routeStopsRenderKey = renderKey;
  host.replaceChildren();
  routing.vias.forEach((via, index) => {
    const row = document.createElement('div');
    row.className = 'route-stop-row';
    row.dataset.viaIndex = String(index);
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'route-stop-edit';
    edit.dataset.viaEdit = String(index);
    edit.title = `Show stop ${index + 1} on the map`;
    edit.setAttribute('aria-label', `Show stop ${index + 1} on the map: ${via.name}`);
    const number = document.createElement('span');
    number.className = 'route-stop-number';
    number.setAttribute('aria-hidden', 'true');
    number.textContent = String(index + 1);
    const copy = document.createElement('span');
    copy.className = 'endpoint-copy';
    const label = document.createElement('span');
    label.className = 'endpoint-label';
    label.textContent = `Stop ${index + 1}`;
    const name = document.createElement('strong');
    name.textContent = via.name || 'Point on map';
    copy.append(label, name);
    edit.append(number, copy);
    edit.addEventListener('click', () => showPlaceOnMap(via.pt, via.name));

    const actions = document.createElement('div');
    actions.className = 'route-stop-actions';
    const action = (className, text, title, disabled, handler) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `route-stop-action ${className}`;
      button.textContent = text;
      button.title = title;
      button.setAttribute('aria-label', title);
      button.disabled = disabled;
      button.addEventListener('click', handler);
      return button;
    };
    if (routing.vias.length > 1) {
      actions.append(
        action('route-stop-move route-stop-up', '↑', `Move stop ${index + 1} earlier`,
          turnNav.active || index === 0, () => moveVia(via, -1)),
        action('route-stop-move route-stop-down', '↓', `Move stop ${index + 1} later`,
          turnNav.active || index === routing.vias.length - 1, () => moveVia(via, 1)),
      );
    }
    actions.append(action('route-stop-remove', '✕', `Remove stop ${index + 1}`,
      turnNav.active, () => removeVia(via)));
    row.append(edit, actions);
    host.append(row);
  });
  refreshWaypointMarkers();
}

function moveVia(via, direction) {
  if (turnNav.active) return false;
  const from = routing.vias.indexOf(via);
  const to = from + Math.sign(direction);
  if (from < 0 || to < 0 || to >= routing.vias.length || from === to) return false;
  exitSharedRoute();
  routing.vias.splice(from, 1);
  routing.vias.splice(to, 0, via);
  routeStopsRenderKey = null;
  regenerateRoutesAfterWaypointChange();
  computeRoute();
  updateArmButtons();
  setRouteStatus(`Stop moved to position ${to + 1}`);
  saveStateSoon();
  return true;
}

function regenerateRoutesAfterWaypointChange() {
  // A waypoint materially changes the shape of the trip. Search the full
  // portfolio instead of asking every old letter/profile to survive the new
  // constraint; otherwise recipes that no longer work become grey holes in
  // the chooser. The new portfolio is free to recommend and letter routes
  // from scratch.
  routing.selectRecommendedNext = true;
}

function addVia(lngLat, { allowPastLimit = false, name = 'Point on map', stateId = null } = {}) {
  exitSharedRoute();
  if (!allowPastLimit && routing.vias.length >= MAX_ROUTE_STOPS) {
    routing.arm = null;
    updateArmButtons();
    setRouteStatus(`A route can have up to ${MAX_ROUTE_STOPS} stops`);
    return false;
  }
  const marker = new maplibregl.Marker({
    element: waypointMarkerElement(), anchor: 'bottom', draggable: true,
  })
    .setLngLat(lngLat).addTo(map);
  const via = {
    _uiId: nextViaUiId++,
    pt: [lngLat.lng, lngLat.lat],
    name: normalizeEndpointName(name) || 'Point on map',
    stateId: stateId || placeStateIdAt(lngLat.lng, lngLat.lat) || Region.id,
    marker,
  };
  routing.vias.push(via);
  bindRouteConstraintMarker(marker, 'via', via);
  marker.on('dragend', () => {
    const ll = marker.getLngLat();
    via.pt = [ll.lng, ll.lat];
    via.name = 'Point on map';
    via.stateId = placeStateIdAt(ll.lng, ll.lat) || Region.id;
    regenerateRoutesAfterWaypointChange();
    computeRoute();
    updateArmButtons();
    saveStateSoon();
  });
  regenerateRoutesAfterWaypointChange();
  computeRoute();
  updateArmButtons();
  saveStateSoon();
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
  regenerateRoutesAfterWaypointChange();
  const canRoute = Array.isArray(routing.start) && Array.isArray(routing.end);
  computeRoute();
  if (!canRoute) showRouteActionToast('Stop removed · choose a start to route', { duration: 2600 });
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
function roadBlockNear(lngLat, withinPx = 30, { snap = true, ferryName = null } = {}) {
  const target = map.project(snap ? snapToDrawnRoute(lngLat) : lngLat);
  let found = null;
  let best = Infinity;
  for (const block of routing.blocks) {
    if (ferryName && block.ferryName !== ferryName) continue;
    const p = map.project(block.pt);
    const distance = Math.hypot(p.x - target.x, p.y - target.y);
    if (distance < best && distance <= withinPx) { best = distance; found = block; }
  }
  return found;
}

function routeBlockPayload(block) {
  return block.ferryName
    ? { point: block.pt, ferryName: block.ferryName }
    : block.pt;
}

function addRoadBlock(lngLat, {
  allowPastLimit = false, snap = true, ferryName = null,
} = {}) {
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
  const block = {
    pt: [lngLat.lng, lngLat.lat],
    ferryName: normalizeEndpointName(ferryName),
    marker,
  };
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
  saveStateSoon();
}

function removeRouteEndpoint(kind) {
  if (!['start', 'end'].includes(kind)) return false;
  // Current location is the planner's fallback, not a removable trip point.
  // Only a deliberately chosen Start gets an X; deleting it restores that
  // fallback and resolves a fresh fix once a Destination exists.
  if (kind === 'start' && (routing.startFromDevice
      || (!routing.start && routing.startDefaultsToDevice))) return false;
  if (!routing[kind]) return false;
  exitSharedRoute();
  stopTurnNavigation(false);
  closePlacePicker();
  dismissRoadInfo();
  showRouteActionToast('');
  routing.reqId++;
  routing.pendingRoute = false;
  routing.pendingPanelReveal = false;
  routing.routeRequestActive = false;
  routing[kind] = null;
  routing[`${kind}Name`] = null;
  routing[`${kind}StateId`] = null;
  const markerKey = `${kind}Marker`;
  routing[markerKey]?.remove();
  routing[markerKey] = null;
  if (kind === 'start') {
    routing.startFromDevice = false;
    routing.startDefaultsToDevice = true;
    defaultStartRequest++;
  } else if (!routing.start) {
    routing.startDefaultsToDevice = true;
    defaultStartRequest++;
  }
  routeIsDisplayed = false;
  drawRoute([]);
  routing.last = null;
  routing.options = [];
  clearCandidatePortfolio();
  clearStoredRouteDetails();
  setRouteOptionsLoading(false);
  renderRouteOptionControls();
  renderRouteCard(null);
  updateArmButtons();
  setRouteStatus(kind === 'start' ? 'Start reset to current location' : 'Destination removed');
  if (kind === 'start') resolveDefaultStartFromDevice();
  saveStateSoon();
  return true;
}

function reverseRoute() {
  if (!routing.start || !routing.end || turnNav.active) return false;
  exitSharedRoute();
  closePlacePicker();
  dismissRoadInfo();
  clearSearchResultMarker();
  const oldStart = routing.start;
  const oldStartName = routing.startName;
  const oldStartStateId = routing.startStateId;
  routing.start = routing.end;
  routing.startName = routing.endName;
  routing.startStateId = routing.endStateId;
  routing.end = oldStart;
  routing.endName = oldStartName;
  routing.endStateId = oldStartStateId;
  routing.vias.reverse();
  // Once reversed, the new start is a deliberately chosen route point. It
  // must not inherit the old start's "follow my device" behavior.
  routing.startFromDevice = false;
  routing.startDefaultsToDevice = false;
  defaultStartRequest++;
  deviceStartRequest++;
  routing.startMarker?.setLngLat(routing.start);
  routing.endMarker?.setLngLat(routing.end);
  regenerateRoutesAfterWaypointChange();
  computeRoute();
  updateArmButtons();
  saveStateSoon();
  return true;
}

function clearRoute() {
  routeIsDisplayed = false;
  exitSharedRoute();
  showRouteActionToast('');
  stopTurnNavigation(false);
  routing.arm = null;
  closePlacePicker(false);
  routing.start = routing.end = null;
  routing.startName = routing.endName = null;
  routing.startStateId = routing.endStateId = null;
  routing.startFromDevice = false;
  routing.startDefaultsToDevice = true;
  defaultStartRequest++;
  routing.pendingRoute = false;
  routing.pendingPanelReveal = false;
  routing.routeRequestActive = false;
  routing.reqId++; // a route already being calculated must not reappear after clear
  // The stale reply that reqId just orphaned is DISCARDED on arrival --
  // before the code that would have hidden the calculation banner -- so
  // without this a clear during a search left "Calculating route options"
  // on screen indefinitely.
  hideRouteCalculationStatus();
  activeMultiStateRouting.session?.cancel();
  routing.multiStateActive = false;
  document.body.removeAttribute('data-loaded-partition-count');
  document.body.removeAttribute('data-route-state-ids');
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
  clearCandidatePortfolio();
  schedulePrewarm();
  clearStoredRouteDetails();
  renderRouteOptionControls();
  renderRouteCard(null);
  setRouteStatus('');
  updateArmButtons();
  saveStateSoon();
}

function recalculateRoute() {
  if (!routing.start || !routing.end || turnNav.active) return false;
  exitSharedRoute();
  closePlacePicker();
  dismissRoadInfo();
  clearSearchResultMarker();
  // This is an explicit fresh search, not a request to preserve the currently
  // selected letter/profile. Rebuild the portfolio and choose its recommendation.
  routing.selectRecommendedNext = true;
  computeRoute();
  return true;
}

function updateArmButtons() {
  for (const kind of ['start', 'end']) {
    const button = document.getElementById(`rb-${kind}`);
    if (!button) continue;
    const isDefaultStart = kind === 'start' && !routing.start && routing.startDefaultsToDevice;
    const isSet = Boolean(routing[kind]) || isDefaultStart;
    const endpointName = kind === 'start' ? 'start' : 'destination';
    button.classList.toggle('set', isSet);
    button.classList.toggle('default-current-location', isDefaultStart);
    button.title = isDefaultStart ? 'Current location is the default — tap to choose another start'
      : isSet ? `Change ${endpointName}`
      : `Search the map to choose ${endpointName}`;
    button.setAttribute('aria-label', button.title);
    button.disabled = false;
    const value = button.querySelector('[data-endpoint-value]');
    if (value) value.textContent = routeEndpointDisplayName(kind);
  }
  document.querySelectorAll('[data-endpoint-remove]').forEach((button) => {
    const kind = button.dataset.endpointRemove;
    button.hidden = kind === 'start'
      ? !routing.start || routing.startFromDevice
      : !routing.end;
  });
  const reverseButton = document.getElementById('rb-reverse');
  const hasEndpoints = Boolean(routing.start && routing.end);
  if (reverseButton) {
    reverseButton.disabled = !hasEndpoints || turnNav.active;
    reverseButton.title = !hasEndpoints ? 'Set a start and destination to swap them'
      : turnNav.active ? 'Stop navigation to swap start and destination'
        : 'Swap start and destination';
    reverseButton.setAttribute('aria-label', reverseButton.title);
  }
  const addStopButton = document.getElementById('rb-add-stop');
  if (addStopButton) {
    const limitReached = routing.vias.length >= MAX_ROUTE_STOPS;
    addStopButton.disabled = !hasEndpoints || turnNav.active || limitReached;
    addStopButton.title = !hasEndpoints ? 'Set a start and destination before adding a stop'
      : turnNav.active ? 'Stop navigation before adding a stop'
        : limitReached ? `Maximum of ${MAX_ROUTE_STOPS} stops reached`
          : 'Search or tap the map to add a stop';
    addStopButton.setAttribute('aria-label', addStopButton.title);
  }
  const showStopsButton = document.getElementById('rb-show-stops');
  if (showStopsButton) {
    showStopsButton.setAttribute('aria-checked', String(uiPrefs.showRouteStops));
    showStopsButton.title = uiPrefs.showRouteStops
      ? 'Hide stops from the trip bar' : 'Show stops in the trip bar';
    showStopsButton.querySelector('.route-more-check').textContent = uiPrefs.showRouteStops ? '✓' : '';
  }
  const recalculateButton = document.getElementById('rb-recalculate');
  if (recalculateButton) {
    recalculateButton.disabled = !hasEndpoints || turnNav.active;
    recalculateButton.title = !hasEndpoints
      ? 'Set a start and destination to recalculate the route'
      : turnNav.active ? 'Stop navigation before recalculating the route'
        : 'Recalculate route';
    recalculateButton.setAttribute('aria-label', recalculateButton.title);
  }
  const clearButton = document.getElementById('rb-clear');
  if (clearButton) {
    const hasRouteContent = Boolean(routing.start || routing.end || routing.vias.length
      || routing.blocks.length || routing.last || turnNav.active);
    clearButton.disabled = !hasRouteContent;
    clearButton.title = hasRouteContent ? 'Clear route' : 'No route to clear';
    clearButton.setAttribute('aria-label', clearButton.title);
  }
  renderRouteStops();
  syncRoutePaneVisibility();
}

function setRouteMoreMenuOpen(open, { restoreFocus = false } = {}) {
  const button = document.getElementById('rb-more');
  const menu = document.getElementById('routeMoreMenu');
  if (!button || !menu) return;
  const next = Boolean(open);
  menu.hidden = !next;
  button.setAttribute('aria-expanded', String(next));
  document.body.classList.toggle('route-more-open', next);
  if (restoreFocus && !next) button.focus({ preventScroll: true });
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
  host.querySelectorAll('button[data-route-option]').forEach((button) => {
    button.disabled = loading || turnNav.active;
  });
  if (!loading) hideRouteCalculationStatus();
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
  // Fresh lineups render in portfolio order; the frozen-lineup rendering
  // (pin order, greyed unroutable letters) left with the pinning system.
  cells = routing.options.map(buttonHtml);
  host.innerHTML = cells.join('');
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

function scoreMinutes(seconds) {
  const value = Number(seconds) || 0;
  return `${value < 0 ? '−' : ''}${(Math.abs(value) / 60).toFixed(1)}`;
}

function recommendationBasisLabel(basis) {
  if (basis === 'preferred-route-override') return 'Starred because you marked this route Preferred.';
  if (basis === 'fully-matching-override') return 'Starred because it fully matches your rules within the allowed score margin.';
  if (basis === 'fail-share-guard') return 'Starred because the quicker option fails your rules across most of itself.';
  return 'Starred as the lowest suggestion score among practical routes.';
}

function formatCandidateHours(seconds) {
  const hours = (Number(seconds) || 0) / 3600;
  return `${Math.floor(hours)}h${String(Math.round(hours % 1 * 60)).padStart(2, '0')}`;
}

// The stage sentence, upgraded with the worker's comparator when it shipped
// one: WHO covered a dominated route and by how much, WHICH twin a duplicate
// matches, how far past the quickest a too-slow candidate ran. Labels resolve
// here by profileId so extras read as their listed letter, not an internal
// profile name. Falls back to the worker's generic sentence.
function candidateStageDetail(c, stage, labelOf) {
  const d = c.stageData;
  const pct = (value) => `${Math.round((Number(value) || 0) * 100)}%`;
  const mate = d?.mateId ? (labelOf.get(d.mateId) || 'another option') : null;
  if (c.stage === 'too-slow' && d?.vsQuickestS) {
    const ratio = (c.timeS / Math.max(1, d.vsQuickestS)).toFixed(1);
    return `${formatCandidateHours(c.timeS)} against the quickest `
      + `${formatCandidateHours(d.vsQuickestS)} (${ratio}×), with no offsetting safety gain.`;
  }
  if (c.stage === 'duplicate' && mate) {
    return `Effectively the same roads as ${mate} — ${pct(d.overlap)} shared.`;
  }
  if (c.stage === 'dominated' && mate) {
    const quicker = d.slowerS >= 60
      ? `${Math.round(d.slowerS / 60)} min quicker` : 'no slower';
    const safer = d.moreSevereM >= 60
      ? ` and carries ${Math.round(d.moreSevereM)} m less failing road or walking`
      : ' and no less safe';
    return `${mate} covers this corridor (${pct(d.overlap)} shared), is ${quicker},${safer}.`;
  }
  if (c.stage === 'not-chosen' && mate) {
    return `${c.stageWhy} Closest offered route: ${mate}, ${pct(d.overlap)} shared.`;
  }
  return c.stageWhy;
}

// The similarity line an offered route shows: its closest boardmate. 100%
// never appears here -- the seating's diversity sweep is what this number
// audits.
function candidateSimilarityLine(c, labelOf) {
  const d = c.stageData;
  if (c.stage !== 'offered' || !d?.mateId) return '';
  const mate = labelOf.get(d.mateId) || 'another offered route';
  return `<p class="all-route-stage-why"><b>Similarity:</b> closest to ${mate}, `
    + `${Math.round((Number(d.overlap) || 0) * 100)}% shared roads.</p>`;
}

// The portfolio at a glance, above the rows: how many routes were built and
// offered, what removed the rest, and the spread the corpus actually covers.
function allRoutesSummary(all) {
  const offered = all.filter((c) => c.presented);
  const counts = {};
  for (const c of all) counts[c.stage] = (counts[c.stage] || 0) + 1;
  const cutLine = ['too-slow', 'duplicate', 'dominated', 'not-chosen', 'considered']
    .filter((stage) => counts[stage])
    .map((stage) => `${counts[stage]} ${CANDIDATE_STAGES[stage].label.toLowerCase()}`)
    .join(' · ');
  const stats = all.map((c) => candidateStatLine(c));
  const min = (values) => Math.min(...values), max = (values) => Math.max(...values);
  const mi = stats.map((s) => s.mi), pass = stats.map((s) => s.pass);
  const times = all.map((c) => c.timeS);
  const recommended = all.find((c) => c.recommended);
  const meta = document.createElement('div');
  meta.className = 'all-routes-meta';
  meta.innerHTML = `
    <p><b>${all.length}</b> routes built · <b>${offered.length}</b> offered${
      cutLine ? ` · ${cutLine}` : ''}</p>
    <p>${mi.length ? `Distance <b>${min(mi).toFixed(1)}–${max(mi).toFixed(1)}</b> mi
      · time <b>${formatCandidateHours(min(times))}–${formatCandidateHours(max(times))}</b>
      · passing your rules <b>${min(pass)}–${max(pass)}%</b>` : ''}</p>
    ${recommended ? `<p>Recommended: <b>${recommended.label}</b> — ${
      recommendationBasisLabel(recommended.recommendationBasis)}</p>` : ''}`;
  return meta;
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
  const labelOf = new Map(all.map((c) => [c.profileId, c.label]));
  host.append(allRoutesSummary(all));
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
      ${c.suggestionScore ? `<div class="all-route-score">
        <strong>Suggestion score ${scoreMinutes(c.suggestionScore.totalS)} min</strong>
        <span>travel <b>${scoreMinutes(c.suggestionScore.travelS)}</b></span>
        <span class="score-fail">fails <b>+${scoreMinutes(c.suggestionScore.failS)}</b></span>
        <span class="score-penalty">walk <b>+${scoreMinutes(c.suggestionScore.dismountS)}</b></span>
        <span class="score-penalty">ordinary roads <b>+${scoreMinutes(c.suggestionScore.ordinaryRoadS)}</b></span>
        <span class="score-credit">trails <b>−${scoreMinutes(c.suggestionScore.trailCreditS)}</b></span>
        ${c.preferredRouteM > 0 && c.preferredRouteMultiplier != null
          ? `<span>Preferred route <b>${(c.preferredRouteM / 1609.344).toFixed(1)} mi × ${Number(c.preferredRouteMultiplier).toFixed(2)}</b> search cost</span>` : ''}
        ${c.recommendationBasis ? `<span class="score-basis">${recommendationBasisLabel(c.recommendationBasis)}</span>` : ''}
      </div>` : ''}
      <p class="all-route-why"><b>Built as:</b> ${c.why}</p>
      ${candidateSimilarityLine(c, labelOf)}
      ${(() => {
        const detail = c.stage === 'offered' ? '' : candidateStageDetail(c, stage, labelOf);
        return detail ? `<p class="all-route-stage-why"><b>${stage.label}:</b> ${detail}</p>` : '';
      })()}`;
    row.addEventListener('click', () => chooseCandidate(c));
    host.append(row);
  }
}

// Tapping a row loads that route. Offered routes are already in hand; the rest
// are fetched whole from the worker's portfolio cache.
function closeConsideredRouteDialogs() {
  const allRoutes = document.getElementById('allRoutesDialog');
  if (allRoutes?.open) allRoutes.close();
  if (settingsMenuIsOpen()) selectPanelTab('route');
}

function chooseCandidate(c) {
  const existing = (routing.options || []).find((o) =>
    o.optimization?.profileId === c.profileId);
  if (existing) {
    closeConsideredRouteDialogs();
    activateRouteOption(existing, true);
    renderRouteOptionControls();
    return;
  }
  if ((!routing.worker && !routing.multiStateActive) || !routing.candidatesKey) return;
  routing.candidateReqId = (routing.candidateReqId || 0) + 1;
  const request = { type: 'route-candidate', id: routing.candidateReqId,
    candidatesKey: routing.candidatesKey, profileId: c.profileId };
  if (routing.multiStateActive && activeMultiStateRouting.bridge) {
    activeMultiStateRouting.bridge.search({ request, signal: new AbortController().signal })
      .then((result) => onRouterMessage({ data: result }))
      .catch((error) => showRouteActionToast(error.message || 'That route is unavailable',
        { duration: 2800 }));
  } else routing.worker.postMessage(request);
  closeConsideredRouteDialogs();
  showRouteActionToast(`Loading ${c.label}…`, { busy: true, duration: 8000 });
}

function openAllRoutes() {
  renderAllRoutesList();
  document.getElementById('allRoutesDialog').showModal();
}

function syncConsideredRoutesButton() {
  const button = document.getElementById('moreRoutesBtn');
  if (button) button.disabled = !(routing.allCandidates || []).length;
}

function clearCandidatePortfolio() {
  routing.allCandidates = [];
  routing.candidatesKey = null;
  syncConsideredRoutesButton();
}

function activateRouteOption(option, updateNavigation = false) {
  if (!option?.ok) return;
  // Activating any route supersedes an in-flight candidate fetch. Without
  // this, tapping an All-Routes row and then flipping back to a letter let
  // the fetch's reply arrive seconds later and stomp the newer choice --
  // the rider's LAST action lost.
  routing.candidateReqId = (routing.candidateReqId || 0) + 1;
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
      turnNav.hillTauntCount = 0;
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
      showRouteActionToast('Stop navigation before choosing a different route', { duration: 2600 });
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
  ['routeTipsBtn', 'routeIncompleteTipsBtn', 'navTipsBtn'].forEach((id) =>
    document.getElementById(id)?.addEventListener('click', openRouteTips));
  const incompleteBar = document.getElementById('routeIncompleteBar');
  const chooseMissingEndpoint = (event) => {
    if (event.target.closest?.('#routeIncompleteTipsBtn')) return;
    openPlaceSearch(routing.end && !routing.start ? 'start' : 'end');
  };
  incompleteBar?.addEventListener('click', chooseMissingEndpoint);
  document.getElementById('routeIncompleteMessage')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    chooseMissingEndpoint(event);
  });

  renderRouteCard(null);

  for (const kind of ['start', 'end']) {
    document.getElementById('rb-' + kind).addEventListener('click', () => openPlaceSearch(kind));
  }
  const moreButton = document.getElementById('rb-more');
  const moreMenu = document.getElementById('routeMoreMenu');
  moreButton.addEventListener('click', () => {
    setRouteMoreMenuOpen(moreMenu.hidden);
  });
  moreMenu.addEventListener('click', () => setRouteMoreMenuOpen(false));
  // The menu is transient: the next tap anywhere dismisses it, including a
  // route-bar control. Capture pointerdown so map/control click handlers cannot
  // swallow the dismissal; only the ellipsis itself is allowed to toggle it.
  document.addEventListener('pointerdown', (event) => {
    if (!moreMenu.hidden && !event.target.closest?.('#rb-more')
        && !event.target.closest?.('#routeMoreMenu')) {
      setRouteMoreMenuOpen(false);
    }
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !moreMenu.hidden) {
      event.preventDefault();
      setRouteMoreMenuOpen(false, { restoreFocus: true });
    }
  });
  document.getElementById('rb-search').addEventListener('click', () => openPlaceSearch());
  document.getElementById('rb-reverse').addEventListener('click', reverseRoute);
  document.getElementById('rb-add-stop').addEventListener('click', () => openPlaceSearch('via'));
  document.getElementById('rb-recalculate').addEventListener('click', recalculateRoute);
  document.getElementById('rb-clear').addEventListener('click', clearRoute);
  document.getElementById('rb-show-stops').addEventListener('click', () => {
    uiPrefs.showRouteStops = !uiPrefs.showRouteStops;
    routeStopsRenderKey = null;
    updateArmButtons();
    saveStateSoon();
  });
  document.querySelectorAll('[data-endpoint-remove]').forEach((button) => {
    button.addEventListener('click', () => removeRouteEndpoint(button.dataset.endpointRemove));
  });
  document.getElementById('navStartButton').addEventListener('click', () => {
    if (turnNav.active) stopTurnNavigation();
    else if (!promptForNavigationEndpoint()) startTurnNavigation();
  });
  document.getElementById('navCardDetailsBtn').addEventListener('click', () => openRouteDetails());
  document.getElementById('navUseNearestBtn').addEventListener('click', () => useNearestPlannedRoute());
  document.getElementById('navRouteToStartBtn').addEventListener('click', () => {
    stopRouteStartCountdown();
    requestRouteBackToCurrentRoute();
  });
  document.getElementById('navCancelStartBtn').addEventListener('click', () => stopTurnNavigation());
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
  document.getElementById('confirmRemoveRouteMarker').addEventListener('click', () => {
    const pending = pendingRouteMarkerRemoval;
    pendingRouteMarkerRemoval = null;
    document.getElementById('removeRouteMarkerDialog').close();
    if (!pending) return;
    if (pending.kind === 'via') removeVia(pending.item);
    else removeRoadBlock(pending.item);
  });
  document.getElementById('confirmSharedSwitch').addEventListener('click', () => confirmSharedSwitch());
  updateArmButtons();
  buildPlacePicker();
  buildSavedRoutes();

  // A shared link wins over the receiver's locally persisted route.
  if (sharedRoute) {
    const rt = sharedRoute.route;
    routing.restoringRoute = true;
    routing.sharedLoading = true;         // suppress the exit-shared hooks below
    routing.sharedActive = !!routing.sharedRecipe;
    setRoutePoint('start', { lng: rt.s[0], lat: rt.s[1] }, rt.sn);
    for (const [index, p] of (rt.v || []).entries()) addVia(
      { lng: p[0], lat: p[1] }, { name: rt.vn?.[index] });
    for (const [index, p] of (rt.b || []).entries()) addRoadBlock(
      { lng: p[0], lat: p[1] }, { ferryName: rt.bn?.[index] });
    setRoutePoint('end', { lng: rt.e[0], lat: rt.e[1] }, rt.en);
    routing.sharedLoading = false;
    routing.restoringRoute = false;
    fitRouteBounds(rt);
    setStatus('Shared route loaded');
    // The route is now persisted like any other plan. Removing the consumed
    // token prevents Clear/Edit + refresh from resurrecting the original link.
    saveStateSoon();
    if (saveStateNow()) consumeSharedRouteHash();
  } else if (savedState && normalizeStoredRoute(savedState.route)) {
    const rt = normalizeStoredRoute(savedState.route);
    routing.restoringRoute = true;
    setRoutePoint('start', { lng: rt.s[0], lat: rt.s[1] }, rt.sn,
      { fromDevice: rt.sd, stateId: rt.ss || Region.id });
    for (const [index, p] of (rt.v || []).entries()) addVia(
      { lng: p[0], lat: p[1] }, { allowPastLimit: true, name: rt.vn?.[index],
        stateId: rt.vs?.[index] || Region.id });
    for (const [index, p] of (rt.b || []).entries()) addRoadBlock(
      { lng: p[0], lat: p[1] }, { allowPastLimit: true, ferryName: rt.bn?.[index] });
    setRoutePoint('end', { lng: rt.e[0], lat: rt.e[1] }, rt.en,
      { stateId: rt.es || Region.id });
    routing.restoringRoute = false;
  } else updateArmButtons();
  queueMicrotask(() => resumePendingMapRouteIntent());
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
    y: routing.vias.map((via) => via.name),
    z: routing.blocks.map((block) => point(block.pt)),
    zn: routing.blocks.map((block) => block.ferryName || null),
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
  for (const [index, p] of (route.v || []).entries()) addVia(
    { lng: p[0], lat: p[1] }, { name: route.vn?.[index] });
  for (const [index, p] of (route.b || []).entries()) addRoadBlock(
    { lng: p[0], lat: p[1] }, { ferryName: route.bn?.[index] });
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
// Returns whether the write actually landed: on a device whose storage is
// full this throws, and the caller used to report "Saved" regardless.
function storeSavedRoutes(list) {
  try {
    localStorage.setItem(SAVED_ROUTES_KEY, JSON.stringify(list));
    return true;
  } catch (e) { return false; }
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
      const dependency = MapStore.routeDependencyStatus(saved?.routeDependencies);
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
      loadAction.textContent = dependency.available ? 'Load ›' : 'Unavailable';
      load.append(savedName, loadAction);
      if (!dependency.available) {
        const dependencyMessage = document.createElement('small');
        dependencyMessage.className = 'saved-route-dependency';
        dependencyMessage.textContent = dependency.message;
        savedName.append(dependencyMessage);
      }
      load.disabled = !route || !dependency.available;
      load.addEventListener('click', () => {
        const current = loadSavedRoutes()[index];
        const currentRoute = normalizeStoredRoute(current);
        if (!current || !currentRoute
            || !MapStore.routeDependencyStatus(current.routeDependencies).available) return;
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
        for (const [viaIndex, point] of currentRoute.v.entries()) addVia(
          { lng: point[0], lat: point[1] },
          { allowPastLimit: true, name: currentRoute.vn?.[viaIndex] });
        for (const [blockIndex, point] of (currentRoute.b || []).entries()) addRoadBlock(
          { lng: point[0], lat: point[1] },
          { allowPastLimit: true, ferryName: currentRoute.bn?.[blockIndex] });
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
    const stored = storeSavedRoutes(current);
    render();
    document.getElementById('savedRoutesStatus').textContent = stored
      ? `Deleted ${request.name}.`
      : 'Could not update saved routes — this device is out of storage for the app.';
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
    const routed = routing.last?.ok ? routing.last : null;
    list.unshift({ name: name.slice(0, 60), s: routing.start, e: routing.end,
      sn: routing.startName, en: routing.endName,
      v: routing.vias.map((x) => x.pt), vn: routing.vias.map((x) => x.name),
      b: routing.blocks.map((x) => x.pt),
      bn: routing.blocks.map((x) => x.ferryName || null),
      mode: routing.mode, profileId: routing.profileId,
      prefDesig: routing.prefDesig,
      prefResidential: routing.prefResidential, rules: { ...rules },
      routeStateIds: routed?.stateIds ? [...routed.stateIds] : [Region.id],
      routeDependencies: routeDependencyMetadata(routed),
      ts: Date.now() });
    const stored = storeSavedRoutes(list.slice(0, 30));
    if (stored) input.value = '';
    render();
    document.getElementById('savedRoutesStatus').textContent = stored
      ? `Saved ${name.slice(0, 60)}.`
      : 'Could not save — this device is out of storage for the app.';
  });
  render();
}

/* --------------------------------------- start/end location dialog */
// Offline place search over the baked OSM indexes of INSTALLED maps. Store
// catalogues separately expose a capped summary for discovering an
// uninstalled destination; that summary never substitutes for an installed
// state's complete places.json.
let placesIndex = null, placesPromise = null;
let availablePlacesIndex = [];
let placeSearchLoadedStateIds = [];

function placeStateConfig(stateId) {
  return allKnownStates().find((state) => state.id === stateId)
    || nationalMapOffers.get(stateId)?.state || null;
}

function placeSourceIdentity(stateId, row) {
  return `${stateId}:${String(row[0] || '').trim().toLowerCase()}|${Number(row[1]).toFixed(6)}|${Number(row[2]).toFixed(6)}|${String(row[3] || '')}`;
}

function ensurePlaces() {
  if (!placesPromise) {
    placesPromise = (async () => {
      const installedStateIds = MapStore.installedStateIds();
      const loaded = await Promise.all(installedStateIds.map(async (stateId) => {
        const state = placeStateConfig(stateId);
        if (!state?.datasets?.places) return null;
        try {
          const response = await fetch(`maps/${stateId}/places.json`);
          if (!response.ok) return null;
          const rows = await response.json();
          if (!Array.isArray(rows)) return null;
          return { stateId, rows: rows.map((row) => [
            row[0], row[1], row[2], row[3], row[4], stateId,
            placeSourceIdentity(stateId, row),
          ]) };
        } catch (error) { return null; }
      }));
      placesIndex = loaded.flatMap((entry) => entry?.rows || []);
      placeSearchLoadedStateIds = loaded.filter(Boolean).map((entry) => entry.stateId)
        .sort((a, b) => a.localeCompare(b));
      updateRegionalPlaceLabels();
      availablePlacesIndex = [];
      try {
        const catalogue = await loadNationalCatalogue();
        for (const [stateId, offer] of catalogue.offers) {
          if (MapStore.availability(stateId) !== 'remote') continue;
          for (const entry of offer.state.placeSearch?.entries || []) {
            availablePlacesIndex.push({ ...entry, stateId, source: 'store',
              sourceId: entry.id, requiresDownload: true });
          }
        }
      } catch (error) { /* installed offline search remains complete */ }
    })().catch(() => {
      placesPromise = null;
      if (!Array.isArray(placesIndex)) placesIndex = [];
    }); // offline/cache race: retry next time
  }
  return placesPromise;
}

// A constrained renderer can drop the big low-zoom context tiles that carry
// town labels, leaving a bare regional map. The style holds an independent
// point source for exactly that band; fill it with the installed states'
// larger places so orientation never depends on a tile archive.
function updateRegionalPlaceLabels() {
  const source = map.getSource?.('basemap-regional-places');
  if (!source || !Array.isArray(placesIndex)) return;
  const features = placesIndex
    .filter((row) => ['city', 'town'].includes(row[3]))
    .sort((a, b) => (b[4] || 0) - (a[4] || 0))
    .slice(0, 400)
    .map((row) => ({ type: 'Feature',
      geometry: { type: 'Point', coordinates: [row[1], row[2]] },
      properties: { name: row[0], population: row[4] || 0 } }));
  source.setData({ type: 'FeatureCollection', features });
}
onStyleReady(() => updateRegionalPlaceLabels());

let placeSearchRequestId = 0;
let placeSearchAutoTimer = 0;
let placePickerViewportRestoreTimers = [];
let searchResultMarker = null;
let searchResultOpenToken = 0;
let placeSearchTarget = null;
const PENDING_MAP_ROUTE_INTENT_KEY = 'jra-pending-map-route-intent-1';
const PENDING_MAP_ROUTE_INTENT_MAX_AGE_MS = 60 * 60 * 1000;
const onlinePlaceCache = new Map();
let onlinePlaceLastRequestAt = 0;
// Photon is built for search-as-you-type and POI lookup. The public Nominatim
// endpoint previously used here explicitly forbids autocomplete, so it cannot
// legally power the automatic no-local-results fallback below.
const ONLINE_PLACE_SEARCH_ENDPOINT = 'https://photon.komoot.io/api/';
const ONLINE_PLACE_SEARCH_MIN_INTERVAL_MS = 800;
const ONLINE_PLACE_AUTO_DELAY_MS = 700;
const ONLINE_PLACE_RESULT_LIMIT = 8;

function placeStateIdAt(lon, lat, properties = null) {
  const point = [Number(lon), Number(lat)];
  if (!point.every(Number.isFinite)) return null;
  const stated = String(properties?.state || '').trim().toLowerCase();
  const named = allKnownStates().find((state) => state.name.toLowerCase() === stated);
  if (named && point[0] >= named.bounds.minLon && point[0] <= named.bounds.maxLon
      && point[1] >= named.bounds.minLat && point[1] <= named.bounds.maxLat) return named.id;
  const exact = nationalFeatureCollection?.features?.find((feature) =>
    featureContainsPoint(feature, point));
  if (exact) return exact.properties.id;
  const candidates = allKnownStates().filter((state) => point[0] >= state.bounds.minLon
    && point[0] <= state.bounds.maxLon && point[1] >= state.bounds.minLat
    && point[1] <= state.bounds.maxLat);
  candidates.sort((a, b) =>
    (a.bounds.maxLon - a.bounds.minLon) * (a.bounds.maxLat - a.bounds.minLat)
      - (b.bounds.maxLon - b.bounds.minLon) * (b.bounds.maxLat - b.bounds.minLat));
  return candidates[0]?.id || null;
}

function placeStateIsDiscoverable(stateId) {
  if (!stateId) return false;
  return MapStore.availability(stateId) !== 'remote' || nationalMapOffers.has(stateId);
}

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

  // Photon applies a location bias while finding candidates, not merely while
  // sorting them. Include a coarse map cell in the cache key so searching for
  // a common chain after moving to another city does not reuse the old city's
  // candidate set.
  const cacheKey = `${Region.id}|${normalized}|${Math.round(refLon * 5)},${Math.round(refLat * 5)}`;
  let matches = onlinePlaceCache.get(cacheKey);
  if (!matches) {
    if (navigator.onLine === false) throw new Error('offline');
    const waitMs = Math.max(0, ONLINE_PLACE_SEARCH_MIN_INTERVAL_MS - (Date.now() - onlinePlaceLastRequestAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    onlinePlaceLastRequestAt = Date.now();

    const url = new URL(ONLINE_PLACE_SEARCH_ENDPOINT);
    // Location bias makes a generic query ("coffee", "Fred Meyer", "library")
    // useful without hard-bounding it to the current viewport. The region
    // filter below remains the routing-coverage boundary.
    url.search = new URLSearchParams({
      q: query.trim(), limit: '30', lon: String(refLon), lat: String(refLat),
      lang: String(navigator.language || 'en').split('-')[0],
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
    matches = (Array.isArray(data?.features) ? data.features : [])
      .map((feature) => {
        const properties = feature?.properties || {};
        const coordinates = feature?.geometry?.coordinates || [];
        const stateId = placeStateIdAt(coordinates[0], coordinates[1], properties);
        const osmId = properties.osm_type && properties.osm_id != null
          ? `${properties.osm_type}:${properties.osm_id}` : null;
        return {
          name: onlinePlaceResultName(properties),
          lon: Number(coordinates[0]), lat: Number(coordinates[1]), source: 'online',
          type: String(properties.osm_value || properties.type || '').replace(/_/g, ' '),
          stateId, sourceId: osmId, requiresDownload: stateId
            ? MapStore.availability(stateId) === 'remote' : false,
        };
      })
      .filter((item) => item.name && Number.isFinite(item.lon) && Number.isFinite(item.lat))
      .filter((item) => placeStateIsDiscoverable(item.stateId));
    if (onlinePlaceCache.size >= 80) onlinePlaceCache.delete(onlinePlaceCache.keys().next().value);
    onlinePlaceCache.set(cacheKey, matches);
  }

  // Sort by distance from the current view and keep the nearest handful.
  return matches
    .map((m) => ({ ...m, distanceM: navDistanceM([refLon, refLat], [m.lon, m.lat]) }))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, ONLINE_PLACE_RESULT_LIMIT);
}

function onlinePlaceResultName(item) {
  // Photon result. A street address distinguishes multiple branches of a
  // common local business; neighbourhood/city keeps landmarks understandable
  // without dumping a full geocoder address into the compact picker.
  if (item && ('osm_key' in item || 'osm_value' in item)) {
    const primary = String(item.name || item.street || item.city || item.county || '').trim();
    const street = [item.housenumber, item.street].map((part) => String(part || '').trim())
      .filter(Boolean).join(' ');
    const locality = String(item.district || item.locality || item.city || item.county || '').trim();
    const state = String(item.state || Region.name).trim();
    const parts = [primary];
    if (street && street.toLowerCase() !== primary.toLowerCase()) parts.push(street);
    if (locality && !parts.some((part) => part.toLowerCase() === locality.toLowerCase())) {
      parts.push(locality);
    }
    if (state && !parts.some((part) => part.toLowerCase() === state.toLowerCase())) parts.push(state);
    return parts.filter(Boolean).join(', ').slice(0, 180);
  }
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

function closePlacePicker() {
  const target = placeSearchTarget;
  placeSearchRequestId++;
  clearTimeout(placeSearchAutoTimer);
  placeSearchAutoTimer = 0;
  placeSearchTarget = null;
  if (target && routing.arm === target) {
    routing.arm = null;
    updateArmButtons();
  }
  const picker = document.getElementById('placePicker');
  if (document.activeElement && picker.contains(document.activeElement)) document.activeElement.blur();
  picker.hidden = true;
  document.body.classList.remove('place-picker-open');
  restoreViewportAfterPlacePicker();
  const placeResults = document.getElementById('placeResults');
  placeResults.replaceChildren();
  placeResults.classList.remove('show');
  placeResults.removeAttribute('aria-busy');
  setUseLocationBusy(false);
}

function clearSearchResultMarker() {
  searchResultOpenToken++;
  searchResultMarker?.remove();
  searchResultMarker = null;
}

function searchResultMarkerElement() {
  const element = document.createElement('div');
  element.className = 'search-result-marker';
  element.setAttribute('aria-hidden', 'true');
  return element;
}

function showTemporaryMapMarker(lngLat) {
  clearSearchResultMarker();
  searchResultMarker = new maplibregl.Marker({
    element: searchResultMarkerElement(), anchor: 'center',
  }).setLngLat(lngLat).addTo(map);
  return searchResultMarker;
}

function showPlaceOnMap(point, name = 'Point on map', { searchResult = false } = {}) {
  const lng = Number(Array.isArray(point) ? point[0] : point?.lng);
  const lat = Number(Array.isArray(point) ? point[1] : point?.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
  const picker = document.getElementById('placePicker');
  if (picker && !picker.hidden) closePlacePicker();
  dismissRoadInfo();
  if (searchResult) showTemporaryMapMarker([lng, lat]);
  const token = ++searchResultOpenToken;
  const routeName = normalizeEndpointName(name) || 'Point on map';
  let rendered = false;
  const showCard = () => {
    if (rendered || token !== searchResultOpenToken) return;
    rendered = true;
    const lngLat = { lng, lat };
    // A chosen search result gets the SAME card as a map tap. It has no road
    // under it to score, so the safety block says so plainly rather than the
    // card quietly changing shape between the two ways of picking a point.
    renderMapTapCard({
      displayTitle: routeName,
      pointName: routeName,
      placeName: routeName,
      summary: searchResult ? 'Search result — no road information at this point.'
        : 'Use this point in your trip, or open Details.',
      rows: [], lngLat,
      anchorPoint: map.project(lngLat),
      swatchColor: searchResult ? '#7a3fc2' : '#52656f',
      swatchLabel: searchResult ? 'Search result' : 'Map location',
      debugData: {
        source: { id: searchResult ? 'place-search' : 'map-location',
          name: searchResult ? 'Place search result' : 'Map location' },
        selectedName: routeName,
      },
      avoidTemporaryMarker: true,
    });
    readoutPinned = true;
  };
  moveMapToPlace(lng, lat);
  map.once?.('moveend', showCard);
  setTimeout(showCard, 650);
  return true;
}

function moveMapToPlace(lng, lat) {
  const camera = { center: [lng, lat], zoom: Math.max(map.getZoom(), 14) };
  map.stop();
  // WebKit can retain several expensive tile generations over an animated
  // statewide-to-city zoom. A direct move has the same useful destination
  // framing and allocates only the final generation.
  if (constrainedMapRuntime) map.jumpTo(camera);
  else map.easeTo({ ...camera, duration: 450 });
}

function setUseLocationBusy(busy) {
  const button = document.getElementById('useLoc');
  if (!button) return;
  button.disabled = Boolean(busy);
  button.setAttribute('aria-busy', String(Boolean(busy)));
}

function setPlacePickerHint(kind = 'map', message = '') {
  const hint = document.getElementById('placePickerHint');
  if (!hint) return;
  hint.classList.toggle('location-error', kind === 'location-error');
  const icon = document.createElement('span');
  icon.className = 'picker-hint-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = kind === 'location-error' ? '!' : kind === 'internet' ? '◎'
    : placeSearchTarget ? '⌖' : '⌕';
  const copy = document.createElement('span');
  if (kind === 'map') {
    const lead = document.createElement('strong');
    if (placeSearchTarget === 'start') {
      lead.textContent = 'Tap the map to set your start';
      copy.append(lead, document.createTextNode(', or search for it.'));
    } else if (placeSearchTarget === 'end') {
      lead.textContent = 'Tap the map to set your destination';
      copy.append(lead, document.createTextNode(', or search for it.'));
    } else if (placeSearchTarget === 'via') {
      lead.textContent = 'Tap the map to add a stop';
      copy.append(lead, document.createTextNode(', or search for it.'));
    } else {
      lead.textContent = 'Search for a place.';
      copy.append(lead);
    }
  } else if (kind === 'location-error') {
    const lead = document.createElement('strong');
    lead.textContent = 'Couldn’t get your location.';
    copy.append(lead, document.createTextNode(message
      || ' Search or tap the map to set your start.'));
  } else {
    copy.textContent = message;
  }
  hint.replaceChildren(icon, copy);
}

function openPlaceSearch(target = null) {
  setRouteMoreMenuOpen(false);
  routing.arm = null;
  dismissRoadInfo();
  // Searching needs only the tiny local place index. Starting the 44 MB
  // routing graph here made an iPhone fetch/inflate/index it during the first
  // keyboard animation -- the field appeared to freeze before the rider had
  // even chosen a point. The router starts when both endpoints exist.
  ensurePlaces();
  placeSearchTarget = ['start', 'end', 'via'].includes(target) ? target : null;
  // Endpoint search also arms the map itself. The search card is deliberately
  // not modal: a rider can ignore the field and tap a point directly, with no
  // extra "tap the map" button in the way.
  routing.arm = placeSearchTarget;
  updateArmButtons();
  const targetLabel = placeSearchTarget === 'start' ? 'start'
    : placeSearchTarget === 'end' ? 'destination' : 'stop';
  document.getElementById('placePickerTitle').textContent = placeSearchTarget === 'via'
    ? 'Add stop' : placeSearchTarget ? `Set ${targetLabel}` : 'Find a place';
  setPlacePickerHint('map');
  // Device location is meaningful as a route start. It is deliberately absent
  // from Destination and generic place search so it cannot be offered as an
  // accidental destination.
  document.getElementById('useLoc').hidden = placeSearchTarget !== 'start';
  const searchInput = document.getElementById('placeSearch');
  searchInput.placeholder = placeSearchTarget === 'start' ? 'Search for a start…'
    : placeSearchTarget === 'end' ? 'Search for a destination…'
      : placeSearchTarget === 'via' ? 'Search for a stop…' : 'Search for a place…';
  searchInput.value = '';
  searchInput.classList.remove('current-endpoint-preview');
  searchInput.setAttribute('aria-label', placeSearchTarget === 'start' ? 'Search for a route start'
    : placeSearchTarget === 'end' ? 'Search for a route destination'
      : placeSearchTarget === 'via' ? 'Search for a route stop' : 'Search for a place');
  document.getElementById('placeResults').replaceChildren();
  document.getElementById('placeResults').classList.remove('show');
  setUseLocationBusy(false);
  const picker = document.getElementById('placePicker');
  // The chooser grows from the control that opened it. Besides making the
  // transition harder to miss, the three origins visually explain whether a
  // choice will set Start, set Destination, or merely Find a place.
  picker.dataset.openedFrom = placeSearchTarget || 'find';
  picker.hidden = false;
  document.body.classList.add('place-picker-open');
  setRouteStatus(placeSearchTarget
    ? placeSearchTarget === 'via' ? 'Search or tap the map to add a stop'
      : `Search or tap the map to set your ${targetLabel}`
    : 'Search for a place');
  // On a phone the keyboard obscures most of the map, including the location
  // the rider may be trying to tap. Open the on-map chooser first and wait for
  // an explicit tap on the search field. A desktop keyboard remains the
  // efficient default when there is no map-space tradeoff.
  if (window.innerWidth > 720
      && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    requestAnimationFrame(() => searchInput.focus({ preventScroll: true }));
  }
}

function readPendingMapRouteIntent() {
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_MAP_ROUTE_INTENT_KEY) || 'null');
    if (!value || value.version !== 1 || !Number.isFinite(value.createdAt)
        || Date.now() - value.createdAt > PENDING_MAP_ROUTE_INTENT_MAX_AGE_MS) {
      localStorage.removeItem(PENDING_MAP_ROUTE_INTENT_KEY);
      return null;
    }
    return value;
  } catch (error) { return null; }
}

function clearPendingMapRouteIntent() {
  try { localStorage.removeItem(PENDING_MAP_ROUTE_INTENT_KEY); } catch (error) { /* optional */ }
}

// A retained trip must survive the download it is waiting for. The intent
// expires an hour after it was written, but a large state pack can take
// longer — or finish after the phone sat overnight — so a completed install
// restamps the clock and the post-install reload still finds the trip.
function refreshPendingMapRouteIntent(stateId) {
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_MAP_ROUTE_INTENT_KEY) || 'null');
    if (value?.version !== 1) return;
    const waitingFor = [...new Set([value.stateId, ...(value.requiredStateIds || [])])];
    if (stateId && !waitingFor.includes(stateId)) return;
    localStorage.setItem(PENDING_MAP_ROUTE_INTENT_KEY,
      JSON.stringify({ ...value, createdAt: Date.now() }));
  } catch (error) { /* optional */ }
}

async function beginMapInstallForPlace(item, action, target = null) {
  const stateId = item?.stateId;
  if (!stateId || MapStore.availability(stateId) !== 'remote') return false;
  try {
    localStorage.setItem(PENDING_MAP_ROUTE_INTENT_KEY, JSON.stringify({
      version: 1, createdAt: Date.now(), action, target,
      stateId, point: [Number(item.lon), Number(item.lat)], name: item.name,
    }));
  } catch (error) {
    setRouteStatus('This device could not retain the trip while downloading the map.');
    return true;
  }
  closePlacePicker();
  setRouteStatus(`${placeStateConfig(stateId)?.name || 'That map'} is required for this trip.`);
  await openNationalStateCard(stateId);
  return true;
}

function choosePlaceSearchResult(lngLat, name, {
  fromDevice = false, stateId = Region.id, requiresDownload = false,
} = {}) {
  const target = placeSearchTarget;
  if (requiresDownload) {
    beginMapInstallForPlace({ ...lngLat, lon: lngLat.lng, lat: lngLat.lat, name, stateId },
      'choose-place', target);
    return;
  }
  if (!target) {
    showPlaceOnMap(lngLat, name, { searchResult: true });
    setRouteStatus('Search result shown — choose how to use it');
    return;
  }
  closePlacePicker();
  clearSearchResultMarker();
  if (target === 'via') {
    if (!addVia(lngLat, { name, stateId })) return;
    // addVia() reframes the complete itinerary. Do not first fly to the stop
    // and immediately fly back out, especially while the router is working.
    if (!(routing.start && routing.end)) moveMapToPlace(lngLat.lng, lngLat.lat);
    setRouteStatus(`Stop added: ${normalizeEndpointName(name) || 'Point on map'}`);
    return;
  }
  setRoutePoint(target, lngLat, name, {
    fromDevice: target === 'start' && fromDevice, stateId,
  });
  // When this choice completes the trip, computeRoute() owns the camera and
  // frames both points. The old point zoom followed by an immediate route fit
  // was the endpoint-selection memory spike that repeatedly killed iOS.
  if (!(routing.start && routing.end)) moveMapToPlace(lngLat.lng, lngLat.lat);
  const label = target === 'start' ? 'Start' : 'Destination';
  setRouteStatus(`${label} set to ${normalizeEndpointName(name) || 'Point on map'}`);
}

async function routeToPlaceSearchResult(lngLat, name, {
  stateId = Region.id, requiresDownload = false,
} = {}) {
  if (requiresDownload) {
    await beginMapInstallForPlace({ ...lngLat, lon: lngLat.lng, lat: lngLat.lat, name, stateId },
      'route-it');
    return;
  }
  // “Route It” is deliberately a new, simple trip: where the rider is now to
  // the selected result. Do not destroy an existing itinerary until location
  // succeeds, so a denied/slow GPS request cannot cost the rider their plan.
  const requestId = ++placeSearchRequestId;
  clearTimeout(placeSearchAutoTimer);
  placeSearchAutoTimer = 0;
  const results = document.getElementById('placeResults');
  results.setAttribute('aria-busy', 'true');
  results.querySelectorAll('.place-result-route').forEach((button) => { button.disabled = true; });
  setPlacePickerHint('status', 'Finding your current location to build the route…');
  setRouteStatus('Finding current location…');
  try {
    const pos = await getFreshDevicePosition({ timeout: 30000, retryUntilUsable: true });
    if (requestId !== placeSearchRequestId) return;
    clearRoute();
    clearSearchResultMarker();
    setDeviceStart(pos);
    // The fix above is brand new. Suppress the ordinary “new destination”
    // refresh so this one action does not immediately ask Core Location for
    // the same point a second time.
    setRoutePoint('end', lngLat, name, { refreshDeviceStart: false, stateId });
    setRouteStatus(`Routing to ${normalizeEndpointName(name) || 'selected place'}`);
  } catch {
    if (requestId !== placeSearchRequestId) return;
    results.removeAttribute('aria-busy');
    results.querySelectorAll('.place-result-route').forEach((button) => { button.disabled = false; });
    setPlacePickerHint('location-error', ' Choose Map to inspect it, or try Route It again.');
    setRouteStatus('');
  }
}

async function resumePendingMapRouteIntent() {
  const intent = readPendingMapRouteIntent();
  if (!intent) return false;
  if (MapStore.availability(intent.stateId) === 'remote') {
    await openNationalStateCard(intent.stateId);
    return true;
  }
  if (intent.action === 'resume-route') {
    const remaining = (intent.requiredStateIds || [])
      .filter((stateId) => MapStore.availability(stateId) === 'remote');
    if (remaining.length) {
      const next = { ...intent, stateId: remaining[0], requiredStateIds: remaining,
        createdAt: Date.now() };
      try { localStorage.setItem(PENDING_MAP_ROUTE_INTENT_KEY, JSON.stringify(next)); }
      catch (error) { clearPendingMapRouteIntent(); }
      await openNationalStateCard(remaining[0]);
      return true;
    }
    clearPendingMapRouteIntent();
    if (routing.start && routing.end) {
      // A slim first launch is still at the national overview when the map
      // finishes installing. Frame the retained trip immediately instead of
      // leaving the rider looking at the whole country while the statewide
      // graph initializes; the completed route will refine the same view.
      fitRouteBounds({
        s: routing.start, e: routing.end,
        v: routing.vias.map((via) => via.pt),
        b: routing.blocks.map((block) => block.pt),
      });
      computeRoute();
    }
    setRouteStatus('Required maps installed. Resuming this trip…');
    return true;
  }
  const [lng, lat] = intent.point || [];
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    clearPendingMapRouteIntent();
    return false;
  }
  clearPendingMapRouteIntent();
  const point = { lng, lat };
  if (intent.action === 'route-it') {
    await routeToPlaceSearchResult(point, intent.name, { stateId: intent.stateId });
    return true;
  }
  if (intent.target === 'via') {
    addVia(point, { name: intent.name, stateId: intent.stateId });
  } else if (['start', 'end'].includes(intent.target)) {
    setRoutePoint(intent.target, point, intent.name, { stateId: intent.stateId });
    if (!(routing.start && routing.end)) moveMapToPlace(lng, lat);
  } else {
    showPlaceOnMap(point, intent.name, { searchResult: true });
  }
  setRouteStatus(`${normalizeEndpointName(intent.name) || 'Place'} restored after map installation.`);
  return true;
}

function buildPlacePicker() {
  const input = document.getElementById('placeSearch');
  const results = document.getElementById('placeResults');
  const TYPE_LABEL = { city: 'city', town: 'town', village: 'village', hamlet: 'hamlet',
    suburb: 'suburb', neighbourhood: 'neighborhood', ferry: 'ferry terminal',
    coordinates: 'coordinates' };

  const uniqueMatches = (items) => {
    const unique = [];
    for (const item of items) {
      const label = item.name.trim().toLowerCase();
      // Prefer stable source identity when a source carries it. Older compact
      // indexes do not, so border copies also get a display-only name/spatial
      // collapse. Neither rule changes graph topology or routing portals.
      const duplicate = unique.some((prior) => (item.sourceId && prior.sourceId === item.sourceId)
        || (prior.name.trim().toLowerCase() === label
          && navDistanceM([prior.lon, prior.lat], [item.lon, item.lat]) < 120));
      if (!duplicate) unique.push(item);
    }
    return unique;
  };

  const searchScopeStateNames = () => {
    const ids = placeSearchLoadedStateIds.length ? placeSearchLoadedStateIds
      : [...new Set((placesIndex || []).map((row) => row?.stateId || row?.[5] || Region.id))];
    return ids.map((id) => placeStateConfig(id)?.name || id).sort((a, b) => a.localeCompare(b));
  };

  const render = (items, message = '', { offerInternet = false, onlineItems = [] } = {}) => {
    results.replaceChildren();
    const appendItems = (matches, label = '') => {
      if (label && matches.length) {
        const heading = document.createElement('p');
        heading.className = 'place-results-section';
        heading.textContent = label;
        results.append(heading);
      }
      for (const item of matches) {
        const hit = document.createElement('div');
        hit.className = 'place-hit place-result-row';
        hit.dataset.lon = String(item.lon);
        hit.dataset.lat = String(item.lat);
        hit.dataset.name = item.name;
        hit.dataset.stateId = item.stateId || Region.id;
        hit.dataset.sourceId = item.sourceId || '';
        hit.dataset.requiresDownload = String(Boolean(item.requiresDownload));
        const summary = document.createElement('button');
        summary.type = 'button';
        summary.className = 'place-result-summary';
        summary.setAttribute('aria-label', placeSearchTarget
          ? `Choose ${item.name}` : `Show ${item.name} on map`);
        const resultName = document.createElement('span');
        resultName.className = 'place-result-name';
        resultName.textContent = item.name;
        const detail = document.createElement('small');
        const stateName = placeStateConfig(item.stateId)?.name || item.stateId || Region.name;
        detail.textContent = item.requiresDownload
          ? `${TYPE_LABEL[item.type] || item.type || 'place'} · ${stateName} · Download map`
          : item.source === 'online'
          ? (Number.isFinite(item.distanceM)
            ? `${item.type ? `${item.type} · ` : ''}${stateName} · ${fmtMi(item.distanceM)} mi from map center · online`
            : `${stateName} · online · OpenStreetMap`)
          : `${TYPE_LABEL[item.type] || item.type || 'place'} · ${stateName}`;
        summary.append(resultName, detail);
        hit.append(summary);
        // Targeted Start/Destination/Stop searches keep their direct one-tap
        // assignment. Generic Find results add the two explicit choices the
        // rider needs: make a fresh trip, or simply inspect the point.
        if (!placeSearchTarget) {
          const actions = document.createElement('div');
          actions.className = 'place-result-actions';
          const route = document.createElement('button');
          route.type = 'button';
          route.className = 'place-result-route';
          route.textContent = 'Route It';
          route.setAttribute('aria-label', `Route from current location to ${item.name}`);
          const show = document.createElement('button');
          show.type = 'button';
          show.className = 'place-result-map';
          show.textContent = 'Map';
          show.setAttribute('aria-label', `Show ${item.name} on map`);
          actions.append(route, show);
          hit.append(actions);
        }
        results.append(hit);
      }
    };
    const onDevice = items.filter((item) => !item.requiresDownload);
    const available = items.filter((item) => item.requiresDownload);
    appendItems(onDevice, (onlineItems.length || available.length) && onDevice.length
      ? 'On this device' : '');
    appendItems(available, 'Available maps');
    if (message) {
      const notice = document.createElement('p');
      notice.className = 'place-results-message';
      notice.setAttribute('role', 'status');
      notice.textContent = message;
      results.append(notice);
    }
    appendItems(onlineItems, items.length ? 'From the internet' : 'Internet results');
    if (items.length || onlineItems.length || message || offerInternet) {
      const scope = document.createElement('p');
      scope.className = 'place-results-scope';
      const names = searchScopeStateNames();
      scope.textContent = navigator.onLine === false
        ? `Offline search covers installed maps: ${names.join(', ') || 'none'}.`
        : `On-device search covers installed maps: ${names.join(', ') || 'none'}.`;
      results.append(scope);
    }
    if (offerInternet) {
      const internet = document.createElement('button');
      internet.type = 'button';
      internet.className = 'place-hit place-internet-search';
      internet.dataset.internetSearch = 'true';
      internet.append(document.createTextNode('Search with internet'));
      const detail = document.createElement('small');
      detail.textContent = 'More places and landmarks';
      internet.append(detail);
      results.append(internet);
    }
    results.classList.toggle('show', items.length > 0 || onlineItems.length > 0
      || Boolean(message) || offerInternet);
  };

  // A pasted coordinate pair is a place. Every routing bug worth reporting is
  // a pair of points, and until now the only way to reach an exact one was to
  // tap the map and hope -- which is useless for anything smaller than a few
  // hundred metres. Point Defiance is unreachable from downtown Tacoma inside a
  // dead zone tens of metres wide, and `places.json` has no record for it at
  // all, so no amount of typing its name gets you there.
  //
  // Accepts what people actually have in the clipboard: "[-122.4443, 47.2529]",
  // "-122.4443, 47.2529", "-122.4443 47.2529", and the same three in the
  // lat-first order Google Maps hands out. Order is resolved by which reading
  // lands inside the region rather than by asking the rider to know; where both
  // readings are in bounds, lon-lat wins because that is the order the rest of
  // this codebase speaks.
  const coordinateMatch = () => {
    const raw = input.value.trim();
    const numbers = raw.replace(/^[[(\s]+|[\])\s]+$/g, '').split(/[,\s]+/)
      .filter(Boolean).map(Number);
    if (numbers.length !== 2 || !numbers.every(Number.isFinite)) return null;
    const [first, second] = numbers;
    const candidates = [[first, second], [second, first]]
      .filter(([lon, lat]) => Math.abs(lon) <= 180 && Math.abs(lat) <= 90)
      .map(([lon, lat]) => ({ lon, lat, stateId: placeStateIdAt(lon, lat) }))
      .filter((item) => placeStateIsDiscoverable(item.stateId));
    if (!candidates.length) return null;
    const { lon, lat, stateId } = candidates[0];
    return { name: `${lon.toFixed(5)}, ${lat.toFixed(5)}`, lon, lat,
      type: 'coordinates', source: 'local', stateId,
      requiresDownload: MapStore.availability(stateId) === 'remote' };
  };

  const localMatches = () => {
    const coordinate = coordinateMatch();
    if (coordinate) return [coordinate];
    const q = input.value.trim().toLowerCase();
    if (!q || !placesIndex) return [];
    const starts = [], contains = [];
    for (const p of placesIndex) {
      const row = Array.isArray(p) ? {
        name: p[0], lon: p[1], lat: p[2], type: p[3], stateId: p[5] || Region.id,
        sourceId: p[6] || placeSourceIdentity(p[5] || Region.id, p), source: 'local',
      } : p;
      const n = row.name.toLowerCase();
      if (n.startsWith(q)) starts.push(row);
      else if (n.includes(q)) contains.push(row);
    }
    if (navigator.onLine !== false) {
      for (const item of availablePlacesIndex) {
        const n = item.name.toLowerCase();
        if (n.startsWith(q)) starts.push(item);
        else if (n.includes(q)) contains.push(item);
      }
    }
    return uniqueMatches(starts.concat(contains)).slice(0, 8);
  };

  const showLocalMatches = () => {
    const query = input.value.trim();
    const local = localMatches();
    clearTimeout(placeSearchAutoTimer);
    placeSearchAutoTimer = 0;
    // A coordinate is already an exact answer: no online lookup, no offer of
    // one. Two numbers that parse but fall outside the loaded state say so,
    // rather than silently becoming a failed name search.
    const isCoordinate = local.length === 1 && local[0].type === 'coordinates';
    if (isCoordinate) {
      render(local, '', { offerInternet: false });
      return;
    }
    const numbers = query.replace(/^[[(\s]+|[\])\s]+$/g, '').split(/[,\s]+/)
      .filter(Boolean).map(Number);
    if (numbers.length === 2 && numbers.every(Number.isFinite)) {
      render([], `That point is outside ${Region.name}.`, { offerInternet: false });
      return;
    }
    const online = navigator.onLine !== false;
    const shouldSearchOnline = online && query.length >= 2
      && Array.isArray(placesIndex) && local.length === 0;
    render(local, shouldSearchOnline ? 'No offline matches. Searching the internet…' : '',
      { offerInternet: online && query.length >= 2 });
    if (shouldSearchOnline) {
      const expectedQuery = query;
      placeSearchAutoTimer = setTimeout(() => {
        placeSearchAutoTimer = 0;
        if (input.value.trim() === expectedQuery && localMatches().length === 0) {
          searchOnline({ automatic: true });
        }
      }, ONLINE_PLACE_AUTO_DELAY_MS);
    }
  };
  const searchOnline = async ({ automatic = false } = {}) => {
    clearTimeout(placeSearchAutoTimer);
    placeSearchAutoTimer = 0;
    const query = input.value.trim();
    if (query.length < 2) {
      setRouteStatus('Enter at least two characters to search online');
      return;
    }
    setPlacePickerHint('internet', automatic ? 'No offline matches — searching nearby places online.'
      : placeSearchTarget
        ? `Adding internet results below local matches for your ${placeSearchTarget === 'via'
          ? 'stop' : placeSearchTarget === 'start' ? 'start' : 'destination'}.`
        : 'Adding internet results below local matches.');
    const requestId = ++placeSearchRequestId;
    const local = localMatches();
    render(local, `Searching the internet for “${query}”…`);
    try {
      const onlineMatches = await searchOnlinePlaces(query);
      if (requestId !== placeSearchRequestId || input.value.trim() !== query) return;
      const combined = uniqueMatches([...local, ...onlineMatches]);
      const matches = combined.filter((item) => item.source === 'online');
      render(local, matches.length ? ''
        : `No additional internet results for “${query}”.`, {
        onlineItems: matches,
        // A valid but empty response can be transient (or location-biased in
        // an unhelpful direction). Keep an explicit retry path just as we do
        // for a network error instead of leaving an empty, terminal picker.
        offerInternet: matches.length === 0,
      });
      setRouteStatus(onlineMatches.length
        ? `${onlineMatches.length} internet ${onlineMatches.length === 1 ? 'result' : 'results'} found`
        : 'No internet search results');
    } catch (e) {
      if (requestId === placeSearchRequestId) {
        render(local, local.length
          ? 'Internet search is unavailable. Local results are still available.'
          : 'Internet search is unavailable. You can try again or keep typing.',
          { offerInternet: true });
        setRouteStatus('Internet search unavailable');
      }
    }
  };

  input.addEventListener('focus', () => {
    ensurePlaces();
  });
  input.addEventListener('input', () => {
    placeSearchRequestId++;
    clearTimeout(placeSearchAutoTimer);
    placeSearchAutoTimer = 0;
    setUseLocationBusy(false);
    setPlacePickerHint('map');
    const query = input.value.trim();
    ensurePlaces().then(() => { if (input.value.trim() === query) showLocalMatches(); });
    showLocalMatches();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const firstResult = results.querySelector('.place-hit:not(.place-internet-search)');
      if (firstResult) firstResult.click();
      else results.querySelector('.place-internet-search')?.click();
    }
  });
  results.addEventListener('click', (e) => {
    const hit = e.target.closest('.place-hit');
    if (!hit) return;
    if (hit.dataset.internetSearch === 'true') {
      searchOnline();
      return;
    }
    const lngLat = { lng: Number(hit.dataset.lon), lat: Number(hit.dataset.lat) };
    const name = hit.dataset.name;
    const options = { stateId: hit.dataset.stateId || Region.id,
      requiresDownload: hit.dataset.requiresDownload === 'true' };
    if (e.target.closest('.place-result-route')) {
      routeToPlaceSearchResult(lngLat, name, options);
      return;
    }
    input.value = '';
    render([]);
    choosePlaceSearchResult(lngLat, name, options);
  });

  document.getElementById('placePickerClose').addEventListener('click', closePlacePicker);
  document.getElementById('useLoc').addEventListener('click', () => {
    const requestId = ++placeSearchRequestId;
    setUseLocationBusy(true);
    setPlacePickerHint('status', 'Finding your location…');
    setRouteStatus('Locating…');
    const stillFindingTimer = setTimeout(() => {
      if (requestId === placeSearchRequestId) {
        setPlacePickerHint('status', 'Still finding your location…');
      }
    }, 6000);
    getFreshDevicePosition({ timeout: 30000, retryUntilUsable: true }).then((pos) => {
      clearTimeout(stillFindingTimer);
      if (requestId !== placeSearchRequestId) return;
      setUseLocationBusy(false);
      const lngLat = { lng: pos.coords.longitude, lat: pos.coords.latitude };
      choosePlaceSearchResult(lngLat, 'My location', { fromDevice: true });
      // When that became the trip's device start, arm the same accuracy
      // ratchet the other device-start paths get from setDeviceStart().
      if (routing.startFromDevice) {
        const accuracy = Number(pos.coords.accuracy);
        routing.deviceStartAccuracyM = Number.isFinite(accuracy) ? accuracy : null;
        refineDeviceStartWhilePlanning();
      }
    }).catch(() => {
      clearTimeout(stillFindingTimer);
      if (requestId !== placeSearchRequestId) return;
      setUseLocationBusy(false);
      setPlacePickerHint('location-error');
      setRouteStatus('');
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
  'facility-gap': 'bike space ends in traffic',
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
  'facility-gap': 'Protected bike space briefly ends at a short one-way shared-traffic '
    + 'connector on a through road. Routes strongly avoid this transition.',
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
      // Name the shoulder as well as the triggers. Without it this rung's only
      // fact was the speed -- and the speed is identical on the card of a road
      // that PASSES at the same speed with a wide enough shoulder. A rider
      // tapping two stretches of one highway got "fails: 55 mph" and "passes;
      // 55 mph" and no way to tell what actually differed (field report, OR 224
      // at Three Lynx, where the inventory alternates 0/1/3/4/10 ft).
      const shHere = shUnknown
        ? 'No shoulder is recorded here'
        : `The shoulder here is ${sh} ft${shSource}`;
      return `Needs a bike lane or a safe-ish-width shoulder: ${why.join(', ')}.`
        + ` ${shHere}, against your ${rules.minShoulder} ft minimum.`;
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
  // The test is >=, so a shoulder exactly at the minimum is not "over" it.
  // Saying so reads as sloppy in precisely the place a rider is deciding
  // whether to trust the verdict.
  const vsMin = `${sh > rules.minShoulder ? 'over' : 'meeting'} your ${rules.minShoulder} ft minimum`;
  if ((n.facility || 0) >= 2 || n.good_facility) met.push('Has a bike lane or better');
  else if (!shUnknown) met.push(`${sh} ft shoulder, ${vsMin}`);
  else if (shInferred) met.push(`${sh} ft shoulder${shSource}, ${vsMin}`);
  else met.push(`No shoulder recorded, and this road is not fast or busy enough to need one`);
  if (spd != null)
    met.push(rules.noUpperLimit
      ? `${spdTxt}, and you have set no speed limit`
      : `${spdTxt}, under your ${rules.upperMaxSpeed} mph limit`);
  return `${met.join('; ')}.${cautionNote}`;
}

const HIT_LAYERS = [];  // hit-layer ids, registered as sources attach
const HIT_SRC = {};     // hit-layer id -> its source
// Clicking/tapping PINS the readout (so its links are clickable). Hover no
// longer previews a card -- mousemove only turns the cursor into a pointer
// over an inspectable feature; the card itself always comes from a click.
let readoutPinned = false;
let roadInfoSuppressedUntil = 0;

function dismissRoadInfo() {
  clearSearchResultMarker();
  clearTapHighlight();
  clearRouteElevationSelection();
  readoutPinned = false;
  readoutEl.classList.remove('show');
}

/* The tapped stretch of road, drawn while its card is open. Vector-tile
 * geometry is clipped at tile edges, so a long road highlights the piece the
 * tap landed in rather than its whole length -- which is the piece the card is
 * describing anyway.
 */
function showTapHighlight(geometry) {
  const source = map.getSource('tap-highlight');
  if (!source || !geometry) return false;
  const type = geometry.type;
  if (type !== 'LineString' && type !== 'MultiLineString') return false;
  source.setData({ type: 'Feature', properties: {}, geometry });
  for (const id of TAP_HIGHLIGHT_LAYERS) {
    if (!map.getLayer(id)) continue;
    // Back to the top every time. These layers are created with the permanent
    // ones at style load, but drawRoute() adds the route's own layers later
    // and they land ABOVE -- so a tap on the drawn route painted the highlight
    // underneath it, which is exactly the case a rider taps most.
    map.moveLayer(id);
    setLayout(id, 'visibility', 'visible');
  }
  startTapRipple();
  return true;
}

function clearTapHighlight() {
  stopTapRipple();
  for (const id of TAP_HIGHLIGHT_LAYERS) {
    if (map.getLayer(id)) setLayout(id, 'visibility', 'none');
  }
  const source = map.getSource('tap-highlight');
  if (source) source.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } });
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

// Route badges are controls as well as explanations. They sit above the route
// and often extend well beyond its invisible line hit target, so asking only
// what road is under the finger makes taps at their edge arbitrary. Resolve a
// visible badge first and use its source point (which is exactly on the route)
// to identify the segment the badge explains.
const ACTIVE_ROUTE_ICON_LAYERS = [
  'route-fail-marker', 'route-marker', 'route-dismount-marker',
  'route-dismount-halo', 'route-ferry-marker',
];
const ACTIVE_ROUTE_ICON_HIT_PX = 26;
function activeRouteIconAt(point) {
  const layers = ACTIVE_ROUTE_ICON_LAYERS.filter((id) => map.getLayer(id)
    && map.getLayoutProperty(id, 'visibility') !== 'none');
  if (!layers.length) return null;
  const pad = ACTIVE_ROUTE_ICON_HIT_PX;
  const features = map.queryRenderedFeatures(
    [[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]], { layers });
  let best = null, bestDistance = Infinity;
  for (const feature of features) {
    const distance = screenDistanceToFeature(point, feature);
    if (distance <= ACTIVE_ROUTE_ICON_HIT_PX && distance < bestDistance) {
      best = feature;
      bestDistance = distance;
    }
  }
  return best;
}

function routeSegmentForActiveIcon(icon) {
  if (!icon || !routing.last?.ok) return null;
  const coordinates = icon.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  let routeIndex = Number(icon.properties?.routeIndex);
  if (!Number.isInteger(routeIndex) || !routing.last.segs?.[routeIndex]) {
    routeIndex = routeSegmentIndexNearTap(routing.last,
      { lng: coordinates[0], lat: coordinates[1] }, 50);
  }
  if (!Number.isInteger(routeIndex)) return null;
  const feature = routeSegmentMapFeature(
    routing.last.coords, routing.last.segs[routeIndex], routeIndex);
  if (!feature) return null;
  // renderReadout uses this pseudo-layer to select the active-route scorer.
  feature.layer = { id: 'route-seg-hit' };
  return { feature, routeIndex,
    lngLat: { lng: coordinates[0], lat: coordinates[1] } };
}

// Resolve what the rider can actually see before consulting the deliberately
// broader transparent hit layers. The hit archive contains every street in a
// tile, including local streets the basemap hides until neighbourhood zoom;
// without this first pass an invisible residential street could steal a tap
// aimed at a visible designated-route ribbon.
function visibleFeatureAt(point, pad = 6) {
  const candidates = new Map();
  const roadsHit = 'roads__hit';
  for (const id of ['basemap-major', 'basemap-medium', 'basemap-minor', 'basemap-local']) {
    if (map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none') {
      candidates.set(id, roadsHit);
    }
  }
  const addSourceLayers = (src, visibleLayers, targetLayer = hitId(src)) => {
    if (!src || (!src.enabled && !src.alwaysOn && !src.fixed && !src.closure)) return;
    for (const id of visibleLayers) {
      if (map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none') {
        candidates.set(id, targetLayer);
      }
    }
  };
  const routes = SOURCES.find((src) => src.id === 'routes');
  addSourceLayers(routes, ['routes'], 'routes__hit');
  const osm = SOURCES.find((src) => src.id === 'osm');
  addSourceLayers(osm, [trailBaseId(osm || { id: 'osm' }), trailId(osm || { id: 'osm' })],
    'osm__trail-hit');
  for (const src of SOURCES) {
    if (['roads', 'osm', 'routes', 'blts'].includes(src.id)) continue;
    if (src.closure) addSourceLayers(src, [src.id, `${src.id}__line`], src.id);
    else addSourceLayers(src,
      [src.id, failId(src), vhId(src), cautionId(src), prohibitedId(src)]);
  }
  const layers = [...candidates.keys()];
  if (!layers.length) return null;
  const rendered = map.queryRenderedFeatures(
    [[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]], { layers });
  if (!rendered.length) return null;
  const features = rendered.map((feature) => ({ ...feature,
    // MapLibre decodes geometry through a lazy prototype getter. Object spread
    // does not copy that getter, so materialize it before replacing the layer
    // id or road taps lose highlighting, nearest-distance ranking and heading.
    geometry: feature.geometry,
    layer: { ...feature.layer, id: candidates.get(feature.layer.id) } }));
  const isRibbon = (feature) => !!(HIT_SRC[feature.layer.id] || {}).ribbon;
  const scored = features.filter((feature) => !isRibbon(feature));
  const pool = scored.length ? scored : features;
  return dodgeBannedHit(point, pool, nearestOfHits(point, pool));
}

// The active route's own feature under a point, honoured within the widened
// route-seg-hit band only; null with no trip drawn, so ordinary resolution
// is untouched the rest of the time.
function activeRouteFeatureAt(point) {
  if (!routing.last?.ok || !map.getLayer('route-seg-hit')) return null;
  // As an [x, y] pair: a bare {x, y} object is not a PointLike to MapLibre,
  // which silently queries the whole viewport instead of the point.
  const hits = map.queryRenderedFeatures([point.x, point.y], { layers: ['route-seg-hit'] });
  return hits.length ? nearestOfHits(point, hits) : null;
}

function featureAt(point) {
  const layers = HIT_LAYERS.filter(
    (id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none'
  );
  if (!layers.length) return null;
  // Tapping the dismount marker has to answer, and the marker is wider than the
  // route line under it -- a tap on the triangle's corner would otherwise miss
  // the line and return whatever road happened to be behind it.
  const onMarker = dismountMarkerAt(point);
  const pad = onMarker ? DISMOUNT_MARKER_HIT_PX : 6;
  if (!onMarker) {
    // The drawn route answers first inside its own hit band -- the same
    // draw-order claim the dismount marker makes in its halo. The route is
    // what the rider is mid-trip with, and the visible-first pass below does
    // not know route layers, so without this a tap ON the drawn line
    // returned whichever street ran beneath it (field report, zoomed out).
    // A street stays one finger-width away from the line.
    const routeHit = activeRouteFeatureAt(point);
    if (routeHit) return routeHit;
    const visible = visibleFeatureAt(point, pad);
    if (visible) return visible;
  }
  const feats = map.queryRenderedFeatures(
    [[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]],
    { layers }
  );
  if (!feats.length) return null;
  const isRibbon = (f) => !!(HIT_SRC[f.layer.id] || {}).ribbon;
  const scored = feats.filter((f) => !isRibbon(f));
  const pool = scored.length ? scored : feats;
  // Nearest-wins is wrong inside a marker's halo, and the reason is the widened
  // pad above. That pad exists to REACH PAST the nearest thing -- a tap on the
  // triangle's corner is genuinely closer to whatever road runs under the
  // marker than to the route line the marker belongs to, so measuring distance
  // hands back the road and the marker stops answering for itself. Draw order
  // is the right rule here: the marker's own layer is on top because the
  // marker is what was tapped.
  if (onMarker) return pool[0];
  return dodgeBannedHit(point, pool, nearestOfHits(point, pool));
}

// A tap that could mean a rideable way or a bikes-banned one beside it means
// the rideable way -- the same doctrine as the router's node snapping ("a tap
// beside I-90 should not board I-90"). Beside the Interurban Trail the
// nearest record is I-5's, and handing the rider a banned freeway's card for
// a tap aimed at the trail is never the answer they wanted. Everything in
// the pool is already inside the tap box, so no extra reach is granted; the
// banned road's own card remains one clean tap away from anything else.
function hitProhibited(feature) {
  const src = HIT_SRC[feature.layer?.id];
  if (!src?.scorer) return false;
  try { return !!src.scorer(feature.properties || {}).prohibited; } catch (e) { return false; }
}
function dodgeBannedHit(point, pool, pick) {
  if (!pick || !hitProhibited(pick)) return pick;
  const rideable = pool.filter((feature) => !hitProhibited(feature));
  return rideable.length ? nearestOfHits(point, rideable) : pick;
}

// Point-to-segment distance in screen pixels.
function pointToSegmentPx(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1,
    ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// A clipped tile line is short; the cap only guards against a pathological one.
const HIT_VERTEX_LIMIT = 400;
function screenDistanceToFeature(point, feature) {
  const g = feature.geometry;
  const parts = !g ? null
    : g.type === 'LineString' ? [g.coordinates]
      : g.type === 'MultiLineString' ? g.coordinates
        : g.type === 'Point' ? [[g.coordinates]] : null;
  if (!parts) return Infinity;
  let best = Infinity, seen = 0;
  for (const line of parts) {
    let prev = null;
    for (const c of line) {
      if (++seen > HIT_VERTEX_LIMIT) return best;
      const p = map.project(c);
      best = Math.min(best, prev
        ? pointToSegmentPx(point, prev, p)
        : Math.hypot(p.x - point.x, p.y - point.y));
      prev = p;
    }
  }
  return best;
}

// Which of the features inside the pad box the rider actually pointed at.
//
// queryRenderedFeatures returns everything in the box in DRAW order, and this
// used to take the topmost. At a boundary between two segments of one highway
// that is a coin flip between two records which legitimately disagree: OR 224
// at Three Lynx books 3 ft on one segment and 4 ft on the next, so two taps a
// moment apart produced "Fails your rules" and "Passes your rules" on the same
// road, with nothing in either card to explain the difference. Nearest is the
// question the rider is asking.
const HIT_TIE_PX = 0.5;
function nearestOfHits(point, feats) {
  if (feats.length < 2) return feats[0] || null;
  const scored = feats.map((f) => ({ f, d: screenDistanceToFeature(point, f) }));
  const nearest = Math.min(...scored.map((s) => s.d));
  // Within the tie band, draw order still decides -- except for the one case
  // below, so a near-tie stays as stable as it was before.
  const tied = scored.filter((s) => s.d <= nearest + HIT_TIE_PX).map((s) => s.f);
  return reconcileCoincident(tied);
}

// Genuinely coincident records describing one place.
//
// Prefer a measured shoulder over a blank one: an absent measurement is not a
// measurement of zero. (The safety model separately scores an UNKNOWN shoulder
// as 0 -- that is the right policy for "we know nothing about this road", and
// the wrong rule for "we hold four records and one row is unpopulated".)
// Among measured values take the lowest, because this is a safety verdict and
// the conservative reading is the one a rider can act on.
//
// Direction is not duplication: `224d` and `224i` are the two sides of one road
// and wsdotShoulderText() reports both, so only records sharing a
// RouteIdentifier are reconciled here.
function reconcileCoincident(feats) {
  if (feats.length < 2) return feats[0] || null;
  const head = feats[0];
  const id = head.properties?.RouteIdentifier;
  if (id == null) return head;
  const siblings = feats.filter((f) => f.properties?.RouteIdentifier === id);
  if (siblings.length < 2) return head;
  const measured = siblings.filter((f) => f.properties?.ShoulderWidth != null);
  if (!measured.length) return head;
  return measured.reduce((a, b) =>
    (b.properties.ShoulderWidth < a.properties.ShoulderWidth ? b : a));
}

// Sources that are hit-tested but never painted.
//
// applyDisplayMode() filters every blts paint layer to false, because the
// agency's increasing- and decreasing-milepost inventory lines would draw on
// top of one another; the state-highway verdict is conflated onto the matching
// OSM centreline in roads.pmtiles instead, and THAT is what a rider sees. The
// card kept evaluating the tapped inventory record, which made it the only
// voice in the app that could disagree with the map and the route at once.
const UNPAINTED_SOURCES = new Set(['blts']);

// The painted road under a tap. roads.pmtiles is the source the tile build and
// the graph build share a decision layer over (test_build_parity.py), so its
// verdict is both the one on screen and the one the router used.
function paintedRoadAt(point) {
  const layer = 'roads__hit';
  if (!point || !map.getLayer(layer)) return null;
  if (map.getLayoutProperty(layer, 'visibility') === 'none') return null;
  const pad = 6;
  return nearestOfHits(point, map.queryRenderedFeatures(
    [[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]],
    { layers: [layer] }));
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
  delete readoutEl.dataset.pinPlacement;
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

// A searched or inspected place has a temporary pin that must stay visible
// while the rider decides what it means. Use the pin's actual rendered bounds
// and choose the side with the most useful remaining room. On a phone this is
// normally above or below; a wider map can naturally place the card beside it.
function positionPlaceCardAwayFromPin(point) {
  const edgeGap = 10;
  const pinGap = 10;
  const mapRect = map.getContainer().getBoundingClientRect();
  const parentRect = readoutEl.offsetParent?.getBoundingClientRect() || { left: 0, top: 0 };
  readoutEl.classList.add('near-tap');
  readoutEl.style.left = '0px';
  readoutEl.style.right = 'auto';
  readoutEl.style.top = '0px';
  readoutEl.style.bottom = 'auto';
  const cardRect = readoutEl.getBoundingClientRect();
  const tapX = mapRect.left + point.x;
  const tapY = mapRect.top + point.y;
  const renderedPin = searchResultMarker?.getElement?.().getBoundingClientRect();
  const pinWidth = renderedPin?.width || 20;
  const pinHeight = renderedPin?.height || 20;
  // During a search camera move, MapLibre can fire moveend one paint before
  // the marker DOM transform catches up. The projected coordinate is already
  // final, so centre the symmetric target there instead of positioning the
  // card around a stale rendered rectangle.
  const pinRect = {
    left: tapX - pinWidth / 2,
    right: tapX + pinWidth / 2,
    top: tapY - pinHeight / 2,
    bottom: tapY + pinHeight / 2,
    width: pinWidth,
    height: pinHeight,
  };
  const minLeft = mapRect.left + edgeGap;
  const maxLeft = Math.max(minLeft, mapRect.right - edgeGap - cardRect.width);
  const minTop = mapRect.top + edgeGap;
  const maxTop = Math.max(minTop, mapRect.bottom - edgeGap - cardRect.height);
  const clampLeft = (left) => Math.min(maxLeft, Math.max(minLeft, left));
  const clampTop = (top) => Math.min(maxTop, Math.max(minTop, top));
  const centeredLeft = clampLeft((pinRect.left + pinRect.right - cardRect.width) / 2);
  const centeredTop = clampTop((pinRect.top + pinRect.bottom - cardRect.height) / 2);
  const available = {
    below: mapRect.bottom - edgeGap - pinRect.bottom,
    above: pinRect.top - (mapRect.top + edgeGap),
    right: mapRect.right - edgeGap - pinRect.right,
    left: pinRect.left - (mapRect.left + edgeGap),
  };
  const candidates = [
    { side: 'below', need: cardRect.height + pinGap, room: available.below,
      left: centeredLeft, top: pinRect.bottom + pinGap },
    { side: 'above', need: cardRect.height + pinGap, room: available.above,
      left: centeredLeft, top: pinRect.top - pinGap - cardRect.height },
    { side: 'right', need: cardRect.width + pinGap, room: available.right,
      left: pinRect.right + pinGap, top: centeredTop },
    { side: 'left', need: cardRect.width + pinGap, room: available.left,
      left: pinRect.left - pinGap - cardRect.width, top: centeredTop },
  ];
  const fitting = candidates.filter((candidate) => candidate.room >= candidate.need)
    .sort((a, b) => (b.room - b.need) - (a.room - a.need));
  const chosen = fitting[0] || candidates.sort((a, b) =>
    (b.room / Math.max(1, b.need)) - (a.room / Math.max(1, a.need)))[0];
  const viewportLeft = clampLeft(chosen.left);
  const viewportTop = clampTop(chosen.top);
  readoutEl.dataset.pinPlacement = chosen.side;
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
  let best = null;
  for (const f of feats) {
    const q = f.properties;
    if (routeBaseId(q.RouteIdentifier) !== base) continue;
    if (String(q.RouteIdentifier) === String(p.RouteIdentifier)) continue;
    if (q.ShoulderWidth == null || q.ShoulderWidth === p.ShoulderWidth) continue;
    // Several records can describe the far side at one point, and this used to
    // return whichever the query happened to list first. Take the narrowest,
    // for the same reason reconcileCoincident() does.
    if (!best || q.ShoulderWidth < best.ShoulderWidth) best = q;
  }
  return best;
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

// The grade of a road the rider tapped that is NOT on their route.
//
// Map tiles carry no elevation, so this one fact has to come from the routing
// graph, which means it arrives after the card is already on screen. The card
// therefore renders a placeholder row and this fills it in. A token guards the
// obvious race: tap two streets quickly and the first answer must not land in
// the second card.
const TAPPED_GRADE_PENDING = 'measuring\u2026';
let tappedGradeToken = 0;
let tappedRoadGradeRequested = false;
function requestTappedRoadGrade(lngLat, name) {
  // On a cross-state trip the composite router owns the loaded corridor (and
  // on a phone the home worker may be released entirely) — ask it instead.
  const bridged = routing.multiStateActive && activeMultiStateRouting.bridge;
  if (!bridged && (!routing.worker || !routing.ready)) return null;
  const token = ++tappedGradeToken;
  const request = { type: 'edge-grade', id: token,
    lon: Number(lngLat.lng), lat: Number(lngLat.lat), name: name || null };
  if (bridged) {
    activeMultiStateRouting.bridge.search({ request, signal: new AbortController().signal })
      .then((result) => onRouterMessage({ data: result }))
      .catch(() => { /* the placeholder row simply stays out */ });
  } else routing.worker.postMessage(request);
  return token;
}
function applyTappedRoadGrade(m) {
  if (Number(m.id) !== tappedGradeToken) return;
  const table = document.getElementById('mapTapDetails')?.querySelector('table');
  if (!table) return;
  for (const row of table.querySelectorAll('tr')) {
    const [keyCell, valueCell] = row.children;
    if (!keyCell || !valueCell || keyCell.textContent !== 'Grade') continue;
    // Unsigned on purpose: a tapped road has no direction of travel, so
    // "uphill" would be a coin flip. The route card, which does know which way
    // the rider is going, still says uphill or downhill.
    if (m.gradePct === null || m.gradePct === undefined) row.remove();
    else valueCell.textContent = `${Math.abs(m.gradePct).toFixed(1)}% either way`;
    return;
  }
}

function readoutTable(rows) {
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
  return table;
}

function readoutRoutePointName(rows) {
  for (const key of ['Name', 'Route']) {
    const value = rows.find(([rowKey]) => rowKey === key)?.[1];
    const normalized = normalizeEndpointName(value);
    if (normalized && !/^\(?unnamed (?:road|path)\)?$/i.test(normalized)
        && !/^closed route segment$/i.test(normalized)) return normalized;
  }
  return 'Point on map';
}

function compactReadoutSummary(rows, fallback = '') {
  const valueFor = (...keys) => rows.find(([key, value]) =>
    keys.includes(key) && value != null && value !== '')?.[1];
  const verdict = valueFor('Result', 'Verdict');
  const context = valueFor('Bike facility', 'Network', 'Type');
  return [verdict, context].filter(Boolean).join(' · ') || fallback
    || 'Use this point in your trip, or open Details.';
}

function readoutRowValue(rows, ...keys) {
  return rows.find(([key, value]) => keys.includes(key)
    && value != null && value !== '')?.[1] || null;
}

function compactReadoutSafety(rows, fallback = '') {
  const box = document.createElement('div');
  box.className = 'readout-safety-summary';
  const verdict = readoutRowValue(rows, 'Result', 'Verdict');
  const reason = readoutRowValue(rows, 'Why');
  const headline = document.createElement('strong');
  headline.textContent = verdict || fallback || 'Road information';
  box.append(headline);
  if (reason && reason !== headline.textContent) {
    const detail = document.createElement('span');
    detail.textContent = reason;
    box.append(detail);
  }
  return box;
}

function isFailingDesignatedReadout(rows) {
  const verdict = String(readoutRowValue(rows, 'Result', 'Verdict') || '').toLowerCase();
  const route = readoutRowValue(rows, 'Bike route', 'Designated bike route');
  return verdict.includes('fail') && Boolean(route);
}

// The 'Bike route' context row for a non-ribbon card, and the gate that
// decides whether there is one. A route name from SCREEN PROXIMITY alone must
// never be pinned on a road that does not itself claim route membership:
// beside a trail the nearest record is often a parallel road, and I-5's
// WSDOT card wearing "Interurban Trail" -- which then fed the
// designated-but-fails banner -- is how a banned freeway read as the trail
// failing (field report). The road's own flag is the fact; the ribbon merely
// supplies the name. Bike infrastructure is the one source allowed to lean on
// proximity, because a path under a route ribbon is the route's own pavement.
function bikeRouteContextRow(srcId, p, screenPoint, feature = null) {
  const claimsRoute = p.g || p.desig === 1 || Number(p.Designated) === 1;
  // Reviewed supplemental routes are a separate overlay, so the ordinary road
  // tile cannot carry their membership flag. Geometry may establish that an
  // OSM road actually runs along the route; the 80%-of-shape requirement below
  // still rejects a nearby parallel road or one that merely crosses it.
  const along = srcId === 'roads' ? routeNamesAlongFeature(feature) : [];
  if (!claimsRoute && srcId !== 'osm' && !along.length) return null;
  const badge = routeBadgeAt(screenPoint);
  if (badge) return ['Bike route', badge];
  if (along.length) return ['Bike route', along.join(' · ')];
  // routeBadgeAt can only name the route while its ribbon layer is switched
  // on; the road's own record still states the fact when the layer is hidden.
  return claimsRoute
    ? ['Bike route', 'On a designated route (USBR / regional trail)'] : null;
}

// The routes the tapped feature itself RUNS ALONG: most of its drawn shape
// within conflation distance of a route line. Membership by geometry, for
// sources that carry no membership flag -- the OSM path that IS the route's
// pavement shares its line to the metre, where a parallel road or service
// path does not. A feature that merely CROSSES a route touches it at one
// point and stays out. Same 80%-of-shape doctrine as the router worker's
// preferred-edge matcher.
function routeNamesAlongFeature(feature, toleranceM = 20) {
  const geometry = feature?.geometry;
  const lines = geometry?.type === 'LineString' ? [geometry.coordinates]
    : geometry?.type === 'MultiLineString' ? geometry.coordinates : [];
  const coords = lines.flat();
  if (coords.length < 2) return [];
  const step = Math.max(1, Math.floor(coords.length / 12));
  const counts = new Map();
  let samples = 0;
  for (let i = 0; i < coords.length; i += step) {
    samples++;
    for (const name of routeNamesNear({ lng: coords[i][0], lat: coords[i][1] }, toleranceM)) {
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  const needed = Math.max(2, Math.ceil(samples * 0.8));
  return [...counts.entries()]
    .filter(([, count]) => count >= needed)
    .map(([name]) => name);
}

// Which Prefer-route checkboxes a tapped feature's card offers. MEMBERSHIP,
// never pixel proximity: the painted ribbon is deliberately a wide band, so
// "the tap pixel touches the ribbon" is true on unrelated streets beside a
// route (field report: Meadow Road wearing the Interurban Trail's toggle)
// and varies with zoom and the layer toggle. The toggle appears only when
// the rider actually selected a segment OF the route: the ribbon's own card,
// a feature whose own data claims membership (its geometry then names which
// route), or an OSM path whose geometry runs along the route line.
function preferredRouteTogglesFor(srcId, p, n, lngLat, feature = null) {
  if (srcId === 'routes') return routeOverlayNames(p);
  const claimsRoute = p?.g || p?.desig === 1 || Number(p?.Designated) === 1;
  if (claimsRoute) {
    const along = routeNamesAlongFeature(feature, 30);
    // Degenerate tile geometry still deserves a name: the flag already
    // established membership, so a point lookup only says WHICH route.
    return along.length ? along : routeNamesNear(lngLat, 60);
  }
  if (srcId === 'osm' || srcId === 'roads') return routeNamesAlongFeature(feature);
  return [];
}


function mapPointRouteActions(lngLat, routeName, { disclosure = false } = {}) {
  const lat = Number(lngLat.lat);
  const lng = Number(lngLat.lng);
  const routeActions = document.createElement('div');
  routeActions.className = 'readout-route-actions';
  const routeButton = (className, text, label, handler) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = text;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', handler);
    return button;
  };
  const commitEndpoint = (kind) => {
    setPanelOpen(false);
    const point = { lng, lat };
    const chosenName = refineMapPointName(point, routeName, (resolved) => {
      if (!routing[kind] || routing[kind][0] !== lng || routing[kind][1] !== lat) return;
      routing[`${kind}Name`] = resolved;
      updateArmButtons();
      saveStateSoon();
    });
    setRoutePoint(kind, point, chosenName);
    dismissRoadInfo();
    setRouteStatus(kind === 'start' ? 'Start set from map' : 'Destination set from map');
  };
  const start = routeButton('map-point-start', 'Start', 'Use this point as route start',
    () => commitEndpoint('start'));
  const end = routeButton('map-point-end', 'Destination', 'Use this point as route destination',
    () => commitEndpoint('end'));
  const stop = routeButton('map-point-stop', disclosure ? 'New stop' : 'Add stop',
    'Add this point as a route stop', () => commitMapPointStop({ lng, lat }, routeName));
  if (turnNav.active) {
    for (const button of [start, end]) {
      button.disabled = true;
      button.title = 'Stop navigation to edit the route';
    }
  }
  const canAddStop = routing.start && routing.end && !turnNav.active
    && routing.vias.length < MAX_ROUTE_STOPS;
  stop.disabled = !canAddStop;
  stop.title = turnNav.active ? 'Stop navigation to edit the route'
    : !routing.start || !routing.end ? 'Set a start and destination before adding a stop'
      : canAddStop ? 'Add this point as a stop'
        : `Maximum of ${MAX_ROUTE_STOPS} stops reached`;
  if (disclosure) {
    // The map-details disclosure reads as one sentence: Set as Start, New
    // stop, or Destination. Search-result cards keep Destination first because
    // that remains their common one-tap action.
    routeActions.append(start, stop, end);
  } else {
    routeActions.append(end, start);
    if (routing.start && routing.end) routeActions.append(stop);
    else routeActions.classList.add('two-actions');
  }
  return routeActions;
}

function canAddMapPointStop() {
  return routing.start && routing.end && !turnNav.active
    && routing.vias.length < MAX_ROUTE_STOPS;
}

function commitMapPointStop(lngLat, routeName) {
  if (!canAddMapPointStop()) return false;
  const lng = Number(lngLat.lng);
  const lat = Number(lngLat.lat);
  setPanelOpen(false);
  const point = { lng, lat };
  let committedVia = null;
  const chosenName = refineMapPointName(point, routeName, (resolved) => {
    if (!committedVia || !routing.vias.includes(committedVia)) return;
    committedVia.name = resolved;
    renderRouteStops();
    saveStateSoon();
  });
  if (!addVia(point, { name: chosenName })) return false;
  committedVia = routing.vias.at(-1);
  dismissRoadInfo();
  setRouteStatus('Stop added from map');
  return true;
}


/* ------------------------------------------------- where the rider tapped
 * places.json is the same baked OSM index the search box uses:
 * [name, lng, lat, kind, population]. Two different questions are asked of it.
 * The REGION is the municipality a point belongs to (Tukwila), so only
 * city/town/village/hamlet count and a large place wins over a marginally
 * closer small one -- a tap downtown should say Seattle, not the nearest
 * hamlet. The LOCALITY is the neighbourhood name, which is only honest very
 * close to its centre, so it is capped tight and omitted when nothing is near.
 */
const REGION_KINDS = new Set(['city', 'town', 'village', 'hamlet']);
const LOCALITY_KINDS = new Set(['neighbourhood', 'suburb']);
const REGION_MAX_M = 40000;
const LOCALITY_MAX_M = 1600;

function placeDistanceM(lng, lat, place) {
  return navDistanceM([lng, lat], [place[1], place[2]]);
}

function regionNameFor(lng, lat) {
  if (!placesIndex) return null;
  let best = null, bestScore = Infinity;
  for (const place of placesIndex) {
    if (!REGION_KINDS.has(place[3])) continue;
    const distanceM = placeDistanceM(lng, lat, place);
    if (distanceM > REGION_MAX_M) continue;
    // Population discounts distance: a city's name reaches farther than a
    // hamlet's because that is how riders actually name where they are.
    const reach = 1 + Math.log10(Math.max(10, Number(place[4]) || 10));
    const score = distanceM / reach;
    if (score < bestScore) { bestScore = score; best = place; }
  }
  return best?.[0] || null;
}

function localityNameFor(lng, lat) {
  if (!placesIndex) return null;
  let best = null, bestDistance = Infinity;
  for (const place of placesIndex) {
    if (!LOCALITY_KINDS.has(place[3])) continue;
    const distanceM = placeDistanceM(lng, lat, place);
    if (distanceM < bestDistance && distanceM <= LOCALITY_MAX_M) {
      bestDistance = distanceM; best = place;
    }
  }
  return best?.[0] || null;
}

// Trip-point names favor the closest municipality rather than the larger-city
// bias used for the card's broad regional context. A rider who taps in
// Mountlake Terrace should not get "Seattle" merely because Seattle is larger.
function nearestRegionNameFor(lng, lat) {
  if (!placesIndex) return null;
  let best = null, bestDistance = Infinity;
  for (const place of placesIndex) {
    if (!REGION_KINDS.has(place[3])) continue;
    const distanceM = placeDistanceM(lng, lat, place);
    if (distanceM < bestDistance && distanceM <= REGION_MAX_M) {
      bestDistance = distanceM;
      best = place;
    }
  }
  return best?.[0] || null;
}

function mapPointLocationName(lngLat) {
  const lng = Number(Array.isArray(lngLat) ? lngLat[0] : lngLat?.lng);
  const lat = Number(Array.isArray(lngLat) ? lngLat[1] : lngLat?.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || !placesIndex) return 'Point on map';
  const region = nearestRegionNameFor(lng, lat) || regionNameFor(lng, lat);
  const locality = localityNameFor(lng, lat);
  if (region && locality && region.toLowerCase() !== locality.toLowerCase()) {
    return `${region} — ${locality}`;
  }
  if (region) return `${region} — Point on map`;
  if (locality) return `${locality} — Point on map`;
  return 'Point on map';
}

// Commit a tap immediately, then improve its label as soon as the small
// offline place index is ready. Coordinates never change and no reroute is
// needed just because the human-readable name became more specific.
function refineMapPointName(lngLat, currentName, apply) {
  const explicit = normalizeEndpointName(currentName);
  if (explicit && explicit !== 'Point on map') return explicit;
  const immediate = mapPointLocationName(lngLat);
  if (immediate !== 'Point on map') return immediate;
  ensurePlaces().then(() => {
    const resolved = mapPointLocationName(lngLat);
    if (resolved !== 'Point on map') apply(resolved);
  });
  return immediate;
}

function readoutPrimaryButton(className, text, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = text;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-expanded', 'false');
  return button;
}

function openMapTapDebug(title, record) {
  const dialog = document.getElementById('mapDebugDialog');
  const heading = document.getElementById('mapDebugTitle');
  const output = document.getElementById('mapDebugOutput');
  if (!dialog || !heading || !output) return;
  heading.textContent = title || 'Map location';
  output.textContent = JSON.stringify(record, null, 2);
  if (!dialog.open) dialog.showModal();
}

/* ------------------------------------------- one card for every map tap
 * A point on the map, a chosen search result and a road segment used to open
 * three different cards, so the same tap taught the rider three layouts and
 * the location-only one could not answer "is this road safe?" at all. There is
 * one card now, and what changes between the three is only how many of its
 * lines have something to say.
 *
 * Above the fold, in this order and never reordered:
 *   the segment name (when a road or trail was tapped)
 *   the place itself -- a search result's name, or the neighbourhood
 *   the region, so "Point on map" still says where in the state it is
 *   the safety verdict and its reason
 *   bike accommodation
 *   surface, and ONLY when it is not paved -- "Surface: Paved" is the
 *     expected case and saying it every time trains riders to skip the line
 *
 * Everything else the app knows lives one flip-down away, and that panel is
 * built by subtraction: every row not already shown above appears there, so a
 * fact can never be dropped by forgetting to add it in two places.
 */
function renderMapTapCard({
  displayTitle, detailsTitle = displayTitle, pointName, summary, rows, lngLat, anchorPoint,
  swatchColor, swatchLabel, streetViewHeading = null, allowRoadBlock = false,
  showStreetView = true, showNavigate = true, roadBlockKind = 'road', roadBlockSnap = true,
  roadBlockFerryName = null,
  segmentName = null, placeName = null,
  debugData = null, cautionKinds = [], endpointRole = null,
  avoidTemporaryMarker = false, preferredRouteToggles = [],
}) {
  const lat = Number(lngLat.lat);
  const lng = Number(lngLat.lng);
  let routeName = normalizeEndpointName(pointName) || 'Point on map';

  readoutEl.replaceChildren();
  const close = document.createElement('button');
  close.className = 'readout-close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Close map point');
  close.textContent = '✕';

  const heading = document.createElement('div');
  heading.className = 'rt-title';
  const swatch = document.createElement('span');
  swatch.className = 'rt-swatch';
  swatch.setAttribute('role', 'img');
  swatch.style.backgroundColor = swatchColor;
  swatch.setAttribute('aria-label', swatchLabel);
  const headingText = document.createElement('span');
  headingText.textContent = displayTitle;
  heading.append(swatch, headingText);

  // The identity block: segment, place, region. Region is filled in
  // asynchronously because the place index is fetched on demand; the line is
  // simply absent until it can be answered, never a spinner or a guess.
  const identity = document.createElement('div');
  identity.className = 'readout-identity';
  const identityLine = (className, text) => {
    if (!text) return null;
    const line = document.createElement('div');
    line.className = `readout-identity-line ${className}`;
    line.textContent = text;
    identity.append(line);
    return line;
  };
  const segment = normalizeEndpointName(segmentName);
  const segmentLine = identityLine('readout-identity-segment', segment);
  // The friendly road/trail name is already the collapsed card heading. Keep
  // it available as context when Details swaps that heading to the technical
  // source name, but do not print the same name twice in the compact card.
  if (segmentLine && segment.toLowerCase() === String(displayTitle).toLowerCase()) {
    segmentLine.hidden = true;
  }
  const place = normalizeEndpointName(placeName)
    || (placesIndex ? localityNameFor(lng, lat) : null);
  // Never repeat the segment name back as if it were a second fact.
  identityLine('readout-identity-place',
    place && place.toLowerCase() !== (segment || '').toLowerCase() ? place : null);
  const regionLine = document.createElement('div');
  regionLine.className = 'readout-identity-line readout-identity-region';
  const region = placesIndex ? regionNameFor(lng, lat) : null;
  regionLine.textContent = region || '';
  regionLine.hidden = !region;
  identity.append(regionLine);
  if (!placesIndex) {
    const forCard = readoutCardToken = (readoutCardToken || 0) + 1;
    ensurePlaces().then(() => {
      // The rider may have tapped elsewhere while the index loaded.
      if (forCard !== readoutCardToken || !regionLine.isConnected) return;
      const late = regionNameFor(lng, lat);
      if (!late) return;
      regionLine.textContent = late;
      regionLine.hidden = false;
      requestAnimationFrame(positionCard);
    });
  }

  const safetySummary = compactReadoutSafety(rows, summary);
  safetySummary.style.setProperty('--readout-accent', swatchColor);
  let combinedWarning = null;
  if (isFailingDesignatedReadout(rows)) {
    combinedWarning = document.createElement('div');
    combinedWarning.className = 'readout-designated-fail';
    combinedWarning.textContent = 'Designated Route — but Fails Safety Rules.';
  }

  // Named designation, bike accommodation and (only when it is not paved)
  // surface. A named route is rider-useful identity, not a technical detail:
  // "US Bicycle Route 95" must not be displaced by the agency's vague
  // "Bike facility: yes" row and then hidden behind Details.
  const shownAbove = new Set(['Result', 'Verdict', 'Why', 'Name']);
  const facts = document.createElement('div');
  facts.className = 'readout-core-facts';
  const bikeRouteKeys = ['Bike route', 'Designated bike route'];
  // Prefer a real relation name over an earlier agency boolean. BLTS rows put
  // “Designated bike route: yes” before the coincident OSM name, and the
  // generic first-match helper therefore hid “US Bicycle Route 95”.
  const bikeRoute = readoutRowValue(rows, 'Bike route')
    || readoutRowValue(rows, 'Designated bike route');
  const accommodationKeys = ['Bike facility', 'Cycleway', 'Trail type', 'Network'];
  const accommodation = readoutRowValue(rows, ...accommodationKeys);
  const addFact = (label, value, keys, { prominent = false } = {}) => {
    if (!value) return;
    for (const key of keys) shownAbove.add(key);
    const fact = document.createElement('div');
    fact.className = 'readout-core-fact';
    if (label === 'Bike accommodation') fact.classList.add('readout-core-fact-accommodation');
    if (prominent) fact.classList.add('readout-core-fact-caution');
    const name = document.createElement('span');
    name.textContent = label;
    const text = document.createElement('strong');
    text.textContent = String(value);
    fact.append(name, text);
    facts.append(fact);
  };
  addFact('Bike route', bikeRoute, bikeRouteKeys);
  addFact('Bike accommodation', accommodation, accommodationKeys,
    { prominent: cautionKinds.includes('odd') });
  // With no bike lane or trail, the shoulder is what decides whether the road
  // passes -- so it belongs beside the verdict rather than two taps away under
  // Details. A figure of 0 ft counts: "no shoulder" on a fast road is exactly
  // what a rider needs to see. Where a facility IS recorded it speaks for the
  // road instead, and the shoulder stays in Details as before.
  if (!accommodation) {
    addFact('Shoulder', readoutRowValue(rows, 'Shoulder'), ['Shoulder']);
  }
  const surfaceKeys = ['Surface (OSM)', 'Surface'];
  const surface = readoutRowValue(rows, ...surfaceKeys);
  // "Paved" and "Unknown" are both the ordinary case: one is expected, the
  // other is the absence of a fact. Only a surface a rider would change line
  // for is worth a line.
  // Suppressed above, NOT dropped: a paved surface still belongs in Details,
  // which is the panel that promises to leave nothing out.
  if (surface && !isRoutinePavedSurface(surface)) {
    addFact('Surface', surface, surfaceKeys, { prominent: cautionKinds.includes('unpaved') });
  }
  // Access is a warning, not metadata: a dismount requirement belongs above.
  addFact('Access', readoutRowValue(rows, 'Access'), ['Access'],
    { prominent: cautionKinds.includes('walk') });
  if (cautionKinds.includes('steep')) {
    addFact('Hill', readoutRowValue(rows, 'Grade'), ['Grade'], { prominent: true });
  }
  if (cautionKinds.includes('traffic')) {
    addFact('Traffic', readoutRowValue(rows, 'Traffic', 'Traffic stress'),
      ['Traffic', 'Traffic stress'], { prominent: true });
  }
  if (cautionKinds.includes('curve')) {
    addFact('Curve caution', readoutRowValue(rows, 'Curve caution'), ['Curve caution'],
      { prominent: true });
  }

  let navigateButton = null;
  if (!endpointRole && showNavigate) {
    navigateButton = readoutPrimaryButton('readout-primary-route', 'Navigate',
      'Choose how to use this point in your route');
    navigateButton.removeAttribute('aria-expanded');
    navigateButton.addEventListener('click', () => openMapPointNavigate({ lng, lat }, routeName));
  }

  const streetViewBtn = document.createElement('button');
  streetViewBtn.type = 'button';
  streetViewBtn.className = 'streetview-launch';
  streetViewBtn.setAttribute('aria-label', 'Open Street View in this app');
  streetViewBtn.textContent = 'Street View';
  streetViewBtn.addEventListener('click', () => openStreetView(lat, lng, streetViewHeading));

  // Everything not already above the fold, in the order the source built it.
  const detailRows = rows.filter(([key]) => !shownAbove.has(key));
  const detailsToggle = document.createElement('button');
  detailsToggle.type = 'button';
  detailsToggle.className = 'readout-details-toggle';
  detailsToggle.setAttribute('aria-expanded', 'false');
  detailsToggle.setAttribute('aria-controls', 'mapTapDetails');
  detailsToggle.innerHTML = '<span class="readout-details-label">Details</span>'
    + '<span class="readout-details-chevron" aria-hidden="true"></span>';
  const details = document.createElement('div');
  details.id = 'mapTapDetails';
  details.className = 'readout-details';
  details.hidden = true;
  if (detailRows.length) details.append(readoutTable(detailRows));
  const debugButton = document.createElement('button');
  debugButton.type = 'button';
  debugButton.className = 'readout-debug-launch';
  debugButton.textContent = 'Debug view';
  debugButton.setAttribute('aria-label', `Open complete debug information for ${displayTitle}`);
  const debugRecord = {
    title: displayTitle,
    technicalTitle: detailsTitle,
    selectedCoordinate: { longitude: lng, latitude: lat },
    summary,
    displayedInformation: rows.map(([label, value]) => ({ label, value })),
    ...(debugData || { source: { id: 'map-location', name: 'Map location' } }),
  };
  debugButton.addEventListener('click', () => openMapTapDebug(routeName, debugRecord));
  details.append(debugButton);

  let blockButton = null;
  if (allowRoadBlock && !endpointRole) {
    const ferryBlock = roadBlockKind === 'ferry';
    const existingBlock = roadBlockNear({ lng, lat }, 30, {
      snap: roadBlockSnap,
      ferryName: ferryBlock ? roadBlockFerryName : null,
    });
    const canAddBlock = routing.start && routing.end && routing.blocks.length < MAX_ROAD_BLOCKS;
    if (existingBlock || canAddBlock) {
      blockButton = document.createElement('button');
      blockButton.type = 'button';
      blockButton.className = 'readout-road-block';
      if (ferryBlock) {
        blockButton.classList.add('is-labelled');
        blockButton.textContent = existingBlock ? 'Use ferry' : 'Avoid ferry';
      } else {
        blockButton.innerHTML = '<span aria-hidden="true">🚧</span>';
      }
      const blockLabel = existingBlock
        ? (ferryBlock ? 'Remove ferry roadblock' : 'Remove roadblock')
        : (ferryBlock ? 'Prevent this ferry from being used' : 'Avoid this road');
      blockButton.setAttribute('aria-label', blockLabel);
      blockButton.title = blockLabel;
      blockButton.addEventListener('click', () => {
        if (existingBlock) removeRoadBlock(existingBlock);
        else addRoadBlock({ lng, lat }, {
          snap: roadBlockSnap,
          ferryName: ferryBlock ? roadBlockFerryName : null,
        });
        dismissRoadInfo();
      });
    }
  }

  const positionCard = () => {
    if (!anchorPoint) return;
    if (avoidTemporaryMarker) positionPlaceCardAwayFromPin(anchorPoint);
    else positionRoadInfoNear(anchorPoint);
  };

  detailsToggle.addEventListener('click', () => {
    const open = details.hidden;
    details.hidden = !open;
    detailsToggle.setAttribute('aria-expanded', String(open));
    detailsToggle.querySelector('.readout-details-label').textContent = open ? 'Less' : 'Details';
    headingText.textContent = open ? detailsTitle : routeName;
    if (segmentLine) {
      segmentLine.hidden = segment.toLowerCase() === headingText.textContent.toLowerCase();
    }
    requestAnimationFrame(positionCard);
  });

  const primaryActions = document.createElement('div');
  primaryActions.className = 'readout-primary-actions';
  if (navigateButton) primaryActions.append(navigateButton);
  if (showStreetView) primaryActions.append(streetViewBtn);
  primaryActions.append(detailsToggle);
  if (blockButton) {
    if (!blockButton.classList.contains('is-labelled')) primaryActions.classList.add('has-road-block');
    primaryActions.append(blockButton);
  }

  readoutEl.append(close, heading);
  if (identity.childElementCount) readoutEl.append(identity);
  if (combinedWarning) readoutEl.append(combinedWarning);
  readoutEl.append(safetySummary);
  if (facts.childElementCount) readoutEl.append(facts);
  // Tapping a signed route offers its Preferred toggle right on the card --
  // the same per-state selection Settings → Routes edits. A segment where
  // routes overlap lists one row per route, so preferring "10" does not
  // silently prefer everything sharing its pavement.
  if (preferredRouteToggles.length) {
    const preferredBlock = document.createElement('div');
    preferredBlock.className = 'readout-preferred-routes';
    for (const name of preferredRouteToggles) {
      const row = document.createElement('label');
      row.className = 'readout-preferred-route';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = isPreferredRoute(name);
      checkbox.setAttribute('aria-label', `Prefer ${name}`);
      checkbox.addEventListener('change', () => {
        const requested = checkbox.checked;
        if (setRoutePreferred(name, requested) === false) checkbox.checked = !requested;
      });
      const text = document.createElement('span');
      // Always name the route. The card title may also happen to be the route
      // name, but the control must remain explicit and consistent across route,
      // road and trail cards.
      text.textContent = `Prefer route: ${name}`;
      row.append(checkbox, text);
      preferredBlock.append(row);
    }
    readoutEl.append(preferredBlock);
  }
  readoutEl.append(primaryActions, details);
  readoutEl.classList.add('show');
  positionCard();
  if (routeName === 'Point on map') {
    const applyRefinedName = (resolved) => {
      routeName = resolved;
      debugRecord.title = resolved;
      debugButton.setAttribute('aria-label', `Open complete debug information for ${resolved}`);
      if (detailsToggle.getAttribute('aria-expanded') !== 'true') headingText.textContent = resolved;
      requestAnimationFrame(positionCard);
    };
    const refined = refineMapPointName({ lng, lat }, routeName, applyRefinedName);
    if (refined !== 'Point on map') applyRefinedName(refined);
  }
}
// Guards the late region fill against a rider tapping again mid-fetch.
let readoutCardToken = 0;

/* The Navigate choices are their own small popup rather than a third
 * disclosure inside the card: on a phone the card is already near the tap and
 * an inline menu pushed the whole thing off screen. */
function openMapPointNavigate(lngLat, routeName) {
  const dialog = document.getElementById('mapPointNavigateDialog');
  const host = document.getElementById('mapPointNavigateChoices');
  if (!dialog || !host) return;
  const label = document.getElementById('mapPointNavigateWhere');
  if (label) label.textContent = routeName;
  host.replaceChildren(mapPointRouteActions(lngLat, routeName, { disclosure: true }));
  host.addEventListener('click', (event) => {
    if (event.target.closest('button')) dialog.close();
  }, { once: true });
  if (!dialog.open) dialog.showModal();
}

function renderReadout(feature, lngLat, anchorPoint = null, {
  avoidTemporaryMarker = false,
  routeElevationIndex = null,
} = {}) {
  resetRoadInfoPosition();
  // The road-card hit target is deliberately wider than the route as drawn,
  // so the feature returned by featureAt() is not proof that the rider tapped
  // the visible active route. Only inspectRoadAt()'s stricter geometry check
  // may supply routeElevationIndex. Clear the old chart marker for every other
  // inspection, including the particularly confusing case where the wide hit
  // target returns a route segment for a visibly off-route tap.
  if (Number.isInteger(routeElevationIndex)) {
    selectRouteElevationSegment(routeElevationIndex, lngLat);
  } else {
    clearRouteElevationSelection();
  }
  if (!feature) {
    renderMapTapCard({
      displayTitle: 'Point on map',
      pointName: 'Point on map',
      summary: 'Use this point in your trip, or open Details.',
      rows: [], lngLat, anchorPoint,
      swatchColor: '#fff', swatchLabel: 'Unspecified map point',
      debugData: { source: { id: 'map-tap', name: 'Map tap' } },
      avoidTemporaryMarker,
      preferredRouteToggles: [],
    });
    return;
  }
  const src = HIT_SRC[feature.layer.id];
  const p = feature.properties;
  if (!src) {
    renderMapTapCard({
      displayTitle: 'Point on map', pointName: 'Point on map',
      summary: 'Use this point in your trip, or open Details.',
      rows: [], lngLat, anchorPoint,
      swatchColor: '#fff', swatchLabel: 'Unspecified map point',
      debugData: { source: { id: 'unregistered-map-feature', name: 'Map feature' } },
      avoidTemporaryMarker,
    });
    return;
  }
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
    renderMapTapCard({
      displayTitle: 'Route closure',
      detailsTitle: 'Route closure (OSM)',
      pointName: readoutRoutePointName(rows),
      summary: [p.name, p.reason].filter(Boolean).join(' · ') || 'Closed route segment',
      rows, lngLat, anchorPoint,
      swatchColor: COLORS[4], swatchLabel: 'Route closure map color',
      avoidTemporaryMarker,
    });
    return;
  }
  if (src.ferryContext) {
    const rows = [
      ['Name', p.n || 'Ferry crossing'],
      ['Result', '⛴ Ferry route'],
      ['Why', 'Use Avoid ferry to prevent this crossing from being used.'],
      ['Routing', rules.allowFerries === false
        ? 'Ferries are currently disabled in Settings'
        : 'Available to the route planner'],
      ['Map symbol', 'Blue dashed — ferry crossing'],
    ];
    const pointName = readoutRoutePointName(rows);
    renderMapTapCard({
      displayTitle: pointName,
      detailsTitle: 'Ferry route',
      pointName,
      segmentName: pointName,
      summary: compactReadoutSummary(rows),
      rows, lngLat, anchorPoint,
      swatchColor: '#4f7f92', swatchLabel: 'Ferry route map color',
      showStreetView: false,
      showNavigate: false,
      allowRoadBlock: true,
      roadBlockKind: 'ferry',
      roadBlockSnap: false,
      roadBlockFerryName: p.n || null,
      debugData: {
        source: { id: src.id, name: src.name, hitLayer: feature.layer?.id || null },
        rawProperties: { ...p },
        geometry: feature.geometry || null,
      },
      avoidTemporaryMarker,
    });
    return;
  }
  const nOwn = src.scorer(p);         // this feature's own normalized props
  // The verdict must be the one the rider can SEE and the one the router used.
  // For an unpainted source it is neither: OR 224 at Three Lynx read "Passes
  // your rules" from ODOT's inventory while the map drew the road red and the
  // router detoured 45 miles around it. So the verdict comes from the painted
  // road and the agency record keeps the detail rows below -- it is the better
  // DESCRIPTION of the road; it was simply never the thing being drawn.
  let verdictSrc = src, verdictProps = p;
  let unpaintedVerdict = null;
  if (UNPAINTED_SOURCES.has(src.id)) {
    const painted = paintedRoadAt(anchorPoint);
    const paintedSrc = painted && HIT_SRC[painted.layer.id];
    if (paintedSrc) {
      verdictSrc = paintedSrc;
      verdictProps = painted.properties;
      unpaintedVerdict = evaluateRoad(nOwn);
    }
  }
  const n = verdictSrc === src ? nOwn : verdictSrc.scorer(verdictProps);
  // One evaluation drives the headline, the reason, and the colour. It used to
  // read p.level (the router's answer) for the headline and re-derive the
  // reason, so a card could say "Passes your rules" above "Fails: ...". Both
  // sides now ask safety-model.js, and asking once here means the card cannot
  // disagree with itself even if they ever diverge again.
  const verdict = evaluateRoad(n);
  const facilityGap = src.id === 'routeseg' && p.facilityGap === 1;
  const lvl = facilityGap && verdict.level < 3 ? 3 : verdict.level;
  const common = [
    ['Verdict', readoutVerdict(n, lvl, verdict)],
    ['Why', explainLevel(n, verdict)],
  ];
  let title, rows;
  if (src.id === 'routeseg') {
    const segmentRegion = routeStateConfig(p.stateId) || Region;
    title = 'Your route — segment';
    if (p.ferry === 1) {
      rows = [
        ['Name', p.name || 'Ferry crossing'],
        ['State', segmentRegion.name],
        ['Result', '⛴ Ferry'],
        ['Why', 'Crossing by ferry — road rules don’t apply on the boat.'],
        ['Speed', p.mph ? `~${p.mph} mph crossing` : null],
      ];
    } else {
      const routeVerdict = facilityGap && lvl === 3 ? [
        ['Verdict', 'Caution — traffic conflict'],
        ['Why', 'Protected bike space briefly ends at a short one-way shared-traffic connector on a through road. Routes strongly avoid this transition.'],
      ] : p.crossing === 1 ? [
        ['Verdict', 'Blue — Intersection crossing'],
        ['Why', 'Short crossing between passing route segments; treated as crossing the road, not riding along it.'],
      ] : common;
      rows = [
        ['Name', p.name || '(unnamed road)'],
        ['State', segmentRegion.name],
        ['Access', p.dismount === 1 ? 'Dismount required — walk your bike.' : null],
        ...routeVerdict,
        ['Traffic conflict', facilityGap && lvl === 4
          ? 'Protected bike space briefly ends in a one-way shared-traffic lane here.' : null],
        ['Speed limit', p.mph != null && !p.infra ? `${p.mph} mph${p.e ? ' (estimated from class)' : ''}` : null],
        ['Speed source', p.official & 1 ? `${segmentRegion.speedAgency} legal speed` : null],
        ['Shoulder', p.sh >= 0 ? `${p.sh} ft${p.shBack != null && p.shBack >= 0
          && p.shBack !== p.sh
          ? ` your direction (${p.shBack} ft the other way)` : ''}` : null],
        ['Lanes', p.lanes ? `${p.lanes}${p.ctl ? ', incl. centre turn lane' : ''}` : null],
        ['Traffic stress', p.lts ? `${segmentRegion.stressAgency} rates it ${p.lts} of 4 (Level of Traffic Stress)` : null],
        // One builder, so the route card and the tap card cannot describe the
        // same road with different numbers.
        ...measurementRows(n.measures),
        ...roadClassRow(n.measures, p.roadClass, null),
        ['Grade', routeSegmentGrade(p.gradePct, p.lenM)],
        ['Area', n.urban ? 'Urban (Census)' : 'Rural (Census)'],
        ['Sidewalk (OSM)', n.sidewalk || 'not mapped'],
        ['Rule override', sidewalkFallbackApplies(n) ? 'Sidewalk fallback — strongly deprioritized' : null],
        // The facility for the DIRECTION RIDDEN. A lane painted on the other
        // side of a two-way street is named as such rather than letting the
        // card claim a lane the rider cannot see from their side (field:
        // 37th Avenue NE, cycleway:right=lane, ridden the other way).
        ['Bike facility', FACILITY_NAME[p.facility]
          || (Number(p.facilityOther) >= 1
            ? `${FACILITY_NAME[p.facilityOther]} — other direction only` : null)],
        ['Facility source', p.official & 2 ? segmentRegion.facilitySourceName : null],
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
      ['Map symbol', 'Olive-green dashed — designated cycling corridor'],
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
      ['Path type', osmInfrastructureType(p)],
      ['Cycleway', osmCycleway(p)],
      ['Trail type', p.mtb === 1 ? 'Mountain-bike trail — hidden and not routed unless enabled in Settings' : null],
      ['Surface', p.surface],
      ['Width', p.width != null ? `${p.width} m` : null],
    ];
  } else if (src.id === 'roads') {
    title = p.d ? `Road (OSM geometry + ${Region.speedAgency} data)` : 'Road (OSM)';
    tappedRoadGradeRequested = requestTappedRoadGrade(lngLat, p.n) != null;
    rows = [
      ['Name', p.n],
      ...common,
      // Tapping a road off the route and a segment of the route describe the
      // same street, so they use one vocabulary. Curve caution stays exclusive
      // to the route card: it needs a direction of travel, which a tapped road
      // has none of.
      //
      // Grade used to be exclusive too, for a different reason -- the map tiles
      // carry no elevation. But the routing graph does and is already in
      // memory, so the card asks it. The value lands after this row is built,
      // which is why it starts as a placeholder; applyTappedRoadGrade() fills
      // it in, or removes the row when the graph has nothing near the tap.
      ['Grade', tappedRoadGradeRequested ? TAPPED_GRADE_PENDING : null],
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
      // Every row below describes the AGENCY record, so they read nOwn, not
      // the painted road the verdict above came from.
      ...(unpaintedVerdict && unpaintedVerdict.level !== lvl
        ? [['Agency record', `${Region.stressAgency} books this stretch as `
            + `${readoutVerdict(nOwn, unpaintedVerdict.level, unpaintedVerdict)}. `
            + 'The verdict above is the road as drawn and as routed, which is '
            + 'what the map and your route agree on.']]
        : []),
      [`BLTS (${Region.stressAgency})`, p.LTS_Bicycle],
      ['Speed limit', p.SpeedLimit != null ? p.SpeedLimit + ' mph' : null],
      ['Lanes', p.LaneCount],
      ['AADT', p.AADT != null ? Number(p.AADT).toLocaleString() : null],
      ['Shoulder', wsdotShoulderText(anchorPoint, p)],
      ['Area', nOwn.urban ? 'Urban (Census)' : 'Rural (Census)'],
      ['Sidewalk (OSM)', wsdotSidewalkAt(lngLat)],
      ['Bike facility', p.BikeFacilityType],
      ['Designated bike route', p.Designated === 1 ? 'yes' : null],
      ['Limited access', p.LimitedAccess ? 'yes' : null],
      ['Bikes prohibited',
        p.Prohibited ? `yes (${Region.restrictionAgency} restriction)` : null],
    ];
  }
  // If a designated route runs through this spot, include its designation in
  // the road details even though the ribbon is already visible on the map.
  if (src.id !== 'routes') {
    const routeRow = bikeRouteContextRow(src.id, p, map.project(lngLat), feature);
    if (routeRow) rows.push(routeRow);
  }
  rows = rows.filter(([, v]) => v != null && v !== '');
  const pointName = readoutRoutePointName(rows);
  renderMapTapCard({
    displayTitle: pointName === 'Point on map' ? title : pointName,
    detailsTitle: title,
    pointName,
    // The road or trail the rider actually tapped, shown as its own line so a
    // segment card leads with the street name rather than burying it in a
    // table below the verdict.
    segmentName: pointName === 'Point on map' ? null : pointName,
    summary: compactReadoutSummary(rows),
    rows, lngLat, anchorPoint,
    swatchColor: src.id === 'routes' ? COLORS[1]
    : src.id === 'restrict' ? COLORS[4]
      : p.ferry === 1 ? COLORS[0] : readoutVerdictColor(n, lvl),
    swatchLabel: src.id === 'routes'
      ? 'Designated route map color' : `Map color: ${readoutVerdict(n, lvl, verdict)}`,
    streetViewHeading: streetViewRoadHeading(feature, lngLat),
    // A roadblock is a route-editing action, not generic road metadata. Only
    // the chosen route's own hit layer offers it, never an arbitrary road the
    // rider happens to inspect nearby -- which is exactly "part of an active
    // route", since routeseg IS the drawn route.
    allowRoadBlock: src.id === 'routeseg',
    roadBlockKind: p.ferry === 1 ? 'ferry' : 'road',
    roadBlockSnap: p.ferry !== 1,
    roadBlockFerryName: p.ferry === 1 ? p.name || null : null,
    // Any tapped segment that lies on a signed route offers its Preferred
    // checkbox -- not only the ribbon's own card, which a road usually
    // outbids for the tap.
    preferredRouteToggles: preferredRouteTogglesFor(src.id, p, n, lngLat, feature),
    cautionKinds: src.id === 'routeseg' && p.ferry !== 1
      ? [...routeMarkerKinds(p, routeVisualStyle(p)), ...(p.hazard ? ['curve'] : [])]
      : [],
    debugData: {
      source: {
        id: src.id,
        name: src.name,
        hitLayer: feature.layer?.id || null,
        sourceLayer: feature.sourceLayer || feature.layer?.['source-layer'] || null,
      },
      rawProperties: { ...p },
      normalizedProperties: n,
      safetyEvaluation: verdict,
      geometry: feature.geometry || null,
    },
    avoidTemporaryMarker,
  });
}

readoutEl.addEventListener('click', (e) => {
  if (!e.target.closest('.readout-close')) return;
  dismissRoadInfo();
});

// A static web/native bundle cannot keep a Google API key secret. Street View
// therefore uses the external Google Maps handoff until key ownership,
// restrictions and terms are verified outside the repository. The empty value
// deliberately keeps the existing fallback path active.
const GOOGLE_MAPS_EMBED_KEY = '';
const NATIVE_STREET_VIEW_BRIDGE = 'https://nothinglabs.github.io/randoroute/street-view-embed.html';
// Keep Street View in the app on every platform. While it is open we hide the
// MapLibre canvas below the modal, so iOS composites only the panorama instead
// of two large WebGL surfaces at once.
const STREET_VIEW_IN_APP = Boolean(GOOGLE_MAPS_EMBED_KEY);

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
    // Keep the synthetic click inside the card. The document's ordinary
    // click-away handler dismisses a pinned road card for body-level actions;
    // an external Street View handoff should not erase what the rider was
    // inspecting when they return.
    readoutEl.appendChild(a);
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
  map.stop();
  document.body.classList.add('street-view-open');
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
  document.body.classList.remove('street-view-open');
  requestAnimationFrame(() => {
    map.resize();
    map.triggerRepaint?.();
  });
});

// A pinned road card belongs to the map inspection interaction. Any click on
// the app UI outside the map dismisses it, while clicks on the map can inspect
// another road and clicks inside the card can still use Street View or Close.
document.addEventListener('click', (e) => {
  if (!readoutEl.classList.contains('show')) return;
  if (e.target.closest('#map') || e.target.closest('#readout') || e.target.closest('dialog')) return;
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
  map.getCanvas().style.cursor = activeRouteIconAt(e.point) || featureAt(e.point)
    ? 'pointer' : '';
});
let lastPlacementTs = 0;
let lastRoadInfoTouchAt = 0;

function inspectRoadAt(point, lngLat = null) {
  if (Date.now() < roadInfoSuppressedUntil) return false;
  const canvas = map.getCanvas();
  const edgeGuard = window.matchMedia('(pointer: coarse)').matches ? 50 : 40;
  const routeIcon = activeRouteIconAt(point);
  if (!routeIcon && (point.x < edgeGuard || point.y < edgeGuard
      || point.x > canvas.clientWidth - edgeGuard
      || point.y > canvas.clientHeight - edgeGuard)) return false;
  const iconSegment = routeSegmentForActiveIcon(routeIcon);
  const feature = iconSegment?.feature || featureAt(point);
  // A deliberate tap is useful even between mapped segments: the generic
  // point card can still make it a destination, start, or stop and can open
  // Google Maps. Feature-backed taps simply add the richer road safety facts.
  // Generic search is non-modal. A deliberate road/trail tap dismisses the
  // search card and opens the normal route actions for that mapped feature.
  const picker = document.getElementById('placePicker');
  if (picker && !picker.hidden) closePlacePicker();
  const inspectedLngLat = iconSegment?.lngLat
    || lngLat || map.unproject([point.x, point.y]);
  const tappedRouteIndex = iconSegment?.routeIndex ?? routeSegmentIndexAtMapTap(
    routing.last, inspectedLngLat, point);
  // A road gets its own stretch drawn instead of a pin: the card is about that
  // piece of road, and showing it is more use than marking the pixel the
  // finger landed on. A tap on nothing still gets the pin -- there the point
  // IS the subject.
  clearTapHighlight();
  const highlighted = feature ? showTapHighlight(feature.geometry) : false;
  if (highlighted) clearSearchResultMarker();
  else showTemporaryMapMarker(inspectedLngLat);
  renderReadout(feature || null, inspectedLngLat, point, {
    avoidTemporaryMarker: true,
    routeElevationIndex: tappedRouteIndex,
  });
  readoutPinned = true;
  return true;
}

/* Tapping the start or the destination asks "what is this point?", not "what
 * would you like to do with it?" -- so the card names its role in the trip and
 * drops both Navigate (the role is already assigned) and the road block (which
 * would ask the router to avoid the place it is routing to). The endpoint
 * marker is its own anchor, so no temporary pin is dropped on top of it.
 */
function openEndpointCard(kind) {
  const point = kind === 'start' ? routing.start : routing.end;
  if (!Array.isArray(point)) return false;
  const [lng, lat] = point;
  const name = normalizeEndpointName(
    kind === 'start' ? routing.startName : routing.endName) || 'Point on map';
  const role = kind === 'start' ? 'Route start' : 'Destination';
  clearSearchResultMarker();
  clearTapHighlight();
  // Dismiss whatever was open, and hold off the synthetic map click some
  // platforms deliver after a marker tap -- it would replace this card with
  // the card for whatever road happens to lie under the endpoint.
  suppressRoadInfo(400);
  renderMapTapCard({
    displayTitle: name,
    pointName: name,
    placeName: name,
    summary: kind === 'start'
      ? 'Your trip starts here.' : 'Your trip ends here.',
    rows: [], lngLat: { lng, lat },
    anchorPoint: map.project({ lng, lat }),
    swatchColor: kind === 'start' ? '#0072B2' : '#D55E00',
    swatchLabel: role,
    endpointRole: role,
    avoidTemporaryMarker: true,
  });
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
    let committedVia = null;
    const name = refineMapPointName(lngLat, 'Point on map', (resolved) => {
      if (!committedVia || !routing.vias.includes(committedVia)) return;
      committedVia.name = resolved;
      renderRouteStops();
      saveStateSoon();
    });
    const changed = addVia(lngLat, { name });
    if (changed) committedVia = routing.vias.at(-1);
    if (changed) setRouteStatus(routing.vias.length >= MAX_ROUTE_STOPS
      ? `Stop added — maximum of ${MAX_ROUTE_STOPS} reached` : 'Stop added');
    return true;
  }
  if (kind === 'block') {
    const added = addRoadBlock(lngLat);
    if (added) setRouteStatus(routing.blocks.length >= MAX_ROAD_BLOCKS
      ? `Road block added — maximum of ${MAX_ROAD_BLOCKS} reached`
      : 'Road block added');
    return true;
  }
  const name = refineMapPointName(lngLat, 'Point on map', (resolved) => {
    if (!routing[kind] || routing[kind][0] !== lngLat.lng || routing[kind][1] !== lngLat.lat) return;
    routing[`${kind}Name`] = resolved;
    updateArmButtons();
    saveStateSoon();
  });
  setRoutePoint(kind, lngLat, name);
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
    ['designated', 'Designated bike route', 'designated'],
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
      hint: 'Paint in the traffic lane. Gives a modest route preference—even when the road still fails your rules.' },
    { key: 'residential', label: 'Residential street', min: .4, max: 1.1, step: .01,
      hint: 'Applies to the OSM residential and living-street classes, not to anything merely signed 25 mph.' },
    { key: 'designated', label: 'Signed bike route, no infrastructure', min: .25, max: 1.2, step: .01,
      hint: 'A route number on a sign. Deliberately a small bonus: signage is context, not protection.' },
    { key: 'strongDesignated', label: 'Signed bike route, when you asked to prefer them', min: .2, max: 1, step: .01,
      hint: 'Replaces the value above while "Heavily prefer designated bike routes" is on.' },
    { key: 'preferredRoute', label: 'Strong Preferred-route pull', min: .05, max: 1, step: .01,
      hint: 'Controls the strongest candidate for routes you mark Preferred. The router also generates moderate and neutral alternatives. Applied once instead of the ordinary facility or designation bonus; it never compounds with a trail or bike-lane weight.' },
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
    { base: 'stressedRoad', label: 'Official traffic-stress rating', min: 1, max: 4, step: .01,
      hint: 'This map pack\'s normalized 1–4 Level of Traffic Stress rating. Applies at full weight to a 4 and half weight to a 3; coverage depends on the map pack.' },
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
    { key: 'climbKneePct', label: 'Grade where a climb starts to hurt (%)', min: 0, max: 9, step: .5,
      hint: 'Below this, a metre climbed costs the same however it is taken. Raise it '
        + 'if gentle grades do not bother you; lower it to start avoiding them sooner.' },
    // Step .01, not .25: the default 7.84 is the value that makes the curve's
    // quadratic coefficient exactly 0.19, and a coarser step cannot reach it --
    // the slider would render at 7.75 while the weight held 7.84, and a rider
    // who dragged it could never get back.
    { key: 'climbCostAt10Pct', label: 'Cost of a 10% grade, per metre climbed', min: 1, max: 40, step: .01,
      hint: 'How much worse a steep metre is than a gentle one, anchored at 10%. The whole '
        + 'curve follows: at the default, 6% costs 1.8x and 12% costs 13x. Set it to 1 to '
        + 'ignore steepness entirely and charge only for height gained.' },
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
    for (const item of items) keys.push(...weightControlsFor(item).map((control) => control.key));
  }
  return keys;
}
// The controls one weight item renders: the key each slider edits, and the
// label naming it. buildRoutingWeightsEditor() renders exactly this list and
// editorWeightKeys() enumerates exactly this list. That is the point of the
// shared call: the coverage test used to check a SECOND copy of this rule
// while the editor built its sliders from its own inline version, so a weight
// could be orphaned in the UI with the test still passing.
function weightControlsFor(item) {
  if (item.key) return [{ key: item.key, label: 'Value' }];
  const suffix = item.suffix || '';
  const modes = item.modes || WEIGHT_MODES.map(([id]) => id);
  const out = [];
  for (const mode of modes) {
    const [, modeLabel] = WEIGHT_MODES.find(([id]) => id === mode);
    if (item.levels) {
      for (let i = 0; i < item.levels.length; i++) {
        out.push({ key: item.base + mode + item.levels[i],
          label: `${modeLabel} · ${item.levelLabels[i].toLowerCase()}` });
      }
    } else {
      out.push({ key: item.base + mode + suffix, label: modeLabel });
    }
  }
  return out;
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
    revert.classList.toggle('is-hidden', value === dflt);
    revert.disabled = value === dflt;
    revert.setAttribute('aria-hidden', value === dflt ? 'true' : 'false');
  };
  const commit = () => {
    routingWeights[key] = Number(input.value);
    paint();
    suppressRoadInfo(1200);
    // Route-only, never the full map re-score: weights are read by the router
    // and by nothing that paints the map, so re-scoring every source mid-drag
    // is guaranteed churn. Not currently pinned by a test -- the check that
    // claimed to was matching source text, and the real behaviour needs the
    // browser (see test_weights_panel_ui.mjs for where it would belong).
    scheduleReroute();
  };
  input.addEventListener('input', commit);
  // The page-level tuned notice changes the document flow. Updating it during
  // a drag used to shove the slider out from under the rider's finger on the
  // first off-default value; wait until the gesture is complete instead.
  input.addEventListener('change', syncWeightsTunedBadge);
  revert.addEventListener('click', (e) => {
    e.preventDefault();
    input.value = String(dflt);
    commit();
    syncWeightsTunedBadge();
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
      for (const { key, label } of weightControlsFor(item)) {
        cost.append(weightSlider(key, label, item.min, item.max, item.step));
      }
      group.append(cost);
    }
    host.append(group);
  }
}

// Route-shaping switches that are useful to expert tuners but add noise to
// the everyday Options page live beside the numerical weights. They keep the
// same state and routing behavior; this is a UI move, not a second source of
// truth for the preference.
function buildAdvancedRoutingOptions() {
  const host = document.getElementById('advancedRoutingOptions');
  if (!host) return;
  host.replaceChildren();
  const heading = document.createElement('h3');
  heading.id = 'advancedRoutingOptionsTitle';
  heading.textContent = 'Route options';
  const note = document.createElement('p');
  note.textContent = 'Independent of presets. Changed options are marked.';
  host.append(heading, note);
  const grid = document.createElement('div');
  grid.className = 'weights-route-options-grid';
  host.append(grid);

  const add = (key, label, state, onChange) => {
    const card = document.createElement('label');
    card.className = 'weights-route-option';
    card.htmlFor = `r-${key}`;
    card.innerHTML = `<input type="checkbox" id="r-${key}" ${state[key] ? 'checked' : ''}>
      <span class="weights-route-option-label">${label}</span>
      <small class="weights-route-option-state">Changed</small>`;
    const input = card.querySelector('input');
    const paint = () => {
      const changed = state[key] !== ADVANCED_ROUTE_OPTION_DEFAULTS[key];
      card.classList.toggle('changed', changed);
      card.querySelector('.weights-route-option-state').hidden = !changed;
    };
    input.addEventListener('change', () => {
      state[key] = input.checked;
      paint();
      suppressRoadInfo(900);
      onChange();
      syncWeightsTunedBadge();
    });
    paint();
    grid.append(card);
  };
  const updatePreference = scheduleReroute;
  add('prefDesig', 'Heavily prefer designated bike routes', routing, updatePreference);
  // The strongest override in the app, so it lives with the expert switches
  // rather than on the everyday Options page (field direction): it changes
  // route CHOICE only, and a signed road that fails the rules stays red.
  add('alwaysPreferBikeRoutes', 'Follow designated bike routes even if they fail safety rules '
    + '<span class="rule-caution-copy">(use with caution — not generally recommended)</span>',
  rules, updatePreference);
  add('prefResidential', 'Prefer residential streets', routing, updatePreference);
  add('allowSidewalkFallback', 'Allow sidewalk fallback', rules, scheduleRescore);
  add('allowMtbTrails', 'Allow mountain bike trails', rules, scheduleRescore);
  add('allowFerries', 'Allow routes with ferries', rules, scheduleReroute);
}

function activeRoutingPreset() {
  return ROUTING_PRESETS.find((preset) =>
    Object.entries(preset.rules)
      .filter(([key]) => !ADVANCED_ROUTE_RULE_KEYS.includes(key))
      .every(([key, value]) => rules[key] === value)
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
  // The panel title carries the same fact on EVERY tab: which preset the
  // rider is riding, or that they have departed from one. It replaced a
  // "changes override any preset" line that sat on the Limits tab only --
  // the title says it once, live, where every tab can see it.
  const title = document.getElementById('settingsPanelTitle');
  if (title) title.textContent = `Settings — ${active ? active.label : 'Custom'}`;
  const overrideNote = document.getElementById('settingsRulesPresetNote');
  if (overrideNote) {
    overrideNote.hidden = false;
    overrideNote.textContent = active
      ? `Changes override ${active.label}.`
      : 'Settings modified — custom rules profile.';
    overrideNote.classList.toggle('custom', !active);
  }
}

function presetInfoRows(preset) {
  const presetRules = preset.rules;
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
      return lvl.noLimit ? 'Traffic volume is not used.' : lvl.id
        ? `${lvl.label}, about ${lvl.adt.toLocaleString()} vehicles a day, needs a bike lane or a safe-ish-width shoulder. Where no count exists the road's class stands in.`
        : 'Traffic volume is not used.';
    })()],
    ['Official stress rating', `A ${STRESS_AGENCY} Level of Traffic Stress of 4 always marks a road`
      + ' as caution. It never fails one.'],
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
    ['Surface', presetRules.preferPaved === true
      ? 'Strongly prefers paved roads and trails; unpaved routes remain available.'
      : 'Slightly prefers known paved roads and trails.'],
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
    `Apply ${preset.label}?\n\nThis will replace your custom safety rules. Advanced route options and weights will stay unchanged.`
  )) return;

  clearTimeout(_rescoreTimer);
  clearTimeout(_ruleRouteTimer);
  _rescoreTimer = null;
  _ruleRouteTimer = null;
  for (const [key, value] of Object.entries(preset.rules)) {
    if (!ADVANCED_ROUTE_RULE_KEYS.includes(key)) rules[key] = value;
  }
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

/* ------------------------------------------------------------ maps
 * One installed state is the HOME map at a time: it supplies startup camera
 * and state-local defaults through Region.dataRoot. Other installed states
 * remain available to place search and multi-state partition routing.
 *
 * The list comes from maps/states.js, generated from the folders. If a state is
 * shown here it has a map package that the app can actually select; future
 * states belong on this screen only after their package exists.
 */
// What a state's folder lets a rider do, in the order the answer matters:
// routing is the app, tiles are the picture, and a place index alone is enough
// to search but not to ride.
function mapsStateCapability(state) {
  if (!state) return 'No map yet';
  if (state.datasets.graph && state.datasets.roads) return 'Routing, map and safety data';
  if (state.datasets.basemap || state.datasets.roads) return 'Map only — no routing yet';
  if (state.datasets.places) return 'Place search only — no map or routing yet';
  return 'Nothing usable yet';
}

function setMapsStatus(message) {
  const status = document.getElementById('mapsStatus');
  if (status) status.textContent = message || '';
}

async function updateMapsStorageLine() {
  const host = document.getElementById('mapsStorage');
  if (!host) return;
  const estimate = await MapStore.storageEstimate();
  const installed = `Added map downloads: ${formatMapBytes(estimate.installedBytes)}`;
  host.textContent = estimate.usageBytes != null && estimate.quotaBytes != null
    ? `${installed} · App storage: ${formatMapBytes(estimate.usageBytes)} of ${formatMapBytes(estimate.quotaBytes)}`
    : installed;
}

// Changing Home is a reload: the state-local graph, tiles, overlays and place
// index come from the other folder, and there is no partial way to swap those
// defaults under a running map. Other installed states remain installed and
// available to cross-state routing after the reload.
function switchMapState(id) {
  // allKnownStates, not Region.states: a state installed from a store this
  // session is switchable now, not only after the next reload.
  const target = allKnownStates().find((state) => state.id === id);
  if (!target || (target.id === Region.id && Region.localDataAvailable)) return false;
  if (turnNav.active) {
    setMapsStatus('Finish navigating before switching states.');
    return false;
  }
  try {
    localStorage.setItem(Region.storageKey, target.id);
  } catch (e) {
    // Private mode, or storage full. Reloading would silently come back on the
    // old state, which looks like the tap did nothing.
    setMapsStatus('This device would not remember the change, so nothing was switched.');
    return false;
  }
  setMapsStatus(`Loading ${target.name}…`);
  clearRoute();
  location.reload();
  return true;
}

const formatMapBytes = (bytes) => bytes <= 0 ? '0 MB' : bytes >= 1048576 * 995
  ? `${(bytes / (1048576 * 1024)).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1048576))} MB`;

const NATIONAL_STATES_URL = 'maps/national-states.geojson';
const MAP_FIRST_RUN_DISMISSED_KEY = 'jra-map-first-run-dismissed-1';
const MAP_FIRST_RUN_REPROMPT_MS = 30 * 24 * 60 * 60 * 1000;
let nationalCataloguePromise = null;
let nationalFeatureCollection = null;
let nationalMapOffers = new Map();
let nationalMapOffersByStore = new Map();
let selectedNationalStateId = null;
let nationalInstallController = null;

function defaultMapStoreUrl() {
  return window.MAP_STORE_DEFAULT_URL || 'maps/';
}

function mapStoreUrls() {
  return [...new Set([defaultMapStoreUrl(),
    ...MapStore.customStores().map((store) => store.url)])];
}

function mapStoreOfferKey(storeUrl, stateId) {
  let resolved = String(storeUrl || '');
  try { resolved = new URL(resolved, location.href).href; }
  catch (error) { /* comparison falls back to the supplied store address */ }
  return `${resolved}\n${stateId}`;
}

async function loadNationalCatalogue(force = false) {
  if (force) nationalCataloguePromise = null;
  if (nationalCataloguePromise) return nationalCataloguePromise;
  nationalCataloguePromise = (async () => {
    const boundaries = await loadNationalBoundaries();
    const offers = new Map();
    const offersByStore = new Map();
    const indexes = await Promise.allSettled(mapStoreUrls().map(async (storeUrl) => ({
      storeUrl, index: await MapStore.fetchIndex(storeUrl),
    })));
    for (const result of indexes) {
      if (result.status !== 'fulfilled') continue;
      for (const state of result.value.index.states) {
        const offer = { storeUrl: result.value.storeUrl, state };
        offersByStore.set(mapStoreOfferKey(result.value.storeUrl, state.id), offer);
        if (!offers.has(state.id)) offers.set(state.id, offer);
      }
    }
    nationalMapOffers = offers;
    nationalMapOffersByStore = offersByStore;
    applyNationalMapFeatureStates();
    return { boundaries, offers };
  })().catch((error) => {
    nationalCataloguePromise = null;
    throw error;
  });
  return nationalCataloguePromise;
}

// The state polygons alone, without the store catalogue. placeStateIdAt's
// accurate containment test needs them from the first tap: they used to load
// only with the full catalogue (search or the Maps screen), so a rider who
// booted with a saved trip and tapped a destination fell through to the
// bounding-box fallback — whose smallest-box tie-break puts the Portland
// strip inside 45.5–45.54°N in WASHINGTON, silently routing a cross-state
// tap single-state (found 2026-08-25 when two probe runs ground for 10+
// minutes on the home graph). The file is in the app-shell precache, so
// this is one cache read on any installed app.
let nationalBoundariesPromise = null;
function loadNationalBoundaries() {
  if (!nationalBoundariesPromise) {
    nationalBoundariesPromise = (async () => {
      const response = await fetch(NATIONAL_STATES_URL);
      if (!response.ok) throw new Error(`National state map: HTTP ${response.status}`);
      const boundaries = await response.json();
      if (boundaries?.type !== 'FeatureCollection' || boundaries.features?.length !== 51) {
        throw new Error('National state map is not the expected 50 states plus DC.');
      }
      nationalFeatureCollection = boundaries;
      return boundaries;
    })().catch((error) => {
      nationalBoundariesPromise = null;
      throw error;
    });
  }
  return nationalBoundariesPromise;
}

function nationalAvailability(id) {
  const local = MapStore.availability(id);
  if (local === 'bundled' || local === 'installed') return 'installed';
  return nationalMapOffers.has(id) ? 'available' : 'unavailable';
}

function applyNationalMapFeatureStates() {
  if (!map?.getSource?.('national-states') || !nationalFeatureCollection) return;
  for (const feature of nationalFeatureCollection.features) {
    try {
      map.setFeatureState({ source: 'national-states', id: feature.properties.id }, {
        availability: nationalAvailability(feature.properties.id),
        selected: feature.properties.id === selectedNationalStateId,
      });
    } catch (error) { /* style/source is being replaced */ }
  }
}

function projectNationalPoint(stateId, coordinate) {
  let [lon, lat] = coordinate;
  if (stateId === 'alaska') {
    if (lon > 0) lon -= 360;
    return [45 + ((lon + 181) / 52) * 275, 440 + ((72 - lat) / 21) * 135];
  }
  if (stateId === 'hawaii') {
    return [350 + ((lon + 161) / 7) * 150, 500 + ((22.5 - lat) / 4) * 75];
  }
  // Equirectangular with a 38°N standard parallel: one degree of longitude is
  // cos(38°) of a degree of latitude, so states keep their shape. Packing the
  // same latitude span into a 16:9-ish box flattened the whole country by a
  // third and the Maps screen showed a squat, wrong-shaped map.
  return [35 + ((lon + 125) / 59) * 890, 15 + ((50 - lat) / 26) * 497];
}

function nationalFeaturePath(feature) {
  const geometry = feature.geometry;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates]
    : geometry.coordinates;
  const points = [];
  const commands = [];
  for (const polygon of polygons) {
    for (const ring of polygon) {
      const projected = ring.map((point) => projectNationalPoint(feature.properties.id, point));
      if (!projected.length) continue;
      points.push(...projected);
      commands.push(`M${projected.map((point) => `${point[0].toFixed(1)},${point[1].toFixed(1)}`)
        .join('L')}Z`);
    }
  }
  return { d: commands.join(''), points };
}

function renderNationalOrientationMap(host) {
  if (!host) return;
  host.classList.add('loading');
  host.textContent = 'Loading state availability…';
  loadNationalCatalogue().then(({ boundaries }) => {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 960 600');
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', 'State map availability');
    for (const feature of boundaries.features) {
      const id = feature.properties.id;
      const projected = nationalFeaturePath(feature);
      const group = document.createElementNS(ns, 'g');
      group.classList.add('national-state', nationalAvailability(id));
      if (id === 'alaska' || id === 'hawaii') group.classList.add('inset');
      group.dataset.stateId = id;
      group.setAttribute('role', 'button');
      group.setAttribute('tabindex', '0');
      group.setAttribute('aria-label', `${feature.properties.name}: ${nationalAvailability(id)}`);
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', projected.d);
      path.setAttribute('fill-rule', 'evenodd');
      group.append(path);
      const open = () => openNationalStateCard(id);
      group.addEventListener('click', open);
      group.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault(); open();
      });
      svg.append(group);
    }
    host.classList.remove('loading');
    host.replaceChildren(svg);
  }).catch((error) => {
    host.textContent = `Could not load state availability: ${error.message}`;
  });
}

function stateWithAcquisitions(state) {
  if (!state) return null;
  const acquisitions = state.acquisitions || window.MAP_STATE_ACQUISITIONS?.[state.id];
  return acquisitions ? { ...state, acquisitions } : state;
}

// An installed map retains the manifest it was downloaded with. The generated
// shell catalogue is the current default-store offer, while the fetched
// catalogue is the current offer from the store that supplied the install.
// Compare either CURRENT offer with the retained manifest; comparing the old
// installed state to itself hid upgrades such as a newly added regional tile
// archive. Bundled states deliberately never enter this path.
function installedMapUpdateOffer(id) {
  if (MapStore.availability(id) !== 'installed') return null;
  const installed = MapStore.installedEntry(id);
  if (!installed) return null;
  const currentStoreUrl = installed.storeUrl || defaultMapStoreUrl();
  const fetched = nationalMapOffersByStore.get(mapStoreOfferKey(currentStoreUrl, id));
  if (fetched && MapStore.updateAvailable(fetched.state)) return fetched;

  if (mapStoreOfferKey(currentStoreUrl, id) !== mapStoreOfferKey(defaultMapStoreUrl(), id)) {
    return null;
  }
  const indexed = (self.MAP_STATES || []).find((state) => state.id === id);
  const state = stateWithAcquisitions(indexed);
  return state && MapStore.updateAvailable(state)
    ? { storeUrl: defaultMapStoreUrl(), state } : null;
}

function setStateCardFact(host, label, value) {
  const term = document.createElement('dt');
  term.textContent = label;
  const detail = document.createElement('dd');
  detail.textContent = value;
  host.append(term, detail);
}

async function openNationalStateCard(id) {
  let catalogue;
  try { catalogue = await loadNationalCatalogue(); }
  catch (error) { setMapsStatus(error.message); return; }
  const feature = catalogue.boundaries.features.find((item) => item.properties.id === id);
  if (!feature) return;
  const offer = nationalMapOffers.get(id) || null;
  const pendingIntent = readPendingMapRouteIntent();
  const continuesTrip = pendingIntent?.stateId === id;
  const updateOffer = installedMapUpdateOffer(id);
  const known = allKnownStates().find((state) => state.id === id) || offer?.state || null;
  const state = stateWithAcquisitions(updateOffer?.state || known);
  const availability = nationalAvailability(id);
  selectedNationalStateId = id;
  applyNationalMapFeatureStates();
  const dialog = document.getElementById('mapStateDialog');
  const title = document.getElementById('mapStateTitle');
  const status = document.getElementById('mapStateStatus');
  const summary = document.getElementById('mapStateSummary');
  const facts = document.getElementById('mapStateFacts');
  const actionStatus = document.getElementById('mapStateActionStatus');
  const primary = document.getElementById('mapStatePrimary');
  const remove = document.getElementById('mapStateRemove');
  const cancel = document.getElementById('mapStateCancelDownload');
  title.textContent = feature.properties.name;
  status.className = `map-state-card-status ${updateOffer ? 'update' : availability}`;
  status.textContent = updateOffer ? 'Update available'
    : availability === 'installed' ? 'On this device'
    : availability === 'available' ? 'Available to download' : 'Not offered';
  summary.textContent = state?.summary || (availability === 'unavailable'
    ? 'A downloadable map is not available from your configured map stores.'
    : 'State boundary and name only.');
  facts.replaceChildren();
  setStateCardFact(facts, 'Capability', state ? mapsStateCapability(state) : 'Orientation only');
  setStateCardFact(facts, 'Route use', state?.datasets?.graph
    ? 'Enables trips in or across this state' : 'No routing graph offered');
  if (state && availability !== 'unavailable') {
    setStateCardFact(facts, 'Storage', formatMapBytes(MapStore.stateBytes(state)));
  }
  setStateCardFact(facts, 'Home map', Region.localDataAvailable && Region.id === id ? 'Yes' : 'No');
  // Which map bytes this device actually holds, so a field report and a
  // release can be compared without guessing.
  const installedForVersion = MapStore.installedEntry(id);
  const mapUnitId = installedForVersion
    && (installedForVersion.state.acquisitions || [])
      .find((unit) => unit.kind === 'state-map')?.id;
  if (mapUnitId) {
    setStateCardFact(facts, 'Map data', mapUnitId.split('-').pop().slice(0, 8));
  }
  actionStatus.textContent = '';
  remove.hidden = availability !== 'installed' || MapStore.availability(id) !== 'installed';
  cancel.hidden = true;
  primary.disabled = false;
  remove.onclick = async () => {
    remove.disabled = true;
    actionStatus.textContent = `Removing ${feature.properties.name}…`;
    await MapStore.removeState(id);
    if (Region.id === id) {
      localStorage.removeItem(Region.storageKey);
      location.reload();
      return;
    }
    nationalCataloguePromise = null;
    dialog.close();
    populateMapsPane();
  };
  if (updateOffer) {
    primary.textContent = `Update ${formatMapBytes(MapStore.stateBytes(updateOffer.state))}`;
    primary.onclick = async () => {
      primary.disabled = true;
      cancel.hidden = false;
      nationalInstallController = new AbortController();
      cancel.onclick = () => nationalInstallController?.abort();
      const installed = await downloadStoreState(updateOffer.storeUrl,
        updateOffer.state, primary, {
          signal: nationalInstallController.signal,
          onStatus: (message) => { actionStatus.textContent = message; },
        });
      nationalInstallController = null;
      cancel.hidden = true;
      if (installed) location.reload();
      else primary.disabled = false;
    };
  } else if (availability === 'installed') {
    const current = Region.localDataAvailable && Region.id === id;
    primary.textContent = continuesTrip ? 'Continue trip'
      : current ? 'Current home map' : 'Use as home map';
    primary.disabled = current && !continuesTrip;
    primary.onclick = () => {
      if (continuesTrip) location.reload();
      else if (!current) switchMapState(id);
    };
  } else if (availability === 'available' && offer) {
    primary.textContent = `Download ${formatMapBytes(MapStore.stateBytes(offer.state))}`;
    primary.onclick = async () => {
      primary.disabled = true;
      cancel.hidden = false;
      nationalInstallController = new AbortController();
      cancel.onclick = () => nationalInstallController?.abort();
      const installed = await downloadStoreState(offer.storeUrl, offer.state, primary, {
        signal: nationalInstallController.signal,
        onStatus: (message) => { actionStatus.textContent = message; },
      });
      nationalInstallController = null;
      cancel.hidden = true;
      if (installed) {
        if (!continuesTrip) {
          try { localStorage.setItem(Region.storageKey, id); } catch (error) {
            actionStatus.textContent = 'The map installed, but this device could not remember it as home.';
            primary.disabled = false;
            return;
          }
        }
        location.reload();
      } else primary.disabled = false;
    };
  } else {
    primary.textContent = 'Done';
    primary.onclick = () => dialog.close();
  }
  if (!dialog.open) dialog.showModal();
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (((a[1] > point[1]) !== (b[1] > point[1]))
        && point[0] < (b[0] - a[0]) * (point[1] - a[1])
          / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function featureContainsPoint(feature, point) {
  const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates]
    : feature.geometry.coordinates;
  return polygons.some((polygon) => pointInRing(point, polygon[0])
    && !polygon.slice(1).some((hole) => pointInRing(point, hole)));
}

function firstRunDismissed(offers) {
  try {
    const value = JSON.parse(localStorage.getItem(MAP_FIRST_RUN_DISMISSED_KEY) || 'null');
    const prior = new Set(value?.offeredStateIds || []);
    const newlyOffered = [...offers.keys()].some((id) => !prior.has(id));
    return !newlyOffered && Number.isFinite(value?.dismissedAt)
      && Date.now() - value.dismissedAt < MAP_FIRST_RUN_REPROMPT_MS;
  } catch (error) { return false; }
}

async function initializeNationalOrientation() {
  if (Region.localDataAvailable) return;
  let catalogue;
  try { catalogue = await loadNationalCatalogue(); }
  catch (error) {
    console.warn('National orientation unavailable:', error);
    return;
  }
  if (map.getSource('national-states')) applyNationalMapFeatureStates();
  else map.once('load', applyNationalMapFeatureStates);
  map.on('click', 'national-state-fill', (event) => {
    const id = event.features?.[0]?.properties?.id;
    if (id) openNationalStateCard(id);
  });
  map.on('mouseenter', 'national-state-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'national-state-fill', () => { map.getCanvas().style.cursor = ''; });
  renderNationalOrientationMap(document.getElementById('firstRunNationalMap'));
  if (firstRunDismissed(catalogue.offers)) return;
  const dialog = document.getElementById('mapFirstRunDialog');
  const status = document.getElementById('mapFirstRunStatus');
  document.getElementById('mapFirstRunLocation').onclick = async () => {
    status.textContent = 'Finding your state…';
    try {
      const position = await getDevicePosition({ maximumAge: 30000, timeout: 15000 });
      const point = [Number(position.coords.longitude), Number(position.coords.latitude)];
      const feature = catalogue.boundaries.features.find((item) => featureContainsPoint(item, point));
      if (!feature) {
        status.textContent = 'That location is outside the 50 states and DC. Choose manually below.';
        return;
      }
      status.textContent = `${feature.properties.name} found. Review its details before downloading.`;
      openNationalStateCard(feature.properties.id);
    } catch (error) {
      status.textContent = 'Location was unavailable. Choose a state manually below.';
    }
  };
  document.getElementById('mapFirstRunDismiss').onclick = () => {
    try {
      localStorage.setItem(MAP_FIRST_RUN_DISMISSED_KEY, JSON.stringify({
        dismissedAt: Date.now(), offeredStateIds: [...catalogue.offers.keys()].sort(),
      }));
    } catch (error) { /* private mode: dismissal lasts for this page only */ }
    dialog.close();
  };
  if (!dialog.open) dialog.showModal();
}

// Every state the app can name right now: the startup index (bundled +
// installed-at-load) plus anything installed since, which region.js has not
// seen yet because merging happens at reload.
function allKnownStates() {
  const states = [...Region.states];
  const known = new Set(states.map((state) => state.id));
  for (const entry of MapStore.installedStates()) {
    if (!known.has(entry.state.id)) states.push(entry.state);
  }
  return states.sort((a, b) => a.name.localeCompare(b.name));
}

function buildMapsStateList() {
  const host = document.getElementById('mapsStateList');
  if (!host) return;
  host.replaceChildren();
  for (const state of allKnownStates()) {
    const home = state.id === Region.id;
    const availability = MapStore.availability(state.id);
    const updateOffer = installedMapUpdateOffer(state.id);
    // A remote state earns a row only when the app's own catalog names it
    // (the slim shell: its data downloads from the app's origin). A state
    // installed from a third-party store and then removed is simply gone
    // from this list -- its store below still offers it.
    if (availability === 'remote' && !home
        && !(self.MAP_STATES || []).some((bundled) => bundled.id === state.id)) continue;
    const row = document.createElement('label');
    row.className = `maps-state${home ? ' loaded' : ''}`
      + (state.status === 'preview' ? ' preview' : '');
    const label = document.createElement('span');
    label.className = 'maps-state-name';
    const title = document.createElement('span');
    title.textContent = state.name;
    label.append(title);
    const detail = document.createElement('span');
    detail.className = 'maps-state-detail';
    detail.textContent = mapsStateCapability(state);
    label.append(detail);
    if (availability === 'remote') {
      // Known but not on this device: the row offers a download, not a
      // switch. This is the slim-shell path -- the bundled index names the
      // state, a store has its data.
      row.classList.add('remote');
      row.append(label);
      const download = document.createElement('button');
      download.type = 'button';
      download.className = 'maps-state-download';
      download.textContent = Array.isArray(state.files)
        ? `Download ${formatMapBytes(MapStore.stateBytes(state))}` : 'Download';
      download.addEventListener('click', () => downloadKnownState(state, download));
      row.append(download);
      host.append(row);
      continue;
    }
    const choice = document.createElement('input');
    // Home is one state at a time, so: radios. Installation is independent;
    // the On device badge shows which other maps routing can still use.
    choice.type = 'radio';
    choice.name = 'mapsState';
    choice.checked = home;
    choice.value = state.id;
    choice.addEventListener('change', () => {
      if (!choice.checked) return;
      // A refused switch must not leave the list claiming the other state is
      // Home; put the selection back where the app actually starts.
      if (!switchMapState(state.id)) buildMapsStateList();
    });
    row.prepend(choice);
    row.append(label);
    if (availability === 'installed') {
      const meta = document.createElement('span');
      meta.className = 'maps-state-size';
      meta.textContent = formatMapBytes(MapStore.stateBytes(MapStore.installedEntry(state.id).state));
      row.append(meta);
      if (updateOffer) {
        const update = document.createElement('button');
        update.type = 'button';
        update.className = 'maps-state-download maps-state-update';
        update.textContent = 'Update';
        update.setAttribute('aria-label', `Update the downloaded ${state.name} map (${formatMapBytes(MapStore.stateBytes(updateOffer.state))})`);
        update.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          downloadStoreState(updateOffer.storeUrl, updateOffer.state, update)
            .then((installed) => { if (installed) location.reload(); });
        });
        row.append(update);
      }
      if (!home) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'maps-state-remove';
        remove.textContent = 'Remove';
        remove.setAttribute('aria-label', `Remove the downloaded ${state.name} map`);
        remove.addEventListener('click', async (event) => {
          event.preventDefault();
          setMapsStatus(`Removing ${state.name}…`);
          await MapStore.removeState(state.id);
          setMapsStatus(`${state.name} removed.`);
          buildMapsStateList();
          updateMapsStorageLine();
        });
        row.append(remove);
      }
    }
    if (home || availability === 'bundled' || availability === 'installed'
        || state.status === 'preview') {
      const badge = document.createElement('span');
      // Home is a startup/default choice, not an exclusive routing map.
      // Every other locally available state says On device so the screen does
      // not imply that selecting Home unloaded it.
      const onDevice = availability === 'bundled' || availability === 'installed';
      badge.className = `maps-state-badge${!home && !onDevice ? ' preview' : ''}`;
      badge.textContent = home ? 'Home' : onDevice ? 'On device' : 'Preview';
      row.append(badge);
    }
    host.append(row);
  }
}

// Download a state named by the bundled index but absent from this device
// (the slim shell). Its files come from the app's own origin store.
async function downloadKnownState(state, button) {
  const offer = nationalMapOffers.get(state.id);
  await downloadStoreState(offer?.storeUrl || defaultMapStoreUrl(), offer?.state || state, button);
}

async function downloadStoreState(storeUrl, state, button, options = {}) {
  if (button) button.disabled = true;
  const name = state.name || state.id;
  const updating = MapStore.availability(state.id) === 'installed';
  const report = options.onStatus || setMapsStatus;
  try {
    // The bundled registry entries carry no file list (only the store index
    // does), so fetch the store's word for what the state ships.
    let full = state;
    if (!Array.isArray(state.files)) {
      const index = await MapStore.fetchIndex(storeUrl);
      full = index.states.find((candidate) => candidate.id === state.id);
      if (!full) throw new Error(`The store no longer offers ${name}.`);
    }
    report(`${updating ? 'Updating' : 'Downloading'} ${name}…`);
    await MapStore.installState(storeUrl, full, ({ done, total }) => {
      const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
      report(`${updating ? 'Updating' : 'Downloading'} ${name}… ${pct}% of ${formatMapBytes(total)}`);
    }, { signal: options.signal });
    report(`${name} is ${updating ? 'updated and ' : ''}ready to use.`);
    refreshPendingMapRouteIntent(state.id);
    // Installing the data for the state the session is already homed on --
    // a slim shell's first download, or a re-install after a storage-blind
    // boot -- can only take effect through region.js, which binds at boot.
    // Without this reload the screen keeps the national map while saying
    // "ready to use", and only a forced restart recovers.
    if (state.id === Region.id && !Region.localDataAvailable) {
      rebootIntoInstalledHomeState();
      return full;
    }
    buildMapsStateList();
    buildMapsStoreList();
    updateMapsStorageLine();
    return full;
  } catch (error) {
    report(error?.name === 'AbortError' ? `${name} download cancelled.`
      : `Could not download ${name}: ${error.message}`);
    if (button) button.disabled = false;
    return null;
  }
}

/* ------------------------------------------------------------- map stores */
// Third-party stores the rider added. Each renders as its address plus the
// states it offers that this device does not already have.
function buildMapsStoreList() {
  const host = document.getElementById('mapsStoreList');
  if (!host) return;
  host.replaceChildren();
  for (const store of MapStore.customStores()) {
    const row = document.createElement('div');
    row.className = 'maps-store';
    const head = document.createElement('div');
    head.className = 'maps-store-head';
    const address = document.createElement('span');
    address.className = 'maps-store-url';
    address.textContent = store.url;
    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'maps-state-remove';
    forget.textContent = 'Forget';
    forget.setAttribute('aria-label', `Forget the store ${store.url}`);
    forget.addEventListener('click', () => {
      // Forgetting the store keeps any maps already downloaded from it; they
      // are the rider's, listed above with their own Remove.
      MapStore.removeCustomStore(store.url);
      buildMapsStoreList();
      nationalCataloguePromise = null;
      renderNationalOrientationMap(document.getElementById('mapsNationalMap'));
    });
    head.append(address, forget);
    const offers = document.createElement('div');
    offers.className = 'maps-store-offers';
    offers.textContent = 'Checking…';
    row.append(head, offers);
    host.append(row);
    renderStoreOffers(store.url, offers);
  }
}

async function renderStoreOffers(storeUrl, host) {
  try {
    const index = await MapStore.fetchIndex(storeUrl);
    host.replaceChildren();
    let offered = 0;
    for (const state of index.states) {
      const available = MapStore.availability(state.id);
      const updating = available === 'installed' && MapStore.updateAvailable(state);
      if (available !== 'remote' && !updating) continue;
      offered += 1;
      const row = document.createElement('div');
      row.className = 'maps-store-offer';
      const label = document.createElement('span');
      label.textContent = `${state.name} (${state.status})`;
      const download = document.createElement('button');
      download.type = 'button';
      download.className = 'maps-state-download';
      download.textContent = `${updating ? 'Update' : 'Download'} ${formatMapBytes(MapStore.stateBytes(state))}`;
      download.addEventListener('click', () => {
        downloadStoreState(storeUrl, state, download)
          .then((installed) => { if (installed && updating) location.reload(); });
      });
      row.append(label, download);
      host.append(row);
    }
    if (!offered) {
      host.textContent = 'Everything this store offers is already on this device.';
    }
  } catch (error) {
    host.textContent = `Could not read this store: ${error.message}`;
  }
}

function populateMapsPane() {
  setMapsStatus('');
  renderNationalOrientationMap(document.getElementById('mapsNationalMap'));
  buildMapsStateList();
  // The shell catalogue makes default-store updates visible immediately. A
  // custom-store install needs its current remote catalogue first, so refresh
  // the rows once the same request driving the orientation map completes.
  loadNationalCatalogue().then(() => buildMapsStateList()).catch(() => {});
  buildMapsStoreList();
  updateMapsStorageLine();
}

function openMapsDialog() {
  if (!settingsMenuIsOpen()) {
    selectPanelTab('settings');
    setPanelOpen(true);
  }
  settingsPaneSelect?.('maps');
}

/* ----------------------------- Settings → Routes: the state's signed routes */
function formatRouteMiles(lengthM) {
  const miles = lengthM / 1609.344;
  if (!(miles > 0.05)) return null;
  return miles >= 10 ? `${Math.round(miles)} mi` : `${miles.toFixed(1)} mi`;
}

function buildStateRoutesList(catalog) {
  const host = document.getElementById('stateRoutesList');
  if (!host) return;
  host.replaceChildren();
  const groups = new Map();
  for (const entry of catalog.values()) {
    // A route present in both sources appears once under OSM, with both source
    // names in its detail. Official-only routes get their own agency section.
    const sourceId = entry.sourceIds?.includes('osm') ? 'osm'
      : entry.sourceIds?.[0] || 'osm';
    const label = sourceId === 'osm' ? 'OSM routes'
      : entry.sourceLabels?.[0] || sourceId;
    let group = groups.get(sourceId);
    if (!group) groups.set(sourceId, group = { label, entries: [] });
    group.entries.push(entry);
  }
  const orderedGroups = [...groups.entries()].sort(([a], [b]) =>
    a === 'osm' ? -1 : b === 'osm' ? 1 : groups.get(a).label.localeCompare(groups.get(b).label));
  for (const [sourceId, group] of orderedGroups) {
    const rows = [];
    host.append(sourceId === 'osm'
      ? plainSourceHeading(group.label)
      : sourceToggleHeading(sourceId, group.label, rows));
    // Preferred first within each source, then numeric-aware alphabetical.
    group.entries.sort((a, b) =>
      (isPreferredRoute(b.name) - isPreferredRoute(a.name))
      || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    for (const entry of group.entries) {
      const row = document.createElement('label');
      row.className = 'state-route-row';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = isPreferredRoute(entry.name);
      checkbox.setAttribute('aria-label', `Prefer ${entry.name}`);
      const text = document.createElement('span');
      text.className = 'state-route-name';
      const name = document.createElement('strong');
      name.textContent = entry.name;
      const detail = document.createElement('small');
      const kind = entry.national ? 'National (USBR)'
        : entry.network === 'official' ? 'Official route' : 'Regional';
      const sources = entry.sourceLabels?.length > 1 ? entry.sourceLabels.join(' + ') : null;
      detail.textContent = [kind, formatRouteMiles(entry.lengthM), sources]
        .filter(Boolean).join(' · ');
      text.append(name, detail);
      const badge = document.createElement('span');
      badge.className = 'state-route-preferred-badge';
      badge.textContent = 'Preferred';
      badge.hidden = !checkbox.checked;
      checkbox.addEventListener('change', () => {
        const requested = checkbox.checked;
        if (setRoutePreferred(entry.name, requested) === false) checkbox.checked = !requested;
        badge.hidden = !checkbox.checked;
      });
      row.append(checkbox, text, badge);
      rows.push({ row, checkbox });
      host.append(row);
    }
    if (sourceId !== 'osm') setSourceRowsOff(rows, isRouteSourceSuppressed(sourceId));
  }
}

function plainSourceHeading(label) {
  const heading = document.createElement('h3');
  heading.className = 'state-route-source-heading';
  heading.textContent = label;
  return heading;
}

// A switched-off source's routes stay listed and keep whatever Preferred marks
// the rider gave them -- switching the source back on must restore exactly what
// they had. They just cannot be MARKED while the source is off, because the
// worker no longer treats their edges as designated and the checkbox would do
// nothing.
function setSourceRowsOff(rows, off) {
  for (const { row, checkbox } of rows) {
    row.classList.toggle('state-route-row-off', off);
    checkbox.disabled = off;
  }
}

// The switch for one non-OSM source. OSM has no switch: it is the baseline the
// whole app is built on, not a source a rider opts into.
function sourceToggleHeading(sourceId, label, rows) {
  const heading = document.createElement('label');
  heading.className = 'state-route-source-heading state-route-source-toggle';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = !isRouteSourceSuppressed(sourceId);
  checkbox.setAttribute('aria-label', `Use ${label}`);
  const text = document.createElement('span');
  text.textContent = label;
  const state = document.createElement('small');
  const paint = () => {
    state.textContent = checkbox.checked ? '' : 'Off — hidden and not routed';
    heading.classList.toggle('state-route-source-heading-off', !checkbox.checked);
  };
  paint();
  checkbox.addEventListener('change', () => {
    const requested = !checkbox.checked;   // checked means "use it"
    if (setRouteSourceSuppressed(sourceId, requested) === false) {
      checkbox.checked = !checkbox.checked;
    }
    paint();
    setSourceRowsOff(rows, isRouteSourceSuppressed(sourceId));
  });
  heading.append(checkbox, text, state);
  return heading;
}

async function populateStateRoutesPane() {
  const region = document.getElementById('stateRoutesRegion');
  if (region) region.textContent = Region.name;
  const status = document.getElementById('stateRoutesStatus');
  const host = document.getElementById('stateRoutesList');
  if (host) host.replaceChildren();
  if (status) status.textContent = 'Loading routes…';
  try {
    const catalog = await ensureStateRouteCatalog();
    buildStateRoutesList(catalog);
    if (status) {
      status.textContent = catalog.size ? ''
        : 'This state’s data includes no signed bicycle routes.';
    }
  } catch (e) {
    if (status) status.textContent = 'Could not load the route list.';
  }
}

function openStateRoutesDialog() {
  if (!settingsMenuIsOpen()) {
    selectPanelTab('settings');
    setPanelOpen(true);
  }
  settingsPaneSelect?.('routes');
}

document.getElementById('mapsStoreAdd')?.addEventListener('click', () => {
  const input = document.getElementById('mapsStoreUrl');
  try {
    const url = MapStore.addCustomStore(input.value);
    input.value = '';
    setMapsStatus(`Added ${url}`);
    buildMapsStoreList();
    nationalCataloguePromise = null;
    renderNationalOrientationMap(document.getElementById('mapsNationalMap'));
  } catch (error) {
    setMapsStatus(error.message);
  }
});

function buildRulesPanel() {
  const slidersHost = document.getElementById('settingsSliders');
  const optionsHost = document.getElementById('settingsOptions');
  const displayOptionsHost = document.getElementById('settingsDisplayOptions');
  slidersHost.replaceChildren();
  optionsHost.replaceChildren();
  displayOptionsHost.replaceChildren();
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

  check('allowFreeways', 'Route over freeway as last resort (still shows as failing)');
  check('preferPaved', 'Strongly prefer paved surfaces');
  check('requireSafe', 'Only show routes fully matching safety rules');
  // The preset-info card's phrasing; the longer sentence wrapped to two
  // lines on a 375 px phone and pushed the Rules pane past one screen.
  check('inferShoulderFromEdge', 'Guess shoulder width when undocumented');

  // Display-only options never knock the rider off a routing preset.
  const warningIconsCard = document.createElement('div');
  warningIconsCard.className = 'check-rule rule-card rule-standalone';
  warningIconsCard.innerHTML = `
    <label class="rule-check" for="r-hideRouteWarningIcons">
      <input type="checkbox" id="r-hideRouteWarningIcons" ${uiPrefs.hideRouteWarningIcons ? 'checked' : ''}>
      <span>Hide route warning icons</span>
    </label>`;
  displayOptionsHost.appendChild(warningIconsCard);
  warningIconsCard.querySelector('input').addEventListener('change', (e) => {
    uiPrefs.hideRouteWarningIcons = e.target.checked;
    suppressRoadInfo(900);
    syncRouteWarningIconVisibility();
    saveStateSoon();
  });
  const advancedToolsCard = document.createElement('div');
  advancedToolsCard.className = 'check-rule rule-card rule-standalone';
  advancedToolsCard.innerHTML = `
    <label class="rule-check" for="r-showAdvancedTools">
      <input type="checkbox" id="r-showAdvancedTools" ${uiPrefs.showAdvancedTools ? 'checked' : ''}>
      <span>Show advanced options and routing weights</span>
    </label>`;
  displayOptionsHost.appendChild(advancedToolsCard);
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
      <input type="range" id="r-${key}" min="2" max="${MAX_LANES_NO_LIMIT}" step="1" value="${rules[key]}">`;
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
      // Compact "2k+/day": the spelled-out "~2,000/day" wrapped the row to
      // two lines on a 375 px phone, and the Rules pane must fit one screen.
      const perDay = lvl.adt >= 1000 ? `${lvl.adt / 1000}k` : String(lvl.adt);
      if (lvl.noLimit) return 'No limit';
      return lvl.id ? `${lvl.label} (${perDay}+/day)` : 'Not used';
    };
    wrap.innerHTML = `
      <div class="rule-head">
        <label for="r-${key}">Road is busier than</label>
        <span class="val" id="v-${key}">${label(rules[key])}</span>
      </div>
      <input type="range" id="r-${key}" min="1" max="${levels.length - 1}" step="1" value="${rules[key]}">`;
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
  spaceHeading.textContent = 'Require bike lane or safe-ish shoulder if any of these:';
  slidersHost.appendChild(spaceHeading);
  slider('maxSpeedNoShoulder', 'Speed limit is over', 20, 45, 5, ' mph', 'rule-sub');
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
      const requestedButton = paneButtons.find((button) => button.dataset.settingsPane === pane);
      if (!requestedButton || requestedButton.hidden) pane = 'rules';
      paneButtons.forEach((button) => {
        const active = button.dataset.settingsPane === pane;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
      });
      document.querySelectorAll('.settings-pane').forEach((panel) => {
        panel.hidden = panel.id !== `settings-${pane}`;
      });
      if (pane === 'presets' || pane === 'rules') syncPresetSelection();
      syncSettingsNavigationLock();
      if (pane === 'maps') populateMapsPane();
      if (pane === 'routes') populateStateRoutesPane();
      if (pane === 'weights') prepareRoutingWeightsPane();
    };
    settingsPaneSelect = selectSettingsPane;
    paneButtons.forEach((button) => {
      button.addEventListener('click', () => {
        selectSettingsPane(button.dataset.settingsPane);
      });
      button.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const visibleButtons = paneButtons.filter((candidate) => !candidate.hidden);
        const current = visibleButtons.indexOf(button);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? visibleButtons.length - 1
          : (current + (event.key === 'ArrowRight' ? 1 : -1) + visibleButtons.length) % visibleButtons.length;
        visibleButtons[next].focus();
        selectSettingsPane(visibleButtons[next].dataset.settingsPane);
      });
    });
    document.getElementById('settingsHelpBtn').addEventListener('click', () => {
      buildCautionCauseHelp();
      openHelp('settings');
    });
    document.getElementById('resetRoutingWeights').addEventListener('click', () => {
      Object.assign(routingWeights, DEFAULT_ROUTING_WEIGHTS);
      for (const key of ADVANCED_ROUTE_PREFERENCE_KEYS) {
        routing[key] = ADVANCED_ROUTE_OPTION_DEFAULTS[key];
      }
      for (const key of ADVANCED_ROUTE_RULE_KEYS) {
        rules[key] = ADVANCED_ROUTE_OPTION_DEFAULTS[key];
      }
      buildAdvancedRoutingOptions();
      buildRoutingWeightsEditor();
      syncWeightsTunedBadge();
      scheduleRescore();
      showRouteActionToast('Advanced routing reset to defaults', { duration: 2200 });
    });
    selectSettingsPane(document.querySelector('[data-settings-pane].active')?.dataset.settingsPane || 'rules');
    settingsTabs.dataset.bound = 'true';
  }
}

// Route-shaping values stay fixed for the lifetime of active navigation, but
// they remain fully legible instead of being greyed out. A tap is intercepted
// before the control changes and explains how to unlock it. Voice controls
// stay live because they affect presentation of the current ride, not its path.
function syncSettingsNavigationLock() {
  // Clean up disabled state left by an older shell before this interaction
  // guard existed. Controls that were independently disabled stay disabled.
  document.querySelectorAll('[data-nav-lock-was-disabled]').forEach((control) => {
    control.disabled = control.dataset.navLockWasDisabled === 'true';
    control.removeAttribute('data-nav-lock-was-disabled');
    if (!control.disabled) control.removeAttribute('aria-disabled');
  });
}

function showSettingsNavigationLockDialog() {
  const dialog = document.getElementById('settingsNavLockDialog');
  if (dialog && !dialog.open) dialog.showModal();
}

function blockSettingsChangeDuringNavigation(event) {
  if (!turnNav.active) return;
  const pane = event.target.closest?.('.settings-pane');
  if (!pane || pane.id === 'settings-voice') return;
  const control = event.target.closest?.('button, input, select, label');
  if (!control) return;
  if (event.type === 'keydown' && ['Tab', 'Escape'].includes(event.key)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  showSettingsNavigationLockDialog();
}

const settingsPanel = document.getElementById('tab-settings');
for (const eventName of ['pointerdown', 'click', 'keydown']) {
  settingsPanel?.addEventListener(eventName, blockSettingsChangeDuringNavigation, true);
}

// The Routes screen builds its checkboxes after an asynchronous catalog load.
// Apply the same navigation lock when those late controls arrive; the screen
// stays inspectable during a ride, but Preferred-route choices stay fixed.
const stateRoutesLockObserver = new MutationObserver(() => syncSettingsNavigationLock());
const stateRoutesLockHost = document.getElementById('stateRoutesList');
if (stateRoutesLockHost) stateRoutesLockObserver.observe(stateRoutesLockHost, { childList: true });

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
    ${navVoice.keepScreenAwake ? 'checked' : ''}><span>Keep the screen awake while navigating</span></label>`;
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
    ${navVoice.safetyLevels ? 'checked' : ''}><span>Announce route safety levels</span></label>`;
  safety.querySelector('input').addEventListener('change', (e) => {
    navVoice.safetyLevels = e.target.checked;
    syncNativeVoiceStatusPreferences();
    saveStateSoon();
  });
  host.appendChild(safety);

  const taunt = document.createElement('div');
  taunt.className = 'check-rule rule-card';
  taunt.innerHTML = `<label class="rule-check"><input type="checkbox" id="v-voiceHillTaunt"
    ${navVoice.hillTaunt ? 'checked' : ''}><span>Hill Taunt — light mockery on steep climbs</span></label>`;
  taunt.querySelector('input').addEventListener('change', (e) => {
    navVoice.hillTaunt = e.target.checked;
    saveStateSoon();
  });
  host.appendChild(taunt);

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

// Settings is full-screen. Each pane gets the same remaining viewport and
// scrolls its own content, so tab changes cannot resize the surrounding UI.
function syncSettingsPaneHeight() {
  const settingsView = document.getElementById('tab-settings');
  if (!settingsView?.classList.contains('active')) return;
  settingsView.style.removeProperty('--settings-pane-height');
}

/* ------------------------------------------------------------- boot */
// State polygons for tap resolution, from the shell cache — see
// loadNationalBoundaries for why a tap must not wait for search or Maps.
loadNationalBoundaries().catch(() => { /* bbox fallback remains */ });
buildSourcePanel();
buildRulesPanel();
buildVoicePanel();
buildRoutingPanel();
syncSettingsNavigationLock();
// On a native or memory-constrained browser, do not make a blank planner hold
// the 44 MB routing graph (about 142 MB after expansion) before the rider has
// asked for a route. Besides slowing the first search, that idle allocation
// leaves iPhone Safari too little headroom for a map zoom and can make WebKit
// terminate the page. Existing/saved trips still start at once; unconstrained
// desktop browsers retain the latency-saving background prewarm.
if (routing.start && routing.end) {
  // A saved trip used to start the graph load immediately, concurrent with
  // MapLibre's first tile parse — the exact overlap the cache-cap comments
  // above record as a WebKit kill loop. Worse, a mid-ride kill relaunches
  // into this same collision with the same saved trip, so one kill could
  // cascade into several. On constrained devices the settle helper defers
  // the load until the launch camera has its tiles; desktop keeps the
  // immediate start.
  //
  // A saved CROSS-STATE trip never touches the home graph: its recompute
  // goes straight to the partition session, so loading the statewide graph
  // here would put a second full-size graph beside the composite during the
  // relaunch after a kill — the exact state being relaunched from. Skip it
  // on constrained devices; a later single-state request loads it lazily.
  if (!(isConstrainedDevice() && routingRequiresPartitionSession())
      && !homeGraphExceedsDeviceBudget()) {
    ensureRouterAfterMapSettles();
  }
} else if (isNativeAppRuntime() || isConstrainedDevice()) {
  ensurePlaces();
} else {
  let backgroundRouterStarted = false;
  const startBackgroundRouter = () => {
    if (backgroundRouterStarted) return;
    backgroundRouterStarted = true;
    ensureRouter();
  };
  const queueBackgroundRouter = () => {
    map.once('idle', startBackgroundRouter);
    setTimeout(startBackgroundRouter, 1500);
  };
  if (map.loaded()) queueBackgroundRouter();
  else map.once('load', queueBackgroundRouter);
}

// On phones, Navigate sits immediately above the permanent Route sheet; on
// desktop it hangs on the left edge just below the docked panel, so the whole
// left column reads route choices then Navigate.
const mobileNavMedia = window.matchMedia('(max-width: 720px)');
let _mobileDockFrame = null;
let _routeGuidanceTimer = null;
function syncMobileNavDock() {
  // Every pass through here is a distinct post-layout frame, which is what
  // the settled Details-button anchor needs: two agreeing reads from two
  // separate passes commit; a lone transient read never does.
  observePlanningDetailsAnchor();
  const panel = document.getElementById('panel');
  if (!mobileNavMedia.matches) {
    // The docked panel's height is content-driven, so CSS alone cannot hang
    // the Navigate button under it; publish the measured bottom edge.
    document.body.style.setProperty('--desktop-panel-bottom',
      `${Math.ceil(panel.getBoundingClientRect().bottom)}px`);
    return;
  }
  const height = document.body.classList.contains('panel-open')
    ? Math.ceil(window.innerHeight - panel.getBoundingClientRect().top) : 0;
  // The dock and the banner are siblings, so put the shared measurement on
  // <body> rather than only on the dock. Both elements then rise together.
  document.body.style.setProperty('--mobile-panel-height', `${height}px`);
}
function scheduleMobileNavDock() {
  if (_mobileDockFrame != null) return;
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

function syncPanelInteractivity() {
  const panel = document.getElementById('panel');
  panel.inert = false;
  panel.removeAttribute('aria-hidden');
}

function routeHasBothEndpoints() {
  return Boolean(routing.start && routing.end);
}

function syncRoutePaneVisibility() {
  const panel = document.getElementById('panel');
  const routeTab = document.getElementById('tab-route');
  const incompleteBar = document.getElementById('routeIncompleteBar');
  const incompleteMessage = document.getElementById('routeIncompleteMessage');
  if (!panel) return;
  // Before a route exists, keep one small, explicit affordance at the bottom
  // instead of either a full empty route chooser or no guidance at all.
  const incomplete = !routeHasBothEndpoints() && !turnNav.active;
  routeTab?.classList.toggle('route-incomplete', incomplete);
  if (incompleteBar) incompleteBar.hidden = !incomplete;
  if (incompleteMessage) {
    incompleteMessage.textContent = routing.end && !routing.start
      ? 'Select start to see routes'
      : 'Select destination to see routes';
    incompleteMessage.setAttribute('aria-label', incompleteMessage.textContent);
  }
  scheduleMobileNavDockAfterInit();
}

function flashEmptyRouteGuidance() {
  if (!mobileNavMedia.matches || routing.start || routing.end) return;
  const routeTab = document.getElementById('tab-route');
  const message = document.getElementById('routeIncompleteBar');
  const endpoints = document.querySelector('.route-endpoints');
  if (!routeTab?.classList.contains('active')
      || message?.hidden || !endpoints) return;
  clearTimeout(_routeGuidanceTimer);
  message.classList.remove('route-guidance-flash');
  endpoints.classList.remove('route-guidance-flash');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!document.body.classList.contains('panel-open')) return;
    message.classList.add('route-guidance-flash');
    endpoints.classList.add('route-guidance-flash');
    _routeGuidanceTimer = setTimeout(() => {
      message.classList.remove('route-guidance-flash');
      endpoints.classList.remove('route-guidance-flash');
    }, 2300);
  }));
}

function setPanelOpen() {
  const wasOpen = document.body.classList.contains('panel-open');
  document.body.classList.add('panel-open');
  syncLayersToggle();
  syncSettingsToggle();
  syncPanelInteractivity();
  refreshNavigationUI();
  scheduleMobileNavDock();
  requestAnimationFrame(drawRouteCardElevation);
  syncRouteDetailsWarningState(routing.last, { flash: true });
  if (!wasOpen) flashEmptyRouteGuidance();
}

function selectPanelTab(tabId) {
  const settingsWasOpen = settingsMenuIsOpen();
  if (!settingsWasOpen && tabId === 'settings') beginSettingsEditSession();
  if (tabId !== 'layers') setActiveRouteIconLegendOpen(false);
  document.body.classList.toggle('settings-panel-active', tabId === 'settings');
  document.body.classList.toggle('aux-panel-active', tabId === 'settings' || tabId === 'layers');
  document.querySelectorAll('.tab').forEach((t) =>
    t.classList.toggle('active', t.id === 'tab-' + tabId));
  syncLayersToggle();
  syncSettingsToggle();
  syncRoutePaneVisibility();
  scheduleMobileNavDock();
  if (tabId === 'route') { updateNavCard(); drawRouteCardElevation(); } // redraw elevation once visible
  if (tabId === 'settings') requestAnimationFrame(syncSettingsPaneHeight);
  if (tabId === 'settings') syncSettingsNavigationLock();
  if (settingsWasOpen && tabId !== 'settings') finishSettingsEditSession();
}

selectPanelTab('route');
setPanelOpen(true);

function layersMenuIsOpen() {
  return document.getElementById('tab-layers').classList.contains('active');
}

function syncLayersToggle() {
  const toggle = document.getElementById('layersToggle');
  if (!toggle) return;
  const open = layersMenuIsOpen();
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Hide map layers' : 'Show map layers');
  toggle.title = open ? 'Hide map layers' : 'Show map layers';
}

// Keep this focused on route conditions a rider may need to interpret. The
// ferry symbol is self-explanatory. Keep these six labels short enough to scan
// at a glance; their fuller meaning remains in each item's accessible label.
const ACTIVE_ROUTE_ICON_DEFINITIONS = [
  ['route-dismount-marker-icon', 'Walk your bike', 'Dismount here.'],
  ['route-marker-steep', 'Steep hill', '7.5% for a block, 5% held for 250 m, or 4% for 800 m.'],
  ['route-marker-traffic', 'Heavy traffic', 'High traffic volume.'],
  ['route-marker-unpaved', 'Unpaved', 'Loose surface.'],
  ['route-marker-fail', 'Fails rules', 'Outside your safety limits.'],
  ['route-marker-fail-designated', 'Bike route fails rules',
    'Official route, but outside your safety limits.'],
];

function buildActiveRouteIconLegend() {
  const host = document.getElementById('activeRouteIconLegendItems');
  if (!host || host.childElementCount) return;
  renderActiveRouteIconItems(host);
}

// Renders the warning-icon rows into any host (the layers-panel legend and
// the app tour both call this), so the tour can never drift from the legend.
function renderActiveRouteIconItems(host) {
  const images = new Map();
  const imageSink = {
    hasImage: (id) => images.has(id),
    addImage: (id, image, options = {}) => images.set(id,
      { ...image, pixelRatio: Number(options.pixelRatio) || 1 }),
  };
  ensureRouteMarkerImages(imageSink);
  ensureDismountMarkerImage(imageSink);
  for (const [id, label, detail] of ACTIVE_ROUTE_ICON_DEFINITIONS) {
    const image = images.get(id);
    if (!image) continue;
    const item = document.createElement('div');
    item.className = 'active-route-icon-item';
    item.setAttribute('aria-label', `${label}: ${detail}`);
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.style.width = `${Math.round(image.width / image.pixelRatio)}px`;
    canvas.style.height = `${Math.round(image.height / image.pixelRatio)}px`;
    const pixels = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
    canvas.getContext('2d').putImageData(pixels, 0, 0);
    const strong = document.createElement('strong');
    strong.textContent = label;
    item.append(canvas, strong);
    host.append(item);
  }
}

function setActiveRouteIconLegendOpen(open) {
  const legend = document.getElementById('activeRouteIconLegend');
  if (!legend) return;
  if (open) buildActiveRouteIconLegend();
  legend.hidden = !open;
}

function closeLayersAndActiveRouteIcons() {
  setActiveRouteIconLegendOpen(false);
  selectPanelTab('route');
}

document.getElementById('layersToggle').addEventListener('click', () => {
  const open = layersMenuIsOpen();
  closePlacePicker(true);
  dismissRoadInfo();
  if (open) closeLayersAndActiveRouteIcons();
  else {
    selectPanelTab('layers');
    setActiveRouteIconLegendOpen(true);
  }
  setPanelOpen(true);
  syncLayersToggle();
});
document.getElementById('layersPanelClose').addEventListener('click', closeLayersAndActiveRouteIcons);
document.getElementById('activeRouteIconLegendClose')
  .addEventListener('click', closeLayersAndActiveRouteIcons);

function settingsMenuIsOpen() {
  return document.getElementById('tab-settings').classList.contains('active');
}

function syncSettingsToggle() {
  const toggle = document.getElementById('settingsToggle');
  if (!toggle) return;
  const open = settingsMenuIsOpen();
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Hide settings' : 'Show settings');
  toggle.title = open ? 'Hide settings' : 'Show settings';
}

document.getElementById('settingsToggle').addEventListener('click', () => {
  const open = settingsMenuIsOpen();
  closePlacePicker(true);
  dismissRoadInfo();
  selectPanelTab(open ? 'route' : 'settings');
  setPanelOpen(true);
  if (open) document.getElementById('settingsToggle')?.focus();
  else requestAnimationFrame(() =>
    document.querySelector('#settingsTabs [role="tab"][aria-selected="true"]')?.focus());
});
document.getElementById('settingsPanelClose').addEventListener('click', () => {
  selectPanelTab('route');
  document.getElementById('settingsToggle')?.focus();
});
document.getElementById('tab-settings').addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !settingsMenuIsOpen()) return;
  event.preventDefault();
  selectPanelTab('route');
  document.getElementById('settingsToggle')?.focus();
});

// Dialog close buttons and the version shown inside Getting Started help.
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () =>
  document.getElementById(b.dataset.close).close()));
document.getElementById('mapStateDialog')?.addEventListener('close', () => {
  const pending = readPendingMapRouteIntent();
  if (pending?.stateId === selectedNationalStateId
      && MapStore.availability(selectedNationalStateId) === 'remote') {
    clearPendingMapRouteIntent();
  }
  selectedNationalStateId = null;
  applyNationalMapFeatureStates();
});
// A resurrected iOS PWA can answer localStorage reads with nothing for the
// first moments of a launch. region.js runs synchronously in that window, so
// a device with its home state fully installed can boot as if it had no data:
// national map, no state sources, while every later read (Settings, the
// restored route) sees healthy storage. When the registry turns out to hold
// the active state after all, one reload reboots region.js against working
// storage. The hash marker survives without any storage, so a boot whose
// registry is STILL empty after a marked reload stays on the national map
// instead of looping.
const STORAGE_RETRY_MARK = '#jra-storage-retry';
async function healStorageBlindBoot() {
  if (Region.localDataAvailable) {
    if (location.hash === STORAGE_RETRY_MARK) {
      history.replaceState(null, '', location.pathname + location.search);
    }
    return;
  }
  if (!window.MapStore || location.hash === STORAGE_RETRY_MARK) return;
  for (const delay of [400, 2000]) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    let installed = false;
    try { installed = !!MapStore.installedEntry(Region.id); } catch (error) { /* still blind */ }
    if (installed) {
      location.hash = STORAGE_RETRY_MARK;
      rebootIntoInstalledHomeState();
      return;
    }
  }
}
// Named so a test can observe the decision without navigating the harness.
function rebootIntoInstalledHomeState() { location.reload(); }
healStorageBlindBoot();

// The renderer's bytes must be the manifest's bytes. The .810/.811 field
// failure: a validated store update replaced an archive while the service
// worker kept answering tile ranges from a previous copy (stale chunk
// entries; a first-match duplicate cache entry can defeat even
// version-keyed chunks). This check reads each archive's 127-byte header
// THROUGH the same ranged path the renderer uses and compares the
// PMTiles-declared total size against the installed manifest. Any
// disagreement: have the worker drop every entry for that archive and
// reload once -- the next read fetches one clean copy. The hash marker
// stops a repeatedly-wrong archive from reload-looping.
const ARCHIVE_HEAL_MARK = '#jra-archive-heal';
function pmtilesDeclaredTotal(buffer) {
  if (buffer.byteLength < 127) return null;
  const bytes = new Uint8Array(buffer);
  if (String.fromCharCode(...bytes.slice(0, 7)) !== 'PMTiles') return null;
  const view = new DataView(buffer);
  const u64 = (offset) => view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 2 ** 32;
  return u64(56) + u64(64);
}
async function verifyRenderedArchives() {
  if (!navigator.serviceWorker?.controller || !window.MapStore) return;
  const entry = MapStore.installedEntry(Region.id);
  if (!entry || !Array.isArray(entry.state.files)) return;
  const manifestBytes = new Map(entry.state.files
    .filter((file) => file.path.endsWith('.pmtiles'))
    .map((file) => [new URL(`maps/${entry.state.id}/${file.path}`, location.href).pathname,
      file.bytes]));
  if (!manifestBytes.size) return;
  await new Promise((resolve) => (map.loaded() ? resolve() : map.once('idle', resolve)));
  const sources = map.getStyle().sources || {};
  const stale = [];
  for (const source of Object.values(sources)) {
    const url = typeof source.url === 'string' && source.url.startsWith('pmtiles://')
      ? source.url.slice('pmtiles://'.length) : null;
    if (!url) continue;
    const pathname = new URL(url, location.href).pathname;
    const expected = manifestBytes.get(pathname);
    if (!Number.isFinite(expected)) continue;
    try {
      const head = await fetch(url, { headers: { Range: 'bytes=0-126' } });
      if (head.status !== 206) continue;
      const declared = pmtilesDeclaredTotal(await head.arrayBuffer());
      if (declared != null && declared !== expected) stale.push(pathname);
    } catch (error) { /* offline or transient: verify again next session */ }
  }
  if (!stale.length) {
    if (location.hash === ARCHIVE_HEAL_MARK) {
      history.replaceState(null, '', location.pathname + location.search);
    }
    return;
  }
  if (location.hash === ARCHIVE_HEAL_MARK) {
    console.warn('Stale archives persist after a purge; leaving them to the next update:', stale);
    return;
  }
  for (const pathname of stale) {
    await new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = resolve;
      setTimeout(resolve, 5000);
      navigator.serviceWorker.controller.postMessage(
        { type: 'PURGE_PMTILES_ARCHIVE', pathname }, [channel.port2]);
    });
  }
  location.hash = ARCHIVE_HEAL_MARK;
  location.reload();
}
verifyRenderedArchives();

// A rider should hear that an installed state's map has an update, not
// discover it by opening the Maps screen. The comparison runs against the
// app-shipped index (refreshed with every app update), so the common path --
// an app update whose release also re-cut a state's data -- announces itself
// offline on the very next boot. Dismissal is remembered per offered
// acquisition set: the banner returns only when a NEWER update appears.
const MAP_DATA_UPDATE_DISMISSED_KEY = 'jra-map-update-dismissed-1';
function installedMapUpdateOffers() {
  if (!window.MapStore) return [];
  return MapStore.installedStates()
    .map((entry) => installedMapUpdateOffer(entry.state.id))
    .filter(Boolean);
}
function mapUpdateFingerprint(offers) {
  return offers.map((offer) => (offer.state.acquisitions || [])
    .map((unit) => unit.id).sort().join('+')).sort().join('|');
}
function announceInstalledMapUpdates() {
  const banner = document.getElementById('mapDataUpdatePrompt');
  if (!banner || !document.getElementById('updatePrompt').hidden) return;
  const offers = installedMapUpdateOffers();
  if (!offers.length) return;
  const fingerprint = mapUpdateFingerprint(offers);
  try {
    if (localStorage.getItem(MAP_DATA_UPDATE_DISMISSED_KEY) === fingerprint) return;
  } catch (error) { /* private mode: announce every boot */ }
  const text = document.getElementById('mapDataUpdateText');
  const button = document.getElementById('mapDataUpdateBtn');
  const later = document.getElementById('mapDataUpdateLaterBtn');
  const totalBytes = offers.reduce((sum, offer) => sum + MapStore.stateBytes(offer.state), 0);
  text.textContent = offers.length === 1
    ? `${offers[0].state.name} map update available (${formatMapBytes(totalBytes)})`
    : `${offers.length} map updates available (${formatMapBytes(totalBytes)})`;
  button.textContent = offers.length === 1 ? 'Update' : 'Open Maps';
  button.disabled = false;
  button.onclick = async () => {
    if (offers.length > 1) {
      banner.hidden = true;
      openMapsDialog();
      return;
    }
    button.disabled = true;
    const installed = await downloadStoreState(offers[0].storeUrl, offers[0].state, button,
      { onStatus: (message) => { text.textContent = message; } });
    // New data binds at boot, exactly like a fresh home-state install.
    if (installed) rebootIntoInstalledHomeState();
    else button.disabled = false;
  };
  later.onclick = () => {
    try { localStorage.setItem(MAP_DATA_UPDATE_DISMISSED_KEY, fingerprint); }
    catch (error) { /* private mode */ }
    banner.hidden = true;
  };
  banner.hidden = false;
}
setTimeout(announceInstalledMapUpdates, 3500);
initializeNationalOrientation();
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
  // The map DATA the renderer is serving, per archive, so a field report can
  // name exactly which map bytes drew a bad pixel. These are the content
  // stamps region.js bound at boot -- for a store-installed state, what the
  // registry says is installed.
  const stamps = ['regional', 'basemap', 'roads', 'overlays']
    .filter((dataset) => Region.datasets?.[dataset] && Region.versions?.[dataset])
    .map((dataset) => `${dataset} ${String(Region.versions[dataset]).replace(/^sha-/, '').slice(0, 6)}`)
    .join(' · ');
  el.textContent = `v${APP_VERSION} · ${graph}`
    + (stamps ? `\n${Region.name} map data: ${stamps}` : '')
    + (t ? `\nlast route search ${(t.totalMs / 1000).toFixed(1)}s`
      + (phases ? ` (${phases})` : '') : '');
}
syncGraphVersionLine();
const nativeAppVersionOnly = isNativeAppRuntime();
if (nativeAppVersionOnly) {
  document.getElementById('iosAppVersionLabel').hidden = false;
}
document.getElementById('techDetailsBtn').addEventListener('click', () => openHelp('technical'));
document.getElementById('startTourBtn').addEventListener('click', () => {
  document.getElementById('helpDialog')?.close();
  openOnboarding();
});
// The optional Settings tab keeps these expert controls out of the map chrome.
// Build it when selected so its values and considered-route availability are
// always current without paying the editor cost during normal route planning.
function prepareRoutingWeightsPane() {
  buildAdvancedRoutingOptions();
  buildRoutingWeightsEditor();
  syncWeightsTunedBadge();
  syncSettingsNavigationLock();
  syncConsideredRoutesButton();
}

function openRoutingWeights() {
  if (!uiPrefs.showAdvancedTools) return false;
  if (!settingsMenuIsOpen()) {
    selectPanelTab('settings');
    setPanelOpen(true);
  }
  settingsPaneSelect?.('weights');
  return true;
}

// The route warning badges -- walk, hill, traffic, unpaved, fails -- as one
// switch. The ferry marker stays: it marks a leg of the trip, not a warning.
// Hiding the dismount marker also retires its widened tap halo, which is the
// honest pairing: an icon that is not there should not be answering taps.
const ROUTE_WARNING_ICON_LAYERS = ['route-marker', 'route-fail-marker',
  'route-dismount-marker', 'route-dismount-halo'];
function syncRouteWarningIconVisibility() {
  const visibility = uiPrefs.hideRouteWarningIcons ? 'none' : 'visible';
  for (const id of ROUTE_WARNING_ICON_LAYERS) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
  }
}

function syncAdvancedToolsVisibility() {
  const weightsTab = document.getElementById('settings-tab-weights');
  if (weightsTab) weightsTab.hidden = !uiPrefs.showAdvancedTools;
  if (!uiPrefs.showAdvancedTools
      && document.getElementById('settings-weights')?.hidden === false) {
    settingsPaneSelect?.('rules');
  }
  renderRouteOptionControls();
  syncSettingsPaneHeight();
}
// A weight left off its default silently changes every route. Mark the tab so
// the changed state remains discoverable whenever the advanced UI is enabled.
function syncWeightsTunedBadge() {
  const button = document.getElementById('settings-tab-weights');
  const changedWeights = Object.keys(DEFAULT_ROUTING_WEIGHTS)
    .filter((key) => routingWeights[key] !== DEFAULT_ROUTING_WEIGHTS[key]);
  const changedOptions = [
    ...ADVANCED_ROUTE_PREFERENCE_KEYS.filter((key) =>
      routing[key] !== ADVANCED_ROUTE_OPTION_DEFAULTS[key]),
    ...ADVANCED_ROUTE_RULE_KEYS.filter((key) =>
      rules[key] !== ADVANCED_ROUTE_OPTION_DEFAULTS[key]),
  ];
  const changed = changedWeights.length + changedOptions.length;
  if (button) {
    button.classList.toggle('tuned', changed > 0);
    button.title = changed
      ? `Advanced routing (${changed} changed from default)`
      : 'Advanced routing weights';
  }
  const notice = document.getElementById('weightsModifiedNotice');
  if (notice) {
    notice.hidden = changed === 0;
    notice.textContent = changed === 1
      ? 'Advanced routing has been modified (1 change)'
      : `Advanced routing has been modified (${changed} changes)`;
  }
}
document.getElementById('moreRoutesBtn')?.addEventListener('click', openAllRoutes);
syncWeightsTunedBadge();
syncAdvancedToolsVisibility();
document.getElementById('layersHelpBtn').addEventListener('click', () =>
  openHelp('layers'));
document.getElementById('routesHelpBtn').addEventListener('click', () => {
  document.getElementById('routesDialog').close();
  openHelp('save-share');
});

function isNativeAppRuntime() {
  return document.documentElement.dataset.appRuntime === 'native'
    || window.location.protocol === 'capacitor:'
    || Boolean(window.Capacitor?.isNativePlatform?.());
}

function isStandaloneApp() {
  return isNativeAppRuntime()
    || window.matchMedia('(display-mode: standalone)').matches
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
  // One banner at a time, and the app update comes first: it usually carries
  // the very index that announces the map update on the next boot.
  const mapBanner = document.getElementById('mapDataUpdatePrompt');
  if (mapBanner) mapBanner.hidden = true;
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
      // The reload is the point; a storage failure in the save must not eat it.
      try { saveStateNow(); } finally { location.reload(); }
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

document.getElementById('getUpdateBtn').addEventListener('click', async () => {
  saveStateNow();
  updateAccepted = true;
  // Take the banner down on the way out. Leaving it up through the handover
  // made a successful update look like it was being offered all over again.
  document.getElementById('updatePrompt').hidden = true;
  // Resolve the worker at tap time rather than trusting the reference captured
  // when the banner went up. That reference goes stale whenever a newer release
  // lands while the banner is showing: the browser discards the old waiting
  // worker for the incoming one, postMessage to the discarded worker is a
  // silent no-op, and the button did nothing (field report, 2026-08-25).
  let worker = null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    worker = reg?.waiting || reg?.installing || null;
  } catch (e) { /* fall through to the captured worker */ }
  if (!worker && pendingUpdateWorker?.state !== 'redundant') worker = pendingUpdateWorker;
  if (worker) {
    const skip = () => worker.postMessage({ type: 'SKIP_WAITING' });
    if (worker.state === 'installed') skip();
    else worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') skip();
    });
  }
  // The handover normally lands in controllerchange above, which reloads. If
  // it has not within a few seconds — the worker died, the event was missed —
  // reload anyway: the rider asked for a restart, so restart. At worst the
  // banner re-offers a release that is still installing.
  setTimeout(() => location.reload(), 8000);
});
document.getElementById('updateLaterBtn').addEventListener('click', () => {
  deferredUpdateWorker = pendingUpdateWorker;
  document.getElementById('updatePrompt').hidden = true;
});
setupAutomaticUpdates();

// Manual "Check for updates" from Help or the trip menu. Wired independently
// of setupAutomaticUpdates so a slow or stalled service-worker registration
// never leaves either button dead.
async function publishedAppVersion() {
  // The unique query is deliberate: an older cache-first service worker will
  // miss this URL and retrieve the current release marker from the network.
  // Native assets are bundled, so their local marker can never report a newer
  // build; ask the published app directly instead.
  const base = nativeAppVersionOnly
    ? 'https://nothinglabs.github.io/randoroute/version.json'
    : './version.json';
  const response = await fetch(`${base}?update-check=${Date.now()}`, {
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

function setManualUpdateStatus(text, { busy = false, duration = 4200 } = {}) {
  const status = document.getElementById('updateCheckStatus');
  status.textContent = text;
  // The rider clicked and this is the reply, so it holds the shared toast --
  // see showRouteActionToast. "Checking..." is not an answer and does not.
  showRouteActionToast(text, { busy, duration: busy ? 0 : duration, answer: !busy });
}

async function runManualUpdateCheck() {
  const buttons = [document.getElementById('checkUpdatesBtn'),
    document.getElementById('routeUpdateBtn')].filter(Boolean);
  buttons.forEach((button) => { button.disabled = true; });
  setManualUpdateStatus('Checking for updates…', { busy: true });
  try {
    if (nativeAppVersionOnly) {
      const publishedVersion = await publishedAppVersion();
      setManualUpdateStatus(publishedVersion === APP_VERSION
        ? `You have the latest version (v${APP_VERSION}).`
        : `A newer iOS build is available (v${publishedVersion}).`);
      return;
    }
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
      setManualUpdateStatus('Update ready — tap “Restart to update”.');
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
      setManualUpdateStatus(`You have the latest version (v${APP_VERSION}).`);
      return;
    }
    setManualUpdateStatus(`Version v${publishedVersion} found — fetching it…`, { busy: true });
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
    setManualUpdateStatus(`Version v${publishedVersion} found — installing…`, { busy: true });
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
      setManualUpdateStatus('Update found — installing…', { busy: true });
      // Attach AND check immediately, like setupAutomaticUpdates: a fast
      // install reaches `installed` before a bare listener exists, and the
      // field then sat on "installing…" forever with no Restart banner. A
      // worker that dies (`redundant` -- one shell file failed to fetch) must
      // say so instead of spinning; and a hard-reloaded page has no
      // controller, so the banner cannot show -- tell the rider to reload.
      const offerInstalled = () => {
        const ready = reg.waiting || (fresh.state === 'installed' ? fresh : null);
        if (fresh.state === 'redundant') {
          setManualUpdateStatus('The update could not be installed — check your'
            + ' connection and try again.');
          return;
        }
        if (!ready) return;
        offerUpdate(ready);
        if (document.getElementById('updatePrompt').hidden) {
          setManualUpdateStatus('Update ready — reload this page to finish installing.');
        }
      };
      fresh.addEventListener('statechange', offerInstalled);
      offerInstalled();
      // The update prompt renders under this modal dialog; close it so the
      // "Get update?" banner is visible.
      document.getElementById('helpDialog')?.close();
    } else if (publishedVersion !== APP_VERSION) {
      setManualUpdateStatus(`Version v${publishedVersion} is published but has not reached this device yet.`
        + ' A release can take a couple of minutes to propagate. Try again shortly,'
        + ' or fully close and reopen the app.', { duration: 6500 });
    } else {
      setManualUpdateStatus(`You have the latest version (v${APP_VERSION}).`);
    }
  } catch (e) {
    setManualUpdateStatus('Could not check right now — make sure you are online and try again.');
  } finally {
    // In a finally, because the quick answers above return early: without it
    // the button re-enabled only on the slow path, so the first check left it
    // dead for the rest of the session.
    buttons.forEach((button) => { button.disabled = false; });
  }
}

document.getElementById('checkUpdatesBtn').addEventListener('click', runManualUpdateCheck);
document.getElementById('routeUpdateBtn').addEventListener('click', runManualUpdateCheck);



// Run cb as soon as the style spec is loaded. Polling avoids a styledata-event
// race, and isStyleLoaded flips true independent of basemap TILE loading, so a
// slow or unreachable basemap never blocks the data layers.
function onStyleReady(cb) {
  const check = () => (map.isStyleLoaded() ? cb() : setTimeout(check, 120));
  check();
}

onStyleReady(() => {
  if (!Region.localDataAvailable) return;
  // Visual toggles must not create holes in street-information popups. Load
  // every source once; updateVisibility() independently hides painted lines.
  Promise.all(SOURCES.map((src) => loadSource(src)))
    .finally(syncVisibleDetailedMapSources);
  ensureTapHighlightLayers();
});

/* What the open card is describing. A dot said "somewhere about here"; the
 * stretch of road itself says exactly which piece the verdict is about, and it
 * works the same whether the tap landed on the drawn route or on an ordinary
 * road beside it -- both feed this one source their geometry. It lives with
 * the permanent layers rather than the route's, because a rider can tap a road
 * long before asking for a route.
 *
 * It must not paint over the road. The first version drew a solid yellow core
 * on top, which covered the segment's verdict colour with something that read
 * as a bike facility -- so tapping a road to ask "how safe is this?" replaced
 * the answer with a lie. These layers are OFFSET to either side: two bright
 * lines that ride alongside the road and ripple outward, leaving the verdict
 * colour untouched between them.
 *
 * Two ripples, half a cycle apart, so one is always visible. The map already
 * speaks two animations and this has to be none of them:
 *
 *   caution  a halo BREATHING in and out of the line, attached to it, amber
 *   fail     red ticks MARCHING along the line
 *   selected two bright rails LEAVING the road sideways and fading
 *
 * Different axis from the ticks, and a different shape from the halo, which
 * never detaches or vanishes. Each rail is a pale core over a dark edge: the
 * map is full of blue passing roads, lime facilities, amber caution and red
 * failure, so no single hue is safe -- and red-green colour blindness flattens
 * hue anyway. Two tones at opposite ends of the LIGHTNESS scale means one of
 * them stands out against whatever the rail is crossing.
 */
// One pair in flight at a time. Two, half a cycle apart, kept something on
// screen at every instant but drew four rails at once, and four parallel lines
// around a street read as a corridor rather than as brackets on one road.
const TAP_RIPPLES = [{ id: 'a', phase: 0 }];
// One layer, centred on the road. The rails are gone: two lines travelling
// outward read as a corridor being drawn rather than a thing being picked, and
// living with them they simply felt wrong (field report).
const TAP_RIPPLE_SIDES = [['centre', 0]];
// The dark edge is added first so the pale core paints over its middle, leaving
// it showing as a thin outline on both flanks of the core.
// A single achromatic glow. Achromatic on purpose: it cannot be mistaken for a
// verdict colour, which is the whole reason the original green wash had to go.
// It pulses hard and clears completely between pulses, so the road's own colour
// is never hidden for longer than the swell.
const TAP_RIPPLE_PARTS = [
  { part: 'glow', color: 'selection', extra: 0, opacity: 1 },
];
const tapRippleLayerId = (ripple, side, part) => `tap-highlight-${ripple}-${side}-${part}`;
const TAP_HIGHLIGHT_LAYERS = TAP_RIPPLES.flatMap((ripple) =>
  TAP_RIPPLE_PARTS.flatMap(({ part }) =>
    TAP_RIPPLE_SIDES.map(([side]) => tapRippleLayerId(ripple.id, side, part))));
// Where a rail is born and where it dies, in pixels from the road's centre.
// TAP_RIPPLE_NEAR is measured, not chosen: the drawn route is the widest line
// on the map at about 9 px, so its edge is 4.5 px out, and a rail's dark edge
// is 3.5 px half-width. Starting at 8.5 leaves daylight over even that, which
// is the case a rider taps most -- a road on their own route.
const TAP_RIPPLE_NEAR = 8.5, TAP_RIPPLE_FAR = 17;
const TAP_RIPPLE_CORE_WIDTH = 3.6;

// ...but those pixel figures are sized for a road drawn at full zoom, and they
// were applied at every zoom. The rails' footprint was the same ~45 px whether
// the road beneath them was 10 px wide or 2, so zoomed out the highlight buried
// the very thing it was pointing at (field report: "too much, especially if
// zoomed out; less huge, and consistent at various zoom levels").
//
// Consistency here means the same SHAPE against the road, not the same number
// of pixels. Every other line on the map is on a zoom ramp; the highlight now
// rides one too, and because the clearance rule above is proportional -- rails
// outside the route line -- scaling both together keeps it satisfied.
const TAP_RIPPLE_MIN_SCALE = 0.42;
const TAP_RIPPLE_FULL_ZOOM = 15, TAP_RIPPLE_MIN_ZOOM = 10;
function tapRippleScale() {
  const zoom = map.getZoom();
  if (zoom >= TAP_RIPPLE_FULL_ZOOM) return 1;
  if (zoom <= TAP_RIPPLE_MIN_ZOOM) return TAP_RIPPLE_MIN_SCALE;
  const t = (zoom - TAP_RIPPLE_MIN_ZOOM) / (TAP_RIPPLE_FULL_ZOOM - TAP_RIPPLE_MIN_ZOOM);
  return TAP_RIPPLE_MIN_SCALE + (1 - TAP_RIPPLE_MIN_SCALE) * t;
}

function ensureTapHighlightLayers() {
  if (map.getSource('tap-highlight')) return;
  map.addSource('tap-highlight', {
    type: 'geojson',
    data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } },
  });
  for (const ripple of TAP_RIPPLES) {
    for (const { part, color, extra } of TAP_RIPPLE_PARTS) {
      for (const [side, sign] of TAP_RIPPLE_SIDES) {
        map.addLayer({
          id: tapRippleLayerId(ripple.id, side, part),
          type: 'line', source: 'tap-highlight',
          layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
          paint: {
            'line-color': RoutePalette[color],
            'line-offset': sign * TAP_RIPPLE_NEAR,
            'line-width': TAP_RIPPLE_CORE_WIDTH + extra,
            'line-opacity': 0,
            'line-blur': 0.4,
          },
        });
      }
    }
  }
  // The animation repaints every 60 ms and so picks the zoom scale up on its
  // own, but a rider who has asked for reduced motion gets one resting paint
  // and nothing after it. Without this, zooming out left their highlight
  // frozen at the scale it was drawn at -- which is the case this whole ramp
  // exists to fix.
  map.on('zoom', () => {
    if (tapRippleTimer != null) return;
    if (!map.getLayer(TAP_HIGHLIGHT_LAYERS[0])) return;
    if (map.getLayoutProperty(TAP_HIGHLIGHT_LAYERS[0], 'visibility') === 'none') return;
    restTapRipple();
  });
}

/* The ripple itself. Sine over the cycle, so each pair fades in as it leaves
 * the road and is gone by the time it reaches the far edge -- a wave leaving,
 * not an edge sliding back and forth.
 */
// Twice the old rate. The step halves with the period: 60 ms was 25 frames per
// cycle at 1500, and keeping it there would have given a 750 ms pulse only 12 --
// a fast pulse drawn coarsely reads as a flicker, not a swell. Only ticks while
// a selection is on screen.
const TAP_RIPPLE_STEP_MS = 30;
const TAP_RIPPLE_PERIOD_MS = 750;
let tapRippleTimer = null;
let tapRippleElapsed = 0;

// One place that turns "how far through its travel is this rail" into paint, so
// the moving and the resting states cannot drift apart: resting is progress 0.
// A swell that lifts the tapped stretch off the map and falls away again. The
// width and the blur grow together so it reads as light coming off the road
// rather than a second line laid over it, and the peak is brief.
const TAP_GLOW_MIN_WIDTH = 7, TAP_GLOW_MAX_WIDTH = 26;
// Peaks at FULL white. The swell is brief and clears completely, so the road's
// colour is gone only at the very top of the pulse -- which is what makes it
// dramatic rather than what made the old green wash unusable, since that never
// cleared at all. The RESTING swell is held low for the same reason: held
// still, and under reduced motion, the verdict has to stay readable.
const TAP_GLOW_PEAK_OPACITY = 1;
const TAP_GLOW_REST_SWELL = 0.4;
function paintTapRipple(ripple, progress) {
  const scale = tapRippleScale();
  const swell = progress === 0 ? TAP_GLOW_REST_SWELL : Math.sin(Math.PI * progress) ** 0.5;
  // ^0.6 fills the middle of the travel out rather than peaking sharply, so the
  // pair is bright for most of its journey and only thins at the extremes. At
  // rest (progress 0) sine is 0, so the resting state substitutes full strength.
  for (const { part, opacity } of TAP_RIPPLE_PARTS) {
    for (const [side] of TAP_RIPPLE_SIDES) {
      const id = tapRippleLayerId(ripple, side, part);
      if (!map.getLayer(id)) continue;
      setPaint(id, 'line-offset', 0);
      setPaint(id, 'line-opacity', opacity * TAP_GLOW_PEAK_OPACITY * swell);
      setPaint(id, 'line-width',
        (TAP_GLOW_MIN_WIDTH + (TAP_GLOW_MAX_WIDTH - TAP_GLOW_MIN_WIDTH) * swell) * scale);
      // Blur tracks width, so the swell is light spreading rather than a band
      // widening -- and it keeps the centre soft enough to read the road under.
      setPaint(id, 'line-blur', (2 + 6 * swell) * scale);
    }
  }
}

// Held still: both pairs parked close in at full strength. This is what a
// screenshot shows, and what a rider who has asked for reduced motion sees --
// the segment still reads as picked out, because the flanking rails carry that
// on their own and the animation only makes them easier to catch.
function restTapRipple() {
  for (const ripple of TAP_RIPPLES) paintTapRipple(ripple.id, 0);
}

function startTapRipple() {
  stopTapRipple();
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    restTapRipple();
    return;
  }
  tapRippleElapsed = 0;
  const tick = () => {
    const base = (tapRippleElapsed % TAP_RIPPLE_PERIOD_MS) / TAP_RIPPLE_PERIOD_MS;
    for (const ripple of TAP_RIPPLES) {
      // Never exactly 0, which paintTapRipple reserves for the resting state.
      paintTapRipple(ripple.id, ((base + ripple.phase) % 1) || 0.001);
    }
  };
  tick();
  tapRippleTimer = setInterval(() => {
    tapRippleElapsed += TAP_RIPPLE_STEP_MS;
    tick();
  }, TAP_RIPPLE_STEP_MS);
}

function stopTapRipple() {
  if (tapRippleTimer) clearInterval(tapRippleTimer);
  tapRippleTimer = null;
}

// Debug handle (harmless; used for local verification).
window.VIS = { map, SOURCES, rules, rescoreAll, effectiveLevel };
