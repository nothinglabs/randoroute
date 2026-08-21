#!/usr/bin/env node
// Switching a non-OSM route source off (Settings → Routes) must do two things
// and no more: its routes stop being drawn, and its edges stop counting as
// designated when routing. Everything else -- the graph's own flags, the safety
// verdict of every road -- stays exactly as it was.
//
// The hard part is that the graph records NO per-edge source attribution. Both
// OSM relations and the reviewed supplemental sources are stamped into the same
// designated-route bit at build time, so the worker has to re-derive which
// edges a switched-off source covers by matching the published linework back
// onto its own edges. Two things can go wrong there, and both are checked here:
//
//   1. Over-reach. Routes share pavement. Suppressing Oregon's Scenic Bikeways
//      by their linework alone takes 1,505 edges off the TransAmerica Trail
//      and 73 off the Oregon Coast Scenic Bikeway -- separate OSM relations
//      that happen to run down the same roads. That is why the worker is also
//      sent the geometry of everything still standing, and this file measures
//      the damage with that pass removed so the assertion cannot pass on a
//      worker that never had one.
//   2. Silent no-op. Matching zero edges would look identical to a clean pass.
//      Every assertion below therefore also pins that the numbers are nonzero
//      and that the same routes DO match when the source is switched back on.
//
// Run against the real graphs and the real shipped overlays, through the
// worker's own matcher and its own pricing function.
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routerWorker, appDefaultRules } from './testlib/harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The rider's real defaults, with the follow-signed-routes lens ON. That lens
// is what gives a designated edge a different price from an identical
// undesignated one, so it is the setting under which suppression is
// observable at all.
const RULES = { ...appDefaultRules(), requireSafe: false, alwaysPreferBikeRoutes: true };

/** The catalogue the app builds from a state's route overlay. */
function catalogFor(state) {
  const fc = JSON.parse(gunzipSync(readFileSync(
    join(ROOT, 'maps', state, 'bikeroutes.geojson.gz'))));
  const entries = [];
  for (const route of fc.routeCatalog || []) {
    if (!route?.name || !Array.isArray(route.lines) || !route.lines.length) continue;
    entries.push({
      name: route.name,
      sourceIds: route.sourceIds?.length ? route.sourceIds.slice() : ['osm'],
      lines: route.lines,
    });
  }
  return { sources: (fc.routeSources || []).filter((s) => s.id !== 'osm'), entries };
}

/**
 * The exact split app.js sends: geometry of routes whose EVERY source is
 * switched off, and geometry of everything still standing. Kept deliberately
 * short so it stays readable beside syncSuppressedRoutesToWorker().
 */
function splitFor(entries, offIds) {
  const lines = [], keepLines = [];
  for (const entry of entries) {
    const gone = entry.sourceIds.every((id) => offIds.includes(id));
    for (const line of entry.lines) (gone ? lines : keepLines).push(line);
  }
  return { lines, keepLines };
}

const designatedCount = (worker) => worker.run(`(() => {
  let n = 0;
  for (let i = 0; i < E; i++) if (designatedEdge(i, eFlags[i])) n++;
  return n;
})()`);
const flaggedCount = (worker) => worker.run(`(() => {
  let n = 0;
  for (let i = 0; i < E; i++) if (eFlags[i] & 64) n++;
  return n;
})()`);

/** Trust and price for one edge, under the follow-signed-routes lens. */
function probeEdge(worker, edge) {
  return worker.run(`(() => {
    const rules = ${JSON.stringify(RULES)};
    useWeights(null);
    useVerdictCache(rules);
    return {
      trusted: trustRouteEdge(${edge}, eFlags[${edge}], rules),
      designated: designatedEdge(${edge}, eFlags[${edge}]),
      cost: edgeCostParts(${edge}, true, 'balanced', modeWeights('balanced'),
        rules, rules, false, false, 0, false),
      level: edgeLevelFor(${edge}, rules, true),
    };
  })()`);
}

const suppress = (worker, key, lines, keepLines) =>
  worker.post({ type: 'suppressed-routes', key, lines, keepLines });

