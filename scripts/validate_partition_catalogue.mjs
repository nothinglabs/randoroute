#!/usr/bin/env node
// Validate catalogue structure and every byte/hash/version it names. This is
// the publication gate after build_graph_partitions.py and before upload.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { MultiStateRouting: M } = require(join(ROOT, 'multi-state-routing.js'));

const args = process.argv.slice(2);
let catalogueArgument = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--artifact-root' || args[i] === '--source-root') { i++; continue; }
  if (!args[i].startsWith('--') && !catalogueArgument) catalogueArgument = args[i];
}
const cataloguePath = resolve(catalogueArgument || join(ROOT, 'maps/partition-catalogue.json'));
function option(name, fallback) {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`${name} needs a path`);
  return resolve(args[at + 1]);
}
const artifactRoot = option('--artifact-root', dirname(cataloguePath));
const sourceRoot = option('--source-root', artifactRoot);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const align4 = (value) => value + ((4 - value % 4) % 4);

try {
  const catalogue = JSON.parse(readFileSync(cataloguePath, 'utf8'));
  M.validatePartitionCatalogue(catalogue);
  for (const state of catalogue.states) {
    const compressed = readFileSync(join(sourceRoot, state.sourcePath));
    if (compressed.length !== state.sourceCompressedBytes) {
      throw new Error(`${state.sourcePath}: compressed size does not match catalogue`);
    }
    if (sha256(compressed) !== state.sourceSha256) {
      throw new Error(`${state.sourcePath}: sha256 does not match catalogue`);
    }
    const raw = zlib.gunzipSync(compressed);
    if (raw.length !== state.sourceRawBytes) {
      throw new Error(`${state.sourcePath}: raw size does not match catalogue`);
    }
  }
  for (const partition of catalogue.partitions) {
    const compressed = readFileSync(join(artifactRoot, partition.path));
    if (compressed.length !== partition.compressedBytes) {
      throw new Error(`${partition.path}: compressed size does not match catalogue`);
    }
    if (sha256(compressed) !== partition.sha256) {
      throw new Error(`${partition.path}: sha256 does not match catalogue`);
    }
    const raw = zlib.gunzipSync(compressed);
    if (raw.length !== partition.rawBytes) {
      throw new Error(`${partition.path}: raw size does not match catalogue`);
    }
    if (raw.subarray(0, 4).toString() !== 'BGP1') {
      throw new Error(`${partition.path}: bad partition magic`);
    }
    const metadataBytes = raw.readUInt32LE(4);
    const graphBytes = raw.readUInt32LE(8);
    const graphStart = align4(12 + metadataBytes);
    if (graphStart + graphBytes !== raw.length) {
      throw new Error(`${partition.path}: wrapper lengths do not match`);
    }
    const metadata = JSON.parse(raw.subarray(12, 12 + metadataBytes).toString('utf8'));
    const state = catalogue.states.find((entry) => entry.id === partition.stateId);
    // The magic is honest, not pinned: metadata must NAME what the bytes
    // actually are, and it must be a format the runtime parses (a BGRC
    // source graph legitimately yields BGRC partitions -- the synthetic
    // fixtures exercise exactly that back-compat path).
    if (metadata.partitionFormat !== catalogue.graphFormat
        || metadata.partitionId !== partition.id
        || metadata.stateId !== partition.stateId
        || metadata.sourceGraphVersion !== partition.sourceGraphVersion
        || metadata.sourceGraphSha256 !== state.sourceSha256
        || !['BGRC', 'BGRD'].includes(metadata.embeddedGraphMagic)) {
      throw new Error(`${partition.path}: wrapper metadata does not match catalogue`);
    }
    const embeddedMagic = raw.subarray(graphStart, graphStart + 4).toString();
    if (embeddedMagic !== metadata.embeddedGraphMagic) {
      throw new Error(`${partition.path}: embedded graph is ${embeddedMagic}, `
        + `metadata claims ${metadata.embeddedGraphMagic}`);
    }
    const graph = raw.subarray(graphStart, graphStart + graphBytes);
    const counts = [graph.readUInt32LE(4), graph.readUInt32LE(8), graph.readUInt32LE(12),
      graph.readUInt32LE(16), graph.readUInt32LE(20), graph.readUInt32LE(24)];
    const expected = [partition.nodeCount, partition.edgeCount, partition.directedArcCount,
      partition.geometryPointCount, partition.nameCount, partition.nameBytes];
    if (graphBytes !== partition.embeddedGraphBytes
        || counts.some((count, index) => count !== expected[index])) {
      throw new Error(`${partition.path}: embedded graph counts do not match catalogue`);
    }
  }
  console.log(`validated ${catalogue.states.length} states, ${catalogue.partitions.length} partitions, ${catalogue.portals.length} exact portals`);
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
