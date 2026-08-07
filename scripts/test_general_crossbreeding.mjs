#!/usr/bin/env node
// General route cross-breeding uses exact shared graph nodes, collapses a
// shared edge run to one equivalent cut, and refuses a splice that would visit
// a node twice. The full browser/portfolio integration is held by
// test_all_routes_screen.mjs on Seattle -> Mukilteo; these are the small
// structural contracts that are easier to see with deliberately tiny paths.
import { check, done, routerWorker } from './testlib/harness.mjs';

const worker = routerWorker();

worker.context.crossBreedFixtures = {
  first: {
    nodeIds: [0, 1, 2, 3, 4, 5, 9],
    edgeIds: [10, 11, 12, 13, 14, 15],
  },
  sharedRun: {
    nodeIds: [0, 6, 2, 3, 7, 8, 9],
    edgeIds: [20, 21, 12, 22, 23, 24],
  },
  parallelRun: {
    nodeIds: [0, 6, 2, 3, 7, 8, 9],
    edgeIds: [20, 21, 99, 22, 23, 24],
  },
};

const cuts = worker.run(`(() => ({
  shared: sharedCrossBreedCuts(crossBreedFixtures.first,
    crossBreedFixtures.sharedRun),
  parallel: sharedCrossBreedCuts(crossBreedFixtures.first,
    crossBreedFixtures.parallelRun),
}))()`);

check('one shared graph-edge run produces one equivalent splice point',
  cuts.shared.length === 1 && cuts.shared[0].first === 2 && cuts.shared[0].second === 2,
  JSON.stringify(cuts.shared));
check('parallel edges between the same nodes remain distinct splice boundaries',
  cuts.parallel.length === 2
    && cuts.parallel[0].first === 2 && cuts.parallel[1].first === 3,
  JSON.stringify(cuts.parallel));

const loops = worker.run(`(() => ({
  repeated: crossBreedWouldLoop(
    { nodeIds: [0, 1, 2, 3] }, 2,
    { nodeIds: [8, 7, 2, 1, 9] }, 2),
  simple: crossBreedWouldLoop(
    { nodeIds: [0, 1, 2, 3] }, 2,
    { nodeIds: [8, 7, 2, 6, 9] }, 2),
}))()`);

check('a child that revisits a prefix node is rejected as a loop', loops.repeated === true);
check('a simple prefix-to-suffix splice is accepted', loops.simple === false);

const metric = (dangerM = 0, timeS = 1) => ({
  failM: 0, dangerM, cautionM: 0, gapM: 0, nonTrailM: 0, roughM: 0,
  ascentM: 0, timeS, distM: 1,
});

worker.context.sectionFrontierFixtures = {
  oneSwitch: [
    [
      { from: 0, to: 1, edge: 100, source: 0, index: 0, metrics: metric() },
      { from: 1, to: 2, edge: 101, source: 0, index: 1, metrics: metric() },
      { from: 2, to: 5, edge: 102, source: 0, index: 2, metrics: metric(10) },
      { from: 5, to: 6, edge: 103, source: 0, index: 3, metrics: metric(10) },
    ],
    [
      { from: 0, to: 3, edge: 200, source: 1, index: 0, metrics: metric(10) },
      { from: 3, to: 2, edge: 201, source: 1, index: 1, metrics: metric(10) },
      { from: 2, to: 4, edge: 202, source: 1, index: 2, metrics: metric() },
      { from: 4, to: 6, edge: 203, source: 1, index: 3, metrics: metric() },
    ],
  ],
  twoSwitches: [
    [
      { from: 0, to: 1, edge: 300, source: 0, index: 0, metrics: metric() },
      { from: 1, to: 2, edge: 301, source: 0, index: 1, metrics: metric() },
      { from: 2, to: 3, edge: 302, source: 0, index: 2, metrics: metric(10) },
      { from: 3, to: 4, edge: 303, source: 0, index: 3, metrics: metric(10) },
      { from: 4, to: 5, edge: 304, source: 0, index: 4, metrics: metric() },
      { from: 5, to: 6, edge: 305, source: 0, index: 5, metrics: metric() },
    ],
    [
      { from: 0, to: 7, edge: 400, source: 1, index: 0, metrics: metric(10) },
      { from: 7, to: 2, edge: 401, source: 1, index: 1, metrics: metric(10) },
      { from: 2, to: 8, edge: 402, source: 1, index: 2, metrics: metric() },
      { from: 8, to: 4, edge: 403, source: 1, index: 3, metrics: metric() },
      { from: 4, to: 9, edge: 404, source: 1, index: 4, metrics: metric(10) },
      { from: 9, to: 6, edge: 405, source: 1, index: 5, metrics: metric(10) },
    ],
  ],
};

const frontiers = worker.run(`(() => ({
  oneSwitch: boundedSectionFrontierPaths(sectionFrontierFixtures.oneSwitch, 0, 6)
    .map((path) => path.arcs.map((arc) => arc.edge)),
  twoSwitches: boundedSectionFrontierPaths(sectionFrontierFixtures.twoSwitches, 0, 6)
    .map((path) => path.arcs.map((arc) => arc.edge)),
}))()`);

check('section frontier combines a safer prefix and safer suffix at a shared junction',
  frontiers.oneSwitch.some((edges) => JSON.stringify(edges) === JSON.stringify([100, 101, 202, 203])),
  JSON.stringify(frontiers.oneSwitch));
check('dominated parent paths do not survive the section frontier',
  frontiers.oneSwitch.length === 1, JSON.stringify(frontiers.oneSwitch));
check('section frontier can switch parents more than once',
  frontiers.twoSwitches.some((edges) =>
    JSON.stringify(edges) === JSON.stringify([300, 301, 402, 403, 304, 305])),
  JSON.stringify(frontiers.twoSwitches));

const frontierExplanation = worker.run(`profileExplanation({
  crossBred: true, crossBreedKind: 'frontier'
})`);
check('section frontier explains its Pareto and exact-junction method',
  /non-dominated sections/i.test(frontierExplanation)
    && /exact shared road junctions/i.test(frontierExplanation),
  frontierExplanation);

done();
