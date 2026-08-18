#!/usr/bin/env node
// A short shared-traffic connector between protected facilities can represent
// a hazardous merge/cross-traffic manoeuvre rather than a useful shortcut.
// Keep this deliberately narrow: explicit cycleway crossings and ordinary
// bike lanes must not be swept into the heuristic.
import { check, checkEqual, done, nearestEdge, routerWorker } from './testlib/harness.mjs';

const worker = routerWorker({ fresh: true });
check('production graph loads', worker.ready);

// Burke-Gilman / University Bridge transition reported from the field.
const reported = nearestEdge(worker, -122.3183675, 47.655559,
  'isFacilityGapEdge(i)');
check('reported bridge transition is found', reported.edge >= 0 && reported.metres < 5,
  JSON.stringify(reported));

const facts = worker.run(`(() => {
  const i = ${reported.edge};
  return {
    gap: isFacilityGapEdge(i), flags: eFlags[i], facility: eFacility[i],
    roadClass: eClass[i], lenM: eLen[i],
    distancePenalty: facilityGapDistancePenaltyS(i),
    entryPenalty: facilityGapEntryPenaltyS(-1, i),
    continuedPenalty: facilityGapEntryPenaltyS(i, i),
  };
})()`);
checkEqual('reported transition is classified', facts.gap, true);
checkEqual('classification requires a one-way road edge', !!(facts.flags & 16), true);
checkEqual('classification requires a sharrow, not a bike lane', facts.facility, 1);
check('classification is limited to larger roads', facts.roadClass >= 4);
check('classification is limited to a short connector', facts.lenM <= 40);
check('distance creates an additive penalty', facts.distancePenalty > 0);
checkEqual('the conflict charges one entry penalty', facts.entryPenalty, 120);
checkEqual('a contiguous run does not repeat the entry penalty', facts.continuedPenalty, 0);

const coverage = worker.run(`(() => {
  let gaps = 0, gapM = 0, infraMisclassified = 0, bikeLaneMisclassified = 0;
  for (let i = 0; i < E; i++) {
    if (!isFacilityGapEdge(i)) continue;
    gaps++; gapM += eLen[i];
    if (eFlags[i] & 8) infraMisclassified++;
    if (eFacility[i] >= 2) bikeLaneMisclassified++;
  }
  return { edges: E, gaps, gapM, infraMisclassified, bikeLaneMisclassified };
})()`);
check('heuristic remains a narrow exception', coverage.gaps > 0
  && coverage.gaps / coverage.edges < 0.001, JSON.stringify(coverage));
checkEqual('explicit cycleway crossings are exempt', coverage.infraMisclassified, 0);
checkEqual('bike-lane edges are exempt', coverage.bikeLaneMisclassified, 0);

done();
