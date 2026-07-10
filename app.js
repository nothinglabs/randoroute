/*
 * Washington Bike Safety Visualizer — Phase 1 (WSDOT BLTS)
 *
 * Visualization only. All data is baked into local static files at build time;
 * the app makes no runtime calls to WSDOT / Overpass / ArcGIS and does no routing.
 *
 * Architecture (built to let Phase 2's OSM source slot in with no rewrite):
 *   - Each data source has its own toggle, its own scorer, and its own layer.
 *   - A scorer maps that source's raw props to NORMALIZED props:
 *       baseScore, shoulder_width, maxspeed_num, prohibited, restricted, limited_access, good_facility
 *   - applyEffective() is source-agnostic: it reads only normalized props + the
 *     current riding-rules settings and writes an effective 1-4 level (or 0 = unknown)
 *     used for color. Re-scoring is instant and client-side (no refetch).
 */

const APP_VERSION = '2026-07-07.3'; // shown in the panel footer; bump per release

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
  [1, 'Comfortable (slow)'],
  [2, 'Meets your criteria'],
  [4, 'Fails / bikes prohibited (avoid)'],
  [0, 'Unknown / no data'],
];

/* ------------------------------------------------- riding-rules state */
const rules = {
  allowFreeways: true,  // show limited-access/high-speed roads as rideable at all?
  minShoulder: 4,       // ft; below this a road gets penalized
  unknownShoulderZero: true, // pessimistic: no shoulder data = 0 ft (fast roads must PROVE a shoulder)
  freeMaxSpeed: 25,     // mph; at/below this a road is comfortable regardless of shoulder
  upperMaxSpeed: 45,    // mph; above this it's high-stress unless shoulder/facility is adequate
  noUpperLimit: true,   // disable the upper-speed hard cap
};

/* --------------------------------------------------- display state */
// Pass/fail mode: an accessibility-friendly view that doesn't rely on telling
// colors apart. Instead of a 1-4 color ramp it shows ONLY roads that meet the
// criteria (effective level at/below passMax), painted a single green; every
// other road is hidden. Recomputes live as the riding rules change.
const PASS_COLOR = '#009E73';
const display = {
  passFail: false,
  passMax: 2, // a road "passes" if its effective level is 1..passMax (Low & Moderate)
  hideResidential: true, // declutter: hide neighborhood streets in the All-roads layer
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
    limited_access: !!p.LimitedAccess,
    good_facility: !!(p.BikeFacilityType && p.BikeFacilityType.length),
    infra: false,
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
  const bikeish = hw === 'cycleway' || hw === 'path' || hw === 'bridleway' || cw != null;
  let base = null;
  let prohibited = false;
  if (hw === 'cycleway' && bike !== 'no' && bike !== 'dismount') base = 1;
  else if (hw === 'path' && (bike === 'designated' || bike === 'yes')) base = 1;
  else if (hw === 'footway' && bike === 'designated') base = 2;
  else if (hw === 'bridleway' && (bike === 'designated' || bike === 'yes')) base = 2;
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
    limited_access: false,
    good_facility: base != null && !prohibited,
    infra: true,
  };
}

// Full OSM road network (Phase 3). Short property keys (see build_roads.py):
// h=class s=speed(mph) e=estimated f=facility b=bike-prohibited m=limited-access
// w=shoulder(ft) n=name r=ref. Speeds are always present — actual, or inferred
// from road class (BNA-style) with e=1 marking the estimate.
function scoreRoad(p) {
  return {
    baseScore: null,
    shoulder_width: p.w == null ? null : p.w,
    maxspeed_num: p.s == null ? null : p.s,
    prohibited: p.b === 1,
    restricted: false,
    limited_access: p.m === 1,
    good_facility: p.f === 1,
    infra: false,
    est: p.e === 1,
  };
}

