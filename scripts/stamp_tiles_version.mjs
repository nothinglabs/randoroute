#!/usr/bin/env node
// Stamp the pmtiles archives' content hashes into build-version.js, exactly
// as build_graph.py stamps GRAPH_DATA_VERSION. The service worker compares
// these on activation and refreshes a stale offline archive; without a stamp
// the offline copy was refreshed only by reinstalling the app.
//
// Run after any tile rebuild: node scripts/stamp_tiles_version.mjs
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const stamp = (name) => {
  const sha = createHash('sha256')
    .update(readFileSync(join(ROOT, 'data', name)))
    .digest('hex').slice(0, 12);
  return `sha-${sha}`;
};

const versions = {
  ROADS_TILES_VERSION: stamp('roads.pmtiles'),
  BASEMAP_TILES_VERSION: stamp('basemap.pmtiles'),
  OVERLAY_TILES_VERSION: stamp('overlays.pmtiles'),
};

const path = join(ROOT, 'build-version.js');
let source = readFileSync(path, 'utf8');
for (const [key, value] of Object.entries(versions)) {
  const pattern = new RegExp(`(root\\.${key} = ')[^']*(')`);
  if (!pattern.test(source)) throw new Error(`${key} line not found in build-version.js`);
  source = source.replace(pattern, `$1${value}$2`);
  console.log(`stamped ${key} = ${value}`);
}
writeFileSync(path, source);
