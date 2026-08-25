#!/usr/bin/env node
// A port is not openable merely because its region.json parses. Launch the real
// app against Oregon's shipped PMTiles archives and prove the state selector,
// source URLs, range-serving path, rendered map, and offline place index all
// agree. No invented state and no Washington archive standing in for Oregon.
import { check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const context = await browser.newContext({
  serviceWorkers: 'block', viewport: { width: 430, height: 900 },
  hasTouch: true, isMobile: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) '
    + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
});
await context.addInitScript(() => localStorage.setItem('jra-map-state-1', 'oregon'));
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(site.url, { waitUntil: 'load' });
await page.waitForFunction(() => window.Region?.id === 'oregon' && window.map,
  { timeout: 30000 });
await page.waitForFunction(() => map.loaded && map.loaded(), { timeout: 90000 });
await page.waitForFunction(() => map.queryRenderedFeatures().length > 0,
  { timeout: 30000 });

const observed = await page.evaluate(async () => {
  await ensurePlaces();
  const style = map.getStyle();
  const sources = Object.fromEntries(Object.entries(style.sources)
    .map(([id, source]) => [id, source.url || source.tiles || null]));
  return {
    region: Region.id,
    dataRoot: Region.dataRoot,
    centre: map.getCenter(),
    sources,
    rendered: map.queryRenderedFeatures().length,
    placeCount: placesIndex?.length || 0,
    hasPortland: (placesIndex || []).some((place) =>
      String(place[0] || '').toLowerCase() === 'portland'),
  };
});
await page.evaluate(() => { map.jumpTo({ center: [-122.6765, 45.5231], zoom: 7 }); });
await page.waitForFunction(() => map.isSourceLoaded('basemap-regional'),
  null, { timeout: 60000 });
const sourceText = JSON.stringify(observed.sources);
const oregonArchiveRequests = site.requests.filter((request) =>
  /\/maps\/oregon\/(?:regional|basemap|roads|overlays)\.pmtiles/.test(request.url));

check('the real app opens in Oregon',
  observed.region === 'oregon' && observed.dataRoot === 'maps/oregon',
  JSON.stringify({ region: observed.region, dataRoot: observed.dataRoot }));
check('it opens over Portland rather than restoring another state\'s view',
  Math.abs(observed.centre.lng - -122.6765) < 0.2
    && Math.abs(observed.centre.lat - 45.5231) < 0.2,
  `${observed.centre.lng.toFixed(3)}, ${observed.centre.lat.toFixed(3)}`);
check('the live style points at Oregon\'s compact regional, detailed basemap and road archives',
  sourceText.includes('maps/oregon/regional.pmtiles')
    && sourceText.includes('maps/oregon/basemap.pmtiles')
    && sourceText.includes('maps/oregon/roads.pmtiles'), sourceText);
check('PMTiles actually reads byte ranges from the Oregon archives',
  oregonArchiveRequests.some((request) => /regional\.pmtiles/.test(request.url) && request.range)
    && oregonArchiveRequests.some((request) => /basemap\.pmtiles/.test(request.url) && request.range)
    && oregonArchiveRequests.some((request) => /roads\.pmtiles/.test(request.url) && request.range),
  JSON.stringify(oregonArchiveRequests.slice(0, 12)));
check('Oregon tile features reach the rendered map', observed.rendered > 0,
  String(observed.rendered));
check('Oregon\'s real offline place index is usable',
  observed.placeCount > 1000 && observed.hasPortland,
  JSON.stringify({ count: observed.placeCount, hasPortland: observed.hasPortland }));
check('opening Oregon raises no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
await site.close();
done();
