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

const APP_VERSION = '2026-07-12.81'; // shown in the map corner; bump per release
// Increment whenever router-worker.js changes the binary graph contract. It
// keeps a just-updated worker from receiving a graph cached by an older
// service worker during the first post-update load.
const GRAPH_FORMAT_VERSION = 'bgr4';

/* ---------------------------------------------------------------- palette */
// Blue -> red diverging (ColorBrewer RdYlBu, 4-class). Distinguishable across
// the common types of color vision deficiency because it avoids green and
// varies in lightness as well as hue. 1 = safest .. 4 = avoid, 0 = unknown.
const COLORS = {
  1: '#2c7bb6', // blue
  2: '#74add1', // medium blue (kept dark enough to read on the light basemap)
  3: '#f46d43', // orange
  4: '#d7191c', // red
  0: '#999999', // unknown / no data
};
const LEGEND = [
  [1, 'Comfortable'],
  [2, 'Meets your criteria'],
  [3, 'Caution — limited-access highway'],
  [4, 'Fails / bikes prohibited (avoid)'],
  [0, 'Unknown / no data'],
];

/* ------------------------------------------------- riding-rules state */
const rules = {
  allowFreeways: true,  // only permit heavily penalized freeway fallback?
  minShoulder: 4,       // ft; below this a road gets penalized
  unknownShoulderZero: true, // pessimistic: no shoulder data = 0 ft (fast roads must PROVE a shoulder)
  freeMaxSpeed: 35,     // mph; at/below this a road passes even without a shoulder
  upperMaxSpeed: 45,    // mph; above this it's high-stress unless shoulder/facility is adequate
  noUpperLimit: true,   // disable the upper-speed hard cap
  requireSafe: false,   // error out instead of returning a route with failing roads
};

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
  const bikeish = hw === 'cycleway' || hw === 'path' || hw === 'bridleway' || hw === 'track' || cw != null;
  let base = null;
  let prohibited = false;
  if (hw === 'cycleway' && bike !== 'no' && bike !== 'dismount') base = 1;
  else if (hw === 'path' && (bike === 'designated' || bike === 'yes')) base = 1;
  else if (hw === 'footway' && bike === 'designated') base = 2;
  else if (hw === 'bridleway' && (bike === 'designated' || bike === 'yes')) base = 2;
  else if (hw === 'track' && (bike === 'designated' || bike === 'yes')) base = 2;
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
  // Pessimistic option: an unknown shoulder counts as 0 ft, so fast roads must
  // PROVE an adequate shoulder to pass. Slow roads are unaffected (free-speed
  // rule below fires first) and so are roads with a bike facility.
  const sh = n.shoulder_width == null && rules.unknownShoulderZero ? 0 : n.shoulder_width;

  // Slow enough → comfortable regardless of shoulder.
  if (spd != null && spd <= rules.freeMaxSpeed) return n.limited_access ? 3 : 1;

  // Designated bike route (USBR / regional trail): a vetted corridor is a
  // known quantity — meets criteria regardless of shoulder/speed data.
  // (Freeway and prohibition gates above still apply.)
  if (n.desig) return n.limited_access ? 3 : 2;

  // Hard gates. Each fails ONLY when we have data proving the violation
  // (with the pessimistic option, "unknown = 0 ft" counts as data).
  const shoulderFails = !n.good_facility && sh != null && sh < rules.minShoulder;
  const speedFails = !rules.noUpperLimit && spd != null && spd > rules.upperMaxSpeed;
  if (shoulderFails || speedFails) return 4;

  // No usable data on any criterion → unknown.
  if (spd == null && sh == null && !n.good_facility) return 0;

  return n.limited_access ? 3 : 2; // caution, or meets your criteria
}

/* ------------------------------------------------ data-source registry */
// zRank controls draw order: higher ranks render on top of lower ones.
const SOURCES = [
  {
    id: 'routes',
    name: 'Designated routes (USBR & trails)',
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
  cases.push(['<=', spd, rules.freeMaxSpeed], 1);               // slow = comfortable
  cases.push(['==', ['get', 'g'], 1], 2);                       // designated route = vetted
  // Shoulder gate: pessimistic mode treats a missing shoulder as 0 ft;
  // otherwise only a known-narrow shoulder fails.
  const sh = rules.unknownShoulderZero
    ? ['coalesce', ['get', 'w'], 0]
    : ['case', ['has', 'w'], ['get', 'w'], rules.minShoulder]; // unknown -> never under
  cases.push(['all', ['!=', ['get', 'f'], 1], ['<', sh, rules.minShoulder]], 4);
  if (!rules.noUpperLimit) cases.push(['>', spd, rules.upperMaxSpeed], 4); // speed cap
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
  if (savedState.rules) Object.assign(rules, savedState.rules);
  if (typeof savedState.passFail === 'boolean') display.passFail = savedState.passFail;
}

// Navigation choices are local device preferences, not part of a shared route.
// Keep automatic recovery on by default, while still letting a rider opt out.
const navigationOptions = {
  autoReroute: !savedState || typeof savedState.autoReroute !== 'boolean' ? true : savedState.autoReroute,
};

function validRoutePoint(point) {
  return Array.isArray(point) && point.length === 2
    && Number.isFinite(point[0]) && Number.isFinite(point[1])
    && point[0] >= -180 && point[0] <= 180 && point[1] >= -90 && point[1] <= 90;
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
    const vias = Array.isArray(data.x) ? data.x.slice(0, 8) : [];
    if (!vias.every(validRoutePoint)) return null;
    const sharedRules = {};
    for (const key of Object.keys(rules)) {
      const value = data.r && data.r[key];
      if (typeof rules[key] === 'boolean' && typeof value === 'boolean') sharedRules[key] = value;
      if (typeof rules[key] === 'number' && Number.isFinite(value)) sharedRules[key] = value;
    }
    return {
      route: { s: data.s, e: data.e, v: vias },
      mode: ['direct', 'balanced', 'low'].includes(data.m) ? data.m : null,
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

const sharedRoute = readSharedRoute();
if (sharedRoute) Object.assign(rules, sharedRoute.rules);

let saveTimer = null;
function saveStateSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({
        rules, passFail: display.passFail,
        mode: routing.mode, prefDesig: routing.prefDesig, prefResidential: routing.prefResidential,
        autoReroute: navigationOptions.autoReroute,
        sources: Object.fromEntries(SOURCES.map((s) => [s.id, !!s.enabled])),
        view: { c: map.getCenter().toArray().map((v) => +v.toFixed(5)), z: +map.getZoom().toFixed(2) },
        route: routing.start && routing.end
          ? { s: routing.start, e: routing.end, v: routing.vias.map((x) => x.pt) } : null,
      }));
    } catch (e) { /* storage full/blocked — nonfatal */ }
  }, 800);
}

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
});
// A double tap is too easy to trigger while placing or inspecting a point on
// a phone, and can leave the app looking brokenly zoomed-in. Desktop keeps the
// conventional double-click zoom; touch devices still support pinch zoom.
const COARSE_POINTER = window.matchMedia('(pointer: coarse)').matches;
if (COARSE_POINTER) map.doubleClickZoom.disable();
// Keep the statewide view readable. The All-roads layer is on by default, but
// it appears only in a local/regional view; neighborhood streets need a closer
// zoom still.
const ROADS_MIN_ZOOM = 10;
const RES_MIN_ZOOM = 13;
let roadsZoomState = null;
function refreshRoadsForZoom() {
  const zoom = map.getZoom();
  const state = `${zoom >= ROADS_MIN_ZOOM}:${zoom >= RES_MIN_ZOOM}`;
  if (state === roadsZoomState) return;
  roadsZoomState = state;
  const roads = SOURCES.find((src) => src.id === 'roads');
  if (roads && map.getLayer(roads.id)) applyDisplayMode(roads);
  for (const src of SOURCES) {
    if (src.minVisibleZoom && map.getLayer(src.id)) updateVisibility(src);
  }
}
map.on('zoomend', refreshRoadsForZoom);
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

