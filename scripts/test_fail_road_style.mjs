#!/usr/bin/env node
// A failing road is a dark red DASH, and it is the same dash at every zoom.
//
// It used to be two different symbols joined at z13: a solid red line below,
// and above it white diagonal slashes -- PATTERN_PROHIBITED, the very image
// the bikes-prohibited layer draws, so a road that merely fails your rules and
// a road bicycles may not legally use were rendered identically. Zooming in
// changed a road's appearance without changing anything about the road.
//
// This test runs the map. It finds roads the app is actually drawing as level
// 4, walks along their rendered pixels, and asserts it sees ink AND gaps -- at
// two zooms either side of the old handover.
import { appPage, check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);
await page.waitForFunction(
  () => typeof applyDisplayModeAll === 'function' && typeof display !== 'undefined'
    && map.getLayer('roads__vh'),
  null, { timeout: 90000 });

/* ------------------------------------------- exactly one layer draws level 4 */
const layers = await page.evaluate(() => ({
  slash: !!map.getLayer('roads__slash'),
  vh: !!map.getLayer('roads__vh'),
  dash: map.getPaintProperty('roads__vh', 'line-dasharray') || null,
  vhMaxZoom: (map.getStyle().layers.find((l) => l.id === 'roads__vh') || {}).maxzoom ?? null,
  // The grey pass/fail dash must stop below level 4 or it draws under the red.
  // The filter is ['all', ['>=', <level expr>, n], ['<=', <level expr>, 3]] and
  // the level expression itself is full of 4s, so read the bound, not the text.
  failUpperBound: (map.getFilter('roads__fail') || [])[2]?.[2] ?? null,
  patterns: map.hasImage('verdict-prohibited'),
}));

check('the white-slash layer is gone', layers.slash === false);
check('the level-4 layer is still there', layers.vh === true);
// A dasharray that does not vary with zoom cannot hold its size on screen,
// because the unit is line-width multiples and the width ramp is 17x across
// the zoom range. The legacy { stops } function is required here -- an
// expression form is accepted by addLayer and then silently drops the layer.
check('and it is dashed, with the dash varying by zoom',
  !!layers.dash && Array.isArray(layers.dash.stops) && layers.dash.stops.length >= 3
    && layers.dash.stops.every(([, pair]) => Array.isArray(pair) && pair.length === 2),
  JSON.stringify(layers.dash));
check('with no maxzoom, so one symbol carries every zoom', layers.vhMaxZoom === null,
  `maxzoom=${layers.vhMaxZoom}`);
check('the prohibited slash image is no longer registered', layers.patterns === false);
check('the pass/fail grey dash stops before level 4', layers.failUpperBound === 3,
  `upper bound ${layers.failUpperBound}`);

/* ------------------------------------------------------ and on real pixels */
// Everything except failing roads is switched off, so whatever ink lands on a
// level-4 centreline came from the layer under test.
const sampleAt = async (zoom) => page.evaluate(async (z) => {
  const canvas = map.getCanvas();
  const settled = () => new Promise((resolve) => {
    map.once('idle', resolve);
    map.triggerRepaint();
  });
  Object.assign(display, {
    meetRules: false, caution: false, bikeFacilities: false, designated: false,
    bikesProhibited: false, unpavedBackground: false, failRules: true,
  });
  applyDisplayModeAll();
  // Aurora Avenue and the arterials either side of it: reliably level 4.
  map.jumpTo({ center: [-122.3447, 47.6605], zoom: z });
  await settled();

  const feats = map.queryRenderedFeatures({ layers: ['roads__vh'] });
  if (!feats.length) return { found: 0 };

  const ratio = canvas.width / canvas.clientWidth;
  const ctx = (() => {
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    copy.getContext('2d').drawImage(canvas, 0, 0);
    return copy.getContext('2d');
  })();
  const warm = (x, y) => {
    const d = ctx.getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data;
    // The fail red over the road interior: red dominant, and clearly so.
    // Nothing else on screen with these layers off is warm.
    return d[0] > 70 && d[0] - d[1] > 30 && d[0] - d[2] > 20;
  };
  // Sample a short window ACROSS the line, not a single pixel on it. At z9 a
  // road is about 1 px wide, tile geometry is simplified, and the projected
  // centreline drifts off the drawn pixels -- which reported 1 px "dashes"
  // that were the sampler losing the line, not the dash being short.
  const reddish = (x, y, nx, ny) => {
    if (x < 3 || y < 3 || x > canvas.clientWidth - 3 || y > canvas.clientHeight - 3) return null;
    for (const d of [0, -1, 1, -2, 2]) {
      if (warm(x + nx * d, y + ny * d)) return true;
    }
    return false;
  };

  // Walk every rendered level-4 centreline a pixel at a time, sampling only
  // where it is actually on screen. Picking the single longest line looked
  // tidier and was wrong: at z15 the longest one runs mostly off the viewport,
  // so every sample fell outside the canvas and the walk came back empty.
  const SAMPLE_CAP = 4000;
  let ink = 0, gap = 0, off = 0;
  // Run lengths of consecutive inked samples: the drawn dash, in screen pixels.
  const runs = [];
  let run = 0;
  const endRun = () => { if (run) runs.push(run); run = 0; };
  outer: for (const f of feats) {
    const g = f.geometry;
    const lines = g.type === 'MultiLineString' ? g.coordinates
      : g.type === 'LineString' ? [g.coordinates] : [];
    for (const line of lines) {
      if (line.length < 2) continue;
      const pts = line.map((c) => map.project(c));
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const steps = Math.min(600, Math.round(len));
        const nx = len ? -(b.y - a.y) / len : 0;
        const ny = len ? (b.x - a.x) / len : 0;
        for (let s = 0; s < steps; s++) {
          const t = s / steps;
          const hit = reddish(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, nx, ny);
          if (hit === null) { off++; endRun(); }
          else if (hit) { ink++; run++; }
          else { gap++; endRun(); }
          if (ink + gap >= SAMPLE_CAP) break outer;
        }
      }
      endRun();
    }
    endRun();
  }
  runs.sort((a, b) => a - b);
  const median = runs.length ? runs[Math.floor(runs.length / 2)] : 0;
  return { found: feats.length, walked: ink + gap, ink, gap, off,
    dashes: runs.length, medianDashPx: median };
}, zoom);

