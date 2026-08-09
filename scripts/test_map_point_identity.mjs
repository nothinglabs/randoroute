#!/usr/bin/env node
// The unified card leads with where the rider is, not just what they tapped.
// Identity comes from the same baked place index the search box uses, so it
// works offline and costs no request. The road/trail name is the heading (and
// must not be repeated below it); locality and region provide useful context.
import { appPage, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);
await page.waitForFunction(() => typeof regionNameFor === 'function'
  && typeof renderReadout === 'function', { timeout: 60000 });
await page.evaluate(() => ensurePlaces());
await page.waitForFunction(() => !!placesIndex, { timeout: 30000 });

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

const regions = await page.evaluate(() => ({
  tukwila: regionNameFor(-122.2588, 47.4633),
  seattle: regionNameFor(-122.3321, 47.6062),
  everett: regionNameFor(-122.2021, 47.9790),
  spokane: regionNameFor(-117.4260, 47.6588),
  // Middle of the Pacific: nothing within reach, so nothing is claimed.
  ocean: regionNameFor(-127.5, 47.0),
}));
check('a tap in Tukwila is placed in Tukwila', regions.tukwila === 'Tukwila',
  JSON.stringify(regions));
// The nearest place to downtown Seattle by raw distance is a neighbourhood or
// a hamlet; a rider says "Seattle". Population has to discount distance.
check('a tap downtown says the city, not the nearest tiny place',
  regions.seattle === 'Seattle', JSON.stringify(regions));
check('and the same holds across the state', regions.everett === 'Everett'
  && regions.spokane === 'Spokane', JSON.stringify(regions));
check('far from anywhere it claims nothing rather than guessing',
  regions.ocean === null, JSON.stringify(regions));

const tripPointNames = await page.evaluate(() => {
  const saved = placesIndex;
  placesIndex = [
    ['Mountlake Terrace', -122.3000, 47.7900, 'town', 22000],
    ['Seattle Heights', -122.3010, 47.7910, 'neighbourhood', 0],
    ['Marysville', -122.1771, 48.0518, 'city', 70000],
  ];
  const named = mapPointLocationName({ lng: -122.3005, lat: 47.7905 });
  const cityOnly = mapPointLocationName({ lng: -122.1771, lat: 48.0518 });
  placesIndex = saved;
  return { named, cityOnly };
});
check('trip points use municipality plus neighborhood when both are known',
  tripPointNames.named === 'Mountlake Terrace — Seattle Heights', JSON.stringify(tripPointNames));
check('a municipality-only tap remains explicit that it is a point on the map',
  tripPointNames.cityOnly === 'Marysville — Point on map', JSON.stringify(tripPointNames));

/* ------------------------------------------- the lines as the rider sees them */
const card = await page.evaluate(() => {
  renderReadout(null, { lng: -122.2588, lat: 47.4633 }, { x: 200, y: 400 });
  const lines = [...document.querySelectorAll('#readout .readout-identity-line')]
    .filter((line) => !line.hidden && line.textContent.trim());
  return {
    heading: document.querySelector('#readout .rt-title')?.textContent,
    lines: lines.map((line) => line.textContent),
    classes: lines.map((line) => line.className.replace('readout-identity-line ', '')),
  };
});
check('a bare point still says which town it is in',
  card.lines.includes('Tukwila'), JSON.stringify(card));

const segmentCard = await page.evaluate(() => {
  const source = SOURCES.find((item) => item.id === 'roads');
  HIT_SRC['test-identity-hit'] = source;
  renderReadout({
    layer: { id: 'test-identity-hit' },
    properties: { n: 'Interurban Avenue South', s: 35, w: 4, h: 'secondary', u: 1 },
    geometry: { type: 'LineString', coordinates: [[-122.26, 47.46], [-122.25, 47.47]] },
  }, { lng: -122.2588, lat: 47.4633 }, { x: 200, y: 400 });
  const lines = [...document.querySelectorAll('#readout .readout-identity-line')]
    .filter((line) => !line.hidden && line.textContent.trim());
  return {
    heading: document.querySelector('#readout .rt-title')?.textContent,
    lines: lines.map((line) => line.textContent),
    order: lines.map((line) => line.className.replace('readout-identity-line ', '')),
  };
});
check('a segment leads with its own name once, then gives the region as context',
  segmentCard.heading === 'Interurban Avenue South'
    && !segmentCard.lines.includes('Interurban Avenue South')
    && segmentCard.lines.includes('Tukwila'), JSON.stringify(segmentCard));
check('the final context line is the region',
  segmentCard.order[segmentCard.order.length - 1] === 'readout-identity-region',
  JSON.stringify(segmentCard));
// A card that printed the road name twice would read as two different facts.
check('and never repeats one name as two lines',
  new Set(segmentCard.lines).size === segmentCard.lines.length, JSON.stringify(segmentCard));

check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
