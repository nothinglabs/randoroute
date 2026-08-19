#!/usr/bin/env node
// A route marked Preferred (Settings → Routes) is the alwaysPreferBikeRoutes
// lens scoped to ONE signed route. It gets a strong Suggested candidate plus
// moderate and neutral alternatives, while every other signed route stays
// ordinarily priced and every safety verdict stays exactly what it was.
// Proven against the real graph and the real bikeroutes overlay, through the
// worker's own matcher.
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routerWorker } from './testlib/harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RULES = {
  minShoulder: 4, maxSpeedNoShoulder: 35, upperMaxSpeed: 45,
  noUpperLimit: true, allowFreeways: false, allowMtbTrails: false,
  requireSafe: false, allowFerries: true, allowSidewalkFallback: true,
  preferPaved: true, inferShoulderFromEdge: true,
  lanesNoShoulderOver: 4, busyNoShoulder: 2,
};

// Pick a real, single-feature route of a rideable length from the shipped
// overlay -- the same file the app's Routes screen and worker sync read.
const overlay = JSON.parse(gunzipSync(readFileSync(
  join(ROOT, 'maps', 'washington', 'bikeroutes.geojson.gz'))));
const routes = new Map();
for (const feature of overlay.features) {
  const names = String(feature.properties?.n || '').split(' / ')
    .map((part) => part.trim()).filter(Boolean);
  const lines = feature.geometry?.type === 'LineString' ? [feature.geometry.coordinates]
    : feature.geometry?.type === 'MultiLineString' ? feature.geometry.coordinates : [];
  for (const name of names) {
    const entry = routes.get(name) || { name, lines: [], points: 0 };
    for (const line of lines) { entry.lines.push(line); entry.points += line.length; }
    routes.set(name, entry);
  }
}
const chosen = [...routes.values()]
  .filter((route) => route.points >= 50 && route.points <= 3000)
  .sort((a, b) => b.points - a.points)[0];
assert.ok(chosen, 'the overlay must contain a route of testable size');

const worker = routerWorker({ fresh: true });
assert.ok(worker.ready, 'the real routing graph must load');

const KEY = chosen.name;
const applied = worker.post({ type: 'preferred-routes', key: KEY, lines: chosen.lines });
assert.equal(applied?.type, 'preferred-routes-applied',
  'the worker must acknowledge the geometry it matched');
assert.equal(applied.key, KEY, 'the ack must carry the selection key');
assert.ok(applied.edges >= 5,
  `matching "${chosen.name}" should mark a meaningful number of edges (got ${applied.edges})`);

