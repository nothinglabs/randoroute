#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { SafetyModel } from './testlib/harness.mjs';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const common = fs.readFileSync(new URL('../route-common.js', import.meta.url), 'utf8');
const details = fs.readFileSync(new URL('../route-details.js', import.meta.url), 'utf8');
const detailsHtml = fs.readFileSync(new URL('../route-details.html', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} source was not found`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`${name} source was incomplete`);
}

const percentageContext = {};
vm.createContext(percentageContext);
vm.runInContext(`const ROUTE_CATEGORY_KEYS = ['trail', 'bike', 'pass', 'caution', 'fail'];\n${functionSource(common, 'routeCategoryPercentages')}`, percentageContext);

for (const distances of [
  { trail: 370, bike: 490, pass: 130, caution: 10, fail: 0 },
  { trail: 1, bike: 1, pass: 1, caution: 1, fail: 1 },
  { trail: 5000, bike: 2400, pass: 2500, caution: 99, fail: 1 },
  { trail: 0, bike: 0, pass: 1, caution: 0, fail: 0 },
]) {
  const values = percentageContext.routeCategoryPercentages(distances);
  assert.equal(Object.values(values).reduce((sum, value) => sum + value, 0), 100,
    'the five displayed map categories must total exactly 100%');
  for (const key of ['trail', 'bike', 'pass', 'caution', 'fail']) {
    if (distances[key] > 0) assert.ok(values[key] >= 1, `${key} must stay visible when it has distance`);
    else assert.equal(values[key], 0, `${key} must remain zero when it has no distance`);
  }
}

// route-details.html loads safety-model.js before route-details.js, so these
// functions run with a real SafetyModel on the window. Give the sandbox the
// real one rather than a stand-in: the stress threshold they read is then the
// shipped constant, and moving it moves this test with it.
// The flag and official-bit vocabulary route-details.js reads, mirrored from
// its own declarations at the top of that file.
const categoryContext = {
  FLAG_FACILITY: 2, FLAG_FREEWAY: 4, FLAG_INFRA: 8, FLAG_FERRY: 32,
  FLAG_DESIGNATED: 64, FLAG_LIMITED_ACCESS: 128,
  OFFICIAL_MTB: 4, OFFICIAL_DISMOUNT: 8, OFFICIAL_SIDEWALK: 16,
  OFFICIAL_SIDEWALK_NO: 32, OFFICIAL_URBAN: 64,
  ROUTE_CATEGORY_KEYS: ['trail', 'bike', 'pass', 'caution', 'fail'],
  window: { SafetyModel },
};
vm.createContext(categoryContext);
vm.runInContext([
  functionSource(details, 'isBikeNetwork'),
  functionSource(details, 'isOffStreetTrail'),
  functionSource(details, 'isMountainBikeTrail'),
  functionSource(common, 'isDismountSegment'),
  functionSource(details, 'activeDetailRules'),
  functionSource(details, 'routeSegmentFacts'),
  functionSource(details, 'routeSegmentLevel'),
  functionSource(details, 'routeDisplayCategory'),
].join('\n'), categoryContext);

assert.equal(categoryContext.routeDisplayCategory({ lenM: 1, facility: 1, level: 1 }), 'pass',
  'a sharrow must remain an ordinary passing road');
assert.equal(categoryContext.routeDisplayCategory({ lenM: 1, facility: 2, level: 1 }), 'bike');
// A painted lane on a road the state rates worst-on-scale passes the rules --
// the caution rung is for roads whose space is not the rider's -- but it is not
// a lane we advertise, so it counts with the ordinary passing roads. Separation
// is exempt: that credit no rating can take away.
assert.equal(categoryContext.routeDisplayCategory({ lenM: 1, facility: 2, level: 2, lts: 4 }),
  'pass', 'a bike lane on a high-stress road passes, and is not bike network');
assert.equal(categoryContext.routeDisplayCategory({ lenM: 1, facility: 4, level: 2, lts: 4 }),
  'bike', 'a SEPARATED lane keeps its credit whatever the rating says');
assert.equal(categoryContext.routeDisplayCategory({ lenM: 1, facility: 5, level: 1 }), 'trail');
assert.equal(categoryContext.routeDisplayCategory({ lenM: 1, facility: 5, level: 3 }), 'caution',
  'a caution verdict must override facility styling');
assert.equal(categoryContext.routeDisplayCategory({ lenM: 1, facility: 5, level: 4 }), 'fail',
  'a failing verdict must override facility styling');
assert.equal(categoryContext.routeDisplayCategory({ lenM: 1, facility: 5, level: 1,
  displayCategory: 'caution' }), 'caution', 'Route Details must honor the exact stored map category');
assert.equal(categoryContext.routeDisplayCategory({ lenM: 1, flags: 32, level: 1 }), null,
  'ferry distance is outside the five riding categories');

// The five labels both category lists use. Whether they FIT is a rendered
// question and is measured in test_route_card_labels.mjs -- searching the
// source for the string only proves someone typed it, which is what let
// "Trusted Bike Lanes" ship truncated to "Trusted Bike La...".
const labels = ['Trails', 'Trusted Bike Lane', 'Passes Rules', 'Needs Caution', 'Fails Rules'];
const appCard = functionSource(app, 'renderRouteCard');
// Both category lists render from the shared ROUTE_CATEGORY_LABELS table in
// route-common.js -- assert the table carries the five labels and that both
// renderers actually read it rather than restating the strings.
const labelContext = {};
vm.createContext(labelContext);
vm.runInContext(common.replace(/\bconst /g, 'var '), labelContext);
assert.deepEqual([...labelContext.ROUTE_CATEGORY_LABELS].map(([, label]) => String(label)),
  labels, 'ROUTE_CATEGORY_LABELS must carry the five category labels in order');
assert.ok(appCard.includes('ROUTE_CATEGORY_LABELS'),
  'the route card must render the shared label table');
assert.match(styles,
  /\.rc-category-swatch\.fail::after\s*\{[\s\S]*repeating-linear-gradient\(90deg,[\s\S]*var\(--verdict-fail\)/,
  'the route-card fail key must echo the route with a static horizontal dash pattern');
assert.doesNotMatch(styles,
  /\.rc-category-swatch\.fail(?:\s*\{|::after\s*\{)[^}]*animation\s*:/,
  'the compact route-card fail key must not animate');
assert.ok(details.includes('ROUTE_CATEGORY_LABELS'),
  'Route Details must render the shared label table');
assert.ok(details.includes('<b>5%+ uphill</b><strong>${fmtMi(routeStats.inclineOver5M)} mi</strong>'),
  'Route Details Elevation must report 5%+ uphill distance in miles');
assert.ok(!details.includes('Incline over 5%'),
  'Route Details must not leave the 5% grade metric in its top summary');
assert.ok(app.includes("['bikeFacilities', 'Trusted bike lanes', 'facility']"),
  'Map Layers must label the lime bucket as trusted bike lanes');
assert.ok(details.includes('At least <strong>55 mph</strong>'),
  'Route Details is missing the bold 55+ mph road metric');
assert.ok(!details.includes('Avg. limit') && !details.includes('Max limit'),
  'Route Details must omit average and maximum speed-limit rows');
assert.ok(details.includes('<b>Ferry</b>') && details.includes('<b>Dismount</b>'),
  'Route Details summary must include ferry and dismount metrics when present');
assert.ok(!details.includes('a confirmed ≥'),
  'the speed/shoulder statistic must not label the shoulder as confirmed');
assert.ok(detailsHtml.includes('total 100% of non-ferry riding distance'),
  'Route Details must explain the mutually exclusive total');
assert.ok(!appCard.includes('⛴') && !appCard.includes('Dismount'),
  'the compact route card must not add ferry or dismount rows');
const ferryMarkerContext = {};
vm.createContext(ferryMarkerContext);
vm.runInContext(functionSource(app, 'buildRouteFerryMarkerData'), ferryMarkerContext);
const ferryMarkers = ferryMarkerContext.buildRouteFerryMarkerData([
  [[-122.5, 47.5], [-122.4, 47.6], [-122.3, 47.7]],
]);
assert.deepEqual(JSON.parse(JSON.stringify(ferryMarkers.features[0].geometry.coordinates)),
  [-122.4, 47.6], 'the ferry marker must sit over the ferry leg');
assert.ok(app.includes("id: 'route-ferry-marker'")
  && app.includes("'icon-image': 'route-ferry-marker-icon'"),
  'the selected route must render the offline ferry icon');
const ferryImageContext = {};
vm.createContext(ferryImageContext);
vm.runInContext(functionSource(app, 'ensureFerryMarkerImage'), ferryImageContext);
let ferryImage;
ferryImageContext.ensureFerryMarkerImage({
  hasImage: () => false,
  addImage: (id, image, options) => { ferryImage = { id, image, options }; },
});
assert.equal(ferryImage.id, 'route-ferry-marker-icon');
assert.deepEqual(JSON.parse(JSON.stringify({ width: ferryImage.image.width,
  height: ferryImage.image.height, pixelRatio: ferryImage.options.pixelRatio })),
{ width: 80, height: 52, pixelRatio: 2 },
'the ferry marker must use the wide Retina-sized boat silhouette');
assert.equal(ferryImage.image.data[3], 0,
  'the ferry marker corner must remain transparent instead of becoming a badge');
assert.ok(!app.includes("id: 'route-ferry-marker-halo'"),
  'the ferry badge must not sit inside the ghost-like circular halo');
assert.match(styles, /route-details-dialog-head[^}]+safe-area-inset-top/,
  'the embedded Details header must reserve the iOS top safe area');
assert.match(styles, /\.route-details-dialog\s*\{\s*position:\s*fixed;\s*inset:\s*0;/,
  'the phone-sized Details dialog must be pinned to the visible viewport');

console.log('Route category summary tests passed.');
