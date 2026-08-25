#!/usr/bin/env node
// Route climb must be physically possible. Field: a 41.6-mile Kirkland to
// Tacoma ferry route reported 9,022 ft of ascent with a 417 ft maximum
// elevation -- DEM nodata poisoned a few pier nodes with kilometre-deep
// values (-2,973 m in the released graph) and the short edges out of them
// carried thousands of metres of invented climb. The graph loaders repair
// those at parse time; these checks hold the repaired arrays and the field
// route to physical sense, in both the monolith worker and the partition
// runtime that constrained phones actually route through.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { appDefaultRules, check, done, ROOT, routerWorker } from './testlib/harness.mjs';

const require = createRequire(import.meta.url);
const { PartitionRouting } = require(join(ROOT, 'partition-runtime.js'));
const catalogue = require(join(ROOT, 'maps/partition-catalogue.json'));

const scan = `(() => {
  let minEle = Infinity, impossible = 0;
  for (let n = 0; n < nodeEle.length; n++) if (nodeEle[n] < minEle) minEle = nodeEle[n];
  for (let i = 0; i < eLen.length; i++) {
    if ((eAsc[i] > 100 && eAsc[i] > eLen[i]) || (eDes[i] > 100 && eDes[i] > eLen[i])) impossible++;
  }
  return JSON.stringify({ minEle, impossible });
})()`;

const worker = routerWorker();
const arrays = JSON.parse(worker.run(scan));
check('the loaded graph holds no impossible elevations',
  arrays.minEle >= -100 && arrays.impossible === 0, JSON.stringify(arrays));

// The field route. Anything near the reported 2,750 m of climb fails; the
// honest figure for this corridor is a few hundred metres.
const route = worker.post({ type: 'route', id: 'elevation-sanity',
  start: [-122.208, 47.676], end: [-122.44, 47.253],
  points: [[-122.208, 47.676], [-122.44, 47.253]],
  pointStateIds: ['washington', 'washington'], rules: appDefaultRules(),
  mode: 'balanced', prefDesignated: false, prefResidential: false });
check('Kirkland to Tacoma reports a physically possible climb',
  route?.ok === true && route.ascentM > 50 && route.ascentM < 1200,
  JSON.stringify({ ok: route?.ok, ascentM: Math.round(route?.ascentM || -1),
    distKm: +((route?.distM || 0) / 1000).toFixed(1),
    ferryKm: +((route?.ferryM || 0) / 1000).toFixed(1) }));

// Every production partition, through the partition runtime's own parser.
const loadPartition = async (partition) => {
  const raw = zlib.gunzipSync(readFileSync(join(ROOT, 'maps', partition.path)));
  return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
};
let worstMin = Infinity, impossibleEdges = 0, parsed = 0;
for (const partition of catalogue.partitions) {
  const composed = await PartitionRouting.composePartitions({ catalogue,
    partitionIds: [partition.id], routeStateIds: partition.stateIds || undefined,
    budgetBytes: partition.rawBytes * 4, loadPartition });
  const graph = PartitionRouting.parseBgrc(composed.buffer);
  parsed++;
  for (let n = 0; n < graph.N; n++) if (graph.nodeEle[n] < worstMin) worstMin = graph.nodeEle[n];
  for (let i = 0; i < graph.E; i++) {
    if ((graph.eAsc[i] > 100 && graph.eAsc[i] > graph.eLen[i])
        || (graph.eDes[i] > 100 && graph.eDes[i] > graph.eLen[i])) impossibleEdges++;
  }
}
check('every production partition parses to possible elevations',
  parsed > 0 && worstMin >= -100 && impossibleEdges === 0,
  JSON.stringify({ parsed, worstMin, impossibleEdges }));

done();
