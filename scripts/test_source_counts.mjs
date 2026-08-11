#!/usr/bin/env node
// The layer list's feature counts belong to the STATE, not to app.js.
//
// A vector tile carries no global count, so the totals shown beside each
// overlay layer are baked at build time -- and they were baked into SOURCES in
// app.js as literals. Those literals were Washington's, so the moment a second
// state shipped, Oregon's layer list reported Washington's numbers: 55,271 BLTS
// segments against its actual 81,210, and 338,650 roads against 308,347.
//
// Nothing caught it because nothing compared a displayed number to the data
// behind it. This does, for every state, against the files that ship.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';
import { ROOT, check, checkEqual, done, source } from './testlib/harness.mjs';

const { MAP_STATES } = createRequire(import.meta.url)(ROOT + '/maps/states.js');
const appSrc = source('app.js');

// SOURCES must read Region, not carry literals. A number here is a state fact
// in shared code, which is the bug this file exists for.
const literals = appSrc.match(/^\s*count: \d+/gm) || [];
check('no layer count is hardcoded in app.js', literals.length === 0,
  literals.join(' | '));

const features = (path) => {
  const raw = zlib.gunzipSync(readFileSync(path));
  return JSON.parse(raw.toString('utf8')).features.length;
};

for (const state of MAP_STATES) {
  const counts = state.sourceCounts || {};
  check(`${state.id}: declares its layer counts`,
    !!counts.blts && !!counts.bikeinfra && !!counts.roads, JSON.stringify(counts));
  if (!counts.blts) continue;

  // blts ships whole, so this is exact.
  if (state.datasets?.overlays) {
    checkEqual(`${state.id}: the BLTS count matches blts.geojson.gz`,
      counts.blts, features(`${ROOT}/maps/${state.id}/blts.geojson.gz`));
  }
  // bikeinfra is filtered before tiling (sharrow-only ways are dropped), so the
  // shipped total is only an upper bound here. test_source_counts.py PINS it
  // exactly, by importing the real sharrow_only() from the builder rather than
  // reimplementing the rule in a second language -- which would be the very
  // defect this family of tests exists to catch.
  const infra = features(`${ROOT}/maps/${state.id}/bikeinfra.geojson.gz`);
  check(`${state.id}: the bike-infrastructure count is within its own data`,
    counts.bikeinfra > 0 && counts.bikeinfra <= infra,
    `${counts.bikeinfra} declared vs ${infra} shipped`);
}

// The counts must DIFFER between states. If a second state is ever given the
// first one's numbers again, this is the check that says so.
const seen = MAP_STATES.filter((s) => s.sourceCounts?.blts)
  .map((s) => `${s.sourceCounts.blts}/${s.sourceCounts.roads}`);
check('no two states report the same counts', new Set(seen).size === seen.length,
  seen.join(' | '));

done();
