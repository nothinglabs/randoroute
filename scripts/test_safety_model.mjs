#!/usr/bin/env node
// safety-model.js is the single definition of the verdict. Three callers adapt
// their storage to it and ask; the fourth -- app.js roadLevelExpr() -- cannot,
// because MapLibre evaluates it declaratively in the renderer. So this test
// evaluates that expression itself and compares it with the model across a
// combinatorial sweep of road properties and rider settings.
//
// Both of the contradictions found in the field (a sharrowed road drawn red but
// labelled "Passes your rules"; a wide-road rule that changed the map and not
// the router) were drift between two of these copies.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { SafetyModel, source } from './testlib/harness.mjs';

const app = source('app.js');

// safety-model.js is imported, not evaluated in a hand-built sandbox. Its IIFE
// ends with `}(typeof self !== 'undefined' ? self : this))`, and in a Node
// CommonJS module `this` is module.exports -- so require() has always reached
// it. See scripts/testlib/harness.mjs.
assert.ok(SafetyModel, 'safety-model.js should publish SafetyModel');

// What used to sit here was a set of assert.match calls over the text of app.js
// and router-worker.js, pinning exact function bodies and whitespace to prove
// "nobody restates a rule". They broke on renames and passed through real
// regressions. The sweep below tests the same property the only way that
// actually holds: by running both implementations and comparing verdicts.

/* ------------------------------- the map expression must match the model */
// A small MapLibre expression evaluator: only the operators roadLevelExpr uses.
function evalExpr(expr, props) {
  if (!Array.isArray(expr)) return expr;
  const [op, ...args] = expr;
  const v = (a) => evalExpr(a, props);
  switch (op) {
    case 'get': return props[args[0]] === undefined ? null : props[args[0]];
    case 'has': return props[args[0]] !== undefined && props[args[0]] !== null;
    case 'coalesce': {
      for (const a of args) { const r = v(a); if (r !== null && r !== undefined) return r; }
      return null;
    }
    case 'case': {
      for (let i = 0; i + 1 < args.length; i += 2) if (v(args[i]) === true) return v(args[i + 1]);
      return v(args[args.length - 1]);
    }
    case 'all': return args.every((a) => v(a) === true);
    case 'any': return args.some((a) => v(a) === true);
    case '!': return v(args[0]) !== true;
    case '==': return v(args[0]) === v(args[1]);
    case '!=': return v(args[0]) !== v(args[1]);
    case '<': return v(args[0]) < v(args[1]);
    case '<=': return v(args[0]) <= v(args[1]);
    case '>': return v(args[0]) > v(args[1]);
    case '>=': return v(args[0]) >= v(args[1]);
    // The edge-space inference introduced arithmetic and set membership. Without
    // these the evaluator threw, and the sweep quietly never exercised that
    // branch -- which now ships ON for The Randonneur.
    case 'max': return Math.max(...args.map((a) => Number(v(a))));
    case 'min': return Math.min(...args.map((a) => Number(v(a))));
    case '-': return args.length === 1 ? -Number(v(args[0])) : Number(v(args[0])) - Number(v(args[1]));
    case '+': return args.reduce((acc, a) => acc + Number(v(a)), 0);
    case 'literal': return args[0];
    case 'in': {
      const needle = v(args[0]);
      const hay = v(args[1]);
      return Array.isArray(hay) ? hay.includes(needle) : String(hay).includes(String(needle));
    }
    case 'match': {
      const input = v(args[0]);
      for (let i = 1; i + 1 < args.length; i += 2) {
        const label = args[i];
        const hit = Array.isArray(label) ? label.includes(input) : label === input;
        if (hit) return v(args[i + 1]);
      }
      return v(args[args.length - 1]);
    }
    default: throw new Error(`roadLevelExpr uses an operator this test cannot evaluate: ${op}`);
  }
}

// Lift roadLevelExpr out of app.js and run it against a stubbed `rules`.
const start = app.indexOf('function roadLevelExpr()');
const end = app.indexOf('\n}', app.indexOf('return [\'case\', ...cases', start)) + 2;
assert.ok(start > 0 && end > start, 'roadLevelExpr should be findable in app.js');
const exprCtx = vm.createContext({ rules: null, SafetyModel,
  MAX_LANES_NO_LIMIT: SafetyModel.MAX_LANES_NO_LIMIT });
vm.runInContext(`${app.slice(start, end)}; this.roadLevelExpr = roadLevelExpr;`, exprCtx);

