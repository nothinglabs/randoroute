#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const phinney = [-122.35403, 47.67213];
const mukilteo = [-122.29704, 47.95067];
const portTownsend = [-122.75902, 48.11111];
const twoFerries = ['Mukilteo-Clinton Ferry', 'Port Townsend-Coupeville Ferry'];
const common = {
  rules: { freeMaxSpeed: 35 },
  forceDesignated: true,
  forceResidential: true,
};
const scenarios = [
  {
    ...common,
    name: 'Portfolio: Phinney to Mukilteo includes low-speed corridor',
    points: [phinney, mukilteo],
    expectFullyMatching: true,
    expectAny: {
      // Rebuilt against a fresh WSDOT speed/facility snapshot (2026-07): the
      // scenic ~30 mi, 27 mi-facility corridor is now surfaced by a balanced
      // profile rather than the 30 mph-capped discovery profile, and measures
      // 29.97 mi. High facility mileage (not the discovery label) pins the
      // scenic corridor; the standalone discovery option is a shorter 22.7 mi
      // route on this refreshed data.
      minDistanceMi: 29.5, maxDistanceMi: 33, minFacilityMi: 22,
      maxFailM: 400,
    },
  },
  {
    ...common,
    name: 'Portfolio: Mukilteo to Port Townsend retains scenic Whidbey corridor',
    points: [mukilteo, portTownsend],
    expectFullyMatching: true,
    expectAny: {
      maxDistanceMi: 50, maxFailM: 600, ferries: twoFerries,
      // Whidbey middle crossing floor is 31 (not 32): the ferry-access patch
      // makes terminal approaches two-way for bikes, shaving ~0.3 mi off the
      // Clinton/Coupeville approach without changing the route's character.
      landMinMi: [0, 31, 0], landMaxMi: [1, 38, 1],
    },
  },
  {
    ...common,
    name: 'Portfolio: no-waypoint full trip combines both corridors',
    points: [phinney, portTownsend],
    expectFullyMatching: true,
    expectAny: {
      minDistanceMi: 70, maxDistanceMi: 80, minFacilityMi: 22,
      maxFailM: 500, discoveryMaxSpeed: 30, ferries: twoFerries,
      // Whidbey crossing floor 31 (see note above): two-way ferry approaches.
      // On the full trip the discovery profile does take the scenic first leg;
      // it measures 29.97 mi on the 2026-07 WSDOT rebuild (was ~30), so the
      // first-leg floor is 29.5.
      landMinMi: [29.5, 31, 0], landMaxMi: [34, 38, 1],
    },
  },
];

const result = spawnSync(process.execPath,
  [new URL('./smoke_route_graph.mjs', import.meta.url).pathname, JSON.stringify(scenarios)],
  { stdio: 'inherit' });
process.exit(result.status == null ? 1 : result.status);
