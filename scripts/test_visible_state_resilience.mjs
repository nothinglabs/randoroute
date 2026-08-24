#!/usr/bin/env node
// An installed neighbor's layers must survive a rider's real network: a
// transient tile error is not a reason to strip the state off the map, while
// an archive that never loads at all must still detach so one wedged source
// cannot hold map.loaded() false forever. Field report: layers vanished
// "without reason" on iOS — one dropped request detached the whole state.
import { appPage, check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
try {
  const page = await appPage(browser, site.port, { desktop: true });
  await page.waitForFunction(() => window.map && map.loaded && map.loaded(), null,
    { timeout: 120000 });

  // A Columbia-area viewport attaches installed non-home Oregon.
  await page.evaluate(() => {
    map.jumpTo({ center: [-122.6, 45.62], zoom: 10 });
    map.fire('moveend');
  });
  await page.waitForFunction(() => !!map.getSource('state-oregon-basemap-context'),
    null, { timeout: 60000 });
  await page.waitForFunction(() => map.isSourceLoaded('state-oregon-basemap-context'),
    null, { timeout: 60000 });
  const attached = await page.evaluate(() => ({
    sources: Object.keys(map.getStyle().sources).filter((id) => id.startsWith('state-oregon')),
    layers: map.getStyle().layers.filter((l) => l.id.startsWith('state-oregon-')).length,
  }));
  check('an installed neighbor attaches with sources and cloned layers',
    attached.sources.length >= 2 && attached.layers > 0, JSON.stringify(attached));

  // A transient error on a loaded source — one dropped tile request — must
  // not strip the state.
  const afterTransient = await page.evaluate(() => {
    map.fire('error', { sourceId: 'state-oregon-basemap-roads', error: new Error('tile dropped') });
    map.fire('error', { sourceId: 'state-oregon-basemap-context', error: new Error('tile dropped') });
    return {
      sources: Object.keys(map.getStyle().sources).filter((id) => id.startsWith('state-oregon')).length,
      layers: map.getStyle().layers.filter((l) => l.id.startsWith('state-oregon-')).length,
    };
  });
  check('a transient error on a loaded source does not strip the state',
    afterTransient.sources >= 2 && afterTransient.layers > 0, JSON.stringify(afterTransient));

  // A sibling can still be in its first-load window after context and roads
  // are already useful. Its error must detach only that source; stripping the
  // whole state here is the field failure where land and every layer vanish
  // together because one optional overlay request dropped.
  const afterOverlayFailure = await page.evaluate(() => {
    map.__visibleStateEverLoaded.delete('state-oregon-basemap-overlays');
    map.fire('error', {
      sourceId: 'state-oregon-basemap-overlays', error: new Error('overlay header dropped'),
    });
    return {
      context: !!map.getSource('state-oregon-basemap-context'),
      roads: !!map.getSource('state-oregon-basemap-roads'),
      overlays: !!map.getSource('state-oregon-basemap-overlays'),
      contextLayers: map.getStyle().layers
        .filter((layer) => layer.source === 'state-oregon-basemap-context').length,
      roadLayers: map.getStyle().layers
        .filter((layer) => layer.source === 'state-oregon-basemap-roads').length,
    };
  });
  check('a first-load failure detaches only its dataset and preserves working siblings',
    afterOverlayFailure.context && afterOverlayFailure.roads
      && !afterOverlayFailure.overlays
      && afterOverlayFailure.contextLayers > 0 && afterOverlayFailure.roadLayers > 0,
    JSON.stringify(afterOverlayFailure));
  await page.waitForFunction(() => map.getSource('state-oregon-basemap-overlays')
      && map.isSourceLoaded('state-oregon-basemap-overlays')
      && map.getStyle().layers.some((layer) =>
        layer.id.startsWith('state-oregon-safety-osm')),
    null, { timeout: 120000 });

  // Pan home to detach, break the archive, pan back: the failed attachment
  // must self-heal by detaching rather than wedging the style.
  await page.evaluate(() => {
    map.jumpTo({ center: [-122.33, 47.6], zoom: 12 });
    map.fire('moveend');
  });
  await page.waitForFunction(() => !map.getSource('state-oregon-basemap-context'),
    null, { timeout: 60000 });
  site.publish('/maps/oregon/basemap.pmtiles', (req, res) => { res.writeHead(404); res.end(); });
  site.publish('/maps/oregon/roads.pmtiles', (req, res) => { res.writeHead(404); res.end(); });
  site.publish('/maps/oregon/overlays.pmtiles', (req, res) => { res.writeHead(404); res.end(); });
  await page.evaluate(() => {
    map.jumpTo({ center: [-122.6, 45.62], zoom: 10 });
    map.fire('moveend');
  });
  // The attach happens against a dead archive. Whether the session's warm
  // protocol header lets the source stand with blank tiles, or a cold header
  // failure makes the error hook detach it, the style must settle —
  // map.loaded() coming back true is the anti-wedge invariant. (The cold
  // wedge-and-detach path is proven by test_offline_pwa's offline restart.)
  const settled = await page
    .waitForFunction(() => map.loaded(), null, { timeout: 60000 })
    .then(() => true).catch(() => false);
  check('a dead archive never wedges the style', settled,
    await page.evaluate(() => JSON.stringify({
      loaded: map.loaded(),
      oregon: Object.keys(map.getStyle().sources).filter((id) => id.startsWith('state-oregon')),
    })));

  // Restore the archive; the next viewport change re-attaches and the clones
  // return — a temporary outage is not a permanent loss.
  site.unpublish('/maps/oregon/basemap.pmtiles');
  site.unpublish('/maps/oregon/roads.pmtiles');
  site.unpublish('/maps/oregon/overlays.pmtiles');
  await page.evaluate(() => {
    map.jumpTo({ center: [-122.61, 45.63], zoom: 10.5 });
    map.fire('moveend');
  });
  const recovered = await page
    .waitForFunction(() => !!map.getSource('state-oregon-basemap-context')
      && map.isSourceLoaded('state-oregon-basemap-context'), null, { timeout: 60000 })
    .then(() => true).catch(() => false);
  const recoveredLayers = await page.evaluate(() =>
    map.getStyle().layers.filter((l) => l.id.startsWith('state-oregon-')).length);
  check('the state re-attaches with its layers once the archive recovers',
    recovered && recoveredLayers > 0, JSON.stringify({ recovered, recoveredLayers }));

  check('no page errors', (page.pageErrors || []).length === 0,
    (page.pageErrors || []).join(' | '));
} finally {
  await browser.close();
  site.close();
}

done();