const result = worker.run(`(() => {
  const base = ${JSON.stringify(RULES)};
  const preferred = { ...base, preferredRoutes: ${JSON.stringify(KEY)} };
  const staleKey = { ...base, preferredRoutes: 'some other selection' };
  useWeights(null);

  // A matched edge of the chosen route, and a signed edge of some OTHER route.
  let onRoute = -1, offRoute = -1, facilityEdge = -1;
  for (let i = 0; i < E; i++) {
    const flags = eFlags[i];
    if (facilityEdge < 0 && eFacility[i] > 0 && !(flags & 32) && !isDismountEdge(i)) {
      facilityEdge = i;
    }
    if (!(flags & 64) || (flags & (4 | 32)) || isDismountEdge(i)) continue;
    if (edgeShoulder(i, true) === PROHIBITED_SHOULDER) continue;
    if (preferredEdges[i] === 1 && onRoute < 0 && !eFacility[i]) onRoute = i;
    if (preferredEdges[i] === 0 && offRoute < 0) offRoute = i;
    if (onRoute >= 0 && offRoute >= 0 && facilityEdge >= 0) break;
  }
  const price = (edge, rules) => {
    useVerdictCache(rules);
    return edgeCostParts(edge, true, 'balanced', modeWeights('balanced'),
      rules, rules, false, false, 0, false);
  };
  const onRouteOff = price(onRoute, base);
  const onRouteOn = price(onRoute, preferred);
  const defaultMult = preferredSignedRouteMult(onRoute);
  const facilityOnlyMult = facilityPrefMult(eFacility[facilityEdge]);
  const preferredFacilityMult = preferredSignedRouteMult(facilityEdge);
  const spectrum = preferredRouteSpectrum(activeWeights.preferredRoute);
  const neutralRules = withoutPreferredRouteSelection(preferred);
  const candidateBase = {
    edgeIds: [onRoute], timeS: 1000, failM: 0, dismountM: 0,
    distM: 1000, ferryM: 0, facilityM: 0, trailM: 0,
  };
  const strongCandidate = { ...candidateBase,
    _profile: { id: 'strong', preferredRouteStrength: 'strong' } };
  const moderateCandidate = { ...candidateBase, timeS: 500,
    _profile: { id: 'moderate', preferredRouteStrength: 'moderate' } };
  const anchor = bestStrongPreferredCandidate([moderateCandidate, strongCandidate]);
  const originalRoute = route;
  const spectrumCalls = [];
  route = (_points, callRules) => {
    spectrumCalls.push({
      multiplier: activeWeights.preferredRoute,
      hasPreferredSelection: callRules.preferredRoutes === ${JSON.stringify(KEY)},
    });
    return {
      ok: true, edgeIds: [onRoute], timeS: 1000, failM: 0, dismountM: 0,
      distM: 1000, ferryM: 0, facilityM: 0, trailM: 0, desigM: 1000,
      residentialM: 0, freewayM: 0, limitedAccessM: 0, mtbM: 0, hazardM: 0,
      levelM: [0, 0, 1000, 0, 0],
    };
  };
  const spectrumRaw = [];
  addPreferredRouteSpectrumCandidates(spectrumRaw, [], preferred, false, false, []);
  route = originalRoute;
  useWeights({ preferredRoute: 0.3 });
  const tunedCost = price(onRoute, preferred);
  const tunedMult = preferredSignedRouteMult(onRoute);
  useWeights(null);
  return {
    marked: preferredEdges.reduce((sum, value) => sum + value, 0),
    onRoute, offRoute, facilityEdge,
    onRouteOff,
    onRouteOn,
    onRouteStale: price(onRoute, staleKey),
    offRouteOff: price(offRoute, base),
    offRouteOn: price(offRoute, preferred),
    levelOff: edgeLevelFor(onRoute, base, true),
    levelOn: edgeLevelFor(onRoute, preferred, true),
    heuristicOff: heuristicSpeed('balanced', false, base),
    heuristicOn: heuristicSpeed('balanced', false, preferred),
    safetyKeySame: safetyRulesSignature(base) === safetyRulesSignature(preferred),
    costKeyDiffers: rulesSignature(base) !== rulesSignature(preferred),
    mult: defaultMult,
    trailMult: activeWeights.facilityPath,
    facilityOnlyMult, preferredFacilityMult,
    compoundedFacilityMult: defaultMult * facilityOnlyMult,
    tunedCost, tunedMult,
    spectrum: spectrum.map(({ strength, multiplier }) => ({ strength, multiplier })),
    neutralRules,
    spectrumCalls,
    spectrumProfiles: spectrumRaw.map((candidate) => candidate._profile.preferredRouteStrength),
    anchorId: anchor?._profile.id,
  };
})()`);

assert.ok(result.onRoute >= 0, 'a matched, ordinarily-signed edge must exist');
assert.ok(result.offRoute >= 0, 'a signed edge outside the chosen route must exist');
assert.ok(result.facilityEdge >= 0, 'the graph must contain a physical bicycle facility');
assert.ok(result.onRouteOn < result.onRouteOff,
  `a Preferred route's edge must price cheaper (${result.onRouteOff.toFixed(2)} -> ${result.onRouteOn.toFixed(2)})`);
assert.ok(result.mult < result.trailMult,
  'the Preferred price must beat the ordinary off-street trail price');
