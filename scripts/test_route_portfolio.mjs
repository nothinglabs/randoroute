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
      minDistanceMi: 30, maxDistanceMi: 33, minFacilityMi: 22,
      maxFailM: 400, discoveryMaxSpeed: 30,
    },
  },
  {
    ...common,
    name: 'Portfolio: Mukilteo to Port Townsend retains scenic Whidbey corridor',
    points: [mukilteo, portTownsend],
    expectFullyMatching: true,
    expectAny: {
      maxDistanceMi: 50, maxFailM: 600, ferries: twoFerries,
      landMinMi: [0, 32, 0], landMaxMi: [1, 38, 1],
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
      landMinMi: [30, 32, 0], landMaxMi: [34, 38, 1],
    },
  },
];

const result = spawnSync(process.execPath,
  [new URL('./smoke_route_graph.mjs', import.meta.url).pathname, JSON.stringify(scenarios)],
  { stdio: 'inherit' });
process.exit(result.status == null ? 1 : result.status);
