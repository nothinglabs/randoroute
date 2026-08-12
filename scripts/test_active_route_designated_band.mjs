#!/usr/bin/env node
// A selected route is wider than the ordinary map lines. Where it follows a
// designated cycle route, the designation therefore needs its own route-only
// underlay; relying on the statewide ribbon leaves it completely covered.
// Measure the real MapLibre style at rider-relevant zooms so this cannot drift
// back into an invisible sliver.
import { appPage, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);
await page.waitForFunction(() => typeof drawRoute === 'function' && window.map,
  { timeout: 90000 });

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};

const result = await page.evaluate(() => {
  const coords = [[-122.34, 47.61], [-122.33, 47.615], [-122.32, 47.62]];
  drawRoute(coords, [], [{
    c0: 0, c1: 2, lenM: 1800, mph: 25, sh: 4, flags: 64,
    level: 1, facility: 0,
  }]);
  const style = map.getStyle().layers.map((layer) => layer.id);
  const widthAt = (zoom) => {
    const expression = map.getPaintProperty('route-designated-band', 'line-width');
    // This expression is deliberately a simple linear zoom ladder. Evaluate
    // its stops directly; getPaintProperty returns the expression itself,
    // while queryRenderedFeatures cannot report a paint width.
    const stops = [];
    for (let index = 3; index < expression.length; index += 2) {
      stops.push([Number(expression[index]), Number(expression[index + 1])]);
    }
    if (zoom <= stops[0][0]) return stops[0][1];
    if (zoom >= stops.at(-1)[0]) return stops.at(-1)[1];
    for (let index = 1; index < stops.length; index++) {
      const [rightZoom, rightWidth] = stops[index];
      const [leftZoom, leftWidth] = stops[index - 1];
      if (zoom <= rightZoom) {
        const ratio = (zoom - leftZoom) / (rightZoom - leftZoom);
        return leftWidth + (rightWidth - leftWidth) * ratio;
      }
    }
    return NaN;
  };
  const source = map.getSource('route-designated')._data;
  return {
    widths: [6, 10, 14].map((zoom) => [zoom, widthAt(zoom)]),
    casing: Number(map.getPaintProperty('route-casing', 'line-width')),
    opacity: Number(map.getPaintProperty('route-designated-band', 'line-opacity')),
    color: map.getPaintProperty('route-designated-band', 'line-color'),
    expectedColor: RoutePalette.designated,
    featureCount: source.features.length,
    beneathCasing: style.indexOf('route-designated-band') < style.indexOf('route-casing'),
  };
});

check('a designated segment creates an active-route bike-route band',
  result.featureCount === 1, JSON.stringify(result));
check('the bike-route band stays beneath the white casing and safety verdict',
  result.beneathCasing, JSON.stringify(result));
check('the band keeps the designated-route color rather than changing safety',
  result.color === result.expectedColor, JSON.stringify(result));
check('the band remains visibly wider than the selected route at every zoom',
  result.widths.every(([, width]) => width >= result.casing + 5),
  JSON.stringify(result));
check('the route designation remains strong enough to read through the map',
  result.opacity >= 0.8, JSON.stringify(result));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
