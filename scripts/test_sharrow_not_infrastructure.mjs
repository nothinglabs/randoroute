#!/usr/bin/env node
// A sharrow is paint in a shared traffic lane. It is not bike infrastructure,
// and must never be drawn in the bike-network lime or counted in a route's
// "trails / lanes" percentage.
//
// It leaked in three independent places, each with its own threshold, which is
// the point of this file: the rule lives in three codebases that cannot import
// each other -- the paint expression (declarative, MapLibre), the route render
// styler (JS, main thread) and the mileage tally (JS, worker) -- so nothing but
// a test can hold them together.
//
//   1. routeVisualStyle() used `facility >= 1`, painting the route line lime
//      over a sharrow.
//   2. facilityM in router-worker.js summed `eFacility >= 1`, inflating the
//      headline percentage.
//   3. bikeNetworkExpr() returned an unconditional true for the OSM source.
//      build_osm.py scores `shared_lane` as 2 -- the same as a painted lane --
//      so the source genuinely contains sharrows and cannot be trusted whole.
//
// The weights are deliberately NOT covered here: facilityShared stays, because
// a sharrow may still be worth a small routing preference. This is about what
// the map claims, not what the router prefers.
import assert from 'node:assert';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../router-worker.js', import.meta.url), 'utf8');

/* --------------------------------- 1. the route line is not painted lime */
const styler = app.slice(app.indexOf('function routeVisualStyle'),
  app.indexOf('function sameRouteCoordinate'));
assert.ok(styler.length > 50, 'routeVisualStyle not found');
assert.doesNotMatch(styler, /p\.facility\s*>=\s*1/,
  'a sharrow (facility 1) must not qualify a route segment as bike infrastructure');
assert.match(styler, /p\.facility\s*>=\s*2/,
  'the route styler should require a painted lane or better');
// A trail is facility 5 and must still be a trail.
assert.match(styler, /p\.facility === 5/, 'trails must keep their own style');

/* ------------------------------- 2. it is not counted in the mileage tally */
assert.doesNotMatch(worker, /eFacility\[ei\]\s*>=\s*1\)\s*facilityM/,
  'facilityM must not count sharrows toward the route bike-facility mileage');
const tallies = [...worker.matchAll(/eFacility\[ei\]\s*>=\s*(\d)\)\s*facilityM/g)];
assert.strictEqual(tallies.length, 2,
  `expected both facilityM tally sites, found ${tallies.length}`);
for (const t of tallies) {
  assert.strictEqual(t[1], '2', 'every facilityM tally must use the same threshold');
}

/* ------------------------------- 3. the OSM source excludes sharrows too */
const expr = app.slice(app.indexOf('const SHARED_LANE_VALUES'),
  app.indexOf('function verdictColorExpr'));
assert.ok(expr.length > 50, 'bikeNetworkExpr region not found');
assert.doesNotMatch(expr, /src\.id === 'osm'\) return \['boolean', true\]/,
  'the OSM source contains sharrows and must not be painted lime wholesale');
assert.match(expr, /shared_lane/,
  'the shared-lane tag value must be filtered out of the bike network');
// Every cycleway key must be checked: a sharrow tagged only on one side still
// is not infrastructure.
for (const key of ['cycleway', 'cycleway:both', 'cycleway:left', 'cycleway:right']) {
  assert.ok(expr.includes(`'${key}'`), `bikeNetworkExpr must inspect ${key}`);
}
// And those tags must actually reach the tiles, or the filter is inert.
const osmBuild = fs.readFileSync(new URL('../scripts/build_osm.py', import.meta.url), 'utf8');
const keep = osmBuild.slice(osmBuild.indexOf('KEEP_TAGS'), osmBuild.indexOf('CANDIDATE_HW'));
for (const key of ['cycleway', 'cycleway:both', 'cycleway:left', 'cycleway:right']) {
  assert.ok(keep.includes(`"${key}"`),
    `build_osm.py must keep ${key} or the sharrow filter can never see it`);
}
// The road tiles carry a numeric level and were already correct; keep them so.
const roadsExpr = app.slice(app.indexOf("if (src.id === 'roads')"),
  app.indexOf("if (src.id === 'blts')"));
assert.match(roadsExpr, /\['>=', \['coalesce', \['get', 'ft'\], 0\], 2\]/,
  'the roads source must keep requiring a painted lane or better');

/* ------------------------ the routing weight is deliberately left alone */
assert.match(worker, /facilityShared: 0\.82/,
  'the sharrow routing preference is intentionally retained; only the paint changed');

/* ----------------- the ladder already agreed, and must keep agreeing ----- */
// FACILITY_RIDING_SPACE is what decides whether a facility substitutes for a
// shoulder. A sharrow must never satisfy it.
const model = fs.readFileSync(new URL('../safety-model.js', import.meta.url), 'utf8');
const ridingSpace = /FACILITY_RIDING_SPACE\s*=\s*(\d)/.exec(model);
assert.ok(ridingSpace, 'FACILITY_RIDING_SPACE not found');
assert.ok(Number(ridingSpace[1]) >= 2,
  'a sharrow must not count as riding space in place of a shoulder');

console.log('ok - sharrows are not painted, counted, or treated as riding space');
