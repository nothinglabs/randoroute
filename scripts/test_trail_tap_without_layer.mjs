#!/usr/bin/env node
// A layer toggle controls COLOURING. It never controls whether a way is there.
//
// The rule is already written into the map: trailBaseId draws an always-on
// neutral ghost of every trail, because with "Off-street trails" switched off a
// trail used to be a floating name over literally nothing. The tap never
// learned it. trailHitId's visibility was forced on but its FILTER was gated on
// the same toggle, so with trails off the layer was visible and matched
// nothing, and tapping the Willamette Greenway Trail in Portland fell through
// to the generic "point on map" card (field report).
//
// Visible-and-matching-nothing is the hard case to spot by eye, which is why
// this asserts on what the hit layer actually returns.
import { appPage, check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);
await page.waitForFunction(
  () => typeof applyDisplayModeAll === 'function' && typeof display !== 'undefined'
    && map.getLayer('osm__trail-hit'),
  null, { timeout: 90000 });

const probe = (trailsOn) => page.evaluate(async (on) => {
  const settled = () => new Promise((resolve) => {
    map.once('idle', resolve);
    map.triggerRepaint();
  });
  display.offstreetTrails = on;
  applyDisplayModeAll();
  // The Burke-Gilman along Lake Union: dense, unambiguous off-street trail.
  map.jumpTo({ center: [-122.3325, 47.6480], zoom: 15 });
  await settled();
  return {
    hits: map.queryRenderedFeatures({ layers: ['osm__trail-hit'] }).length,
    visibility: map.getLayoutProperty('osm__trail-hit', 'visibility'),
    // The lime colouring is what the toggle is FOR, so it must still respond.
    coloured: map.queryRenderedFeatures({ layers: ['osm__trail'] }).length,
  };
}, trailsOn);

const on = await probe(true);
check('with the trails layer on, trails are tappable', on.hits > 0, JSON.stringify(on));
check('and coloured', on.coloured > 0, JSON.stringify(on));

const off = await probe(false);
check('with the trails layer OFF, the trail is still tappable',
  off.hits > 0, JSON.stringify(off));
check('and the hit layer is still visible, not just filtered to nothing',
  off.visibility !== 'none', JSON.stringify(off));
check('while the colouring the toggle controls does switch off',
  off.coloured === 0, JSON.stringify(off));
check('the toggle changed what is drawn, not what exists',
  off.hits === on.hits, `${off.hits} tappable off vs ${on.hits} on`);

await browser.close();
await site.close();
done();
