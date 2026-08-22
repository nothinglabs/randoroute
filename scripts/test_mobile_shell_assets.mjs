#!/usr/bin/env node
// The generated native shell must contain every local script and stylesheet its
// HTML entry points load. A missing palette.js left the native app alive but
// stopped app.js at startup, producing controls over a blank map; the regular
// web tests could not see it because the file exists in the repository.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SHELL = join(ROOT, 'mobile-shell');

execFileSync(process.execPath, [join(HERE, 'build_mobile_shell.mjs')], {
  cwd: ROOT,
  stdio: 'pipe',
});

let checked = 0;
for (const entry of ['index.html', 'route-details.html']) {
  const html = await readFile(join(SHELL, entry), 'utf8');
  const refs = [
    ...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi),
    ...html.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["']/gi),
  ].map((match) => match[1])
    .filter((ref) => !/^(?:[a-z]+:|\/\/|#)/i.test(ref));

  assert.ok(refs.length, `${entry} should load local resources`);
  for (const ref of refs) {
    const path = ref.split(/[?#]/, 1)[0];
    await assert.doesNotReject(
      access(join(SHELL, path)),
      `${entry} loads ${ref}, but the native-shell build did not copy it`,
    );
    checked++;
  }
}

// Data does not appear in either HTML entry point: the app builds those paths
// at runtime from the loaded state's folder. Missing overlays.pmtiles made all
// standalone trails disappear on iOS while active-route trail segments (drawn
// from route geometry) still looked fine, and nothing in the HTML would have
// shown it.
//
// The native app carries EVERY state, so a rider switching on the Maps screen
// is switching between things already on the device. Each state's own
// region.json says which files it has; that is what must be in the bundle,
// file for file.
const { MAP_STATES } = createRequire(import.meta.url)(join(ROOT, 'maps/states.js'));
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
assert.ok(MAP_STATES.length >= 1, 'maps/states.js should index at least one state');
let dataFiles = 0;
for (const state of MAP_STATES) {
  for (const [dataset, file] of Object.entries(DATASET_FILES)) {
    const ref = `maps/${state.id}/${file}`;
    if (!state.datasets[dataset]) {
      // The reverse direction matters just as much: bundling a file the state
      // does not declare means the app will never ask for it, and the iOS
      // build silently carries dead megabytes.
      await assert.rejects(
        access(join(SHELL, ref)),
        `${state.id} does not declare "${dataset}", but the shell contains ${ref}`,
      );
      continue;
    }
    await assert.doesNotReject(
      access(join(SHELL, ref)),
      `${state.id} declares "${dataset}", but the native-shell build did not copy ${ref}`,
    );
    dataFiles++;
    checked++;
  }
}
// The generated index itself: without it region.js throws at startup and the
// native app never gets past its launch screen.
await assert.doesNotReject(
  access(join(SHELL, 'maps/states.js')),
  'the native-shell build did not copy maps/states.js',
);
checked++;

console.log(`Native shell verified: ${checked} local resources are packaged `
  + `(${dataFiles} data files across ${MAP_STATES.length} states)`);
