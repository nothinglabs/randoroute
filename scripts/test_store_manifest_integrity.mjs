#!/usr/bin/env node
// The store manifest and the files it describes must be the SAME build.
// Field: a Washington install failed with "regional.pmtiles: expected 915501
// bytes, received 915593" — a deploy shipped maps/index.json from one
// tippecanoe run and the archive from another. Every byte count and every
// declared sha256 in the repo's manifest must match the files beside it, so
// skew is caught at build time instead of by a rider's failed download.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { check, done, ROOT } from './testlib/harness.mjs';

const index = JSON.parse(await readFile(join(ROOT, 'maps/index.json'), 'utf8'));
let files = 0, badBytes = [], badSha = [];
const sha256 = async (path) =>
  createHash('sha256').update(await readFile(path)).digest('hex');

for (const state of index.states) {
  for (const file of state.files || []) {
    files++;
    const path = join(ROOT, 'maps', state.id, file.path);
    const actual = await stat(path).then((s) => s.size, () => -1);
    if (actual !== file.bytes) badBytes.push(`${state.id}/${file.path}: manifest ${file.bytes}, file ${actual}`);
  }
  for (const unit of state.acquisitions || []) {
    if (unit.catalogue) {
      files++;
      const path = join(ROOT, 'maps', unit.catalogue.path);
      const actual = await stat(path).then((s) => s.size, () => -1);
      if (actual !== unit.catalogue.bytes) {
        badBytes.push(`${unit.catalogue.path}: manifest ${unit.catalogue.bytes}, file ${actual}`);
      }
      if (unit.catalogue.sha256 && await sha256(path) !== unit.catalogue.sha256) {
        badSha.push(unit.catalogue.path);
      }
    }
    for (const file of unit.files || []) {
      files++;
      // routing-partitions files carry maps/-relative paths; state-map
      // acquisition files are relative to the state's folder.
      const path = unit.kind === 'routing-partitions'
        ? join(ROOT, 'maps', file.path)
        : join(ROOT, 'maps', state.id, file.path);
      const actual = await stat(path).then((s) => s.size, () => -1);
      const declared = file.bytes ?? file.compressedBytes;
      if (actual !== declared) badBytes.push(`${file.path}: manifest ${declared}, file ${actual}`);
      if (file.sha256 && await sha256(path) !== file.sha256) badSha.push(file.path);
    }
  }
}

check(`every manifest byte count matches its file (${files} files)`,
  badBytes.length === 0, badBytes.slice(0, 5).join(' | '));
check('every declared sha256 matches its file',
  badSha.length === 0, badSha.slice(0, 5).join(' | '));
done();
