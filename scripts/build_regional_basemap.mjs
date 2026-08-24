#!/usr/bin/env node
// Build the small, resident regional land/water archive from one state's
// already-released detailed basemap. No source download or OSM rebuild is
// involved: zoom 8 is the handoff tile set already reviewed for that state.
// Re-tiling those features across zooms 4-8 preserves the detailed coastline
// and inland-water holes without loading the much larger context archive at
// regional zooms.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAPS = join(ROOT, 'maps');
const SOURCE_ZOOM = 8;
const MIN_ZOOM = 4;
// land_detail is the coastline band only -- inland areas far from the coast
// (southern Washington between Longview and The Dalles, for one) exist solely
// in the generalized land layer, on every zoom of the detailed archive. A
// regional archive without that layer painted those areas as open sea the
// moment nothing else backed it up. Carry both, in the same under-over order
// the detailed band draws them.
const LAYERS = ['land', 'land_detail', 'water'];

function command(name) {
  try {
    return execFileSync('which', [name], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(`Required command not found: ${name}`);
  }
}

function actualFeatures(value, output = []) {
  if (value?.type === 'Feature' && value.geometry) {
    output.push(value);
    return output;
  }
  for (const child of value?.features || []) actualFeatures(child, output);
  return output;
}

function relativeToRoot(path) {
  return relative(ROOT, path).split('\\').join('/');
}

function decodeFeatures(decoder, source, layer) {
  const decoded = JSON.parse(execFileSync(decoder, [
    '-l', layer, `-Z${SOURCE_ZOOM}`, `-z${SOURCE_ZOOM}`,
    relativeToRoot(source),
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
  return actualFeatures(decoded);
}

function build(state, decoder, tippecanoe) {
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
    const layerFiles = [];
    for (const layer of LAYERS) {
      let features = decodeFeatures(decoder, source, layer);
      // A landlocked state's basemap deliberately has no OSM coastline layer.
      // Its generalized land geometry is the accurate fallback, but publish
      // it under the same land_detail source-layer contract the renderer uses.
      if (layer === 'land_detail' && !features.length) {
        features = decodeFeatures(decoder, source, 'land');
        console.log('  land_detail uses land fallback (no coastline layer)');
      }
      if (!features.length) {
        throw new Error(`${state}: basemap zoom ${SOURCE_ZOOM} has no ${layer} features`);
      }
      const path = join(work, `${layer}.geojsonseq`);
      writeFileSync(path, `${features.map((feature) => JSON.stringify(feature)).join('\n')}\n`);
      layerFiles.push([layer, path]);
      console.log(`  ${layer.padEnd(11)} ${features.length.toLocaleString()} features`);
    }

    execFileSync(tippecanoe, [
      '-o', relativeToRoot(staged), '--force', `-Z${MIN_ZOOM}`, `-z${SOURCE_ZOOM}`,
      // Regional geography is tiny compared with the detailed basemap. Keep
      // every polygon: ordinary smallest-feature reduction dropped narrow
      // Whidbey at z4-5, and aggressive simplification erased Deception Pass.
      // The released Washington result remains below 151 KB compressed and
      // 451 KB uncompressed per tile, inside tippecanoe's ordinary limits.
      '--no-tiny-polygon-reduction',
      '--simplification=1', '--simplify-only-low-zooms', '--read-parallel',
      ...layerFiles.flatMap(([layer, path]) => ['-L', `${layer}:${relativeToRoot(path)}`]),
    ], { cwd: ROOT, stdio: 'inherit' });
    renameSync(staged, output);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`Wrote maps/${state}/regional.pmtiles`);
}

const decoder = command('tippecanoe-decode');
const tippecanoe = command('tippecanoe');
const states = process.argv.slice(2);
if (!states.length) {
  throw new Error('usage: node scripts/build_regional_basemap.mjs <state> [state ...]');
}
for (const state of states) build(state, decoder, tippecanoe);
