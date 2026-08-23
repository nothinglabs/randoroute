#!/usr/bin/env node
// Turn the maps/ folders into the one list the app can read.
//
// Each state's truth is `maps/<state>/region.json`, next to that state's data
// and the notes describing how it was built. Nothing outside maps/ names a
// state -- but a browser cannot list a directory, so the folders are collected
// here into `maps/states.js`, a classic script index.html and sw.js load
// before region.js.
//
// It is a build artefact, checked in like build-version.js: adding a state is
// adding a folder and running `npm run maps:registry`.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const MAPS = resolve(option('--maps-root', join(ROOT, 'maps')));
const STATES_OUTPUT = resolve(option('--states-output', join(MAPS, 'states.js')));
const STORE_OUTPUT = resolve(option('--store-output', join(MAPS, 'index.json')));

// The one home of "which file carries each dataset". sw.js precaches these
// paths, build_mobile_shell.mjs bundles them, and the map-store installer
// downloads them -- all three read the file lists this script bakes into
// maps/index.json rather than keeping their own copy of this table.
const DATASET_FILES = {
  ferries: 'ferries.geojson.gz',
  bikeroutes: 'bikeroutes.geojson.gz',
  restrictions: 'bike_restrictions.geojson.gz',
  closures: 'route_closures.geojson.gz',
  roads: 'roads.pmtiles',
  basemap: 'basemap.pmtiles',
  overlays: 'overlays.pmtiles',
  graph: 'graph2.bin.gz',
  places: 'places.json',
};

// Every key a state may declare. An unknown key is a typo -- silently ignoring
// it is how a state ends up shipping with, say, `defaultZoomLevel` and opening
// at the wrong scale with nothing to show for it.
const KNOWN = new Set(['id', 'name', 'status', 'readiness', 'summary', 'bounds',
  'defaultCenter', 'defaultZoom', 'stressAgency', 'restrictionAgency', 'speedAgency',
  'facilitySourceName', 'stressLayerName', 'restrictionLayerName',
  'interstateRoutePrefixes', 'stateRoutePrefixes', 'facilityLevels', 'sourceCounts', 'routeDirectionSuffixes',
  // Documented in maps/README.md and read by test_shoulder_directional_fill.mjs,
  // and missing from this list until Nevada's import went looking for it: a
  // state that set the key the contract told it to set failed the registry
  // build with `unknown key`, which is the opposite of what an unknown-key
  // check is for.
  'directionalShoulderFloor',
  'datasets', 'versions', 'attribution']);
const REQUIRED = ['id', 'name', 'status', 'bounds', 'defaultCenter', 'defaultZoom', 'datasets'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const acquisitionId = (kind, stateId, value) =>
  `${kind}-${stateId}-${sha256(Buffer.from(JSON.stringify(value))).slice(0, 16)}`;

const states = [];
for (const entry of readdirSync(MAPS, { withFileTypes: true }).sort((a, b) =>
  a.name.localeCompare(b.name))) {
  if (!entry.isDirectory()) continue;
  const configPath = join(MAPS, entry.name, 'region.json');
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`maps/${entry.name}/ has no region.json`);
    throw new Error(`maps/${entry.name}/region.json is not valid JSON: ${error.message}`);
  }
  for (const key of REQUIRED) {
    if (config[key] === undefined) throw new Error(`maps/${entry.name}/region.json omits "${key}"`);
  }
  for (const key of Object.keys(config)) {
    if (!KNOWN.has(key)) throw new Error(`maps/${entry.name}/region.json has unknown key "${key}"`);
  }
  if (config.id !== entry.name) {
    throw new Error(`maps/${entry.name}/region.json declares id "${config.id}"`);
  }
  // A declared dataset whose file is missing would ship a state that 404s on
  // first use; measuring the files here both catches that and gives the store
  // index the sizes a download UI needs.
  const files = [];
  for (const [dataset, file] of Object.entries(DATASET_FILES)) {
    if (!config.datasets[dataset]) continue;
    const filePath = join(MAPS, entry.name, file);
    let stat;
    try {
      stat = statSync(filePath);
    } catch (e) {
      throw new Error(`maps/${entry.name}/region.json declares "${dataset}" but ${file} is missing`);
    }
    files.push({ dataset, path: file, bytes: stat.size });
  }
  const mapUnit = {
    acquisitionFormat: 1,
    id: acquisitionId('map', config.id, { versions: config.versions || {}, files }),
    kind: 'state-map',
    stateIds: [config.id],
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
  };
  states.push({ config, files, acquisitions: [mapUnit] });
}
if (!states.length) throw new Error('maps/ holds no states');