const colorExpr = () => {
  const expr = ['match', ['get', 'level']];
  for (const lvl of [1, 2, 3, 4, 0]) expr.push(lvl, COLORS[lvl]);
  expr.push(COLORS[0]);
  return expr;
};

/* -------------------------------------------------------- status UI */
const statusEl = document.getElementById('status');
let statusTimer = null;
function setStatus(msg, sticky = false) {
  statusEl.textContent = msg;
  statusEl.classList.remove('hidden');
  clearTimeout(statusTimer);
  if (!sticky) statusTimer = setTimeout(() => statusEl.classList.add('hidden'), 1400);
}

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
      paint: { 'line-color': '#d7191c', 'line-width': 7, 'line-opacity': 0.92,
               'line-dasharray': [1.2, 1.1] },
      filter: ['==', ['geometry-type'], 'LineString'],
    }, beforeId);
    map.addLayer({
      id: src.id, type: 'circle', source: src.id,
      minzoom: 10,
      paint: { 'circle-radius': 9, 'circle-color': '#d7191c',
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
    layout: { 'line-cap': 'butt', 'line-join': 'round', visibility: 'none' },
    paint: {
      'line-color': FAIL_COLOR,
      'line-dasharray': [2, 2],
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.8, 10, 1.4, 14, 2.6],
      'line-opacity': 0.65,
    },
    filter: ['all', ['>=', ['get', 'level'], display.passMax + 1], ['<=', ['get', 'level'], 4]],
  }, beforeId);
  map.addLayer({
    id: vhId(src), // color-ramp mode: level 4 shown dashed to read as "not passable"
    type: 'line',
    source: src.id,
    ...SL,
    layout: { 'line-cap': 'butt', 'line-join': 'round', visibility: 'none' },
    paint: {
      'line-color': COLORS[4],
      'line-dasharray': [2, 1.5],
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.1, 10, 1.9, 14, 3.7],
      'line-opacity': 0.9,
    },
    filter: ['==', ['get', 'level'], 4],
  }, beforeId);
  map.addLayer({
    id: src.id,
    type: 'line',
    source: src.id,
    ...SL,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': colorExpr(),
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.1, 10, 1.9, 14, 3.7],
      'line-opacity': 0.9,
    },
  }, beforeId);
  // Invisible wide line on top — a forgiving hover target so you don't have to
  // land pixel-perfect on the thin visible line. Transparent, so no visual change.
  map.addLayer({
    id: hitId(src),
    type: 'line',
    source: src.id,
    ...SL,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#000',
      'line-opacity': 0,
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 8, 12, 14, 16, 22],
    },
  }, beforeId);
  applyDisplayMode(src);
  attachHover(src, hitId(src));
}

