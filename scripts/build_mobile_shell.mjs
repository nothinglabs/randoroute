import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'mobile-shell');
const files = [
  'index.html',
  'styles.css',
  'app.js',
  'basemap-style.js',
  'router-worker.js',
  'route-details.html',
  'route-details.css',
  'route-details.js',
  'manifest.json',
  'vendor/maplibre-gl.js',
  'vendor/maplibre-gl.css',
  'vendor/pmtiles.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'data/bikeroutes.geojson',
  'data/blts.geojson',
  'data/bikeinfra.geojson',
  'data/bike_restrictions.geojson',
  'data/route_closures.geojson',
  'data/roads.pmtiles',
  'data/basemap.pmtiles',
  'data/graph2.bin.gz',
  'data/places.json',
  'fonts/Klokantech Noto Sans Regular/0-255.pbf',
  'fonts/Klokantech Noto Sans Regular/256-511.pbf',
  'fonts/Klokantech Noto Sans Regular/512-767.pbf',
  'fonts/Klokantech Noto Sans Regular/768-1023.pbf',
];

for (const relativePath of files) {
  const destination = join(output, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(root, relativePath), destination);
}

console.log(`Prepared ${files.length} native shell assets in mobile-shell/`);