// A partition catalogue is optional while ordinary state graphs remain the
// compatibility path. When present, publish one state-owned routing unit per
// catalogue state. Units share the exact catalogue identity but contain only
// their owner's partition files, so installing another state never duplicates
// every already-installed state's detailed graph data.
const partitionCataloguePath = join(MAPS, 'partition-catalogue.json');
if (existsSync(partitionCataloguePath)) {
  const catalogueBytes = readFileSync(partitionCataloguePath);
  const catalogueSha256 = sha256(catalogueBytes);
  let catalogue;
  try { catalogue = JSON.parse(catalogueBytes.toString('utf8')); }
  catch (error) { throw new Error(`maps/partition-catalogue.json is invalid: ${error.message}`); }
  const { MultiStateRouting } = await import('node:module')
    .then(({ createRequire }) => createRequire(import.meta.url)(join(ROOT, 'multi-state-routing.js')));
  MultiStateRouting.validatePartitionCatalogue(catalogue);
  const stateById = new Map(states.map((entry) => [entry.config.id, entry]));
  const sourceStateDependencies = catalogue.states.map((state) => ({
    stateId: state.id, graphVersion: state.graphVersion, sha256: state.sourceSha256,
  }));
  for (const catalogueState of catalogue.states) {
    const entry = stateById.get(catalogueState.id);
    if (!entry) throw new Error(`partition catalogue names missing state "${catalogueState.id}"`);
    if (entry.config.versions?.graph !== catalogueState.graphVersion) {
      throw new Error(`${catalogueState.id}: partition catalogue graph version is stale`);
    }
    const files = catalogue.partitions
      .filter((partition) => partition.stateId === catalogueState.id)
      .map((partition) => {
        const filePath = join(MAPS, partition.path);
        let stat;
        try { stat = statSync(filePath); }
        catch (error) { throw new Error(`${partition.path}: partition catalogue file is missing`); }
        if (stat.size !== partition.compressedBytes) {
          throw new Error(`${partition.path}: partition catalogue byte size is stale`);
        }
        return {
          dataset: 'graph-partition', path: partition.path,
          bytes: partition.compressedBytes, rawBytes: partition.rawBytes,
          sha256: partition.sha256, partitionId: partition.id,
          stateId: partition.stateId, sourceGraphVersion: partition.sourceGraphVersion,
        };
      });
    const catalogueFile = {
      path: 'partition-catalogue.json', bytes: catalogueBytes.length,
      sha256: catalogueSha256,
      partitionCatalogueFormat: catalogue.partitionCatalogueFormat,
      graphFormat: catalogue.graphFormat,
    };
    entry.acquisitions.push({
      acquisitionFormat: 1,
      id: `routing-${catalogueState.id}-${catalogueSha256.slice(0, 16)}`,
      kind: 'routing-partitions', stateIds: [catalogueState.id],
      totalBytes: catalogueFile.bytes + files.reduce((sum, file) => sum + file.bytes, 0),
      compatibility: {
        partitionCatalogueFormat: catalogue.partitionCatalogueFormat,
        graphFormat: catalogue.graphFormat, catalogueSha256,
      },
      sourceStateDependencies,
      catalogue: catalogueFile,
      files,
    });
  }
}

const body = states.map(({ config }) => `  ${JSON.stringify(config)},`).join('\n');
const acquisitions = Object.fromEntries(states.map((entry) => [entry.config.id, entry.acquisitions]));
writeFileSync(STATES_OUTPUT, `/* GENERATED by scripts/build_map_registry.mjs -- do not edit.
 *
 * One entry per maps/<state>/region.json, in folder order. A browser cannot
 * list a directory, so the folders are indexed here; region.js picks which one
 * this session is running on. Rebuild with \`npm run maps:registry\`.
 *
 * Loaded as a classic script by index.html and via importScripts() by sw.js,
 * so it must not use module syntax. In Node the IIFE's \`this\` is
 * module.exports, so tests and build scripts can require() it.
 */
(function (root) {
  // False in a slim native shell: the states are known but their data files
  // are not on this origin, so using one means downloading it from a store.
  root.MAP_STATES_BUNDLED = true;
  root.MAP_STATES = [
${body}
  ];
  // Artifact manifests are derived from the generated store contract rather
  // than hand-authored state configuration. A full shell can use them
  // directly; a slim shell receives the same manifests after installation.
  root.MAP_STATE_ACQUISITIONS = ${JSON.stringify(acquisitions)};
}(typeof self !== 'undefined' ? self : this));
`);

// The same registry as pure data, plus per-file sizes: the map-store contract.
// A store is any HTTPS directory serving this file beside the state folders it
// describes; the app's installer reads it, and so does build_mobile_shell.mjs.
writeFileSync(STORE_OUTPUT, `${JSON.stringify({
  storeFormat: 2,
  states: states.map(({ config, files, acquisitions: units }) =>
    ({ ...config, files, acquisitions: units })),
}, null, 1)}\n`);

console.log(`indexed ${states.length} state${states.length === 1 ? '' : 's'} -> ${STATES_OUTPUT}, ${STORE_OUTPUT}`);
for (const { config, files } of states) {
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  console.log(`  ${config.id.padEnd(12)} ${config.status.padEnd(9)} ${(bytes / 1048576).toFixed(0)} MB in ${files.length} files`);
}
