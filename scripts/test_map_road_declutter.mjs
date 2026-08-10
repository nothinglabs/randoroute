#!/usr/bin/env node
// A city-wide view should explain the road hierarchy, not render every block.
// Local streets are the densest class in roads.pmtiles, so their basemap and
// safety treatments must share one neighborhood-scale reveal. Cycling-specific
// facilities and trails remain exempt in app.js and can appear earlier.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import vm from 'node:vm';
import { appPage, launchBrowser, serveRepo, ROOT } from './testlib/harness.mjs';

const source = readFileSync(new URL('../basemap-style.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
// The style is built from the loaded state's folder and omits a source the
// state does not ship, so the sandbox needs the real region rather than a stub.
const { Region } = createRequire(import.meta.url)(join(ROOT, 'region.js'));
const window = {
  location: { href: 'https://example.test/randoroute/' },
  setTimeout,
};
vm.runInNewContext(source, { window, URL, console, Region });

const { ROAD_MIN_ZOOM, createStyle } = window.BikeBasemap;
const style = createStyle();
const layer = (id) => style.layers.find((candidate) => candidate.id === id);

assert.equal(ROAD_MIN_ZOOM.major, 5, 'major roads should retain statewide context');
assert.equal(ROAD_MIN_ZOOM.medium, 8, 'secondary roads should retain regional context');
assert.ok(ROAD_MIN_ZOOM.minor >= 10 && ROAD_MIN_ZOOM.minor < 11,
  'tertiary streets should wait until city scale');
assert.ok(ROAD_MIN_ZOOM.local >= 12.25,
  `local streets should wait for neighborhood detail, got z${ROAD_MIN_ZOOM.local}`);
assert.equal(layer('basemap-local-casing').minzoom, ROAD_MIN_ZOOM.local,
  'the local casing should use the shared detail threshold');
assert.equal(layer('basemap-local').minzoom, ROAD_MIN_ZOOM.local,
  'the local street interior should use the shared detail threshold');
assert.equal(layer('basemap-minor').minzoom, ROAD_MIN_ZOOM.minor,
  'tertiary streets should use their own city-scale threshold');
assert.ok(layer('basemap-local-labels').minzoom > ROAD_MIN_ZOOM.local,
  'local labels should follow their streets instead of floating over an empty map');

const sharedThresholdUses = app.match(/BikeBasemap\.ROAD_MIN_ZOOM\.local/g) || [];
assert.ok(sharedThresholdUses.length >= 3,
  'safety fills, hit targets, and neutral trail context should share the basemap threshold');
assert.match(app, /id: trailId\(src\)[\s\S]*?minzoom: 0,/,
  'cycling trails should remain eligible below the ordinary local-street threshold');
assert.match(app, /earlyBikeFacility[\s\S]*?BikeBasemap\.ROAD_MIN_ZOOM\.local/,
  'bike facilities should retain their early-reveal exemption');
const facilityThreshold = Number(/const BIKE_FACILITY_MIN_ZOOM = ([\d.]+);/.exec(app)?.[1]);
assert.ok(facilityThreshold >= 11 && facilityThreshold < ROAD_MIN_ZOOM.local,
  `bike facilities should appear between city and local detail: z${facilityThreshold}`);

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);
await page.waitForFunction(() => map.getLayer('basemap-local') && map.getLayer('roads'),
  { timeout: 30000 });

async function sampleAt(zoom) {
  return page.evaluate(async ({ zoom, localThreshold }) => {
    map.jumpTo({ center: [-122.335, 47.61], zoom });
    await new Promise((resolve) => {
      const done = () => { map.off('idle', done); resolve(); };
      map.on('idle', done);
      setTimeout(resolve, 15000);
    });
    const rendered = (id) => map.getLayer(id)
      ? map.queryRenderedFeatures({ layers: [id] }) : [];
    const localLayer = map.getStyle().layers.find((candidate) => candidate.id === 'basemap-local');
    return {
      zoom: map.getZoom(),
      localThreshold,
      localMinZoom: localLayer?.minzoom,
      local: rendered('basemap-local').length,
      medium: rendered('basemap-medium').length,
      bikeFacilities: rendered('roads').filter((feature) => feature.properties.f === 1).length,
      trails: rendered('osm__trail').length,
    };
  }, { zoom, localThreshold: ROAD_MIN_ZOOM.local });
}

const city = await sampleAt(ROAD_MIN_ZOOM.local - 0.2);
const neighborhood = await sampleAt(ROAD_MIN_ZOOM.local + 0.35);
assert.equal(city.localMinZoom, ROAD_MIN_ZOOM.local,
  `the live map should retain the local-street cutoff: ${JSON.stringify(city)}`);
assert.ok(city.zoom < city.localMinZoom,
  `the city sample should sit below local-street detail: ${JSON.stringify(city)}`);
assert.ok(city.medium > 0,
  `the useful city road hierarchy should remain: ${JSON.stringify(city)}`);
assert.ok(city.bikeFacilities + city.trails > 0,
  `cycling infrastructure should remain before local streets: ${JSON.stringify(city)}`);
assert.ok(neighborhood.local > 0,
  `local streets should return at neighborhood scale: ${JSON.stringify(neighborhood)}`);
assert.equal(page.pageErrors.length, 0, page.pageErrors.join(' | '));

await browser.close();
site.close();
console.log('Map road decluttering tests passed.');
