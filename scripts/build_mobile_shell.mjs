import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'mobile-shell');
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
  'onboarding/tour-welcome.jpg',
  'onboarding/tour-plan.jpg',
  'onboarding/tour-routes.jpg',
  'onboarding/tour-fast.jpg',
  'onboarding/tour-safer.jpg',
  'onboarding/tour-road.jpg',
  'onboarding/tour-navigate.jpg',
];

// By default the native app carries EVERY state's data, so a rider switching
// on the Maps screen is switching between things already on the device rather
// than starting a download. (The web app is the other way round: it fetches
// the one state the rider selected.)
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
if (!SLIM) {
  for (const state of storeIndex.states) {
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
await writeFile(join(output, 'README.md'), `# Generated iOS web bundle

Run \`npm run ios:sync\` to rebuild this directory from the web app's current
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
  sharedIndex.replace('data-app-runtime="web"', 'data-app-runtime="native"'),
);

if (SLIM) {
  // The registry stays (the app must know which states exist) but the flag
  // flips so the Maps screen offers downloads rather than instant switches.
  const statesPath = join(output, 'maps/states.js');
  const registry = await readFile(statesPath, 'utf8');
  const flagged = registry.replace('root.MAP_STATES_BUNDLED = true;', 'root.MAP_STATES_BUNDLED = false;');
  if (flagged === registry) throw new Error('maps/states.js is missing the MAP_STATES_BUNDLED flag');
  await writeFile(statesPath, flagged);
}

console.log(`Prepared ${files.length} native shell assets in mobile-shell/`);
console.log(SLIM
  ? `  SLIM shell: ${MAP_STATES.length} state${MAP_STATES.length === 1 ? '' : 's'} indexed, no data bundled`
  : `  ${MAP_STATES.length} state${MAP_STATES.length === 1 ? '' : 's'} bundled: `
    + MAP_STATES.map((state) => `${state.name} (${state.status})`).join(', '));
