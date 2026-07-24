/*
 * Washington Bike Safety Visualizer
 *
 * All road, trail, ferry, restriction, and elevation data is baked into local
 * static files. Routing runs on-device in a web worker; the only optional
 * runtime lookup is the rider-initiated online place search.
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

const APP_VERSION = '2026-07-23.336';
// Increment whenever router-worker.js changes the binary graph contract. It
// keeps a just-updated worker from receiving a graph cached by an older
// service worker during the first post-update load.
const GRAPH_FORMAT_VERSION = 'bgr8-3';
const OFFICIAL_DISMOUNT = 8;
const OFFICIAL_SIDEWALK = 16;
const OFFICIAL_SIDEWALK_NO = 32;
const OFFICIAL_URBAN = 64;
const SIGNIFICANT_UNPAVED_M = 1609.344;

/* ---------------------------------------------------------------- palette */
// One visual verdict system. Internal levels 1 and 2 retain different routing
// costs but share blue; a passing bike-network edge is promoted to lime.
// Caution is amber, failure is red, and insufficient data is gray.
const BIKE_NETWORK_COLOR = '#9fc400';
const COLORS = {
  1: '#168ad1', // passes rules
  2: '#168ad1', // passes rules (internal levels remain distinct for routing)
  3: '#c46b00', // caution — amber, immediately distinct from blue pass roads
  4: '#b2182b', // fails rules
  0: '#999999', // insufficient data
};
const ROUTE_SURFACE_LABEL = ['Unknown', 'Paved', 'Gravel / compacted', 'Unpaved'];
function routeSurfaceLabel(surface) {
  const value = Number(surface);
  return Number.isInteger(value) && value >= 0 && value < ROUTE_SURFACE_LABEL.length
    ? ROUTE_SURFACE_LABEL[value] : ROUTE_SURFACE_LABEL[0];
}
function isConfirmedUnpavedSurface(surface) {
  const value = Number(surface);
  return value === 2 || value === 3;
}
function isDismountSegment(segment) {
  return !!segment?.dismount || !!((segment?.official || 0) & OFFICIAL_DISMOUNT);
}

/* ------------------------------------------------- riding-rules state */
const DEFAULT_RULES = Object.freeze({
  allowFreeways: true,  // only permit heavily penalized freeway fallback?
  allowMtbTrails: false, // technical MTB paths are opt-in, not ordinary bike routing
  preferPaved: false,   // strong pavement preference; a modest baseline remains
  vettedBikeRoutes: true, // let designated corridors pass despite missing/narrow shoulder data?
  minShoulder: 4,       // ft; below this a road gets penalized
  unknownShoulderZero: true, // pessimistic: no shoulder data = 0 ft (fast roads must PROVE a shoulder)
  urbanMaxSpeedNoShoulder: 30, // mph; at/below this an urban road passes without a shoulder
  ruralMaxSpeedNoShoulder: 35, // mph; at/below this a rural road passes without a shoulder
  allowSidewalkFallback: true, // a mapped sidewalk can satisfy the shoulder rule, with caution
  upperMaxSpeed: 45,    // mph; roads above this absolute cutoff fail
  noUpperLimit: true,   // disable the upper-speed hard cap
  requireSafe: false,   // limit the portfolio to routes whose every edge matches the rules
});
const rules = { ...DEFAULT_RULES };
const RULE_NUMBER_LIMITS = {
  minShoulder: [0, 10],
  urbanMaxSpeedNoShoulder: [15, 45],
  ruralMaxSpeedNoShoulder: [15, 45],
  upperMaxSpeed: [25, 65],
};

