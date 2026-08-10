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
  const reddish = (x, y) => {
    if (x < 2 || y < 2 || x > canvas.clientWidth - 2 || y > canvas.clientHeight - 2) return null;
    const d = ctx.getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data;
    // The fail red is #a51c30 at 0.9 opacity over the road interior: red
    // dominant, and clearly so. Nothing else on screen with these layers off
    // is warm.
    return d[0] > 110 && d[0] - d[1] > 45 && d[0] - d[2] > 30;
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
        const steps = Math.min(600, Math.round(Math.hypot(b.x - a.x, b.y - a.y)));
        for (let s = 0; s < steps; s++) {
          const t = s / steps;
          const hit = reddish(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
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
  check(`z${zoom}: the drawn dash is a dash, not a slab`,
    s.medianDashPx >= 4 && s.medianDashPx <= 24,
    `median ${s.medianDashPx} px over ${s.dashes} dashes`);
}
check('the dash is about the same size on screen at both zooms',
  Math.abs(seen[12].medianDashPx - seen[15].medianDashPx) <= 9,
  `z12 ${seen[12].medianDashPx} px vs z15 ${seen[15].medianDashPx} px`);

await browser.close();
await site.close();
done();
