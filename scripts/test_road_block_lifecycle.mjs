#!/usr/bin/env node
// Removing a road block must actually remove it. Field, 2026-08-27: after
// deleting a block and forcing a recalc, routes kept avoiding the blocked
// spot — healing at random. Root cause: the A* goal-potential cache keyed
// on goal/mode/rules but not on the active blocks, so a potential built
// WITH a block (its edges excluded, bounds higher through that area) was
// reused after removal — an inadmissible bound that prunes exactly the
// paths through the old block site.
//
// The reproduction is the field sequence, order and all: a worker whose
// FIRST search for this trip runs with the block (poisoning the cache),
// then the same trip with the block removed — which must match a baseline
// from a worker that never saw a block.
import { appDefaultRules, check, done, routerWorker } from './testlib/harness.mjs';

// Across the Fremont Bridge: a pinch point, so the block forces a real
// detour (another canal crossing), which is what makes a poisoned bound
// large enough to steer the healed search visibly wrong.
const TRIP = { points: [[-122.3499, 47.6493], [-122.3446, 47.6390]], mode: 'balanced' };
const rules = appDefaultRules();

const clean = routerWorker({ fresh: true });
check('baseline worker loads', clean.ready);
const baseline = clean.post({ type: 'route', id: 1, rules, ...TRIP });
check('baseline route computes', baseline?.ok && baseline.distM > 1000,
  `distM ${baseline?.distM}`);
// Block the baseline where it crosses mid-canal.
const mid = baseline.coords.reduce((best, c) =>
  Math.abs(c[1] - 47.6470) < Math.abs(best[1] - 47.6470) ? c : best);

const blocked = routerWorker({ fresh: true });
check('blocked worker loads', blocked.ready);
const detour = blocked.post({ type: 'route', id: 2, rules, ...TRIP, blocks: [mid] });
check('a block on the route forces a detour',
  detour?.ok && Math.abs(detour.distM - baseline.distM) > 30,
  `baseline ${Math.round(baseline.distM)}m, blocked ${Math.round(detour.distM)}m`);

const healed = blocked.post({ type: 'route', id: 3, rules, ...TRIP, blocks: [] });
check('removing the block restores the baseline route',
  healed?.ok && Math.abs(healed.distM - baseline.distM) < 5,
  `baseline ${Math.round(baseline.distM)}m, after removal ${Math.round(healed.distM)}m`
  + ` (detour was ${Math.round(detour.distM)}m)`);

// The engine states its own block count so the app can catch a request that
// silently carried (or dropped) a block — the field report's tell.
check('the engine echoes how many blocks each search used',
  detour.blocksApplied === 1 && healed.blocksApplied === 0
    && baseline.blocksApplied === 0,
  JSON.stringify({ detour: detour.blocksApplied, healed: healed.blocksApplied,
    baseline: baseline.blocksApplied }));

done();
