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
  await page.waitForFunction(() => window.map && map.loaded && map.loaded(), { timeout: 120000 });

  // A Columbia-area viewport attaches installed non-home Oregon.
  await page.evaluate(() => {
    map.jumpTo({ center: [-122.6, 45.62], zoom: 10 });
    map.fire('moveend');
  });
  await page.waitForFunction(() => !!map.getSource('state-oregon-basemap-context'),
    { timeout: 60000 });
  await page.waitForFunction(() => map.isSourceLoaded('state-oregon-basemap-context'),
    { timeout: 60000 });
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

  // And it self-heals: MapLibre never re-asks for a tile it was handed an
  // error for, so once the burst settles the wounded source must be reloaded
  // (setUrl) — debounced, once — instead of leaving permanent holes. Field:
  // lakes without water, safety color missing on whole archives.
  const healed = await page.evaluate(() => new Promise((resolve) => {
    const source = map.getSource('state-oregon-basemap-roads');
    const original = source.setUrl.bind(source);
    let called = 0;
    source.setUrl = (url) => { called += 1; return original(url); };
    map.fire('error', { sourceId: 'state-oregon-basemap-roads', error: new Error('range failed') });
    map.fire('error', { sourceId: 'state-oregon-basemap-roads', error: new Error('range failed') });
    setTimeout(() => resolve({ called,
      still: !!map.getSource('state-oregon-basemap-roads') }), 6500);
  }));
  check('a loaded source reloads itself once after an error burst',
    healed.called === 1 && healed.still, JSON.stringify(healed));

  // Pan home to detach, break the archive, pan back: the failed attachment
  // must self-heal by detaching rather than wedging the style.
  await page.evaluate(() => {
    map.jumpTo({ center: [-122.33, 47.6], zoom: 12 });
    map.fire('moveend');
  });
  await page.waitForFunction(() => !map.getSource('state-oregon-basemap-context'),
    { timeout: 60000 });
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
    .waitForFunction(() => map.loaded(), { timeout: 60000 })
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
      && map.isSourceLoaded('state-oregon-basemap-context'), { timeout: 60000 })
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
