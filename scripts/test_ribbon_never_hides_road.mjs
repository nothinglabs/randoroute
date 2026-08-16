#!/usr/bin/env node
// An informational ribbon must never be what a tap returns when there is a
// scored road under it.
//
// The designated-route ribbon draws above roads on purpose, so tapping the
// Olympic Discovery Trail returned the ribbon's own card: a name, a network,
// and a note reading "the scored road or facility supplies the safety verdict"
// -- while showing nothing at all about that road. The ODT is the worst
// possible place for that to happen. It runs 58.8 miles along ordinary road,
// including US 101 at 60 mph with no shoulder, and it is the reason designated
// routes are no longer allowed to excuse anything. A rider tapping it was shown
// the designation and denied the verdict.
//
// The same defect was fixed once already for the county ribbon, by making that
// layer non-hit-testable. This is the general rule instead.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { appPage, launchBrowser, serveRepo } from './testlib/harness.mjs';

const appSrc = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

function lift(name) {
  const re = new RegExp(`\\nfunction ${name}\\s*\\([^)]*\\)\\s*\\{`);
  const at = appSrc.search(re);
  assert.notEqual(at, -1, `app.js should define ${name}`);
  let depth = 0;
  for (let j = appSrc.indexOf('{', at); j < appSrc.length; j++) {
    if (appSrc[j] === '{') depth++;
    else if (appSrc[j] === '}' && --depth === 0) return appSrc.slice(at + 1, j + 1);
  }
  throw new Error(`unterminated ${name}`);
}

/* --------------------------------------- the ribbon is declared as such */
const routes = appSrc.match(/id: 'routes',[\s\S]*?\n  \},/)[0];
assert.match(routes, /ribbon: true/,
  "the designated-route overlay must be flagged as a ribbon, or featureAt "
  + 'cannot know to yield to the road beneath it');

/* ------------------------------------------------- featureAt, in isolation */
// Ordered as MapLibre returns them: topmost first.
let rendered = [];
const ctx = {
  HIT_LAYERS: ['routes__hit', 'roads__hit', 'osm__hit'],
  HIT_SRC: {
    routes__hit: { id: 'routes', ribbon: true },
    // The scorer mirrors the real one's shape: featureAt asks it whether a
    // hit is bikes-banned before letting it win an ambiguous tap.
    roads__hit: { id: 'roads', scorer: (p) => ({ prohibited: p.b === 1 }) },
    osm__hit: { id: 'osm' },
  },
  map: {
    getLayer: (id) => (id === 'route-dismount-halo' && !ctx.haloPresent ? null : { id }),
    getLayoutProperty: () => 'visible',
    queryRenderedFeatures: () => rendered,
  },
  // featureAt widens its reach over a dismount marker; there is none here, so
  // the real function answers false and the ordinary tolerance applies.
  DISMOUNT_MARKER_HIT_PX: 18,
  haloPresent: false,
  HIT_VERTEX_LIMIT: 400,
  HIT_TIE_PX: 0.5,
  // This isolated suite exercises the broad hit-layer fallback. Visible-first
  // selection has its own live-map coverage in test_map_road_declutter.
  visibleFeatureAt: () => null,
  Math,
};
// map.project turns a [lng, lat] into a screen point. The fixtures below are
// authored directly in screen space, so the identity is the honest stub.
ctx.map.project = ([x, y]) => ({ x, y });
vm.createContext(ctx);
vm.runInContext([
  lift('dismountMarkerAt'), lift('featureAt'), lift('pointToSegmentPx'),
  lift('screenDistanceToFeature'), lift('nearestOfHits'),
  lift('reconcileCoincident'), lift('hitProhibited'), lift('dodgeBannedHit'),
].join('\n'), ctx);

const at = (...ids) => {
  rendered = ids.map((id) => ({ layer: { id } }));
  const hit = ctx.featureAt({ x: 100, y: 100 });
  return hit && hit.layer.id;
};

assert.equal(at('routes__hit', 'roads__hit'), 'roads__hit',
  'the road under a designated route must answer the tap, not the ribbon');
assert.equal(at('routes__hit', 'osm__hit'), 'osm__hit',
  'the same holds for a trail under the ribbon');
assert.equal(at('routes__hit'), 'routes__hit',
  'with nothing scored beneath it, the ribbon still answers');
assert.equal(at('roads__hit', 'routes__hit'), 'roads__hit',
  'draw order does not matter; a scored feature always wins');
assert.equal(at('roads__hit', 'osm__hit'), 'roads__hit',
  'between two scored features the topmost still wins');
assert.equal(at(), null, 'nothing under the tap, nothing returned');
console.log('PASS  a scored road always outranks an informational ribbon (6 cases)');