// Main layer follows the source toggle; the two dashed overlays are each shown
// in exactly one display mode.
function updateVisibility(src) {
  // A source must be enabled by its checkbox, and the dense All-roads tiles
  // also require a close enough zoom to avoid obscuring the statewide map.
  const on = src.enabled && (!src.minVisibleZoom || map.getZoom() >= src.minVisibleZoom);
  if (src.closure) {
    for (const id of [src.id, src.id + '__line']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    }
    return;
  }
  if (map.getLayer(src.id)) map.setLayoutProperty(src.id, 'visibility', on ? 'visible' : 'none');
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
    updateVisibility(src);
    return;
  }
  if (src.ribbon) {
    // Informational ribbon under the scoring layers: orange = designated
    // route. National (USBR) draws wider than regional trails. Same in both
    // display modes — the designation doesn't depend on your rules.
    map.setFilter(src.id, null);
    map.setPaintProperty(src.id, 'line-color',
      ['match', ['get', 't'], 'ncn', '#e08214', '#fdb863']);
    map.setPaintProperty(src.id, 'line-width',
      ['interpolate', ['linear'], ['zoom'],
        6, ['match', ['get', 't'], 'ncn', 2.6, 1.6],
        10, ['match', ['get', 't'], 'ncn', 5, 3],
        14, ['match', ['get', 't'], 'ncn', 9, 5.5]]);
    map.setPaintProperty(src.id, 'line-opacity', 0.38);
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
      map.setPaintProperty(src.id, 'line-opacity', 0.65);
    } else {
      map.setPaintProperty(src.id, 'line-color', COLORS[4]);
      map.setPaintProperty(src.id, 'line-dasharray', [2, 1.5]);
      map.setPaintProperty(src.id, 'line-width', ['interpolate', ['linear'], ['zoom'], 6, 1.1, 10, 1.9, 14, 3.7]);
      map.setPaintProperty(src.id, 'line-opacity', 0.9);
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
    if (hideRes && map.getZoom() < RES_MIN_ZOOM) {
      conds.push(['all', ['!=', ['get', 'h'], 'residential'], ['!=', ['get', 'h'], 'living_street']]);
    }
    if (dedup) conds.push(['!=', ['get', 'd'], 1]);
    return conds.length > 1 ? ['all', ...conds] : f;
  };
  // Roads layer: residential/living_street draw thinner so arterials stand out.
  const isRes = ['match', ['get', 'h'], ['residential', 'living_street'], true, false];
  const w = (r6, n6, r10, n10, r14, n14) =>
    src.expr
      ? ['interpolate', ['linear'], ['zoom'],
         6, ['case', isRes, r6, n6], 10, ['case', isRes, r10, n10], 14, ['case', isRes, r14, n14]]
      : ['interpolate', ['linear'], ['zoom'], 6, n6, 10, n10, 14, n14];
  if (display.passFail) {
    map.setFilter(src.id, and(['all', ['>=', lvl, 1], ['<=', lvl, display.passMax]]));
    map.setPaintProperty(src.id, 'line-color', PASS_COLOR);
    map.setPaintProperty(src.id, 'line-opacity', 0.95);
    map.setPaintProperty(src.id, 'line-width', w(0.8, 1.4, 1.5, 2.6, 2.8, 5));
  } else {
    // Solid ramp for passing levels (and unknown); level 4 goes to the dashed vh layer.
    map.setFilter(src.id, and(['!=', lvl, 4]));
    map.setPaintProperty(src.id, 'line-color',
      ['match', lvl, 1, COLORS[1], 2, COLORS[2], 3, COLORS[3], 4, COLORS[4], COLORS[0]]);
    map.setPaintProperty(src.id, 'line-opacity', 0.9);
    map.setPaintProperty(src.id, 'line-width', w(0.6, 1.1, 1.1, 1.9, 2.1, 3.7));
  }
  if (map.getLayer(failId(src)))
    map.setFilter(failId(src), and(['all', ['>=', lvl, display.passMax + 1], ['<=', lvl, 4]]));
  if (map.getLayer(vhId(src)))
    map.setFilter(vhId(src), and(['==', lvl, 4]));
  if (map.getLayer(hitId(src)))
    map.setFilter(hitId(src), hideRes || dedup ? and(['boolean', true]) : null); // keep hover off hidden roads
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
  mode: sharedRoute?.mode || (savedState && savedState.mode) || 'balanced', // 'direct' | 'balanced' | 'low'
  prefDesig: sharedRoute?.prefDesig != null ? sharedRoute.prefDesig : savedState && typeof savedState.prefDesig === 'boolean'
    ? savedState.prefDesig : true, // strongly prefer designated routes & trails
  prefResidential: sharedRoute?.prefResidential != null ? sharedRoute.prefResidential
    : savedState && typeof savedState.prefResidential === 'boolean' ? savedState.prefResidential : true,
  reqId: 0,
  last: null, // last successful result (for redraws)
};

function setRouteStatus(t) {
  for (const id of ['route-status', 'rb-status']) {
    const el = document.getElementById(id);
    if (el) el.textContent = t;
  }
}

