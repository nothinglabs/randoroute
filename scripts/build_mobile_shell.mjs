import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = process.env.JRA_SHELL_OUTPUT
  ? resolve(process.env.JRA_SHELL_OUTPUT) : join(root, 'mobile-shell');
const shellRuntime = process.env.JRA_SHELL_RUNTIME || 'native';
if (!['native', 'web'].includes(shellRuntime)) {
  throw new Error('JRA_SHELL_RUNTIME must be "native" or "web"');
}
const files = [
  'index.html',
  'street-view-embed.html',
  'styles.css',
  'app.js',
  'basemap-style.js',
  'marker-icons.js',
  'route-common.js',
  'palette.js',
  'maps/states.js',
  'map-store.js',
  'region.js',
  'build-version.js',
  'multi-state-routing.js',
  'partition-runtime.js',
  'partition-loader-worker.js',
  'multi-state-route-coordinator.js',
  'safety-model.js',
  'router-worker.js',
  'route-details.html',
  'route-details.css',
  'route-details.js',
  'manifest.json',
  'vendor/maplibre-gl.js',
  'vendor/maplibre-gl.css',
  'vendor/pmtiles.js',
  'vendor/fflate.js',
  'vendor/fflate-LICENSE.txt',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'fonts/Klokantech Noto Sans Regular/0-255.pbf',
  'fonts/Klokantech Noto Sans Regular/256-511.pbf',
  'fonts/Klokantech Noto Sans Regular/512-767.pbf',
  'fonts/Klokantech Noto Sans Regular/768-1023.pbf',
  'maps/index.json',
  'maps/national-states.geojson',
  'onboarding/tour-welcome.jpg',
  'onboarding/tour-plan.jpg',
  'onboarding/tour-routes.jpg',
  'onboarding/tour-fast.jpg',
  'onboarding/tour-safer.jpg',
  'onboarding/tour-road.jpg',
  'onboarding/tour-navigate.jpg',
];

// A full native shell carries a deliberately bounded starter set. Importing a
// tenth or fiftieth state must not silently turn one iOS target into a national
// multi-gigabyte bundle. The default chooses at most two released states by
// readiness; JRA_BUNDLED_STATE_IDS makes a different explicit product choice.
//
// JRA_SLIM_SHELL=1 builds the on-demand variant instead: the shell knows the
// states (maps/states.js, maps/index.json) but carries none of their data --
// MAP_STATES_BUNDLED flips to false, and the Maps screen offers downloads
// from a map store instead of instant switches. Ship slim only once a store
// is live and the download flow is field-verified.
//
// Which files a state has is baked into maps/index.json by the registry
// builder -- the one home of the dataset->file table. Note what is NOT
// bundled: the *.geojson and *.geojson.gz source archives behind the tiles
// are build inputs, and the runtime has not fetched them since those overlays
// moved to PMTiles.
const SLIM = process.env.JRA_SLIM_SHELL === '1';
const { MAP_STATES } = createRequire(import.meta.url)(join(root, 'maps/states.js'));
const storeIndex = JSON.parse(await readFile(join(root, 'maps/index.json'), 'utf8'));
const DEFAULT_BUNDLED_STATE_LIMIT = 2;
const explicitBundledStateIds = String(process.env.JRA_BUNDLED_STATE_IDS || '')
  .split(',').map((id) => id.trim()).filter(Boolean);
const knownStateIds = new Set(storeIndex.states.map((state) => state.id));
if (new Set(explicitBundledStateIds).size > DEFAULT_BUNDLED_STATE_LIMIT) {
  throw new Error(`JRA_BUNDLED_STATE_IDS may name at most ${DEFAULT_BUNDLED_STATE_LIMIT} states`);
}
if (explicitBundledStateIds.some((id) => !knownStateIds.has(id))) {
  throw new Error('JRA_BUNDLED_STATE_IDS names a state outside maps/index.json');
}
const defaultBundledStateIds = [...storeIndex.states]
  .filter((state) => state.status === 'released')
  .sort((a, b) => (b.readiness || 0) - (a.readiness || 0)
    || a.id.localeCompare(b.id))
  .slice(0, DEFAULT_BUNDLED_STATE_LIMIT)
  .map((state) => state.id);