function checkState({ state, offId, minDualClaimed }) {
  console.log(`\n${state}: switching off "${offId}"`);
  const worker = routerWorker({ state, fresh: true });
  assert.ok(worker.ready, `the ${state} graph must load`);
  const { entries } = catalogFor(state);
  const offEntries = entries.filter((e) => e.sourceIds.includes(offId));
  assert.ok(offEntries.length,
    `${state}'s route catalogue must contain routes from "${offId}"; without them`
    + ' this whole file would pass by testing nothing');

  const flagged = flaggedCount(worker);
  const before = designatedCount(worker);
  assert.equal(before, flagged,
    'with nothing switched off, designatedEdge() must agree with the raw graph bit');
  assert.ok(before > 0, `${state} must ship a graph with designated routes stamped in it`);

  const { lines, keepLines } = splitFor(entries, [offId]);
  assert.ok(lines.length, `switching off "${offId}" must have geometry to send`);
  assert.ok(keepLines.length, 'the surviving routes must be sent too, or nothing can be rescued');

  const ack = suppress(worker, offId, lines, keepLines);
  assert.equal(ack?.type, 'suppressed-routes-applied', 'the worker must acknowledge the geometry');
  assert.equal(ack.key, offId, 'the ack must carry the selection key the rules will be signed with');
  assert.ok(ack.edges > 0,
    `matching "${offId}" marked no edges. Either the linework no longer lands on the graph`
    + ' or the source was never stamped into it -- a switch that suppresses nothing is worse'
    + ' than no switch, because the rider believes it worked.');

  const after = designatedCount(worker);
  assert.equal(before - after, ack.edges,
    'every edge the worker reports as suppressed must actually stop reading as designated');
  assert.equal(flaggedCount(worker), flagged,
    'suppression must never rewrite the graph\'s own flags -- switching the source back on'
    + ' has to restore exactly what shipped');
  console.log(`  designated ${before} -> ${after}  (${ack.edges} suppressed,`
    + ` ${offEntries.length} routes)`);

  // The overlap subtraction, measured. Sending no surviving geometry is what
  // the naive version of this feature did, and in BOTH states it masks edges
  // that another route also runs down. Washington has no route claimed by two
  // sources at all, so this is the only place its 100-odd shared edges show up.
  const naive = suppress(worker, `${offId}:naive`, lines, []);
  assert.ok(naive.edges > ack.edges,
    `without the surviving routes, suppressing "${offId}" masks ${naive.edges} edges;`
    + ` with them it masks ${ack.edges}. These being equal means the keep pass is not`
    + ' subtracting anything, and the subtraction is the whole reason it exists.');
  console.log(`  overlap subtraction rescued ${naive.edges - ack.edges} shared edges`
    + ` (${naive.edges} matched, ${ack.edges} kept suppressed)`);
  suppress(worker, offId, lines, keepLines);

  // One suppressed edge, priced with the source off and then on. A predicate
  // nobody reads is not a feature: the cost has to move.
  const edge = worker.run(`(() => {
    for (let i = 0; i < E; i++) {
      if (suppressedRouteEdges[i] !== 1) continue;
      if ((eFlags[i] & (4 | 32)) || isDismountEdge(i) || eFacility[i]) continue;
      if (edgeShoulder(i, true) === PROHIBITED_SHOULDER) continue;
      return i;
    }
    return -1;
  })()`);
  assert.ok(edge >= 0,
    'no suppressed edge is an ordinary road, so nothing here can show a price change');

  const off = probeEdge(worker, edge);
  suppress(worker, '', [], []);
  assert.equal(designatedCount(worker), before,
    'switching the source back on must restore every designation exactly');
  const on = probeEdge(worker, edge);

  assert.equal(on.designated, true, 'the probe edge is designated with the source on');
  assert.equal(off.designated, false, 'and is not, with the source off');
  assert.equal(on.trusted, true,
    'with the source on and the follow-signed-routes lens set, the edge is trusted');
  assert.equal(off.trusted, false,
    'with the source off it must not be trusted -- that trust is the whole routing effect');
  assert.ok(off.cost > on.cost,
    `edge ${edge} priced ${on.cost.toFixed(2)} with the source on and ${off.cost.toFixed(2)}`
    + ' with it off. Suppression that does not change the price changes no route.');
  assert.equal(off.level, on.level,
    'the SAFETY verdict must not move. Suppression is a route-choice lens, which is why'
    + ' safetyRulesSignature() excludes it -- if the verdict changed here, that exclusion'
    + ' would be handing back stale verdicts.');
  console.log(`  edge ${edge}: cost ${on.cost.toFixed(2)} -> ${off.cost.toFixed(2)},`
    + ` verdict unchanged (level ${on.level})`);
  return { worker, entries, lines, keepLines, offId, minDualClaimed };
}

/**
 * Route by route: who loses their designation when a source is switched off,
 * and who must not.
 *
 * Read through the Preferred-route matcher, because that matcher accepts only
 * edges designatedEdge() still accepts -- so "how many edges does this route
 * match" is a direct read of whether the route is still designated.
 *
 * Three groups, and the interesting one is the third:
 *
 *   dual   -- claimed by both OSM and the switched-off source. app.js never
 *             sends their geometry to be suppressed, so they are protected
 *             before the worker sees them.
 *   sole   -- claimed only by the switched-off source. These are what the
 *             switch is FOR, and they must fall to (nearly) nothing.
 *   osm    -- nothing to do with the switched-off source at all, and precisely
 *             the routes the naive version of this quietly damaged: an OSM
 *             relation that happens to run down a bikeway's pavement.
 */
