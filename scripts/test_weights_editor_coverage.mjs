#!/usr/bin/env node
// The weights editor reaches every weight, and every weight it reaches exists.
//
// Two failure modes this catches, both silent in a browser:
//
//   1. A weight defined in DEFAULT_ROUTING_WEIGHTS that no editor row exposes.
//      It still affects every route; there is just no way to see or change it.
//   2. An editor row naming a weight that does not exist. The slider renders,
//      the value goes nowhere, and moving it appears to do nothing.
//
// Both became live risks when the weights were renamed and the editor was
// regrouped from flat rows into per-cost mode triples, since the row keys are
// now ASSEMBLED (base + mode + suffix) rather than written out.
//
// Also checks that app.js and router-worker.js still agree, key for key and
// value for value. They are separate files by necessity -- one is a worker --
// and a route scored against one set and displayed against another is the kind
// of bug that shows up as "the card disagrees with the map".
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';

const appSrc = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

// Lift the editor definitions out of app.js rather than duplicating them, so
// this test cannot pass against a stale copy of the structure it is checking.
function lift(marker, endMarker) {
  const i = appSrc.indexOf(marker);
  assert.notStrictEqual(i, -1, `app.js no longer contains ${marker}`);
  // An unmatched END marker must fail too: it used to slice to -1+length,
  // which is an empty string, and the ZERO_ROUTING_WEIGHTS lift ran that way
  // silently for six releases after the set gained a new last line.
  const e = appSrc.indexOf(endMarker, i);
  assert.notStrictEqual(e, -1, `app.js no longer ends ${marker} with ${endMarker}`);
  return appSrc.slice(i, e + endMarker.length);
}
// The editor labels name the state's agencies through Region, the way every
// other rider-facing string does. Lifting the constants into a bare sandbox
// left that undefined -- the app loads region.js first, so this stub is what
// the real environment already provides.
const box = vm.createContext({ console,
  Region: { stressAgency: 'WSDOT', restrictionAgency: 'WSDOT', speedAgency: 'WSDOT' } });
vm.runInContext([
  lift('const DEFAULT_ROUTING_WEIGHTS', '\n});'),
  lift('const RENAMED_ROUTING_WEIGHTS', '\n});'),
  lift('const ROUTING_WEIGHT_BOUNDS', '\n});'),
  lift('const ZERO_ROUTING_WEIGHTS', '\'crossUncontrolledLowStressSec\']);'),
  lift('function validatedRoutingWeight', '\n}'),
  lift('function validRoutingWeights', '\n}'),
  lift('const WEIGHT_MODES', '\n];'),
  lift('const ROUTING_WEIGHT_GROUPS', '\n];'),
  lift('function weightControlsFor', '\n}'),
  lift('function editorWeightKeys', '\n}'),
  // Hand the values back out; `const` at script top level does not become a
  // property of the context object.
  'globalThis.OUT = { defaults: DEFAULT_ROUTING_WEIGHTS, renamed: RENAMED_ROUTING_WEIGHTS,'
  + ' bounds: ROUTING_WEIGHT_BOUNDS, validate: validRoutingWeights,'
  + ' editor: editorWeightKeys(), groups: ROUTING_WEIGHT_GROUPS, modes: WEIGHT_MODES,'
  + ' controlsFor: weightControlsFor };',
].join('\n'), box);
const { defaults, renamed, editor, groups, modes } = box.OUT;

assert.strictEqual(box.OUT.validate({ useMeasuredTraffic: 999 }).useMeasuredTraffic, 1,
  'app validation must clamp useMeasuredTraffic above its semantic maximum');
assert.strictEqual(box.OUT.validate({ useMeasuredTraffic: -999 }).useMeasuredTraffic, 0,
  'app validation must clamp useMeasuredTraffic below its semantic minimum');
assert.strictEqual(box.OUT.validate({ preferredRoute: 999 }).preferredRoute, 1,
  'app validation must clamp the Preferred-route multiplier above 1');
assert.strictEqual(box.OUT.validate({ preferredRoute: -999 }).preferredRoute, 0.05,
  'app validation must keep the Preferred-route multiplier positive');

/* ------------------------------------------- every weight is reachable */
const defKeys = new Set(Object.keys(defaults));
const editKeys = new Set(editor);
assert.deepStrictEqual([...defKeys].filter((k) => !editKeys.has(k)), [],
  'these weights affect routing but no editor row exposes them');
assert.deepStrictEqual([...editKeys].filter((k) => !defKeys.has(k)), [],
  'these editor rows name a weight that does not exist; the slider would do nothing');
