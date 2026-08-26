#!/usr/bin/env node
// Waiting must be visible — and only real waiting. From the 2026-08-25/26
// field days:
//   1. While map tiles are actively flowing (a slow fill), the top-edge
//      loading bar shows; it leaves within a beat of the last arrival.
//   2. A burst that already finished (a cached pan) and geojson rewrites
//      (route switches) never summon it — the old indicator showed for
//      work that was already done and lingered after rendering finished.
//   3. A route compute that runs long carries a climbing elapsed marker on
//      the calculation banner, even when the phase message stops changing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, appPage, check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';

// The real archive, served correctly but SLOWLY: every response (ranges
// included) waits before answering, so tile arrivals trickle the way they
// do on a phone mid-fill.
function slowArchive(path, delayMs) {
  const bytes = readFileSync(join(ROOT, path));
  return (req, res) => {
    const range = req.headers.range && /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
    setTimeout(() => {
      if (range) {
        const from = +range[1];
        const to = Math.min(range[2] ? +range[2] : bytes.length - 1, bytes.length - 1);
        res.writeHead(206, { 'content-type': 'application/octet-stream',
          'accept-ranges': 'bytes', 'content-length': to - from + 1,
          'content-range': `bytes ${from}-${to}/${bytes.length}` });
        res.end(bytes.subarray(from, to + 1));
      } else {
        res.writeHead(200, { 'content-type': 'application/octet-stream',
          'accept-ranges': 'bytes', 'content-length': bytes.length });
        res.end(bytes);
      }
    }, delayMs);
  };
}

const ARCHIVES = ['roads.pmtiles', 'basemap.pmtiles', 'overlays.pmtiles'];
const site = await serveRepo();
const browser = await launchBrowser();
try {
  const page = await appPage(browser, site.port, { desktop: true });
  await page.waitForFunction(() => window.map && map.loaded && map.loaded(),
    null, { timeout: 120000 });
  await page.evaluate(() => { document.getElementById('onboardingClose')?.click(); });
  await page.evaluate(() => new Promise((resolve) => {
    map.once('idle', () => resolve());
    setTimeout(resolve, 10000);
  }));

  const atRest = await page.evaluate(() =>
    document.getElementById('mapLoadingBar').hidden);
  check('the bar stays away from a settled map', atRest === true);

  // A slow fill: archives answer, but every range takes 600 ms.
  for (const file of ARCHIVES) {
    site.publish(`/maps/washington/${file}`, slowArchive(`maps/washington/${file}`, 600));
  }
  await page.evaluate(() => {
    map.jumpTo({ center: [-117.426, 47.658], zoom: 14.2 });
  });
  const shown = await page.waitForFunction(
    () => !document.getElementById('mapLoadingBar').hidden,
    null, { timeout: 20000 }).then(() => true).catch(() => false);
  check('a slow tile fill surfaces the loading bar', shown);

  // Arrivals finish; the bar must leave promptly.
  for (const file of ARCHIVES) site.unpublish(`/maps/washington/${file}`);
  const settled = await page.waitForFunction(
    () => document.getElementById('mapLoadingBar').hidden,
    null, { timeout: 45000 }).then(() => true).catch(() => false);
  check('and leaves once the arrivals stop', settled);

  // Route switches rewrite geojson sources; those events never count as
  // tile traffic, so the bar stays away however many land.
  const afterSwitch = await page.evaluate(async () => {
    map.addSource('__bar-probe', { type: 'geojson',
      data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: '__bar-probe', type: 'circle', source: '__bar-probe' });
    for (let i = 0; i < 6; i++) {
      map.getSource('__bar-probe').setData({ type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'Point',
          coordinates: [-117.42 + i * 0.001, 47.65] }, properties: {} }] });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
    return document.getElementById('mapLoadingBar').hidden;
  });
  check('geojson rewrites (route switches) never summon the bar',
    afterSwitch === true);

  const banner = await page.evaluate(() => {
    hideRouteCalculationStatus();
    showRouteCalculationStatus('Calculating route options', 'Testing route profiles… (1 of 3)');
    const fresh = document.getElementById('routeCalculationDetail').textContent;
    calcShownAt = Date.now() - 200000;
    showRouteCalculationStatus('Calculating route options', 'Testing route profiles… (1 of 3)');
    const aged = document.getElementById('routeCalculationDetail').textContent;
    hideRouteCalculationStatus();
    return { fresh, aged };
  });
  check('a fresh compute banner carries no elapsed marker',
    !/working for/.test(banner.fresh), JSON.stringify(banner));
  check('a long compute banner says how long it has been working',
    /working for \d+ min$/.test(banner.aged), JSON.stringify(banner));
} finally {
  await browser.close();
  site.close();
}

done();
