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
  [4, 'Fails a criterion (avoid)'],
  [0, 'Unknown / no data'],
];

/* ------------------------------------------------- riding-rules state */
const rules = {
  allowFreeways: false, // show limited-access/high-speed roads as rideable at all?
  minShoulder: 4,       // ft; below this a road gets penalized
  freeMaxSpeed: 25,     // mph; at/below this a road is comfortable regardless of shoulder
  upperMaxSpeed: 45,    // mph; above this it's high-stress unless shoulder/facility is adequate
  noUpperLimit: false,  // disable the upper-speed hard cap
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
    prohibited: false,
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
  const sh = n.shoulder_width;

  // Slow enough → comfortable regardless of shoulder.
  if (spd != null && spd <= rules.freeMaxSpeed) return 1;

  // Hard gates. Each fails ONLY when we have data proving the violation.
  const shoulderFails = !n.good_facility && sh != null && sh < rules.minShoulder;
  const speedFails = !rules.noUpperLimit && spd != null && spd > rules.upperMaxSpeed;
  if (shoulderFails || speedFails) return 4;

  // No usable data on any criterion → unknown.
  if (spd == null && sh == null && !n.good_facility) return 0;

  return 2; // meets your criteria
}

/* ------------------------------------------------ data-source registry */
const SOURCES = [
  {
    id: 'blts',
    name: 'WSDOT BLTS (state highways)',
    url: 'data/blts.geojson',
    scorer: scoreBLTS,
    enabled: true,
    fc: null,     // cached FeatureCollection (loaded once)
    loading: false,
  },
  {
    id: 'osm',
    name: 'OSM bike infrastructure',
    url: 'data/bikeinfra.geojson',
    scorer: scoreOSM,
    enabled: true,
    fc: null,
    loading: false,
  },
];

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
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
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
  for (const src of SOURCES) if (src.enabled && src.fc) rescore(src);
  const ms = Math.round(performance.now() - t0);
  if (ms > 0) setStatus(`Recolored in ${ms} ms`);
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

function ensureLayer(src) {
  if (map.getLayer(src.id)) return;
  map.addSource(src.id, { type: 'geojson', data: src.fc });
  // Two dashed overlays are added first so the solid main layer draws on top
  // where lines overlap. Each is shown in only one display mode.
  map.addLayer({
    id: failId(src), // pass/fail mode: roads with data that don't qualify
    type: 'line',
    source: src.id,
    layout: { 'line-cap': 'butt', 'line-join': 'round', visibility: 'none' },
    paint: {
      'line-color': FAIL_COLOR,
      'line-dasharray': [2, 2],
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.8, 10, 1.4, 14, 2.6],
      'line-opacity': 0.65,
    },
    filter: ['all', ['>=', ['get', 'level'], display.passMax + 1], ['<=', ['get', 'level'], 4]],
  });
  map.addLayer({
    id: vhId(src), // color-ramp mode: level 4 shown dashed to read as "not passable"
    type: 'line',
    source: src.id,
    layout: { 'line-cap': 'butt', 'line-join': 'round', visibility: 'none' },
    paint: {
      'line-color': COLORS[4],
      'line-dasharray': [2, 1.5],
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.1, 10, 1.9, 14, 3.7],
      'line-opacity': 0.9,
    },
    filter: ['==', ['get', 'level'], 4],
  });
  map.addLayer({
    id: src.id,
    type: 'line',
    source: src.id,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': colorExpr(),
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.1, 10, 1.9, 14, 3.7],
      'line-opacity': 0.9,
    },
  });
  applyDisplayMode(src);
  attachHover(src, src.id);
  attachHover(src, failId(src));
  attachHover(src, vhId(src));
}

// Main layer follows the source toggle; the two dashed overlays are each shown
// in exactly one display mode.
function updateVisibility(src) {
  const on = src.enabled;
  if (map.getLayer(src.id)) map.setLayoutProperty(src.id, 'visibility', on ? 'visible' : 'none');
  if (map.getLayer(failId(src)))
    map.setLayoutProperty(failId(src), 'visibility', on && display.passFail ? 'visible' : 'none');
  if (map.getLayer(vhId(src)))
    map.setLayoutProperty(vhId(src), 'visibility', on && !display.passFail ? 'visible' : 'none');
}