async function ensureRouter() {
  if (routing.ready || routing.loading) return;
  routing.loading = true;
  try {
    setRouteStatus('Loading routing data (one-time download)…');
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
    routing.worker.postMessage({ type: 'graph', buffer: buf }, [buf]);
  } catch (e) {
    routing.loading = false;
    setRouteStatus('Routing data failed to load (' + e.message + ').');
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
  if (flags & 8) return 1;
  if (s.mph <= rules.freeMaxSpeed) return flags & 128 ? 3 : 1;
  if (flags & 64) return flags & 128 ? 3 : 2;
  let sh = s.sh;
  if (sh < 0 && rules.unknownShoulderZero) sh = 0;
  if (!(flags & 2) && sh >= 0 && sh < rules.minShoulder) return 4;
  if (!rules.noUpperLimit && s.mph > rules.upperMaxSpeed) return 4;
  return flags & 128 ? 3 : 2;
}

const HIGHWAY_NAME = /\b(highway|state route|sr\s*\d|us\s*(?:route\s*)?\d|i-?\s*\d)\b/i;
function isHighwaySegment(s) {
  const flags = s.flags || 0;
  return !(flags & (4 | 8 | 32)) && (s.mph >= 45 || HIGHWAY_NAME.test(s.name || ''));
}

function routeSummaryStats(m) {
  const levels = [0, 0, 0, 0, 0];
  let highwayM = 0, freewayM = 0, limitedAccessM = 0;
  for (const s of m.segs || []) {
    const flags = s.flags || 0;
    const len = Number(s.lenM) || 0;
    if (flags & 32) continue; // ferry is reported separately, not a safety level
    const level = s.level || fallbackRouteLevel(s);
    if (level >= 1 && level <= 4) levels[level] += len;
    if (flags & 4) freewayM += len;
    else if (flags & 128) limitedAccessM += len;
    else if (isHighwaySegment(s)) highwayM += len;
  }
  return { levels, highwayM, freewayM, limitedAccessM };
}

const ROUTE_DETAILS_KEY = 'wa-bike-route-details-1';
function storeRouteDetails(m) {
  if (!m || !m.ok) return;
  try {
    localStorage.setItem(ROUTE_DETAILS_KEY, JSON.stringify({
      savedAt: Date.now(),
      mode: routing.mode,
      rules: { ...rules },
      summary: {
        distM: m.distM, timeS: m.timeS, ascentM: m.ascentM, descentM: m.descentM,
        failM: m.failM, desigM: m.desigM, ferryM: m.ferryM,
      },
      // Keep the detailed report compact: it only needs road attributes and
      // lengths, not the complete route geometry or elevation profile.
      segs: (m.segs || []).map((s) => ({
        name: s.name || '', mph: s.mph, sh: s.sh, flags: s.flags || 0,
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
  offRouteReminderSent: false,
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
  return { coords, cumulative, instructions, segs, totalM: cumulative[cumulative.length - 1] || 0 };
}

const AUTO_REROUTE_AFTER_MS = 60_000;
const AUTO_REROUTE_REMINDER_MS = 45_000;
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
  turnNav.offRouteReminderSent = false;
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
  turnNav.offRouteReminderSent = false;
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
      ? (nearStart && turnNav.offRouteMovingMs < AUTO_REROUTE_REMINDER_MS
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

function refreshNavigationUI() {
  const routeAvailable = !!routing.last?.ok;
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
        ? ' Auto reroute will begin after 60 seconds of moving off route. You can tap Reroute now.'
        : ' You can tap Reroute to make a new route from here.';
      speakNavigation(`You are off route. Return to ${target}.${startHint}${autoHint}`);
      turnNav.offRouteSpokenAt = Date.now();
    } else {
      trackOffRouteMovingTime(pos);
    }
    if (navigationOptions.autoReroute && !turnNav.offRouteReminderSent
        && turnNav.offRouteMovingMs >= AUTO_REROUTE_REMINDER_MS) {
      turnNav.offRouteReminderSent = true;
      speakNavigation('You are still off route. Auto rerouting in 15 seconds of moving time. Tap Reroute to do it now.');
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
  const rejoinLegM = Number(routing.last?.legs?.[0]?.distM) || Infinity;
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
  if (!routing.last?.ok || !navigator.geolocation) {
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
  if (automatic) speakNavigation('You are still off route. Rerouting from your current location now.');
  turnNav.message = automatic ? 'Auto-rerouting from here' : 'Rerouting from here';
  setRouteStatus('Rerouting…');
  updateArmButtons();
  refreshNavigationUI();
  computeRoute();
}

function stopTurnNavigation(announce = true) {
  if (!turnNav.active) return;
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
}

document.addEventListener('visibilitychange', () => {
  if (turnNav.active && document.visibilityState === 'visible') requestNavigationWakeLock();
});

function renderRouteCard(m) {
  const card = document.getElementById('routeCard');
  const controls = document.getElementById('routeControls');
  const moveControls = () => {
    const slot = card.querySelector('#routeControlsSlot');
    if (slot && controls) slot.replaceWith(controls);
  };
  if (!card) return;
  if (!m) {
    card.innerHTML = `<div id="routeControlsSlot"></div><div class="rc-empty">Use <b>Start</b> on the map bar to
      search for or tap your start point. Use <b>End</b> for the destination. Routes follow your
      riding rules and chosen mode, entirely on this device.</div>`;
    moveControls();
    refreshNavigationUI();
    return;
  }
  if (!m.ok) {
    card.innerHTML = `<div id="routeControlsSlot"></div><div class="rc-empty">${m.reason}</div>`;
    moveControls();
    refreshNavigationUI();
    return;
  }
  const stats = routeSummaryStats(m);
  // Reserve this line even when a mode does not use a ferry. That keeps the
  // sheet from jumping when switching between otherwise valid route modes.
  const ferry = `<div class="rc-sub rc-ferry">${m.ferryM > 0
    ? `⛴ ${fmtMi(m.ferryM)} mi by ferry (crossing + typical wait included)`
    : '&nbsp;'}</div>`;
  const routeTypeParts = [
    `<button class="rc-highlight-item" data-highlight="desig" aria-pressed="false" title="Highlight bike-route segments on the map" ${m.desigM > 0 ? '' : 'disabled'}><span>★ Bike routes</span><b>${fmtDist(m.desigM)}</b></button>`,
  ];
  if (stats.highwayM > 0) routeTypeParts.push(`<button class="rc-highlight-item" data-highlight="highway" aria-pressed="false" title="Highlight highway segments on the map"><span>⚠ Highways</span><b>${fmtDist(stats.highwayM)}</b></button>`);
  if (stats.freewayM > 0) routeTypeParts.push(`<button class="rc-highlight-item" data-highlight="freeway" aria-pressed="false" title="Highlight freeway segments on the map"><span>⛔ Freeways</span><b>${fmtDist(stats.freewayM)}</b></button>`);
  if (stats.limitedAccessM > 0) routeTypeParts.push(`<button class="rc-highlight-item rc-attention" data-highlight="limited-access" aria-pressed="false" title="Highlight limited-access caution segments on the map"><span>⚠ Caution</span><b>${fmtDist(stats.limitedAccessM)}</b></button>`);
  const routeTypes = `<div class="rc-route-types">${routeTypeParts.join('')}</div>`;
  const levelNames = ['', 'Comfy', 'Meets rules', 'Caution', 'Fails rules'];
  const levels = `<div class="rc-levels">${[1, 2, 4].map((level) =>
    `<button class="rc-level rc-l${level}${level === 4 && stats.levels[level] > 0 ? ' rc-attention' : ''}" data-highlight="level-${level}" aria-pressed="false" title="Highlight ${levelNames[level].toLowerCase()} segments on the map" ${stats.levels[level] > 0 ? '' : 'disabled'}><span>${levelNames[level]}</span><b>${fmtDist(stats.levels[level])}</b></button>`
  ).join('')}</div>`;
  const legs = m.legs && m.legs.length > 1
    ? `<div class="rc-legs">${m.legs.map((l, i) =>
        `<div class="rc-leg">Leg ${i + 1}: <b>${fmtMi(l.distM)} mi</b> · ${fmtDur(l.timeS)}${
          l.failM > 0 ? ` · <span class="rc-leg-warn">${fmtDist(l.failM)} fail</span>` : ''}</div>`).join('')}</div>`
    : '';
  card.innerHTML = `
    <div id="routeControlsSlot"></div>
    <div class="rc-main">${fmtMi(m.distM)} mi <small>· ${fmtDur(m.timeS)}</small></div>
    <div class="rc-sub">↗ ${fmtFt(m.ascentM)} ft climb · ↘ ${fmtFt(m.descentM)} ft descent</div>
    ${ferry}
    <div class="rc-highlight-hint">Tap an item to highlight it on the map</div>
    ${routeTypes}
    ${levels}
    ${legs}
    <canvas id="profileCv"></canvas>`;
  moveControls();
  card.querySelectorAll('[data-highlight]').forEach((b) => {
    const active = b.dataset.highlight === routeHighlightKey;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  drawProfile(m.profile, m.distM);
  refreshNavigationUI();
}

function drawProfile(profile, distM) {
  const cv = document.getElementById('profileCv');
  if (!cv || !profile || profile.length < 2) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 280, h = cv.clientHeight || 72;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  let lo = Infinity, hi = -Infinity;
  for (const [, e] of profile) { if (e < lo) lo = e; if (e > hi) hi = e; }
  if (hi - lo < 30) { const mid = (hi + lo) / 2; lo = mid - 15; hi = mid + 15; }
  const padT = 12, padB = 14, padL = 2, padR = 2;
  const X = (d) => padL + (d / distM) * (w - padL - padR);
  const Y = (e) => padT + (1 - (e - lo) / (hi - lo)) * (h - padT - padB);
  ctx.beginPath();
  ctx.moveTo(X(profile[0][0]), Y(profile[0][1]));
  for (const [d, e] of profile) ctx.lineTo(X(d), Y(e));
  ctx.lineTo(X(profile[profile.length - 1][0]), h - padB);
  ctx.lineTo(X(profile[0][0]), h - padB);
  ctx.closePath();
  ctx.fillStyle = 'rgba(44,123,182,0.18)';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(X(profile[0][0]), Y(profile[0][1]));
  for (const [d, e] of profile) ctx.lineTo(X(d), Y(e));
  ctx.strokeStyle = '#2c7bb6';
  ctx.lineWidth = 1.8;
  ctx.stroke();
  ctx.fillStyle = '#98a2ad';
  ctx.font = '10px system-ui';
  ctx.fillText(`${fmtFt(hi)} ft`, padL + 2, padT - 2);
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${fmtFt(lo)} ft`, padL + 2, h - 1);
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

function onRouterMessage(ev) {
  const m = ev.data;
  if (m.type === 'ready') {
    routing.ready = true;
    routing.loading = false;
    setRouteStatus(routing.start && routing.end ? 'Routing…' : '');
    renderRouteCard(routing.last);
    computeRoute();
  } else if (m.type === 'route') {
    if (m.id !== routing.reqId) return; // stale reply
    routing.last = m;
    if (!m.ok) {
      routing.navRejoin = null;
      stopTurnNavigation(false);
      renderRouteCard(m);
      drawRoute([]);
      setRouteStatus(m.reason);
      if (m.code === 'point-too-far') showPointTooFarPopup(m);
      return;
    }
    if (turnNav.active) {
      turnNav.route = buildTurnInstructions(m);
      turnNav.next = 0;
      turnNav.nearest = 0;
      turnNav.routeM = 0;
      turnNav.arrived = false;
      clearOffRouteTracking();
      turnNav.rejoinAwaiting = false;
      turnNav.message = 'Route updated';
    }
    renderRouteCard(m);
    storeRouteDetails(m);
    drawRoute(m.coords, m.ferrySegs, m.segs);
    setRouteStatus(`${fmtMi(m.distM)} mi`);
  } else if (m.type === 'error') {
    setRouteStatus('Routing error: ' + m.message);
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
  saveStateSoon();
  routing.worker.postMessage({
    type: 'route', id: routing.reqId,
    points: [routing.start, ...(routing.navRejoin ? [routing.navRejoin] : []), ...routing.vias.map((v) => v.pt), routing.end],
    rules: { ...rules }, mode: routing.mode,
    prefDesignated: routing.prefDesig,
    prefResidential: routing.prefResidential,
  });
}

// Pseudo-source for tapping the route line itself: segments carry their graph
// attributes, so the route is inspectable even with every data layer off.
const ROUTESEG_SRC = { id: 'routeseg', name: 'Your route', scorer: scoreRouteSeg };
function scoreRouteSeg(p) {
  return {
    baseScore: null,
    shoulder_width: p.sh >= 0 ? p.sh : null,
    maxspeed_num: p.ferry ? null : p.mph,
    prohibited: false, restricted: false,
    freeway: p.fw === 1,
    limited_access: p.lim === 1 || p.fw === 1,
    good_facility: p.fac === 1,
    infra: p.infra === 1,
    est: p.e === 1,
    desig: p.desig === 1,
  };
}

// Pulse animation for failing portions of the route — impossible to miss.
let failPulseTimer = null;
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

function drawRoute(coords, ferrySegs, segs) {
  clearRouteHighlight();
  const data = { type: 'Feature', properties: {},
    geometry: { type: 'LineString', coordinates: coords } };
  // Ferry legs are drawn as white dashes on top of the route line, so the
  // crossing reads as "not riding" at a glance.
  const fdata = { type: 'FeatureCollection', features: (ferrySegs || []).map((c) => ({
    type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c } })) };
  // Per-edge segments with graph attrs feed the invisible tap target.
  const sdata = { type: 'FeatureCollection', features: (segs || []).map((s) => ({
    type: 'Feature',
    properties: { name: s.name, mph: s.mph, sh: s.sh, lenM: s.lenM,
      e: s.flags & 1 ? 1 : 0, fac: s.flags & 2 ? 1 : 0, fw: s.flags & 4 ? 1 : 0,
      lim: s.flags & 128 ? 1 : 0,
      infra: s.flags & 8 ? 1 : 0, ferry: s.flags & 32 ? 1 : 0, desig: s.flags & 64 ? 1 : 0,
      level: s.level || fallbackRouteLevel(s), hwy: isHighwaySegment(s) ? 1 : 0 },
    geometry: { type: 'LineString', coordinates: coords.slice(s.c0, s.c1 + 1) },
  })) };
  // Failing portions (scored live against the current rules) pulse red on top.
  const failData = { type: 'FeatureCollection',
    features: sdata.features.filter((f) =>
      f.properties.ferry !== 1 && effectiveLevel(scoreRouteSeg(f.properties)) === 4) };
  const emptyHighlights = { type: 'FeatureCollection', features: [] };
  const srcExisting = map.getSource('route');
  if (srcExisting) {
    srcExisting.setData(data);
    map.getSource('route-ferry').setData(fdata);
    map.getSource('route-seg').setData(sdata);
    map.getSource('route-fail').setData(failData);
    map.getSource('route-highlight-marker').setData(emptyHighlights);
    setFailPulse(failData.features.length > 0);
    return;
  }
  map.addSource('route', { type: 'geojson', data });
  map.addSource('route-ferry', { type: 'geojson', data: fdata });
  map.addSource('route-seg', { type: 'geojson', data: sdata });
  map.addSource('route-fail', { type: 'geojson', data: failData });
  map.addSource('route-highlight-marker', { type: 'geojson', data: emptyHighlights });
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
  map.addLayer({
    id: 'route', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#7623bb', 'line-width': 6.5, 'line-opacity': 1 },
  });
  map.addLayer({
    id: 'route-fail-casing', type: 'line', source: 'route-fail',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 12, 'line-opacity': 0.8 },
  });
  map.addLayer({
    id: 'route-fail', type: 'line', source: 'route-fail',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#d7191c', 'line-width': 6.5, 'line-opacity': 0.9 },
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
}

let routeHighlightKey = null;
const ROUTE_HIGHLIGHT_FILTERS = {
  desig: ['==', ['get', 'desig'], 1],
  highway: ['==', ['get', 'hwy'], 1],
  freeway: ['==', ['get', 'fw'], 1],
  'limited-access': ['==', ['get', 'lim'], 1],
  'level-1': ['==', ['get', 'level'], 1],
  'level-2': ['==', ['get', 'level'], 2],
  'level-3': ['==', ['get', 'level'], 3],
  'level-4': ['==', ['get', 'level'], 4],
};

function routeSegmentMatchesHighlight(seg, key) {
  const flags = seg.flags || 0;
  const level = seg.level || fallbackRouteLevel(seg);
  if (key === 'desig') return !!(flags & 64);
  if (key === 'highway') return isHighwaySegment(seg);
  if (key === 'freeway') return !!(flags & 4);
  if (key === 'limited-access') return !!(flags & 128);
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
  routeHighlightKey = null;
  for (const id of ['route-highlight-halo', 'route-highlight', 'route-highlight-marker-halo', 'route-highlight-marker']) {
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

function setRoutePoint(kind, lngLat) {
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
        const ll = routing[mk].getLngLat();
        routing[kind] = [ll.lng, ll.lat];
        computeRoute();
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

function addVia(lngLat) {
  const marker = new maplibregl.Marker({ color: '#555555', draggable: true, scale: 0.85 })
    .setLngLat(lngLat).addTo(map);
  const via = { pt: [lngLat.lng, lngLat.lat], marker };
  routing.vias.push(via);
  marker.on('dragend', () => {
    const ll = marker.getLngLat();
    via.pt = [ll.lng, ll.lat];
    computeRoute();
  });
  computeRoute();
  updateArmButtons();
}

function removeLastVia() {
  const via = routing.vias.pop();
  if (!via) return;
  via.marker.remove();
  if (routing.arm === 'via') routing.arm = null;
  updateArmButtons();
  computeRoute();
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
  stopTurnNavigation(false);
  routing.arm = null;
  closePlacePicker(false);
  routing.start = routing.end = null;
  routing.navRejoin = null;
  for (const v of routing.vias) v.marker.remove();
  routing.vias = [];
  for (const k of ['startMarker', 'endMarker']) {
    if (routing[k]) { routing[k].remove(); routing[k] = null; }
  }
  drawRoute([]);
  routing.last = null;
  try { localStorage.removeItem(ROUTE_DETAILS_KEY); } catch (e) { /* nonfatal */ }
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
  if (add) add.disabled = !(routing.start && routing.end);
  if (remove) remove.disabled = routing.vias.length === 0;
  if (reverse) reverse.disabled = !(routing.start && routing.end);
}

const MODES = [
  ['direct', 'Direct', 'Fastest ride, even if stressful'],
  ['balanced', 'Balanced', 'Avoids bad roads when the detour is reasonable'],
  ['low', 'Low-stress', 'Detours hard to avoid failing roads; unavoidable ones pulse red'],
];

function syncRoutePreferenceControls() {
  const designated = document.getElementById('prefDesig');
  const residential = document.getElementById('prefResidential');
  if (designated) designated.checked = routing.prefDesig;
  if (residential) residential.checked = routing.prefResidential;
}

function buildRoutingPanel() {
  const chips = document.getElementById('modeChips');
  document.getElementById('routeCard').addEventListener('click', (e) => {
    const button = e.target.closest('[data-highlight]');
    if (button && !button.disabled) toggleRouteHighlight(button.dataset.highlight);
  });
  chips.innerHTML = MODES.map(([id, label]) =>
    `<button data-mode="${id}" ${id === routing.mode ? 'class="active"' : ''}
       title="${MODES.find((m) => m[0] === id)[2]}">${label}</button>`).join('');
  chips.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      routing.mode = b.dataset.mode;
      chips.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      computeRoute();
    });
  });

  // Route preferences intentionally share this single compact row on phones.
  // The details button stays alongside them, so the route card keeps its
  // previous height instead of pushing the map farther down.
  const pref = document.createElement('div');
  pref.className = 'route-preferences';
  pref.innerHTML = `
    <label class="route-preference" for="prefDesig" title="Strongly prefer designated bike routes and trails">
      <input type="checkbox" id="prefDesig" ${routing.prefDesig ? 'checked' : ''}>
      <span>Prefer bike routes</span>
    </label>
    <label class="route-preference" for="prefResidential" title="Prefer local residential streets over ordinary tertiary streets">
      <input type="checkbox" id="prefResidential" ${routing.prefResidential ? 'checked' : ''}>
      <span>Prefer residential</span>
    </label>
    <button type="button" id="routeDetailsBtn" class="route-details-btn" aria-label="Open route details and routing tips" title="Route details and routing tips"><span aria-hidden="true">i</span></button>`;
  chips.closest('#routeControls').append(pref);
  pref.querySelector('input').addEventListener('change', (e) => {
    routing.prefDesig = e.target.checked;
    saveStateSoon();
    computeRoute();
  });
  pref.querySelector('#prefResidential').addEventListener('change', (e) => {
    routing.prefResidential = e.target.checked;
    saveStateSoon();
    computeRoute();
  });
  pref.querySelector('#routeDetailsBtn').addEventListener('click', openRouteDetails);

  renderRouteCard(null);

  for (const kind of ['start', 'end']) {
    document.getElementById('rb-' + kind).addEventListener('click', () => openPlacePicker(kind));
  }
  document.getElementById('rb-via').addEventListener('click', () => armRoutePoint('via'));
  document.getElementById('rb-via-remove').addEventListener('click', removeLastVia);
  document.getElementById('rb-reverse').addEventListener('click', reverseRoute);
  document.getElementById('navStartButton').addEventListener('click', () => {
    if (turnNav.active) stopTurnNavigation();
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
  } else if (savedState && savedState.route) {
    const rt = savedState.route;
    setRoutePoint('start', { lng: rt.s[0], lat: rt.s[1] });
    for (const p of rt.v || []) addVia({ lng: p[0], lat: p[1] });
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
  if (shared.prefDesig != null) routing.prefDesig = shared.prefDesig;
  if (shared.prefResidential != null) routing.prefResidential = shared.prefResidential;
  document.querySelectorAll('#modeChips button').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === routing.mode));
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
  try { return JSON.parse(localStorage.getItem(SAVED_ROUTES_KEY) || '[]'); } catch (e) { return []; }
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
    host.innerHTML = (list.length ? '' : '<div class="hint">Saved routes stay on this device.</div>')
      + list.map((r, i) =>
        `<div class="saved-row">
           <button class="saved-load" data-i="${i}">${r.name}</button>
           <button class="saved-del" data-i="${i}" title="Delete">✕</button>
         </div>`).join('');

    host.querySelectorAll('.saved-load').forEach((b) => b.addEventListener('click', () => {
      const r = loadSavedRoutes()[Number(b.dataset.i)];
      if (!r) return;
      clearRoute();
      routing.mode = r.mode || routing.mode;
      routing.prefDesig = r.prefDesig != null ? r.prefDesig : routing.prefDesig;
      routing.prefResidential = r.prefResidential != null ? r.prefResidential : routing.prefResidential;
      document.querySelectorAll('#modeChips button').forEach((x) =>
        x.classList.toggle('active', x.dataset.mode === routing.mode));
      syncRoutePreferenceControls();
      setRoutePoint('start', { lng: r.s[0], lat: r.s[1] });
      for (const p of r.v || []) addVia({ lng: p[0], lat: p[1] });
      setRoutePoint('end', { lng: r.e[0], lat: r.e[1] });
      const lons = [r.s[0], r.e[0], ...(r.v || []).map((p) => p[0])];
      const lats = [r.s[1], r.e[1], ...(r.v || []).map((p) => p[1])];
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
        { padding: 60, maxZoom: 13 });
      dialog.close();
    }));
    host.querySelectorAll('.saved-del').forEach((b) => b.addEventListener('click', () => {
      const list2 = loadSavedRoutes();
      list2.splice(Number(b.dataset.i), 1);
      storeSavedRoutes(list2);
      render();
    }));
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
      v: routing.vias.map((x) => x.pt), mode: routing.mode, prefDesig: routing.prefDesig,
      prefResidential: routing.prefResidential,
      ts: Date.now() });
    storeSavedRoutes(list.slice(0, 30));
    input.value = '';
    render();
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
  if (cancelArm && (routing.arm === 'start' || routing.arm === 'end')) {
    routing.arm = null;
    updateArmButtons();
    setRouteStatus('');
  }
}

function openPlacePicker(kind) {
  placeTarget = kind;
  routing.arm = kind;
  suppressRoadInfo();
  updateArmButtons();
  ensureRouter();
  setPanelOpen(false);
  document.getElementById('placePickerTitle').textContent =
    (kind === 'start' ? 'Set start' : 'Set destination') + ' — tap map or search';
  document.getElementById('useLoc').hidden = kind !== 'start';
  const onlineButton = document.getElementById('onlinePlaceSearch');
  onlineButton.disabled = false;
  onlineButton.textContent = '⌕';
  document.getElementById('placeSearch').value = '';
  document.getElementById('placeResults').replaceChildren();
  document.getElementById('placeResults').classList.remove('show');
  document.getElementById('placePicker').hidden = false;
  setRouteStatus(`Tap the map or search to set the ${kind === 'start' ? 'START' : 'DESTINATION'}`);
}

function armRoutePoint(kind) {
  if (kind === 'via' && !(routing.start && routing.end)) return;
  closePlacePicker(false);
  routing.arm = routing.arm === kind ? null : kind;
  if (routing.arm) suppressRoadInfo();
  updateArmButtons();
  ensureRouter();
  if (routing.arm) {
    setPanelOpen(false);
    setRouteStatus(kind === 'via' ? 'Tap the map to add a stop'
      : `Tap the map to set the ${kind === 'start' ? 'START' : 'DESTINATION'}`);
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
    setRoutePoint(placeTarget, lngLat);
    routing.arm = null;
    updateArmButtons();
    setRouteStatus(placeTarget === 'start' ? 'Start set — choose End next' : 'Destination set');
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
      setRouteStatus('Start = your location. Choose End next');
    }, () => setRouteStatus('Could not get your location'), { enableHighAccuracy: true, timeout: 10000 });
  });
}

/* ---------------------------------------------- hover/click readout */
const readoutEl = document.getElementById('readout');
const LEVEL_NAME = { 0: 'unknown', 1: 'Low', 2: 'Moderate', 3: 'Caution', 4: 'Very high' };
// The road card must repeat the legend vocabulary, so a rider can connect a
// colored line on the map with the detailed verdict they just opened.
const READOUT_COLOR_LABEL = {
  0: 'Gray — Unknown / no data',
  1: 'Blue — Comfortable',
  2: 'Light blue — Meets your criteria',
  3: 'Orange — Caution (limited-access highway)',
  4: 'Red dashed — Fails / bikes prohibited (avoid)',
};
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
      ? 'Dedicated or protected bike path — low stress.'
      : n.baseScore === 2
      ? 'Bike lane or shared path — moderate.'
      : 'Bike infrastructure.';
  const spd = n.maxspeed_num;
  const shRaw = n.shoulder_width;
  const shUnknown = shRaw == null;
  const sh = shUnknown && rules.unknownShoulderZero ? 0 : shRaw;
  const spdTxt = spd != null ? `${spd} mph${n.est ? ' (est.)' : ''}` : null;
  if (spd != null && spd <= rules.freeMaxSpeed)
    return n.limited_access
      ? `${spdTxt} — meets your speed/shoulder rules, but this is a limited-access highway (caution).`
      : `${spdTxt} — at or below your ${rules.freeMaxSpeed} mph no-shoulder limit, passes without a shoulder.`;

  if (n.desig)
    return n.limited_access
      ? 'On a designated bike route, but it is also a limited-access highway (caution).'
      : 'On a designated bike route (USBR / regional trail) — a vetted corridor, treated as meeting your criteria.';

  const shoulderFails = !n.good_facility && sh != null && sh < rules.minShoulder;
  const speedFails = !rules.noUpperLimit && spd != null && spd > rules.upperMaxSpeed;
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
  if (spd != null)
    met.push(
      rules.noUpperLimit
        ? `${spdTxt} — no speed cutoff set`
        : `${spdTxt} within your ${rules.upperMaxSpeed} mph max`
    );
  return `Meets your criteria — ${met.join(', ')}.`;
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
    ['Map color', READOUT_COLOR_LABEL[lvl] || READOUT_COLOR_LABEL[0]],
    ['Stress', lvl === 0 ? 'unknown' : `${lvl} — ${LEVEL_NAME[lvl]}`],
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
        ['Shoulder', p.sh >= 0 ? `${p.sh} ft` : null],
        ['Type', p.infra ? 'Dedicated bike infrastructure' : (p.fw || p.lim) ? 'Limited-access highway' : null],
      ];
    }
  } else if (src.id === 'routes') {
    title = 'Designated bike route';
    const isUSBR = p.t === 'ncn' && /^\d+$/.test(p.r || '');
    rows = [
      ['Name', p.n || null],
      ['Route', isUSBR ? 'US Bicycle Route ' + p.r : p.r || null],
      ['Network', p.t === 'ncn' ? 'National (AASHTO-designated)' : 'Regional trail / route'],
      ['Map color', 'Orange — designated routes (USBR & trails)'],
      ['Note', 'Officially designated cycling corridor — treated as meeting your criteria (freeway and prohibition rules still apply).'],
    ];
  } else if (src.id === 'restrict') {
    title = 'Bikes prohibited (WSDOT)';
    rows = [
      ['Route', p.Route ? 'SR ' + String(p.Route).replace(/^0+/, '') : p.RouteIdentifier],
      ['Map color', 'Red dashed — Fails / bikes prohibited (avoid)'],
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
  readoutEl.innerHTML =
    `<button class="readout-close" aria-label="Close road information">✕</button>` +
    `<div class="rt-title">${title}</div><table>` +
    rows.map(([k, v]) => `<tr><td class="k">${k}</td><td>${v}</td></tr>`).join('') +
    '</table>' +
    `<a class="gmap" href="${streetView}" target="_blank" rel="noopener">Open Street View ↗</a>`;
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
    addVia(lngLat);
    setRouteStatus('Stop added — tap + to add another');
    return true;
  }
  setRoutePoint(kind, lngLat);
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
    row.innerHTML = `
      <input type="checkbox" id="chk-${src.id}" ${src.enabled ? 'checked' : ''}>
      <label for="chk-${src.id}">${src.name}</label>
      <span class="count"></span>`;
    host.appendChild(row);
    row.querySelector('input').addEventListener('change', (e) =>
      setSourceVisible(src, e.target.checked)
    );
  }
}

function buildRulesPanel() {
  const slidersHost = document.getElementById('settingsSliders');
  const optionsHost = document.getElementById('settingsOptions');
  slidersHost.replaceChildren();
  optionsHost.replaceChildren();

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
      onChange();
    });
  };

  check('allowFreeways', 'Allow freeway as last resort');
  check('requireSafe', 'Fail if no complete safe route found');
  check('autoReroute', 'Auto-reroute after 60 sec off route while moving', navigationOptions, () => {
    saveStateSoon();
    refreshNavigationUI();
  });
  check('unknownShoulderZero', 'Unknown shoulder treated as 0 ft');
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
      scheduleRescore();
    });
  }

  const settingsTabs = document.getElementById('settingsTabs');
  if (!settingsTabs.dataset.bound) {
    const selectSettingsPane = (pane) => {
      document.querySelectorAll('[data-settings-pane]').forEach((button) => {
        const active = button.dataset.settingsPane === pane;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
      });
      document.querySelectorAll('.settings-pane').forEach((panel) => {
        panel.hidden = panel.id !== `settings-${pane}`;
      });
    };
    document.querySelectorAll('[data-settings-pane]').forEach((button) =>
      button.addEventListener('click', () => selectSettingsPane(button.dataset.settingsPane)));
    document.getElementById('settingsHelpBtn').addEventListener('click', () =>
      document.getElementById('settingsHelpDialog').showModal());
    settingsTabs.dataset.bound = 'true';
  }
}

function buildLegend() {
  const host = document.getElementById('legend');
  host.innerHTML = '';
  const dash = (c) => `background:repeating-linear-gradient(90deg,${c} 0 4px,transparent 4px 8px)`;
  const rows = display.passFail
    ? [[PASS_COLOR, 'Meets your criteria (Low–Moderate)'],
       ['dashed', 'Fails / bikes prohibited'],
       [null, 'No-data roads are hidden']]
    // Color-ramp view: level 4 is drawn dashed to read as "not passable".
    : LEGEND.map(([lvl, label]) => [lvl === 4 ? 'dash4' : COLORS[lvl], label]);
  const routes = SOURCES.find((src) => src.id === 'routes');
  if (!display.passFail && routes?.enabled) rows.unshift(['#fdb863', 'Orange: designated routes (USBR & trails)']);
  for (const [color, label] of rows) {
    const item = document.createElement('div');
    item.className = 'item';
    const swatch =
      color === 'dashed'
        ? `<span class="swatch" style="${dash(FAIL_COLOR)}"></span>`
        : color === 'dash4'
        ? `<span class="swatch" style="${dash(COLORS[4])}"></span>`
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
  scheduleMobileNavDock();
}
placeNavigationControl();
if (mobileNavMedia.addEventListener) mobileNavMedia.addEventListener('change', placeNavigationControl);
else mobileNavMedia.addListener(placeNavigationControl);
if (window.ResizeObserver) {
  new ResizeObserver(scheduleMobileNavDock).observe(document.getElementById('panel'));
}

// Tabs.
function setPanelOpen(open) {
  document.body.classList.toggle('panel-open', open);
  refreshNavigationUI();
  scheduleMobileNavDock();
}

function selectPanelTab(tabId) {
  document.querySelectorAll('#tabs button[data-tab]').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === tabId));
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
document.getElementById('panelClose').addEventListener('click', () => setPanelOpen(false));
document.getElementById('panelOpen').addEventListener('click', () => {
  closePlacePicker(true);
  readoutPinned = false;
  readoutEl.classList.remove('show');
  selectPanelTab('route');
  setPanelOpen(true);
});

// Dialog close buttons and small map-corner version stamp.
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () =>
  document.getElementById(b.dataset.close).close()));
document.getElementById('appVersion').textContent = 'v' + APP_VERSION;

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
function offerUpdate(worker) {
  if (!worker || !navigator.serviceWorker.controller) return;
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
  } catch (e) { /* service worker unavailable — app still works online */ }
}

document.getElementById('getUpdateBtn').addEventListener('click', () => {
  if (pendingUpdateWorker) pendingUpdateWorker.postMessage({ type: 'SKIP_WAITING' });
});
document.getElementById('updateLaterBtn').addEventListener('click', () => {
  document.getElementById('updatePrompt').hidden = true;
});
setupAutomaticUpdates();



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
