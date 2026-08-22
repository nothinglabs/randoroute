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

let ferryTapFixture = null;
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
  if (state.id === 'washington') {
    const feature = overlay?.features?.find((candidate) => candidate.properties?.n
      && candidate.geometry?.coordinates?.length > 8);
    const coordinate = feature?.geometry?.coordinates?.[Math.floor(feature.geometry.coordinates.length / 2)];
    if (feature && coordinate) ferryTapFixture = {
      name: feature.properties.n,
      target: { lng: coordinate[0], lat: coordinate[1] },
    };
  }
}

const site = await serveRepo();
const browser = await launchBrowser();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, serviceWorkers: 'block',
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

// A permanent ferry is a real routing edge, not just decoration. Tapping its
// mid-water line must open a named card and let a planned trip either require
// that crossing with a stop or exclude it with a roadblock.
const ferryCard = await page.evaluate(async ({ name, target }) => {
  const source = SOURCES.find((candidate) => candidate.id === 'ferries');
  window.__testFerryTap = target;

  routing.worker?.terminate?.();
  routing.worker = { postMessage: () => {}, terminate: () => {} };
  routing.ready = true;
  routing.loading = false;
  routing.start = [target.lng - 0.2, target.lat - 0.03];
  routing.end = [target.lng + 0.2, target.lat + 0.03];
  routing.startName = 'Test start';
  routing.endName = 'Test destination';
  // This deliberately lies within the normal 34 px route-snap tolerance but
  // away from the ferry tap. A ferry roadblock must stay on the ferry itself.
  routing.last = {
    ok: true,
    coords: [[target.lng - 0.02, target.lat + 0.003],
      [target.lng + 0.02, target.lat + 0.003]],
    segs: [],
  };

  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      map.off('idle', done);
      resolve();
    };
    map.on('idle', done);
    map.jumpTo({ center: target, zoom: 12 });
    setTimeout(done, 8000);
  });
  const point = map.project(target);
  const feature = featureAt(point);
  const opened = inspectRoadAt(point, target);
  const readout = document.getElementById('readout');
  return {
    name,
    opened,
    hitLayer: feature?.layer?.id,
    registered: HIT_SRC[hitId(source)] === source,
    heading: readout.querySelector('.rt-title')?.textContent,
    summary: readout.querySelector('.readout-safety-summary')?.textContent,
    actions: [...readout.querySelectorAll('.readout-primary-actions > button')]
      .map((button) => ({ text: button.textContent, disabled: button.disabled })),
    detailsHidden: document.getElementById('mapTapDetails')?.hidden,
  };
}, ferryTapFixture);
check('a ferry tap resolves through its registered wide hit target',
  ferryCard.opened && ferryCard.registered && ferryCard.hitLayer === 'ferries__hit',
  JSON.stringify(ferryCard));
check('the ferry card names and explains the crossing',
  ferryCard.heading && ferryCard.heading !== 'Point on map' && /Ferry route/.test(ferryCard.summary)
    && /require it/.test(ferryCard.summary), JSON.stringify(ferryCard));
check('a planned route offers direct stop and ferry-roadblock actions',
  ferryCard.actions.map((action) => action.text).join('|') === 'Add stop|Details|Avoid ferry'
    && ferryCard.actions.every((action) => !action.disabled), JSON.stringify(ferryCard.actions));

await page.locator('#readout .readout-details-toggle').click();
const ferryDetails = await page.evaluate(() => document.getElementById('mapTapDetails').textContent);
check('ferry Details reports planner availability and the map symbol',
  /RoutingAvailable to the route planner/.test(ferryDetails)
    && /Map symbolBlue dashed/.test(ferryDetails), ferryDetails);

await page.locator('#readout .readout-primary-stop').click();
const forced = await page.evaluate(() => ({
  count: routing.vias.length,
  point: routing.vias.at(-1)?.pt,
  name: routing.vias.at(-1)?.name,
  target: window.__testFerryTap,
}));
check('Add stop requires the selected ferry point in the itinerary',
  forced.count === 1 && forced.name === ferryCard.heading
    && Math.abs(forced.point[0] - forced.target.lng) < 1e-9
    && Math.abs(forced.point[1] - forced.target.lat) < 1e-9,
  JSON.stringify(forced));

await page.evaluate(() => {
  const target = window.__testFerryTap;
  inspectRoadAt(map.project(target), target);
});
await page.locator('#readout .readout-road-block').click();
const blocked = await page.evaluate(() => ({
  count: routing.blocks.length,
  point: routing.blocks.at(-1)?.pt,
  ferryName: routing.blocks.at(-1)?.ferryName,
  target: window.__testFerryTap,
}));
check('Avoid ferry puts the roadblock on the ferry instead of the nearby drawn route',
  blocked.count === 1
    && blocked.ferryName === ferryCard.heading
    && Math.abs(blocked.point[0] - blocked.target.lng) < 1e-9
    && Math.abs(blocked.point[1] - blocked.target.lat) < 1e-9,
  JSON.stringify(blocked));

const persistedBlock = await page.evaluate(() => {
  saveStateNow();
  const saved = JSON.parse(localStorage.getItem(STATE_KEY));
  const shared = readSharedRoute(shareRouteUrl());
  return {
    workerPayload: routeBlockPayload(routing.blocks[0]),
    savedName: saved?.route?.bn?.[0],
    sharedName: shared?.route?.bn?.[0],
  };
});
check('the selected ferry survives worker messages, refresh state and shared routes',
  persistedBlock.workerPayload?.ferryName === ferryCard.heading
    && persistedBlock.savedName === ferryCard.heading
    && persistedBlock.sharedName === ferryCard.heading,
  JSON.stringify(persistedBlock));

const removeAction = await page.evaluate(() => {
  const target = window.__testFerryTap;
  inspectRoadAt(map.project(target), target);
  return document.querySelector('#readout .readout-road-block')?.textContent;
});
check('the same ferry card can remove its roadblock', removeAction === 'Use ferry', removeAction);
await page.locator('#readout .readout-road-block').click();
check('Use ferry removes the ferry roadblock', await page.evaluate(() => routing.blocks.length === 0));

check('loading ferry context raises no page errors', pageErrors.length === 0,
  pageErrors.slice(0, 3).join(' | '));

await browser.close();
site.close();
done();
