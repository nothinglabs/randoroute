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
  [1, 'Low stress (safest)'],
  [2, 'Moderate'],
  [3, 'High'],
  [4, 'Very high (avoid)'],
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
  };
}

/* --------------------------------------------- source-agnostic scorer */
// "Your criteria decide": stress is computed from the road's own attributes
// (speed, shoulder/facility, freeway status) against the current riding rules.
// WSDOT's precomputed rating is NOT a floor — relaxing the rules lets more
// roads pass, tightening lets fewer. Returns effective level 0 (unknown) or 1..4.
function effectiveLevel(n) {
  if (n.prohibited) return 4;                              // bikes not allowed
  if (n.limited_access && !rules.allowFreeways) return 4;  // freeway gate

  const adequate =
    (n.shoulder_width != null && n.shoulder_width >= rules.minShoulder) || n.good_facility;
  const spd = n.maxspeed_num;

  if (spd == null) {
    // No speed data. If we also have no shoulder/facility signal, defer to
    // WSDOT's rating (or unknown); otherwise judge on shoulder alone.
    if (n.shoulder_width == null && !n.good_facility) return n.baseScore == null ? 0 : n.baseScore;
    return adequate ? 2 : 3;
  }

  if (spd <= rules.freeMaxSpeed) return 1;   // slow enough to be comfortable regardless of shoulder
  if (adequate) return 2;                    // faster, but has an adequate shoulder / bike facility

  // Faster than "free" speed AND no adequate shoulder:
  if (spd <= rules.upperMaxSpeed) return 3;  // high stress
  return rules.noUpperLimit ? 3 : 4;         // above the upper cap => avoid, unless the cap is disabled
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
  // Phase 2 will push a second entry here (OSM bike infra) — same shape.
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

// Plain-language reason for a segment's effective level under the current rules.
// Mirrors effectiveLevel()'s branches so the readout explains exactly why.
function explainLevel(n) {
  if (n.prohibited) return 'Bikes are not permitted here.';
  if (n.limited_access && !rules.allowFreeways)
    return 'Limited-access highway — turn on “Allow freeways” to include it.';
  const adequate =
    (n.shoulder_width != null && n.shoulder_width >= rules.minShoulder) || n.good_facility;
  const spd = n.maxspeed_num;
  if (spd == null) {
    if (n.shoulder_width == null && !n.good_facility)
      return n.baseScore == null
        ? 'No speed or shoulder data for this segment.'
        : `No speed data; falling back to WSDOT rating (BLTS ${n.baseScore}).`;
    return adequate
      ? 'No speed data; shoulder/facility meets your minimum.'
      : `No speed data; shoulder under your ${rules.minShoulder} ft minimum.`;
  }
  if (spd <= rules.freeMaxSpeed)
    return `${spd} mph ≤ your “free” ${rules.freeMaxSpeed} mph — comfortable regardless of shoulder.`;
  if (adequate) {
    const via = n.good_facility
      ? 'has a bike facility'
      : `${n.shoulder_width} ft shoulder ≥ your ${rules.minShoulder} ft`;
    return `${spd} mph, but ${via} — moderate.`;
  }
  const sh = n.shoulder_width == null ? 'no shoulder data' : `${n.shoulder_width} ft shoulder < your ${rules.minShoulder} ft`;
  if (spd <= rules.upperMaxSpeed)
    return `${spd} mph over your “free” ${rules.freeMaxSpeed} mph, ${sh} — high stress.`;
  if (rules.noUpperLimit)
    return `${spd} mph over your upper ${rules.upperMaxSpeed} mph, ${sh} (hard cap off) — high stress.`;
  return `${spd} mph over your upper max ${rules.upperMaxSpeed} mph, ${sh} — avoid.`;
}

function attachHover(src, layerId) {
  map.on('mousemove', layerId, (e) => {
    map.getCanvas().style.cursor = 'pointer';
    const p = e.features[0].properties;
    const n = src.scorer(p);            // recompute normalized props from this feature
    const lvl = p.level;
    const verdict = lvl === 0 ? 'no data' : lvl <= display.passMax ? '✓ Pass' : '✗ Fail';
    const rows = [
      ['Route', p.RouteIdentifier],
      ['Result', verdict],
      ['Stress', lvl === 0 ? 'unknown' : `${lvl} — ${LEVEL_NAME[lvl]}`],
      ['Why', explainLevel(n)],
      ['BLTS (WSDOT)', p.LTS_Bicycle],
      ['Speed limit', p.SpeedLimit != null ? p.SpeedLimit + ' mph' : null],
      ['Lanes', p.LaneCount],
      ['AADT', p.AADT != null ? Number(p.AADT).toLocaleString() : null],
      ['Shoulder', p.ShoulderWidth != null ? p.ShoulderWidth + ' ft' : null],
      ['Bike facility', p.BikeFacilityType],
      ['Limited access', p.LimitedAccess ? 'yes' : null],
    ].filter(([, v]) => v != null && v !== '');
    readoutEl.innerHTML =
      '<div class="rt-title">Segment</div><table>' +
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
  slider('minShoulder', 'Min shoulder width', 'Narrower shoulders get penalized (missing = below).', 0, 10, 1, ' ft');
  slider('freeMaxSpeed', '“Free” max speed', 'At/below this, comfortable regardless of shoulder.', 15, 40, 5, ' mph');
  slider('upperMaxSpeed', 'Upper max speed', 'Above this, high-stress unless shoulder/facility is adequate.', 35, 65, 5, ' mph');
  check('noUpperLimit', 'No upper limit', 'Disable the high-speed hard cap (compute a level instead of auto-4).');
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
