#!/usr/bin/env node
// The generated native shell must contain every local script and stylesheet its
// HTML entry points load. A missing palette.js left the native app alive but
// stopped app.js at startup, producing controls over a blank map; the regular
// web tests could not see it because the file exists in the repository.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
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
// The full shell carries a bounded starter set. Every indexed state remains
// discoverable, but importing more states cannot silently grow one native
// target without limit.
const { MAP_STATES } = createRequire(import.meta.url)(join(ROOT, 'maps/states.js'));
const shellRegistry = createRequire(import.meta.url)(join(SHELL, 'maps/states.js'));
const bundledIds = shellRegistry.MAP_STATES_BUNDLED_IDS || [];
assert.ok(bundledIds.length > 0 && bundledIds.length <= 2,
  `the default full shell should bundle one or two starter states, got ${bundledIds.join(', ')}`);
assert.equal(shellRegistry.MAP_STORE_DEFAULT_URL,
  'https://nothinglabs.github.io/randoroute/maps/',
  'the full shell should configure the store used by non-bundled states');
const DATASET_FILES = {
  ferries: 'ferries.geojson.gz',
  bikeroutes: 'bikeroutes.geojson.gz',
  restrictions: 'bike_restrictions.geojson.gz',
  closures: 'route_closures.geojson.gz',
  roads: 'roads.pmtiles',
  regional: 'regional.pmtiles',
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
    if (!state.datasets[dataset] || !bundledIds.includes(state.id)) {
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
const storeIndex = JSON.parse(await readFile(join(ROOT, 'maps/index.json'), 'utf8'));
for (const stateId of bundledIds) {
  const state = storeIndex.states.find((candidate) => candidate.id === stateId);
  const routing = state.acquisitions.find((unit) => unit.kind === 'routing-partitions');
  if (!routing) continue;
  await assert.doesNotReject(access(join(SHELL, 'maps', routing.catalogue.path)),
    `${stateId} routing catalogue is absent from the full shell`);
  for (const file of routing.files) {
    await assert.doesNotReject(access(join(SHELL, 'maps', file.path)),
      `${stateId} routing partition ${file.partitionId} is absent from the full shell`);
  }
}
// The generated index itself: without it region.js throws at startup and the
// native app never gets past its launch screen.
await assert.doesNotReject(
  access(join(SHELL, 'maps/states.js')),
  'the native-shell build did not copy maps/states.js',
);
checked++;
await assert.doesNotReject(
  access(join(SHELL, 'maps/national-states.geojson')),
  'the native-shell build did not copy the resident national orientation layer',
);
checked++;

const slim = await mkdtemp(join(tmpdir(), 'randoroute-slim-shell-'));
try {
  execFileSync(process.execPath, [join(HERE, 'build_mobile_shell.mjs')], {
    cwd: ROOT, stdio: 'pipe', env: { ...process.env,
      JRA_SLIM_SHELL: '1', JRA_SHELL_OUTPUT: slim,
      JRA_MAP_STORE_URL: 'https://maps.example.test/releases/' },
  });
  const slimStates = await readFile(join(slim, 'maps/states.js'), 'utf8');
  assert.match(slimStates, /MAP_STATES_BUNDLED = false/,
    'the slim native shell did not mark state data as unbundled');
  assert.match(slimStates, /https:\/\/maps\.example\.test\/releases\//,
    'the slim native shell did not publish its configured HTTPS map store');
  await assert.doesNotReject(access(join(slim, 'maps/national-states.geojson')),
    'the slim native shell omitted the resident national orientation layer');
  await assert.rejects(access(join(slim, `maps/${MAP_STATES[0].id}/graph2.bin.gz`)),
    'the slim native shell bundled a detailed state graph');
  checked += 4;

  let overLimit = '';
  try {
    execFileSync(process.execPath, [join(HERE, 'build_mobile_shell.mjs')], {
      cwd: ROOT, stdio: 'pipe', env: { ...process.env,
        JRA_BUNDLED_STATE_IDS: 'washington,oregon,california',
        JRA_SHELL_OUTPUT: slim },
    });
  } catch (error) {
    overLimit = String(error.stderr || error.message);
  }
  assert.match(overLimit, /may name at most 2 states/,
    'the native shell should reject an explicit starter set above the two-state bound');
  checked++;
} finally {
  await rm(slim, { recursive: true, force: true });
}

console.log(`Native shell verified: ${checked} local resources are packaged `
  + `(${dataFiles} data files across ${MAP_STATES.length} states)`);
