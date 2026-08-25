#!/usr/bin/env node
// A Washington-home map must keep real coastline and lake geometry through
// the compact regional band, hand off cleanly to detailed context, and paint
// installed Oregon's safety data rather than only its neutral basemap.
//
// A CONSTRAINED page, deliberately: the resident-ground handoff exists because
// constrained renderers drop the ~1.2 MB low-zoom context tiles. Their compact
// regional archive owns z4-z8; an unconstrained browser keeps the detailed
// archive's full range and has no handoff to test (test_regional_basemap_bands
// proves that split).
import { check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';
import { createRequire } from 'node:module';

const site = await serveRepo();
// Simulate the real upgrade interval: Washington has the new regional
// archive, while an existing Oregon install still carries its retained .806
// manifest and therefore does not declare one until the rider updates it.
const require = createRequire(import.meta.url);
const registry = require('../maps/states.js');
const mixedStates = structuredClone(registry.MAP_STATES);
const oldOregon = mixedStates.find((state) => state.id === 'oregon');
delete oldOregon.datasets.regional;
delete oldOregon.versions.regional;
site.publish('/maps/states.js', `(function (root) {
  root.MAP_STATES_BUNDLED = true;
  root.MAP_STATES = ${JSON.stringify(mixedStates)};
  root.MAP_STATE_ACQUISITIONS = ${JSON.stringify(registry.MAP_STATE_ACQUISITIONS)};
}(typeof self !== 'undefined' ? self : this));`);
const browser = await launchBrowser();
try {
  const context = await browser.newContext({
    serviceWorkers: 'block', viewport: { width: 900, height: 800 },
    hasTouch: true, isMobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) '
      + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.pageErrors = pageErrors;
  await page.goto(`http://localhost:${site.port}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.map && map.loaded && map.loaded(),
    { timeout: 120000 }).catch(() => {});
  await page.evaluate(() => {
    window.__multiStateMapErrors = [];
    map.on('error', (event) => {
      window.__multiStateMapErrors.push({
        message: String(event?.error?.message || event?.message || event),
        name: String(event?.error?.name || ''),
        sourceId: String(event?.sourceId || event?.source?.id || ''),
      });
    });
    map.jumpTo({ center: [-122.48, 48.02], zoom: 4 });
  });
  await page.waitForFunction(() => map.queryRenderedFeatures({
    layers: ['basemap-regional-land', 'basemap-regional-land-detail'],
  }).length > 0, null, { timeout: 45000 });
  const regionalChecks = [];
  for (const zoom of [4, 5, 6, 7, 8]) {
    await page.evaluate((z) => { map.jumpTo({ center: [-122.48, 48.02], zoom: z }); }, zoom);
    await page.waitForFunction(() => map.loaded() && map.isSourceLoaded('basemap-regional'),
      null, { timeout: 45000 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() =>
      requestAnimationFrame(resolve))));
    regionalChecks.push(await page.evaluate((z) => {
      const layerIds = map.getStyle().layers.map((layer) => layer.id);
      // Regional ground is the union: the archive carries the coastline band
      // (land_detail) only at z8, and the generalized land layer is the whole
      // ground at z4-z7 -- exactly as the detailed archive draws on desktop.
      // A marine point must be claimed by NEITHER.
      const landLayers = ['basemap-regional-land', 'basemap-regional-land-detail'];
      const waterLayers = ['basemap-regional-water'];
      const rendered = (lon, lat, layers) => {
        const point = map.project([lon, lat]);
        const onScreen = point.x >= 0 && point.x < map.getCanvas().clientWidth
          && point.y >= 0 && point.y < map.getCanvas().clientHeight;
        return { onScreen, count: onScreen
          ? map.queryRenderedFeatures(point, { layers }).length : 0 };
      };
      const dry = [
        ['Whidbey Island', -122.686, 48.219],
        ['Seattle', -122.31, 47.65],
      ].map(([name, lon, lat]) => ({ name,
        land: rendered(lon, lat, landLayers), water: rendered(lon, lat, waterLayers) }));
      // Deception Pass (200 m across, sub-pixel below z9) is deliberately
      // absent: the generalized land layer bridges it at z7-z8, exactly as
      // the detailed archive has always drawn on desktop. These two channels
      // are kilometers wide and must stay open at every regional zoom.
      const marine = [
        ['Admiralty Inlet', -122.76, 48.10],
        ['Saratoga Passage', -122.50, 48.10],
      ].map(([name, lon, lat]) => ({ name,
        land: rendered(lon, lat, landLayers), water: rendered(lon, lat, waterLayers) }));
      const greenLake = {
        land: rendered(-122.3397, 47.6804, landLayers),
        water: rendered(-122.3397, 47.6804, waterLayers),
      };
      // Washington is wholly inside one z4 tile. At z5-z8, probe dry land on
      // both sides of an actual Web Mercator tile boundary: a missing or
      // clipped tile becomes an ocean-colored strip at exactly this seam.
      const seamByZoom = {
        5: [-123.75, 47.45], 6: [-123.75, 47.45],
        7: [-120.9375, 47.30], 8: [-122.34375, 47.55],
      };
      const seam = seamByZoom[z]
        ? [-0.03, 0.03].map((offset) => ({
          land: rendered(seamByZoom[z][0] + offset, seamByZoom[z][1], landLayers),
          water: rendered(seamByZoom[z][0] + offset, seamByZoom[z][1], waterLayers),
        })) : [];
      const detailedLayers = ['basemap-land', 'basemap-land-detail', 'basemap-green',
        'basemap-water', 'basemap-waterways'];
      return {
        zoom: z,
        sourceLoaded: map.isSourceLoaded('basemap-regional'),
        dry, marine, greenLake, seam,
        detailed: map.queryRenderedFeatures({ layers: detailedLayers }).length,
        waterAboveLand: Math.min(...waterLayers.map((id) => layerIds.indexOf(id)))
          > Math.max(...landLayers.map((id) => layerIds.indexOf(id))),
      };
    }, zoom));
  }
  check('z4-z8 regional geometry keeps Whidbey and Seattle dry',
    regionalChecks.every((band) => band.dry.every((probe) =>
      probe.land.onScreen && probe.land.count > 0 && probe.water.count === 0)),
    JSON.stringify(regionalChecks));
  check('z4-z8 regional geometry keeps Whidbey separated by marine water',
    regionalChecks.every((band) => band.marine.every((probe) =>
      probe.land.onScreen && probe.land.count === 0)), JSON.stringify(regionalChecks));
  // Below z8 the archive's own generalization drops the 400 m lake (about a
  // pixel there); it must be water from z8, where a rider can see it.
  check('z8 regional water paints visible Green Lake above land',
    regionalChecks.filter((band) => band.zoom >= 8).every((band) =>
      band.greenLake.water.onScreen
      && band.greenLake.water.count > 0 && band.waterAboveLand),
    JSON.stringify(regionalChecks));
  check('z5-z8 dry land stays continuous across regional tile seams',
    regionalChecks.filter((band) => band.zoom >= 5).every((band) =>
      band.seam.length === 2 && band.seam.every((probe) =>
        probe.land.onScreen && probe.land.count > 0 && probe.water.count === 0)),
    JSON.stringify(regionalChecks));
  await page.evaluate(() => { map.jumpTo({ center: [-121.5, 46.5], zoom: 4 }); });
  await page.waitForFunction(() => map.loaded() && map.isSourceLoaded('basemap-regional'),
    null, { timeout: 45000 });
  const mixedNeighbor = await page.evaluate(() => {
    const point = map.project([-123.0351, 44.9429]); // dry land in Salem, Oregon
    const layers = map.getStyle().layers.map((layer) => layer.id);
    return {
      onScreen: point.x >= 0 && point.x < map.getCanvas().clientWidth
        && point.y >= 0 && point.y < map.getCanvas().clientHeight,
      administrativeGround: map.queryRenderedFeatures(point,
        { layers: ['basemap-state-ground'] }).length,
      neighborRegionalAttached: !!map.getSource('state-oregon-basemap-regional'),
      fallbackBelowRegional: layers.indexOf('basemap-state-ground')
          < layers.indexOf('basemap-regional-land-detail')
        && layers.indexOf('basemap-state-ground')
          < layers.indexOf('basemap-regional-water'),
    };
  });
  check('an old neighboring install retains low-zoom ground below the new home geometry',
    mixedNeighbor.onScreen && mixedNeighbor.administrativeGround > 0
      && !mixedNeighbor.neighborRegionalAttached && mixedNeighbor.fallbackBelowRegional,
    JSON.stringify(mixedNeighbor));
  const regionalErrors = await page.evaluate(() => window.__multiStateMapErrors);
  check('z4-z8 uses only the compact regional archive without source failures',
    regionalChecks.every((band) => band.sourceLoaded && band.detailed === 0)
      && regionalErrors.length === 0,
    JSON.stringify({ regionalChecks, errors: regionalErrors }));

  await page.evaluate(() => { map.jumpTo({ center: [-122.3397, 47.6804], zoom: 9.25 }); });
  await page.waitForFunction(() => map.isSourceLoaded('basemap-context'),
    null, { timeout: 45000 });
  const handoff = await page.evaluate(() => {
    const greenLake = map.project([-122.3397, 47.6804]);
    return {
      regional: map.queryRenderedFeatures({ layers: ['basemap-regional-land-detail',
        'basemap-regional-water'] }).length,
      detailedLand: map.queryRenderedFeatures(greenLake,
        { layers: ['basemap-land', 'basemap-land-detail'] }).length,
      detailedWater: map.queryRenderedFeatures(greenLake,
        { layers: ['basemap-water'] }).length,
    };
  });
  // The regional layers no longer retire at z9: overzoomed z8 tiles stay the
  // coastline-correct backdrop under the detailed layers, so a dropped detail
  // tile degrades to a blocky true shoreline instead of to sea-as-land. The
  // handoff is that detailed land and water claim Green Lake ABOVE it.
  check('z9 keeps the regional backdrop while detailed land and water claim Green Lake',
    handoff.regional > 0 && handoff.detailedLand > 0 && handoff.detailedWater > 0,
    JSON.stringify(handoff));

  await page.evaluate(() => { map.jumpTo({ center: [-122.6765, 45.5231], zoom: 13 }); });
  await page.waitForFunction(() =>
    document.body.dataset.visibleMapStateIds?.includes('oregon'), null, { timeout: 45000 });
  await page.waitForFunction(() => {
    const safetyLayers = (map.getStyle()?.layers || [])
      .filter((layer) => layer.id.startsWith('state-oregon-safety-'))
      .map((layer) => layer.id);
    return safetyLayers.length > 0
      && map.isSourceLoaded('state-oregon-basemap-roads')
      && map.isSourceLoaded('state-oregon-basemap-overlays')
      && map.queryRenderedFeatures({ layers: safetyLayers }).length > 0;
  }, null, { timeout: 60000 });
  const oregon = await page.evaluate(() => {
    const styleLayers = map.getStyle().layers;
    const layers = styleLayers.map((layer) => layer.id);
    const safetyLayers = layers.filter((id) => id.startsWith('state-oregon-safety-'));
    const neutralPaintLayers = styleLayers
      .filter((layer) => layer.id.startsWith('state-oregon-basemap-')
        && layer.type !== 'symbol')
      .map((layer) => layer.id);
    const layerIndex = (id) => layers.indexOf(id);
    return {
      visible: document.body.dataset.visibleMapStateIds,
      safetyLayers,
      renderedSafety: safetyLayers.length
        ? map.queryRenderedFeatures({ layers: safetyLayers }).length : 0,
      neutralBelowSafety: neutralPaintLayers.length > 0 && safetyLayers.length > 0
        && Math.max(...neutralPaintLayers.map(layerIndex))
          < Math.min(...safetyLayers.map(layerIndex)),
      neighboringLandBelowHomeWater:
        layerIndex('state-oregon-basemap-land') < layerIndex('basemap-water'),
      errors: window.__multiStateMapErrors,
    };
  });
  check('the Oregon viewport renders installed Oregon safety layers',
    oregon.visible.includes('oregon')
      && oregon.safetyLayers.length > 0 && oregon.renderedSafety > 0,
    JSON.stringify(oregon));
  check('neighboring land and neutral roads stay below water and safety paint',
    oregon.neutralBelowSafety && oregon.neighboringLandBelowHomeWater,
    JSON.stringify(oregon));
  check('the complete Washington-to-Oregon source handoff raises no page errors',
    page.pageErrors.length === 0, page.pageErrors.join(' | '));
} finally {
  await browser.close();
  await site.close();
}

done();