// WSDOT Permanent Bike Restrictions overlay: always prohibited, by definition.
function scoreRestrict() {
  return { baseScore: 4, shoulder_width: null, maxspeed_num: null, prohibited: true,
           restricted: true, limited_access: false, good_facility: false, infra: false };
}

/* --------------------------------------------- source-agnostic scorer */
// "Your criteria decide", as HARD gates: each criterion is pass/fail. A road
// fails (level 4 = avoid) if the data we have shows any criterion is not met.
// Missing data does NOT fail a road — only a known-bad value does. There is no
// middle "3": a road either meets the criteria (1 = comfortable, 2 = meets)
// or it fails (4). Returns 0 only when there's no usable data at all.
function effectiveLevel(n) {
  if (n.prohibited) return 4;                              // bikes not allowed
  if (n.limited_access && !rules.allowFreeways) return 4;  // freeway gate

  // Dedicated bike infrastructure: the infra type IS the rating (cycleway = 1,
  // bike lane = 2). The car-speed/shoulder rules don't apply to it.
  if (n.infra) return n.baseScore == null ? 0 : n.baseScore;

  const spd = n.maxspeed_num;
  // Pessimistic option: an unknown shoulder counts as 0 ft, so fast roads must
  // PROVE an adequate shoulder to pass. Slow roads are unaffected (free-speed
  // rule below fires first) and so are roads with a bike facility.
  const sh = n.shoulder_width == null && rules.unknownShoulderZero ? 0 : n.shoulder_width;

  // Slow enough → comfortable regardless of shoulder.
  if (spd != null && spd <= rules.freeMaxSpeed) return 1;

  // Hard gates. Each fails ONLY when we have data proving the violation
  // (with the pessimistic option, "unknown = 0 ft" counts as data).
  const shoulderFails = !n.good_facility && sh != null && sh < rules.minShoulder;
  const speedFails = !rules.noUpperLimit && spd != null && spd > rules.upperMaxSpeed;
  if (shoulderFails || speedFails) return 4;

  // No usable data on any criterion → unknown.
  if (spd == null && sh == null && !n.good_facility) return 0;

  return 2; // meets your criteria
}

/* ------------------------------------------------ data-source registry */
// zRank controls draw order: higher ranks render on top of lower ones.
const SOURCES = [
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
    id: 'roads',
    name: 'All roads (OSM, est. speeds)',
    // Vector tiles: the browser fetches only the small tiles in view, so this
    // layer no longer loads 78MB of GeoJSON into memory (it was crashing iOS).
    vector: 'pmtiles://data/roads.pmtiles',
    sourceLayer: 'roads',
    count: 323581, // baked at build time (tiles don't carry a global count)
    scorer: scoreRoad,
    zRank: 0,      // bottom: authoritative layers draw on top
    expr: true,    // scored via map expressions (works identically on tiles)
    enabled: false, // opt-in
    fc: null,
    loading: false,
  },
];

// Level as a MapLibre expression for expression-scored sources. Mirrors
// effectiveLevel() for road props (speed always present; flags optional).
// Rules are baked in as constants — on any rule change we rebuild the
// expression and re-apply paint/filters, which is instant at any data size.
function roadLevelExpr() {
  const spd = ['get', 's'];
  const cases = [];
  cases.push(['==', ['get', 'b'], 1], 4);                       // bikes prohibited
  if (!rules.allowFreeways) cases.push(['==', ['get', 'm'], 1], 4); // freeway gate
  cases.push(['<=', spd, rules.freeMaxSpeed], 1);               // slow = comfortable
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
  center: [-120.5, 47.4], // Washington State
  zoom: 6.4,
  maxZoom: 17,
});
// PMTiles: static single-file vector tiles over HTTP range requests — no server.
if (window.pmtiles) {
  const _pmProtocol = new pmtiles.Protocol();
  maplibregl.addProtocol('pmtiles', _pmProtocol.tile);
}
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
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

function rescoreAll() {
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
  if (routing.ready && routing.start && routing.end) computeRoute();
}

