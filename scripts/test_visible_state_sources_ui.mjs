#!/usr/bin/env node
// A Washington-home browser must draw Oregon ground when the viewport crosses
// the state line, then release that archive when it returns north.
import { appPage, check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
try {
  const page = await appPage(browser, site.port);
  await page.waitForFunction(() =>
    typeof map !== 'undefined' && typeof map.getLayer === 'function'
      && map.getLayer('basemap-land'));
  await page.evaluate(() => { map.jumpTo({ center: [-122.3321, 47.6062], zoom: 13 }); });
  await page.waitForFunction(() => !map.getSource('state-oregon-basemap-context'));
  const initial = await page.evaluate(() => ({
    home: Region.id,
    oregonContext: !!map.getSource('state-oregon-basemap-context'),
  }));
  check('a Washington viewport does not preload Oregon tile archives',
    initial.home === 'washington' && !initial.oregonContext, JSON.stringify(initial));

  await page.evaluate(() => { map.jumpTo({ center: [-122.6765, 45.5231], zoom: 13 }); });
  await page.waitForFunction(() =>
    document.body.dataset.visibleMapStateIds?.includes('oregon')
      && map.getSource('state-oregon-basemap-context')
      && map.getLayer('state-oregon-basemap-land'));
  await page.evaluate(() => Promise.race([
    new Promise((resolve) => map.once('idle', () => resolve())),
    new Promise((resolve) => setTimeout(resolve, 30000)),
  ]));
  const oregon = await page.evaluate(() => ({
    visible: document.body.dataset.visibleMapStateIds,
    ground: map.queryRenderedFeatures({ layers: [
      'state-oregon-basemap-land', 'state-oregon-basemap-land-detail',
    ] }).length,
    roads: map.queryRenderedFeatures({ layers: [
      'state-oregon-basemap-major', 'state-oregon-basemap-medium',
      'state-oregon-basemap-minor', 'state-oregon-basemap-local',
    ] }).length,
  }));
  check('the Oregon viewport renders ground and roads from Oregon archives',
    oregon.visible.includes('oregon') && oregon.ground > 0 && oregon.roads > 0,
    JSON.stringify(oregon));

  // Designated bike routes are a home-region GeoJSON, not a tile archive, so
  // they need their own mirror: a Washington-home browser in Portland must
  // still draw Oregon's signed-route ribbon (field report: routes showed only
  // in the home state).
  await page.waitForFunction(() =>
    map.getLayer('state-oregon-routes-ribbon')
      && map.getSource('state-oregon-routes'), null, { timeout: 60000 });
  await page.waitForFunction(() => map.queryRenderedFeatures(
    { layers: ['state-oregon-routes-ribbon'] }).length > 0, null, { timeout: 60000 });
  const ribbon = await page.evaluate(() => ({
    rendered: map.queryRenderedFeatures({ layers: ['state-oregon-routes-ribbon'] }).length,
    visibility: map.getLayoutProperty('state-oregon-routes-ribbon', 'visibility'),
  }));
  check('the Oregon viewport draws Oregon designated bike routes',
    ribbon.rendered > 0 && ribbon.visibility === 'visible', JSON.stringify(ribbon));

  await page.evaluate(() => { map.jumpTo({ center: [-122.3321, 47.6062], zoom: 13 }); });
  await page.waitForFunction(() => !map.getSource('state-oregon-basemap-context'));
  const returned = await page.evaluate(() => ({
    visible: document.body.dataset.visibleMapStateIds,
    source: !!map.getSource('state-oregon-basemap-context'),
    layer: !!map.getLayer('state-oregon-basemap-land'),
    routesLayer: !!map.getLayer('state-oregon-routes-ribbon'),
    routesSource: !!map.getSource('state-oregon-routes'),
  }));
  check('leaving Oregon releases its detailed renderer sources and layers',
    returned.visible === 'washington' && !returned.source && !returned.layer
      && !returned.routesLayer && !returned.routesSource,
    JSON.stringify(returned));
  check('viewport source switching produces no page errors', page.pageErrors.length === 0,
    page.pageErrors.join(' | '));
} finally {
  await browser.close();
  site.close();
}

done();