function checkPerRoute({ worker, entries, lines, keepLines, offId, minDualClaimed }) {
  const match = (entry) => worker.post({
    type: 'preferred-routes', key: entry.name, lines: entry.lines,
  }).edges;
  const totals = (rows) => rows.reduce((sum, row) => sum + row.edges, 0);

  // Measure with the source ON first, because that is what makes a later zero
  // mean something. A route that matches nothing even here is dropped from the
  // comparison: a few catalogue entries are short enough, or far enough from
  // any graph edge, that the matcher never claims an edge for them, and they
  // can be neither damaged nor rescued.
  suppress(worker, '', [], []);
  const groups = { dual: [], sole: [], osm: [] };
  for (const entry of entries) {
    const claimsOff = entry.sourceIds.includes(offId);
    const group = !claimsOff ? 'osm' : entry.sourceIds.length > 1 ? 'dual' : 'sole';
    const edges = match(entry);
    if (edges > 0) groups[group].push({ entry, edges });
  }
  for (const name of ['sole', 'osm']) {
    assert.ok(groups[name].length,
      `no ${name} route matches a designated edge even with "${offId}" switched on, so the`
      + ' comparisons below have nothing to compare');
  }
  assert.ok(groups.dual.length >= minDualClaimed,
    `${groups.dual.length} routes claimed by both OSM and "${offId}" match graph edges; this`
    + ` state carried at least ${minDualClaimed} when the check was written. Below that, the`
    + ' caller-side protection has nothing to act on and its assertion is a silent pass.');

  // Without the keep pass: the naive version of this feature, and the damage
  // it does. Measuring it here is what stops the assertion further down from
  // passing on a worker that never had a keep pass at all.
  suppress(worker, `${offId}:naive`, lines, []);
  for (const { entry, edges } of groups.sole) {
    const now = match(entry);
    assert.equal(now, 0,
      `"${entry.name}" comes only from "${offId}" and still matches ${now} of its ${edges}`
      + ' designated edges even with nothing rescued. The suppression pass is not matching'
      + ' the whole route, so part of a switched-off source would stay live.');
  }
  const damaged = groups.osm.map((row) => ({ ...row, now: match(row.entry) }))
    .filter((row) => row.now < row.edges);
  assert.ok(damaged.length,
    'no route unrelated to the switched-off source loses edges without the keep pass, so this'
    + ' state cannot demonstrate the over-reach the keep pass exists to prevent, and the'
    + ' assertion below would pass on a worker that had no keep pass at all');
  console.log(`  without the keep pass, ${damaged.length} unrelated route(s) lose `
    + `${damaged.reduce((sum, row) => sum + row.edges - row.now, 0)} designated edges: `
    + damaged.map((row) => row.entry.name).join(', '));

  // With it.
  suppress(worker, offId, lines, keepLines);
  for (const group of ['osm', 'dual']) {
    for (const { entry, edges } of groups[group]) {
      const now = match(entry);
      assert.equal(now, edges, group === 'osm'
        ? `"${entry.name}" has nothing to do with "${offId}", and switching "${offId}" off left`
          + ` it with ${now} of its ${edges} designated edges. Switching a supplemental source`
          + ' off must never un-designate a road some other route also runs down.'
        : `"${entry.name}" is carried by OSM as well as "${offId}", so switching "${offId}" off`
          + ` must leave it whole; it kept ${now} of ${edges} edges.`);
    }
  }
  // A sole-source route keeps whatever runs down pavement a surviving route
  // also claims -- that pavement is designated on the survivor's account, not
  // the switched-off source's. Old West Scenic Bikeway keeps nearly half its
  // edges to the TransAmerica Trail. What must not survive is the source as a
  // whole, so the bar is on the total.
  const left = groups.sole.reduce((sum, row) => sum + match(row.entry), 0);
  const was = totals(groups.sole);
  assert.ok(left < was * 0.25,
    `switching "${offId}" off left its own routes holding ${left} of ${was} designated edges.`
    + ' Individual stretches shared with a surviving route are expected to stay; the source'
    + ' surviving as a whole is not.');
  console.log(`  with it, all ${groups.osm.length} unrelated and ${groups.dual.length}`
    + ` dual-claimed routes are untouched, and the ${groups.sole.length} ${offId}-only routes`
    + ` fall to ${left}/${was} edges (pavement shared with a surviving route)`);
  worker.post({ type: 'preferred-routes', key: '', lines: [] });
  suppress(worker, '', [], []);
}

// Both shipped states, because they fail differently. Washington's four Island
// County routes have no dual claims at all; Oregon's nine dual-claimed Scenic
// Bikeways are the only place the caller-side protection is observable.
const CASES = [
  { state: 'washington', offId: 'island-county', minDualClaimed: 0 },
  { state: 'oregon', offId: 'oregon-scenic-bikeways', minDualClaimed: 5 },
];
for (const testCase of CASES) checkPerRoute(checkState(testCase));

console.log('\nswitching a route source off suppresses only what no surviving route claims');
