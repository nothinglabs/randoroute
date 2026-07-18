/*
 * Washington Bike Safety Visualizer — Phase 1 (WSDOT BLTS)
 *
 * Visualization only. All data is baked into local static files at build time;
 * the app makes no runtime calls to WSDOT / Overpass / ArcGIS and does no routing.
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

const APP_VERSION = '2026-07-18.146';
// Increment whenever router-worker.js changes the binary graph contract. It
// keeps a just-updated worker from receiving a graph cached by an older
// service worker during the first post-update load.
const GRAPH_FORMAT_VERSION = 'bgr7-2';

/* ---------------------------------------------------------------- palette */
// One visual verdict system. Internal levels 1 and 2 retain different routing
// costs but share blue; a passing bike-network edge is promoted to lime.
// Caution is a muted purple, failure is red, and insufficient data is gray.
const BIKE_NETWORK_COLOR = '#9fc400';
const COLORS = {
  1: '#168ad1', // passes rules
  2: '#168ad1', // passes rules (internal levels remain distinct for routing)
  3: '#63418f', // caution — dark muted purple, distinct from lime facilities
  4: '#b2182b', // fails rules
  0: '#999999', // insufficient data
};

/* ------------------------------------------------- riding-rules state */
const DEFAULT_RULES = Object.freeze({
  allowFreeways: true,  // only permit heavily penalized freeway fallback?
  allowMtbTrails: false, // technical MTB paths are opt-in, not ordinary bike routing
  vettedBikeRoutes: true, // let designated corridors pass despite missing/narrow shoulder data?
  minShoulder: 4,       // ft; below this a road gets penalized
  unknownShoulderZero: true, // pessimistic: no shoulder data = 0 ft (fast roads must PROVE a shoulder)
  freeMaxSpeed: 35,     // mph; at/below this a road passes even without a shoulder
  upperMaxSpeed: 45,    // mph; roads above this absolute cutoff fail
  noUpperLimit: true,   // disable the upper-speed hard cap
  requireSafe: false,   // limit the portfolio to routes whose every edge matches the rules
});
const rules = { ...DEFAULT_RULES };
const RULE_NUMBER_LIMITS = {
  minShoulder: [0, 10],
  freeMaxSpeed: [15, 45],
  upperMaxSpeed: [35, 65],
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
  diversityQuick: 1.3, diversityBalanced: 1.35, diversitySafer: 1.35, diversityWide: 1.6,
});
const ROUTING_WEIGHTS_VERSION = 6;
function validRoutingWeights(source) {
  const clean = {};
  const zeroOkay = new Set(['ferryWaitMin', 'speedBalanced', 'speedLow',
    'speedBelowDirect', 'speedBelowBalanced', 'speedBelowLow', 'downhillFactor', 'undulationSecPerM']);
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
  if (hw === 'cycleway' && bike !== 'no' && bike !== 'dismount') base = 1;
  else if (hw === 'path' && (bike === 'designated' || bike === 'yes')) base = 1;
  else if (hw === 'footway' && bike === 'designated') base = 2;
  else if (hw === 'bridleway' && (bike === 'designated' || bike === 'yes')) base = 2;
  else if (hw === 'track' && (bike === 'designated' || bike === 'yes')) base = 2;
  else if (hw === 'service' && bike === 'designated'
      && (p.motor_vehicle === 'no' || p.motor_vehicle === 'private'
        || p.access === 'no' || p.access === 'private')) base = 1;
  else if (OSM_PROTECTED.has(cw)) base = 1;
  else if (OSM_LANE.has(cw)) base = 2;
  else if ((bike === 'no' || bike === 'dismount') && bikeish) { base = 4; prohibited = true; }
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
  };
}

// Full OSM road network (Phase 3). Short property keys (see build_roads.py):
// h=class s=speed(mph) e=estimated f=facility b=bike-prohibited m=motorway
// w=shoulder(ft) n=name r=ref. Speeds are always present — actual, or inferred
// from road class (BNA-style) with e=1 marking the estimate.
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

  // Slow enough → comfortable regardless of shoulder.
  if (spd != null && spd <= rules.freeMaxSpeed) return n.limited_access ? 3 : 1;

  // A rider can opt to treat a designated bike route (USBR / regional trail)
  // as a vetted corridor. The freeway, prohibition, and speed-cutoff gates
  // above still apply; otherwise it is evaluated by the shoulder rule.
  if (n.desig && rules.vettedBikeRoutes) return n.limited_access ? 3 : 2;

  // Hard gates. Each fails ONLY when we have data proving the violation
  // (with the pessimistic option, "unknown = 0 ft" counts as data).
  const shoulderFails = !n.good_facility && sh != null && sh < rules.minShoulder;
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
    vector: 'pmtiles://data/roads.pmtiles?v=9',
    sourceLayer: 'roads',
    count: 323730, // baked at build time (tiles don't carry a global count)
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
  const cases = [];
  cases.push(['==', ['get', 'b'], 1], 4);                       // bikes prohibited
  cases.push(['==', ['get', 'm'], 1], 4);                       // freeway: last-resort failure
  if (!rules.noUpperLimit) cases.push(['>', spd, rules.upperMaxSpeed], 4); // absolute speed cap
  cases.push(['<=', spd, rules.freeMaxSpeed], 1);               // slow = comfortable
  if (rules.vettedBikeRoutes)
    cases.push(['==', ['get', 'g'], 1], 2);                     // designated route = vetted
  // Shoulder gate: pessimistic mode treats a missing shoulder as 0 ft;
  // otherwise only a known-narrow shoulder fails.
  const sh = rules.unknownShoulderZero
    ? ['coalesce', ['get', 'w'], 0]
    : ['case', ['has', 'w'], ['get', 'w'], rules.minShoulder]; // unknown -> never under
  cases.push(['all', ['!=', ['get', 'f'], 1], ['<', sh, rules.minShoulder]], 4);
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
// Version 6 deliberately replaces every earlier advanced-weight set. The
// defaults are part of the router's safety behavior, and must match the
// weights sent to router-worker.js rather than leaving existing devices on
// the obsolete 1.15× direct / 3× balanced failure penalties.
if ((savedState?.weightsVersion || 0) < ROUTING_WEIGHTS_VERSION) {
  Object.assign(savedRoutingWeights, DEFAULT_ROUTING_WEIGHTS);
}
const routingWeights = { ...DEFAULT_ROUTING_WEIGHTS, ...savedRoutingWeights };

