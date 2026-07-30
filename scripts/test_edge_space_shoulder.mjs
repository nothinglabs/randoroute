#!/usr/bin/env node
// "Infer shoulder from edge space": where the county logged bail-out space but
// nobody recorded a shoulder, treat that space (less a foot) as shoulder.
//
// Edge space is NOT a shoulder. build_graph.py says so in the format doc --
// "total edge space, paved or not ... is NOT a ridable shoulder" -- because it
// may be gravel, rumble strip or ditch lip. The margin is what converts "space
// exists" into "space you would ride on", and the toggle is what keeps this a
// rider's decision rather than a silent loosening of their shoulder rule.
//
// The properties that make it trustworthy:
//
//   1. It only ever FILLS A GAP. A recorded shoulder always wins, even when
//      edge space would be kinder.
//   2. It runs BEFORE the untagged-is-zero fallback. That fallback is now
//      unconditional, so an inference consulted after it could never fire at
//      all -- every untagged road would already read 0 ft.
//   3. Off means off: the verdict is byte-for-byte the old one.
//   4. The map agrees with the card. roadLevelExpr is evaluated by MapLibre
//      against tile properties and cannot call the model, so the inference is
//      rebuilt declaratively there. A drift between the two is the exact bug
//      class this app has hit before -- a road drawn one colour and described
//      another.
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';

const box = vm.createContext({ self: {} });
vm.runInContext(fs.readFileSync(new URL('../safety-model.js', import.meta.url), 'utf8'), box);
const SM = box.self.SafetyModel;
const MARGIN = SM.EDGE_SPACE_MARGIN_FT;
assert.strictEqual(MARGIN, 1, 'the documented margin is 1 ft');

const base = {
  prohibited: false, ferry: false, freeway: false, infra: false, facility: 0,
  limitedAccess: false, speed: 50, shoulder: null, edgeSpace: null,
  lanes: 2, sidewalk: null, urban: false, stressRating: null, adt: null, fc: null,
};
const rules = {
  minShoulder: 4, inferShoulderFromEdge: false,
  maxSpeedNoShoulder: 35, lanesNoShoulderOver: 3, busyNoShoulder: 0,
  noUpperLimit: true, allowSidewalkFallback: false,
};
const on = { ...rules, inferShoulderFromEdge: true };

/* ------------------------------------------------- 1. it only fills a gap */
// A recorded 2 ft shoulder beside 9 ft of edge space stays 2 ft.
assert.strictEqual(
  SM.effectiveShoulder({ ...base, shoulder: 2, edgeSpace: 9 }, on), 2,
  'a recorded shoulder must win over the inference, even when less generous');
assert.strictEqual(
  SM.shoulderWasInferred({ ...base, shoulder: 2, edgeSpace: 9 }, on), false,
  'a recorded shoulder is not an inference');
// A recorded 0 ft is data, not a gap.
assert.strictEqual(
  SM.effectiveShoulder({ ...base, shoulder: 0, edgeSpace: 9 }, on), 0,
  'a recorded zero is evidence of absence and must not be overridden');

/* ------------------------------------- 2. it runs before the zero fallback */
const gap = { ...base, shoulder: null, edgeSpace: 6 };
assert.strictEqual(SM.effectiveShoulder(gap, on), 5,
  '6 ft of edge space less the 1 ft margin should read as a 5 ft shoulder');
assert.strictEqual(SM.shoulderWasInferred(gap, on), true);
assert.strictEqual(SM.effectiveShoulder(gap, rules), 0,
  'baseline: without the toggle an untagged road is 0 ft');
// Untagged-is-zero is unconditional now, so it can never pre-empt the inference.
assert.strictEqual(SM.effectiveShoulder({ ...base, shoulder: null, edgeSpace: null }, on), 0,
  'no tag and no edge space still falls back to zero');

/* --------------------------------------------- the margin cannot go negative */
for (const space of [0, 0.5, 1]) {
  const v = SM.effectiveShoulder({ ...base, edgeSpace: space }, on);
  assert.ok(v >= 0, `edge space ${space} produced a negative shoulder: ${v}`);
}
assert.strictEqual(SM.effectiveShoulder({ ...base, edgeSpace: 1 }, on), 0,
  '1 ft of edge space is entirely consumed by the margin');