// Switch a source between the color-ramp view (level 4 dashed) and the green
// pass/fail view (gray-dashed fail overlay).
function applyDisplayMode(src) {
  if (!map.getLayer(src.id)) return;
  if (display.passFail) {
    map.setFilter(src.id, ['all', ['>=', ['get', 'level'], 1], ['<=', ['get', 'level'], display.passMax]]);
    map.setPaintProperty(src.id, 'line-color', PASS_COLOR);
    map.setPaintProperty(src.id, 'line-opacity', 0.95);
    map.setPaintProperty(src.id, 'line-width', ['interpolate', ['linear'], ['zoom'], 6, 1.4, 10, 2.6, 14, 5]);
  } else {
    // Solid ramp for levels 1-3 (and unknown); level 4 goes to the dashed vh layer.
    map.setFilter(src.id, ['!=', ['get', 'level'], 4]);
    map.setPaintProperty(src.id, 'line-color', colorExpr());
    map.setPaintProperty(src.id, 'line-opacity', 0.9);
    map.setPaintProperty(src.id, 'line-width', ['interpolate', ['linear'], ['zoom'], 6, 1.1, 10, 1.9, 14, 3.7]);
  }
  updateVisibility(src);
}

function applyDisplayModeAll() {
  for (const src of SOURCES) applyDisplayMode(src);
  buildLegend();
}

async function loadSource(src) {
  if (src.fc || src.loading) return;
  src.loading = true;
  setStatus(`Loading ${src.name}…`, true);
  const res = await fetch(src.url);
  if (!res.ok) {
    setStatus(`Failed to load ${src.name} (${res.status})`, true);
    src.loading = false;
    return;
  }
  src.fc = await res.json();
  src.loading = false;
  rescore(src);      // sets .level on every feature
  ensureLayer(src);
  setStatus(`${src.name}: ${src.fc.features.length.toLocaleString()} segments`);
  updateSourceCount(src);
}

function setSourceVisible(src, on) {
  src.enabled = on;
  if (on && !src.fc) return loadSource(src);
  if (on && !map.getLayer(src.id)) return ensureLayer(src);
  updateVisibility(src);
}

/* ---------------------------------------------- hover/click readout */
const readoutEl = document.getElementById('readout');
const LEVEL_NAME = { 0: 'unknown', 1: 'Low', 2: 'Moderate', 3: 'High', 4: 'Very high' };

// Plain-language reason for a segment's verdict under the current rules.
// Mirrors effectiveLevel()'s hard-gate branches so the readout explains why.
function explainLevel(n) {
  if (n.prohibited) return 'Bikes not allowed / must dismount here.';
  if (n.infra)
    return n.baseScore === 1
      ? 'Dedicated or protected bike path — low stress.'
      : n.baseScore === 2
      ? 'Bike lane or shared path — moderate.'
      : 'Bike infrastructure.';
  if (n.limited_access && !rules.allowFreeways)
    return 'Limited-access highway — turn on “Allow freeways” to include it.';

  const spd = n.maxspeed_num;
  const sh = n.shoulder_width;
  if (spd != null && spd <= rules.freeMaxSpeed)
    return `${spd} mph ≤ your “free” ${rules.freeMaxSpeed} mph — comfortable regardless of shoulder.`;

  const shoulderFails = !n.good_facility && sh != null && sh < rules.minShoulder;
  const speedFails = !rules.noUpperLimit && spd != null && spd > rules.upperMaxSpeed;
  const reasons = [];
  if (speedFails) reasons.push(`${spd} mph is over your ${rules.upperMaxSpeed} mph max`);
  if (shoulderFails) reasons.push(`${sh} ft shoulder is under your ${rules.minShoulder} ft minimum`);
  if (reasons.length) return `Fails: ${reasons.join(' and ')}.`;

  if (spd == null && sh == null && !n.good_facility)
    return 'No speed or shoulder data for this segment.';

  const met = [];
  if (n.good_facility) met.push('has a bike facility');
  else if (sh != null) met.push(`${sh} ft shoulder ≥ your ${rules.minShoulder} ft`);
  else met.push('shoulder unknown (not held against it)');
  if (spd != null) met.push(`${spd} mph within your ${rules.upperMaxSpeed} mph max`);
  return `Meets your criteria — ${met.join(', ')}.`;
}

