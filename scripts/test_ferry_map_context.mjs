#!/usr/bin/env node
// Ferries are permanent map context, not geometry invented only after a route
// is selected. The shipped overlay must account for every ferry edge in the
// graph without painting split/parallel graph fragments as a heavy bundle, and
// the map must draw it while the planner is still blank.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  ROOT, check, done, launchBrowser, mapStates, routerWorker, serveRepo,
} from './testlib/harness.mjs';

for (const state of mapStates().filter((candidate) => candidate.datasets?.graph)) {
  const worker = routerWorker({ state: state.id });
  const graphFerryEdges = worker.run(`(() => {
    let count = 0;
    for (let edge = 0; edge < E; edge++) if (eFlags[edge] & 32) count++;
    return count;
  })()`);
  let overlay = null;
  try {
    overlay = JSON.parse(gunzipSync(readFileSync(
      join(ROOT, 'maps', state.id, 'ferries.geojson.gz'))));
  } catch { /* reported by the checks below */ }
  check(`${state.id}: declares its ferry overlay`, state.datasets.ferries === true);
  const representedEdges = overlay?.features?.reduce(
    (sum, feature) => sum + Number(feature.properties?.e || 0), 0);
  check(`${state.id}: overlay accounts for every graph ferry edge`,
    representedEdges === graphFerryEdges,
    `${representedEdges ?? 'missing'} represented / ${graphFerryEdges} graph`);
  check(`${state.id}: split or parallel graph edges are dissolved for display`,
    overlay?.features?.length < graphFerryEdges,
    `${overlay?.features?.length ?? 'missing'} lines / ${graphFerryEdges} graph edges`);
  check(`${state.id}: ferry geometry is usable linework`,
    overlay?.features?.every((feature) => feature.geometry?.type === 'LineString'
      && feature.geometry.coordinates?.length >= 2));
}

const site = await serveRepo();
const browser = await launchBrowser();
const context = await browser.newContext({
  viewport: { width: 800, height: 600 }, serviceWorkers: 'block',
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
// The permanent overlay must not depend on loading the large routing graph.
await page.route('**/graph2.bin.gz*', (route) => route.abort());
await page.goto(site.url, { waitUntil: 'load' });
await page.waitForFunction(() => window.map && map.getLayer('ferries')
  && map.isSourceLoaded('ferries'), { timeout: 30000 });
await page.evaluate(() => new Promise((resolve) => {
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    map.off('idle', done);
    resolve();
  };
  map.on('idle', done);
  map.jumpTo({ center: Region.defaultCenter, zoom: Math.max(Region.defaultZoom, 11) });
  setTimeout(done, 12000);
}));
const live = await page.evaluate(() => {
  const order = map.getStyle().layers.map((layer) => layer.id);
  return {
    sourceFeatures: map.querySourceFeatures('ferries').length,
    renderedFeatures: map.queryRenderedFeatures({ layers: ['ferries'] }).length,
    dashed: map.getPaintProperty('ferries', 'line-dasharray'),
    opacity: map.getPaintProperty('ferries', 'line-opacity'),
    minzoom: map.getLayer('ferries').minzoom,
    belowRoads: order.indexOf('ferries') < order.indexOf('basemap-major-casing'),
    hasRoute: !!map.getSource('route'),
  };
});
check('the blank planner loads ferry context', live.sourceFeatures > 0, JSON.stringify(live));
check('ferry lines render across Puget Sound without an active route',
  live.renderedFeatures > 0 && !live.hasRoute, JSON.stringify(live));
check('permanent ferries use a dashed water-route treatment',
  Array.isArray(live.dashed) && live.dashed.length === 2, JSON.stringify(live.dashed));
check('ferry context stays quiet below regional detail zoom', live.minzoom >= 7);
check('ferry context remains subordinate to the road verdicts', live.opacity < 0.85,
  JSON.stringify({ opacity: live.opacity }));
check('ferry context stays underneath the street network', live.belowRoads);
check('loading ferry context raises no page errors', pageErrors.length === 0,
  pageErrors.slice(0, 3).join(' | '));

await browser.close();
site.close();
done();
