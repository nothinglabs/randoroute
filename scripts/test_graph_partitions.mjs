#!/usr/bin/env node
// Execute the real partition builder against tiny ordinary graphs. The states
// exist only below a temporary test root; no real maps/<state>/ folder is added.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import zlib from 'node:zlib';
import { check, checkEqual, done, ROOT } from './testlib/harness.mjs';

const require = createRequire(import.meta.url);
const { MultiStateRouting: M } = require(join(ROOT, 'multi-state-routing.js'));
const python = process.env.PYTHON || 'python3';
const fixture = join(ROOT, 'scripts/testlib/build_synthetic_partition_fixture.py');
const builder = join(ROOT, 'scripts/build_graph_partitions.py');
const validator = join(ROOT, 'scripts/validate_partition_catalogue.mjs');
const temp = mkdtempSync(join(tmpdir(), 'randoroute-partitions-'));

function filesBelow(root) {
  const found = [];
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(relative(root, full));
    }
  }
  walk(root);
  return found.sort();
}

function build(maps, output, stateOrder = ['state-a', 'state-b']) {
  const catalogue = join(output, 'partition-catalogue.json');
  const args = [builder, '--maps-root', maps, '--output-root', output,
    '--catalogue', catalogue, '--cell-degrees', '1'];
  for (const state of stateOrder) args.push('--state', state);
  execFileSync(python, args, { cwd: ROOT, stdio: 'pipe' });
  return { catalogue, value: JSON.parse(readFileSync(catalogue, 'utf8')) };
}

function unwrap(path) {
  const raw = zlib.gunzipSync(readFileSync(path));
  const metaLength = raw.readUInt32LE(4);
  const graphLength = raw.readUInt32LE(8);
  const graphStart = 12 + metaLength + ((4 - (12 + metaLength) % 4) % 4);
  return { raw, metadata: JSON.parse(raw.subarray(12, 12 + metaLength).toString('utf8')),
    graph: raw.subarray(graphStart, graphStart + graphLength) };
}

function graphFlags(graph) {
  const nodes = graph.readUInt32LE(4), edges = graph.readUInt32LE(8);
  let offset = 28 + nodes * 4 + nodes * 4 + nodes * 2;
  offset += (4 - offset % 4) % 4;
  offset += edges * 4 * 3 + edges * 2 * 2 + edges * 2;
  return [...graph.subarray(offset, offset + edges)];
}