assert.equal(result.preferredFacilityMult, Math.min(result.mult, result.facilityOnlyMult),
  'a Preferred facility must use the stronger single bonus');
assert.ok(result.preferredFacilityMult > result.compoundedFacilityMult,
  'Preferred and facility bonuses must never compound');
assert.equal(result.tunedMult, 0.3,
  'the Advanced weight must directly control a Preferred road with no facility');
assert.ok(result.tunedCost > result.onRouteOn && result.tunedCost < result.onRouteOff,
  'weakening the Preferred weight must weaken, but not remove, its routing preference');
assert.equal(result.spectrum.map((entry) => entry.strength).join(','), 'strong,moderate,neutral',
  'Preferred-route portfolios must probe strong, moderate, and neutral pull');
assert.equal(result.spectrum[0].multiplier, 0.1,
  'the default strong candidate must be stronger now that alternatives coexist');
assert.ok(result.spectrum[1].multiplier > result.spectrum[0].multiplier
    && result.spectrum[1].multiplier < 1,
  'the moderate multiplier must sit between strong and neutral');
assert.equal(result.spectrum[2].multiplier, 1,
  'the neutral candidate must remove the Preferred-route multiplier');
assert.equal(result.neutralRules.preferredRoutes, undefined,
  'the neutral/direct lens must remove the scoped Preferred-route trust exception');
assert.equal(result.neutralRules.minShoulder, RULES.minShoulder,
  'neutralizing Preferred routes must preserve the rider\'s actual safety rules');
assert.equal(result.neutralRules.allowFerries, RULES.allowFerries,
  'neutralizing Preferred routes must preserve unrelated route options');
assert.equal(result.spectrumCalls.length, 3,
  'the portfolio must execute all three Preferred-route searches');
assert.equal(result.spectrumCalls[0].hasPreferredSelection, true,
  'the strong search must use the named Preferred-route exception');
assert.equal(result.spectrumCalls[1].hasPreferredSelection, true,
  'the moderate search must retain the named Preferred-route exception');
assert.equal(result.spectrumCalls[2].hasPreferredSelection, false,
  'the neutral search must genuinely remove the named-route exception, not merely use ×1');
assert.equal(result.spectrumProfiles.join(','), 'strong,moderate,neutral',
  'generated candidates must retain their Preferred-route strength metadata');
assert.equal(result.anchorId, 'strong',
  'the recommendation anchor must come from the strong lens even when an alternative is faster');
assert.equal(result.offRouteOn, result.offRouteOff,
  'a signed route the rider did NOT prefer must price exactly as before');
assert.equal(result.onRouteStale, result.onRouteOff,
  'a selection key the matcher has not seen must change nothing (startup race guard)');
assert.equal(result.levelOn, result.levelOff,
  'Preferred is a cost lens only: the safety verdict must not move');
assert.ok(result.heuristicOn > result.heuristicOff,
  'the A* bound must account for the discount while a selection is active');
assert.ok(result.safetyKeySame, 'the safety-verdict cache must be reused across the toggle');
assert.ok(result.costKeyDiffers, 'the A* cost and potential caches must separate selections');

// Clearing the selection restores the exact baseline.
const messagesBeforeClear = worker.messages.length;
worker.post({ type: 'preferred-routes', key: '', lines: [] });
assert.ok(!worker.messages.slice(messagesBeforeClear)
  .some((message) => message.type === 'preferred-routes-applied'),
'clearing must not claim to have matched anything');
const after = worker.run(`(() => {
  const base = ${JSON.stringify(RULES)};
  useVerdictCache(base);
  return { hasSet: preferredEdges !== null,
    cost: edgeCostParts(${result.onRoute}, true, 'balanced', modeWeights('balanced'),
      base, base, false, false, 0, false) };
})()`);
assert.equal(after.hasSet, false, 'clearing must drop the edge set');
assert.equal(after.cost, result.onRouteOff, 'after clearing, the baseline price returns');

