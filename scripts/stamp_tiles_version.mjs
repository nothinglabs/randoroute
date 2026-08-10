#!/usr/bin/env node
// Stamp a state's pmtiles archives' content hashes into its region.json,
// exactly as build_graph.py stamps the graph's. The service worker compares
// these on activation and refreshes a stale offline archive; without a stamp
// the offline copy was refreshed only by reinstalling the app.
//
// Run after any tile rebuild:
//   node scripts/stamp_tiles_version.mjs [state]      (default: washington)
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const state = process.argv[2] || 'washington';
const folder = join(ROOT, 'maps', state);
const configPath = join(folder, 'region.json');
if (!existsSync(configPath)) throw new Error(`no such state: maps/${state}/region.json`);

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const stamp = (name) => `sha-${createHash('sha256')
  .update(readFileSync(join(folder, name))).digest('hex').slice(0, 12)}`;

const versions = { ...config.versions };
for (const [dataset, file] of [
  ['roads', 'roads.pmtiles'],
  ['basemap', 'basemap.pmtiles'],
  ['overlays', 'overlays.pmtiles'],
]) {
  if (!config.datasets[dataset]) {
    // A state that does not ship the archive must not carry a stamp for it:
    // the service worker would then chase a refresh for a file that 404s on
    // every activation.
    delete versions[dataset];
    console.log(`skipped ${dataset} -- maps/${state}/ does not ship it`);
    continue;
  }
  versions[dataset] = stamp(file);
  console.log(`stamped ${dataset} = ${versions[dataset]}`);
}

config.versions = versions;
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
// The app reads the generated index, not the folders, so a stamp that stops
// here would never reach a browser.
execFileSync(process.execPath, [join(ROOT, 'scripts/build_map_registry.mjs')],
  { stdio: 'inherit' });
