#!/usr/bin/env node
// Mark graph edges that follow the reviewed supplemental route geometry.
//
// The graph's bit 64 is designation, not safety. OSM sets it while building
// the graph; this post-build step adds the same bit for reviewed agency routes
// using the worker's own overlap+bearing matcher. A sidecar remembers only the
// bits this step added so a refresh can remove stale matches without touching
// the OSM designations already present in the graph.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import zlib from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const region = process.argv[2];
if (!region || !/^[a-z0-9-]+$/.test(region)) {
  throw new Error('usage: node scripts/stamp_supplemental_route_edges.mjs <region>');
}
const stateDir = join(ROOT, 'maps', region);
const graphPath = join(stateDir, 'graph2.bin.gz');
const sidecarPath = join(stateDir, 'supplemental-route-edges.json.gz');
const snapshotPath = join(ROOT, 'maps', 'supplemental-routes.geojson.gz');
const regionPath = join(stateDir, 'region.json');

const snapshot = JSON.parse(zlib.gunzipSync(readFileSync(snapshotPath)));
const routes = (snapshot.features || []).filter((feature) => feature.properties?.region === region);
if (!routes.length) throw new Error(`${region} has no approved supplemental route geometry`);
const lines = routes.flatMap((feature) => {
  const geometry = feature.geometry || {};
  return geometry.type === 'LineString' ? [geometry.coordinates]
    : geometry.type === 'MultiLineString' ? geometry.coordinates : [];
});

const compressed = readFileSync(graphPath);
const inputGraphHash = createHash('sha256').update(compressed).digest('hex').slice(0, 12);
const inflated = zlib.gunzipSync(compressed);
const graphBuffer = inflated.buffer.slice(inflated.byteOffset, inflated.byteOffset + inflated.byteLength);
const messages = [];
const context = vm.createContext({
  Date, Math, Map, Set, WeakMap, WeakSet, JSON, TextDecoder, TextEncoder,
  ArrayBuffer, DataView, Float32Array, Float64Array, Int8Array, Int16Array,
  Int32Array, Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array,
  console, isNaN, isFinite, parseInt, parseFloat, Number, String, Boolean,
  Array, Object, Error, RangeError, TypeError, Promise, Symbol, BigInt,
  setTimeout, clearTimeout,
  postMessage(message) { messages.push(message); },
});
context.self = context;
context.importScripts = (...names) => {
  for (const name of names) {
    vm.runInContext(readFileSync(join(ROOT, name), 'utf8'), context, { filename: name });
  }
};
vm.runInContext(readFileSync(join(ROOT, 'router-worker.js'), 'utf8'), context,
  { filename: 'router-worker.js' });
context.onmessage({ data: { type: 'graph', buffer: graphBuffer } });
if (!messages.some((message) => message.type === 'ready')) {
  throw new Error(`${region} graph did not load in the route matcher`);
}

let previous = [];
if (existsSync(sidecarPath)) {
  const sidecar = JSON.parse(zlib.gunzipSync(readFileSync(sidecarPath)));
  // Clear our old bits only when this is the graph that sidecar describes. A
  // newly rebuilt graph can reuse an edge index for an OSM-designated road;
  // clearing an old index there would damage the clean base graph.
  if (sidecar.format === 1 && Array.isArray(sidecar.addedEdges)
      && (!sidecar.graphHash || sidecar.graphHash === inputGraphHash)) {
    previous = sidecar.addedEdges;
  }
}
context._previousSupplementalEdges = previous;
vm.runInContext(`for (const edge of _previousSupplementalEdges) {
  if (Number.isInteger(edge) && edge >= 0 && edge < E) eFlags[edge] &= ~64;
}`, context);
context._supplementalRouteLines = lines;
const result = vm.runInContext(`(() => {
  const matched = matchRouteLines(_supplementalRouteLines);
  const addedEdges = [];
  let matchedEdges = 0;
  for (let edge = 0; edge < E; edge++) {
    if (!matched[edge]) continue;
    matchedEdges++;
    if (!(eFlags[edge] & 64)) addedEdges.push(edge);
    eFlags[edge] |= 64;
  }
  return { addedEdges, matchedEdges };
})()`, context);

const rebuilt = zlib.gzipSync(Buffer.from(graphBuffer), { level: 9, mtime: 0 });
const hash = createHash('sha256').update(rebuilt).digest('hex').slice(0, 12);
writeFileSync(graphPath, rebuilt);
const sourceCounts = routes.map((feature) => ({
  sourceId: feature.properties.sourceId,
  routeId: feature.properties.routeId,
  name: feature.properties.n,
}));
writeFileSync(sidecarPath, zlib.gzipSync(Buffer.from(`${JSON.stringify({
  format: 1,
  region,
  graphHash: hash,
  routes: sourceCounts,
  matchedEdges: result.matchedEdges,
  addedEdges: result.addedEdges,
}, null, 1)}\n`), { level: 9, mtime: 0 }));

const config = JSON.parse(readFileSync(regionPath, 'utf8'));
config.versions.graph = `sha-${hash}`;
// The decompressed size gates monolith-vs-partition routing on device; keep
// it true to the graph this stamp describes.
config.graphRawBytes = graphBuffer.byteLength;
writeFileSync(regionPath, `${JSON.stringify(config, null, 1)}\n`);
console.log(`${region}: ${routes.length} reviewed routes matched ${result.matchedEdges.toLocaleString()} edges`);
console.log(`  ${result.addedEdges.length.toLocaleString()} newly designated beyond OSM`);
console.log(`  graph ${config.versions.graph}`);