assert.strictEqual(editor.length, editKeys.size,
  'a weight is exposed by more than one row, so the two sliders would fight');

/* ------------------------------------------ worker and app agree exactly */
const workerSrc = fs.readFileSync(new URL('../router-worker.js', import.meta.url), 'utf8');
const wbox = vm.createContext({});
const wi = workerSrc.indexOf('const DEFAULT_WEIGHTS');
vm.runInContext(workerSrc.slice(wi, workerSrc.indexOf('\n});', wi) + 4)
  + '\nglobalThis.W = DEFAULT_WEIGHTS;', wbox);
assert.deepStrictEqual(
  Object.fromEntries(Object.entries(wbox.W).sort()),
  Object.fromEntries(Object.entries(defaults).sort()),
  'router-worker.js and app.js disagree about the routing weights');

/* --------------------------------------------- the rename map is sound */
for (const [was, now] of Object.entries(renamed)) {
  assert.ok(defKeys.has(now), `rename target ${now} (from ${was}) is not a real weight`);
  assert.ok(!defKeys.has(was), `${was} was supposedly renamed but still exists`);
}
// Anything a rider could have tuned under the old scheme must have somewhere to
// land. These are the keys that actually changed spelling.
for (const was of ['directFail', 'lowFail', 'lowComfy', 'arterialPrimaryLow',
  'hazardLow3', 'speedLow', 'speedBelowLow', 'limitedLow', 'wideRoadLow',
  'stressedRoadLow', 'climbLowSecPerM', 'turnLowSec', 'measuredTraffic']) {
  assert.ok(renamed[was], `a saved custom value for ${was} would be dropped on upgrade`);
}

/* ------------------------------------------------ labels are meaningful */
const seenLabel = new Set();
for (const [title, blurb, items] of groups) {
  assert.ok(title && title.length > 3, 'every group needs a title');
  assert.ok(blurb === null || blurb.length > 20, `${title}: blurb should explain or be omitted`);
  for (const item of items) {
    assert.ok(item.label, `${title}: an entry has no label`);
    assert.ok(!seenLabel.has(item.label), `duplicate label "${item.label}"`);
    seenLabel.add(item.label);
    assert.ok(item.min < item.max, `${item.label}: empty slider range`);
    // A default outside the slider range is unreachable: the rider can never
    // get back to it by dragging, and the revert button would jump the thumb
    // off the end.
    // The keys this row ACTUALLY renders, from the app's own expander. This
    // used to filter every editor key by the item's prefix, which is not the
    // same thing: `base: 'climb'` swept up climbKneePct and climbCostAt10Pct
    // -- separate sliders with their own ranges -- and checked them against
    // the climb triple's 0-5, reporting a default of 7.84 as unreachable when
    // its own slider reaches 40.
    for (const { key } of box.OUT.controlsFor(item)) {
      if (!defKeys.has(key)) continue;
      const d = defaults[key];
      assert.ok(d >= item.min && d <= item.max,
        `${item.label}: default ${key}=${d} is outside the slider range ${item.min}-${item.max}`);
      // A default that IS an endpoint leaves the slider able to move only one
      // way, so the preference the control exists to strengthen cannot be
      // strengthened. useMeasuredTraffic is the one deliberate two-state
      // control here; everything else is a continuous preference.
      if (key === 'useMeasuredTraffic') continue;
      assert.ok(d > item.min && d < item.max,
        `${item.label}: default ${key}=${d} sits at an end of its ${item.min}-${item.max}`
        + ' range, so the slider can only move one way');
    }
  }
}

/* ---------------------------------- mode ids match what the worker builds */
// Spread into a host array: values built inside the vm carry the vm's
// Array.prototype, and deepStrictEqual compares prototypes.
const modeIds = [...modes].map(([id]) => id);
assert.deepStrictEqual(modeIds, ['Direct', 'Balanced', 'LowStress'],
  'the editor mode ids must be the weight-key suffixes the worker assembles');
// Ask modeSuffix() rather than searching the worker's text for the strings: a
// grep passes on a suffix that appears in a comment and fails on one the
// function builds, which is backwards on both counts.
const si = workerSrc.indexOf('function modeSuffix');
vm.runInContext(workerSrc.slice(si, workerSrc.indexOf('\n}', si) + 2)
  + '\nglobalThis.suffixes = ["direct", "balanced", "low"].map(modeSuffix);', wbox);
assert.deepStrictEqual([...wbox.suffixes].sort(), [...modeIds].sort(),
  'modeSuffix() and the weights editor disagree about the mode suffixes');

console.log(`ok - ${editor.length} weights, all reachable, app and worker agree`);