/* --------------------------------- the tap answers for the NEAREST feature */
// Two records of one highway meeting end to end. queryRenderedFeatures hands
// them back in draw order, and taking the topmost is a coin flip at the seam:
// OR 224 at Three Lynx books 3 ft on one segment and 4 ft on the next, so two
// taps a moment apart returned "Fails your rules" and "Passes your rules" on
// the same road with nothing in either card to explain the difference.
const line = (id, coords, props) => ({
  layer: { id }, geometry: { type: 'LineString', coordinates: coords },
  properties: props || {},
});
const pick = (feats, x, y) => { rendered = feats; return ctx.featureAt({ x, y }); };
const HERE = [[100, 90], [100, 140]];   // under the tap at (100, 100)
const FAR = [[0, 0], [0, 40]];          // ~100 px away

assert.equal(
  pick([line('roads__hit', FAR), line('roads__hit', HERE)], 100, 100)
    .geometry.coordinates[0][0],
  100, 'the nearer of two scored features answers, whatever the draw order');
assert.equal(
  pick([line('roads__hit', HERE), line('roads__hit', FAR)], 100, 100)
    .geometry.coordinates[0][0],
  100, 'and the same answer when the draw order is reversed');
console.log('PASS  the tap resolves to the nearest feature, not the topmost');

/* ------------- an ambiguous tap never means the bikes-banned road */
// Beside the Interurban Trail the nearest record is I-5's; a tap that could
// mean a rideable way or a banned one beside it means the rideable way, the
// same doctrine as the router's node snapping.
const NEXT = [[104, 90], [104, 140]];   // 4 px beside the tap
assert.equal(
  pick([line('roads__hit', HERE, { b: 1 }), line('roads__hit', NEXT)], 100, 100)
    .geometry.coordinates[0][0],
  104, 'a rideable way in reach wins over a nearer bikes-banned one');
assert.equal(
  pick([line('roads__hit', HERE, { b: 1 })], 100, 100).properties.b,
  1, 'a banned road alone under the tap still answers for itself');
console.log('PASS  an ambiguous tap resolves to the rideable way (2 cases)');

/* ------------------ coincident records: measured beats blank, lowest wins */
const both = (props) => line('blts__hit', HERE, props);
assert.equal(pick([
  both({ RouteIdentifier: '224d', ShoulderWidth: null }),
  both({ RouteIdentifier: '224d', ShoulderWidth: 4 }),
], 100, 100).properties.ShoulderWidth, 4,
  'a measured shoulder beats an unpopulated row: absence is not a measurement '
  + 'of zero, whatever the model scores an unknown shoulder as');
assert.equal(pick([
  both({ RouteIdentifier: '224d', ShoulderWidth: 4 }),
  both({ RouteIdentifier: '224d', ShoulderWidth: 1 }),
], 100, 100).properties.ShoulderWidth, 1,
  'among measured values the narrowest wins; this is a safety verdict');
assert.equal(pick([
  both({ RouteIdentifier: '224d', ShoulderWidth: 3 }),
  both({ RouteIdentifier: '224i', ShoulderWidth: 1 }),
], 100, 100).properties.RouteIdentifier, '224d',
  'the two DIRECTIONS of one road are not duplicates: wsdotShoulderText '
  + 'reports both sides, so they must not be silently merged here');
console.log('PASS  coincident records reconcile conservatively (3 cases)');

/* ------------------------- but a dismount marker still owns its own taps */
// featureAt widens its pad inside a marker's halo precisely to REACH PAST the
// nearest thing: a tap on the triangle's corner is genuinely closer to the road
// running under the marker than to the route line the marker belongs to. So
// nearest-wins is the wrong rule there, and draw order is the right one -- the
// marker's layer is on top because the marker is what was tapped. Measuring
// distance here handed a rider the road instead of the dismount warning
// (test_dismount_marker.mjs caught it on real pixels; this pins the rule).
ctx.haloPresent = true;
assert.equal(
  pick([line('route-seg-hit', FAR), line('roads__hit', HERE)], 100, 100).layer.id,
  'route-seg-hit',
  'on a dismount marker the marker\'s own feature answers, however far its '
  + 'line is from the finger');
ctx.haloPresent = false;
assert.equal(
  pick([line('route-seg-hit', FAR), line('roads__hit', HERE)], 100, 100).layer.id,
  'roads__hit', 'and off a marker the ordinary nearest-wins rule is back');
console.log('PASS  a dismount marker keeps the taps its widened pad captures');

