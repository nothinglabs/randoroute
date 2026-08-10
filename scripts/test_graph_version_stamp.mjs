#!/usr/bin/env node
// The graph a rider downloads is the graph the version says it is.
//
// GRAPH_DATA_VERSION is what makes a service worker fetch a rebuilt graph: the
// cache is keyed by URL including `?gv=`, so an unchanged version means the new
// graph is silently never downloaded. build-version.js was created because two
// hand-maintained copies of the version drifted -- and then its single copy was
// forgotten twice in one day across three rebuilds. Nothing looked wrong,
// which is the whole failure.
//
// So the version is now DERIVED: build_graph.py stamps a sha256 prefix of the
// artefact into the state's own maps/<state>/region.json, and this test
// recomputes that hash from the graph actually on disk. A rebuild that skips
// the stamp -- or a hand-edited version that matches no artefact -- fails the
// suite here instead of shipping a graph nobody will ever receive.
//
// The path comes from the region rather than a literal, so a state that moves
// its folder cannot leave this test hashing a file the app never asks for.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ROOT } from './testlib/harness.mjs';

const require = createRequire(import.meta.url);
// The IIFE ends with `}(typeof self !== 'undefined' ? self : this))`, and in
// Node CJS `this` is module.exports -- same contract safety-model.js uses.
const bv = require(join(ROOT, 'build-version.js'));
const { Region } = require(join(ROOT, 'region.js'));
const graphPath = Region.dataUrl('graph2.bin.gz');

assert.ok(bv.GRAPH_DATA_VERSION, 'build-version.js should publish GRAPH_DATA_VERSION');

const digest = createHash('sha256')
  .update(readFileSync(join(ROOT, graphPath)))
  .digest('hex')
  .slice(0, 12);

assert.equal(bv.GRAPH_DATA_VERSION, `sha-${digest}`,
  `GRAPH_DATA_VERSION (${bv.GRAPH_DATA_VERSION}) does not match the graph on disk `
  + `(sha-${digest}). The graph was rebuilt without stamping -- run `
  + `scripts/build_graph.py, which stamps automatically, or `
  + `stamp_graph_version() from it.`);

// The URL is built from the version at load time; a stamp that did not reach
// the URL would defeat the cache key it exists for.
assert.ok(bv.GRAPH_URL.includes(`gv=${bv.GRAPH_DATA_VERSION}`),
  `GRAPH_URL (${bv.GRAPH_URL}) does not carry the stamped version`);

console.log(`Graph version stamp verified: ${bv.GRAPH_DATA_VERSION} matches ${graphPath}.`);
