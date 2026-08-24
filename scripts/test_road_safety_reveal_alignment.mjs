#!/usr/bin/env node
// A road class and its safety coloring reveal at the SAME zoom. Field: base
// street casings appearing before their safety overlay read as uncolored,
// unjudged roads. The home 'roads' safety layer's opacity is a zoom step
// whose thresholds must be exactly the basemap's per-class reveal zooms, and
// a neighboring state's cloned safety layer must carry the identical mask.
import { check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)'
  + ' AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const site = await serveRepo();
const browser = await launchBrowser();
try {
  const context = await browser.newContext({ serviceWorkers: 'block',
    userAgent: IPHONE_UA, viewport: { width: 430, height: 900 },
    hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto(`http://localhost:${site.port}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.map && map.loaded && map.loaded()
    && !!map.getLayer('roads'), null, { timeout: 90000 });

  const home = await page.evaluate(() => {
    const layer = (id) => map.getStyle().layers.find((l) => l.id === id);
    const stepZooms = (expression) => Array.isArray(expression) && expression[0] === 'step'
      ? expression.slice(2).filter((_, index) => index % 2 === 1) : null;
    return {
      minzooms: Object.fromEntries(['major', 'medium', 'minor', 'local']
        .map((cls) => [cls, layer(`basemap-${cls}-casing`)?.minzoom])),
      declared: BikeBasemap.ROAD_MIN_ZOOM,
      safetyOpacity: layer('roads')?.paint?.['line-opacity'],
      safetySteps: stepZooms(layer('roads')?.paint?.['line-opacity']),
    };
  });
  check('base casings reveal at the declared per-class zooms',
    ['major', 'medium', 'minor', 'local'].every((cls) =>
      home.minzooms[cls] === home.declared[cls]), JSON.stringify(home.minzooms));
  const steps = home.safetySteps || [];
  check('the safety overlay is a zoom step anchored to those same class zooms',
    steps.length >= 4
      && steps[0] === home.declared.major
      && steps[1] === home.declared.medium
      && steps[2] === home.declared.minor
      && steps[steps.length - 1] === home.declared.local
      && steps.every((z, i) => i === 0 || z >= steps[i - 1]),
    JSON.stringify(steps));

  // The Oregon clones must carry the identical mask — a neighbor's roads must
  // never color earlier or later than the home state's.
  await page.evaluate(() => {
    map.jumpTo({ center: [-122.6765, 45.5231], zoom: 13 });
    map.fire('moveend');
  });
  await page.waitForFunction(() => !!map.getLayer('state-oregon-safety-roads'),
    null, { timeout: 60000 });
  const parity = await page.evaluate(() => {
    const layer = (id) => map.getStyle().layers.find((l) => l.id === id);
    return {
      home: JSON.stringify(layer('roads')?.paint?.['line-opacity'] || null),
      oregon: JSON.stringify(layer('state-oregon-safety-roads')?.paint?.['line-opacity'] || null),
    };
  });
  check('a neighboring state\'s cloned safety overlay carries the identical reveal mask',
    parity.oregon === parity.home && parity.home !== 'null', `${parity.oregon?.slice(0, 120)}`);
} finally {
  await browser.close();
  site.close();
}

done();