// Soft route-choice costs. These never make an edge legal or illegal; the
// rider-facing Limits remain the hard safety rules. Kept in one shared shape
// with router-worker.js so the advanced desktop editor is reproducible.
const DEFAULT_ROUTING_WEIGHTS = Object.freeze({
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
  ferryWaitMin: 15, uphillFactor: 7, downhillFactor: 2.5, undulationSecPerM: 3,
  climbDirectSecPerM: 0.25, climbBalancedSecPerM: 0.9, climbLowSecPerM: 1.6,
  turnDirectSec: 6, turnBalancedSec: 11, turnLowSec: 15,
  diversityQuick: 1.3, diversityBalanced: 1.35, diversitySafer: 1.35, diversityWide: 1.6,
});
const ROUTING_WEIGHTS_VERSION = 8;
function validRoutingWeights(source) {
  const clean = {};
  const zeroOkay = new Set(['ferryWaitMin', 'speedBalanced', 'speedLow',
    'speedBelowDirect', 'speedBelowBalanced', 'speedBelowLow', 'downhillFactor', 'undulationSecPerM',
    'climbDirectSecPerM', 'climbBalancedSecPerM', 'climbLowSecPerM',
    'turnDirectSec', 'turnBalancedSec', 'turnLowSec']);
  if (!source || typeof source !== 'object') return clean;
  for (const key of Object.keys(DEFAULT_ROUTING_WEIGHTS)) {
    const value = Number(source[key]);
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
  // Preserve existing custom settings and shared links made before the
  // urban/rural split.  New installs use the Randonneur 30/35 defaults.
  const legacyNoShoulderMax = Number(source.freeMaxSpeed);
  if (Number.isFinite(legacyNoShoulderMax)) {
    for (const key of ['urbanMaxSpeedNoShoulder', 'ruralMaxSpeedNoShoulder']) {
      if (clean[key] == null) {
        const [min, max] = RULE_NUMBER_LIMITS[key];
        clean[key] = Math.min(max, Math.max(min, legacyNoShoulderMax));
      }
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

// Caution has a specific semantic meaning, so keep it solid enough to avoid
// a dashed layer beneath showing through at the normal background opacity.
function cautionBackgroundLineOpacity() {
  return routeIsDisplayed ? 0.65 : 0.76;
}

/* ------------------------------------------------------- the scorers */
// Each returns normalized props. baseScore null => unknown (gray).

function scoreBLTS(p) {
  // WSDOT already computed LTS_Bicycle (1-4). Use it directly; missing => unknown.
  const lts = p.LTS_Bicycle;
  return {
    baseScore: lts == null ? null : lts,
    shoulder_width: p.ShoulderWidth == null ? null : p.ShoulderWidth,
    maxspeed_num: p.SpeedLimit == null ? null : p.SpeedLimit,
    prohibited: !!p.Prohibited, // overlaps a WSDOT permanent bike restriction
    wsdotBan: !!p.Prohibited,
    restricted: false,
    freeway: false,
    limited_access: !!p.LimitedAccess,
    good_facility: !!(p.BikeFacilityType && p.BikeFacilityType.length),
    infra: false,
    desig: p.Designated === 1, // on a designated bike route (USBR / regional)
    urban: p.Urban === 1,
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
function scoreOSM(p) {
  const bike = p.bicycle;
  const hw = p.highway;
  const cw = osmCycleway(p);
  const bikeish = hw === 'cycleway' || hw === 'path' || hw === 'bridleway'
    || hw === 'track' || hw === 'service' || cw != null;
  let base = null;
  let prohibited = false;
  const dismount = bike === 'dismount';
  if (hw === 'cycleway' && bike !== 'no') base = 1;
  else if (hw === 'path' && (bike === 'designated' || bike === 'yes')) base = 1;
  else if (hw === 'footway' && bike === 'designated') base = 2;
  else if (hw === 'bridleway' && (bike === 'designated' || bike === 'yes')) base = 2;
  else if (hw === 'track' && (bike === 'designated' || bike === 'yes')) base = 2;
  else if (hw === 'service' && bike === 'designated'
      && (p.motor_vehicle === 'no' || p.motor_vehicle === 'private'
        || p.access === 'no' || p.access === 'private')) base = 1;
  else if (OSM_PROTECTED.has(cw)) base = 1;
  else if (OSM_LANE.has(cw)) base = 2;
  else if (bike === 'no' && bikeish) { base = 4; prohibited = true; }
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
    limited_access: p.m === 1,
    good_facility: p.f === 1,
    infra: false,
    est: p.e === 1,
    desig: p.g === 1, // on a designated bike route (USBR / regional)
    sidewalk: p.k === 1 ? 'present' : p.k === 2 ? 'absent' : null,
    urban: p.u === 1,
  };
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
function noShoulderMaxSpeed(n) {
  return n.urban ? rules.urbanMaxSpeedNoShoulder : rules.ruralMaxSpeedNoShoulder;
}

function sidewalkFallbackApplies(n, speed = n.maxspeed_num, shoulder = n.shoulder_width) {
  return rules.allowSidewalkFallback && n.sidewalk === 'present'
    && !n.good_facility && speed != null && speed > noShoulderMaxSpeed(n)
    && shoulder != null && shoulder < rules.minShoulder;
}

// "Your criteria decide", as HARD gates: each criterion is pass/fail. A road
// fails (level 4 = avoid) if the data we have shows any criterion is not met.
// Missing data does NOT fail a road — only a known-bad value does. Level 3 is
// reserved for a bike-legal WSDOT limited-access highway that otherwise meets
// the rider's rules: a useful caution, not a failed route criterion.
function effectiveLevel(n) {
  if (n.prohibited) return 4;                              // bikes not allowed
  if (n.freeway) return 4;                                 // true motorway: last resort

  // Dedicated bike infrastructure: the infra type IS the rating (cycleway = 1,
  // bike lane = 2). The car-speed/shoulder rules don't apply to it.
  if (n.infra) return n.baseScore == null ? 0 : n.baseScore;

  const spd = n.maxspeed_num;
  // This setting is an absolute road-speed ceiling. It comes before the
  // slow-road and designated-route shortcuts so the UI's “Never allow” label
  // always means what it says. Dedicated bike infrastructure remains exempt.
  const speedFails = !rules.noUpperLimit && spd != null && spd > rules.upperMaxSpeed;
  if (speedFails) return 4;
  // Pessimistic option: an unknown shoulder counts as 0 ft, so fast roads must
  // PROVE an adequate shoulder to pass. Slow roads are unaffected (free-speed
  // rule below fires first) and so are roads with a bike facility.
  const sh = n.shoulder_width == null && rules.unknownShoulderZero ? 0 : n.shoulder_width;

  // Slow enough → comfortable regardless of shoulder.  The local Census
  // classification distinguishes a 35 mph rural road from urban exposure.
  const noShoulderMax = noShoulderMaxSpeed(n);
  if (spd != null && spd <= noShoulderMax) return n.limited_access ? 3 : 1;

  // A rider can opt to treat a designated bike route (USBR / regional trail)
  // as a vetted corridor. The freeway, prohibition, and speed-cutoff gates
  // above still apply; otherwise it is evaluated by the shoulder rule.
  if (n.desig && rules.vettedBikeRoutes) return n.limited_access ? 3 : 2;

  // Hard gates. Each fails ONLY when we have data proving the violation
  // (with the pessimistic option, "unknown = 0 ft" counts as data).
  const shoulderFails = !n.good_facility && sh != null && sh < rules.minShoulder;
  // A mapped sidewalk is an opt-in fallback, not bike infrastructure. It
  // meets the shoulder rule so strict filtering can use it, but stays amber.
  if (shoulderFails && sidewalkFallbackApplies(n, spd, sh)) return 3;
  if (shoulderFails) return 4;

  // No usable data on any criterion → unknown.
  if (spd == null && sh == null && !n.good_facility) return 0;

  return n.limited_access ? 3 : 2; // caution, or meets your criteria
}

/* ------------------------------------------------ data-source registry */
// zRank controls draw order: higher ranks render on top of lower ones.
const SOURCES = [
  {
    id: 'routes',
    name: 'Designated routes (USBR & regional)',
    url: 'data/bikeroutes.geojson',
    scorer: scoreRouteOverlay,
    zRank: -1,     // a ribbon UNDER the scoring layers
    ribbon: true,  // informational overlay: identical in both display modes
    enabled: true,
    fc: null,
    loading: false,
  },
  {
    id: 'blts',
    name: 'WSDOT BLTS (state highways)',
    url: 'data/blts.geojson',
    scorer: scoreBLTS,
    zRank: 1,
    enabled: true,
    fc: null,     // cached FeatureCollection (loaded once)
    loading: false,
  },
  {
    id: 'osm',
    name: 'OSM bike infrastructure',
    url: 'data/bikeinfra.geojson',
    scorer: scoreOSM,
    zRank: 2,
    minVisibleZoom: 10,
    enabled: true,
    fc: null,
    loading: false,
  },
  {
    id: 'restrict',
    name: 'Bikes prohibited (WSDOT)',
    url: 'data/bike_restrictions.geojson',
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
    url: 'data/route_closures.geojson',
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
    vector: 'pmtiles://data/roads.pmtiles?v=10',
    sourceLayer: 'roads',
    count: 324089, // baked at build time (tiles don't carry a global count)
    scorer: scoreRoad,
    zRank: 0,      // bottom: authoritative layers draw on top
    expr: true,    // scored via map expressions (works identically on tiles)
    minVisibleZoom: 10,
    enabled: true,  // on by default; automatically decluttered when zoomed out
    fc: null,
    loading: false,
  },
];

// Layer toggles restore from the persisted state (before panels build).
try {
  const st = JSON.parse(localStorage.getItem('wa-bike-state-1') || 'null');
  if (st && st.sources) for (const s of SOURCES) if (st.sources[s.id] != null) s.enabled = st.sources[s.id];
} catch (e) { /* ignore */ }
// Closures are an informational map annotation, not a user-selectable data
// layer. Keep them visible even if an older saved preference disabled them.
for (const src of SOURCES) if (src.closure) src.enabled = true;
// The pass/fail presentation was removed from the UI; use the normal
// low-to-high stress colors even for visitors with an older saved preference.
display.passFail = false;

// Level as a MapLibre expression for expression-scored sources. Mirrors
// effectiveLevel() for road props (speed always present; flags optional).
// Rules are baked in as constants — on any rule change we rebuild the
// expression and re-apply paint/filters, which is instant at any data size.
function roadLevelExpr() {
  const spd = ['get', 's'];
  const noShoulderMax = ['case', ['==', ['get', 'u'], 1],
    rules.urbanMaxSpeedNoShoulder, rules.ruralMaxSpeedNoShoulder];
  const cases = [];
  cases.push(['==', ['get', 'b'], 1], 4);                       // bikes prohibited
  cases.push(['==', ['get', 'm'], 1], 4);                       // freeway: last-resort failure
  if (!rules.noUpperLimit) cases.push(['>', spd, rules.upperMaxSpeed], 4); // absolute speed cap
  cases.push(['<=', spd, noShoulderMax], 1);                    // slow = comfortable
  if (rules.vettedBikeRoutes)
    cases.push(['==', ['get', 'g'], 1], 2);                     // designated route = vetted
  // Shoulder gate: pessimistic mode treats a missing shoulder as 0 ft;
  // otherwise only a known-narrow shoulder fails.
  const sh = rules.unknownShoulderZero
    ? ['coalesce', ['get', 'w'], 0]
    : ['case', ['has', 'w'], ['get', 'w'], rules.minShoulder]; // unknown -> never under
  const shoulderFailure = ['all', ['!=', ['get', 'f'], 1], ['<', sh, rules.minShoulder]];
  if (rules.allowSidewalkFallback) {
    cases.push(['all', shoulderFailure, ['==', ['get', 'k'], 1]], 3);
    cases.push(['all', shoulderFailure, ['!=', ['get', 'k'], 1]], 4);
  } else {
    cases.push(shoulderFailure, 4);
  }
  return ['case', ...cases, 2];                                  // meets criteria
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

// Voice guidance is a local device preference, not part of a shared route.
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
  offRouteMode: savedOffRouteRecoveryMode,
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
    blurb: 'Slower roads, flexible; concerns pulse red.',
    rules: Object.freeze({
      ...DEFAULT_RULES,
      allowFreeways: false,
      vettedBikeRoutes: false,
      urbanMaxSpeedNoShoulder: 25,
      ruralMaxSpeedNoShoulder: 25,
      upperMaxSpeed: 45,
      noUpperLimit: false,
      requireSafe: false,
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
      vettedBikeRoutes: false,
      urbanMaxSpeedNoShoulder: 25,
      ruralMaxSpeedNoShoulder: 25,
      upperMaxSpeed: 35,
      noUpperLimit: false,
      requireSafe: true,
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
      profileId: ROUTE_PROFILE_IDS.has(data.o) ? data.o : null,
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
function saveStateNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  // An untouched older tab must not overwrite a newer tab's route when a
  // service-worker update reloads every open copy of the app.
  if (!stateDirty) return true;
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({
      rules, passFail: display.passFail,
      mode: routing.mode, profileId: routing.profileId,
      prefDesig: routing.prefDesig, prefResidential: routing.prefResidential,
      voiceHeadings: navVoice.headings, voiceUpdateMin: navVoice.updateMin,
      voiceStatusRoute: navVoice.statusRoute, voiceStatusSpeed: navVoice.statusSpeed,
      voiceStatusMiles: navVoice.statusMiles, voiceStatusEta: navVoice.statusEta,
      navigationOffRouteMode: navVoice.offRouteMode,
      weights: routingWeights, weightsVersion: ROUTING_WEIGHTS_VERSION,
      sources: Object.fromEntries(SOURCES.map((s) => [s.id, !!s.enabled])),
      view: { c: map.getCenter().toArray().map((v) => +v.toFixed(5)), z: +map.getZoom().toFixed(2) },
      route: routing.start && routing.end
        ? {
            s: routing.start, e: routing.end, v: routing.vias.map((x) => x.pt),
            b: routing.blocks.map((x) => x.pt),
            sn: routing.startName, en: routing.endName,
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

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
      positron: {
        type: 'raster',
        tiles: [
          // CARTO Positron raster basemap (background only — not an OSM render).
          'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
          'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
          'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
        ],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors © CARTO',
      },
    },
    layers: [{ id: 'positron', type: 'raster', source: 'positron' }],
  },
  center: (savedState && savedState.view && savedState.view.c) || [-122.3321, 47.6062],
  zoom: (savedState && savedState.view && savedState.view.z) || 6.4,
  maxZoom: 17,
  maxPitch: 0,
  pitchWithRotate: false,
});
map.touchPitch?.disable();
// A double tap is too easy to trigger while placing or inspecting a point on
// a phone, and can leave the app looking brokenly zoomed-in. Desktop keeps the
// conventional double-click zoom; touch devices still support pinch zoom.
const COARSE_POINTER = window.matchMedia('(pointer: coarse)').matches;
if (COARSE_POINTER) map.doubleClickZoom.disable();
// Keep the statewide view readable. The All-roads layer is on by default, but
// it appears only in a local/regional view; neighborhood streets need a closer
// zoom still.
const RES_MIN_ZOOM = 13;
// Residential visibility is expressed directly in each MapLibre paint
// expression below. That lets the renderer update continuously during wheel,
// trackpad, touch, keyboard, and programmatic zooms without relying on a JS
// zoom event to rebuild feature filters.
// PMTiles: static single-file vector tiles over HTTP range requests — no server.
if (window.pmtiles) {
  const _pmProtocol = new pmtiles.Protocol();
  maplibregl.addProtocol('pmtiles', _pmProtocol.tile);
}
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

// A user-initiated pan/zoom (originalEvent present) suspends navigation
// auto-follow; our own programmatic camera moves have no originalEvent.
map.on('movestart', (e) => { if (turnNav.active && e.originalEvent) turnNav.cameraFollow = false; });
map.on('moveend', (e) => { if (turnNav.active && e.originalEvent) scheduleNavigationFollowResume(); });
// While navigating and panned away, the geolocate control re-centers on the
// rider first instead of toggling tracking off. Capture on the map container
// preempts the control's own click handler.
map.getContainer().addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('.maplibregl-ctrl-geolocate');
  if (btn && turnNav.active && !turnNav.cameraFollow) {
    e.stopPropagation();
    e.preventDefault();
    recenterNavigationOnRider();
  }
}, true);

function bikeNetworkExpr(src) {
  if (src.id === 'osm') return ['boolean', true];
  if (src.id === 'roads') {
    return ['==', ['get', 'f'], 1];
  }
  if (src.id === 'blts') {
    return ['all', ['has', 'BikeFacilityType'], ['!=', ['get', 'BikeFacilityType'], '']];
  }
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

function isBikeNetworkVerdict(n) {
  return !!(n && (n.infra || n.good_facility));
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
  for (const f of src.fc.features) {
    if (!f.properties._n) f.properties._n = src.scorer(f.properties);
    f.properties.level = effectiveLevel(f.properties._n);
  }
  const mapSrc = map.getSource(src.id);
  if (mapSrc) mapSrc.setData(src.fc);
}

function rescoreAll(recomputeRoute = true) {
  const t0 = performance.now();
  for (const src of SOURCES) {
    if (!src.enabled) continue;
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
  }, 700);
}

const FAIL_COLOR = '#9aa0a6';
const failId = (src) => src.id + '__fail'; // gray-dashed "has data but fails" (pass/fail mode)
const vhId = (src) => src.id + '__vh';     // red-dashed "very high / avoid" (color-ramp mode)
const hitId = (src) => src.id + '__hit';   // wide transparent line: easy hover target
const trailId = (src) => src.id + '__trail'; // lime base for off-street OSM bike paths/trails
const trailDotsId = (src) => src.id + '__trail-dots'; // fine dotted trail centerline
const trailHitId = (src) => src.id + '__trail-hit'; // dedicated wide target for dotted trails
const stateSidewalkProbeId = 'roads__state-sidewalk-probe';
const OSM_TRAIL_EXPR = ['match', ['get', 'highway'],
  ['cycleway', 'path', 'footway', 'bridleway', 'track', 'service'], true, false];
const OSM_NOT_TRAIL_EXPR = ['match', ['get', 'highway'],
  ['cycleway', 'path', 'footway', 'bridleway', 'track', 'service'], false, true];
const OSM_NOT_MTB_EXPR = ['!=', ['get', 'mtb'], 1];

// Insert this source's layers below any already-added layers of higher-zRank
// sources, so draw order follows zRank regardless of load order.
function beforeIdFor(src) {
  const style = map.getStyle();
  if (!style || !style.layers) return undefined;
  const higher = SOURCES.filter((s) => s.zRank > src.zRank).map((s) => s.id);
  const hit = style.layers.find((l) =>
    higher.some((id) => l.id === id || l.id.startsWith(id + '__')));
  if (hit) return hit.id;
  // keep the route line above every data source
  return map.getLayer('route-shadow') ? 'route-shadow' : undefined;
}

function ensureLayer(src) {
  if (map.getLayer(src.id)) return;
  const beforeId = beforeIdFor(src);
  if (src.vector) map.addSource(src.id, { type: 'vector', url: src.vector });
  else map.addSource(src.id, { type: 'geojson', data: src.fc });
  const SL = src.vector ? { 'source-layer': src.sourceLayer } : {};
  if (src.closure) {
    map.addLayer({
      id: src.id + '__line', type: 'line', source: src.id,
      minzoom: 10,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: { 'line-color': COLORS[4], 'line-width': 7, 'line-opacity': backgroundLineOpacity(0.92),
               'line-dasharray': [1.2, 1.1] },
      filter: ['==', ['geometry-type'], 'LineString'],
    }, beforeId);
    map.addLayer({
      id: src.id, type: 'circle', source: src.id,
      minzoom: 10,
      paint: { 'circle-radius': 9, 'circle-color': COLORS[4],
               'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
      filter: ['==', ['geometry-type'], 'Point'],
    }, beforeId);
    updateVisibility(src);
    return;
  }
  // Two dashed overlays are added first so the solid main layer draws on top
  // where lines overlap. Each is shown in only one display mode.
  map.addLayer({
    id: failId(src), // pass/fail mode: roads with data that don't qualify
    type: 'line',
    source: src.id,
    ...SL,
    minzoom: src.minVisibleZoom || 0,
    layout: { 'line-cap': 'butt', 'line-join': 'round', visibility: 'none' },
    paint: {
      'line-color': FAIL_COLOR,
      'line-dasharray': [2, 2],
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.8, 10, 1.4, 14, 2.6],
      'line-opacity': backgroundLineOpacity(0.65),
    },
    filter: ['all', ['>=', ['get', 'level'], display.passMax + 1], ['<=', ['get', 'level'], 4]],
  }, beforeId);
  map.addLayer({
    id: vhId(src), // color-ramp mode: level 4 shown dashed to read as "not passable"
    type: 'line',
    source: src.id,
    ...SL,
    minzoom: src.minVisibleZoom || 0,
    layout: { 'line-cap': 'butt', 'line-join': 'round', visibility: 'none' },
    paint: {
      'line-color': COLORS[4],
      'line-dasharray': [2, 1.5],
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.1, 10, 1.9, 14, 3.7],
      'line-opacity': backgroundLineOpacity(0.9),
    },
    filter: ['==', ['get', 'level'], 4],
  }, beforeId);
  map.addLayer({
    id: src.id,
    type: 'line',
    source: src.id,
    ...SL,
    minzoom: src.minVisibleZoom || 0,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': verdictColorExpr(src),
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.1, 10, 1.9, 14, 3.7],
      'line-opacity': backgroundLineOpacity(0.9),
    },
  }, beforeId);
  if (src.id === 'osm') {
    map.addLayer({
      id: trailId(src),
      type: 'line',
      source: src.id,
      ...SL,
      minzoom: src.minVisibleZoom || 0,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': BIKE_NETWORK_COLOR,
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.9, 10, 3, 14, 5],
        'line-opacity': backgroundLineOpacity(0.95),
      },
      filter: ['boolean', false],
    }, beforeId);
    map.addLayer({
      id: trailDotsId(src),
      type: 'line',
      source: src.id,
      ...SL,
      minzoom: src.minVisibleZoom || 0,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#687d00',
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.8, 10, 1.2, 14, 1.8],
        'line-opacity': backgroundLineOpacity(0.95),
        'line-dasharray': [0.05, 2.1],
      },
      filter: ['boolean', false],
    }, beforeId);
    // Keep dotted paths as easy to inspect as ordinary streets.  This sits
    // directly on the source geometry (not the gaps between rendered dots),
    // so a trail remains hoverable across its full length.
    map.addLayer({
      id: trailHitId(src),
      type: 'line',
      source: src.id,
      ...SL,
      minzoom: src.minVisibleZoom || 0,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#000',
        'line-opacity': 0,
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 12, 12, 18, 16, 26],
      },
      filter: OSM_TRAIL_EXPR,
    }, beforeId);
  }
  // State highways are visually deduplicated beneath the richer WSDOT layer,
  // but their matching OSM tile still supplies sidewalk context for a WSDOT
  // road-info card.  This transparent layer is queried only on demand.
  if (src.id === 'roads') {
    map.addLayer({
      id: stateSidewalkProbeId,
      type: 'line',
      source: src.id,
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
  map.addLayer({
    id: hitId(src),
    type: 'line',
    source: src.id,
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

// Main layer follows the source toggle; the two dashed overlays are each shown
// in exactly one display mode.
function updateVisibility(src) {
  // Source checkboxes control layout visibility. Dense sources use the
  // layers' native minzoom, which updates reliably throughout wheel, trackpad,
  // touch, keyboard, and programmatic zoom gestures.
  const on = src.enabled;
  if (src.closure) {
    for (const id of [src.id, src.id + '__line']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    }
    return;
  }
  if (map.getLayer(src.id)) map.setLayoutProperty(src.id, 'visibility', on ? 'visible' : 'none');
  if (src.id === 'roads' && map.getLayer(stateSidewalkProbeId))
    map.setLayoutProperty(stateSidewalkProbeId, 'visibility', on ? 'visible' : 'none');
  if (map.getLayer(trailId(src))) map.setLayoutProperty(trailId(src), 'visibility', on ? 'visible' : 'none');
  if (map.getLayer(trailDotsId(src))) map.setLayoutProperty(trailDotsId(src), 'visibility', on ? 'visible' : 'none');
  if (map.getLayer(trailHitId(src))) map.setLayoutProperty(trailHitId(src), 'visibility', on ? 'visible' : 'none');
  if (src.fixed) { // overlay has no mode-specific layers to manage beyond the main one
    if (map.getLayer(hitId(src))) map.setLayoutProperty(hitId(src), 'visibility', on ? 'visible' : 'none');
    if (map.getLayer(failId(src))) map.setLayoutProperty(failId(src), 'visibility', 'none');
    if (map.getLayer(vhId(src))) map.setLayoutProperty(vhId(src), 'visibility', 'none');
    return;
  }
  if (map.getLayer(hitId(src))) map.setLayoutProperty(hitId(src), 'visibility', on ? 'visible' : 'none');
  if (map.getLayer(failId(src)))
    map.setLayoutProperty(failId(src), 'visibility', on && display.passFail ? 'visible' : 'none');
  if (map.getLayer(vhId(src)))
    map.setLayoutProperty(vhId(src), 'visibility', on && !display.passFail ? 'visible' : 'none');
}

// Switch a source between the color-ramp view (level 4 dashed) and the green
// pass/fail view (gray-dashed fail overlay). For setData sources the level
// lives on each feature; for expression sources it's computed inline, so this
// also serves as the "rescore" when rules change.
function applyDisplayMode(src) {
  if (!map.getLayer(src.id)) return;
  if (src.closure) {
    if (map.getLayer(src.id + '__line')) {
      map.setPaintProperty(src.id + '__line', 'line-opacity', backgroundLineOpacity(0.92));
    }
    updateVisibility(src);
    return;
  }
  if (src.ribbon) {
    // Designation is useful context, not physical infrastructure: show it as
    // a dashed blue corridor beneath the actual facility/safety verdict.
    map.setFilter(src.id, null);
    map.setPaintProperty(src.id, 'line-color', COLORS[2]);
    map.setPaintProperty(src.id, 'line-width',
      ['interpolate', ['linear'], ['zoom'],
        6, ['match', ['get', 't'], 'ncn', 3.6, 2.3],
        10, ['match', ['get', 't'], 'ncn', 7, 4.3],
        14, ['match', ['get', 't'], 'ncn', 12, 7.5]]);
    map.setPaintProperty(src.id, 'line-opacity', backgroundLineOpacity(0.3));
    map.setPaintProperty(src.id, 'line-dasharray', [2, 1.4]);
    if (map.getLayer(failId(src))) map.setFilter(failId(src), ['boolean', false]);
    if (map.getLayer(vhId(src))) map.setFilter(vhId(src), ['boolean', false]);
    updateVisibility(src);
    return;
  }
  if (src.fixed) {
    // Regulatory overlay: exempt from the rules, but drawn with the SAME
    // color coding as any failing road in the current display mode.
    map.setFilter(src.id, null);
    if (display.passFail) {
      map.setPaintProperty(src.id, 'line-color', FAIL_COLOR);
      map.setPaintProperty(src.id, 'line-dasharray', [2, 2]);
      map.setPaintProperty(src.id, 'line-width', ['interpolate', ['linear'], ['zoom'], 6, 0.8, 10, 1.4, 14, 2.6]);
      map.setPaintProperty(src.id, 'line-opacity', backgroundLineOpacity(0.65));
    } else {
      map.setPaintProperty(src.id, 'line-color', COLORS[4]);
      map.setPaintProperty(src.id, 'line-dasharray', [2, 1.5]);
      map.setPaintProperty(src.id, 'line-width', ['interpolate', ['linear'], ['zoom'], 6, 1.1, 10, 1.9, 14, 3.7]);
      map.setPaintProperty(src.id, 'line-opacity', backgroundLineOpacity(0.9));
    }
    if (map.getLayer(failId(src))) map.setFilter(failId(src), ['boolean', false]);
    if (map.getLayer(vhId(src))) map.setFilter(vhId(src), ['boolean', false]);
    updateVisibility(src);
    return;
  }
  const lvl = src.expr ? roadLevelExpr() : ['get', 'level'];
  // Declutter: neighborhood streets in the All-roads layer only appear once
  // you're zoomed into neighborhood scale (no toggle — automatic).
  const hideRes = src.id === 'roads';
  // Dedup: while the (data-rich) WSDOT source is on, hide its state highways
  // from the All-roads layer (d=1) — otherwise OSM's unknown-shoulder "pass"
  // would visually mask WSDOT's measured verdict on the same physical road.
  const dedup = src.id === 'roads' && SOURCES.find((s) => s.id === 'blts').enabled;
  const and = (f) => {
    const conds = [f];
    if (dedup) conds.push(['!=', ['get', 'd'], 1]);
    // Explicitly technical MTB paths stay out of the normal map view as well
    // as the normal router. They reappear immediately when the rider opts in.
    if (src.id === 'osm' && !rules.allowMtbTrails) conds.push(OSM_NOT_MTB_EXPR);
    return conds.length > 1 ? ['all', ...conds] : f;
  };
  // Roads layer: residential/living_street draw thinner so arterials stand out.
  const isRes = ['match', ['get', 'h'], ['residential', 'living_street'], true, false];
  const w = (r6, n6, r10, n10, r14, n14) =>
    src.expr
      ? ['interpolate', ['linear'], ['zoom'],
         6, ['case', isRes, r6, n6], 10, ['case', isRes, r10, n10], 14, ['case', isRes, r14, n14]]
      : ['interpolate', ['linear'], ['zoom'], 6, n6, 10, n10, 14, n14];
  const opacity = (value) => {
    const backgroundOpacity = backgroundLineOpacity(value);
    const verdictOpacity = ['case', ['==', lvl, 3], cautionBackgroundLineOpacity(), backgroundOpacity];
    return hideRes
      ? ['step', ['zoom'], ['case', isRes, 0, verdictOpacity], RES_MIN_ZOOM, verdictOpacity]
      : verdictOpacity;
  };
  // Keep background data present without competing with a planned route. The
  // broad invisible hit target below preserves easy road inspection even with
  // these deliberately fine visual strokes.
  if (display.passFail) {
    const passFilter = ['all', ['>=', lvl, 1], ['<=', lvl, display.passMax]];
    map.setFilter(src.id, and(src.id === 'osm' ? ['all', passFilter, OSM_NOT_TRAIL_EXPR] : passFilter));
    map.setPaintProperty(src.id, 'line-color', PASS_COLOR);
    map.setPaintProperty(src.id, 'line-opacity', opacity(0.95));
    map.setPaintProperty(src.id, 'line-width', w(0.5, 0.85, 0.9, 1.55, 1.55, 2.85));
  } else {
    // Solid ramp for passing levels (and unknown); level 4 goes to the dashed vh layer.
    const verdictFilter = ['!=', lvl, 4];
    map.setFilter(src.id, and(src.id === 'osm' ? ['all', verdictFilter, OSM_NOT_TRAIL_EXPR] : verdictFilter));
    map.setPaintProperty(src.id, 'line-color', verdictColorExpr(src, lvl));
    map.setPaintProperty(src.id, 'line-opacity', opacity(0.9));
    map.setPaintProperty(src.id, 'line-width', w(0.4, 0.7, 0.75, 1.2, 1.3, 2.35));
  }
  const visibleTrail = display.passFail
    ? ['all', ['>=', lvl, 1], ['<=', lvl, display.passMax], OSM_TRAIL_EXPR]
    : ['all', ['!=', lvl, 4], OSM_TRAIL_EXPR];
  if (map.getLayer(trailId(src))) {
    map.setFilter(trailId(src), and(visibleTrail));
    map.setPaintProperty(trailId(src), 'line-color', display.passFail ? PASS_COLOR : BIKE_NETWORK_COLOR);
    map.setPaintProperty(trailId(src), 'line-opacity', backgroundLineOpacity(0.95));
  }
  if (map.getLayer(trailDotsId(src))) {
    map.setFilter(trailDotsId(src), and(visibleTrail));
    map.setPaintProperty(trailDotsId(src), 'line-color', display.passFail ? '#587400' : '#687d00');
    map.setPaintProperty(trailDotsId(src), 'line-opacity', backgroundLineOpacity(0.95));
  }
  if (map.getLayer(trailHitId(src))) map.setFilter(trailHitId(src), and(visibleTrail));
  if (map.getLayer(failId(src))) {
    map.setFilter(failId(src), and(['all', ['>=', lvl, display.passMax + 1], ['<=', lvl, 4]]));
    map.setPaintProperty(failId(src), 'line-opacity', opacity(0.65));
  }
  if (map.getLayer(vhId(src))) {
    map.setFilter(vhId(src), and(['==', lvl, 4]));
    map.setPaintProperty(vhId(src), 'line-opacity', opacity(0.9));
  }
  if (map.getLayer(hitId(src))) {
    // OSM trails use their purpose-built, wider hit layer above.  Keeping the
    // generic road target off them ensures the full-width trail target wins
    // instead of a thinner overlapping target being returned first.
    const mainHitFilter = src.id === 'osm' ? OSM_NOT_TRAIL_EXPR : ['boolean', true];
    map.setFilter(hitId(src), (dedup || src.id === 'osm') ? and(mainHitFilter) : null);
    const normalHitWidth = ['interpolate', ['linear'], ['zoom'], 6, 8, 12, 14, 16, 22];
    const residentialHitWidth = ['step', ['zoom'],
      ['case', isRes, 0, 8],
      10, ['case', isRes, 0, 11],
      12, ['case', isRes, 0, 14],
      RES_MIN_ZOOM, 16,
      16, 22];
    map.setPaintProperty(hitId(src), 'line-width', hideRes ? residentialHitWidth : normalHitWidth);
  }
  updateVisibility(src);
}

function applyDisplayModeAll() {
  for (const src of SOURCES) applyDisplayMode(src);
  buildLegend();
}

async function loadSource(src) {
  if (src.loaded || src.loading) return;
  if (src.vector) {
    // Vector tiles: nothing to prefetch — the map streams tiles on demand.
    ensureLayer(src);
    src.loaded = true;
    updateSourceCount(src);
    setStatus(`${src.name}: streaming tiles`);
    return;
  }
  src.loading = true;
  setStatus(`Loading ${src.name}…`, true);
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
        const part = await res.json();
        // (no spread: pushing 200k+ args at once overflows the call stack)
        for (const f of part.features) features.push(f);
        setStatus(`Loading ${src.name}… ${features.length.toLocaleString()} segments`, true);
      }
      fc = { type: 'FeatureCollection', features };
    } else {
      const res = await fetch(src.url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      fc = await res.json();
    }
    src.count = fc.features.length;
    src.fc = fc;
    if (!src.expr) rescore(src); // sets .level on every feature
    ensureLayer(src);
    if (src.expr) src.fc = null; // expression-scored: the map keeps its own copy
    src.loaded = true;
    setStatus(`${src.name}: ${src.count.toLocaleString()} segments`);
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
  // The roads layer's dedup filter depends on whether WSDOT is enabled.
  if (src.id === 'blts') {
    const roads = SOURCES.find((s) => s.id === 'roads');
    if (map.getLayer(roads.id)) applyDisplayMode(roads);
  }
  buildLegend();
  saveStateSoon();
}

/* --------------------------------------------------------- routing */
// Fully client-side: A* over a prebuilt graph (data/graph.bin.gz) in a web
// worker. No routing server. Costs come from the CURRENT riding rules; the
// route recomputes when the rules change.
const routing = {
  arm: null,                 // 'start' | 'end' — next map tap sets that point
  start: null, end: null,    // [lng, lat]
  startName: null, endName: null,
  vias: [],                  // intermediate stops: { pt: [lng,lat], marker }
  blocks: [],                // avoided road locations: { pt: [lng,lat], marker }
  startMarker: null, endMarker: null,
  worker: null, ready: false, loading: false, pendingRoute: false, routeRequestActive: false,
  mode: ['direct', 'balanced', 'low'].includes(savedState?.mode)
    ? savedState.mode : 'balanced', // 'direct' | 'balanced' | 'low'
  profileId: ROUTE_PROFILE_IDS.has(savedState?.profileId)
    ? savedState.profileId : legacyRouteProfile(savedState?.mode),
  prefDesig: savedState && typeof savedState.prefDesig === 'boolean'
    ? savedState.prefDesig : DEFAULT_ROUTE_PREFERENCES.prefDesig, // force this preference across every route option
  prefResidential: savedState && typeof savedState.prefResidential === 'boolean'
    ? savedState.prefResidential : DEFAULT_ROUTE_PREFERENCES.prefResidential,
  reqId: 0,
  compareStartedAt: 0,
  selectRecommendedNext: false,
  options: [],
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
}

async function readRoutingGraphResponse(response) {
  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body?.getReader) return response.arrayBuffer();
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0, announcedPercent = -10;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (total > 0) {
      const percent = Math.min(100, Math.floor((received / total) * 10) * 10);
      if (percent >= announcedPercent + 10) {
        announcedPercent = percent;
        showRouterProgress(`Downloading Washington roads and trails · ${percent}%`);
      }
    }
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

// Off-network start/end pins matter, but not enough to hold route-card space
// permanently: surface them as a passing toast, with the full note kept in
// Route Details.
function notifySnapDistance(m) {
  if (!m || !m.ok) return;
  const notes = [];
  if (Number(m.snapStartM) > 80) notes.push(`Start connects ${fmtDist(m.snapStartM)} away`);
  if (Number(m.snapEndM) > 80) notes.push(`Destination connects ${fmtDist(m.snapEndM)} away`);
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
  // The graph and worker must be ready before editing a route. In particular,
  // do not let a partly-loaded engine race a map tap or place-search result.
  setRouteActionsOpen(false);
  updateArmButtons();
  try {
    showRouterProgress('Downloading Washington roads, trails, ferries, and elevation data…');
    const res = await fetch(`data/graph2.bin.gz?format=${GRAPH_FORMAT_VERSION}`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    let buf = await readRoutingGraphResponse(res);
    showRouterProgress('Checking and unpacking the routing map…');
    const head = new Uint8Array(buf, 0, 2);
    if (head[0] === 0x1f && head[1] === 0x8b) {
      // Server delivered the gzip container raw — decompress ourselves.
      showRouterProgress('Unpacking road, trail, ferry, and elevation data…');
      const ds = new DecompressionStream('gzip');
      buf = await new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer();
    }
    showRouterProgress('Starting the on-device route engine…');
    routing.worker = new Worker('router-worker.js');
    routing.worker.onmessage = onRouterMessage;
    routing.worker.onerror = (event) => {
      event.preventDefault?.();
      handleRouterFailure(event.message || 'routing worker stopped');
    };
    routing.worker.onmessageerror = () => handleRouterFailure('routing worker sent unreadable data');
    routing.worker.postMessage({ type: 'graph', buffer: buf }, [buf]);
  } catch (e) {
    handleRouterFailure(`routing data could not load: ${e.message}`);
  }
}

function routePlannerIsLoading() {
  return routing.loading && !routing.ready;
}

function waitForRoutePlanner() {
  if (routing.ready) return false;
  ensureRouter();
  showRouterProgress('Navigation data is loading. Route planning will be available in a moment.',
    'Preparing route planner');
  return true;
}

const fmtMi = (m) => (m / 1609.34).toFixed(1);
const fmtFt = (m) => Math.round(m * 3.28084).toLocaleString();
const fmtDist = (m) => m < 160.934 ? `${fmtFt(m)} ft` : `${fmtMi(m)} mi`;
function fmtDur(s) {
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} m`;
}

function fallbackRouteLevel(s) {
  const flags = s.flags || 0;
  if (flags & 4) return 4;
  if ((flags & 8) || (s.facility || 0) >= 4) return 1;
  if (!rules.noUpperLimit && s.mph > rules.upperMaxSpeed) return 4;
  const noShoulderMax = (s.official || 0) & OFFICIAL_URBAN
    ? rules.urbanMaxSpeedNoShoulder : rules.ruralMaxSpeedNoShoulder;
  if (s.mph <= noShoulderMax) return flags & 128 ? 3 : 1;
  if ((flags & 64) && rules.vettedBikeRoutes) return flags & 128 ? 3 : 2;
  let sh = s.sh;
  if (sh < 0 && rules.unknownShoulderZero) sh = 0;
  if ((s.facility || 0) < 1 && sh >= 0 && sh < rules.minShoulder) {
    if (rules.allowSidewalkFallback && ((s.official || 0) & OFFICIAL_SIDEWALK)) return 3;
    return 4;
  }
  return flags & 128 ? 3 : 2;
}

const HIGHWAY_NAME = /\b(highway|state route|sr\s*\d|us\s*(?:route\s*)?\d|i-?\s*\d)\b/i;
function isHighwaySegment(s) {
  const flags = s.flags || 0;
  return !(flags & (4 | 8 | 32)) && (s.mph >= 45 || HIGHWAY_NAME.test(s.name || ''));
}

function routeSummaryStats(m) {
  const levels = [0, 0, 0, 0, 0];
  let highwayM = 0, freewayM = 0, limitedAccessM = 0, bikeNetworkM = 0, mtbM = 0, dismountM = 0;
  let roadM = 0, roadSpeedM = 0, unpavedM = 0;
  for (const s of m.segs || []) {
    const flags = s.flags || 0;
    const len = Number(s.lenM) || 0;
    if (flags & 32) continue; // ferry is reported separately, not a riding safety level
    if (isConfirmedUnpavedSurface(s.surface)) unpavedM += len;
    const level = s.level || fallbackRouteLevel(s);
    if (level >= 1 && level <= 4) levels[level] += len;
    // Physical facilities only (lime on the map) — designation alone can be a
    // plain road, and Route Details' "Bike network" verdict draws this line
    // the same way.
    if ((flags & 8) || (s.facility || 0) >= 1) bikeNetworkM += len;
    // Include every road speed, including roads with bike lanes. Dedicated
    // paths carry no motor-vehicle speed and are not part of this road average.
    const mph = Number(s.mph);
    if (!(flags & 8) && Number.isFinite(mph) && mph > 0) {
      roadM += len;
      roadSpeedM += mph * len;
    }
    if (s.mtb || ((s.official || 0) & 4)) mtbM += len;
    if (isDismountSegment(s)) dismountM += len;
    if (flags & 4) freewayM += len;
    else if (flags & 128) limitedAccessM += len;
    else if (isHighwaySegment(s)) highwayM += len;
  }
  return {
    levels, highwayM, freewayM, limitedAccessM, bikeNetworkM, mtbM, dismountM, unpavedM,
    avgRoadSpeedMph: roadM > 0 ? Math.round(roadSpeedM / roadM) : null,
  };
}

function routePercent(meters, total, preciseSmall = false) {
  if (!(meters > 0) || !(total > 0)) return '0%';
  const pct = Math.min(100, 100 * meters / total);
  if (preciseSmall && pct < 0.1) return '<0.1%';
  if (preciseSmall && pct < 1) return `${pct.toFixed(1)}%`;
  if (preciseSmall && pct > 99 && pct < 100) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

const ROUTE_DETAILS_KEY = 'wa-bike-route-details-1';
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
      // Keep the detailed report compact: it only needs road attributes and
      // lengths plus downsampled geometry for the small route preview.
      segs: (m.segs || []).map((s) => ({
        name: s.name || '', mph: s.mph, sh: s.sh, flags: s.flags || 0,
        facility: s.facility || 0, official: s.official || 0, mtb: !!s.mtb,
        dismount: isDismountSegment(s),
        surface: Number.isInteger(s.surface) ? s.surface : 0,
        roadClass: s.roadClass || 0, c0: s.c0, c1: s.c1,
        locationStart: locationAt(s.c0), locationEnd: locationAt(s.c1),
        crossing: s.crossing ? 1 : 0,
        hazard: s.hazard || 0,
        hazardLenM: s.hazardLenM || 0, hazC0: s.hazC0, hazC1: s.hazC1,
        hazardLocationStart: locationAt(s.hazC0), hazardLocationEnd: locationAt(s.hazC1),
        gradePct: s.gradePct || 0, timeS: Number(s.timeS) || 0,
        level: s.level || fallbackRouteLevel(s), lenM: Number(s.lenM) || 0,
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

function buildTurnInstructions(m) {
  const coords = m.coords || [];
  const cumulative = [0];
  for (let i = 1; i < coords.length; i++) cumulative.push(cumulative[i - 1] + navDistanceM(coords[i - 1], coords[i]));
  const instructions = [];
  let lastM = -Infinity;
  const segs = m.segs || [];
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
    const junctionM = cumulative[at];
    const incoming = routeBearingOver(coords, cumulative, junctionM - TURN_BEARING_SPAN_M, junctionM);
    const outgoing = routeBearingOver(coords, cumulative, junctionM, junctionM + TURN_BEARING_SPAN_M);
    const delta = navDelta(incoming, outgoing);
    const from = navRoadName(segs[i]?.name);
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
    const straightPathTransition = pathTransition && Math.abs(delta) < 20;
    if (Math.abs(delta) < (sameRoad ? 50 : 20) && !straightCrossing && !straightPathTransition) continue;
    const distanceM = cumulative[at];
    // Do not speak a chain of tiny graph-edge transitions as separate turns.
    if (distanceM - lastM < 70) continue;
    const crossingRoad = navRoadName(next.name);
    const text = straightCrossing
      ? `Continue across ${crossingRoad || 'the road'}`
      : navTurnText(delta, to, undefined, sameRoad);
    instructions.push({
      distanceM,
      coordIndex: at,
      segmentIndex: destination?.index ?? i + 1,
      text,
      heading: compassWord(outgoing),
    });
    lastM = distanceM;
  }
  instructions.sort((a, b) => a.distanceM - b.distanceM);
  const segmentTimeS = segs.reduce((sum, seg) => sum + Math.max(0, Number(seg.timeS) || 0), 0);
  return {
    coords, cumulative, instructions, segs,
    totalM: cumulative[cumulative.length - 1] || 0,
    totalTimeS: segmentTimeS || Math.max(0, Number(m.timeS) || 0),
  };
}

// Leaving the route no longer triggers rerouting. The rider gets the
// distance and compass direction back to the nearest route point, a concrete
// turn instruction as they close in on it, and normal guidance the moment
// they rejoin — anywhere along the route, ahead of or behind where they left.
const OFF_ROUTE_ENTER_M = 100;
const OFF_ROUTE_REJOIN_M = 60;
const OFF_ROUTE_APPROACH_M = 130;
const OFF_ROUTE_RESPEAK_MS = 30_000;
const ROUTE_START_OFFER_M = 160.934; // 0.1 mile
const AUTO_OFF_ROUTE_DELAY_MS = 60_000;
let navigationConnectorRequestId = 0;
let navigationNewRouteRequestId = 0;

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
  const remaining = Math.max(0, next.distanceM - turnNav.routeM);
  return {
    headline: `In ${navDistanceText(remaining)} · ${navInstructionText(next)}`,
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

function openRouteDetails(detailTab = null) {
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
  if (!dialog || !frame || !dialog.showModal) {
    window.location.href = 'route-details.html';
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
  const requestedTab = ['stats', 'concerns', 'steps'].includes(detailTab) ? `&tab=${detailTab}` : '';
  frame.src = `route-details.html?embedded=1&t=${Date.now()}${progress}${requestedTab}`;
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

function openRouteTips() {
  const dialog = document.getElementById('routeTipsDialog');
  if (dialog?.showModal && !dialog.open) dialog.showModal();
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
function speakNavigation(text) {
  if (!text) return;
  if (!('speechSynthesis' in window)) {
    turnNav.message = 'Voice is unavailable in this browser';
    refreshNavigationUI();
    return;
  }
  const now = Date.now();
  // Guard against re-speaking the same phrase on back-to-back GPS fixes (the
  // announcement window spans several fixes), which otherwise stutters and can
  // starve the next real maneuver.
  if (text === lastSpokenText && now - lastSpokenAt < 5000) return;
  lastSpokenText = text;
  lastSpokenAt = now;
  turnNav.lastVoiceAt = now;
  try {
    const synth = window.speechSynthesis;
    // Latest-wins: a new maneuver supersedes whatever is queued or mid-word, so
    // cancel unconditionally. Only clearing `pending` left started utterances
    // running and swallowed the fresh prompt. resume() works around the mobile
    // Safari/Chrome bug where the queue silently pauses.
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    utterance.lang = navigator.language || 'en-US';
    synth.speak(utterance);
    synth.resume();
  } catch (e) { /* the status line remains useful without speech */ }
}

async function requestNavigationWakeLock() {
  if (!turnNav.active || !navigator.wakeLock || document.visibilityState !== 'visible') return;
  try {
    turnNav.wakeLock = await navigator.wakeLock.request('screen');
    turnNav.screenMaySleep = false;
    turnNav.wakeLock.addEventListener('release', () => {
      if (turnNav.active && document.visibilityState === 'visible') requestNavigationWakeLock();
    }, { once: true });
    if (turnNav.locationReady) turnNav.message = '';
  } catch (e) {
    turnNav.screenMaySleep = true;
    if (turnNav.locationReady) turnNav.message = 'Screen may sleep on this browser';
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
  turnNav.message = turnNav.screenMaySleep ? 'Screen may sleep on this browser' : '';
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
    // A single noisy or coarse fix must not announce off-route. A low-accuracy
    // fix is ignored outright; otherwise two consecutive over-threshold fixes
    // are required before declaring the rider has actually left the route.
    const accuracy = Number(pos.coords.accuracy);
    if (Number.isFinite(accuracy) && accuracy > 60) { refreshNavigationUI(); return; }
    if (!(turnNav.offRouteCandidateAt && fixAt - turnNav.offRouteCandidateAt <= 25000)) {
      turnNav.offRouteCandidateAt = fixAt;
      refreshNavigationUI();
      return;
    }
    turnNav.offRouteCandidateAt = 0;
    enterOffRoute(nearest);
    refreshNavigationUI();
    return;
  }
  turnNav.offRouteCandidateAt = 0;
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
  turnNav.message = turnNav.screenMaySleep ? 'Screen may sleep on this browser' : '';
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
    maybeSpeakPeriodicUpdate(null, Infinity);
    refreshNavigationUI();
    return;
  }
  const remaining = next.distanceM - turnNav.routeM;
  if (!next.now && remaining <= 90) {
    // Inside the immediate window: speak only the turn itself, never both
    // the approach and the turn back-to-back.
    next.now = true;
    next.approach = true;
    speakNavigation(`${navInstructionText(next)}.`);
  } else if (!next.approach && remaining <= 350) {
    next.approach = true;
    speakNavigation(`In ${navDistanceText(remaining)}, ${navInstructionText(next).toLowerCase()}.`);
  } else {
    maybeSpeakPeriodicUpdate(next, remaining);
  }
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
  if (parts.length) speakNavigation(`${parts.join('. ')}.`);
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
  if (!routing.last?.ok || routing.last.coords?.length < 2 || !navigator.geolocation) {
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
  turnNav.offRouteCandidateAt = 0;
  turnNav.autoRecoveryAttempted = false;
  turnNav.prevFix = null;
  turnNav.lastPosition = null;
  turnNav.destinationWasNear = false;
  turnNav.lastDestinationM = Infinity;
  turnNav.destinationAwayFixes = 0;
  turnNav.initialCameraAt = 0;
  turnNav.lastCameraAt = 0;
  turnNav.lastVoiceAt = Date.now();
  drawNavigationConnector([]);
  updateNavigationProgress();
  turnNav.message = 'Getting your location';
  settingsPaneSelect?.('voice');
  refreshNavigationUI();
  speakNavigation('Navigation started. Getting your location.');
  turnNav.watchId = navigator.geolocation.watchPosition(
    updateTurnNavigation,
    handleTurnNavigationLocationError,
    // Accept a recent fix and allow GPS a little longer to acquire one. This
    // avoids a false "needs location access" warning on phones whose map
    // marker is already working but whose second watcher has not updated yet.
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 }
  );
  requestNavigationWakeLock();
}

function stopTurnNavigation(announce = true) {
  if (!turnNav.active) return;
  if (turnNav.watchId != null) navigator.geolocation?.clearWatch(turnNav.watchId);
  turnNav.watchId = null;
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
  if (turnNav.active && document.visibilityState === 'visible') requestNavigationWakeLock();
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
  if (!card) return;
  syncRouteDetailsWarningState(m);
  if (!m) {
    card.innerHTML = `<div id="routeControlsSlot"></div><div class="rc-empty">Choose either <b>From</b> or <b>To</b>
      first, then search or tap the map. Routes follow your
      riding rules, entirely on this device. When meaningful alternatives exist, they appear above.</div><div class="rc-details-hidden"><div id="routeDetailsSlot"></div></div>`;
    moveControls();
    moveDetails();
    refreshNavigationUI();
    return;
  }
  if (!m.ok) {
    card.innerHTML = '<div id="routeControlsSlot"></div><div class="rc-empty"></div><div class="rc-details-hidden"><div id="routeDetailsSlot"></div></div>';
    card.querySelector('.rc-empty').textContent = String(m.reason || 'No route found.');
    moveControls();
    moveDetails();
    refreshNavigationUI();
    return;
  }
  const stats = routeSummaryStats(m);
  const ridingM = Math.max(1, m.distM - (m.ferryM || 0));
  const bikePct = routePercent(stats.bikeNetworkM, ridingM);
  const passPct = routePercent((stats.levels[1] || 0) + (stats.levels[2] || 0), ridingM, true);
  const cautionPct = routePercent(stats.levels[3] || 0, ridingM, true);
  const failPct = routePercent(m.failM || 0, ridingM, true);
  const unpavedPct = routePercent(stats.unpavedM, ridingM, true);
  const hasSignificantUnpaved = stats.unpavedM > SIGNIFICANT_UNPAVED_M;
  const containsDismount = stats.dismountM > 0;
  const averageSpeedLimit = stats.avgRoadSpeedMph == null ? 'N/A' : `${stats.avgRoadSpeedMph} mph`;
  const hasSteepGradeWarning = Number(m.maxGradePct) > 18;
  const mtbNotice = stats.mtbM > 0
    ? `<div class="rc-warn rc-mtb">⚠ ${fmtDist(stats.mtbM)} on mountain-bike trail</div>`
    : '';
  card.innerHTML = `
    <div id="routeControlsSlot"></div>
    <div class="rc-route-summary">
      <div class="rc-details-wrap">
        <div class="rc-speed-limit"><b>${averageSpeedLimit}</b><span>Avg. Road<br>Speed Limit</span></div>
        <div id="routeDetailsSlot"></div>
      </div>
      <div class="rc-summary-content">
        <div class="rc-summary-row">
          <div class="rc-elev-wrap"><canvas id="rcElevCanvas" class="rc-elev-canvas"></canvas><button id="rcElevGradeWarning" class="rc-elev-grade-warning" type="button" aria-label="Route has a sustained grade over 18 percent. View route details." ${hasSteepGradeWarning ? '' : 'hidden'}><span aria-hidden="true">!</span> See Details</button></div>
          <div class="rc-main"><span class="rc-distance">${fmtMi(m.distM)} mi</span><span class="rc-duration">Est. ${fmtDur(m.timeS)}</span></div>
        </div>
        ${mtbNotice}<div class="rc-bottom-stats">
          <div class="rc-ride-mix" title="Percent of riding distance; colors match the map legend"><div class="rc-ride-items${containsDismount ? ' has-dismount' : ''}"><span class="rc-ride-item"><span class="rc-mix-swatch" style="background:${BIKE_NETWORK_COLOR}"></span><b>${bikePct}</b> trails / lanes</span><span class="rc-ride-item"><span class="rc-mix-swatch" style="background:${COLORS[1]}"></span><b>${passPct}</b> pass rules</span><span class="rc-ride-item ${stats.levels[3] > 0 ? 'rc-ride-caution' : ''}"><span class="rc-mix-swatch" style="background:${COLORS[3]}"></span><b>${cautionPct}</b> caution</span><span class="rc-ride-item ${m.failM > 0 ? 'rc-ride-fail' : ''}"><span class="rc-mix-swatch" style="background:${COLORS[4]}"></span><b>${failPct}</b> fail rules</span><span class="rc-ride-item${hasSignificantUnpaved ? ' rc-ride-unpaved-warning' : ''}"><span class="rc-unpaved-swatch" aria-hidden="true"></span><b>${unpavedPct}</b> unpaved${hasSignificantUnpaved ? '<span class="rc-unpaved-alert-mark" aria-hidden="true">!</span>' : ''}</span>${containsDismount ? '<span class="rc-ride-item rc-ride-dismount" title="Walk your bike through a short route section"><span aria-hidden="true">⚠</span> Dismount</span>' : ''}</div></div>
        </div>
      </div>
    </div>`;
  moveControls();
  moveDetails();
  document.getElementById('rcElevGradeWarning')?.addEventListener('click', () => openRouteDetails('stats'));
  refreshNavigationUI();
  drawRouteCardElevation();
}

function routeHasDetailsWarning(route) {
  if (!route?.ok) return false;
  const stats = routeSummaryStats(route);
  return Number(route.maxGradePct) > 18 || stats.unpavedM > SIGNIFICANT_UNPAVED_M;
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
  } else if (m.type === 'route-options') {
    if (m.id !== routing.reqId) return;
    const remaining = 400 - (performance.now() - routing.compareStartedAt);
    if (!m.displayDelayApplied && remaining > 0) {
      setTimeout(() => onRouterMessage({ data: { ...m, displayDelayApplied: true } }), remaining);
      return;
    }
    routing.routeRequestActive = false;
    document.body.dataset.routeOptionsMs = String(Math.round(Number(m.ms) || 0));
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
  showRouteActionToast(routing.last?.ok ? 'Recalculating route' : 'Calculating route options', {
    busy: true,
    detail: routing.last?.ok
      ? 'Reapplying your safety rules and route preferences…'
      : 'Testing safer, quicker, and bike-friendly alternatives…',
    duration: 0,
  });
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
      weights: { ...routingWeights },
    });
  } else {
    routing.compareStartedAt = performance.now();
    // While the shared route is active, search with the SENDER's recipe so the
    // path reproduces exactly. The map still colors it with the receiver's
    // current rules (colors are re-scored client-side).
    const rec = routing.sharedActive ? routing.sharedRecipe : null;
    routing.worker.postMessage({
      type: 'route-options', id: routing.reqId, points,
      blocks: routing.blocks?.map((block) => block.pt) || [],
      rules: { ...(rec?.rules || rules) },
      forceDesignated: rec ? !!rec.prefDesig : routing.prefDesig,
      forceResidential: rec ? !!rec.prefResidential : routing.prefResidential,
      preferredProfileId: rec ? (rec.profileId || routing.profileId) : routing.profileId,
      weights: { ...(rec?.weights || routingWeights) },
    });
  }
}

// Pseudo-source for tapping the route line itself: segments carry their graph
// attributes, so the route is inspectable even with every data layer off.
const ROUTESEG_SRC = { id: 'routeseg', name: 'Your route', scorer: scoreRouteSeg };
const ROUTE_SEG_BIKE_EXPR = ['any', ['==', ['get', 'infra'], 1],
  ['>=', ['get', 'facility'], 1]];
const ROUTE_SEG_TRAIL_EXPR = ['==', ['get', 'facility'], 5];
const ROUTE_SEG_NOT_TRAIL_EXPR = ['!=', ['get', 'facility'], 5];
const ROUTE_SEG_NOT_BIKE_EXPR = ['all', ['!=', ['get', 'infra'], 1],
  ['<', ['get', 'facility'], 1]];
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
    freeway: p.fw === 1,
    limited_access: p.lim === 1 || p.fw === 1,
    good_facility: facility >= 1,
    infra: p.infra === 1 || facility >= 4,
    est: p.e === 1,
    desig: p.desig === 1,
    dismount: p.dismount === 1,
    sidewalk: official & OFFICIAL_SIDEWALK ? 'present'
      : official & OFFICIAL_SIDEWALK_NO ? 'absent' : null,
    urban: !!(official & OFFICIAL_URBAN),
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
  if (p.level === 3) return 'caution';
  if (p.level === 0) return 'unknown';
  const bike = p.infra === 1 || p.facility >= 1;
  if (bike && p.facility === 5) return 'trail';
  if (bike) return 'bike';
  if (p.desig === 1) return 'designated';
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

// Dismounts are marked once at the entry to every continuous run.  The route
// line keeps its normal safety color; this marker communicates an access
// instruction without turning a legal walk-bike link into a rule failure.
function buildRouteDismountData(sdata) {
  const features = [];
  let inDismount = false;
  for (const feature of sdata.features) {
    const dismount = feature.properties?.dismount === 1;
    if (dismount && !inDismount) {
      const point = feature.geometry?.coordinates?.[0];
      if (Array.isArray(point) && point.length >= 2) {
        features.push({ type: 'Feature', properties: { name: feature.properties?.name || '' },
          geometry: { type: 'Point', coordinates: point } });
      }
    }
    inDismount = dismount;
  }
  return { type: 'FeatureCollection', features };
}

function ensureUnpavedSlatImage(targetMap, imageId = 'route-unpaved-slats') {
  if (targetMap.hasImage(imageId)) return;
  // Fixed-size symbols stay stable across zoom levels. Dense, narrow bars read
  // as a surface texture while extending beyond the route stroke.
  const width = 2, height = 12;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      data[offset] = 35;
      data[offset + 1] = 54;
      data[offset + 2] = 66;
      data[offset + 3] = 218;
    }
  }
  targetMap.addImage(imageId, { width, height, data }, { pixelRatio: 1 });
}

function ensureDismountMarkerImage(targetMap, imageId = 'route-dismount-marker-icon') {
  if (targetMap.hasImage(imageId)) return;
  // Use a small raster warning icon instead of a text glyph so it works with
  // both our local raster style and hosted styles that do not expose glyphs.
  const width = 18, height = 18;
  const data = new Uint8Array(width * height * 4);
  const paint = (x, y, color) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const offset = (y * width + x) * 4;
    data[offset] = color[0]; data[offset + 1] = color[1];
    data[offset + 2] = color[2]; data[offset + 3] = color[3];
  };
  for (let y = 1; y < 17; y++) {
    const half = Math.max(1, Math.floor((y - 1) * .5) + 1);
    for (let x = 9 - half; x <= 9 + half; x++) paint(x, y, [138, 86, 0, 255]);
  }
  for (let y = 3; y < 15; y++) {
    const half = Math.max(1, Math.floor((y - 2) * .47));
    for (let x = 9 - half; x <= 9 + half; x++) paint(x, y, [239, 176, 37, 255]);
  }
  for (let y = 6; y < 11; y++) { paint(8, y, [81, 47, 0, 255]); paint(9, y, [81, 47, 0, 255]); }
  paint(8, 13, [81, 47, 0, 255]); paint(9, 13, [81, 47, 0, 255]);
  targetMap.addImage(imageId, { width, height, data }, { pixelRatio: 1 });
}

// Pulse animation for failing portions of the route — impossible to miss.
let failPulseTimer = null;
let detailSelectionPulseTimer = null;
function setFailPulse(on) {
  if (on && !failPulseTimer) {
    let t = 0;
    failPulseTimer = setInterval(() => {
      t += 0.11;
      if (!map.getLayer('route-fail')) return;
      const p = Math.abs(Math.sin(t)); // 0..1 throb
      map.setPaintProperty('route-fail', 'line-opacity', 0.55 + 0.45 * p);
      map.setPaintProperty('route-fail', 'line-width', 6 + 8 * p);
      map.setPaintProperty('route-fail-casing', 'line-width', 10 + 9 * p);
      map.setPaintProperty('route-fail-casing', 'line-opacity', 0.5 + 0.4 * p);
    }, 80);
  } else if (!on && failPulseTimer) {
    clearInterval(failPulseTimer);
    failPulseTimer = null;
  }
}

// A report-item selection should retain the segment's own safety color.  The
// white overlay comes and goes, so the rider can locate it without mistaking
// a temporary selection color for another safety category.
function setDetailSelectionPulse(on) {
  if (on && !detailSelectionPulseTimer) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      if (map.getLayer('route-detail-highlight')) {
        map.setPaintProperty('route-detail-highlight', 'line-opacity', 0.9);
      }
      return;
    }
    let whiteVisible = true;
    if (map.getLayer('route-detail-highlight')) {
      map.setPaintProperty('route-detail-highlight', 'line-opacity', 1);
    }
    detailSelectionPulseTimer = setInterval(() => {
      if (!map.getLayer('route-detail-highlight')) return;
      // Alternate cleanly between the underlying route color and white; a
      // binary flash is more recognizable outdoors than a subtle fade.
      whiteVisible = !whiteVisible;
      map.setPaintProperty('route-detail-highlight', 'line-opacity', whiteVisible ? 1 : 0);
    }, 430);
  } else if (!on) {
    if (detailSelectionPulseTimer) clearInterval(detailSelectionPulseTimer);
    detailSelectionPulseTimer = null;
    if (map.getLayer('route-detail-highlight')) {
      map.setPaintProperty('route-detail-highlight', 'line-opacity', 0.9);
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
  const sdata = { type: 'FeatureCollection', features: (segs || []).map((s, routeIndex) => ({
    type: 'Feature',
    properties: { name: s.name, mph: s.mph, sh: s.sh, lenM: s.lenM,
      e: s.flags & 1 ? 1 : 0, fac: s.flags & 2 ? 1 : 0, fw: s.flags & 4 ? 1 : 0,
      lim: s.flags & 128 ? 1 : 0,
      hazard: s.hazard || 0, gradePct: s.gradePct || 0, crossing: s.crossing ? 1 : 0,
      infra: s.flags & 8 ? 1 : 0, ferry: s.flags & 32 ? 1 : 0, desig: s.flags & 64 ? 1 : 0,
      facility: s.facility || 0, official: s.official || 0, mtb: s.mtb ? 1 : 0,
      dismount: isDismountSegment(s) ? 1 : 0,
      surface: Number.isInteger(s.surface) ? s.surface : 0,
      roadClass: s.roadClass || 0,
      routeIndex,
      level: s.level ?? fallbackRouteLevel(s), hwy: isHighwaySegment(s) ? 1 : 0 },
    geometry: { type: 'LineString', coordinates: coords.slice(s.c0, s.c1 + 1) },
  })) };
  const renderData = buildRouteRenderData(sdata);
  const unpavedData = buildRouteUnpavedData(sdata);
  const dismountData = buildRouteDismountData(sdata);
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
    map.getSource('route-seg').setData(sdata);
    map.getSource('route-render').setData(renderData);
    map.getSource('route-fail').setData(failData);
    map.getSource('route-unpaved').setData(unpavedData);
    map.getSource('route-dismount').setData(dismountData);
    map.getSource('route-highlight-marker').setData(emptyHighlights);
    map.getSource('route-detail-marker').setData(emptyHighlights);
    map.getSource('route-detail-selection').setData(emptyLine);
    map.getSource('route-progress').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } });
    setFailPulse(failData.features.length > 0);
    applyDisplayModeAll();
    return;
  }
  map.addSource('route', { type: 'geojson', data });
  map.addSource('route-ferry', { type: 'geojson', data: fdata });
  map.addSource('route-seg', { type: 'geojson', data: sdata });
  map.addSource('route-render', { type: 'geojson', data: renderData });
  map.addSource('route-fail', { type: 'geojson', data: failData });
  map.addSource('route-unpaved', { type: 'geojson', data: unpavedData });
  map.addSource('route-dismount', { type: 'geojson', data: dismountData });
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
  map.addLayer({
    id: 'route-connector-casing', type: 'line', source: 'route-connector',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 10, 'line-opacity': 0.96 },
  });
  map.addLayer({
    id: 'route-connector', type: 'line', source: 'route-connector',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#7b2cbf', 'line-width': 6, 'line-opacity': 1,
             'line-dasharray': [2.2, 1.15] },
  });
  map.addLayer({
    id: 'route-shadow', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#102a43', 'line-width': 15, 'line-opacity': 0.42,
             'line-blur': 1.2 },
  });
  map.addLayer({
    id: 'route-casing', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 11, 'line-opacity': 0.98 },
  });
  const routeVerdictPaint = (color) => ({
    'line-color': color, 'line-width': 6.5, 'line-opacity': 1,
  });
  map.addLayer({
    id: 'route-pass', type: 'line', source: 'route-render',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: routeVerdictPaint(COLORS[1]),
    filter: ['==', ['get', 'style'], 'pass'],
  });
  map.addLayer({
    id: 'route-designated', type: 'line', source: 'route-render',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { ...routeVerdictPaint(COLORS[2]), 'line-width': 7.2,
             'line-dasharray': [1.6, 1.15] },
    filter: ['==', ['get', 'style'], 'designated'],
  });
  map.addLayer({
    id: 'route-bike', type: 'line', source: 'route-render',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: routeVerdictPaint(BIKE_NETWORK_COLOR),
    filter: ['==', ['get', 'style'], 'bike'],
  });
  map.addLayer({
    id: 'route-bike-trail', type: 'line', source: 'route-render',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { ...routeVerdictPaint(BIKE_NETWORK_COLOR), 'line-width': 7.2 },
    filter: ['==', ['get', 'style'], 'trail'],
  });
  map.addLayer({
    id: 'route-bike-trail-dots', type: 'line', source: 'route-render',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#687d00', 'line-width': 2.2, 'line-opacity': 0.96,
             'line-dasharray': [0.05, 2.1] },
    filter: ['==', ['get', 'style'], 'trail'],
  });
  map.addLayer({
    id: 'route-caution', type: 'line', source: 'route-render',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: routeVerdictPaint(COLORS[3]),
    filter: ['==', ['get', 'style'], 'caution'],
  });
  map.addLayer({
    id: 'route-unknown', type: 'line', source: 'route-render',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: routeVerdictPaint(COLORS[0]),
    filter: ['==', ['get', 'style'], 'unknown'],
  });
  map.addLayer({
    id: 'route-fail-casing', type: 'line', source: 'route-fail',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 12, 'line-opacity': 0.8 },
  });
  map.addLayer({
    id: 'route-fail', type: 'line', source: 'route-fail',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': COLORS[4], 'line-width': 6.5, 'line-opacity': 0.9,
             'line-dasharray': [1.25, 1] },
  });
  ensureUnpavedSlatImage(map);
  ensureDismountMarkerImage(map);
  map.addLayer({
    id: 'route-unpaved-slats', type: 'symbol', source: 'route-unpaved',
    layout: {
      'symbol-placement': 'line', 'symbol-spacing': 10,
      'icon-image': 'route-unpaved-slats', 'icon-allow-overlap': true,
      'icon-ignore-placement': true, 'icon-rotation-alignment': 'map',
      'icon-pitch-alignment': 'map', 'icon-keep-upright': false,
    },
    paint: { 'icon-opacity': 1 },
  });
  map.addLayer({
    id: 'route-dismount-halo', type: 'circle', source: 'route-dismount',
    paint: { 'circle-radius': 12, 'circle-color': '#fff7d6', 'circle-opacity': .96,
      'circle-stroke-color': '#8a5600', 'circle-stroke-width': 1.5 },
  });
  map.addLayer({
    id: 'route-dismount-marker', type: 'symbol', source: 'route-dismount',
    layout: { 'icon-image': 'route-dismount-marker-icon', 'icon-size': 1,
      'icon-allow-overlap': true, 'icon-ignore-placement': true },
  });
  map.addLayer({
    id: 'route-ferry', type: 'line', source: 'route-ferry',
    paint: { 'line-color': '#ffffff', 'line-width': 5, 'line-opacity': 0.9,
             'line-dasharray': [0.6, 1.8] },
  });
  setFailPulse(failData.features.length > 0);
  // Ridden portion of the route darkens during navigation.
  map.addLayer({
    id: 'route-progress', type: 'line', source: 'route-progress',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#17262f', 'line-width': 7.6, 'line-opacity': 0.26 },
  });
  map.addLayer({
    id: 'route-highlight-halo', type: 'line', source: 'route-seg',
    layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
    paint: { 'line-color': '#fff4a3', 'line-width': 16, 'line-opacity': 0.78,
             'line-blur': 2 },
  });
  map.addLayer({
    id: 'route-highlight', type: 'line', source: 'route-seg',
    layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
    paint: { 'line-color': '#ffd400', 'line-width': 8, 'line-opacity': 1 },
  });
  map.addLayer({
    id: 'route-detail-highlight', type: 'line', source: 'route-detail-selection',
    layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
    paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.9 },
  });
  // A short highlighted edge can be less than a pixel long at the current
  // zoom. One marker per contiguous highlighted stretch gives it an obvious
  // location without filling long stretches with repeated dots.
  map.addLayer({
    id: 'route-highlight-marker-halo', type: 'circle', source: 'route-highlight-marker',
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 12, 10, 14, 14, 17],
      'circle-color': '#fff4a3', 'circle-opacity': 0.92, 'circle-blur': 0.18,
    },
  });
  map.addLayer({
    id: 'route-detail-marker-halo', type: 'circle', source: 'route-detail-marker',
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 11, 10, 13, 14, 16],
      'circle-color': '#1f2933', 'circle-opacity': 0.86,
    },
  });
  map.addLayer({
    id: 'route-detail-marker', type: 'circle', source: 'route-detail-marker',
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 6, 10, 7, 14, 9],
      'circle-color': '#ffffff', 'circle-opacity': 1,
    },
  });
  map.addLayer({
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
  map.addLayer({
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
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
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
    map.setFilter(id, ROUTE_HIGHLIGHT_FILTERS[key]);
    map.setLayoutProperty(id, 'visibility', 'visible');
  }
  const markerFeatures = routeHighlightMarkers(key);
  const markerSource = map.getSource('route-highlight-marker');
  if (markerSource) markerSource.setData({ type: 'FeatureCollection', features: markerFeatures });
  for (const id of ['route-highlight-marker-halo', 'route-highlight-marker']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', markerFeatures.length ? 'visible' : 'none');
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
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', selected.length >= 2 ? 'visible' : 'none');
  }
  const markerPoint = selected[Math.floor(selected.length / 2)];
  const markerSource = map.getSource('route-detail-marker');
  if (markerSource && markerPoint) markerSource.setData({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: markerPoint } }],
  });
  for (const id of ['route-detail-marker-halo', 'route-detail-marker']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', markerPoint ? 'visible' : 'none');
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

function setRoutePoint(kind, lngLat, name = 'Point on map') {
  exitSharedRoute();
  const previous = routing[kind];
  if (!Array.isArray(previous) || previous[0] !== lngLat.lng || previous[1] !== lngLat.lat) {
    routing.selectRecommendedNext = true;
  }
  clearWaypointsForEndpointChange(kind, lngLat);
  routing[kind] = [lngLat.lng, lngLat.lat];
  routing[`${kind}Name`] = normalizeEndpointName(name) || 'Point on map';
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

function addRoadBlock(lngLat, { allowPastLimit = false } = {}) {
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
  routing.vias.reverse();
  routing.startMarker?.setLngLat(routing.start);
  routing.endMarker?.setLngLat(routing.end);

  clearRouteHighlight();
  updateArmButtons();
  setRouteStatus('Route reversed');
  computeRoute();
  saveStateSoon();
}

function clearRoute() {
  exitSharedRoute();
  showRouteActionToast('');
  stopTurnNavigation(false);
  routing.arm = null;
  closePlacePicker(false);
  setRouteActionsOpen(false);
  routing.start = routing.end = null;
  routing.startName = routing.endName = null;
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
  const plannerLoading = routePlannerIsLoading();
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
    if (plannerLoading) button.title = 'Loading navigation data…';
    button.setAttribute('aria-label', button.title);
    button.disabled = plannerLoading;
    const value = button.querySelector('[data-endpoint-value]');
    if (value) value.textContent = routeEndpointDisplayName(kind);
  }
  const add = document.getElementById('rb-via');
  const block = document.getElementById('rb-road-block');
  const reverse = document.getElementById('rb-reverse');
  const clear = document.getElementById('rb-clear');
  const more = document.getElementById('rb-more');
  if (add) {
    add.disabled = plannerLoading || !(routing.start && routing.end) || routing.vias.length >= MAX_ROUTE_STOPS;
    add.title = plannerLoading ? 'Loading navigation data…' : routing.vias.length >= MAX_ROUTE_STOPS
      ? `Maximum of ${MAX_ROUTE_STOPS} waypoints reached` : 'Add waypoint';
  }
  if (block) {
    block.disabled = plannerLoading || !(routing.start && routing.end) || routing.blocks.length >= MAX_ROAD_BLOCKS;
    block.title = plannerLoading ? 'Loading navigation data…' : routing.blocks.length >= MAX_ROAD_BLOCKS
      ? `Maximum of ${MAX_ROAD_BLOCKS} road blocks reached` : 'Add a road block';
  }
  if (reverse) reverse.disabled = plannerLoading || !(routing.start && routing.end);
  if (clear) clear.disabled = plannerLoading || !(routing.start || routing.end || routing.vias.length || routing.blocks.length);
  // Keep the menu discoverable before the route is complete. Its individual
  // actions remain disabled until their own requirements are met.
  if (more) more.disabled = plannerLoading;
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
  host.innerHTML = routing.options.map((option, index) => {
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
  }).join('');
}

function activateRouteOption(option, updateNavigation = false) {
  if (!option?.ok) return;
  showRouteActionToast('');
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
  syncRouteDetailsWarningState(option, { flash: true });
  storeRouteDetails(option);
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
    setRoutePoint('start', { lng: rt.s[0], lat: rt.s[1] }, rt.sn);
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
      empty.textContent = 'Saved routes stay on this device.';
      host.appendChild(empty);
    }
    list.forEach((saved, index) => {
      const route = normalizeStoredRoute(saved);
      const name = String(saved?.name || `Saved route ${index + 1}`);
      const row = document.createElement('div');
      row.className = 'saved-row';
      const load = document.createElement('button');
      load.className = 'saved-load';
      load.textContent = name;
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
        routing.profileId = ROUTE_PROFILE_IDS.has(current.profileId)
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
        const current = loadSavedRoutes();
        current.splice(index, 1);
        storeSavedRoutes(current);
        render();
        document.getElementById('savedRoutesStatus').textContent = `Deleted ${name}.`;
      });
      row.append(load, remove);
      host.appendChild(row);
    });
  };
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
// The router only covers Washington; drop any hit outside it so a route is
// always possible.
const WA_BBOX = { minLon: -124.9, maxLon: -116.8, minLat: 45.5, maxLat: 49.1 };
const inWashington = (lon, lat) => lon >= WA_BBOX.minLon && lon <= WA_BBOX.maxLon
  && lat >= WA_BBOX.minLat && lat <= WA_BBOX.maxLat;

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
      .filter((item) => inWashington(item.lon, item.lat));
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
  const state = String(address.state || 'Washington').trim();
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
  if (waitForRoutePlanner()) return;
  // A road block is intentionally map-only: routing uses the exact point the
  // rider picks, so a place-search result would add unnecessary indirection.
  if (kind === 'block') {
    armRoutePoint('block');
    return;
  }
  const isConstraint = kind === 'via' || kind === 'block';
  if (isConstraint && (!(routing.start && routing.end)
    || (kind === 'via' ? routing.vias.length >= MAX_ROUTE_STOPS : routing.blocks.length >= MAX_ROAD_BLOCKS))) return;
  setLegendOpen(false);
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
    : '<strong>Search</strong> for a place below, or <strong>tap the map</strong> to set it.';
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
  if (waitForRoutePlanner()) return;
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
    if (!navigator.geolocation) { setStatus('No location access on this device', true); return; }
    setRouteStatus('Locating…');
    navigator.geolocation.getCurrentPosition((pos) => {
      const lngLat = { lng: pos.coords.longitude, lat: pos.coords.latitude };
      setRoutePoint(placeTarget, lngLat, 'My location');
      routing.arm = null;
      updateArmButtons();
      closePlacePicker(false);
      frameMapAfterPlacePicker(lngLat);
      setRouteStatus(placeTarget === 'start' ? 'Start set to your location' : 'Destination set');
    }, () => setRouteStatus('Could not get your location'), { enableHighAccuracy: true, timeout: 10000 });
  });
}

/* ---------------------------------------------- hover/click readout */
const readoutEl = document.getElementById('readout');
// The road card repeats the one shared map/route verdict vocabulary.
function readoutVerdict(n, level) {
  if (n.dismount) return 'Dismount required';
  if (level === 4) return 'Fails your rules';
  if (level === 3) return 'Caution — limited-access highway';
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
  1: 'Shared lane marking',
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
// Plain-language reason for a segment's verdict under the current rules.
// Mirrors effectiveLevel()'s hard-gate branches so the readout explains why.
function explainLevel(n) {
  if (n.dismount) return 'Bicycle access is allowed here, but you must walk your bike.';
  if (n.prohibited)
    return n.wsdotBan
      ? 'Bikes prohibited — WSDOT permanent restriction.'
      : 'Bikes prohibited — OSM-tagged bicycle=no.';
  if (n.freeway)
    return 'Limited-access freeway — treated as a last-resort route failure.';
  if (n.infra)
    return n.baseScore === 1
      ? 'Dedicated or protected bike path — part of the bike network and passes your rules.'
      : n.baseScore === 2
      ? 'Bike lane or shared path — part of the bike network and passes your rules.'
      : 'Bike infrastructure.';
  const spd = n.maxspeed_num;
  const shRaw = n.shoulder_width;
  const shUnknown = shRaw == null;
  const sh = shUnknown && rules.unknownShoulderZero ? 0 : shRaw;
  const spdTxt = spd != null ? `${spd} mph${n.est ? ' (est.)' : ''}` : null;
  const speedFails = !rules.noUpperLimit && spd != null && spd > rules.upperMaxSpeed;
  const noShoulderMax = noShoulderMaxSpeed(n);
  const area = n.urban ? 'urban' : 'rural';
  if (!speedFails && spd != null && spd <= noShoulderMax)
    return n.limited_access
      ? `${spdTxt} — meets your speed/shoulder rules, but this is a limited-access highway (caution).`
      : `${spdTxt} — at or below your ${noShoulderMax} mph ${area} no-shoulder limit, passes without a shoulder.`;

  if (!speedFails && n.desig && rules.vettedBikeRoutes)
    return n.limited_access
      ? 'On a designated bike route, but it is also a limited-access highway (caution).'
      : 'On a designated bike route (USBR / regional trail) — a vetted corridor, treated as meeting your criteria.';

  const shoulderFails = !n.good_facility && sh != null && sh < rules.minShoulder;
  if (!speedFails && shoulderFails && sidewalkFallbackApplies(n, spd, sh)) {
    return `${spdTxt || 'This road'} uses your mapped sidewalk fallback instead of a ${rules.minShoulder} ft shoulder; it is strongly deprioritized.`;
  }
  const reasons = [];
  if (speedFails) reasons.push(`${spdTxt} is over your ${rules.upperMaxSpeed} mph max`);
  if (shoulderFails)
    reasons.push(shUnknown
      ? `shoulder unknown — treated as 0 ft, under your ${rules.minShoulder} ft minimum`
      : `${sh} ft shoulder is under your ${rules.minShoulder} ft minimum`);
  if (reasons.length) return `Fails: ${reasons.join(' and ')}.`;

  if (n.limited_access)
    return 'Limited-access highway — caution. Its recorded speed and shoulder meet your current criteria.';

  if (spd == null && shRaw == null && !n.good_facility && !rules.unknownShoulderZero)
    return 'No speed or shoulder data for this segment.';

  const met = [];
  if (n.good_facility) met.push('has a bike facility');
  else if (!shUnknown) met.push(`${sh} ft shoulder ≥ your ${rules.minShoulder} ft`);
  else if (rules.unknownShoulderZero) met.push(`shoulder unknown — treated as 0 ft, meets your ${rules.minShoulder} ft minimum`);
  else met.push('shoulder unknown (not held against it)');
  if (n.desig && !rules.vettedBikeRoutes) met.push('designated route, checked against your rules');
  if (spd != null)
    met.push(
      rules.noUpperLimit
        ? `${spdTxt} — no speed cutoff set`
        : `${spdTxt} within your ${rules.upperMaxSpeed} mph max`
    );
  return `${met.join('; ')}.`;
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
function featureAt(point) {
  const layers = HIT_LAYERS.filter(
    (id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none'
  );
  if (!layers.length) return null;
  const pad = 6;
  const feats = map.queryRenderedFeatures(
    [[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]],
    { layers }
  );
  return feats[0] || null; // queryRenderedFeatures returns topmost first
}

// Designated-route labels under a screen point (e.g. "US Bicycle Route 10"),
// deduped across overlapping relations; null when none or the layer is off.
function routeBadgeAt(point) {
  const lyr = 'routes__hit';
  if (!map.getLayer(lyr) || map.getLayoutProperty('routes', 'visibility') === 'none') return null;
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

function renderReadout(feature, lngLat, anchorPoint = null) {
  resetRoadInfoPosition();
  const src = HIT_SRC[feature.layer.id];
  const p = feature.properties;
  const n = src.scorer(p);            // recompute normalized props from this feature
  const lvl = p.level != null ? p.level : effectiveLevel(n); // expr sources carry no .level
  const common = [
    ['Verdict', readoutVerdict(n, lvl)],
    ['Why', explainLevel(n)],
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
        ['Speed source', p.official & 1 ? 'WSDOT legal speed' : null],
        ['Shoulder', p.sh >= 0 ? `${p.sh} ft` : null],
        ['Area', n.urban ? 'Urban (Census)' : 'Rural (Census)'],
        ['Sidewalk (OSM)', n.sidewalk || 'not mapped'],
        ['Rule override', sidewalkFallbackApplies(n) ? 'Sidewalk fallback — strongly deprioritized' : null],
        ['Bike facility', FACILITY_NAME[p.facility] || null],
        ['Facility source', p.official & 2 ? 'WSDOT Active Transportation Data' : null],
        ['Road class', ROAD_CLASS_NAME[p.roadClass] || null],
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
    title = 'Bikes prohibited (WSDOT)';
    rows = [
      ['Route', p.Route ? 'SR ' + String(p.Route).replace(/^0+/, '') : p.RouteIdentifier],
      ['Verdict', 'Red dashed — Fails your rules'],
      ['Why', 'Permanent bicycle restriction by official WSDOT traffic action.'],
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
    title = 'Road (OSM)';
    rows = [
      ['Name', p.n],
      ...common,
      ['Class', p.h + (p.r ? ` (${p.r})` : '')],
      ['Speed limit', p.s != null ? `${p.s} mph${p.e ? ' (estimated from class)' : ''}` : null],
      ['Shoulder', p.w != null ? p.w + ' ft' : null],
      ['Area', n.urban ? 'Urban (Census)' : 'Rural (Census)'],
      ['Sidewalk (OSM)', n.sidewalk || 'not mapped'],
      ['Rule override', sidewalkFallbackApplies(n) ? 'Sidewalk fallback — strongly deprioritized' : null],
      ['Bike facility', p.f ? 'yes' : null],
      ['Limited access', p.m ? 'yes' : null],
      ['Bikes prohibited', p.b ? 'yes (OSM tag)' : null],
    ];
  } else {
    title = 'Road segment (WSDOT)';
    rows = [
      ['Route', p.RouteIdentifier],
      ...common,
      ['BLTS (WSDOT)', p.LTS_Bicycle],
      ['Speed limit', p.SpeedLimit != null ? p.SpeedLimit + ' mph' : null],
      ['Lanes', p.LaneCount],
      ['AADT', p.AADT != null ? Number(p.AADT).toLocaleString() : null],
      ['Shoulder', p.ShoulderWidth != null ? p.ShoulderWidth + ' ft' : null],
      ['Area', n.urban ? 'Urban (Census)' : 'Rural (Census)'],
      ['Sidewalk (OSM)', wsdotSidewalkAt(lngLat)],
      ['Bike facility', p.BikeFacilityType],
      ['Designated bike route', p.Designated === 1 ? 'yes' : null],
      ['Limited access', p.LimitedAccess ? 'yes' : null],
      ['Bikes prohibited', p.Prohibited ? 'yes (WSDOT restriction)' : null],
    ];
  }
  // If a designated route runs under this spot, say so — the scored layers
  // draw on top of the ribbon, so this is how the designation stays visible.
  if (src.id !== 'routes') {
    const badge = routeBadgeAt(map.project(lngLat));
    if (badge) rows.push(['Bike route', badge]);
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
    ? 'Designated route map color' : `Map color: ${readoutVerdict(n, lvl)}`);
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
  streetViewBtn.setAttribute('aria-label', GOOGLE_MAPS_EMBED_KEY
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

function googleMapsPointUrl(lat, lng) {
  return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

function googleStreetViewUrl(lat, lng, heading = null) {
  const headingParam = Number.isFinite(heading) ? `&heading=${Math.round(heading)}` : '';
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat.toFixed(6)},${lng.toFixed(6)}${headingParam}`;
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
  if (!GOOGLE_MAPS_EMBED_KEY) {
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
  clearTimeout(streetViewLoadTimer);
  frame.dataset.streetViewActive = '1';
  setStreetViewLoadStatus('Loading Street View…');
  streetViewLoadTimer = setTimeout(() => {
    if (frame.dataset.streetViewActive === '1') {
      setStreetViewLoadStatus('Street View is taking longer than expected. Try Open in Google Maps.', true);
    }
  }, 12000);
  frame.src = `https://www.google.com/maps/embed/v1/streetview?key=${encodeURIComponent(GOOGLE_MAPS_EMBED_KEY)}&location=${lat.toFixed(6)},${lng.toFixed(6)}&radius=250${headingParam}&fov=90`;
  if (!dialog.open) dialog.showModal();
}

document.getElementById('streetViewFrame').addEventListener('load', (event) => {
  if (event.currentTarget.dataset.streetViewActive !== '1') return;
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

// Stop the panorama streaming (and free the connection) when the dialog closes.
document.getElementById('streetViewDialog').addEventListener('close', () => {
  clearTimeout(streetViewLoadTimer);
  streetViewLoadTimer = null;
  const frame = document.getElementById('streetViewFrame');
  frame.dataset.streetViewActive = '0';
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
map.on('mousemove', (e) => {
  // iOS synthesizes mouse movement while tapping. Let the touch-end handler
  // below open and pin the card; otherwise this hover preview wins first and
  // leaves the card in its fixed fallback position.
  if (!roadInfoHoverMedia.matches) return;
  if (routing.arm || Date.now() < roadInfoSuppressedUntil) {
    readoutEl.classList.remove('show');
    return;
  }
  if (readoutPinned) return;
  const f = featureAt(e.point);
  map.getCanvas().style.cursor = f ? 'pointer' : '';
  if (f) renderReadout(f, e.lngLat);
  else readoutEl.classList.remove('show');
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
  if (!routing.ready) {
    // A stale arm should never let the placement click fall through to road
    // details while the routing graph is still initializing.
    routing.arm = null;
    suppressRoadInfo(1500);
    updateArmButtons();
    waitForRoutePlanner();
    return true;
  }
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
  for (const src of SOURCES) {
    if (src.closure) continue;
    const row = document.createElement('div');
    row.className = 'source-row';
    row.id = `src-${src.id}`;
    const note = src.id === 'routes'
      ? '<small class="source-note source-note-prominent">Thicker dashed lines; may not have bike facilities</small>'
      : '';
    row.innerHTML = `
      <input type="checkbox" id="chk-${src.id}" ${src.enabled ? 'checked' : ''}>
      <span class="source-copy"><label for="chk-${src.id}">${src.name}</label>${note}</span>
      <span class="count"></span>`;
    host.appendChild(row);
    row.querySelector('input').addEventListener('change', (e) =>
      setSourceVisible(src, e.target.checked)
    );
  }
}

const ROUTING_WEIGHT_GROUPS = [
  ['Safety outcomes', [
    ['directFail', 'Direct: failing road', 1, 8, .05], ['balancedFail', 'Balanced: failing road', 1, 12, .1],
    ['lowFail', 'Friendly: failing road', 2, 60, 1], ['balancedComfy', 'Balanced: lower-stress road', .5, 1.2, .01],
    ['lowComfy', 'Friendly: lower-stress road', .5, 1.2, .01], ['freeway', 'Freeway last resort', 5, 100, 1],
  ]],
  ['Bike and neighborhood preference', [
    ['designated', 'Designated route (no facility)', .25, 1.2, .01], ['strongDesignated', 'Strong designated-route preference', .2, 1, .01],
    ['residential', 'Residential street', .4, 1.1, .01], ['facilityShared', 'Shared-lane marking', .4, 1.2, .01],
    ['facilityLane', 'Bike lane', .25, 1.1, .01], ['facilityBuffered', 'Buffered bike lane', .2, 1.1, .01],
    ['facilitySeparated', 'Separated bike lane', .2, 1.1, .01], ['facilityPath', 'Shared-use path', .2, 1.1, .01],
    ['mtbTrail', 'Mountain-bike trail when allowed', 1, 30, .5],
  ]],
  ['Major roads without a bike facility', [
    ['arterialTertiaryDirect', 'Tertiary · direct', 1, 3, .01], ['arterialTertiaryBalanced', 'Tertiary · balanced', 1, 3, .01],
    ['arterialTertiaryLow', 'Tertiary · friendly', 1, 3, .01], ['arterialSecondaryDirect', 'Secondary · direct', 1, 4, .01],
    ['arterialSecondaryBalanced', 'Secondary · balanced', 1, 4, .01], ['arterialSecondaryLow', 'Secondary · friendly', 1, 4, .01],
    ['arterialPrimaryDirect', 'Primary/trunk · direct', 1, 5, .01], ['arterialPrimaryBalanced', 'Primary/trunk · balanced', 1, 5, .01],
    ['arterialPrimaryLow', 'Primary/trunk · friendly', 1, 5, .01],
  ]],
  ['Speed, access and curve caution', [
    ['speedBalanced', 'Balanced: each mph over comfort', 0, .08, .002], ['speedLow', 'Friendly: each mph over comfort', 0, .1, .002],
    ['speedBelowDirect', 'Direct: each mph below comfort without shoulder', 0, .04, .001], ['speedBelowBalanced', 'Balanced: each mph below comfort without shoulder', 0, .08, .002],
    ['speedBelowLow', 'Friendly: each mph below comfort without shoulder', 0, .1, .002],
    ['limitedDirect', 'Limited access · direct', 1, 5, .05], ['limitedBalanced', 'Limited access · balanced', 1, 6, .05],
    ['limitedLow', 'Limited access · friendly', 1, 8, .05],
    ['hazardDirect1', 'Curve low · direct', 1, 5, .01], ['hazardDirect2', 'Curve medium · direct', 1, 6, .01],
    ['hazardDirect3', 'Curve high · direct', 1, 8, .01], ['hazardBalanced1', 'Curve low · balanced', 1, 5, .01],
    ['hazardBalanced2', 'Curve medium · balanced', 1, 8, .01], ['hazardBalanced3', 'Curve high · balanced', 1, 12, .1],
    ['hazardLow1', 'Curve low · friendly', 1, 8, .01], ['hazardLow2', 'Curve medium · friendly', 1, 12, .1],
    ['hazardLow3', 'Curve high · friendly', 1, 20, .1],
  ]],
  ['Ride model and alternatives', [
    ['ferryWaitMin', 'Ferry boarding wait (minutes)', 0, 60, 1], ['uphillFactor', 'Uphill effort', 1, 15, .25],
    ['downhillFactor', 'Downhill speed benefit', 0, 5, .1], ['undulationSecPerM', 'Rolling-hill cost (sec/m)', 0, 10, .25],
    ['climbDirectSecPerM', 'Extra climb preference · direct', 0, 5, .05],
    ['climbBalancedSecPerM', 'Extra climb preference · balanced', 0, 5, .05],
    ['climbLowSecPerM', 'Extra climb preference · friendly', 0, 5, .05],
    ['turnDirectSec', 'Turn cost · direct (seconds)', 0, 90, 1],
    ['turnBalancedSec', 'Turn cost · balanced (seconds)', 0, 90, 1],
    ['turnLowSec', 'Turn cost · friendly (seconds)', 0, 90, 1],
    ['diversityQuick', 'Alternative corridor · quick', 1.05, 3, .05], ['diversityBalanced', 'Alternative corridor · balanced', 1.05, 3, .05],
    ['diversitySafer', 'Alternative corridor · safer', 1.05, 3, .05], ['diversityWide', 'Alternative corridor · wide search', 1.05, 4, .05],
  ]],
];

function buildRoutingWeightsEditor() {
  const host = document.getElementById('routingWeightsEditor');
  host.replaceChildren();
  for (const [title, items] of ROUTING_WEIGHT_GROUPS) {
    const group = document.createElement('section');
    group.className = 'weights-group';
    const heading = document.createElement('h3');
    heading.textContent = title;
    group.append(heading);
    for (const [key, label, min, max, step] of items) {
      const row = document.createElement('label');
      row.className = 'weight-row';
      row.innerHTML = `<span>${label}</span><output>${routingWeights[key]}</output>
        <input type="range" min="${min}" max="${max}" step="${step}" value="${routingWeights[key]}" data-weight="${key}">`;
      const input = row.querySelector('input');
      input.addEventListener('input', () => {
        routingWeights[key] = Number(input.value);
        row.querySelector('output').textContent = input.value;
        suppressRoadInfo(1200);
        scheduleRescore();
      });
      group.append(row);
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
    ['Speed without shoulder', `Urban: up to ${presetRules.urbanMaxSpeedNoShoulder} mph; rural: up to ${presetRules.ruralMaxSpeedNoShoulder} mph.`],
    ['Minimum shoulder', `${presetRules.minShoulder} ft on faster roads.`],
    ['Sidewalk fallback', presetRules.allowSidewalkFallback
      ? 'Mapped sidewalks can satisfy the shoulder rule, but are strongly deprioritized and called out as a concern.'
      : 'Mapped sidewalks do not satisfy the shoulder rule.'],
    ['Designated bike routes', presetRules.vettedBikeRoutes
      ? 'Can satisfy the shoulder rule; speed and access limits still apply.'
      : 'Must meet the normal speed and shoulder rules.'],
    ['Freeways', presetRules.allowFreeways
      ? 'Bike-legal segments may be used only as a last resort.' : 'Not used.'],
    ['Rule matching', presetRules.requireSafe
      ? 'Required, except short access blocks (~1,000 ft) at your start, waypoints, and destination; no route is shown otherwise.'
      : 'Not required; a route may include rule-failing segments to complete it.'],
    ['Unknown shoulder', presetRules.unknownShoulderZero ? 'Treated as 0 ft.' : 'Left as unknown.'],
    ['Mountain-bike trails', presetRules.allowMtbTrails ? 'Available with a strong penalty.' : 'Not used.'],
    ['Surface', presetRules.preferPaved === true
      ? 'Strongly prefer paved roads and trails.' : 'Slightly prefer known paved roads and trails.'],
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
  if (!activeRoutingPreset() && !window.confirm(
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
  rescoreAll(false);
  const osm = SOURCES.find((source) => source.id === 'osm');
  if (osm && map.getLayer(osm.id)) applyDisplayMode(osm);
  saveStateSoon();
  if (routing.ready && routing.start && routing.end) computeRoute();
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

  const slider = (key, label, min, max, step, unit) => {
    const wrap = document.createElement('div');
    wrap.className = 'rule rule-card';
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

  const check = (key, label, state = rules, onChange = scheduleRescore) => {
    const wrap = document.createElement('div');
    wrap.className = 'check-rule rule-card';
    wrap.innerHTML = `
      <label class="rule-check" for="r-${key}">
        <input type="checkbox" id="r-${key}" ${state[key] ? 'checked' : ''}>
        <span>${label}</span>
      </label>`;
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
  check('vettedBikeRoutes', 'Trust designated bike routes');
  check('allowFreeways', 'Allow freeway as last resort');
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
  check('unknownShoulderZero', 'Unknown shoulder = 0 ft');
  slider('urbanMaxSpeedNoShoulder', '<strong class="area-rule area-rule-urban">Urban</strong> max speed without shoulder', 15, 45, 5, ' mph');
  slider('ruralMaxSpeedNoShoulder', '<strong class="area-rule area-rule-rural">Rural</strong> max speed without shoulder', 15, 45, 5, ' mph');
  slider('minShoulder', 'Minimum shoulder for faster roads', 0, 10, 1, ' ft');

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
    document.getElementById('settingsHelpBtn').addEventListener('click', () =>
      document.getElementById('settingsHelpDialog').showModal());
    document.getElementById('settingsAdvancedWeightsBtn').addEventListener('click', () => {
      const helpDialog = document.getElementById('settingsHelpDialog');
      if (helpDialog.open) helpDialog.close();
      buildRoutingWeightsEditor();
      document.getElementById('weightsDialog').showModal();
    });
    document.getElementById('resetRoutingWeights').addEventListener('click', () => {
      Object.assign(routingWeights, DEFAULT_ROUTING_WEIGHTS);
      buildRoutingWeightsEditor();
      scheduleRescore();
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

  // Off-route behavior: a dropdown plus one live description line. The three
  // described radio cards it replaces forced the whole pane to scroll; a select
  // keeps every voice control on one sheet without shrinking anything else.
  // Descriptions are static literals (no user input), so innerHTML is safe and
  // lets the dynamic-mode caution render in bold.
  const offRouteChoices = [
    ['guidance', 'Notify only', 'Gives the direction and distance back to your route.'],
    ['return', 'Route back to route', 'Automatically routes you back to the nearest point on your route.'],
    ['dynamic', 'Dynamic re-routing', 'Generates a new route automatically each time you go off course. <strong>Caution: remaining route may change!</strong>'],
  ];
  const offRoute = document.createElement('div');
  offRoute.className = 'rule rule-card voice-offroute';
  offRoute.innerHTML = `
    <div class="rule-head voice-inline-head"><label for="v-offRouteMode">Off-route behavior</label>
      <select id="v-offRouteMode" class="voice-select voice-select-inline">${offRouteChoices.map(([value, label]) =>
        `<option value="${value}"${navVoice.offRouteMode === value ? ' selected' : ''}>${label}</option>`).join('')}</select></div>
    <p class="voice-hint" id="v-offRouteDesc"></p>`;
  const offRouteDesc = offRoute.querySelector('#v-offRouteDesc');
  const syncOffRouteDesc = () => {
    const choice = offRouteChoices.find(([value]) => value === navVoice.offRouteMode);
    offRouteDesc.innerHTML = choice ? choice[2] : '';
    offRouteDesc.classList.toggle('voice-hint-warn', navVoice.offRouteMode === 'dynamic');
  };
  syncOffRouteDesc();
  offRoute.querySelector('select').addEventListener('change', (e) => {
    navVoice.offRouteMode = e.target.value;
    // Choosing an automatic mode is an explicit request to try it, even if a
    // prior recovery attempt during this off-route interval could not finish.
    turnNav.autoRecoveryAttempted = false;
    syncOffRouteDesc();
    saveStateSoon();
    maybeAutomaticallyRecoverOffRoute();
  });
  host.appendChild(offRoute);

  const headings = document.createElement('div');
  headings.className = 'check-rule rule-card';
  headings.innerHTML = `<label class="rule-check"><input type="checkbox" id="v-voiceHeadings"
    ${navVoice.headings ? 'checked' : ''}><span>Speak compass directions (N/S/E/W)</span></label>`;
  headings.querySelector('input').addEventListener('change', (e) => {
    navVoice.headings = e.target.checked;
    saveStateSoon();
  });
  host.appendChild(headings);

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
    saveStateSoon();
  });
  cadence.querySelectorAll('[data-voice-status]').forEach((input) =>
    input.addEventListener('change', () => {
      navVoice[input.dataset.voiceStatus] = input.checked;
      saveStateSoon();
    }));
  host.appendChild(cadence);
}

function buildLegend() {
  const host = document.getElementById('legend');
  host.innerHTML = '';
  const dash = (c) => `background:repeating-linear-gradient(90deg,${c} 0 4px,transparent 4px 8px)`;
  const trail = `background-color:${BIKE_NETWORK_COLOR};background-image:radial-gradient(circle,#687d00 0 1.2px,transparent 1.45px);background-size:7px 6px;background-repeat:repeat-x;background-position:center`;
  const rows = [
    [BIKE_NETWORK_COLOR, 'Bike trails & lanes'],
    ['trail', 'Off-street trails'],
    [COLORS[1], 'Road that meets safety rules'],
    ['dash4', 'Road that fails safety rules'],
    [COLORS[3], 'Caution — limited-access highway'],
    ['ferry', 'Ferry crossing (planned route)'],
    ['dismount', 'Dismount point — walk your bike'],
    ['dashDesig', 'Designated bike route (overlay)'],
    ['unpaved', 'Cross-slats: confirmed unpaved (overlay)'],
  ];
  for (const [color, label] of rows) {
    const item = document.createElement('div');
    item.className = 'item';
    const swatch =
      color === 'trail'
        ? `<span class="swatch" style="${trail}"></span>`
        : color === 'dash4'
        ? `<span class="swatch" style="${dash(COLORS[4])}"></span>`
        : color === 'dashDesig'
        ? `<span class="swatch" style="${dash(COLORS[2])}"></span>`
        : color === 'unpaved'
        ? '<span class="swatch legend-unpaved-swatch"></span>'
        : color === 'dismount'
        ? '<span class="swatch legend-dismount-swatch">⚠</span>'
        : color === 'ferry'
        ? `<span class="swatch" style="background:repeating-linear-gradient(90deg,#ffffff 0 4px,#9dbfd8 4px 8px);border:1px solid #c7d7e2"></span>`
        : color === 'dash2'
        ? `<span class="swatch" style="${dash(COLORS[2])}"></span>`
        : color
        ? `<span class="swatch" style="background:${color}"></span>`
        : `<span class="swatch" style="background:transparent;border:1px dashed #bbb"></span>`;
    item.innerHTML = `${swatch}<span>${label}</span>`;
    host.appendChild(item);
  }
}

/* ------------------------------------------------------------- boot */
buildSourcePanel();
buildRulesPanel();
buildVoicePanel();
buildRoutingPanel();
buildLegend();
// Start the on-device routing graph before route editing is available. This
// keeps endpoint, waypoint, and road-block actions from racing initialization.
ensureRouter();

function setLegendOpen(open) {
  const flyout = document.getElementById('legendFlyout');
  const toggle = document.getElementById('legendToggle');
  if (!flyout || !toggle) return;
  flyout.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.title = open ? 'Hide map legend' : 'Show map legend';
}
document.getElementById('legendToggle').addEventListener('click', () =>
  setLegendOpen(document.getElementById('legendFlyout').hidden));
document.getElementById('legendClose').addEventListener('click', () => setLegendOpen(false));

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

// Dialog close buttons and the version shown inside Getting Started help.
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () =>
  document.getElementById(b.dataset.close).close()));
document.getElementById('appVersion').textContent = 'v' + APP_VERSION;
document.getElementById('appHelpBtn').addEventListener('click', () =>
  document.getElementById('appHelpDialog').showModal());
document.getElementById('layersHelpBtn').addEventListener('click', () =>
  document.getElementById('layersHelpDialog').showModal());
document.getElementById('routesHelpBtn').addEventListener('click', () => {
  document.getElementById('routesDialog').close();
  document.getElementById('routesHelpDialog').showModal();
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

    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
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
document.getElementById('checkUpdatesBtn').addEventListener('click', async () => {
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
    await reg.update();
    const fresh = reg.waiting || reg.installing;
    if (fresh) {
      status.textContent = 'Update found — installing…';
      if (reg.waiting) offerUpdate(reg.waiting);
      else fresh.addEventListener('statechange', () => {
        if (fresh.state === 'installed') offerUpdate(fresh);
      });
      // The update prompt renders under this modal dialog; close it so the
      // "Get update?" banner is visible.
      document.getElementById('appHelpDialog')?.close();
    } else {
      status.textContent = `You have the latest version (v${APP_VERSION}).`;
    }
  } catch (e) {
    status.textContent = 'Could not check right now — make sure you are online and try again.';
  }
  btn.disabled = false;
});



// Run cb as soon as the style spec is loaded. Polling avoids a styledata-event
// race, and isStyleLoaded flips true independent of basemap TILE loading, so a
// slow or unreachable basemap never blocks the data layers.
function onStyleReady(cb) {
  const check = () => (map.isStyleLoaded() ? cb() : setTimeout(check, 120));
  check();
}

onStyleReady(() => {
  for (const src of SOURCES) if (src.enabled) loadSource(src);
});

// Debug handle (harmless; used for local verification).
window.VIS = { map, SOURCES, rules, rescoreAll, effectiveLevel };