function attachHover(src, layerId) {
  map.on('mousemove', layerId, (e) => {
    map.getCanvas().style.cursor = 'pointer';
    const p = e.features[0].properties;
    const n = src.scorer(p);            // recompute normalized props from this feature
    const lvl = p.level;
    const verdict = lvl === 0 ? 'no data' : lvl <= display.passMax ? '✓ Pass' : '✗ Fail';
    const common = [
      ['Result', verdict],
      ['Stress', lvl === 0 ? 'unknown' : `${lvl} — ${LEVEL_NAME[lvl]}`],
      ['Why', explainLevel(n)],
    ];
    let title, rows;
    if (src.id === 'osm') {
      title = 'Bike infrastructure (OSM)';
      rows = [
        ['Name', p.name],
        ...common,
        ['Type', [p.highway, p.bicycle ? `bicycle=${p.bicycle}` : null].filter(Boolean).join(', ')],
        ['Cycleway', osmCycleway(p)],
        ['Surface', p.surface],
        ['Width', p.width != null ? `${p.width} m` : null],
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
      ];
    }
    rows = rows.filter(([, v]) => v != null && v !== '');
    readoutEl.innerHTML =
      `<div class="rt-title">${title}</div><table>` +
      rows.map(([k, v]) => `<tr><td class="k">${k}</td><td>${v}</td></tr>`).join('') +
      '</table>';
    readoutEl.classList.add('show');
  });
  map.on('mouseleave', layerId, () => {
    map.getCanvas().style.cursor = '';
    readoutEl.classList.remove('show');
  });
}

/* ----------------------------------------------------- build panels */
function updateSourceCount(src) {
  const el = document.querySelector(`#src-${src.id} .count`);
  if (el && src.fc) el.textContent = src.fc.features.length.toLocaleString();
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

  check('allowFreeways', 'Allow freeways', 'Show limited-access / high-speed highways as rideable.');
  slider('minShoulder', 'Min shoulder width', 'Known shoulder under this fails a road (unknown shoulder is not held against it).', 0, 10, 1, ' ft');
  slider('freeMaxSpeed', '“Free” max speed', 'At/below this, comfortable regardless of shoulder.', 15, 40, 5, ' mph');
  slider('upperMaxSpeed', 'Upper max speed', 'Above this a road fails (unless “No upper limit”).', 35, 65, 5, ' mph');
  check('noUpperLimit', 'No upper limit', 'Ignore the upper-speed limit — don’t fail roads for speed alone.');
}

function buildDisplayPanel() {
  const host = document.getElementById('display');
  const wrap = document.createElement('div');
  wrap.className = 'check-rule';
  wrap.innerHTML = `
    <input type="checkbox" id="d-passFail" ${display.passFail ? 'checked' : ''}>
    <label for="d-passFail">Pass/fail mode</label>
    <div class="hint" style="width:100%">
      Green = meets your criteria. Roads with data that don't qualify show as
      gray dashed (hover any road for why). Updates live with the riding rules.
    </div>`;
  host.appendChild(wrap);
  wrap.querySelector('input').addEventListener('change', (e) => {
    display.passFail = e.target.checked;
    applyDisplayModeAll();
  });
}

function buildLegend() {
  const host = document.getElementById('legend');
  host.innerHTML = '';
  const dash = (c) => `background:repeating-linear-gradient(90deg,${c} 0 4px,transparent 4px 8px)`;
  const rows = display.passFail
    ? [[PASS_COLOR, 'Meets your criteria (Low–Moderate)'],
       ['dashed', 'Has data — doesn’t meet criteria'],
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
buildDisplayPanel();
buildLegend();

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