try {
  const maps = join(temp, 'maps');
  execFileSync(python, [fixture, maps], { cwd: ROOT });
  const first = build(maps, join(temp, 'out-first'));
  const second = build(maps, join(temp, 'out-second'), ['state-b', 'state-a']);

  check('the generated catalogue passes the shared strict validator',
    M.validatePartitionCatalogue(first.value) === first.value);
  checkEqual('the fixture is split into four detailed partitions', first.value.partitions.length, 4);
  checkEqual('every source edge occurs in exactly one partition',
    first.value.partitions.reduce((sum, part) => sum + part.edgeCount, 0), 4);
  check('both source states own partitions without pair-specific fields',
    first.value.states.map((state) => state.id).join('|') === 'state-a|state-b'
      && first.value.states.every((state) => state.partitionIds.length === 2),
    JSON.stringify(first.value.states));

  const crossStatePortals = first.value.portals.filter((portal) => {
    const owners = portal.endpoints.map((endpoint) =>
      first.value.partitions.find((part) => part.id === endpoint.partitionId).stateId);
    return owners[0] !== owners[1];
  });
  checkEqual('one exact encoded node joins the two synthetic states', crossStatePortals.length, 1);
  checkEqual('the two internal boundaries and one state boundary are all explicit portals',
    first.value.portals.length, 3);
  check('the cross-state portal records identical coordinate bits',
    crossStatePortals[0].endpoints[0].lonBits === crossStatePortals[0].endpoints[1].lonBits
      && crossStatePortals[0].endpoints[0].latBits === crossStatePortals[0].endpoints[1].latBits,
    JSON.stringify(crossStatePortals[0]));

  const outputFiles = filesBelow(join(temp, 'out-first'));
  check('each catalogue partition names a generated artifact',
    first.value.partitions.every((part) => outputFiles.includes(part.path)),
    outputFiles.join(', '));
  const sample = first.value.partitions[0];
  const samplePayload = unwrap(join(temp, 'out-first', sample.path));
  const metadata = samplePayload.metadata;
  check('partition bytes carry a BGP1 wrapper and matching ownership metadata',
    samplePayload.raw.subarray(0, 4).toString() === 'BGP1'
      && metadata.partitionId === sample.id && metadata.stateId === sample.stateId
      && metadata.partitionFormat === first.value.graphFormat,
    JSON.stringify(metadata));
  check('a legacy ordinary graph is upgraded to the uniform embedded BGRC format',
    first.value.partitions.filter((part) => part.stateId === 'state-a').every((part) =>
      unwrap(join(temp, 'out-first', part.path)).graph.subarray(0, 4).toString() === 'BGRC'));
  check('catalogue sizes and hashes describe the emitted partition bytes',
    first.value.partitions.every((part) => {
      const compressed = readFileSync(join(temp, 'out-first', part.path));
      const raw = zlib.gunzipSync(compressed);
      return compressed.length === part.compressedBytes && raw.length === part.rawBytes
        && createHash('sha256').update(compressed).digest('hex') === part.sha256;
    }));
  const stateBFlags = first.value.partitions.filter((part) => part.stateId === 'state-b')
    .flatMap((part) => graphFlags(unwrap(join(temp, 'out-first', part.path)).graph));
  check('ordinary one-way edge flags survive partition serialization',
    stateBFlags.filter((flags) => flags & 16).length === 1, JSON.stringify(stateBFlags));

  const validation = execFileSync(process.execPath, [validator, first.catalogue,
    '--artifact-root', join(temp, 'out-first'), '--source-root', maps],
  { cwd: ROOT, encoding: 'utf8' });
  check('the publication validator reads every source and partition artifact',
    /validated 2 states, 4 partitions, 3 exact portals/.test(validation), validation);

  const firstFiles = filesBelow(join(temp, 'out-first'));
  const secondFiles = filesBelow(join(temp, 'out-second'));
  check('input state order does not change generated paths', firstFiles.join('|') === secondFiles.join('|'));
  const byteDifferences = firstFiles.filter((path) =>
    !readFileSync(join(temp, 'out-first', path)).equals(readFileSync(join(temp, 'out-second', path))));
  check('identical inputs reproduce byte-identical catalogues and partitions',
    byteDifferences.length === 0, byteDifferences.join(', '));

  const stale = join(temp, 'out-first', 'state-a', 'partitions', 'v0-stale');
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, 'old.bin.gz'), 'unreachable');
  build(maps, join(temp, 'out-first'));
  check('a successful catalogue replacement removes unreachable generated acquisitions',
    !existsSync(stale));

  const nearbyMaps = join(temp, 'nearby-maps');
  execFileSync(python, [fixture, nearbyMaps, '--nearby'], { cwd: ROOT });
  const nearby = build(nearbyMaps, join(temp, 'nearby-out'));
  const nearbyCross = nearby.value.portals.filter((portal) => {
    const owners = portal.endpoints.map((endpoint) =>
      nearby.value.partitions.find((part) => part.id === endpoint.partitionId).stateId);
    return owners[0] !== owners[1];
  });
  checkEqual('nearby but non-identical state nodes do not become connected', nearbyCross.length, 0);

  const ambiguousMaps = join(temp, 'ambiguous-maps');
  execFileSync(python, [fixture, ambiguousMaps, '--ambiguous'], { cwd: ROOT });
  const ambiguousOutput = join(temp, 'ambiguous-out');
  const ambiguousRun = spawnSync(python, [builder, '--maps-root', ambiguousMaps,
    '--output-root', ambiguousOutput, '--catalogue', join(ambiguousOutput, 'catalogue.json'),
    '--state', 'state-a', '--state', 'state-b'], { cwd: ROOT, encoding: 'utf8' });
  check('an ambiguous duplicate-coordinate cross-state join fails the build',
    ambiguousRun.status !== 0 && /ambiguous exact cross-state node/.test(ambiguousRun.stderr),
    `${ambiguousRun.status}: ${ambiguousRun.stderr}`);
  check('a failed portal build publishes no partial catalogue or partition acquisition',
    !existsSync(join(ambiguousOutput, 'catalogue.json'))
      && (!existsSync(ambiguousOutput) || filesBelow(ambiguousOutput).length === 0),
    existsSync(ambiguousOutput) ? filesBelow(ambiguousOutput).join(', ') : 'no output root');
} finally {
  rmSync(temp, { recursive: true, force: true });
}

done();
