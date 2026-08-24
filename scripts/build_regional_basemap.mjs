#!/usr/bin/env node
// Build the small, resident regional ground archive from one state's
// already-released detailed basemap. No source download or OSM rebuild is
// involved, and no re-tiling either: the detailed archive already carries
// correct per-zoom generalizations of its ground layers at z4-z8 (desktop
// renders exactly those), so the regional archive is a verbatim copy of
// those tiles restricted to the three ground layers. An earlier version
// decoded the z8 features and re-encoded them across z4-z8; tippecanoe's
// low-zoom re-simplification of the generalized land layer bridged
// Admiralty Inlet at z6 -- geometry the archive's own z6 tile keeps open.
//
// The layers, in the under-over order the renderer draws them:
//   land        generalized ground; the ONLY layer with inland areas far
//               from the coast (southern Washington between Longview and
//               The Dalles exists in no other polygon layer)
//   land_detail the reviewed coastline band
//   water       lakes and rivers (the sea is the absence of land)
// A landlocked state's basemap may lack land_detail entirely; the copy then
// simply carries the layers it has, and the renderer's land layer is the
// ground.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAPS = join(ROOT, 'maps');
const MAX_ZOOM = 8;
const MIN_ZOOM = 4;
const LAYERS = ['land', 'land_detail', 'water'];

function command(name) {
  try {
    return execFileSync('which', [name], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(`Required command not found: ${name}`);
  }
}

function relativeToRoot(path) {
  return relative(ROOT, path).split('\\').join('/');
}

function build(state, tileJoin) {
  const folder = join(MAPS, state);
  const configPath = join(folder, 'region.json');
  if (!existsSync(configPath)) throw new Error(`no such state: maps/${state}/region.json`);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!config.datasets?.basemap) {
    throw new Error(`maps/${state}/region.json does not declare a basemap`);
  }

  const source = join(folder, 'basemap.pmtiles');
  if (!existsSync(source)) throw new Error(`missing maps/${state}/basemap.pmtiles`);
  const work = join(folder, '.regional-build');
  const staged = join(work, 'regional.pmtiles');
  const output = join(folder, 'regional.pmtiles');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  try {
    execFileSync(tileJoin, [
      `--output=${relativeToRoot(staged)}`, '--force',
      `--minimum-zoom=${MIN_ZOOM}`, `--maximum-zoom=${MAX_ZOOM}`,
      // The verbatim z8 water tiles of Puget Sound are the biggest; never
      // let a size limit silently drop one and drown a shoreline.
      '--no-tile-size-limit', '--no-tile-stats', '--quiet',
      ...LAYERS.map((layer) => `--layer=${layer}`),
      relativeToRoot(source),
    ], { cwd: ROOT, stdio: 'inherit' });
    renameSync(staged, output);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`Wrote maps/${state}/regional.pmtiles`);
}

const tileJoin = command('tile-join');
const states = process.argv.slice(2);
if (!states.length) {
  throw new Error('usage: node scripts/build_regional_basemap.mjs <state> [state ...]');
}
for (const state of states) build(state, tileJoin);