const bundledStateIds = SLIM ? []
  : explicitBundledStateIds.length ? [...new Set(explicitBundledStateIds)]
    : defaultBundledStateIds;
if (!SLIM) {
  for (const state of storeIndex.states.filter((candidate) =>
    bundledStateIds.includes(candidate.id))) {
    for (const file of state.files) files.push(`maps/${state.id}/${file.path}`);
    for (const unit of state.acquisitions || []) {
      if (unit.kind !== 'routing-partitions') continue;
      files.push(`maps/${unit.catalogue.path}`);
      for (const file of unit.files) files.push(`maps/${file.path}`);
    }
  }
}

// Shared routing catalogues appear in every participating state's manifest.
// Copy each physical asset once.
files.splice(0, files.length, ...new Set(files));

// The shell is a generated bundle. Recreate it so assets removed from the
// manifest (notably the former uncompressed map overlays) cannot linger in an
// iOS build and silently erase the intended size reduction.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await writeFile(join(output, 'README.md'), `# Generated ${shellRuntime === 'native' ? 'iOS' : 'web-preview'} bundle

Run the repository's bundle script to rebuild this directory from the web app's current
HTML, CSS, JavaScript, vendor libraries, manifest, and icons. Large routing and
map datasets are also copied into the bundle so core mapping, routing, and
navigation do not depend on GitHub or another runtime server.
`);
for (const relativePath of files) {
  const destination = join(output, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(root, relativePath), destination);
}

const nativeIndexPath = join(output, 'index.html');
const sharedIndex = await readFile(nativeIndexPath, 'utf8');
if (!sharedIndex.includes('data-app-runtime="web"')) {
  throw new Error('index.html is missing the native-build runtime marker');
}
await writeFile(
  nativeIndexPath,
  shellRuntime === 'native'
    ? sharedIndex.replace('data-app-runtime="web"', 'data-app-runtime="native"')
    : sharedIndex,
);

const statesPath = join(output, 'maps/states.js');
let registry = await readFile(statesPath, 'utf8');
const storeUrl = process.env.JRA_MAP_STORE_URL
  || 'https://nothinglabs.github.io/randoroute/maps/';
if (!/^https:\/\//.test(storeUrl)) {
  throw new Error('JRA_MAP_STORE_URL must be an HTTPS directory URL');
}
const normalizedStoreUrl = storeUrl.endsWith('/') ? storeUrl : `${storeUrl}/`;
registry = registry
  .replace('root.MAP_STATES_BUNDLED = true;',
    `root.MAP_STATES_BUNDLED = ${String(!SLIM)};\n`
      + `  root.MAP_STATES_BUNDLED_IDS = ${JSON.stringify(bundledStateIds)};`)
  .replace('root.MAP_STATES = [',
    `root.MAP_STORE_DEFAULT_URL = ${JSON.stringify(normalizedStoreUrl)};\n  root.MAP_STATES = [`);
if (!registry.includes('root.MAP_STATES_BUNDLED_IDS =')) {
  throw new Error('maps/states.js is missing the MAP_STATES_BUNDLED flag');
}
await writeFile(statesPath, registry);

console.log(`Prepared ${files.length} ${shellRuntime} shell assets in ${output}`);
console.log(SLIM
  ? `  SLIM shell: ${MAP_STATES.length} state${MAP_STATES.length === 1 ? '' : 's'} indexed, no data bundled`
  : `  ${bundledStateIds.length} of ${MAP_STATES.length} indexed state${MAP_STATES.length === 1 ? '' : 's'} bundled: `
    + bundledStateIds.map((id) => MAP_STATES.find((state) => state.id === id)?.name || id).join(', '));
