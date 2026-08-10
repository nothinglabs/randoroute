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
    roads__hit: { id: 'roads' },
    osm__hit: { id: 'osm' },
  },
  map: {
    getLayer: (id) => (id === 'route-dismount-halo' ? null : { id }),
    getLayoutProperty: () => 'visible',
    queryRenderedFeatures: () => rendered,
  },
  // featureAt widens its reach over a dismount marker; there is none here, so
  // the real function answers false and the ordinary tolerance applies.
  DISMOUNT_MARKER_HIT_PX: 18,
  HIT_VERTEX_LIMIT: 400,
  HIT_TIE_PX: 0.5,
  Math,
};
// map.project turns a [lng, lat] into a screen point. The fixtures below are
// authored directly in screen space, so the identity is the honest stub.
ctx.map.project = ([x, y]) => ({ x, y });
vm.createContext(ctx);
vm.runInContext([
  lift('dismountMarkerAt'), lift('featureAt'), lift('pointToSegmentPx'),
  lift('screenDistanceToFeature'), lift('nearestOfHits'),
  lift('reconcileCoincident'),
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

/* --------------------- and the road card still names the route it carries */
// Yielding the tap must not lose the designation: the road card appends it.
assert.match(appSrc, /const badge = routeBadgeAt\(map\.project\(lngLat\)\);\s*if \(badge\) rows\.push\(\['Bike route', badge\]\);/,
  'the road card must name the designated route running over it');
assert.match(appSrc, /else if \(p\.g\) rows\.push\(\['Bike route',/,
  'and must fall back to the road\'s own flag when the ribbon layer is hidden');
console.log('PASS  the road card still reports the route running over it');

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

console.log('\n13 checks, 0 failed');
