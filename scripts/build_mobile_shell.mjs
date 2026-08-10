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
  'region.js',
  'build-version.js',
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
];

// The native app carries EVERY state's data, so a rider switching on the Maps
// screen is switching between things already on the device rather than
// starting a download. (The web app is the other way round: it fetches the one
// state the rider selected.) On-demand delivery is the eventual answer to the
// size this grows into; until then the whole thing ships in the bundle.
//
// Which files a state has is its own declaration, in maps/<state>/region.json,
// so a state under construction contributes only what it actually built. Note
// what is NOT here: the *.geojson and *.geojson.gz source archives behind the
// tiles are build inputs, and the runtime has not fetched them since those
// overlays moved to PMTiles.
const DATASET_FILES = {
  bikeroutes: 'bikeroutes.geojson.gz',
  restrictions: 'bike_restrictions.geojson.gz',
  closures: 'route_closures.geojson.gz',
  roads: 'roads.pmtiles',
  basemap: 'basemap.pmtiles',
  overlays: 'overlays.pmtiles',
  graph: 'graph2.bin.gz',
  places: 'places.json',
};
const { MAP_STATES } = createRequire(import.meta.url)(join(root, 'maps/states.js'));
for (const state of MAP_STATES) {
  for (const [dataset, file] of Object.entries(DATASET_FILES)) {
    if (state.datasets[dataset]) files.push(`maps/${state.id}/${file}`);
  }
}

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

console.log(`Prepared ${files.length} native shell assets in mobile-shell/`);
console.log(`  ${MAP_STATES.length} state${MAP_STATES.length === 1 ? '' : 's'} bundled: `
  + MAP_STATES.map((state) => `${state.name} (${state.status})`).join(', '));