// Coalesce rapid rule changes (e.g. slider drags) into one recolor per frame.
let _rescorePending = false;
function scheduleRescore() {
  if (_rescorePending) return;
  _rescorePending = true;
  requestAnimationFrame(() => {
    _rescorePending = false;
    rescoreAll();
  });
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
  return map.getLayer('route-casing') ? 'route-casing' : undefined;
}

function ensureLayer(src) {
  if (map.getLayer(src.id)) return;
  const beforeId = beforeIdFor(src);
  if (src.vector) map.addSource(src.id, { type: 'vector', url: src.vector });
  else map.addSource(src.id, { type: 'geojson', data: src.fc });
  const SL = src.vector ? { 'source-layer': src.sourceLayer } : {};
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
  const on = src.enabled;
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
  // Optional declutter: drop neighborhood streets from the All-roads layer.
  const hideRes = display.hideResidential && src.id === 'roads';
  // Dedup: while the (data-rich) WSDOT source is on, hide its state highways
  // from the All-roads layer (d=1) — otherwise OSM's unknown-shoulder "pass"
  // would visually mask WSDOT's measured verdict on the same physical road.
  const dedup = src.id === 'roads' && SOURCES.find((s) => s.id === 'blts').enabled;
  const and = (f) => {
    const conds = [f];
    if (hideRes) conds.push(['!=', ['get', 'h'], 'residential'], ['!=', ['get', 'h'], 'living_street']);
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
  startMarker: null, endMarker: null,
  worker: null, ready: false, loading: false,
  mode: 'balanced', // 'direct' | 'balanced' | 'low'
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
    const res = await fetch('data/graph2.bin.gz');
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
function fmtDur(s) {
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} m`;
}

function renderRouteCard(m) {
  const card = document.getElementById('routeCard');
  if (!card) return;
  if (!m) {
    card.innerHTML = `<div class="rc-empty">Tap <b>A</b> on the map bar, then tap
      your start point. Tap <b>B</b> for the destination. Routes follow your
      riding rules and chosen mode, entirely on this device.</div>`;
    return;
  }
  if (!m.ok) {
    card.innerHTML = `<div class="rc-empty">${m.reason}</div>`;
    return;
  }
  const warn = m.failM > 0
    ? `<div class="rc-warn">⚠ ${fmtMi(m.failM)} mi on roads that fail your rules</div>`
    : `<div class="rc-sub" style="color:#00795c;font-weight:600">✓ Entirely within your riding rules</div>`;
  const ferry = m.ferryM > 0
    ? `<div class="rc-sub">⛴ ${fmtMi(m.ferryM)} mi by ferry (crossing + typical wait included)</div>`
    : '';
  card.innerHTML = `
    <div class="rc-main">${fmtMi(m.distM)} mi <small>· ${fmtDur(m.timeS)}</small></div>
    <div class="rc-sub">↗ ${fmtFt(m.ascentM)} ft climb · ↘ ${fmtFt(m.descentM)} ft descent</div>
    ${ferry}
    ${warn}
    <canvas id="profileCv"></canvas>`;
  drawProfile(m.profile, m.distM);
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
    renderRouteCard(m);
    if (!m.ok) {
      drawRoute([]);
      setRouteStatus(m.reason);
      return;
    }
    drawRoute(m.coords, m.ferrySegs);
    setRouteStatus(`${fmtMi(m.distM)} mi · ${fmtDur(m.timeS)}`);
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
  routing.worker.postMessage({
    type: 'route', id: routing.reqId,
    start: routing.start, end: routing.end,
    rules: { ...rules }, mode: routing.mode,
  });
}

function drawRoute(coords, ferrySegs) {
  const data = { type: 'Feature', properties: {},
    geometry: { type: 'LineString', coordinates: coords } };
  // Ferry legs are drawn as white dashes on top of the route line, so the
  // crossing reads as "not riding" at a glance.
  const fdata = { type: 'FeatureCollection', features: (ferrySegs || []).map((c) => ({
    type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c } })) };
  const srcExisting = map.getSource('route');
  if (srcExisting) {
    srcExisting.setData(data);
    map.getSource('route-ferry').setData(fdata);
    return;
  }
  map.addSource('route', { type: 'geojson', data });
  map.addSource('route-ferry', { type: 'geojson', data: fdata });
  map.addLayer({
    id: 'route-casing', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.85 },
  });
  map.addLayer({
    id: 'route', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#7b2cbf', 'line-width': 5, 'line-opacity': 0.9 },
  });
  map.addLayer({
    id: 'route-ferry', type: 'line', source: 'route-ferry',
    paint: { 'line-color': '#ffffff', 'line-width': 5, 'line-opacity': 0.9,
             'line-dasharray': [0.6, 1.8] },
  });
}

function setRoutePoint(kind, lngLat) {
  routing[kind] = [lngLat.lng, lngLat.lat];
  const mk = kind + 'Marker';
  if (routing[mk]) routing[mk].setLngLat(lngLat);
  else {
    routing[mk] = new maplibregl.Marker({
      color: kind === 'start' ? '#009E73' : '#d7191c', draggable: true,
    }).setLngLat(lngLat).addTo(map);
    routing[mk].on('dragend', () => {
      const ll = routing[mk].getLngLat();
      routing[kind] = [ll.lng, ll.lat];
      computeRoute();
    });
  }
  computeRoute();
}

function clearRoute() {
  routing.arm = null;
  routing.start = routing.end = null;
  for (const k of ['startMarker', 'endMarker']) {
    if (routing[k]) { routing[k].remove(); routing[k] = null; }
  }
  drawRoute([]);
  routing.last = null;
  renderRouteCard(null);
  setRouteStatus('');
  updateArmButtons();
}

function updateArmButtons() {
  for (const kind of ['start', 'end']) {
    for (const prefix of ['rt-', 'rb-']) {
      const b = document.getElementById(prefix + kind);
      if (b) b.classList.toggle('active', routing.arm === kind);
    }
  }
}

const MODES = [
  ['direct', 'Direct', 'Fastest ride, even if stressful'],
  ['balanced', 'Balanced', 'Avoids bad roads when the detour is reasonable'],
  ['low', 'Low-stress', 'Only roads that pass your rules'],
];

function buildRoutingPanel() {
  const chips = document.getElementById('modeChips');
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

  renderRouteCard(null);

  const host = document.getElementById('routing');
  host.innerHTML = `
    <div class="route-actions">
      <button id="rt-start">Set start</button>
      <button id="rt-end">Set end</button>
      <button id="rt-clear">Clear</button>
    </div>
    <div class="hint" id="route-status" style="margin-top:8px"></div>`;

  const arm = (kind) => {
    routing.arm = routing.arm === kind ? null : kind;
    updateArmButtons();
    ensureRouter(); // prefetch the graph on first interest
    if (routing.arm) {
      setSheet('peek'); // get the sheet out of the way for the map tap
      setRouteStatus(`Tap the map to place ${kind === 'start' ? 'START' : 'END'}`);
    } else {
      setRouteStatus('');
    }
  };
  for (const kind of ['start', 'end']) {
    document.getElementById('rb-' + kind).addEventListener('click', () => arm(kind));
    document.getElementById('rt-' + kind).addEventListener('click', () => arm(kind));
  }
  document.getElementById('rb-clear').addEventListener('click', clearRoute);
  document.getElementById('rt-clear').addEventListener('click', clearRoute);
}

/* ---------------------------------------------- hover/click readout */
const readoutEl = document.getElementById('readout');
const LEVEL_NAME = { 0: 'unknown', 1: 'Low', 2: 'Moderate', 3: 'High', 4: 'Very high' };

// Plain-language reason for a segment's verdict under the current rules.
// Mirrors effectiveLevel()'s hard-gate branches so the readout explains why.
function explainLevel(n) {
  if (n.prohibited)
    return n.wsdotBan
      ? 'Bikes prohibited — WSDOT permanent restriction.'
      : 'Bikes prohibited — OSM-tagged (bicycle=no/dismount).';
  if (n.infra)
    return n.baseScore === 1
      ? 'Dedicated or protected bike path — low stress.'
      : n.baseScore === 2
      ? 'Bike lane or shared path — moderate.'
      : 'Bike infrastructure.';
  if (n.limited_access && !rules.allowFreeways)
    return 'Limited-access highway — turn on “Allow freeways” to include it.';

  const spd = n.maxspeed_num;
  const shRaw = n.shoulder_width;
  const shUnknown = shRaw == null;
  const sh = shUnknown && rules.unknownShoulderZero ? 0 : shRaw;
  const spdTxt = spd != null ? `${spd} mph${n.est ? ' (est.)' : ''}` : null;
  if (spd != null && spd <= rules.freeMaxSpeed)
    return `${spdTxt} ≤ your “free” ${rules.freeMaxSpeed} mph — comfortable regardless of shoulder.`;

  const shoulderFails = !n.good_facility && sh != null && sh < rules.minShoulder;
  const speedFails = !rules.noUpperLimit && spd != null && spd > rules.upperMaxSpeed;
  const reasons = [];
  if (speedFails) reasons.push(`${spdTxt} is over your ${rules.upperMaxSpeed} mph max`);
  if (shoulderFails)
    reasons.push(shUnknown
      ? `shoulder unknown — treated as 0 ft, under your ${rules.minShoulder} ft minimum`
      : `${sh} ft shoulder is under your ${rules.minShoulder} ft minimum`);
  if (reasons.length) return `Fails: ${reasons.join(' and ')}.`;

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
        ? `${spdTxt} — speed not capped (“No upper limit” is on)`
        : `${spdTxt} within your ${rules.upperMaxSpeed} mph max`
    );
  return `Meets your criteria — ${met.join(', ')}.`;
}

const HIT_LAYERS = [];  // hit-layer ids, registered as sources attach
const HIT_SRC = {};     // hit-layer id -> its source
// Clicking/tapping PINS the readout (so its links are clickable); hovering
// only previews and never replaces a pinned readout.
let readoutPinned = false;

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

function renderReadout(feature, lngLat) {
  const src = HIT_SRC[feature.layer.id];
  const p = feature.properties;
  const n = src.scorer(p);            // recompute normalized props from this feature
  const lvl = p.level != null ? p.level : effectiveLevel(n); // expr sources carry no .level
  const verdict = lvl === 0 ? 'no data' : lvl <= display.passMax ? '✓ Pass' : '✗ Fail';
  const common = [
    ['Result', verdict],
    ['Stress', lvl === 0 ? 'unknown' : `${lvl} — ${LEVEL_NAME[lvl]}`],
    ['Why', explainLevel(n)],
  ];
  let title, rows;
  if (src.id === 'restrict') {
    title = 'Bikes prohibited (WSDOT)';
    rows = [
      ['Route', p.Route ? 'SR ' + String(p.Route).replace(/^0+/, '') : p.RouteIdentifier],
      ['Result', '✗ Prohibited'],
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
  rows = rows.filter(([, v]) => v != null && v !== '');
  // maps.google.com/?q= is the most universally handled form (opens the
  // Google Maps app via universal link on iOS, web elsewhere).
  const gmaps = `https://maps.google.com/?q=${lngLat.lat.toFixed(6)},${lngLat.lng.toFixed(6)}`;
  readoutEl.innerHTML =
    `<div class="rt-title">${title}</div><table>` +
    rows.map(([k, v]) => `<tr><td class="k">${k}</td><td>${v}</td></tr>`).join('') +
    '</table>' +
    `<a class="gmap" href="${gmaps}" target="_blank" rel="noopener">Open in Google Maps ↗</a>`;
  // iOS standalone PWAs don't reliably honor target=_blank; open explicitly.
  readoutEl.querySelector('.gmap').addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const w = window.open(gmaps, '_blank', 'noopener');
    if (!w) location.href = gmaps; // popup blocked — navigate instead
  });
  readoutEl.classList.add('show');
}

