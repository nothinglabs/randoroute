#!/usr/bin/env node
// Format 13 (BGRD) exists to be ready, not to be read: turn restrictions,
// barriers, refuge islands, smoothness, widthless shoulder claims, seasonal
// access, level crossings, widths, lit ways and ramp destinations are all
// collected NOW so the 50-state build never needs an immediate rebuild when
// a consumer appears (2026-08-27 direction). This proves the shipped
// Washington graph actually banks each of those facts at plausible density,
// that the worker holds the trailers, and — the part that guards riders
// today — that none of it changes what the router charges or reports.
import { appDefaultRules, check, done, graphBuffer, routerWorker } from './testlib/harness.mjs';

check('the shipped graph is BGRD',
  graphBuffer('washington').byteLength > 4
    && Buffer.from(graphBuffer('washington').slice(0, 4)).toString('ascii') === 'BGRD');

const worker = routerWorker();
check('the worker loads it', worker.ready);

const held = worker.run(`(() => {
  let extras = 0, width = 0, smooth = 0, barrier = 0, island = 0,
    level = 0, shoulderClaim = 0, seasonal = 0, lit = 0;
  for (let i = 0; i < E; i++) {
    const x = eExtras[i];
    if (x) extras++;
    if (x & 1) seasonal++;
    if (x & 2) lit++;
    if (x & 24) level++;
    if (x & 32) shoulderClaim++;
    if (eWidth[i]) width++;
    if (eSurface[i] >> 4) smooth++;
    const ld = eLimitedDir[i];
    if (ld & 48) barrier++;
    if (ld & 192) island++;
  }
  let excepted = 0;
  for (let i = 0; i < rKind.length; i++) if (rKind[i] & 128) excepted++;
  return { restrictions: rViaNode.length, destinations: destEdge.length,
    extras, width, smooth, barrier, island, level, shoulderClaim,
    seasonal, lit, excepted };
})()`);
// Floors sized well under the Seattle-extract-alone measurements, so a
// statewide regression to near-zero fails loudly while OSM churn passes.
check('turn restrictions are banked (with bicycle exceptions preserved)',
  held.restrictions > 5000 && held.excepted > 20, JSON.stringify(held));
check('ramp destinations are banked', held.destinations > 500, JSON.stringify(held));
check('per-edge facts are banked at plausible density',
  held.extras > 20000 && held.width > 3000 && held.smooth > 4000
    && held.barrier > 300 && held.island > 1000 && held.level > 40
    && held.shoulderClaim > 40 && held.seasonal > 100 && held.lit > 1000,
  JSON.stringify(held));

// Stored-unused is a promise to riders, not just a label: the level-4
// verdict, the priced cost of an arc and the reported surface class must be
// identical whether the format-13 bytes are present or zeroed out.
const inert = worker.run(`(() => {
  const rules = ${JSON.stringify(appDefaultRules())};
  useVerdictCache(rules);
  const modeW = modeWeights('balanced');
  const price = (ei) => edgeCostParts(ei, true, 'balanced', modeW, rules,
    rules, true, true, 0, false);
  const probes = [];
  for (let ei = 0; ei < E && probes.length < 2000; ei += 701) {
    if (eExtras[ei] || (eSurface[ei] >> 4)) probes.push(ei);
  }
  const before = probes.map((ei) => [price(ei),
    edgeLevelFor(ei, rules, true), eSurface[ei] & 15]);
  const savedExtras = eExtras.slice();
  const savedSurface = eSurface.slice();
  for (const ei of probes) { eExtras[ei] = 0; eSurface[ei] &= 15; }
  // The verdict slots cache per edge; drop them so the recheck genuinely
  // re-derives from the zeroed bytes instead of answering from cache.
  trimRoutingCaches();
  useVerdictCache(rules);
  const after = probes.map((ei) => [price(ei),
    edgeLevelFor(ei, rules, true), eSurface[ei] & 15]);
  eExtras.set(savedExtras);
  eSurface.set(savedSurface);
  trimRoutingCaches();
  return { probes: probes.length,
    identical: JSON.stringify(before) === JSON.stringify(after) };
})()`);
check('zeroing the format-13 bytes changes no price, verdict or surface',
  inert.probes > 100 && inert.identical, JSON.stringify(inert));

done();
