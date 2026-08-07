#!/usr/bin/env node
// "Allow routes with ferries" is an admission gate: off, the ferry edge does
// not exist to the search. Three behaviours are pinned. Off actually removes
// the boat (a cross-sound trip reroutes over land, longer, with zero ferry
// meters). The land answer is a real route, not a failure — Winslow is
// reachable by bridge. And toggling back restores the boat EXACTLY: the goal
// potential built while ferries were banned is tighter than a ferry-allowed
// bound may be, so if its cache slot leaked across the toggle, the returned
// route could silently change. The rules signature keys the caches; this is
// the test that keeps it that way.
import assert from 'node:assert/strict';
import { routerWorker } from './testlib/harness.mjs';

const RULES = { allowFreeways: true, allowMtbTrails: false, preferPaved: true,
  minShoulder: 4, inferShoulderFromEdge: true, maxSpeedNoShoulder: 35,
  lanesNoShoulderOver: 3, busyNoShoulder: 2, allowSidewalkFallback: true,
  upperMaxSpeed: 45, noUpperLimit: true, requireSafe: false, allowFerries: true };
// Pioneer Square -> Winslow (Bainbridge Island): a boat ride with the boat,
// a trip around the Tacoma Narrows and up Kitsap without it.
const TRIP = [[-122.334, 47.6], [-122.515, 47.625]];
const request = (id, rules) => ({ type: 'route', id, rules, points: TRIP, mode: 'direct' });

const worker = routerWorker({ fresh: true });
const boat = worker.post(request('boat', RULES));
assert.ok(boat.ok, 'the ferry-allowed trip should route');
assert.ok(boat.ferryM > 1000, `the allowed route should ride the boat (ferryM ${Math.round(boat.ferryM)})`);

const land = worker.post(request('land', { ...RULES, allowFerries: false }));
assert.ok(land.ok, 'a land route via the Tacoma Narrows should exist');
assert.equal(Math.round(land.ferryM), 0, 'a banned-ferries route must contain zero ferry meters');
assert.ok(land.distM > boat.distM * 3,
  `the land detour should be a real detour (${Math.round(land.distM / 1000)} km vs ${Math.round(boat.distM / 1000)} km)`);

// Old saved states and shared links carry no allowFerries key at all; a
// missing key must mean allowed.
const { allowFerries, ...legacy } = RULES;
const legacyBoat = worker.post(request('legacy', legacy));
assert.ok(legacyBoat.ok && legacyBoat.ferryM > 1000, 'a missing allowFerries key must mean allowed');

const boatAgain = worker.post(request('boat-again', RULES));
assert.ok(boatAgain.ferryM > 1000, 'toggling back must restore the boat');
assert.equal(Math.round(boatAgain.distM), Math.round(boat.distM),
  'a ferry-allowed route after a banned search must match the original exactly');

console.log(`Ferry toggle holds: boat ${Math.round(boat.distM / 1000)} km with `
  + `${Math.round(boat.ferryM / 1000)} km of ferry; banned reroutes over land `
  + `${Math.round(land.distM / 1000)} km with none; toggle round-trip is exact.`);