const seen = {};
for (const zoom of [12, 15]) {
  const s = await sampleAt(zoom);
  seen[zoom] = s;
  check(`z${zoom}: the app draws roads as level 4`, s.found > 0, JSON.stringify(s));
  check(`z${zoom}: enough of a line on screen to judge`, s.walked >= 60, JSON.stringify(s));
  // A solid line would be all ink; the old white hatch above z13 would also
  // read as alternating, but it cannot appear at z12 -- which is exactly why
  // both zooms are checked with the same thresholds.
  check(`z${zoom}: the line is inked`, s.ink / Math.max(1, s.walked) > 0.2, JSON.stringify(s));
  check(`z${zoom}: and it has gaps -- it is a dash, not a solid line`,
    s.gap / Math.max(1, s.walked) > 0.12, JSON.stringify(s));
  // The point of stepping FAIL_DASH down as the line widens. A dasharray is
  // measured in line-width multiples, so a flat pair drew a 1.6 px tick at
  // state level and a 27 px slab up close -- the same defect the zoom handover
  // was removed to fix, just moved into the dash itself.
  // Only z12 and up. Below that the map draws THOUSANDS of level-4 features
  // (9,754 on screen at z9), each a few pixels long, so a walk along them
  // measures feature fragments rather than dash marks -- it reported a "2 px
  // dash" that did not move when the dasharray was doubled. Low zoom needs a
  // different instrument, not a looser threshold on this one.
  check(`z${zoom}: the drawn dash is a dash, not a slab`,
    s.medianDashPx >= 4 && s.medianDashPx <= 24,
    `median ${s.medianDashPx} px over ${s.dashes} dashes; ${JSON.stringify(s)}`);
}
check('the dash is about the same size on screen at both zooms',
  Math.abs(seen[12].medianDashPx - seen[15].medianDashPx) <= 9,
  `z12 ${seen[12].medianDashPx} px vs z15 ${seen[15].medianDashPx} px`);

/* --------------------------------------------- metro view: judge the raster */
// Below z12, walking each feature's geometry is the wrong instrument: vector
// tiles split a statewide network into thousands of tiny fragments, and every
// fragment restart looks like a two-pixel "dash" to the walker. What a rider
// actually sees is the final raster. Render the same z9 view once with the real
// dash and once with an effectively solid dash, then compare the amount of red
// ink. This catches both failures that mattered on a phone: transparent gaps
// disappearing, and local-road density filling the whole metro view.
const rasterAt = async (zoom, center = [-122.3447, 47.6605]) => page.evaluate(async ({ z, at }) => {
  const canvas = map.getCanvas();
  const settle = () => new Promise((resolve) => {
    const fallback = setTimeout(resolve, 800);
    map.once('idle', () => { clearTimeout(fallback); resolve(); });
    map.triggerRepaint();
  });
  map.jumpTo({ center: at, zoom: z });
  await settle();
  const countWarm = () => {
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const ctx = copy.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0);
    const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data;
    let warm = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] > 70 && pixels[i] - pixels[i + 1] > 30
          && pixels[i] - pixels[i + 2] > 20) warm++;
    }
    return { warm, total: pixels.length / 4 };
  };
  const dashed = countWarm();
  const original = map.getPaintProperty('roads__vh', 'line-dasharray');
  map.setPaintProperty('roads__vh', 'line-dasharray', [1000, 0.01]);
  await settle();
  const solid = countWarm();
  map.setPaintProperty('roads__vh', 'line-dasharray', original);
  await settle();
  return { dashed: dashed.warm, solid: solid.warm, total: dashed.total };
}, { z: zoom, at: center });
const metro = await rasterAt(9);
check('z9: failing roads stay context rather than filling the metro view',
  metro.dashed / Math.max(1, metro.total) < 0.08,
  JSON.stringify({ ...metro, coverage: metro.dashed / Math.max(1, metro.total) }));
const lowZoomViews = [];
for (const center of [
  [-122.3447, 47.6605], // Seattle
  [-122.208, 47.98],    // Everett
  [-122.76, 48.02],     // Port Townsend / Whidbey
  [-122.45, 47.25],     // Tacoma
  [-122.9, 47.04],      // Olympia
]) {
  lowZoomViews.push({ center, ...(await rasterAt(11, center)) });
}
const city = lowZoomViews.reduce((best, view) =>
  view.solid > best.solid ? view : best, lowZoomViews[0]);
check('z11: zoomed-out failing roads are present somewhere in the shipped map to judge',
  city.solid > 20, JSON.stringify(lowZoomViews));
check('z11: transparent dash gaps materially reduce red ink in the final raster',
  city.dashed < city.solid * 0.82,
  JSON.stringify({ ...city, ratio: city.dashed / Math.max(1, city.solid) }));

await browser.close();
await site.close();
done();