// Navigation choices are local device preferences, not part of a shared route.
// Keep automatic recovery on by default, while still letting a rider opt out.
const DEFAULT_NAVIGATION_OPTIONS = Object.freeze({ autoReroute: true });
const navigationOptions = {
  autoReroute: !savedState || typeof savedState.autoReroute !== 'boolean'
    ? DEFAULT_NAVIGATION_OPTIONS.autoReroute : savedState.autoReroute,
};
const DEFAULT_ROUTE_PREFERENCES = Object.freeze({ prefDesig: true, prefResidential: true });
const ROUTING_PRESETS = Object.freeze([
  {
    id: 'randonneur',
    label: 'The Randonneur',
    audience: 'For long-distance riders who want the widest range of route choices.',
    blurb: 'Widest choice of routes; loose rules, fewer flags.',
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
      freeMaxSpeed: 25,
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
      freeMaxSpeed: 25,
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

const MAX_ROUTE_STOPS = 8;
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
  if (!vias.every(validRoutePoint)) return null;
  // Preserve plans created before the editor gained a stop limit. New edits
  // cannot add past the limit, but opening an old plan must not delete stops.
  return { s: route.s, e: route.e, v: [...vias] };
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
    if (!vias.every(validRoutePoint)) return null;
    const sharedRules = validRuleOverrides(data.r);
    return {
      // Version-1 links historically loaded their first eight stops. Preserve
      // that behavior so older links in messages continue to work.
      route: { s: data.s, e: data.e, v: vias.slice(0, MAX_ROUTE_STOPS) },
      mode: ['direct', 'balanced', 'low'].includes(data.m) ? data.m : null,
      profileId: ROUTE_PROFILE_IDS.has(data.o) ? data.o : null,
      prefDesig: typeof data.p === 'boolean' ? data.p : null,
      prefResidential: typeof data.q === 'boolean' ? data.q : null,
      rules: sharedRules,
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
if (sharedRoute) Object.assign(rules, sharedRoute.rules);

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
      autoReroute: navigationOptions.autoReroute,
      weights: routingWeights, weightsVersion: ROUTING_WEIGHTS_VERSION,
      sources: Object.fromEntries(SOURCES.map((s) => [s.id, !!s.enabled])),
      view: { c: map.getCenter().toArray().map((v) => +v.toFixed(5)), z: +map.getZoom().toFixed(2) },
      route: routing.start && routing.end
        ? { s: routing.start, e: routing.end, v: routing.vias.map((x) => x.pt) } : null,
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
  center: (savedState && savedState.view && savedState.view.c) || [-120.5, 47.4],
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
  clearNavigationRejoin();
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
        6, ['match', ['get', 't'], 'ncn', 2.6, 1.6],
        10, ['match', ['get', 't'], 'ncn', 5, 3],
        14, ['match', ['get', 't'], 'ncn', 9, 5.5]]);
    map.setPaintProperty(src.id, 'line-opacity', backgroundLineOpacity(0.42));
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
  vias: [],                  // intermediate stops: { pt: [lng,lat], marker }
  navRejoin: null,           // transient route point used by turn-by-turn rerouting
  startMarker: null, endMarker: null,
  worker: null, ready: false, loading: false,
  mode: sharedRoute?.mode || (['direct', 'balanced', 'low'].includes(savedState?.mode)
    ? savedState.mode : 'balanced'), // 'direct' | 'balanced' | 'low'
  profileId: sharedRoute
    ? (sharedRoute.profileId || legacyRouteProfile(sharedRoute.mode))
    : (ROUTE_PROFILE_IDS.has(savedState?.profileId)
      ? savedState.profileId : legacyRouteProfile(savedState?.mode)),
  prefDesig: sharedRoute?.prefDesig != null ? sharedRoute.prefDesig : savedState && typeof savedState.prefDesig === 'boolean'
    ? savedState.prefDesig : DEFAULT_ROUTE_PREFERENCES.prefDesig, // force this preference across every route option
  prefResidential: sharedRoute?.prefResidential != null ? sharedRoute.prefResidential
    : savedState && typeof savedState.prefResidential === 'boolean'
      ? savedState.prefResidential : DEFAULT_ROUTE_PREFERENCES.prefResidential,
  reqId: 0,
  compareStartedAt: 0,
  options: [],
  last: null, // last successful result (for redraws)
};

function setRouteStatus(t) {
  for (const id of ['route-status', 'rb-status']) {
    const el = document.getElementById(id);
    if (el) el.textContent = t;
  }
}

let routeActionToastTimer = null;
function showRouteActionToast(text, { busy = false, duration = 2200 } = {}) {
  const toast = document.getElementById('routeActionToast');
  const label = document.getElementById('routeActionText');
  if (!toast || !label) return;
  clearTimeout(routeActionToastTimer);
  label.textContent = text || '';
  toast.classList.toggle('busy', busy);
  toast.hidden = !text;
  if (text && duration > 0) routeActionToastTimer = setTimeout(() => { toast.hidden = true; }, duration);
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
  const reason = `Routing failed (${detail}). Change a route point to try again.`;
  showRouteActionToast('Routing failed', { duration: 2600 });
  routing.reqId++; // invalidate any reply still queued by the failed worker
  routing.ready = false;
  routing.loading = false;
  if (routing.worker) routing.worker.terminate();
  routing.worker = null;
  routing.navRejoin = null;
  routing.options = [];
  setRouteOptionsLoading(false);
  renderRouteOptionControls();
  stopTurnNavigation(false);
  routing.last = { ok: false, code: 'router-error', reason };
  clearStoredRouteDetails();
  renderRouteCard(routing.last);
  if (map.isStyleLoaded()) drawRoute([]);
  setRouteStatus(reason);
}

async function ensureRouter() {
  if (routing.ready || routing.loading) return;
  routing.loading = true;
  try {
    setRouteStatus('Loading routing data (one-time download)…');
    showRouteActionToast('Preparing route engine — first run takes a few seconds…', { busy: true, duration: 0 });
    const res = await fetch(`data/graph2.bin.gz?format=${GRAPH_FORMAT_VERSION}`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    let buf = await res.arrayBuffer();
    const head = new Uint8Array(buf, 0, 2);
    if (head[0] === 0x1f && head[1] === 0x8b) {
      // Server delivered the gzip container raw — decompress ourselves.
      const ds = new DecompressionStream('gzip');
      buf = await new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer();
    }
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
  if (s.mph <= rules.freeMaxSpeed) return flags & 128 ? 3 : 1;
  if ((flags & 64) && rules.vettedBikeRoutes) return flags & 128 ? 3 : 2;
  let sh = s.sh;
  if (sh < 0 && rules.unknownShoulderZero) sh = 0;
  if ((s.facility || 0) < 2 && sh >= 0 && sh < rules.minShoulder) return 4;
  return flags & 128 ? 3 : 2;
}

const HIGHWAY_NAME = /\b(highway|state route|sr\s*\d|us\s*(?:route\s*)?\d|i-?\s*\d)\b/i;
function isHighwaySegment(s) {
  const flags = s.flags || 0;
  return !(flags & (4 | 8 | 32)) && (s.mph >= 45 || HIGHWAY_NAME.test(s.name || ''));
}

function routeSummaryStats(m) {
  const levels = [0, 0, 0, 0, 0];
  let highwayM = 0, freewayM = 0, limitedAccessM = 0, bikeNetworkM = 0, mtbM = 0;
  for (const s of m.segs || []) {
    const flags = s.flags || 0;
    const len = Number(s.lenM) || 0;
    if (flags & 32) continue; // ferry is reported separately, not a riding safety level
    const level = s.level || fallbackRouteLevel(s);
    if (level >= 1 && level <= 4) levels[level] += len;
    // Physical facilities only (lime on the map) — designation alone can be a
    // plain road, and Route Details' "Bike network" verdict draws this line
    // the same way.
    if ((flags & 8) || (s.facility || 0) >= 2) bikeNetworkM += len;
    if (s.mtb || ((s.official || 0) & 4)) mtbM += len;
    if (flags & 4) freewayM += len;
    else if (flags & 128) limitedAccessM += len;
    else if (isHighwaySegment(s)) highwayM += len;
  }
  return { levels, highwayM, freewayM, limitedAccessM, bikeNetworkM, mtbM };
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
  const base = optimization.mode === 'direct'
    ? 'Prioritizes a quicker trip.'
    : optimization.mode === 'low'
      ? 'Strongly avoids roads that fail your rules.'
      : 'Balances travel time against roads that fail your rules.';
  const preferences = [];
  if (optimization.prefDesignated) preferences.push('bike routes & trails');
  if (optimization.prefResidential) preferences.push('residential streets');
  const method = preferences.length ? `${base} Prefers ${preferences.join(' and ')}.` : base;
  const discovery = optimization.discoveryMaxSpeed
    ? ` Found with a ${optimization.discoveryMaxSpeed} mph no-shoulder search; map colors use your settings.`
    : '';
  const matching = optimization.fullyMatchingRules
    ? ' Every segment matches your safety rules.' : '';
  return `${optimization.reason ? `${optimization.reason} ` : ''}${method}${discovery}${matching}`;
}
// Downsampled elevation profile for the Route Details Elevation tab — enough
// points to draw at dialog width without bloating localStorage.
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

function storeRouteDetails(m) {
  if (!m || !m.ok) return;
  try {
    localStorage.setItem(ROUTE_DETAILS_KEY, JSON.stringify({
      savedAt: Date.now(),
      profile: compactRouteProfile(m),
      snapStartM: Number(m.snapStartM) || 0,
      snapEndM: Number(m.snapEndM) || 0,
      legs: (m.legs || []).map((l) => ({
        distM: Number(l.distM) || 0, timeS: Number(l.timeS) || 0, failM: Number(l.failM) || 0,
      })),
      mode: routing.mode,
      optimization: m.optimization ? {
        ...m.optimization,
        description: optimizationDescription(m.optimization),
      } : null,
      rules: { ...rules },
      summary: {
        distM: m.distM, timeS: m.timeS, ascentM: m.ascentM, descentM: m.descentM,
        failM: m.failM, desigM: m.desigM, facilityM: m.facilityM, ferryM: m.ferryM,
        mtbM: m.mtbM || 0, hazardM: m.hazardM || 0,
      },
      // Keep the detailed report compact: it only needs road attributes and
      // lengths, not the complete route geometry or elevation profile.
      segs: (m.segs || []).map((s) => ({
        name: s.name || '', mph: s.mph, sh: s.sh, flags: s.flags || 0,
        facility: s.facility || 0, official: s.official || 0, mtb: !!s.mtb,
        roadClass: s.roadClass || 0, c0: s.c0, c1: s.c1,
        hazard: s.hazard || 0,
        hazardLenM: s.hazardLenM || 0, hazC0: s.hazC0, hazC1: s.hazC1,
        gradePct: s.gradePct || 0,
        level: s.level || fallbackRouteLevel(s), lenM: Number(s.lenM) || 0,
      })),
    }));
  } catch (e) { /* storage unavailable — the map still works normally */ }
}

/* --------------------------------------------------- turn navigation */
// This is deliberately a foreground navigation mode. It uses the browser's
// GPS, speech synthesis, and Screen Wake Lock API while the app is visible.
// A native iOS wrapper is still required for reliable background navigation.
const turnNav = {
  active: false,
  watchId: null,
  wakeLock: null,
  marker: null,
  route: null,
  next: 0,
  nearest: 0,
  routeM: 0,
  message: '',
  offRouteSpokenAt: 0,
  offRoute: false,
  offRouteExit: null,
  offRouteMovingMs: 0,
  offRouteFix: null,
  lastPosition: null,
  rejoinAwaiting: false,
  arrived: false,
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

function navTurnText(delta, road) {
  const abs = Math.abs(delta);
  const onto = road ? ` onto ${road}` : '';
  if (abs >= 150) return `Make a U-turn${onto}`;
  if (abs >= 55) return `Turn ${delta > 0 ? 'right' : 'left'}${onto}`;
  if (abs >= 20) return `Bear ${delta > 0 ? 'right' : 'left'}${onto}`;
  return road ? `Continue onto ${road}` : 'Continue';
}

function navDistanceText(m) {
  if (m < 160.934) return `${Math.max(25, Math.round(m / 25) * 25)} feet`;
  return `${(m / 1609.34).toFixed(m < 1609.34 ? 1 : 1)} miles`;
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
    const current = segs[i], next = segs[i + 1];
    const at = Math.max(1, Math.min(coords.length - 2, next.c0));
    const incoming = navBearing(coords[Math.max(0, at - 2)], coords[at]);
    const outgoing = navBearing(coords[at], coords[Math.min(coords.length - 1, at + 2)]);
    const delta = navDelta(incoming, outgoing);
    const from = navRoadName(current.name);
    const to = navRoadName(next.name);
    const changedRoad = !!to && to.toLowerCase() !== from.toLowerCase();
    if (!changedRoad && Math.abs(delta) < 40) continue;
    const distanceM = cumulative[at];
    // Do not speak a chain of tiny graph-edge transitions as separate turns.
    if (distanceM - lastM < 70) continue;
    instructions.push({ distanceM, coordIndex: at, text: navTurnText(delta, to) });
    lastM = distanceM;
  }
  instructions.sort((a, b) => a.distanceM - b.distanceM);
  return { coords, cumulative, instructions, segs, totalM: cumulative[cumulative.length - 1] || 0 };
}

const AUTO_REROUTE_AFTER_MS = 60_000;
const NAV_MOVING_MPS = 0.7;

function routeRoadNameAt(index) {
  for (const seg of turnNav.route?.segs || []) {
    if (index >= seg.c0 && index <= seg.c1) return navRoadName(seg.name);
  }
  return '';
}

function clearOffRouteTracking() {
  turnNav.offRoute = false;
  turnNav.offRouteExit = null;
  turnNav.offRouteMovingMs = 0;
  turnNav.offRouteFix = null;
}

function beginOffRouteTracking(pos, nearest) {
  const point = [pos.coords.longitude, pos.coords.latitude];
  const at = Number.isFinite(pos.timestamp) ? pos.timestamp : Date.now();
  turnNav.offRoute = true;
  turnNav.offRouteExit = {
    index: turnNav.nearest,
    routeM: turnNav.routeM,
    road: routeRoadNameAt(turnNav.nearest),
  };
  turnNav.offRouteMovingMs = 0;
  turnNav.offRouteFix = { point, at };
  turnNav.message = `Off route by ${navDistanceText(nearest.offRouteM)}`;
}

function trackOffRouteMovingTime(pos) {
  const point = [pos.coords.longitude, pos.coords.latitude];
  const at = Number.isFinite(pos.timestamp) ? pos.timestamp : Date.now();
  const previous = turnNav.offRouteFix;
  turnNav.offRouteFix = { point, at };
  if (!previous) return false;
  const elapsedMs = Math.max(0, Math.min(30_000, at - previous.at));
  if (!elapsedMs) return false;
  const distanceM = navDistanceM(previous.point, point);
  const reportedSpeed = pos.coords.speed == null ? NaN : Number(pos.coords.speed);
  const derivedSpeed = distanceM / (elapsedMs / 1000);
  // Browser GPS speed is often null. When it is, require both a plausible
  // riding speed and enough distance to reject stationary GPS drift.
  const moving = Number.isFinite(reportedSpeed)
    ? reportedSpeed >= NAV_MOVING_MPS
    : distanceM >= 6 && derivedSpeed >= NAV_MOVING_MPS;
  if (moving) turnNav.offRouteMovingMs += elapsedMs;
  return moving;
}

function offRouteReturnTarget() {
  return turnNav.offRouteExit?.road || 'your planned route';
}

function navigationBannerInfo() {
  if (!turnNav.active) return {
    headline: 'GPS voice guidance · keeps the screen awake when supported',
    meta: '',
    kicker: 'Turn-by-turn navigation',
  };
  const remainingRouteM = Math.max(0, (turnNav.route?.totalM || 0) - turnNav.routeM);
  const routeMeta = `${navDistanceText(remainingRouteM)} remaining`;
  if (turnNav.arrived) return { headline: 'You have arrived', meta: routeMeta, kicker: 'Destination reached' };
  if (turnNav.offRoute) {
    const nearStart = turnNav.offRouteExit?.routeM < 250;
    const remainingSeconds = Math.max(0, Math.ceil((AUTO_REROUTE_AFTER_MS - turnNav.offRouteMovingMs) / 1000));
    const meta = navigationOptions.autoReroute
      ? (nearStart && turnNav.offRouteMovingMs < AUTO_REROUTE_AFTER_MS
        ? 'Move route start to current location (if that’s accurate)'
        : `Auto-reroute in ${remainingSeconds} sec of moving time · Tap Reroute now`)
      : 'Tap Reroute to make a new route from here';
    return {
      headline: `Off route — return to ${offRouteReturnTarget()}`,
      meta,
      kicker: 'Off route',
    };
  }
  const next = turnNav.route?.instructions[turnNav.next];
  if (turnNav.message) return { headline: turnNav.message, meta: routeMeta, kicker: 'Turn-by-turn navigation' };
  if (!next) return { headline: 'Continue to your destination', meta: routeMeta, kicker: 'Turn-by-turn navigation' };
  const remaining = Math.max(0, next.distanceM - turnNav.routeM);
  return {
    headline: `In ${navDistanceText(remaining)} · ${next.text}`,
    meta: `${routeMeta} · GPS guidance active`,
    kicker: 'Next maneuver',
  };
}

function navigationStatusText() {
  return navigationBannerInfo().headline;
}

function openRouteDetails() {
  if (!routing.last?.ok) return;
  const dialog = document.getElementById('routeDetailsDialog');
  const frame = document.getElementById('routeDetailsFrame');
  if (!dialog || !frame || !dialog.showModal) {
    window.location.href = 'route-details.html';
    return;
  }
  // Reload the embedded report so it always reflects the latest route data.
  frame.src = `route-details.html?embedded=1&t=${Date.now()}`;
  if (!dialog.open) dialog.showModal();
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
  if (event.data?.type !== 'highlight-route-step') return;
  showRouteStepOnMap(event.data.startIndex, event.data.endIndex,
    event.data.coordStart, event.data.coordEnd);
});

function refreshNavigationUI() {
  const routeAvailable = !!(routing.last?.ok && routing.last.coords?.length > 1);
  document.body.classList.toggle('navigation-active', turnNav.active);
  const startButton = document.getElementById('navStartButton');
  if (startButton) {
    startButton.disabled = !routeAvailable;
    startButton.title = !routeAvailable
      ? 'Set a route to navigate'
      : turnNav.active ? 'Pause navigation' : 'Start turn-by-turn navigation';
    startButton.setAttribute('aria-pressed', String(turnNav.active));
  }
  const startLabel = document.getElementById('navStartLabel');
  if (startLabel) startLabel.textContent = turnNav.active ? 'Pause' : 'Navigate';
  const startIcon = document.getElementById('navStartIcon');
  if (startIcon) startIcon.textContent = turnNav.active ? 'Ⅱ' : '▶';
  syncRouteOptionControls();
  const banner = document.getElementById('navBanner');
  const kicker = document.getElementById('navBannerKicker');
  const bannerText = document.getElementById('navBannerText');
  const bannerMeta = document.getElementById('navBannerMeta');
  const reroute = document.querySelector('[data-nav-action="reroute"]');
  const info = navigationBannerInfo();
  if (banner) banner.hidden = !turnNav.active;
  if (reroute) reroute.hidden = !(turnNav.active && turnNav.offRoute && turnNav.lastPosition && turnNav.route?.coords?.length);
  if (kicker) kicker.textContent = info.kicker;
  if (bannerText) bannerText.textContent = info.headline;
  if (bannerMeta) bannerMeta.textContent = info.meta;
}

function speakNavigation(text) {
  if (!('speechSynthesis' in window)) {
    turnNav.message = 'Voice is unavailable in this browser';
    refreshNavigationUI();
    return;
  }
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    utterance.lang = navigator.language || 'en-US';
    window.speechSynthesis.speak(utterance);
  } catch (e) { /* the status line remains useful without speech */ }
}

async function requestNavigationWakeLock() {
  if (!turnNav.active || !navigator.wakeLock || document.visibilityState !== 'visible') return;
  try {
    turnNav.wakeLock = await navigator.wakeLock.request('screen');
    turnNav.wakeLock.addEventListener('release', () => {
      if (turnNav.active && document.visibilityState === 'visible') requestNavigationWakeLock();
    }, { once: true });
    turnNav.message = '';
  } catch (e) {
    turnNav.message = 'Screen may sleep on this browser';
  }
  refreshNavigationUI();
}

function releaseNavigationWakeLock() {
  const lock = turnNav.wakeLock;
  turnNav.wakeLock = null;
  if (lock) lock.release().catch(() => {});
}

function nearestNavigationPoint(lon, lat) {
  const route = turnNav.route;
  if (!route?.coords?.length) return null;
  const point = [lon, lat];
  const hasPosition = turnNav.routeM > 0 || turnNav.nearest > 0;
  let lo = hasPosition ? Math.max(0, turnNav.nearest - 80) : 0;
  let hi = hasPosition ? Math.min(route.coords.length - 1, turnNav.nearest + 500) : route.coords.length - 1;
  let best = lo, bestM = Infinity;
  for (let i = lo; i <= hi; i++) {
    const d = navDistanceM(point, route.coords[i]);
    if (d < bestM) { bestM = d; best = i; }
  }
  // If the rider has jumped well beyond the local search window (for example,
  // restarting navigation farther along the route), do one complete recovery scan.
  if (hasPosition && bestM > 250) {
    lo = 0; hi = route.coords.length - 1; bestM = Infinity;
    for (let i = lo; i <= hi; i++) {
      const d = navDistanceM(point, route.coords[i]);
      if (d < bestM) { bestM = d; best = i; }
    }
  }
  return { index: best, offRouteM: bestM, routeM: route.cumulative[best] };
}

function updateTurnNavigation(pos) {
  if (!turnNav.active || !turnNav.route) return;
  const { longitude, latitude } = pos.coords;
  turnNav.lastPosition = [longitude, latitude];
  if (!turnNav.marker) {
    turnNav.marker = new maplibregl.Marker({ color: '#00795c', scale: 0.75 })
      .setLngLat([longitude, latitude]).addTo(map);
  } else turnNav.marker.setLngLat([longitude, latitude]);

  // A reroute is already on its way to the worker. Ignore GPS fixes against
  // the old geometry until the replacement route arrives.
  if (turnNav.rejoinAwaiting) {
    refreshNavigationUI();
    return;
  }

  const nearest = nearestNavigationPoint(longitude, latitude);
  if (!nearest) return;
  turnNav.nearest = Math.max(turnNav.nearest, nearest.index);
  turnNav.routeM = Math.max(turnNav.routeM, nearest.routeM);
  if (nearest.offRouteM > 100) {
    const justLeftRoute = !turnNav.offRoute;
    if (justLeftRoute) {
      beginOffRouteTracking(pos, nearest);
      const target = offRouteReturnTarget();
      const startHint = turnNav.offRouteExit.routeM < 250
        ? ' If this is your actual location, move the route start to your current location.'
        : '';
      const autoHint = navigationOptions.autoReroute
        ? ' The route will update automatically in 60 seconds of moving time.'
        : ' You can tap Reroute to make a new route from here.';
      speakNavigation(`You are off route. Return to ${target}.${startHint}${autoHint}`);
      turnNav.offRouteSpokenAt = Date.now();
    } else {
      trackOffRouteMovingTime(pos);
    }
    if (navigationOptions.autoReroute && turnNav.offRouteMovingMs >= AUTO_REROUTE_AFTER_MS) {
      rerouteNavigation(true);
      return;
    }
    refreshNavigationUI();
    return;
  }
  clearOffRouteTracking();
  turnNav.message = '';
  const rejoinLegValue = Number(routing.last?.legs?.[0]?.distM);
  const rejoinLegM = Number.isFinite(rejoinLegValue) ? rejoinLegValue : Infinity;
  if (routing.navRejoin && !turnNav.rejoinAwaiting && turnNav.routeM >= rejoinLegM - 30) {
    routing.navRejoin = null;
  }
  const next = turnNav.route.instructions[turnNav.next];
  if (!next) {
    if (!turnNav.arrived && turnNav.route.totalM - turnNav.routeM < 55) {
      turnNav.arrived = true;
      turnNav.message = 'Arrived';
      speakNavigation('You have arrived at your destination.');
    }
    refreshNavigationUI();
    return;
  }
  const remaining = next.distanceM - turnNav.routeM;
  if (remaining < -35) {
    turnNav.next++;
    updateTurnNavigation(pos);
    return;
  }
  if (!next.approach && remaining <= 350) {
    next.approach = true;
    speakNavigation(`In ${navDistanceText(remaining)}, ${next.text.toLowerCase()}.`);
  }
  if (!next.now && remaining <= 70) {
    next.now = true;
    speakNavigation(`${next.text}.`);
  }
  refreshNavigationUI();
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
  if (!routing.last?.ok || routing.last.coords?.length < 2 || !navigator.geolocation) {
    setStatus('Set a route and allow location access to start navigation.', true);
    return;
  }
  turnNav.route = buildTurnInstructions(routing.last);
  turnNav.active = true;
  turnNav.next = 0;
  turnNav.nearest = 0;
  turnNav.routeM = 0;
  turnNav.arrived = false;
  turnNav.offRouteSpokenAt = 0;
  clearOffRouteTracking();
  turnNav.lastPosition = null;
  turnNav.rejoinAwaiting = false;
  turnNav.message = 'Getting your location';
  refreshNavigationUI();
  speakNavigation('Navigation started. Follow the route on the map.');
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

function remainingNavigationVias() {
  const legs = routing.last?.legs || [];
  const virtualLegs = routing.navRejoin ? 1 : 0;
  let distanceM = 0;
  for (let i = 0; i < virtualLegs; i++) distanceM += Number(legs[i]?.distM) || 0;
  let completed = 0;
  for (let i = 0; i < routing.vias.length; i++) {
    const legM = Number(legs[virtualLegs + i]?.distM);
    if (!Number.isFinite(legM)) break;
    distanceM += legM;
    if (turnNav.routeM >= distanceM - 30) completed++;
    else break;
  }
  for (const via of routing.vias.slice(0, completed)) via.marker.remove();
  return routing.vias.slice(completed);
}

function rerouteNavigation(automatic = false) {
  const position = turnNav.lastPosition;
  const rejoin = turnNav.route?.coords?.[turnNav.nearest];
  if (!turnNav.active || !position || !rejoin || !routing.end) {
    turnNav.message = 'Waiting for a GPS location to reroute';
    refreshNavigationUI();
    return;
  }
  routing.vias = remainingNavigationVias();
  routing.start = [...position];
  routing.navRejoin = [...rejoin];
  if (routing.startMarker) routing.startMarker.setLngLat({ lng: position[0], lat: position[1] });
  clearOffRouteTracking();
  turnNav.rejoinAwaiting = true;
  if (automatic) speakNavigation('Updating route.');
  turnNav.message = 'Updating route';
  setRouteStatus('Rerouting…');
  updateArmButtons();
  refreshNavigationUI();
  computeRoute();
}

function clearNavigationRejoin() {
  const hadRejoin = !!routing.navRejoin;
  routing.navRejoin = null;
  turnNav.rejoinAwaiting = false;
  return hadRejoin;
}

function stopTurnNavigation(announce = true) {
  const hadRejoin = clearNavigationRejoin();
  if (!turnNav.active) return hadRejoin;
  if (turnNav.watchId != null) navigator.geolocation?.clearWatch(turnNav.watchId);
  turnNav.watchId = null;
  releaseNavigationWakeLock();
  if (turnNav.marker) { turnNav.marker.remove(); turnNav.marker = null; }
  turnNav.active = false;
  turnNav.route = null;
  turnNav.message = '';
  clearOffRouteTracking();
  turnNav.lastPosition = null;
  turnNav.rejoinAwaiting = false;
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  if (announce) speakNavigation('Navigation stopped.');
  refreshNavigationUI();
  return hadRejoin;
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
  if (!m) {
    card.innerHTML = `<div id="routeControlsSlot"></div><div class="rc-empty">Use <b>Start</b> on the map bar to
      search for or tap your start point. Use <b>End</b> for the destination. Routes follow your
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
  const mtbNotice = stats.mtbM > 0
    ? `<div class="rc-warn rc-mtb">⚠ ${fmtDist(stats.mtbM)} on mountain-bike trail</div>`
    : '';
  card.innerHTML = `
    <div id="routeControlsSlot"></div>
    <div class="rc-summary-row"><div class="rc-main">${fmtMi(m.distM)} mi <small>· ${fmtDur(m.timeS)}</small></div></div>
    <div class="rc-sub">↗ ${fmtFt(m.ascentM)} ft climb · ↘ ${fmtFt(m.descentM)} ft descent${m.ferryM > 0 ? ` · ⛴ ${fmtMi(m.ferryM)} mi ferry` : ''}</div>
    <div class="rc-ride-mix" title="Percent of riding distance; colors match the map legend"><span class="rc-ride-label">Ride</span><span><span class="rc-mix-swatch" style="background:${BIKE_NETWORK_COLOR}"></span><b>${bikePct}</b> trails/lanes</span><i>·</i><span><span class="rc-mix-swatch" style="background:${COLORS[1]}"></span><b>${passPct}</b> pass</span><i>·</i><span class="${stats.levels[3] > 0 ? 'rc-ride-caution' : ''}"><span class="rc-mix-swatch" style="background:${COLORS[3]}"></span><b>${cautionPct}</b> caution</span><i>·</i><span class="${m.failM > 0 ? 'rc-ride-fail' : ''}"><span class="rc-mix-swatch" style="background:${COLORS[4]}"></span><b>${failPct}</b> fail</span></div>
    ${mtbNotice}<div class="rc-actions"><div id="routeDetailsSlot"></div></div>`;
  moveControls();
  moveDetails();
  refreshNavigationUI();
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
  const previous = routing.last?.optimization;
  const profileId = previous?.profileId || routing.profileId;
  const exact = profileId
    ? options.find((option) => option.optimization?.profileId === profileId)
    : null;
  if (exact || !previous) return exact || options[0];

  // A settings change can legitimately remove the old profile from the
  // portfolio. In that case, keep the closest search method and preferences
  // instead of falling all the way back to the newly recommended Route A.
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
  if (m.type === 'ready') {
    routing.ready = true;
    routing.loading = false;
    setRouteStatus(routing.start && routing.end ? 'Routing…' : '');
    if (!(routing.start && routing.end)) showRouteActionToast('');
    renderRouteCard(routing.last);
    computeRoute();
  } else if (m.type === 'route-options') {
    if (m.id !== routing.reqId) return;
    const remaining = 400 - (performance.now() - routing.compareStartedAt);
    if (!m.displayDelayApplied && remaining > 0) {
      setTimeout(() => onRouterMessage({ data: { ...m, displayDelayApplied: true } }), remaining);
      return;
    }
    document.body.dataset.routeOptionsMs = String(Math.round(Number(m.ms) || 0));
    setRouteOptionsLoading(false);
    if (!m.ok || !Array.isArray(m.options) || !m.options.length) {
      showRouteActionToast('Could not calculate that route', { duration: 2600 });
      routing.options = [];
      routing.navRejoin = null;
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
    const selected = refreshedRouteSelection(m.options);
    activateRouteOption(selected);
    notifySnapDistance(selected);
  } else if (m.type === 'route') {
    if (m.id !== routing.reqId) return; // stale reply
    setRouteOptionsLoading(false);
    if (!m.ok) {
      showRouteActionToast('Could not calculate that route', { duration: 2600 });
      routing.options = [];
      routing.last = m;
      renderRouteOptionControls();
      routing.navRejoin = null;
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
    ensureRouter();
    setRouteStatus('Loading routing data…');
    return;
  }
  routing.reqId++;
  setRouteStatus('Routing…');
  showRouteActionToast(routing.last?.ok ? 'Recalculating route…' : 'Calculating route options…',
    { busy: true, duration: 0 });
  setRouteOptionsLoading(true);
  saveStateSoon();
  const points = [routing.start, ...(routing.navRejoin ? [routing.navRejoin] : []),
    ...routing.vias.map((v) => v.pt), routing.end];
  const selected = routing.last?.optimization;
  if (turnNav.active || routing.navRejoin) {
    routing.worker.postMessage({
      type: 'route', id: routing.reqId, points, rules: { ...rules },
      mode: selected?.mode || routing.mode,
      profileId: selected?.profileId || routing.profileId,
      profileLabel: selected?.label,
      prefDesignated: routing.prefDesig || !!selected?.prefDesignated,
      prefResidential: routing.prefResidential || !!selected?.prefResidential,
      weights: { ...routingWeights },
    });
  } else {
    routing.compareStartedAt = performance.now();
    routing.worker.postMessage({
      type: 'route-options', id: routing.reqId, points, rules: { ...rules },
      forceDesignated: routing.prefDesig,
      forceResidential: routing.prefResidential,
      preferredProfileId: routing.profileId,
      weights: { ...routingWeights },
    });
  }
}

// Pseudo-source for tapping the route line itself: segments carry their graph
// attributes, so the route is inspectable even with every data layer off.
const ROUTESEG_SRC = { id: 'routeseg', name: 'Your route', scorer: scoreRouteSeg };
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
  return {
    baseScore: facility >= 4 || p.infra === 1 ? 1 : facility >= 2 ? 2 : null,
    shoulder_width: p.sh >= 0 ? p.sh : null,
    maxspeed_num: p.ferry ? null : p.mph,
    prohibited: false, restricted: false,
    freeway: p.fw === 1,
    limited_access: p.lim === 1 || p.fw === 1,
    good_facility: facility >= 2,
    infra: p.infra === 1 || facility >= 4,
    est: p.e === 1,
    desig: p.desig === 1,
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
  if (effectiveLevel(scoreRouteSeg(p)) === 4) return 'fail';
  if (p.level === 3) return 'caution';
  if (p.level === 0) return 'unknown';
  const bike = p.infra === 1 || p.facility >= 2;
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
      hazard: s.hazard || 0, gradePct: s.gradePct || 0,
      infra: s.flags & 8 ? 1 : 0, ferry: s.flags & 32 ? 1 : 0, desig: s.flags & 64 ? 1 : 0,
      facility: s.facility || 0, official: s.official || 0, mtb: s.mtb ? 1 : 0,
      roadClass: s.roadClass || 0,
      routeIndex,
      level: s.level ?? fallbackRouteLevel(s), hwy: isHighwaySegment(s) ? 1 : 0 },
    geometry: { type: 'LineString', coordinates: coords.slice(s.c0, s.c1 + 1) },
  })) };
  const renderData = buildRouteRenderData(sdata);
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
    map.getSource('route-highlight-marker').setData(emptyHighlights);
    map.getSource('route-detail-marker').setData(emptyHighlights);
    map.getSource('route-detail-selection').setData(emptyLine);
    setFailPulse(failData.features.length > 0);
    applyDisplayModeAll();
    return;
  }
  map.addSource('route', { type: 'geojson', data });
  map.addSource('route-ferry', { type: 'geojson', data: fdata });
  map.addSource('route-seg', { type: 'geojson', data: sdata });
  map.addSource('route-render', { type: 'geojson', data: renderData });
  map.addSource('route-fail', { type: 'geojson', data: failData });
  map.addSource('route-highlight-marker', { type: 'geojson', data: emptyHighlights });
  map.addSource('route-detail-marker', { type: 'geojson', data: emptyHighlights });
  map.addSource('route-detail-selection', { type: 'geojson', data: emptyLine });
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
  map.addLayer({
    id: 'route-ferry', type: 'line', source: 'route-ferry',
    paint: { 'line-color': '#ffffff', 'line-width': 5, 'line-opacity': 0.9,
             'line-dasharray': [0.6, 1.8] },
  });
  setFailPulse(failData.features.length > 0);
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
  if (key === 'bike-network') return !!(flags & (8 | 64)) || (seg.facility || 0) >= 2;
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
  if (mobileNavMedia.matches) setPanelOpen(false);
  if (!selected.length) return;
  requestAnimationFrame(() => {
    if (selected.length === 1) {
      map.easeTo({ center: selected[0], zoom: Math.max(map.getZoom(), 15), duration: 450 });
      return;
    }
    const bounds = new maplibregl.LngLatBounds(selected[0], selected[0]);
    for (const coordinate of selected.slice(1)) bounds.extend(coordinate);
    map.fitBounds(bounds, {
      padding: mobileNavMedia.matches
        ? { top: 90, right: 45, bottom: 90, left: 45 }
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

function setRoutePoint(kind, lngLat) {
  clearNavigationRejoin();
  routing[kind] = [lngLat.lng, lngLat.lat];
  const mk = kind + 'Marker';
  if (routing[mk]) routing[mk].setLngLat(lngLat);
  else {
    const touchEndpoint = window.matchMedia('(pointer: coarse)').matches;
    routing[mk] = new maplibregl.Marker({
      color: kind === 'start' ? '#0072B2' : '#D55E00', draggable: !touchEndpoint,
    }).setLngLat(lngLat).addTo(map);
    if (touchEndpoint) enableLongPressEndpointMove(kind, routing[mk]);
    else routing[mk].on('dragend', () => {
        clearNavigationRejoin();
        const ll = routing[mk].getLngLat();
        routing[kind] = [ll.lng, ll.lat];
        computeRoute();
      });
  }
  computeRoute();
  updateArmButtons();
}

function advanceToEndAfterStart(kind) {
  if (kind !== 'start' || routing.end) return false;
  routing.arm = 'end';
  suppressRoadInfo();
  updateArmButtons();
  setRouteStatus('Start set — tap the map or choose End to search');
  return true;
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
      clearNavigationRejoin();
      const ll = marker.getLngLat();
      routing[kind] = [ll.lng, ll.lat];
      setRouteStatus(`${kind === 'start' ? 'Start' : 'Destination'} moved`);
      computeRoute();
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

function addVia(lngLat, { allowPastLimit = false } = {}) {
  if (!allowPastLimit && routing.vias.length >= MAX_ROUTE_STOPS) {
    routing.arm = null;
    updateArmButtons();
    setRouteStatus(`A route can have up to ${MAX_ROUTE_STOPS} stops`);
    return false;
  }
  clearNavigationRejoin();
  const marker = new maplibregl.Marker({ color: '#555555', draggable: true, scale: 0.85 })
    .setLngLat(lngLat).addTo(map);
  const via = { pt: [lngLat.lng, lngLat.lat], marker };
  routing.vias.push(via);
  marker.on('dragend', () => {
    clearNavigationRejoin();
    const ll = marker.getLngLat();
    via.pt = [ll.lng, ll.lat];
    computeRoute();
  });
  computeRoute();
  updateArmButtons();
  return true;
}

function removeLastVia() {
  clearNavigationRejoin();
  const via = routing.vias.pop();
  if (!via) { showRouteActionToast('No added stops to remove'); return; }
  via.marker.remove();
  if (routing.arm === 'via') routing.arm = null;
  updateArmButtons();
  computeRoute();
  showRouteActionToast('Last stop removed · recalculating…', { busy: true, duration: 0 });
  saveStateSoon();
}

function reverseRoute() {
  if (!(routing.start && routing.end)) return;
  stopTurnNavigation(false);
  routing.arm = null;
  routing.navRejoin = null;
  closePlacePicker(false);

  const start = routing.start;
  routing.start = routing.end;
  routing.end = start;
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
  showRouteActionToast('');
  stopTurnNavigation(false);
  routing.arm = null;
  closePlacePicker(false);
  routing.start = routing.end = null;
  routing.navRejoin = null;
  routing.reqId++; // a route already being calculated must not reappear after clear
  for (const v of routing.vias) v.marker.remove();
  routing.vias = [];
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
  if (!routing.start && !routing.end && routing.vias.length === 0) return;
  const dialog = document.getElementById('clearRouteDialog');
  if (dialog && !dialog.open) dialog.showModal();
}

function updateArmButtons() {
  for (const kind of ['start', 'end', 'via']) {
    for (const prefix of ['rt-', 'rb-']) {
      const b = document.getElementById(prefix + kind);
      if (b) b.classList.toggle('active', routing.arm === kind);
    }
  }
  const add = document.getElementById('rb-via');
  const remove = document.getElementById('rb-via-remove');
  const reverse = document.getElementById('rb-reverse');
  if (add) {
    add.disabled = !(routing.start && routing.end) || routing.vias.length >= MAX_ROUTE_STOPS;
    add.title = routing.vias.length >= MAX_ROUTE_STOPS
      ? `Maximum of ${MAX_ROUTE_STOPS} stops reached` : 'Add a stop';
  }
  if (remove) remove.disabled = routing.vias.length === 0;
  if (reverse) reverse.disabled = !(routing.start && routing.end);
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
    button.disabled = turnNav.active || busy;
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
  host.innerHTML = routing.options.map((option, index) => {
    const optimization = option.optimization || {};
    const label = optimization.label || `Option ${index + 1}`;
    const only = routing.options.length === 1;
    const shortLabel = /^Route [A-Z]$/.test(label)
      ? (only ? `${label.slice(-1)} (Only route)` : label.slice(-1))
      : label;
    const active = option === routing.last;
    return `<button type="button" data-route-option="${index}" ${active ? 'class="active"' : ''}
      aria-pressed="${active}" aria-label="Choose route ${index + 1}: ${label}"
      title="${optimizationDescription(optimization)}" ${turnNav.active ? 'disabled' : ''}>
      <span>${shortLabel}</span></button>`;
  }).join('');
}

function activateRouteOption(option, updateNavigation = false) {
  if (!option?.ok) return;
  showRouteActionToast('');
  routing.last = option;
  if (option.optimization) {
    routing.profileId = option.optimization.profileId || routing.profileId;
    routing.mode = option.optimization.mode || routing.mode;
  }
  if (updateNavigation && turnNav.active) {
    turnNav.route = buildTurnInstructions(option);
    turnNav.next = 0;
    turnNav.nearest = 0;
    turnNav.routeM = 0;
    turnNav.arrived = false;
    clearOffRouteTracking();
    turnNav.rejoinAwaiting = false;
    turnNav.message = 'Route updated';
  }
  renderRouteOptionControls();
  renderRouteCard(option);
  storeRouteDetails(option);
  drawRoute(option.coords, option.ferrySegs, option.segs);
  consumePendingRouteStepHighlight();
  setRouteStatus(`${fmtMi(option.distM)} mi · ${option.optimization?.label || 'route choice'}`);
  saveStateSoon();
}

function buildRoutingPanel() {
  const choices = document.getElementById('routeOptions');
  choices.addEventListener('click', (event) => {
    const button = event.target.closest('[data-route-option]');
    if (!button || button.disabled || turnNav.active || choices.classList.contains('loading')) return;
    clearNavigationRejoin();
    const option = routing.options[Number(button.dataset.routeOption)];
    if (option && option !== routing.last) activateRouteOption(option);
  });
  renderRouteOptionControls();

  document.getElementById('routeDetailsBtn').addEventListener('click', openRouteDetails);
  document.getElementById('routeTipsBtn').addEventListener('click', openRouteTips);

  renderRouteCard(null);

  for (const kind of ['start', 'end']) {
    document.getElementById('rb-' + kind).addEventListener('click', () => openPlacePicker(kind));
  }
  document.getElementById('rb-via').addEventListener('click', () => openPlacePicker('via'));
  document.getElementById('rb-via-remove').addEventListener('click', removeLastVia);
  document.getElementById('rb-reverse').addEventListener('click', reverseRoute);
  document.getElementById('navStartButton').addEventListener('click', () => {
    if (turnNav.active) {
      const routeChanged = stopTurnNavigation();
      if (routeChanged) computeRoute();
    }
    else startTurnNavigation();
  });
  document.getElementById('rb-clear').addEventListener('click', requestClearRoute);
  document.getElementById('navBanner').addEventListener('click', (e) => {
    const action = e.target.closest('[data-nav-action]')?.dataset.navAction;
    if (action === 'reroute') rerouteNavigation();
  });
  document.getElementById('confirmClearRoute').addEventListener('click', () => {
    document.getElementById('clearRouteDialog').close();
    clearRoute();
  });
  updateArmButtons();
  buildPlacePicker();
  buildSavedRoutes();

  // A shared link wins over the receiver's locally persisted route.
  if (sharedRoute) {
    const rt = sharedRoute.route;
    setRoutePoint('start', { lng: rt.s[0], lat: rt.s[1] });
    for (const p of rt.v || []) addVia({ lng: p[0], lat: p[1] });
    setRoutePoint('end', { lng: rt.e[0], lat: rt.e[1] });
    fitRouteBounds(rt);
    setStatus('Shared route loaded');
    // The route is now persisted like any other plan. Removing the consumed
    // token prevents Clear/Edit + refresh from resurrecting the original link.
    saveStateSoon();
    if (saveStateNow()) consumeSharedRouteHash();
  } else if (savedState && normalizeStoredRoute(savedState.route)) {
    const rt = normalizeStoredRoute(savedState.route);
    setRoutePoint('start', { lng: rt.s[0], lat: rt.s[1] });
    for (const p of rt.v || []) addVia({ lng: p[0], lat: p[1] }, { allowPastLimit: true });
    setRoutePoint('end', { lng: rt.e[0], lat: rt.e[1] });
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
    x: routing.vias.map((via) => point(via.pt)),
    m: routing.mode,
    o: routing.profileId,
    p: routing.prefDesig,
    q: routing.prefResidential,
    r: { ...rules },
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
  const lons = [route.s[0], route.e[0], ...(route.v || []).map((p) => p[0])];
  const lats = [route.s[1], route.e[1], ...(route.v || []).map((p) => p[1])];
  map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
    { padding: 60, maxZoom: 13 });
}

function loadSharedRouteIntoPlanner(shared) {
  if (!shared || !shared.route) return false;
  clearRoute();
  Object.assign(rules, shared.rules || {});
  buildRulesPanel();
  rescoreAll();
  if (shared.mode) routing.mode = shared.mode;
  routing.profileId = shared.profileId || legacyRouteProfile(shared.mode || routing.mode);
  if (shared.prefDesig != null) routing.prefDesig = shared.prefDesig;
  if (shared.prefResidential != null) routing.prefResidential = shared.prefResidential;
  renderRouteOptionControls();
  syncRoutePreferenceControls();
  const route = shared.route;
  setRoutePoint('start', { lng: route.s[0], lat: route.s[1] });
  for (const p of route.v || []) addVia({ lng: p[0], lat: p[1] });
  setRoutePoint('end', { lng: route.e[0], lat: route.e[1] });
  fitRouteBounds(route);
  saveStateSoon();
  return true;
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
        setRoutePoint('start', { lng: currentRoute.s[0], lat: currentRoute.s[1] });
        for (const point of currentRoute.v) addVia(
          { lng: point[0], lat: point[1] }, { allowPastLimit: true });
        setRoutePoint('end', { lng: currentRoute.e[0], lat: currentRoute.e[1] });
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
        title: 'Washington bike route',
        text: 'Open this bike route in Washington Bike Safety Visualizer.',
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
      importStatus.textContent = 'That does not look like a valid shared BikeSafety route link.';
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
      v: routing.vias.map((x) => x.pt), mode: routing.mode, profileId: routing.profileId,
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
const onlinePlaceCache = new Map();
let onlinePlaceLastRequestAt = 0;
const ONLINE_PLACE_SEARCH_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const ONLINE_PLACE_SEARCH_MIN_INTERVAL_MS = 1100;

async function searchOnlinePlaces(query) {
  const normalized = query.trim().replace(/\s+/g, ' ').toLowerCase();
  if (normalized.length < 2) return [];
  if (onlinePlaceCache.has(normalized)) return onlinePlaceCache.get(normalized);
  if (navigator.onLine === false) throw new Error('offline');

  const waitMs = Math.max(0, ONLINE_PLACE_SEARCH_MIN_INTERVAL_MS - (Date.now() - onlinePlaceLastRequestAt));
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  onlinePlaceLastRequestAt = Date.now();

  const url = new URL(ONLINE_PLACE_SEARCH_ENDPOINT);
  url.search = new URLSearchParams({
    format: 'jsonv2', q: query.trim(), limit: '5', countrycodes: 'us', addressdetails: '0',
    // This router only contains Washington. Out-of-state search hits can
    // never produce a route, so constrain results to the graph's coverage.
    viewbox: '-124.9,49.1,-116.8,45.5', bounded: '1',
  });
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`search failed (${response.status})`);
  const data = await response.json();
  const matches = (Array.isArray(data) ? data : [])
    .map((item) => ({
      name: String(item.display_name || '').trim().slice(0, 180),
      lon: Number(item.lon), lat: Number(item.lat), source: 'online',
    }))
    .filter((item) => item.name && Number.isFinite(item.lon) && Number.isFinite(item.lat));
  if (onlinePlaceCache.size >= 50) onlinePlaceCache.delete(onlinePlaceCache.keys().next().value);
  onlinePlaceCache.set(normalized, matches);
  return matches;
}

function closePlacePicker(cancelArm = false) {
  placeSearchRequestId++;
  const picker = document.getElementById('placePicker');
  if (document.activeElement && picker.contains(document.activeElement)) document.activeElement.blur();
  picker.hidden = true;
  document.getElementById('placeResults').replaceChildren();
  document.getElementById('placeResults').classList.remove('show');
  if (cancelArm && (routing.arm === 'start' || routing.arm === 'end' || routing.arm === 'via')) {
    routing.arm = null;
    updateArmButtons();
    setRouteStatus('');
  }
}

function openPlacePicker(kind) {
  if (kind === 'via' && (!(routing.start && routing.end) || routing.vias.length >= MAX_ROUTE_STOPS)) return;
  setLegendOpen(false);
  placeTarget = kind;
  routing.arm = kind;
  suppressRoadInfo();
  updateArmButtons();
  ensureRouter();
  setPanelOpen(false);
  document.getElementById('placePickerTitle').textContent =
    (kind === 'start' ? 'Set start' : kind === 'via' ? 'Add a stop' : 'Set destination') + ' — tap map or search';
  document.getElementById('useLoc').hidden = kind !== 'start';
  const onlineButton = document.getElementById('onlinePlaceSearch');
  onlineButton.disabled = false;
  onlineButton.textContent = '⌕';
  document.getElementById('placeSearch').value = '';
  document.getElementById('placeResults').replaceChildren();
  document.getElementById('placeResults').classList.remove('show');
  document.getElementById('placePicker').hidden = false;
  setRouteStatus(kind === 'via' ? 'Tap the map or search to add a STOP'
    : `Tap the map or search to set the ${kind === 'start' ? 'START' : 'DESTINATION'}`);
}

function armRoutePoint(kind) {
  if (kind === 'via' && !(routing.start && routing.end)) return;
  if (kind === 'via' && routing.vias.length >= MAX_ROUTE_STOPS) {
    setRouteStatus(`A route can have up to ${MAX_ROUTE_STOPS} stops`);
    return;
  }
  closePlacePicker(false);
  routing.arm = routing.arm === kind ? null : kind;
  if (routing.arm) suppressRoadInfo();
  updateArmButtons();
  ensureRouter();
  if (routing.arm) {
    setPanelOpen(false);
    setRouteStatus(kind === 'via' ? 'Tap the map to add a stop'
      : `Tap the map to set the ${kind === 'start' ? 'START' : 'DESTINATION'}`);
    if (kind === 'via') showRouteActionToast('Tap the map to add a stop', { duration: 3200 });
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

  const render = (items) => {
    results.replaceChildren();
    for (const item of items) {
      const hit = document.createElement('button');
      hit.className = 'place-hit';
      hit.dataset.lon = String(item.lon);
      hit.dataset.lat = String(item.lat);
      hit.append(document.createTextNode(item.name + ' '));
      const detail = document.createElement('small');
      detail.textContent = item.source === 'online'
        ? 'online · OpenStreetMap'
        : (TYPE_LABEL[item.type] || item.type || 'place');
      hit.append(detail);
      results.append(hit);
    }
    results.classList.toggle('show', items.length > 0);
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
    onlineButton.textContent = '…';
    showLocalMatches();
    try {
      const onlineMatches = await searchOnlinePlaces(query);
      if (requestId !== placeSearchRequestId || input.value.trim() !== query) return;
      render([...onlineMatches, ...localMatches()]);
      if (!onlineMatches.length) setRouteStatus('No online matches — local search is still available');
    } catch (e) {
      if (requestId === placeSearchRequestId) {
        showLocalMatches();
        setRouteStatus('Online search unavailable — showing local places');
      }
    } finally {
      if (requestId === placeSearchRequestId) {
        onlineButton.disabled = false;
        onlineButton.textContent = '⌕';
      }
    }
  };

  input.addEventListener('focus', ensurePlaces);
  input.addEventListener('input', () => {
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
    map.flyTo({ center: [lngLat.lng, lngLat.lat], zoom: 13 });
    if (placeTarget === 'via') addVia(lngLat);
    else setRoutePoint(placeTarget, lngLat);
    routing.arm = null;
    updateArmButtons();
    if (placeTarget === 'via') {
      setRouteStatus('Stop added');
      showRouteActionToast('Stop added — route recalculating', { duration: 2200 });
    } else if (!advanceToEndAfterStart(placeTarget)) {
      setRouteStatus(placeTarget === 'start' ? 'Start set' : 'Destination set');
    }
    closePlacePicker(false);
    input.value = '';
    render([]);
  });

  document.getElementById('placePickerClose').addEventListener('click', () => closePlacePicker(true));
  document.getElementById('useLoc').addEventListener('click', () => {
    if (!navigator.geolocation) { setStatus('No location access on this device', true); return; }
    setRouteStatus('Locating…');
    navigator.geolocation.getCurrentPosition((pos) => {
      const lngLat = { lng: pos.coords.longitude, lat: pos.coords.latitude };
      setRoutePoint(placeTarget, lngLat);
      map.flyTo({ center: [lngLat.lng, lngLat.lat], zoom: 13 });
      routing.arm = null;
      updateArmButtons();
      closePlacePicker(false);
      if (!advanceToEndAfterStart(placeTarget)) setRouteStatus(placeTarget === 'start' ? 'Start set to your location' : 'Destination set');
    }, () => setRouteStatus('Could not get your location'), { enableHighAccuracy: true, timeout: 10000 });
  });
}

/* ---------------------------------------------- hover/click readout */
const readoutEl = document.getElementById('readout');
// The road card repeats the one shared map/route verdict vocabulary.
function readoutVerdict(n, level) {
  if (level === 4) return 'Red dashed — Fails your rules';
  if (level === 3) return 'Muted purple — Caution (limited-access highway)';
  if (level === 0) return 'Gray — Insufficient data';
  if (isBikeNetworkVerdict(n)) return 'Lime — Bike network; passes your rules';
  if (n.desig) return 'Blue dashed — Designated bike route; passes your rules';
  return 'Blue — Passes your rules';
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
  if (p.infra || p.ferry || p.facility >= 2 || !p.roadClass) return null;
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
  if (n.prohibited)
    return n.wsdotBan
      ? 'Bikes prohibited — WSDOT permanent restriction.'
      : 'Bikes prohibited — OSM-tagged (bicycle=no/dismount).';
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
  if (!speedFails && spd != null && spd <= rules.freeMaxSpeed)
    return n.limited_access
      ? `${spdTxt} — meets your speed/shoulder rules, but this is a limited-access highway (caution).`
      : `${spdTxt} — at or below your ${rules.freeMaxSpeed} mph no-shoulder limit, passes without a shoulder.`;

  if (!speedFails && n.desig && rules.vettedBikeRoutes)
    return n.limited_access
      ? 'On a designated bike route, but it is also a limited-access highway (caution).'
      : 'On a designated bike route (USBR / regional trail) — a vetted corridor, treated as meeting your criteria.';

  const shoulderFails = !n.good_facility && sh != null && sh < rules.minShoulder;
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
  return `Passes your rules — ${met.join(', ')}.`;
}

const HIT_LAYERS = [];  // hit-layer ids, registered as sources attach
const HIT_SRC = {};     // hit-layer id -> its source
// Clicking/tapping PINS the readout (so its links are clickable); hovering
// only previews and never replaces a pinned readout.
let readoutPinned = false;
let roadInfoSuppressedUntil = 0;

function suppressRoadInfo(ms = 1200) {
  roadInfoSuppressedUntil = Math.max(roadInfoSuppressedUntil, Date.now() + ms);
  readoutPinned = false;
  readoutEl.classList.remove('show');
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

function renderReadout(feature, lngLat) {
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
      rows = [
        ['Name', p.name || '(unnamed road)'],
        ...common,
        ['Speed limit', p.mph != null && !p.infra ? `${p.mph} mph${p.e ? ' (estimated from class)' : ''}` : null],
        ['Speed source', p.official & 1 ? 'WSDOT legal speed' : null],
        ['Shoulder', p.sh >= 0 ? `${p.sh} ft` : null],
        ['Bike facility', FACILITY_NAME[p.facility] || null],
        ['Facility source', p.official & 2 ? 'WSDOT Active Transportation Data' : null],
        ['Road class', ROAD_CLASS_NAME[p.roadClass] || null],
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
      ['Bike facility', p.BikeFacilityType],
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
  // Maps URLs need no API key. Street View opens the panorama nearest the
  // tapped coordinates; Google Maps falls back gracefully where coverage is
  // unavailable.
  const streetView = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${
    lngLat.lat.toFixed(6)},${lngLat.lng.toFixed(6)}`;
  readoutEl.replaceChildren();
  const close = document.createElement('button');
  close.className = 'readout-close';
  close.setAttribute('aria-label', 'Close road information');
  close.textContent = '✕';
  const heading = document.createElement('div');
  heading.className = 'rt-title';
  heading.textContent = title;
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
  const streetViewLink = document.createElement('a');
  streetViewLink.className = 'gmap';
  streetViewLink.href = streetView;
  streetViewLink.target = '_blank';
  streetViewLink.rel = 'noopener';
  streetViewLink.textContent = 'Open Street View ↗';
  readoutEl.append(close, heading, table, streetViewLink);
  readoutEl.classList.add('show');
}

readoutEl.addEventListener('click', (e) => {
  if (!e.target.closest('.readout-close')) return;
  readoutPinned = false;
  readoutEl.classList.remove('show');
});

// ONE global handler pair (per-layer handlers raced where layers overlap).
map.on('mousemove', (e) => {
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
      ? `Stop added — maximum of ${MAX_ROUTE_STOPS} reached`
      : 'Stop added — tap + to add another');
    return true;
  }
  setRoutePoint(kind, lngLat);
  if (advanceToEndAfterStart(kind)) return true;
  if (!(routing.start && routing.end)) {
    // confirm the placement; with only one point there's no route yet
    setRouteStatus(kind === 'start' ? 'Start set — now set the destination'
      : 'Destination set — now set the start');
  }
  return true;
}

// Robust armed-tap on touch devices: a tap during map momentum doesn't always
// produce a MapLibre 'click', so track touches on the canvas directly and
// place the point on any short, still touch while armed.
(() => {
  const canvas = map.getCanvasContainer();
  let t0 = null;
  canvas.addEventListener('touchstart', (e) => {
    if (!routing.arm || e.touches.length !== 1) { t0 = null; return; }
    const t = e.touches[0];
    t0 = { x: t.clientX, y: t.clientY, ts: Date.now() };
  }, { passive: true });
  canvas.addEventListener('touchend', (e) => {
    if (!routing.arm || !t0) return;
    const t = e.changedTouches[0];
    const moved = Math.hypot(t.clientX - t0.x, t.clientY - t0.y);
    const dur = Date.now() - t0.ts;
    t0 = null;
    if (moved < 12 && dur < 700) {
      // Consume the placement tap. Otherwise iOS/MapLibre can emit a later
      // synthetic click that opens the road-information card underneath it.
      e.preventDefault();
      e.stopPropagation();
      const rect = map.getCanvas().getBoundingClientRect();
      const lngLat = map.unproject([t.clientX - rect.left, t.clientY - rect.top]);
      placeArmedPoint(lngLat);
    }
  }, { passive: false });
})();

map.on('click', (e) => {
  if (routing.arm) {
    placeArmedPoint(e.lngLat);
    return;
  }
  if (Date.now() < roadInfoSuppressedUntil || Date.now() - lastPlacementTs < 600) return;
  const f = featureAt(e.point);
  if (f) {
    if (window.matchMedia('(max-width: 720px)').matches) setPanelOpen(false);
    renderReadout(f, e.lngLat);
    readoutPinned = true;
  } else {
    readoutPinned = false;
    readoutEl.classList.remove('show');
  }
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
    ['Speed with shoulder', presetRules.noUpperLimit ? 'No speed limit.' : `Up to ${presetRules.upperMaxSpeed} mph.`],
    ['Speed without shoulder', `Up to ${presetRules.freeMaxSpeed} mph.`],
    ['Minimum shoulder', `${presetRules.minShoulder} ft on faster roads.`],
    ['Designated bike routes', presetRules.vettedBikeRoutes
      ? 'Assumed safe.' : 'Must meet the normal speed and shoulder rules.'],
    ['Freeways', presetRules.allowFreeways
      ? 'Bike-legal segments may be used only as a last resort.' : 'Not used.'],
    ['Rule matching', presetRules.requireSafe
      ? 'Required, except short access blocks (~1,000 ft) at your start, stops, and destination; no route is shown otherwise.'
      : 'Not required; a route may include rule-failing segments to complete it.'],
    ['Unknown shoulder', presetRules.unknownShoulderZero ? 'Treated as 0 ft.' : 'Left as unknown.'],
    ['Mountain-bike trails', presetRules.allowMtbTrails ? 'Available with a strong penalty.' : 'Not used.'],
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
  clearNavigationRejoin();
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
    clearNavigationRejoin();
    saveStateSoon();
    computeRoute();
  };
  check('prefDesig', 'Prefer bike routes & trails', routing, updateRoutePreference);
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
  check('requireSafe', 'Require fully-safe routes');
  check('autoReroute', 'Auto-reroute when off route', navigationOptions, () => {
    saveStateSoon();
    refreshNavigationUI();
  });
  check('unknownShoulderZero', 'Unknown shoulder = 0 ft');
  slider('minShoulder', 'Minimum shoulder', 0, 10, 1, ' ft');
  slider('freeMaxSpeed', 'Max speed without shoulder', 15, 45, 5, ' mph');

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
      <input type="range" id="r-upperMaxSpeed" min="35" max="${NONE_AT}" step="5" value="${cur}">`;
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
    paneButtons.forEach((button) => {
      button.addEventListener('click', () => selectSettingsPane(button.dataset.settingsPane));
      button.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const current = paneButtons.indexOf(button);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? paneButtons.length - 1
          : (current + (event.key === 'ArrowRight' ? 1 : -1) + paneButtons.length) % paneButtons.length;
        paneButtons[next].focus();
        selectSettingsPane(paneButtons[next].dataset.settingsPane);
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

function buildLegend() {
  const host = document.getElementById('legend');
  host.innerHTML = '';
  const dash = (c) => `background:repeating-linear-gradient(90deg,${c} 0 4px,transparent 4px 8px)`;
  const trail = `background-color:${BIKE_NETWORK_COLOR};background-image:radial-gradient(circle,#687d00 0 1.2px,transparent 1.45px);background-size:7px 6px;background-repeat:repeat-x;background-position:center`;
  const rows = [
    [BIKE_NETWORK_COLOR, 'Bike trails & lanes'],
    ['trail', 'Off-street trails'],
    ['dashDesig', 'Designated bike route'],
    [COLORS[1], 'Meets safety rules'],
    [COLORS[3], 'Caution — limited-access highway'],
    ['dash4', 'Fails safety rules'],
    ['ferry', 'Ferry crossing (planned route)'],
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
buildRoutingPanel();
buildLegend();

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
  readoutPinned = false;
  readoutEl.classList.remove('show');
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
