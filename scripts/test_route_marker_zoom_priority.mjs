#!/usr/bin/env node
// The mountain must survive zooming out. Collision placement thins the
// marker chain by sort key, and with slot order alone the survivor at
// statewide zoom is whichever badge came FIRST on the route -- usually a car
// or gravel slats -- while the one climb the rider would route around
// vanishes until they zoom in (field report). Hills claim placement first;
// the chain still thins, but it thins toward mountains.
import { appPage, check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
try {
  const page = await appPage(browser, site.port, { desktop: true });
  await page.waitForFunction(() => window.map && map.loaded && map.loaded(),
    null, { timeout: 120000 });

  // 30 x 150 m of busy caution road with one 300 m 12% wall in the middle:
  // one steep slot competing against a chain of earlier-slotted cars.
  const swept = await page.evaluate(async () => {
    const lat = 47.55;
    const count = 30;
    const coords = Array.from({ length: count + 1 },
      (_, i) => [-122.30 + i * 0.002, lat]);
    const segs = coords.slice(0, -1).map((_, i) => {
      const steep = i === 10 || i === 11;
      return { lenM: 150, c0: i, c1: i + 1, level: 3, mph: 35, sh: 4,
        gradePct: steep ? 12 : 0,
        measures: steep ? {} : { adt: 21000 } };
    });
    drawRoute(coords, [], segs);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const data = map.getSource('route-marker').serialize().data;
    const sourceKinds = {};
    for (const f of data.features) {
      sourceKinds[f.properties.kind] = (sourceKinds[f.properties.kind] || 0) + 1;
    }
    const out = { sourceKinds, zooms: {} };
    for (const zoom of [7, 8.5, 10, 12, 14]) {
      map.jumpTo({ center: [-122.27, lat], zoom });
      await new Promise((resolve) => {
        map.once('idle', () => resolve());
        setTimeout(resolve, 8000);
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const kinds = {};
      for (const f of map.queryRenderedFeatures({ layers: ['route-marker'] })) {
        kinds[f.properties.kind] = (kinds[f.properties.kind] || 0) + 1;
      }
      out.zooms[zoom] = kinds;
    }
    return out;
  });

  check('the planner produced one steep slot among a chain of traffic',
    swept.sourceKinds.steep === 1 && (swept.sourceKinds.traffic || 0) >= 4,
    JSON.stringify(swept.sourceKinds));
  const zoomedOut = [7, 8.5, 10].map((z) => swept.zooms[z] || {});
  check('the mountain renders at every zoomed-out level',
    zoomedOut.every((kinds) => (kinds.steep || 0) >= 1),
    JSON.stringify(swept.zooms));
  check('zooming in still reveals the rest of the chain',
    (swept.zooms[14]?.traffic || 0) >= 4, JSON.stringify(swept.zooms[14]));
} finally {
  await browser.close();
  site.close();
}

done();
