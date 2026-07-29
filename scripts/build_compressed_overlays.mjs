import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const overlays = [
  'data/bikeroutes.geojson',
  'data/blts.geojson',
  'data/bikeinfra.geojson',
  'data/bike_restrictions.geojson',
  'data/route_closures.geojson',
];

for (const relativePath of overlays) {
  const source = await readFile(join(root, relativePath));
  // Catch a corrupt source before packaging it. The compressed copy is kept
  // deterministic so identical overlay data produces identical app bundles.
  JSON.parse(source);
  const outputPath = join(root, `${relativePath}.gz`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, gzipSync(source, { level: 9, mtime: 0 }));
  console.log(`${relativePath} -> ${relativePath}.gz`);
}
