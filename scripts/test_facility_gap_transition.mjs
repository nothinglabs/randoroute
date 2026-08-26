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
    gap: isFacilityGapEdge(i), flags: eFlags[i], facility: edgeFacilityBest(i),
    roadClass: eClass[i], lenM: eLen[i],
    distancePenalty: facilityGapDistancePenaltyS(i),
    entryPenalty: facilityGapEntryPenaltyS(-1, i),
    continuedPenalty: facilityGapEntryPenaltyS(i, i),
  };
})()`);
checkEqual('reported transition is classified', facts.gap, true);
checkEqual('classification requires a one-way road edge', !!(facts.flags & 16), true);
// eFacility nibble-packs both directions (a two-way sharrow reads 0x11), so
// assert the unpacked rung, never the raw byte.
checkEqual('classification requires a sharrow, not a bike lane', facts.facility, 1);
check('classification is limited to larger roads', facts.roadClass >= 4);
check('classification is limited to a short connector', facts.lenM <= 40);
check('distance creates an additive penalty', facts.distancePenalty > 0);
checkEqual('the conflict charges one entry penalty', facts.entryPenalty, 120);
checkEqual('a contiguous run does not repeat the entry penalty', facts.continuedPenalty, 0);

// The field route did not traverse only the tiny sharrow above. It entered
// from protected space across two ordinary road fragments, followed the
// one-way shared lane, then used NE 40th/Cowlitz to regain protected space.
// Pin the major-road fragment too: the original implementation marked a
// nearby 16 m piece but assigned no cost to the route the rider actually saw.
// 2026-08 OSM re-tagged the crossing fragment itself as a shared lane, so
// anchor on the classified conflict as mapped today: the gap-marked fragment
// spanning the major road, whatever its exact facility rung (as long as it is
// not a real bike lane, which would be wrongly swept in).
const roadwayCrossing = nearestEdge(worker, -122.31824, 47.65554,
  'isFacilityGapEdge(i) && eClass[i] >= 6 && eLen[i] <= 16');
const crossingFacts = worker.run(`(() => {
  const i = ${roadwayCrossing.edge};
  return { gap: isFacilityGapEdge(i), facility: edgeFacilityBest(i), roadClass: eClass[i], lenM: eLen[i] };
})()`);
check('the bridge traffic-crossing fragment is found',
  roadwayCrossing.edge >= 0 && roadwayCrossing.metres < 5, JSON.stringify(roadwayCrossing));
checkEqual('the complete bridge traffic conflict is classified', crossingFacts.gap, true);
check('the crossing fragment is not mistaken for a bike lane', crossingFacts.facility <= 1,
  JSON.stringify(crossingFacts));
check('the extended movement crosses a major road', crossingFacts.roadClass >= 6,
  JSON.stringify(crossingFacts));

const rules = { allowFreeways: true, allowMtbTrails: false, preferPaved: true,
  minShoulder: 4, inferShoulderFromEdge: true, maxSpeedNoShoulder: 35,
  lanesNoShoulderOver: 3, busyNoShoulder: 2, allowSidewalkFallback: true,
  upperMaxSpeed: 45, noUpperLimit: true, requireSafe: false };
const fieldRoute = worker.run(`route(
  [[-122.31758, 47.65756], [-122.3507, 47.6685]],
  ${JSON.stringify(rules)}, 'balanced', false, false)`);
check('the field route returns', fieldRoute.ok === true, fieldRoute.reason || '');
check('routing avoids the classified bridge traffic conflict',
  !fieldRoute.edgeIds.includes(roadwayCrossing.edge),
  JSON.stringify({ distanceM: Math.round(fieldRoute.distM) }));

const coverage = worker.run(`(() => {
  let gaps = 0, gapM = 0, infraMisclassified = 0, bikeLaneMisclassified = 0;
  for (let i = 0; i < E; i++) {
    if (!isFacilityGapEdge(i)) continue;
    gaps++; gapM += eLen[i];
    if (eFlags[i] & 8) infraMisclassified++;
    if (edgeFacilityBest(i) >= 2) bikeLaneMisclassified++;
  }
  return { edges: E, gaps, gapM, infraMisclassified, bikeLaneMisclassified };
})()`);
check('heuristic remains a narrow exception', coverage.gaps > 0
  && coverage.gaps / coverage.edges < 0.001, JSON.stringify(coverage));
checkEqual('explicit cycleway crossings are exempt', coverage.infraMisclassified, 0);
checkEqual('bike-lane edges are exempt', coverage.bikeLaneMisclassified, 0);

done();