// Road tiles carry: s speed, w shoulder, ln lanes, ft facility, k sidewalk,
// u urban, l limited access, b prohibited, m freeway, g designated, lts stress.
const tileToFacts = (p) => ({
  prohibited: p.b === 1, ferry: false, freeway: p.m === 1,
  infra: false, infraScore: null, facility: p.ft || 0,
  limitedAccess: p.l === 1, speed: p.s === undefined ? null : p.s,
  shoulder: p.w === undefined ? null : p.w, lanes: p.ln || 0,
  sidewalk: p.k === 1 ? 'present' : p.k === 2 ? 'absent' : null,
  urban: p.u === 1, designated: p.g === 1,
  stressRating: p.lts || null,
  adt: p.adt === undefined ? null : p.adt,
  fc: p.fc === undefined ? null : p.fc,
  // County edge space per side, the input to the shoulder guess. Omitting it
  // here made the model blind to a property the map expression reads, which
  // reported as a map/model divergence when the divergence was in this adapter.
  edgeSpace: p.es === undefined ? null : p.es,
});

const RULE_SETS = [];
// No `unknownZero` dimension: an untagged shoulder is unconditionally 0 ft now,
// so there is no second reading of it to sweep.
for (const maxLanes of [2, 4, 6]) {
  {
    for (const sidewalk of [true, false]) {
      // No `vetted` dimension: designation trust is gone, and sweeping a rule
      // key nothing reads just doubled the combination count for nothing.
      for (const cap of [{ noUpperLimit: true, upperMaxSpeed: 45 },
        { noUpperLimit: false, upperMaxSpeed: 35 }]) {
        for (const noShoulderMax of [25, 35]) for (const busy of [0, 2, 4]) {
          RULE_SETS.push({
            minShoulder: 4, lanesNoShoulderOver: maxLanes,
            allowSidewalkFallback: sidewalk, busyNoShoulder: busy,
            maxSpeedNoShoulder: noShoulderMax, ...cap,
            inferShoulderFromEdge: false,
          });
          // The same set with the shoulder guess on. It ships on for The
          // Randonneur, so leaving it out meant the shipped configuration was
          // never compared between the map and the model.
          RULE_SETS.push({
            minShoulder: 4, lanesNoShoulderOver: maxLanes,
            allowSidewalkFallback: sidewalk, busyNoShoulder: busy,
            maxSpeedNoShoulder: noShoulderMax, ...cap,
            inferShoulderFromEdge: true,
          });
        }
      }
    }
  }
}

const PROPS = [];
for (const s of [undefined, 20, 25, 30, 35, 45, 55]) {
  for (const w of [undefined, 0, 2, 4, 8]) {
    for (const ln of [0, 2, 3, 4, 5, 6]) {
      for (const ft of [0, 1, 2, 4]) {
        for (const k of [0, 1, 2]) {
          for (const u of [0, 1]) {
            // adt and fc drive the busy trigger: a count when the tile has one,
            // the functional class when it does not. Both must be swept, or the
            // map expression and the model are never compared on that path.
            for (const extra of [{}, { l: 1 }, { g: 1 }, { b: 1 }, { m: 1 },
              { lts: 4 }, { lts: 3 }, { lts: 1 }, { lts: 4, l: 1 }, { lts: 4, g: 1 },
              { adt: 200 }, { adt: 3000 }, { adt: 20000 },
              { fc: 3 }, { fc: 5 }, { fc: 7 },
              { adt: 200, fc: 3 }, { adt: 20000, fc: 7 },
              // `es` is county edge space per side, the input to the shoulder
              // guess. 0 must infer nothing; 1 is entirely eaten by the margin.
              { es: 0 }, { es: 1 }, { es: 3 }, { es: 6 }, { es: 12 },
              { es: 6, adt: 20000 }, { es: 2, fc: 3 }]) {
              const p = { u, ln, ft, k, ...extra };
              if (s !== undefined) p.s = s;
              if (w !== undefined) p.w = w;
              PROPS.push(p);
            }
          }
        }
      }
    }
  }
}

