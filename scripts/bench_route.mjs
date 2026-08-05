#!/usr/bin/env node
// Routing benchmark — NOT part of the test suite (the runner only picks
// test_*.mjs). Run it directly when perf work needs a number:
//
//   node scripts/bench_route.mjs         # long:  Seattle -> Vancouver WA
//   node scripts/bench_route.mjs short   # short: Seattle -> Everett
//
// It prints total wall time, the router's own phase timings, the candidate
// list (so a speedup that ALTERS routes is caught, not celebrated), and RSS.
//
// Baselines on the shared dev container (about 14x slower than an M2 MacBook
// Air; compare shapes and ratios across commits, not absolute seconds):
//   2026-08-05  pre-optimization        short 79.0 s   long 214.7 s
//   2026-08-05  cost cache + weighted   short 53.9 s   long ~112 s
//               A* (SEARCH_OVERSHOOT 1.15, exact when diversity probing)
// Candidate distances that move more than ~1% from a previous run mean the
// change was not perf-neutral -- stop and look before trusting the timing.
import { routerWorker } from './testlib/harness.mjs';

const PRESETS = {
  long:  { label: 'Seattle -> Vancouver WA',
           points: [[-122.3321, 47.6062], [-122.6615, 45.6387]] },
  short: { label: 'Seattle -> Everett',
           points: [[-122.3321, 47.6062], [-122.2021, 47.9790]] },
};
const which = process.argv[2] || 'long';
const preset = PRESETS[which];
if (!preset) {
  console.error(`unknown preset "${which}" -- one of: ${Object.keys(PRESETS).join(', ')}`);
  process.exit(2);
}

// The defaults a fresh install routes with.
const RULES = { minShoulder: 4, maxSpeedNoShoulder: 35, upperMaxSpeed: 45,
  noUpperLimit: true, lanesNoShoulderOver: 3, busyNoShoulder: 2,
  allowSidewalkFallback: true, allowFreeways: true, allowMtbTrails: false,
  inferShoulderFromEdge: true, requireSafe: false };

const w = routerWorker();
console.log(`bench: ${preset.label}`);

const before = process.memoryUsage().rss;
const start = performance.now();
const reply = w.post({ type: 'route-options', id: 'bench',
  points: preset.points, rules: RULES });
const totalMs = performance.now() - start;

console.log(`total: ${(totalMs / 1000).toFixed(1)} s`);
if (reply.timings) console.log('phase ms:', JSON.stringify(reply.timings));
console.log('candidates:', (reply.options || []).length, 'ok:', reply.ok !== false);
for (const option of reply.options || []) {
  const label = option.optimization?.label || option.profileId || option.label || '?';
  console.log(`  ${label}: ${(option.distM / 1000).toFixed(1)} km`);
}
console.log(`rss ${(before / 1e6).toFixed(0)} -> ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);
process.exit(0);
