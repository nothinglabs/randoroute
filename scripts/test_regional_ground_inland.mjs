#!/usr/bin/env node
// Inland southern Washington stays LAND with no neighbor installed and the
// detailed archive unreachable, in PIXELS. Field (.809): the strip between
// Longview and The Dalles rendered as open sea on a phone whose Oregon map
// was not installed -- land_detail is the coastline band only, the .807
// regional archive carried nothing else, and the Census ground fill that
// papered over the gap is (correctly) excluded for a regionally-covered
// state. The rebuilt archive carries the generalized land layer beneath
// land_detail; these probes are the wedge the field photographed, plus a
// marine control proving the backstop does not pave the channels.
import { check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const registry = require('../maps/states.js');

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)'
  + ' AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const site = await serveRepo();
// The field world: Washington only. No Oregon folder to paper over the
// border strip with its own regional land.
site.publish('/maps/states.js', `(function (root) {
  root.MAP_STATES = ${JSON.stringify(registry.MAP_STATES
    .filter((state) => state.id === 'washington'))};
  root.MAP_STATE_ACQUISITIONS = ${JSON.stringify({
    washington: registry.MAP_STATE_ACQUISITIONS.washington })};
}(typeof self !== 'undefined' ? self : this));`);
// And the detailed archive never answers, so the regional band is the only
// geography at every zoom.
site.publish('/maps/washington/basemap.pmtiles', (req, res) => {
  res.writeHead(404); res.end();
});

const PROBES = [
  ['wedge-woodland', -122.40, 45.95, 'land'],
  ['wedge-amboy', -122.25, 45.95, 'land'],
  ['wedge-east', -121.80, 45.85, 'land'],
  ['north-control-chehalis', -122.60, 46.55, 'land'],
  ['sea-control-saratoga', -122.48, 48.10, 'sea'],
];
const ZOOMS = [6, 8.3, 9.2, 10.5];

const isWaterColor = ([r, g, b]) => (b - r) > 8;

const browser = await launchBrowser();
try {
  const context = await browser.newContext({ serviceWorkers: 'block',
    userAgent: IPHONE_UA, viewport: { width: 430, height: 900 },
    hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto(`http://localhost:${site.port}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.map && typeof map.getCanvas === 'function',
    null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const wrong = [];
  for (const zoom of ZOOMS) {
    for (const [name, lng, lat, kind] of PROBES) {
      await page.evaluate(({ lng, lat, zoom }) =>
        map.jumpTo({ center: [lng, lat], zoom }), { lng, lat, zoom });
      await page.evaluate(() => new Promise((resolve) => {
        if (map.loaded()) return resolve();
        map.once('idle', resolve);
        setTimeout(resolve, 9000);
      }));
      await page.waitForTimeout(200);
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
      const water = isWaterColor(rgb);
      if ((kind === 'sea') !== water) wrong.push(`${name}@z${zoom}=(${rgb})`);
    }
  }
  check('southern Washington is land and the channels stay water, Washington-only, no detail',
    wrong.length === 0, wrong.slice(0, 8).join(' | '));
} finally {
  await browser.close();
  site.close();
}

done();
