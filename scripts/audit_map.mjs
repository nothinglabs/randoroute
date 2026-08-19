#!/usr/bin/env node
/*
 * Draw an audited route on the REAL map.
 *
 * The companion plotter (scripts/audit_plot.py) draws a route as a bare
 * polyline, which is enough to rank shapes but not enough to judge them: a
 * reader cannot tell a legitimate detour around a lake from a wrong turn when
 * neither the lake nor the streets are on the page. This renders the same
 * route over the app's own basemap -- the same `BikeBasemap.createStyle()`,
 * the same PMTiles archives, the same fonts -- so what you see is what the
 * rider sees, with street names, water and parks underneath.
 *
 * Uses the state's own data through Region, so it works for any state in the
 * registry rather than a hardcoded one.
 *
 * Usage:
 *   node scripts/audit_map.mjs <route.json> [outDir] [--option=A]
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ROOT, serveRepo, launchBrowser } from './testlib/harness.mjs';

const PAGE = (stateId) => `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="/vendor/maplibre-gl.css">
<style>html,body,#map{margin:0;padding:0;width:100%;height:100%}</style>
</head><body><div id="map"></div>
<script>try { localStorage.setItem('jra-map-state-1', ${JSON.stringify(stateId)}); } catch (e) {}</script>
<script src="/maps/states.js"></script>
<script src="/region.js"></script>
<script src="/vendor/pmtiles.js"></script>
<script src="/vendor/maplibre-gl.js"></script>
<script src="/basemap-style.js"></script>
<script>
  window.__ready = false;
  BikeBasemap.ensureProtocol();
  window.map = new maplibregl.Map({
    container: 'map', style: BikeBasemap.createStyle(),
    center: Region.defaultCenter, zoom: 11, attributionControl: false,
    fadeDuration: 0, interactive: false,
  });
  map.on('load', () => { window.__ready = true; });
</script></body></html>`;

/** Draw one option and screenshot it. */
async function shoot(page, result, option, outPath, bbox) {
  const coords = option.coords;
  const m = option.metrics;
  // The measured backtrack, as its own feature, so the picture and the metric
  // cannot disagree about which stretch is the problem.
  let backtrack = null;
  if (m.backtrackM >= 50) {
    const R = 6371000, rad = (d) => (d * Math.PI) / 180;
    let along = 0;
    const slice = [];
    for (let i = 0; i < coords.length; i++) {
      if (i) {
        const [a, b] = [coords[i - 1], coords[i]];
        const dp = rad(b[1] - a[1]), dl = rad(b[0] - a[0]);
        const h = Math.sin(dp / 2) ** 2
          + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dl / 2) ** 2;
        along += 2 * R * Math.asin(Math.sqrt(h));
      }
      if (along >= m.backtrackAtM && along <= m.backtrackEndM) slice.push(coords[i]);
    }
    if (slice.length > 1) backtrack = slice;
  }

  // Failing stretches, in the app's own dark red. Level 4 is the verdict the
  // app draws as failing, so this is the same claim the road cards make.
  const failLines = [];
  for (const seg of option.segs || []) {
    if (seg.level !== 4) continue;
    const part = coords.slice(seg.c0, Math.min(seg.c1 + 1, coords.length));
    if (part.length > 1) failLines.push(part);
  }

  await page.evaluate(({ coords, backtrack, failLines, from, to, bbox }) => {
    for (const id of ['bt', 'fail', 'route', 'route-case', 'ends']) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    for (const id of ['s-route', 's-bt', 's-fail', 's-ends']) {
      if (map.getSource(id)) map.removeSource(id);
    }
    const line = (c) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: c } });
    map.addSource('s-route', { type: 'geojson', data: line(coords) });
    map.addLayer({ id: 'route-case', type: 'line', source: 's-route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 11, 'line-opacity': 0.95 } });
    map.addLayer({ id: 'route', type: 'line', source: 's-route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#1d4ed8', 'line-width': 6 } });
    if (failLines.length) {
      map.addSource('s-fail', { type: 'geojson', data: { type: 'FeatureCollection',
        features: failLines.map(line) } });
      map.addLayer({ id: 'fail', type: 'line', source: 's-fail',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#a81f1f', 'line-width': 6 } });
    }
    if (backtrack) {
      map.addSource('s-bt', { type: 'geojson', data: line(backtrack) });
      map.addLayer({ id: 'bt', type: 'line', source: 's-bt',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#111827', 'line-width': 2.5,
          'line-dasharray': [2, 1.6] } });
    }
    map.addSource('s-ends', { type: 'geojson', data: { type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { k: 'a' }, geometry: { type: 'Point', coordinates: from } },
      { type: 'Feature', properties: { k: 'b' }, geometry: { type: 'Point', coordinates: to } },
    ] } });
    map.addLayer({ id: 'ends', type: 'circle', source: 's-ends',
      paint: { 'circle-radius': 9,
        'circle-color': ['case', ['==', ['get', 'k'], 'a'], '#16a34a', '#ea580c'],
        'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } });

    if (bbox) {
      map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
        { padding: 40, duration: 0, maxZoom: 19 });
      return;
    }
    const lons = coords.map((c) => c[0]).concat(from[0], to[0]);
    const lats = coords.map((c) => c[1]).concat(from[1], to[1]);
    map.fitBounds([[Math.min(...lons), Math.min(...lats)],
      [Math.max(...lons), Math.max(...lats)]],
    { padding: 60, duration: 0, maxZoom: 16 });
  }, { coords, backtrack, failLines, from: result.from, to: result.to, bbox });

  // Tiles for the new viewport have to arrive before the shot; `idle` fires
  // when MapLibre has nothing left to load or draw.
  await page.evaluate(() => new Promise((resolve) => {
    if (map.loaded() && map.areTilesLoaded()) { map.once('idle', resolve); setTimeout(resolve, 2500); }
    else map.once('idle', resolve);
  }));
  await page.waitForTimeout(900);
  await page.screenshot({ path: outPath });
  return outPath;
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const want = (process.argv.find((a) => a.startsWith('--option=')) || '').split('=')[1];
// --bbox=minLon,minLat,maxLon,maxLat frames a detail instead of the whole
// trip: a 19 m graph gap is invisible at trip scale and obvious at 40 m.
const bboxArg = (process.argv.find((a) => a.startsWith('--bbox=')) || '').split('=')[1];
const bbox = bboxArg ? bboxArg.split(',').map(Number) : null;
const suffix = (process.argv.find((a) => a.startsWith('--name=')) || '').split('=')[1];
const src = args[0];
if (!src) {
  console.error('usage: node scripts/audit_map.mjs <route.json> [outDir] [--option=A]');
  process.exit(2);
}
const outDir = args[1] || dirname(src);
const result = JSON.parse(readFileSync(src, 'utf8'));
if (!result.ok) {
  console.log(`${result.id}: no route (${result.reason})`);
  process.exit(0);
}
mkdirSync(outDir, { recursive: true });

