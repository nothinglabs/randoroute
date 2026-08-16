#!/usr/bin/env node
// A route marked Preferred (Settings → Routes) is the alwaysPreferBikeRoutes
// lens scoped to ONE signed route: its matched edges price like the best
// off-street path while every other signed route stays ordinarily priced and
// every safety verdict stays exactly what it was. Proven against the real
// graph and the real bikeroutes overlay, through the worker's own matcher.
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
  let onRoute = -1, offRoute = -1;
  for (let i = 0; i < E; i++) {
    const flags = eFlags[i];
    if (!(flags & 64) || (flags & (4 | 32)) || isDismountEdge(i)) continue;
    if (edgeShoulder(i, true) === PROHIBITED_SHOULDER) continue;
    if (preferredEdges[i] === 1 && onRoute < 0 && !eFacility[i]) onRoute = i;
    if (preferredEdges[i] === 0 && offRoute < 0) offRoute = i;
    if (onRoute >= 0 && offRoute >= 0) break;
  }
  const price = (edge, rules) => {
    useVerdictCache(rules);
    return edgeCostParts(edge, true, 'balanced', modeWeights('balanced'),
      rules, rules, false, false, 0, false);
  };
  return {
    marked: preferredEdges.reduce((sum, value) => sum + value, 0),
    onRoute, offRoute,
    onRouteOff: price(onRoute, base),
    onRouteOn: price(onRoute, preferred),
    onRouteStale: price(onRoute, staleKey),
    offRouteOff: price(offRoute, base),
    offRouteOn: price(offRoute, preferred),
    levelOff: edgeLevelFor(onRoute, base, true),
    levelOn: edgeLevelFor(onRoute, preferred, true),
    heuristicOff: heuristicSpeed('balanced', false, base),
    heuristicOn: heuristicSpeed('balanced', false, preferred),
    safetyKeySame: safetyRulesSignature(base) === safetyRulesSignature(preferred),
    costKeyDiffers: rulesSignature(base) !== rulesSignature(preferred),
    mult: preferredSignedRouteMult(),
    trailMult: activeWeights.facilityPath,
  };
})()`);

assert.ok(result.onRoute >= 0, 'a matched, ordinarily-signed edge must exist');
assert.ok(result.offRoute >= 0, 'a signed edge outside the chosen route must exist');
assert.ok(result.onRouteOn < result.onRouteOff,
  `a Preferred route's edge must price cheaper (${result.onRouteOff.toFixed(2)} -> ${result.onRouteOn.toFixed(2)})`);
assert.ok(result.mult < result.trailMult,
  'the Preferred price must beat the ordinary off-street trail price');
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

console.log(`Preferred route "${chosen.name}": ${result.marked} edges matched, `
  + `cost ${result.onRouteOff.toFixed(2)} -> ${result.onRouteOn.toFixed(2)} on its edges, `
  + `other signed routes and all verdicts untouched.`);