// ONE global handler pair (per-layer handlers raced where layers overlap).
map.on('mousemove', (e) => {
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
  routing.arm = null;
  updateArmButtons();
  readoutPinned = false;
  readoutEl.classList.remove('show'); // don't leave a stale road popup up
  setRoutePoint(kind, lngLat);
  if (!(routing.start && routing.end)) {
    // confirm the placement; with only one point there's no route yet
    setRouteStatus(kind === 'start' ? 'Start set — tap B to place the end'
      : 'End set — tap A to place the start');
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
      const rect = map.getCanvas().getBoundingClientRect();
      const lngLat = map.unproject([t.clientX - rect.left, t.clientY - rect.top]);
      placeArmedPoint(lngLat);
    }
  }, { passive: true });
})();

map.on('click', (e) => {
  if (routing.arm) {
    placeArmedPoint(e.lngLat);
    return;
  }
  if (Date.now() - lastPlacementTs < 600) return; // click synthesized from the placement touch
  const f = featureAt(e.point);
  if (f) {
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
  const host = document.getElementById('rules');

  const slider = (key, label, hint, min, max, step, unit) => {
    const wrap = document.createElement('div');
    wrap.className = 'rule';
    wrap.innerHTML = `
      <div class="rule-head">
        <label for="r-${key}">${label}</label>
        <span class="val" id="v-${key}">${rules[key]}${unit}</span>
      </div>
      <div class="hint">${hint}</div>
      <input type="range" id="r-${key}" min="${min}" max="${max}" step="${step}" value="${rules[key]}">`;
    host.appendChild(wrap);
    const input = wrap.querySelector('input');
    input.addEventListener('input', () => {
      rules[key] = Number(input.value);
      document.getElementById(`v-${key}`).textContent = rules[key] + unit;
      scheduleRescore();
    });
  };

  const check = (key, label, hint) => {
    const wrap = document.createElement('div');
    wrap.className = 'check-rule';
    wrap.innerHTML = `
      <input type="checkbox" id="r-${key}" ${rules[key] ? 'checked' : ''}>
      <label for="r-${key}">${label}</label>`;
    if (hint) {
      const h = document.createElement('div');
      h.className = 'hint';
      h.style.width = '100%';
      h.textContent = hint;
      wrap.appendChild(h);
    }
    host.appendChild(wrap);
    wrap.querySelector('input').addEventListener('change', (e) => {
      rules[key] = e.target.checked;
      scheduleRescore();
    });
  };

  check('allowFreeways', 'Allow freeways', 'Ride limited-access highway shoulders where legal.');
  slider('minShoulder', 'Minimum shoulder', 'Roads with a shoulder narrower than this fail.', 0, 10, 1, ' ft');
  check('unknownShoulderZero', 'Unknown shoulder treated as 0 ft',
    'Fast roads must have shoulder data to pass. Off: unknown isn’t held against a road.');
  slider('freeMaxSpeed', 'Comfortable at or below', 'Traffic at this speed is fine regardless of shoulder.', 15, 40, 5, ' mph');
  slider('upperMaxSpeed', 'Avoid roads faster than', 'Above this a road fails — unless “No speed cutoff” is on.', 35, 65, 5, ' mph');
  check('noUpperLimit', 'No speed cutoff', 'Don’t fail roads on speed alone (shoulder rule still applies).');
}

function buildDisplayPanel() {
  const host = document.getElementById('display');
  const add = (key, label, hint) => {
    const wrap = document.createElement('div');
    wrap.className = 'check-rule';
    wrap.innerHTML = `
      <input type="checkbox" id="d-${key}" ${display[key] ? 'checked' : ''}>
      <label for="d-${key}">${label}</label>
      <div class="hint" style="width:100%">${hint}</div>`;
    host.appendChild(wrap);
    wrap.querySelector('input').addEventListener('change', (e) => {
      display[key] = e.target.checked;
      applyDisplayModeAll();
    });
  };
  add('passFail', 'Pass/fail mode',
    `Green = meets your criteria. Roads with data that don't qualify show as
     gray dashed (hover any road for why). Updates live with the riding rules.`);
  add('hideResidential', 'Hide residential streets',
    'Declutter the All-roads layer: hide neighborhood streets (residential / living street).');
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
buildDisplayPanel();
buildLegend();

// Tabs.
document.querySelectorAll('#tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach((t) =>
      t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
    if (document.body.className.includes('sheet-peek')) setSheet('half');
  });
});

