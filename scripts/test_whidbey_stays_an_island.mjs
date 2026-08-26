#!/usr/bin/env node
// Whidbey stays an island at every zoom, in PIXELS. Field (three rounds of
// reports): zooming out on a phone turned the water around Whidbey into land
// and paved Green Lake — the Census state polygon includes marine water, and
// it back-filled every zoom band where coastline-true geometry was absent or
// still loading. This drives the constrained renderer with the DETAILED
// archive unreachable, so the regional backdrop is the only geography — the
// exact world a phone lives in mid-zoom or with a dropped tile — and asserts
// the rendered color of fixed sea, land and lake coordinates across the zoom
// ladder. A sea point that paints land-colored anywhere is the bug.
import { check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)'
  + ' AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

// Kinds: 'sea' points sit mid-channel in marine water, 'land' points are
// well inland of any shore, 'lake' points are at least a few hundred meters
// inside a lake. Every coordinate was verified against the detailed archive
// at z12 by the pixel probe — a probe that renders land there with detail
// serving is a bad coordinate, not a map defect.
const PROBES = [
  // Mid-channel of Admiralty Inlet's wide reach. NOT the narrow throat off
  // Fort Casey (-122.62, 48.09): that reach is ~5 km -- two pixels at z6 --
  // and the archive's own generalized land closes it below z7, exactly as
  // the detailed archive has always drawn on desktop. Known limit, recorded
  // in issues.md; the channels asserted here are the ones a rider can see.
  ['sea-admiralty-mid', -122.760, 48.100, 'sea'],
  ['sea-saratoga', -122.480, 48.100, 'sea'],
  ['sea-possession-sound', -122.3446, 47.930, 'sea'],
  ['sea-south-whidbey', -122.500, 47.880, 'sea'],
  // Nudged off [-122.520, 48.000]: the retiled water geometry moved a
  // water-body label's glyphs onto that exact pixel at z9.2 (same caveat as
  // Green Lake's floating label). The land was intact; the pixel was text.
  ['land-whidbey-center', -122.500, 48.020, 'land'],
  // Nudged off [-122.130, 48.070]: at z13.5 that exact point sits on a
  // local-road casing (roads keep serving in the fallback world), whose
  // grey reads water-leaning to the color heuristic. The stand-in was
  // fine; the pixel was a road.
  ['land-mainland-marysville', -122.118, 48.075, 'land'],
  ['lake-stevens', -122.0842, 48.005, 'lake'],
  // Dead center: the shoreline bike loop's green facility paint owns the
  // lake's edge pixels from z8.9, and the name label floats near but not on
  // the centroid through z10.
  ['lake-green-seattle', -122.339, 47.680, 'lake'],
];
// 13.5 rides at street zoom: with detail missing there, the overzoomed z8
// regional tile is very blocky — the assertion is that it is still LAND
// under the rider, never open sea (field ask, 2026-08-25: a low-res
// stand-in instead of a sea of blue while detail tiles parse).
const FALLBACK_ZOOMS = [6, 7.8, 8.9, 9.2, 9.6, 10.5, 11.5, 13.5];
const HANDOFF_ZOOMS = [8.9, 9.2, 10];

const site = await serveRepo();
const browser = await launchBrowser();

async function bootPhone() {
  const context = await browser.newContext({ serviceWorkers: 'block',
    userAgent: IPHONE_UA, viewport: { width: 430, height: 900 },
    hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto(`http://localhost:${site.port}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.map && typeof map.getCanvas === 'function',
    null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  return { context, page };
}

async function samplePixel(page, lng, lat, zoom, settleMs = 9000) {
  await page.evaluate(({ lng, lat, zoom }) => {
    map.jumpTo({ center: [lng, lat], zoom });
  }, { lng, lat, zoom });
  await page.evaluate((limit) => new Promise((resolve) => {
    if (map.loaded()) return resolve();
    map.once('idle', () => resolve());
    setTimeout(resolve, limit);
  }), settleMs);
  await page.waitForTimeout(200);
  return page.evaluate(() => new Promise((resolve) => {
    map.once('render', () => {
      const gl = map.getCanvas();
      const out = document.createElement('canvas');
      out.width = 4; out.height = 4;
      const ctx = out.getContext('2d');
      ctx.drawImage(gl, gl.width / 2 - 2, gl.height / 2 - 2, 4, 4, 0, 0, 4, 4);
      const d = ctx.getImageData(2, 2, 1, 1).data;
      resolve([d[0], d[1], d[2]]);
    });
    map.triggerRepaint();
  }));
}

// The land fill is warm cream (r > b by 6); every water paint leans blue by
// 20+. Below z7.8 an inland channel is one or two pixels wide, so its center
// pixel legitimately blends with the shoreline — there the assertion is only
// that the pixel is not dry (no land-fill or blend dominated by it). A tiny
// lake may simplify away entirely when zoomed far out, so lakes are asserted
// only from z8.4, where each of these is several pixels across.
const isWaterColor = ([r, g, b]) => (b - r) > 8;
const isDryColor = ([r, g, b]) => (r - b) >= 3;
const verdict = (kind, zoom, rgb) => {
  if (kind === 'land') return isWaterColor(rgb) ? 'flooded' : null;
  if (kind === 'lake') {
    return zoom >= 8.4 && !isWaterColor(rgb) ? 'paved' : null;
  }
  if (zoom >= 7.8) return isWaterColor(rgb) ? null : 'landed';
  return isDryColor(rgb) ? 'landed' : null;
};

try {
  // Phase A: the detailed archive never answers — the regional backdrop and
  // the ocean background are the only geography at EVERY zoom.
  site.publish('/maps/washington/basemap.pmtiles', (req, res) => {
    res.writeHead(404); res.end();
  });
  const fallback = await bootPhone();
  const wrong = [];
  for (const zoom of FALLBACK_ZOOMS) {
    for (const [name, lng, lat, kind] of PROBES) {
      // The 404 world never reaches 'idle' -- the tile-retry hook keeps the
      // failed detailed requests alive -- so every sample here used to burn
      // the full fallback timeout: 56 samples x 9 s was most of this file's
      // wall time. The regional tiles the assertion reads come from the
      // local static server in well under a second; the short settle keeps
      // the same probes at a twentieth of the cost.
      const rgb = await samplePixel(fallback.page, lng, lat, zoom, 2500);
      const bad = verdict(kind, zoom, rgb);
      if (bad) wrong.push(`${name}@z${zoom}=(${rgb}) ${bad}`);
    }
  }
  check('with no detailed tiles at all, sea stays sea and land stays land at every zoom',
    wrong.length === 0, wrong.slice(0, 8).join(' | '));
  await fallback.context.close();

  // Phase B: the full world — the handoff band must also hold with the
  // detailed archive serving normally.
  site.unpublish('/maps/washington/basemap.pmtiles');
  const full = await bootPhone();
  const wrongFull = [];
  for (const zoom of HANDOFF_ZOOMS) {
    for (const [name, lng, lat, kind] of PROBES) {
      const rgb = await samplePixel(full.page, lng, lat, zoom);
      const bad = verdict(kind, zoom, rgb);
      if (bad) wrongFull.push(`${name}@z${zoom}=(${rgb}) ${bad}`);
    }
  }
  check('through the z9 handoff with detail serving, the same points hold',
    wrongFull.length === 0, wrongFull.slice(0, 8).join(' | '));
  await full.context.close();
} finally {
  await browser.close();
  site.close();
}

done();
