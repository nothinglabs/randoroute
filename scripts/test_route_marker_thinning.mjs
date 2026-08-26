#!/usr/bin/env node
// Fail badges thin by distance at overview zoom, never by count: every
// cluster keeps its first badge at every zoom, followers surface as the
// camera closes in, and nothing is ever dropped outright. Field
// (2026-08-26): a 214-mile route drew its failed runs as a solid column
// of always-on badges.
import { appPage, check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
try {
  const page = await appPage(browser, site.port, { desktop: true });
  await page.waitForFunction(() => typeof thinFailMarkers === 'function'
    && typeof markerSpanM === 'function', null, { timeout: 60000 });

  const out = await page.evaluate(() => {
    // A fail badge every ~600 m along a 30 km line — the stacked-column case.
    const points = [];
    for (let i = 0; i < 50; i++) {
      points.push({ type: 'Feature',
        properties: { kind: i % 3 ? 'fail' : 'fail-designated', slot: -1 },
        geometry: { type: 'Point', coordinates: [-122.3 + i * 0.008, 47.6] } });
    }
    thinFailMarkers(points);
    const at = (tier) => points.filter((p) => (p.properties.mz || 0) <= tier);
    const spacingOk = (set, radius) => set.every((p, i) => i === 0
      || markerSpanM(set[i - 1].geometry.coordinates, p.geometry.coordinates) >= radius);
    const maxGapOk = (set, gap) => set.every((p, i) => i === 0
      || markerSpanM(set[i - 1].geometry.coordinates, p.geometry.coordinates) <= gap);
    return {
      total: points.length,
      overview: at(0).length, mid: at(10).length, street: at(12).length,
      firstAlways: (points[0].properties.mz || 0) === 0,
      overviewSpaced: spacingOk(at(0), 4000),
      overviewCovers: maxGapOk(at(0), 8100),
      // Anchors are immutable, so a pair that includes one may sit closer
      // than the fine radius; spacing is promised between same-tier badges.
      midSpaced: at(10).every((p, i, set) => i === 0
        || (set[i - 1].properties.mz || 0) === 0 || (p.properties.mz || 0) === 0
        || markerSpanM(set[i - 1].geometry.coordinates, p.geometry.coordinates) >= 1000),
      noneDropped: points.every((p) => (p.properties.mz || 0) <= 12),
    };
  });
  check('overview keeps a spaced representative set, not the column',
    out.overview < out.total / 4 && out.overviewSpaced, JSON.stringify(out));
  check('every region stays represented (no gap wider than two radii)',
    out.overviewCovers && out.firstAlways, JSON.stringify(out));
  check('mid zoom adds badges at tighter spacing', out.mid > out.overview
    && out.midSpaced, JSON.stringify(out));
  check('street zoom shows every badge — nothing is dropped',
    out.street === out.total && out.noneDropped, JSON.stringify(out));

  const tiers = await page.evaluate(() => [routeMarkerTierFor(8),
    routeMarkerTierFor(10.5), routeMarkerTierFor(13)]);
  check('the source swaps through the three tiers as the camera closes in',
    tiers[0] === 0 && tiers[1] === 10 && tiers[2] === 12, JSON.stringify(tiers));
} finally {
  await browser.close();
  site.close();
}

done();