let compared = 0;
const mismatches = [];
for (const ruleSet of RULE_SETS) {
  exprCtx.rules = ruleSet;
  const expr = exprCtx.roadLevelExpr();
  for (const p of PROPS) {
    const fromMap = evalExpr(expr, p);
    const fromModel = SafetyModel.level(tileToFacts(p), ruleSet);
    compared++;
    if (fromMap !== fromModel && mismatches.length < 8) {
      mismatches.push({ props: p, rules: {
        lanesOver: ruleSet.lanesNoShoulderOver,
        minShoulder: ruleSet.minShoulder,
        maxSpeedNoShoulder: ruleSet.maxSpeedNoShoulder,
        busy: ruleSet.busyNoShoulder,
        guessShoulder: ruleSet.inferShoulderFromEdge,
        sidewalk: ruleSet.allowSidewalkFallback,
        cap: ruleSet.noUpperLimit ? 'none' : ruleSet.upperMaxSpeed,
      }, map: fromMap, model: fromModel });
    }
  }
}

assert.deepEqual(mismatches, [],
  `the map expression and the shared model must agree everywhere:\n${
    mismatches.map((m) => `  ${JSON.stringify(m)}`).join('\n')}`);

/* ------------------------------ the edge-space shoulder inference ------- */
// These three constraints used to live in test_edge_space_shoulder.mjs as
// assertions over the text of safety-model.js. They are properties of what the
// function returns, so they are tested by calling it.
const inferRules = { inferShoulderFromEdge: true, minShoulder: 4 };
const noInfer = { inferShoulderFromEdge: false, minShoulder: 4 };
const M = SafetyModel.EDGE_SPACE_MARGIN_FT;

// 1. It only fills a gap: a recorded shoulder always wins, including a zero.
assert.equal(SafetyModel.effectiveShoulder({ shoulder: 0, edgeSpace: 9 }, inferRules), 0,
  'a recorded 0 ft shoulder must beat a generous edge-space figure');
assert.equal(SafetyModel.effectiveShoulder({ shoulder: 6, edgeSpace: 20 }, inferRules), 6,
  'a recorded shoulder must win over the inference');
assert.equal(SafetyModel.shoulderWasInferred({ shoulder: 0, edgeSpace: 9 }, inferRules), false,
  'a recorded figure is never reported as inferred');

// 2. It fires only when the rider asked for it, and leaves a margin.
assert.equal(SafetyModel.effectiveShoulder({ shoulder: null, edgeSpace: 9 }, inferRules), 9 - M,
  'an untagged shoulder should infer edge space minus the margin');
assert.equal(SafetyModel.shoulderWasInferred({ shoulder: null, edgeSpace: 9 }, inferRules), true,
  'an inferred figure must be reported as inferred so the card can say so');
assert.equal(SafetyModel.effectiveShoulder({ shoulder: null, edgeSpace: 9 }, noInfer), 0,
  'with the option off, an untagged shoulder is 0 ft and nothing is inferred');

// 3. An unpositive edge space is "no usable answer", not "no shoulder" --
//    turning bad paperwork into a failing road is the bug this prevents.
for (const edgeSpace of [0, -3, null, undefined]) {
  assert.equal(SafetyModel.effectiveShoulder({ shoulder: null, edgeSpace }, inferRules), 0,
    `edgeSpace ${edgeSpace} should fall through to 0 ft rather than infer`);
  assert.equal(SafetyModel.shoulderWasInferred({ shoulder: null, edgeSpace }, inferRules), false,
    `edgeSpace ${edgeSpace} is not an inference and must not be labelled one`);
}

/* -------------------------- a sharrow is paint, not riding space -------- */
// From test_sharrow_not_infrastructure.mjs, likewise rewritten as behaviour.
// Facility 1 is a shared-lane marking; 2 and up is a bike lane or better.
assert.equal(SafetyModel.FACILITY_RIDING_SPACE, 2,
  'a sharrow (facility 1) must sit below the riding-space threshold');
const wide = { minShoulder: 4 };
assert.equal(SafetyModel.hasRidingSpace({ facility: 1 }, 0, wide), false,
  'a sharrow with no shoulder is not riding space');
assert.equal(SafetyModel.hasRidingSpace({ facility: 2 }, 0, wide), true,
  'a bike lane is riding space even with no shoulder');
assert.equal(SafetyModel.hasRidingSpace({ facility: 0 }, 6, wide), true,
  'a wide enough shoulder is riding space with no facility at all');
assert.equal(SafetyModel.hasRidingSpace({ facility: 1 }, 2, wide), false,
  'a sharrow plus too little shoulder is still not riding space');

console.log(`Safety-model tests passed (${compared.toLocaleString()} property/rule combinations, `
  + `map expression and shared model agree; edge-space inference and the `
  + `sharrow threshold checked directly).`);