/* ------------- and the road card still names the route it carries, live */
// Yielding the tap must not lose the designation: the road card appends it,
// from the ribbon when that layer is on and from the road's own flag when it
// is not.
//
// This was two assert.match() calls against app.js's own source, which is
// exactly what AGENTS.md forbids -- a regex over source pins how code READS
// and passes through whatever it DOES. One of them matched a whole statement
// including a variable name, so a rename would have failed the suite while
// deleting the rows outright would have sailed through it. Now it opens the
// card and reads the row.
const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);
await page.waitForFunction(
  () => typeof inspectRoadAt === 'function' && typeof HIT_SRC !== 'undefined'
    && typeof SOURCES !== 'undefined' && typeof routeBadgeAt === 'function',
  { timeout: 90000 });

// The designation is lifted above the fold into its own named "Bike route"
// fact. A generic facility record must not occupy that slot and bury the name.
const cardText = (badge, designatedFlag, genericFacility = false) => page.evaluate(
  ({ badge, designatedFlag, genericFacility }) => {
    roadInfoSuppressedUntil = 0;
    dismissRoadInfo();
    const wasFeature = featureAt, wasBadge = routeBadgeAt;
    HIT_SRC['test-designation-hit'] = SOURCES.find((s) => s.id === 'roads');
    featureAt = () => ({
      layer: { id: 'test-designation-hit' },
      properties: Object.assign(
        { n: 'Test Avenue', s: 30, w: 6, h: 'residential', u: 1 },
        designatedFlag ? { g: 1 } : {},
        genericFacility ? { f: 1 } : {}),
      geometry: { type: 'LineString',
        coordinates: [[-122.34, 47.61], [-122.335, 47.615]] },
    });
    routeBadgeAt = () => badge;
    const point = { x: 220, y: 400 };
    inspectRoadAt(point, map.unproject([point.x, point.y]));
    featureAt = wasFeature;
    routeBadgeAt = wasBadge;
    return document.getElementById('readout').textContent || '';
  }, { badge, designatedFlag, genericFacility });

// A road genuinely under a ribbon always carries its own flag -- roads tiles
// take `g` from the same collect_designated() relation membership that builds
// the ribbon overlay -- so a badge with NO flag means the ribbon is merely
// NEARBY: beside the Interurban Trail the nearest record is I-5's, and naming
// the trail on the banned freeway's card is how it read as the trail failing
// (field report). The name lands only where the road claims membership.
const withBadge = await cardText('US Bicycle Route 10', true, true);
assert.ok(withBadge.includes('US Bicycle Route 10'),
  'the road card must name the designated route running over it');
assert.ok(/bike route/i.test(withBadge),
  'and label it as a bike route, so the designation is not a bare string');
assert.ok(/bike accommodation/i.test(withBadge),
  'a generic accommodation fact must remain separate from the named route');

const badgeWithoutFlag = await cardText('US Bicycle Route 10', false, true);
assert.ok(!badgeWithoutFlag.includes('US Bicycle Route 10'),
  'a nearby ribbon must not pin its name on a road that is not on the route');

const withFlagOnly = await cardText(null, true);
assert.ok(/designated route/i.test(withFlagOnly),
  `the card must fall back to the road's own flag when the ribbon layer is `
  + `hidden, got ${JSON.stringify(withFlagOnly.slice(-200))}`);

const withNeither = await cardText(null, false);
assert.ok(!/designated route|bike route|bike accommodation/i.test(withNeither),
  'and claims no designation when the road carries none');

// Reproduce the field report exactly: an agency BLTS record says only
// BikeFacilityType=yes while the coincident relation supplies the useful name.
// The vague value and the real designation must not compete for one slot.
const agencyCard = await page.evaluate(() => {
  roadInfoSuppressedUntil = 0;
  dismissRoadInfo();
  const wasFeature = featureAt, wasBadge = routeBadgeAt;
  HIT_SRC['test-agency-designation-hit'] = SOURCES.find((s) => s.id === 'blts');
  featureAt = () => ({
    layer: { id: 'test-agency-designation-hit' },
    properties: {
      RouteIdentifier: '534i', LTS_Bicycle: 4, SpeedLimit: 50,
      LaneCount: 1, AADT: 655, ShoulderWidth: 2,
      BikeFacilityType: 'yes', Designated: 1,
    },
    geometry: { type: 'LineString',
      coordinates: [[-122.45, 48.25], [-122.445, 48.255]] },
  });
  routeBadgeAt = () => 'US Bicycle Route 95';
  const point = { x: 220, y: 400 };
  inspectRoadAt(point, map.unproject([point.x, point.y]));
  featureAt = wasFeature;
  routeBadgeAt = wasBadge;
  return document.getElementById('readout').textContent || '';
});
assert.match(agencyCard, /Bike route\s*US Bicycle Route 95/i,
  'the BLTS card must promote the coincident named bike route above Details');
assert.match(agencyCard, /Bike accommodation\s*yes/i,
  'the agency accommodation value may remain as a separate fact');
console.log('PASS  the road card still reports the route running over it (4 cases)');

await browser.close();
await site.close();

console.log('\n17 checks, 0 failed');
