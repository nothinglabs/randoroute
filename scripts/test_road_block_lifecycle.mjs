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
import assert from 'node:assert';
import vm from 'node:vm';
import { appDefaultRules, check, done, routerWorker, source } from './testlib/harness.mjs';

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

// ---------------------------------------------------------------------------
// The engine above was never the whole story. Issue 11 kept being reported
// after the goal-potential fix because the second half is in the CARD: the
// road card asks roadBlockNear() whether a block is already here, and that
// lookup snapped the tap onto the drawn route. The block is what pushed that
// route away, so the lookup measured from the detour -- as far as
// BLOCK_SNAP_PX (34) from the block, past the 30 px match radius. The card
// then showed "Avoid this road", and the rider's removal tap ADDED A SECOND
// BLOCK. It healed once the detour passed 34 px (snapping stops firing), which
// is why it looked intermittent.
//
// Evaluated, not read: the real functions are lifted out of app.js and run
// against a stub projection.
const appSrc = source('app.js');
function lift(name) {
  const at = appSrc.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `app.js still defines ${name}`);
  let i = appSrc.indexOf('(', at), parens = 0;
  for (; i < appSrc.length; i++) {
    if (appSrc[i] === '(') parens++;
    else if (appSrc[i] === ')' && --parens === 0) break;
  }
  const open = appSrc.indexOf('{', i);
  let depth = 0, end = open;
  for (; end < appSrc.length; end++) {
    if (appSrc[end] === '{') depth++;
    else if (appSrc[end] === '}' && --depth === 0) break;
  }
  return appSrc.slice(at, end + 1);
}

const SCALE = 100000;                       // 0.0001 deg == 10 px
const box = {
  Math, Array, JSON, Infinity,
  BLOCK_SNAP_PX: Number(/const BLOCK_SNAP_PX = (\d+)/.exec(appSrc)[1]),
  map: {
    project: (ll) => (Array.isArray(ll)
      ? { x: ll[0] * SCALE, y: -ll[1] * SCALE }
      : { x: ll.lng * SCALE, y: -ll.lat * SCALE }),
    unproject: ([x, y]) => ({ lng: x / SCALE, lat: -y / SCALE }),
  },
  routing: { last: null, blocks: [] },
};
vm.createContext(box);
vm.runInContext(lift('snapToDrawnRoute'), box);
vm.runInContext(lift('roadBlockNear'), box);

const LAT = 47.65;
const BLOCK = [-122.345, LAT];
// The rider taps their own block; the post-block route runs detourPx away.
const looksUp = (detourPx, tapOffsetPx = 0) => {
  box.routing.blocks = [{ pt: BLOCK, ferryName: null }];
  box.routing.last = { ok: true,
    coords: [[-122.35, LAT + detourPx / SCALE], [-122.34, LAT + detourPx / SCALE]] };
  return !!box.roadBlockNear(
    { lng: BLOCK[0] + tapOffsetPx / SCALE, lat: LAT }, 30,
    { snap: true, ferryName: null });
};

// The dead zone that produced the field report: wider than the 30 px match
// radius, but still inside BLOCK_SNAP_PX, so the tap was dragged onto the
// detour and the block went missing.
const deadZone = [31, 33, 34];
check('a block is still found when its own detour sits in the snap dead zone',
  deadZone.every((d) => looksUp(d)),
  JSON.stringify(deadZone.map((d) => ({ detourPx: d, found: looksUp(d) }))));
check('and when the rider taps a little off the block, as on a phone',
  deadZone.every((d) => looksUp(d, 10)),
  JSON.stringify(deadZone.map((d) => ({ detourPx: d, found: looksUp(d, 10) }))));
// Distances either side of the dead zone always worked; they must keep working.
check('near and far detours keep finding the block',
  [5, 10, 20, 28, 36, 50, 200].every((d) => looksUp(d)),
  JSON.stringify([5, 10, 20, 28, 36, 50, 200].map((d) => ({ detourPx: d, found: looksUp(d) }))));
// The radius must still mean something: a block genuinely elsewhere is not a hit.
box.routing.blocks = [{ pt: [-122.3400, LAT], ferryName: null }];
box.routing.last = { ok: true, coords: [[-122.35, LAT], [-122.34, LAT]] };
check('a block far from the tap is still not reported as here',
  !box.roadBlockNear({ lng: -122.3450, lat: LAT }, 30, { snap: true, ferryName: null }),
  'block 500 px away must not match a 30 px lookup');

done();
