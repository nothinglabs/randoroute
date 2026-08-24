#!/usr/bin/env node
// The regional zoom band must remain coastline-correct without loading the
// detailed archive's ~1.2 MB low-zoom tiles. Unconstrained renderers draw the
// full context archive from its own minimum zoom; a constrained renderer uses
// the compact regional archive at z4-z8 plus an archive-free place-label
// source. Field reports: a 5-mile iPhone view showed blank ground, then the
// administrative fallback filled Green Lake and joined Whidbey to mainland.
import { appPage, check, done, launchBrowser, playwright, chromiumPath, serveRepo }
  from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
try {
  const desktop = await appPage(browser, site.port, { desktop: true });
  await desktop.waitForFunction(() => window.map && map.loaded && map.loaded(),
    null, { timeout: 120000 });
  const desktopBands = await desktop.evaluate(() => {
    const layer = (id) => map.getStyle().layers.find((l) => l.id === id);
    return {
      constrained: isConstrainedDevice(),
      landMin: layer('basemap-land')?.minzoom,
      waterMin: layer('basemap-water')?.minzoom,
      regionalLayer: !!layer('basemap-regional-land-detail'),
      placesMin: layer('basemap-place-labels')?.minzoom,
      reliefLayer: !!layer('basemap-regional-places'),
    };
  });
  check('an unconstrained renderer draws context from the archive floor',
    desktopBands.constrained === false && desktopBands.landMin === 4
      && desktopBands.waterMin === 4 && desktopBands.placesMin === 4
      && !desktopBands.regionalLayer && !desktopBands.reliefLayer,
    JSON.stringify(desktopBands));
  await desktop.close();

  const phoneContext = await browser.newContext({
    viewport: { width: 430, height: 900 }, hasTouch: true, isMobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) '
      + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  });
  const phone = await phoneContext.newPage();
  await phone.goto(`http://localhost:${site.port}/index.html`, { waitUntil: 'load' });
  await phone.waitForFunction(() => window.map && map.loaded && map.loaded(),
    null, { timeout: 120000 });
  await phone.waitForFunction(async () => {
    await ensurePlaces();
    const source = map.getSource('basemap-regional-places');
    return !!source && (map.querySourceFeatures?.('basemap-regional-places') || []).length >= 0;
  }, null, { timeout: 60000 });
  const phoneBands = await phone.evaluate(async () => {
    await ensurePlaces();
    updateRegionalPlaceLabels();
    const layer = (id) => map.getStyle().layers.find((l) => l.id === id);
    const data = map.getSource('basemap-regional-places')?.serialize?.()?.data;
    return {
      constrained: isConstrainedDevice(),
      contextLandMin: layer('basemap-land')?.minzoom,
      regionalLandMin: layer('basemap-regional-land-detail')?.minzoom,
      regionalLandMax: layer('basemap-regional-land-detail')?.maxzoom,
      coarseRegionalLandMin: layer('basemap-regional-land')?.minzoom,
      coarseRegionalLandMax: layer('basemap-regional-land')?.maxzoom,
      coarseRegionalLandIndex: map.getStyle().layers
        .findIndex((item) => item.id === 'basemap-regional-land'),
      regionalWaterMin: layer('basemap-regional-water')?.minzoom,
      regionalWaterMax: layer('basemap-regional-water')?.maxzoom,
      administrativeGround: !!layer('basemap-state-ground'),
      administrativeGroundFilter: JSON.stringify(layer('basemap-state-ground')?.filter || null),
      administrativeGroundIndex: map.getStyle().layers
        .findIndex((item) => item.id === 'basemap-state-ground'),
      regionalLandIndex: map.getStyle().layers
        .findIndex((item) => item.id === 'basemap-regional-land-detail'),
      regionalWaterIndex: map.getStyle().layers
        .findIndex((item) => item.id === 'basemap-regional-water'),
      regionalSource: map.getSource('basemap-regional')?.serialize?.()?.url,
      reliefLayer: !!layer('basemap-regional-places'),
      reliefMin: layer('basemap-regional-places')?.minzoom,
      features: Array.isArray(data?.features) ? data.features.length : -1,
      sampleNames: (data?.features || []).slice(0, 3).map((f) => f.properties.name),
    };
  });
  check('a constrained renderer uses regional geometry below its z9 context floor',
    phoneBands.constrained === true && phoneBands.contextLandMin === 9
      // No maxzoom: overzoomed regional tiles stay the coastline-correct
      // backdrop under the detailed layers at every zoom, so the z9 handoff
      // and a dropped detail tile can never regress to sea-as-land.
      && phoneBands.regionalLandMin === 4 && phoneBands.regionalLandMax === undefined
      && phoneBands.regionalWaterMin === 4 && phoneBands.regionalWaterMax === undefined
      // land_detail is the coastline band only; the generalized land layer is
      // the ground for inland areas far from the coast, drawn beneath it.
      && phoneBands.coarseRegionalLandMin === 4
      && phoneBands.coarseRegionalLandMax === undefined
      && phoneBands.administrativeGround
      // The Census fill includes marine water; the home state must be carved
      // out of it wherever its coastline-true regional archive serves.
      && phoneBands.administrativeGroundFilter.includes('washington')
      && phoneBands.administrativeGroundIndex < phoneBands.coarseRegionalLandIndex
      && phoneBands.coarseRegionalLandIndex < phoneBands.regionalLandIndex
      && phoneBands.regionalLandIndex < phoneBands.regionalWaterIndex
      && /regional\.pmtiles/.test(phoneBands.regionalSource || '')
      && phoneBands.reliefLayer && phoneBands.reliefMin === 5
      && phoneBands.features >= 100, JSON.stringify(phoneBands));
  check('the biggest cities lead the label set',
    (phoneBands.sampleNames || []).includes('Seattle'),
    JSON.stringify(phoneBands.sampleNames));
} finally {
  await browser.close();
  site.close();
}

done();