// Bottom-sheet states (mobile only; CSS ignores these classes on desktop).
const SHEET_STATES = ['peek', 'half', 'full'];
function setSheet(state) {
  document.body.classList.remove(...SHEET_STATES.map((s) => 'sheet-' + s));
  document.body.classList.add('sheet-' + state);
}
(() => {
  // Grip: drag to resize (snaps to peek/half/full on release); a plain tap
  // still cycles through the states.
  const grip = document.getElementById('sheetGrip');
  const panel = document.getElementById('panel');
  let drag = null;
  const stateHeights = () => {
    const vh = window.innerHeight;
    return { peek: 92, half: vh * 0.47, full: vh - 74 };
  };
  grip.addEventListener('pointerdown', (e) => {
    drag = { y0: e.clientY, h0: panel.getBoundingClientRect().height, moved: false };
    document.body.classList.add('sheet-dragging');
    grip.setPointerCapture(e.pointerId);
  });
  grip.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = drag.y0 - e.clientY;
    if (Math.abs(dy) > 6) drag.moved = true;
    const H = stateHeights();
    const h = Math.max(H.peek, Math.min(H.full, drag.h0 + dy));
    panel.style.height = h + 'px';
  });
  const endDrag = (e) => {
    if (!drag) return;
    const wasDrag = drag.moved;
    drag = null;
    document.body.classList.remove('sheet-dragging');
    const h = panel.getBoundingClientRect().height;
    panel.style.height = '';
    const H = stateHeights();
    if (!wasDrag) {
      const cur = SHEET_STATES.find((s) => document.body.classList.contains('sheet-' + s)) || 'peek';
      setSheet(cur === 'peek' ? 'half' : cur === 'half' ? 'full' : 'peek');
      return;
    }
    // snap to the nearest state
    const d = (a) => Math.abs(h - a);
    setSheet(d(H.peek) <= d(H.half) && d(H.peek) <= d(H.full) ? 'peek'
      : d(H.half) <= d(H.full) ? 'half' : 'full');
  };
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);
})();

// Footer: version stamp, share, and in-app update (standalone PWAs have no
// browser chrome, so the app provides its own).
document.getElementById('appVersion').textContent = 'v' + APP_VERSION;
document.getElementById('shareBtn').addEventListener('click', async () => {
  const url = 'https://nothinglabs.github.io/clauding/';
  if (navigator.share) {
    try { await navigator.share({ title: 'WA Bike Safety', url }); } catch (e) { /* cancelled */ }
  } else {
    try { await navigator.clipboard.writeText(url); setStatus('Link copied'); }
    catch (e) { setStatus(url, true); }
  }
});
document.getElementById('updateBtn').addEventListener('click', async () => {
  setStatus('Checking for update…', true);
  try {
    const reg = await (navigator.serviceWorker && navigator.serviceWorker.getRegistration());
    if (reg) await reg.update();
  } catch (e) { /* offline etc. */ }
  location.reload();
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
