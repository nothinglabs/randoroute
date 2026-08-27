#!/usr/bin/env node
// The walked sidewalk escape, end to end in the REAL app: the exact field
// trip (Portage Bay Cafe -> Phinney Ridge, the true geocoder pins, default
// everything) must produce a portfolio holding a clean walked option, and
// that option's DISPLAY must agree with its engine truth — amber walk, a
// walker badge, no fail badge, no failing mileage in the legend.
//
// This exists because the field bug it pins survived FOUR display fixes:
// the worker walked the stub, fallbackRouteLevel honored it, and the route
// still drew a "!" on the walk — routeVisualStyle carried its own
// independent re-score that nothing below the browser exercised. Only the
// full pipeline catches the next copy of that mistake.
import { appPage, check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';

const repo = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, repo.port, { desktop: true });
await page.evaluate(() => {
  setRoutePoint('start', { lng: -122.3175829, lat: 47.6575638 }, 'Portage Bay Cafe');
  setRoutePoint('end', { lng: -122.35403, lat: 47.67213 }, 'Phinney Ridge');
});
await page.waitForFunction(() =>
  typeof routing !== 'undefined' && routing.last?.ok && (routing.options || []).length,
null, { timeout: 420000 });

const report = await page.evaluate(() => {
  const clean = routing.options.find((option) =>
    Math.round(option.failM) === 0 && (option.segs || []).some((s) => s.walkAccess));
  if (!clean) return { clean: false };
  activateRouteOption(clean);
  const start = clean.coords[0];
  const dM = (c) => Math.hypot((c[0] - start[0]) * 75300, (c[1] - start[1]) * 110540);
  const sdata = clean.segs.map((seg, index) =>
    routeSegmentMapFeature(clean.coords, seg, index)).filter(Boolean);
  const markers = buildRouteMarkerData({ type: 'FeatureCollection', features: sdata });
  const stats = routeSummaryStats(clean);
  return {
    clean: true, label: clean.optimization?.label,
    walkSegs: clean.segs.filter((s) => s.walkAccess).length,
    stubStyles: sdata.filter((f, i) => clean.segs[i].walkAccess)
      .map((f) => routeVisualStyle(f.properties)),
    failMarkers: (markers.other.features || [])
      .filter((f) => String(f.properties.kind).startsWith('fail')).length,
    walkMarkersNearStart: (markers.walk.features || [])
      .filter((f) => dM(f.geometry.coordinates) < 250).length,
    legendFailM: Math.round(stats.categoryM.fail || 0),
    legendLevel4M: Math.round(stats.levels[4] || 0),
  };
});
check('the field trip offers a clean walked option', report.clean === true,
  JSON.stringify(report));
check('the walked stub draws as caution, never fail',
  report.walkSegs >= 1 && report.stubStyles.every((style) => style === 'caution'),
  JSON.stringify(report.stubStyles));
check('no fail badge anywhere on the clean option', report.failMarkers === 0,
  `fail markers ${report.failMarkers}`);
check('a walker badge marks the walked stub', report.walkMarkersNearStart >= 1,
  `walk markers near start ${report.walkMarkersNearStart}`);
check('the legend counts no failing mileage on the clean option',
  report.legendFailM === 0 && report.legendLevel4M === 0,
  JSON.stringify({ fail: report.legendFailM, level4: report.legendLevel4M }));

await browser.close();
repo.close();
done();
