#!/usr/bin/env node
// Waiting must be visible. Two rules from the 2026-08-25 field day, where
// the app repeatedly looked dead while it was working:
//   1. A map stuck filling tiles shows the "Loading map…" pill after a
//      continuous stretch, and drops it the moment the map goes idle.
//   2. A route compute that runs long carries a climbing elapsed marker on
//      the calculation banner, even when the phase message stops changing.
import { appPage, check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';

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
    document.getElementById('mapLoadingPill').hidden);
  check('the pill stays away from a settled map', atRest === true);

  // Hang every archive the next view needs; the tiles then load forever.
  for (const file of ['roads.pmtiles', 'basemap.pmtiles', 'overlays.pmtiles']) {
    site.publish(`/maps/washington/${file}`, () => { /* never responds */ });
  }
  await page.evaluate(() => {
    map.jumpTo({ center: [-117.426, 47.658], zoom: 14.2 });
  });
  const shown = await page.waitForFunction(
    () => !document.getElementById('mapLoadingPill').hidden,
    null, { timeout: 15000 }).then(() => true).catch(() => false);
  check('a stalled tile fill surfaces the loading pill', shown);

  // Let the archives answer again: the view completes and the pill leaves.
  for (const file of ['roads.pmtiles', 'basemap.pmtiles', 'overlays.pmtiles']) {
    site.unpublish(`/maps/washington/${file}`);
  }
  await page.evaluate(() => {
    map.jumpTo({ center: [-122.3321, 47.6062], zoom: 13 });
  });
  const settled = await page.waitForFunction(
    () => document.getElementById('mapLoadingPill').hidden,
    null, { timeout: 30000 }).then(() => true).catch(() => false);
  check('and leaves when the map settles again', settled);

  // The stall above left zombie 'loading' tiles behind (hung fetches never
  // resolve), which is exactly the chronic state a phone lives in — and in
  // that state a route switch used to summon the spinner AFTER its own
  // render, because geojson setData fires the same loading events as tile
  // fetching. Expire the hide cooldown, then storm a geojson source: the
  // spinner must not appear.
  await page.waitForTimeout(11000);
  const afterSwitch = await page.evaluate(async () => {
    map.addSource('__pill-probe', { type: 'geojson',
      data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: '__pill-probe', type: 'circle', source: '__pill-probe' });
    for (let i = 0; i < 6; i++) {
      map.getSource('__pill-probe').setData({ type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'Point',
          coordinates: [-122.33 + i * 0.001, 47.6] }, properties: {} }] });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await new Promise((resolve) => setTimeout(resolve, 3400));
    return document.getElementById('mapLoadingPill').hidden;
  });
  check('a route-switch style geojson update never summons the spinner',
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
