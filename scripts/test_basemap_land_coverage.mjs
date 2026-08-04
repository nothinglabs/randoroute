#!/usr/bin/env node
// Is there LAND under the rider, everywhere there should be?
//
// test_basemap_land_backdrop.mjs already guards the structural fallback -- hide
// `land_detail` and the coarse `land` layer must still keep the map off the
// ocean. It measures that from screenshots, counting pixels close to #dcecf2.
//
// It cannot catch a hole in the land data, for two reasons.
//
// First, `basemap-water` is painted #dcecf2 and `basemap-ocean` is painted
// #dcecf2 -- the SAME colour, deliberately, so a lake and the backdrop blend.
// A pixel of that colour therefore means either "a lake is here" or "nothing is
// here", and no amount of counting separates them.
//
// Second, it renders Puget Sound, where both land layers have data. A hole
// three hundred kilometres inland was never in shot.
//
// So this asks the map a question pixels cannot answer: at a point that is
// unambiguously dry ground, is there a land POLYGON under it? A city centre is
// the safest possible probe -- if downtown Spokane has no land beneath it, the
// backdrop is missing, whatever colour happens to be on screen.
import { appPage, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);
await page.setViewportSize({ width: 420, height: 800 });

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};

// Dry ground, spread across the state so no single data source can carry the
// whole test. Coordinates are city centres and well-known dry landmarks.
const DRY = [
  { name: 'Seattle downtown', at: [-122.3350, 47.6100] },
  { name: 'Spokane downtown', at: [-117.4260, 47.6580] },
  { name: 'Spokane Riverfront Park', at: [-117.4229, 47.66304] },
  { name: 'Yakima', at: [-120.5059, 46.6021] },
  { name: 'Wenatchee', at: [-120.3103, 47.4235] },
  { name: 'Walla Walla', at: [-118.3430, 46.0646] },
  { name: 'Bellingham', at: [-122.4787, 48.7519] },
  { name: 'Vancouver WA', at: [-122.6615, 45.6387] },
];

// A tight ring around each centre, in PIXELS. The first version offset in
// degrees (±0.004° lon), which at z16 projects ~290 m -- outside a phone
// viewport -- and queryRenderedFeatures legitimately returns nothing for an
// off-canvas point. Two Bellingham probes sat at px 583 and 824 on a 420x800
// screen and reported the city as ocean while it rendered perfectly. Pixel
// offsets stay on-screen at every zoom and latitude by construction.
const OFFSETS = [[0, 0], [120, 0], [-120, 0], [0, 100], [0, -100]];

for (const place of DRY) {
  const probes = await page.evaluate(async ([centre, offsets]) => {
    map.jumpTo({ center: centre, zoom: 16 });
    await new Promise((resolve) => {
      const done = () => { map.off('idle', done); resolve(); };
      map.on('idle', done);
      setTimeout(resolve, 20000);
    });
    const has = (point, layer) => (map.getLayer(layer)
      ? map.queryRenderedFeatures(point, { layers: [layer] }).length : 0);
    const middle = map.project(centre);
    return offsets.map(([dx, dy]) => {
      const point = { x: middle.x + dx, y: middle.y + dy };
      const at = map.unproject([point.x, point.y]);
      return {
        at: [at.lng, at.lat],
        land: has(point, 'basemap-land') + has(point, 'basemap-land-detail'),
        water: has(point, 'basemap-water'),
      };
    });
  }, [place.at, OFFSETS]);

  // A probe is satisfied by land, or by water that explains the absence of it.
  const bare = probes.filter((p) => p.land === 0 && p.water === 0);
  check(`${place.name} has ground under it`, bare.length === 0,
    `${bare.length}/${probes.length} probes bare: `
    + bare.map((p) => p.at.map((v) => v.toFixed(4)).join(',')).join(' '));
}

check('no page errors', page.pageErrors.length === 0, page.pageErrors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