const site = await serveRepo();
const browser = await launchBrowser();
const page = await (await browser.newContext({
  viewport: { width: 1000, height: 800 }, deviceScaleFactor: 2,
})).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// The page has to be SERVED, not set inline: PMTiles and the fonts are
// same-origin fetches, and a `setContent` document has no origin to resolve
// them against. It goes in the REPO ROOT (what the server serves), not the
// working directory, and is removed on the way out.
const pagePath = join(ROOT, '__audit_map.html');
writeFileSync(pagePath, PAGE(result.state || 'washington'));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
});
await page.goto(`http://localhost:${site.port}/__audit_map.html`, { waitUntil: 'load' });
try {
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
} catch (error) {
  // A style that never fires `load` is nearly always a missing script or an
  // archive the server would not range-read; say which rather than timing out
  // mutely.
  console.error(`map never became ready for ${result.id}`);
  if (errors.length) console.error(errors.slice(0, 5).join('\n'));
  await browser.close();
  site.close();
  rmSync(pagePath, { force: true });
  process.exit(1);
}

// Options are labelled "Route A"; accept either that or a bare "A".
const wanted = (option) => !want
  || option.letter === want
  || option.letter.split(/\s+/).pop() === want;

const written = [];
for (const option of result.options) {
  if (!wanted(option)) continue;
  const name = `${result.id}_${option.letter.replace(/\s+/g, '')}${suffix ? '_' + suffix : ''}_map.png`;
  written.push(await shoot(page, result, option, join(outDir, name), bbox));
}
console.log(written.join('\n'));
if (errors.length) console.error('page errors:', errors.slice(0, 3).join(' | '));
await browser.close();
site.close();
rmSync(pagePath, { force: true });
