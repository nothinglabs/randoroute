#!/usr/bin/env node
// Does the router still get a rider across Puget Sound on roads that match
// their rules?
//
// This test asserts INVARIANTS, not measurements. It used to pin distance and
// facility windows -- "70 to 80 miles with at least 22 miles of bike facility",
// "the middle leg is 31 to 38 miles" -- and its own comments recorded the
// ratchet that produced them:
//
//     "it measures 29.97 mi on the 2026-07 WSDOT rebuild (was ~30),
//      so the first-leg floor is 29.5"
//     "Whidbey middle crossing floor is 31 (not 32): the ferry-access patch
//      ... shaving ~0.3 mi off the Clinton/Coupeville approach"
//
// Those numbers tested SAMENESS. Every deliberate routing change broke them and
// had to be paid for with a test edit, which teaches exactly the wrong reflex:
// re-bless the new output and move on. Removing the designation rung -- a change
// made because a signed route was excusing US 101 at 60 mph with no shoulder --
// broke this test purely by shifting a route from 72 miles to 66.
//
// What survives is what stays true however the router is tuned:
//
//   1. A fully rule-matching route EXISTS between these points. This is the
//      corridor-severance detector, and it is the reason this file is worth
//      keeping: a scoring change that quietly cuts Whidbey in half turns this
//      from pass to fail, and nothing else would notice until a rider could not
//      get to Port Townsend.
//   2. No option takes a freeway or a mountain-bike trail when the rules
//      exclude them.
//   3. No option is absurdly long. A loose multiple of the shortest option
//      offered catches "the router went via Spokane" without caring whether a
//      route is 66 miles or 72.
//
// Distances, facility mileage and leg splits are still PRINTED for a human to
// read. They are just not assertions.
import { spawnSync } from 'node:child_process';

const phinney = [-122.35403, 47.67213];
const seattle = [-122.3321, 47.6062];
const mukilteo = [-122.29704, 47.95067];
const portTownsend = [-122.75902, 48.11111];
const common = {
  rules: { freeMaxSpeed: 35 },
  forceDesignated: true,
  forceResidential: true,
  // A portfolio spans deliberately different characters, from quickest to most
  // scenic, so the spread is wide on purpose. This only has to catch a route
  // that has gone somewhere absurd.
  invariants: { maxDistanceRatio: 2.5, maxFreewayM: 0, maxMtbM: 0 },
};

const scenarios = [
  {
    ...common,
    name: 'Portfolio: Phinney to Mukilteo keeps a fully matching corridor',
    points: [phinney, mukilteo],
    expectFullyMatching: true,
  },
  {
    ...common,
    name: 'Portfolio: Mukilteo to Port Townsend keeps the Whidbey corridor open',
    points: [mukilteo, portTownsend],
    expectFullyMatching: true,
  },
  {
    ...common,
    name: 'Portfolio: Seattle to Port Townsend offers the safe-island hybrid',
    points: [seattle, portTownsend],
    expectFullyMatching: true,
    // Field request: keep the practical mainland ride to Mukilteo, then use
    // the calmer Whidbey crossing from the safest candidate. This is a route
    // portfolio contract, not an exact-mileage snapshot: the broad section
    // bounds distinguish the hybrid from both the direct-island and
    // long-mainland parents while allowing the graph data to improve.
    expectAny: {
      crossBred: true,
      ferries: ['Mukilteo-Clinton Ferry', 'Port Townsend-Coupeville Ferry'],
      landMinMi: [30, 32],
      landMaxMi: [42, 45],
    },
  },
];

const result = spawnSync(process.execPath,
  [new URL('./smoke_route_graph.mjs', import.meta.url).pathname, JSON.stringify(scenarios)],
  { stdio: 'inherit' });
process.exit(result.status == null ? 1 : result.status);
