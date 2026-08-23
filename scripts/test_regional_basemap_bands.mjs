#!/usr/bin/env node
// The regional zoom band must never be a bare cream sheet. Unconstrained
// renderers draw the full context archive from its own minimum zoom; a
// constrained renderer (which drops the ~1.2 MB low-zoom context tiles under
// memory pressure) keeps the z9 floor but carries an independent place-label
// source that no tile archive can take down. Field report: a 5-mile view on
// an iPhone showed overlays over blank ground with no town names at all.
import { appPage, check, done, launchBrowser, playwright, chromiumPath, serveRepo }
  from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
try {
  const desktop = await appPage(browser, site.port, { desktop: true });
  await desktop.waitForFunction(() => window.map && map.loaded && map.loaded(),
    { timeout: 120000 });
  const desktopBands = await desktop.evaluate(() => {
    const layer = (id) => map.getStyle().layers.find((l) => l.id === id);
    return {
      constrained: isConstrainedDevice(),
      landMin: layer('basemap-land')?.minzoom,
      waterMin: layer('basemap-water')?.minzoom,
      placesMin: layer('basemap-place-labels')?.minzoom,
      reliefLayer: !!layer('basemap-regional-places'),
    };
  });
  check('an unconstrained renderer draws context from the archive floor',
    desktopBands.constrained === false && desktopBands.landMin === 4
      && desktopBands.waterMin === 4 && desktopBands.placesMin === 4
      && !desktopBands.reliefLayer, JSON.stringify(desktopBands));
  await desktop.close();

  const phoneContext = await browser.newContext({
    viewport: { width: 430, height: 900 }, hasTouch: true, isMobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) '
      + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  });
  const phone = await phoneContext.newPage();
  await phone.goto(`http://localhost:${site.port}/index.html`, { waitUntil: 'load' });
  await phone.waitForFunction(() => window.map && map.loaded && map.loaded(),
    { timeout: 120000 });
  await phone.waitForFunction(async () => {
    await ensurePlaces();
    const source = map.getSource('basemap-regional-places');
    return !!source && (map.querySourceFeatures?.('basemap-regional-places') || []).length >= 0;
  }, { timeout: 60000 });
  const phoneBands = await phone.evaluate(async () => {
    await ensurePlaces();
    updateRegionalPlaceLabels();
    const layer = (id) => map.getStyle().layers.find((l) => l.id === id);
    const data = map.getSource('basemap-regional-places')?.serialize?.()?.data;
    return {
      constrained: isConstrainedDevice(),
      landMin: layer('basemap-land')?.minzoom,
      reliefLayer: !!layer('basemap-regional-places'),
      reliefMin: layer('basemap-regional-places')?.minzoom,
      features: Array.isArray(data?.features) ? data.features.length : -1,
      sampleNames: (data?.features || []).slice(0, 3).map((f) => f.properties.name),
    };
  });
  check('a constrained renderer keeps the z9 context floor with archive-free town labels',
    phoneBands.constrained === true && phoneBands.landMin === 9
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
