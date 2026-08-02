#!/usr/bin/env node
// The dismount marker is the one route symbol a rider cannot afford to miss:
// past it they have to get off and walk. It drew at 18 CSS px -- small enough
// to read as map furniture -- and it had no tap area of its own, so a tap on
// the triangle's corner missed the route line underneath and answered with
// whatever road happened to be behind it.
//
// Both are geometry, so both are checked as geometry: the size of the bitmap
// the map actually holds, and what a tap at a measured offset returns.
import { appPage, chromiumPath, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};

// A short east-west route whose middle third must be walked.
const drawn = await page.evaluate(async () => {
  const lat = 47.60;
  const coords = Array.from({ length: 7 }, (_, i) => [-122.34 + i * .002, lat]);
  const segs = coords.slice(0, -1).map((_, i) => ({
    lenM: 150, c0: i, c1: i + 1, level: 1, mph: 25, sh: 4,
    dismount: i >= 2 && i <= 3,
  }));
  map.jumpTo({ center: [-122.34 + 3 * .002, lat], zoom: 15 });
  drawRoute(coords, [], segs);
  await new Promise((resolve) => map.once('idle', resolve));
  const image = map.style.getImage('route-dismount-marker-icon');
  // querySourceFeatures answers per tile and may repeat a feature that straddles
  // a boundary, so count distinct positions rather than returned features.
  const markers = map.querySourceFeatures('route-dismount');
  window.__markerAt = markers[0]?.geometry.coordinates;
  return {
    markerCount: new Set(markers.map((f) => String(f.geometry.coordinates))).size,
    hasSource: !!map.getSource('route-dismount'),
    // What the map holds, divided by the ratio it will draw at: CSS pixels.
    cssPx: image ? Math.round(image.data.width / image.pixelRatio) : 0,
    haloRadius: map.getPaintProperty('route-dismount-halo', 'circle-radius'),
  };
});
check('the route carries one dismount marker', drawn.markerCount === 1 && drawn.hasSource,
  JSON.stringify(drawn));
check('the marker draws well above the old 18 px', drawn.cssPx >= 24,
  `${drawn.cssPx} CSS px`);
check('the halo is sized to cover it', drawn.haloRadius * 2 >= drawn.cssPx,
  `radius ${drawn.haloRadius} against a ${drawn.cssPx} px icon`);

// Tap the marker off-centre -- far enough from the route line that the line's
// own tap target would miss, but inside the triangle a rider is aiming at.
const taps = await page.evaluate((radius) => {
  const at = map.project(window.__markerAt);
  const inspect = (dx, dy) => {
    const feature = featureAt({ x: at.x + dx, y: at.y + dy });
    return feature ? { layer: feature.layer.id, dismount: feature.properties.dismount } : null;
  };
  const onMarker = (dx, dy) => dismountMarkerAt({ x: at.x + dx, y: at.y + dy });
  // Somewhere on the route with no marker, to prove the widened reach belongs
  // to the marker rather than to every tap on the map.
  const elsewhere = map.project([window.__markerAt[0] + .004, window.__markerAt[1]]);
  return {
    centre: inspect(0, 0),
    edge: inspect(0, -(radius - 2)),
    onCentre: onMarker(0, 0),
    onEdge: onMarker(0, -(radius - 2)),
    onBeyond: onMarker(0, radius * 3),
    onElsewhere: dismountMarkerAt({ x: elsewhere.x, y: elsewhere.y }),
  };
}, drawn.haloRadius);
check('tapping the centre of the marker reports the dismount',
  taps.centre?.layer === 'route-seg-hit' && taps.centre?.dismount === 1, JSON.stringify(taps));
check('and so does tapping its edge, clear of the route line',
  taps.edge?.layer === 'route-seg-hit' && taps.edge?.dismount === 1, JSON.stringify(taps));
check('the marker owns the taps that land on it', taps.onCentre && taps.onEdge,
  JSON.stringify(taps));
check('and no others', !taps.onBeyond && !taps.onElsewhere, JSON.stringify(taps));

check('drawing the marker raises no page errors', page.pageErrors.length === 0,
  page.pageErrors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
