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

done();