// Field regression: preferring the Interurban Trail used to collapse the entire
// chooser to one 7+ mile route. The direct lens carried the Preferred trust
// exception, so even flattened weights could not escape. The real portfolio
// must retain the strong route as Suggested while also surfacing a genuinely
// neutral corridor.
//
// Re-anchored from Ravenna -> Woodland Park Zoo to Green Lake -> Shoreline.
// The original pair runs east-west across north Seattle and the trail runs
// north-south past its western end, so once the shipped overlay was rebuilt the
// corridor was no longer ON the trip: all three preference lenses returned the
// same 8,420 m route carrying zero preferred metres, collapsed to one candidate
// by the dedupe stage, and the assertion below failed on geometry rather than
// on behaviour. It took a session to tell those apart, hence the tripwire.
const interurban = routes.get('Interurban Trail');
assert.ok(interurban, 'the shipped route overlay must contain the Interurban Trail');
worker.post({ type: 'preferred-routes', key: interurban.name, lines: interurban.lines });

const FIELD_POINTS = [[-122.3400, 47.6800], [-122.3450, 47.7560]];

// TRIPWIRE. Everything below is meaningless unless the preferred corridor is
// genuinely reachable on this trip, so prove that first and say so plainly.
// A future overlay or graph rebuild that moves the trail must report "the
// fixture went stale", not "the Preferred feature broke".
const reach = worker.run(`(() => {
  const rules = { ...${JSON.stringify(RULES)}, preferredRoutes: 'Interurban Trail' };
  useWeights(null);
  const main = { ...activeWeights };
  const raw = [];
  addPreferredRouteSpectrumCandidates(raw, ${JSON.stringify(FIELD_POINTS)},
    rules, false, false, null);
  useWeights(main);
  const strong = raw.find((r) => r._profile.preferredRouteStrength === 'strong');
  return { built: raw.length, prefM: strong ? Math.round(preferredRouteMeters(strong)) : 0 };
})()`);
assert.equal(reach.built, 3, 'the preference spectrum must build all three lenses');
assert.ok(reach.prefM > 3000,
  `FIXTURE STALE, not a code failure: the strong lens put only ${reach.prefM} m of the`
  + ' Interurban Trail on this trip, so there is no Preferred behaviour here to test.'
  + ' Re-anchor FIELD_POINTS onto a trip the corridor actually serves.');

const fieldPortfolio = worker.run(`(() => {
  const rules = { ...${JSON.stringify(RULES)}, preferredRoutes: 'Interurban Trail' };
  const points = ${JSON.stringify(FIELD_POINTS)};
  useWeights(null);
  const main = { ...activeWeights };
  // A small flattening is enough to activate the direct-lens branch; its
  // neutral rules, not this exact tuning, are the behavior under test.
  const lens = { ...main, facilityPath: 0.7 };
  return routeOptions(points, rules, false, false, null, false, null,
    'interurban-diversity-regression', main, lens);
})()`);
assert.ok(fieldPortfolio.ok, 'the Interurban field regression must remain routable');
assert.ok(fieldPortfolio.options.length >= 2,
  `a Preferred route must not collapse the chooser (got ${fieldPortfolio.options.length} option)`);
const fieldRecommended = fieldPortfolio.options.find((option) => option.optimization.recommended);
assert.equal(fieldRecommended?.optimization.preferredRouteStrength, 'strong',
  'the practical strong Preferred-route candidate must remain Suggested');
assert.ok(fieldPortfolio.options.some((option) =>
  option.optimization.preferredRouteStrength === 'neutral'),
'the offered portfolio must contain a neutral escape from the Preferred corridor');

console.log(`Preferred route "${chosen.name}": ${result.marked} edges matched, `
  + `cost ${result.onRouteOff.toFixed(2)} -> ${result.onRouteOn.toFixed(2)} on its edges, `
  + `other signed routes and all verdicts untouched.`);
