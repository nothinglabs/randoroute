#!/usr/bin/env node
// A Washington-home map must remain complete at the statewide handoff and
// paint installed Oregon's safety data, not only its neutral basemap.
//
// A CONSTRAINED page, deliberately: the resident-ground handoff exists because
// constrained renderers drop the ~1.2 MB low-zoom context tiles; an
// unconstrained browser keeps the archive's full range and has no handoff to
// test (test_regional_basemap_bands proves that split).
import { check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
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
      window.__multiStateMapErrors.push(String(event?.error?.message || event?.message || event));
    });
    map.jumpTo({ center: [-120.4, 46.75], zoom: 6.4 });
  });
  await page.waitForFunction(() => map.queryRenderedFeatures({
    layers: ['basemap-state-ground'],
  }).length > 0, null, { timeout: 45000 });
  const washington = await page.evaluate(() => {
    const dry = [
      ['Centralia', -122.9543, 46.7162],
      ['Morton', -122.2751, 46.5584],
      ['Yakima', -120.5059, 46.6021],
      ['Goldendale', -120.8217, 45.8207],
    ];
    return {
      zoom: map.getZoom(),
      errors: window.__multiStateMapErrors,
      probes: dry.map(([name, lon, lat]) => {
        const point = map.project([lon, lat]);
        const onScreen = point.x >= 0 && point.x < map.getCanvas().width
          && point.y >= 0 && point.y < map.getCanvas().height;
        const groundLayers = ['basemap-state-ground', 'basemap-land']
          .filter((id) => map.getLayer(id));
        const land = onScreen && groundLayers.length
          ? map.queryRenderedFeatures(point, { layers: groundLayers }).length : 0;
        return { name, onScreen, land };
      }),
    };
  });
  check('southern Washington has rendered low-zoom ground at every dry probe',
    washington.probes.every((probe) => probe.onScreen && probe.land > 0),
    JSON.stringify(washington));
  check('the low-zoom Washington handoff raises no map source errors',
    washington.errors.length === 0, washington.errors.join(' | '));
  const detailedLowZoom = await page.evaluate(() => {
    const layers = ['basemap-land', 'basemap-land-detail', 'basemap-green',
      'basemap-water', 'basemap-waterways'].filter((id) => map.getLayer(id));
    return map.queryRenderedFeatures({ layers }).length;
  });
  check('the statewide view does not render oversized detailed context tiles',
    detailedLowZoom === 0, String(detailedLowZoom));

  await page.evaluate(() => map.jumpTo({ center: [-122.2, 46.35], zoom: 8.75 }));
  await page.waitForFunction(() => map.queryRenderedFeatures({
    layers: ['basemap-state-ground'],
  }).length > 0, null, { timeout: 45000 });
  const contextAtHandoff = await page.evaluate(() => {
    const layers = ['basemap-land', 'basemap-land-detail', 'basemap-green',
      'basemap-water', 'basemap-waterways'].filter((id) => map.getLayer(id));
    return map.queryRenderedFeatures({ layers }).length;
  });
  check('southern Washington stays on complete resident ground through the z8 handoff',
    contextAtHandoff === 0, String(contextAtHandoff));

  await page.evaluate(() => map.jumpTo({ center: [-122.6765, 45.5231], zoom: 13 }));
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
