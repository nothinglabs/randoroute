#!/usr/bin/env node
// Desktop sea stays sea, in PIXELS. Field: the Sound rendered patchy cream
// on a desktop that the phone could not reproduce -- the Census ground fill
// exclusion only covered constrained renderers, and desktop kept painting
// marine water as land below z9.5 wherever a detail tile was missing. The
// desktop context archive serves land from z4, so the home state is excluded
// there too; these probes hold rendered color at the same pixel-verified sea,
// land and lake coordinates the constrained gates use.
import { appPage, check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';

const PROBES = [
  ['sea-admiralty-mid', -122.760, 48.100, 'sea'],
  ['sea-saratoga', -122.480, 48.100, 'sea'],
  ['sea-possession-sound', -122.3446, 47.930, 'sea'],
  // Nudged off [-122.520, 48.000]: the retiled water geometry moved a
  // water-body label's glyphs onto that exact pixel at z9.2 (same finding as
  // test_whidbey_stays_an_island). The land is intact; the pixel was text.
  ['land-whidbey-center', -122.500, 48.020, 'land'],
  ['land-wedge-amboy', -122.250, 45.950, 'land'],
  ['lake-green-seattle', -122.339, 47.680, 'lake'],
];
const ZOOMS = [6, 7.8, 8.6, 9.2];
const isWaterColor = ([r, g, b]) => (b - r) > 8;
const isDryColor = ([r, g, b]) => (r - b) >= 3;
const verdict = (kind, zoom, rgb) => {
  if (kind === 'land') return isWaterColor(rgb) ? 'flooded' : null;
  if (kind === 'lake') return zoom >= 8.4 && !isWaterColor(rgb) ? 'paved' : null;
  if (zoom >= 7.8) return isWaterColor(rgb) ? null : 'landed';
  return isDryColor(rgb) ? 'landed' : null;
};

const site = await serveRepo();
const browser = await launchBrowser();
try {
  const page = await appPage(browser, site.port, { desktop: true });
  await page.waitForFunction(() => window.map && map.loaded && map.loaded(),
    null, { timeout: 120000 });
  const wrong = [];
  for (const zoom of ZOOMS) {
    for (const [name, lng, lat, kind] of PROBES) {
      // Braces matter: an expression arrow would RETURN the Map instance
      // (jumpTo returns this), and Playwright then serializes the whole
      // map -- loaded tiles included -- into one >512 MB pipe message.
      await page.evaluate(({ lng, lat, zoom }) => {
        map.jumpTo({ center: [lng, lat], zoom });
      }, { lng, lat, zoom });
      await page.evaluate(() => new Promise((resolve) => {
        if (map.loaded()) return resolve();
        map.once('idle', () => resolve());
        setTimeout(resolve, 12000);
      }));
      await page.waitForTimeout(250);
      const rgb = await page.evaluate(() => new Promise((resolve) => {
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
      const bad = verdict(kind, zoom, rgb);
      if (bad) wrong.push(`${name}@z${zoom}=(${rgb}) ${bad}`);
    }
  }
  check('on desktop, sea stays sea and land stays land across the Census band',
    wrong.length === 0, wrong.slice(0, 8).join(' | '));
} finally {
  await browser.close();
  site.close();
}

done();