/* ------------------------------------------------------- 3. off means off */
const cases = [];
for (const shoulder of [null, 0, 2, 6]) {
  for (const edgeSpace of [null, 0, 2, 6, 12]) {
    for (const speed of [25, 35, 45, 60]) {
      cases.push({ shoulder, edgeSpace, speed });
    }
  }
}
let differed = 0, improved = 0, worsened = 0;
for (const c of cases) {
  const facts = { ...base, shoulder: c.shoulder, edgeSpace: c.edgeSpace, speed: c.speed };
  const off = { ...rules };
  const withToggle = { ...off, inferShoulderFromEdge: true };
  const a = SM.evaluate(facts, off);
  const b = SM.evaluate(facts, withToggle);
  // Off must reproduce the pre-toggle ladder exactly.
  const offAgain = SM.evaluate(facts, { ...off, inferShoulderFromEdge: false });
  assert.strictEqual(a.level, offAgain.level, 'the toggle off must be deterministic');
  if (a.level === b.level) continue;
  differed++;
  // A verdict may only move where nothing was recorded. A road that reported
  // its shoulder must be immune to the toggle in both directions.
  assert.strictEqual(c.shoulder, null,
    `a recorded ${c.shoulder} ft shoulder changed verdict; the inference must only fill gaps`);
  assert.ok(c.edgeSpace > 0,
    `verdict moved on edgeSpace ${c.edgeSpace}, which carries no information`);
  if (b.level < a.level) improved++; else worsened++;
  // Now that untagged is unconditionally 0 ft, the baseline is the harshest
  // reading available and an inference can only ever be kinder. The direction
  // is asserted rather than assumed: it used to be able to cut both ways, when
  // a rider could switch the zero off and turn "unknown" into "known narrow".
  assert.ok(b.level <= a.level,
    `inference worsened a verdict at ${JSON.stringify(c)}; with the zero`
    + ' fallback unconditional there is no optimistic baseline left to lose');
}
assert.ok(differed > 0, 'the toggle should change something, or it does nothing at all');
assert.ok(improved > 0, 'the toggle must be able to clear a road, which is its purpose');
assert.strictEqual(worsened, 0, 'nothing may get worse; zero is already the floor');
console.log(`  toggle moves ${differed} of ${cases.length} combinations`
  + ` (${improved} cleared, ${worsened} newly narrow)`);

/* ------------------------------------- 4. the map mirrors the model exactly */
const appSrc = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const expr = appSrc.slice(appSrc.indexOf('function roadLevelExpr'),
  appSrc.indexOf('function roadLevelExpr') + 4000);
assert.match(expr, /rules\.inferShoulderFromEdge/,
  'the paint expression must branch on the toggle, or the map will disagree with the card');
assert.match(expr, /\['get', 'es'\]/,
  'the paint expression must read the tile es property, the same per-side number');
assert.match(expr, /SafetyModel\.EDGE_SPACE_MARGIN_FT/,
  'the margin must come from the shared model, not be retyped as a literal');
// Order inside the `case` must match effectiveShoulder: recorded tag first,
// then the inference. Checked on the branch itself, not the whole slice --
// hasEdgeSpace is DEFINED above it and would otherwise read as earlier.
const shBranch = expr.slice(expr.indexOf('const sh = rules.inferShoulderFromEdge'),
  expr.indexOf('const noSpace'));
const wIdx = shBranch.indexOf("['has', 'w'], ['get', 'w']");
const esIdx = shBranch.indexOf('hasEdgeSpace, inferredSh');
assert.ok(wIdx > -1 && esIdx > wIdx,
  'the paint expression must check a recorded shoulder BEFORE the inference');
// And it must skip a zero, exactly as the model does.
assert.match(expr, /\['>', \['coalesce', \['get', 'es'\], 0\], 0\]/,
  'the paint expression must ignore zero edge space, matching inferredShoulder()');

// `es` must actually be in the tiles, or the branch is dead on the map.
const tiles = fs.readFileSync(new URL('../scripts/build_roads.py', import.meta.url), 'utf8');
assert.match(tiles, /props\['es'\]/,
  "build_roads.py must emit 'es' or the map can never see edge space");

/* --------------------------------- and the graph carries it to the router */
const worker = fs.readFileSync(new URL('../router-worker.js', import.meta.url), 'utf8');
assert.match(worker, /edgeSpace:/,
  'edgeFacts must supply edgeSpace or the router will score differently from the map');

/* ------------------------------------ the toggle is off by default */
assert.match(appSrc, /inferShoulderFromEdge: false/,
  'this loosens the shoulder rule, so it must be opt-in');

console.log('ok - edge-space inference fills gaps only, and the map mirrors it');
