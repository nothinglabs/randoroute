#!/usr/bin/env node
// A Washington-home map must remain complete at the statewide handoff and
// paint installed Oregon's safety data, not only its neutral basemap.
import { appPage, check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
try {
  const page = await appPage(browser, site.port, { desktop: true });
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
    const layers = map.getStyle().layers.map((layer) => layer.id);
    const safetyLayers = layers.filter((id) => id.startsWith('state-oregon-safety-'));
    return {
      visible: document.body.dataset.visibleMapStateIds,
      safetyLayers,
      renderedSafety: safetyLayers.length
        ? map.queryRenderedFeatures({ layers: safetyLayers }).length : 0,
      errors: window.__multiStateMapErrors,
    };
  });
  check('the Oregon viewport renders installed Oregon safety layers',
    oregon.visible.includes('oregon')
      && oregon.safetyLayers.length > 0 && oregon.renderedSafety > 0,
    JSON.stringify(oregon));
  check('the complete Washington-to-Oregon source handoff raises no page errors',
    page.pageErrors.length === 0, page.pageErrors.join(' | '));
} finally {
  await browser.close();
  await site.close();
}

done();
