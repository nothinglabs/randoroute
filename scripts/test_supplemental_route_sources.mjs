#!/usr/bin/env node
// Reviewed agency routes are an explicitly approved supplement to OSM. They
// become ordinary designated-route geometry and routing flags, never safety
// evidence. Exercise the shipped artifacts rather than inspecting builders.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { ROOT, SafetyModel, routerWorker } from './testlib/harness.mjs';

const json = (path) => JSON.parse(path.endsWith('.gz')
  ? gunzipSync(readFileSync(join(ROOT, path)))
  : readFileSync(join(ROOT, path), 'utf8'));

const registry = json('maps/route-sources.json');
const snapshot = json('maps/supplemental-routes.geojson.gz');
const washington = json('maps/washington/bikeroutes.geojson.gz');
const oregon = json('maps/oregon/bikeroutes.geojson.gz');
const waEdges = json('maps/washington/supplemental-route-edges.json.gz');
const orEdges = json('maps/oregon/supplemental-route-edges.json.gz');

assert.equal(registry.format, 1);
for (const [region, record] of Object.entries(registry.regions)) {
  assert.ok(record.sources.length, `${region} must list at least one reviewed source`);
  assert.ok(record.sources.every((source) => source.approved === true),
    `${region} must not silently fetch an unapproved source`);
}

const featuresFor = (region) => snapshot.features
  .filter((feature) => feature.properties.region === region);
assert.equal(featuresFor('washington').length, 4,
  'only the four reviewed Island County touring routes should ship');
assert.equal(featuresFor('oregon').length, 18,
  'only the eighteen reviewed Oregon Scenic Bikeways should ship');
assert.deepEqual(featuresFor('washington').map((feature) => feature.properties.n).sort(),
  ['Camano', 'Central Whidbey', 'North Whidbey', 'South Whidbey']);

const provenanceKeys = new Set([
  'region', 'sourceId', 'sourceLabel', 'authority', 'routeId', 'n', 'sourceUrl',
]);
for (const feature of snapshot.features) {
  assert.ok(feature.geometry.coordinates.length, `${feature.properties.n} needs geometry`);
  assert.deepEqual(Object.keys(feature.properties).sort(), [...provenanceKeys].sort(),
    `${feature.properties.n} may carry provenance and designation only, not safety facts`);
}

const sourceIds = (collection) => new Set(collection.routeSources.map((source) => source.id));
assert.deepEqual(sourceIds(washington), new Set(['osm', 'island-county']));
assert.deepEqual(sourceIds(oregon), new Set(['osm', 'oregon-scenic-bikeways']));
const uniqueNames = (collection) => new Set(collection.routeCatalog.map((route) => route.name));
assert.equal(uniqueNames(washington).size, washington.routeCatalog.length,
  'Washington route catalog must show each reconciled route once');
assert.equal(uniqueNames(oregon).size, oregon.routeCatalog.length,
  'Oregon route catalog must show each reconciled route once');
assert.equal(oregon.routeCatalog.filter((route) => route.sourceIds.length > 1).length, 9,
  'nine Scenic Bikeways should be reconciled with their OSM counterpart');
assert.equal(oregon.routeCatalog.filter((route) =>
  route.sourceIds.length === 1 && route.sourceIds[0] === 'oregon-scenic-bikeways').length, 9,
  'nine Scenic Bikeways missing from OSM should remain official-only routes');

for (const sidecar of [waEdges, orEdges]) {
  assert.equal(sidecar.format, 1);
  assert.ok(sidecar.matchedEdges > 0, `${sidecar.region} must match reviewed geometry to its graph`);
  assert.ok(sidecar.addedEdges.length > 0,
    `${sidecar.region} must add designation beyond what OSM already supplied`);
}

// Verify the Washington sidecar did not merely claim to stamp edges: run the
// actual shipped graph and inspect every edge this import says it added.
const worker = routerWorker({ fresh: true });
assert.ok(worker.ready, 'the shipped Washington graph must load');
worker.context._supplementalAddedEdges = waEdges.addedEdges;
assert.equal(worker.run(`_supplementalAddedEdges.every((edge) =>
  Number.isInteger(edge) && edge >= 0 && edge < E && (eFlags[edge] & 64) === 64)`), true,
  'every recorded Island County edge must carry the ordinary designated-route bit');

// Designation is not part of SafetyModel's facts contract. Extra route-source
// metadata cannot turn an unsafe road into a safe one.
const facts = SafetyModel.sealFacts({ speed: 55, shoulder: 0, lanes: 2 });
const rules = {
  minShoulder: 4, maxSpeedNoShoulder: 35, upperMaxSpeed: 45,
  noUpperLimit: true, allowFreeways: false, allowSidewalkFallback: false,
  inferShoulderFromEdge: false, lanesNoShoulderOver: 4, busyNoShoulder: 2,
};
const baseline = SafetyModel.evaluate(facts, rules);
const designated = SafetyModel.evaluate({ ...facts, designated: true,
  sourceId: 'island-county' }, rules);
assert.deepEqual(designated, baseline,
  'published route designation must not alter the road safety verdict');

console.log(`Supplemental routes verified: ${snapshot.features.length} reviewed routes; `
  + `${waEdges.addedEdges.length + orEdges.addedEdges.length} graph designations beyond OSM.`);
