#!/usr/bin/env node
// Which state this build covers is configuration, not code.
//
// The safety model has always been state-agnostic on purpose -- it knows about
// a traffic-stress RATING and never about the agency that published it. But the
// rest of Washington was spread through app.js in a dozen literals: a bounding
// box, an opening view, "WSDOT" on eight card rows, the agency's own spelling
// of its route ids and facility types. `docs/PORTING-TO-ANOTHER-STATE.md`
// claimed changing the agency was "one place in app.js". It was nine.
//
// So `region.js` owns all of it, and this file proves the claim the way a port
// would find out it was false: serve a DIFFERENT region and check the app
// follows it. Grepping the source for "WSDOT" would pass on a build where the
// value was read once and then ignored.
import { playwright, chromiumPath, serveRepo } from './testlib/harness.mjs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ROOT } from './testlib/harness.mjs';

const require_ = createRequire(import.meta.url);
const { Region } = require_(join(ROOT, 'region.js'));

let pass = 0;
const check = (name, ok, detail = '') => {
  if (!ok) { console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`); process.exitCode = 1; }
  else { pass++; console.log(`PASS  ${name}${detail ? `  -- ${detail}` : ''}`); }
};

/* --------------------------------------------- the shipped region is sane */
check('the shipped region is Washington', Region.name === 'Washington');
check('its bounds contain Seattle', Region.contains(-122.3321, 47.6062));
// A rectangle covering south-west Washington unavoidably reaches over the
// Columbia into Portland, because the border is a river and this is a box. That
// is a known approximation, not a bug: a handful of unroutable Oregon results
// beats clipping Vancouver and Longview. What must hold is that somewhere
// plainly outside is excluded.
check('and exclude Eugene', !Region.contains(-123.09, 44.05));
check('and exclude Boise', !Region.contains(-116.2, 43.6));
check('and exclude Vancouver BC', !Region.contains(-123.12, 49.28));
check('a WSDOT increasing-milepost id reads as one',
  Region.routeDirection('005i') === 'increasing mileposts');
check('and its base id drops the direction', Region.routeBase('005i') === '005');
check('an id with no direction suffix keeps its whole base',
  Region.routeBase('161') === '161' && Region.routeDirection('161') === null);
check('a shared-use path outranks a painted lane',
  Region.facilityLevels['Shared-Use Path'] > Region.facilityLevels['Bike Lane']);

/* ------------------------------------------------------ now port it live */
// Oregon, as a port would first write it: same shape, every value different.
const OREGON = `
(function (root) {
  root.Region = {
    name: 'Oregon',
    bounds: { minLon: -124.6, maxLon: -116.4, minLat: 41.9, maxLat: 46.3 },
    defaultCenter: [-122.676, 45.523],
    defaultZoom: 11,
    stressAgency: 'ODOT',
    restrictionAgency: 'ODOT',
    speedAgency: 'ODOT',
    facilitySourceName: 'ODOT Bicycle Facility Inventory',
    stressLayerName: 'ODOT stress (state highways)',
    restrictionLayerName: 'Bikes prohibited (ODOT)',
    interstateRoutePrefixes: ['005', '084', '205', '405'],
    facilityLevels: { 'Path': 5, 'Bike Lane': 2 },
    routeBase: (id) => String(id || ''),
    routeDirection: () => null,
  };
  root.Region.contains = (lon, lat) => {
    const b = root.Region.bounds;
    return lon >= b.minLon && lon <= b.maxLon && lat >= b.minLat && lat <= b.maxLat;
  };
}(typeof self !== 'undefined' ? self : this));
`;

const { chromium } = await playwright();
const site = await serveRepo();
site.publish('/region.js', OREGON);
const browser = await chromium.launch({
  executablePath: chromiumPath(), args: ['--use-gl=swiftshader'],
});
const context = await browser.newContext({
  viewport: { width: 1100, height: 850 }, serviceWorkers: 'block',
});
const page = await context.newPage();
page.setDefaultTimeout(180000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(site.url, { waitUntil: 'load' });
await page.waitForFunction(() => window.map && map.loaded && map.loaded(), { timeout: 180000 })
  .catch(() => {});

const observed = await page.evaluate(() => ({
  centre: map.getCenter(),
  stressAgency: STRESS_AGENCY,
  stressLayer: SOURCES.find((s) => s.id === 'blts')?.name,
  restrictionLayer: SOURCES.find((s) => s.id === 'restrict')?.name,
  // The coverage filter a place search runs every result through.
  acceptsPortland: Region.contains(-122.676, 45.523),
  acceptsSeattle: Region.contains(-122.3321, 47.6062),
  // The agency vocabularies.
  interstate: isInterstateRoute('084A'),
  notInterstate: isInterstateRoute('090A'),
  pathLevel: agencyFacilityLevel('Path'),
  unknownFacility: agencyFacilityLevel('Shared-Use Path'),
}));

check('the map opens on the ported region', Math.abs(observed.centre.lng - -122.676) < 0.01,
  `opened at ${observed.centre.lng.toFixed(3)}, ${observed.centre.lat.toFixed(3)}`);
check('the stress agency follows the region', observed.stressAgency === 'ODOT', observed.stressAgency);
check('the layer list names the ported agency',
  observed.stressLayer === 'ODOT stress (state highways)'
  && observed.restrictionLayer === 'Bikes prohibited (ODOT)',
  `${observed.stressLayer} / ${observed.restrictionLayer}`);
check('coverage moves with the region',
  observed.acceptsPortland && !observed.acceptsSeattle,
  `Portland ${observed.acceptsPortland}, Seattle ${observed.acceptsSeattle}`);
check('the interstate list is the ported one',
  observed.interstate && !observed.notInterstate,
  `I-84 ${observed.interstate}, WA I-90 ${observed.notInterstate}`);
check('the facility vocabulary is the ported one',
  observed.pathLevel === 5 && observed.unknownFacility === 0,
  `Path ${observed.pathLevel}, WSDOT's "Shared-Use Path" ${observed.unknownFacility}`);
check('porting the region raises no errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
site.close();
console.log(`\n${pass} checks passed`);
