// Compress every state's small runtime overlays, so the app fetches the .gz.
//
// The list of FILES is fixed -- these five are the overlays the app knows how
// to load -- but the list of STATES is not: it comes from the generated
// registry, because a hardcoded `maps/washington/...` here silently skipped a
// second state's overlays and left them uncompressed with no error anywhere.
// A state that does not ship one of these files simply has nothing to do.
//
// An optional state id narrows it to one folder. Walking the whole registry is
// right when the overlay format changes; it is wrong during a state IMPORT,
// where it rewrites the other states' committed .gz files. The bytes it writes
// are deterministic but not identical to whatever wrote them before -- Nevada's
// import found Oregon's and Washington's overlays rewritten byte-for-byte
// differently with identical content, which is a diff touching two shipped
// states for no reason, and the one thing an import is told not to do.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { MAP_STATES } = createRequire(import.meta.url)(join(root, 'maps/states.js'));
const OVERLAYS = ['bikeroutes.geojson', 'blts.geojson', 'bikeinfra.geojson',
  'bike_restrictions.geojson', 'route_closures.geojson'];

const only = process.argv[2];
if (only && !MAP_STATES.some((state) => state.id === only)) {
  throw new Error(`no such state in maps/states.js: ${only}`);
}

for (const state of MAP_STATES) {
  if (only && state.id !== only) continue;
  for (const name of OVERLAYS) {
    const relativePath = `maps/${state.id}/${name}`;
    if (!existsSync(join(root, relativePath))) continue;
    const source = await readFile(join(root, relativePath));
    // Catch a corrupt source before packaging it. The compressed copy is kept
    // deterministic so identical overlay data produces identical app bundles.
    JSON.parse(source);
    const outputPath = join(root, `${relativePath}.gz`);
    await mkdir(dirname(outputPath), { recursive: true });
    // Determinism holds per zlib build, not across them: another container's
    // zlib emits different bytes for identical content, and rewriting then
    // changes the registry's sizes and hashes — every installed device would
    // re-download packs that did not change. Content decides, not bytes.
    if (existsSync(outputPath)) {
      try {
        if (gunzipSync(await readFile(outputPath)).equals(source)) {
          console.log(`${relativePath}.gz already carries this content`);
          continue;
        }
      } catch (error) { /* corrupt gz: rewrite it */ }
    }
    await writeFile(outputPath, gzipSync(source, { level: 9, mtime: 0 }));
    console.log(`${relativePath} -> ${relativePath}.gz`);
  }
}
