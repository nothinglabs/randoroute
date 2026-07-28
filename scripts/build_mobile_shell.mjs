import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  'safety-model.js',
  'county-data.js',
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
  'data/bikeroutes.geojson.gz',
  'data/blts.geojson.gz',
  'data/bikeinfra.geojson.gz',
  'data/bike_restrictions.geojson.gz',
  'data/route_closures.geojson.gz',
  'data/roads.pmtiles',
  'data/basemap.pmtiles',
  'data/graph2.bin.gz',
  'data/places.json',
  'fonts/Klokantech Noto Sans Regular/0-255.pbf',
  'fonts/Klokantech Noto Sans Regular/256-511.pbf',
  'fonts/Klokantech Noto Sans Regular/512-767.pbf',
  'fonts/Klokantech Noto Sans Regular/768-1023.pbf',
];

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
