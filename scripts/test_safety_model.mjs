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
import fs from 'node:fs';
import vm from 'node:vm';

const modelSrc = fs.readFileSync(new URL('../safety-model.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

const sandbox = { self: {} };
vm.createContext(sandbox);
vm.runInContext(modelSrc, sandbox);
const SafetyModel = sandbox.self.SafetyModel;
assert.ok(SafetyModel, 'safety-model.js should publish SafetyModel');

/* ------------------------------------------------ nobody restates a rule */
for (const [file, src] of [['app.js', app],
  ['router-worker.js', fs.readFileSync(new URL('../router-worker.js', import.meta.url), 'utf8')]]) {
  assert.doesNotMatch(src, /shoulder\s*<\s*rules\.minShoulder/,
    `${file} should ask SafetyModel rather than restate the shoulder threshold`);
  assert.doesNotMatch(src, /lanes\s*>=\s*rules\.maxLanesNoShoulder/,
    `${file} should ask SafetyModel rather than restate the lane threshold`);
}
assert.match(app, /function effectiveLevel\(n\) \{ return evaluateRoad\(n\)\.level; \}/,
  'the tap-card ladder should be a thin call into the shared model');
assert.match(app, /function fallbackRouteLevel\(s\) \{ return effectiveLevel\(scoreRouteSeg\(routeSegProps\(s\)\)\); \}/,
  'route segments should reach the shared model through the same scorer the card uses');
assert.doesNotMatch(app, /function routeSegFacts\b/,
  'a second adapter into the safety model is how the cards drifted apart before');

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
});

const RULE_SETS = [];
for (const maxLanes of [2, 4, 6]) {
  for (const unknownZero of [true, false]) {
    for (const sidewalk of [true, false]) {
      for (const vetted of [true, false]) {
        for (const cap of [{ noUpperLimit: true, upperMaxSpeed: 45 },
          { noUpperLimit: false, upperMaxSpeed: 35 }]) {
          RULE_SETS.push({
            minShoulder: 4, maxLanesNoShoulder: maxLanes, unknownShoulderZero: unknownZero,
            allowSidewalkFallback: sidewalk, vettedBikeRoutes: vetted,
            urbanMaxSpeedNoShoulder: 30, ruralMaxSpeedNoShoulder: 35, ...cap,
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
            for (const extra of [{}, { l: 1 }, { g: 1 }, { b: 1 }, { m: 1 },
              { lts: 4 }, { lts: 3 }, { lts: 1 }, { lts: 4, l: 1 }, { lts: 4, g: 1 }]) {
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
        maxLanes: ruleSet.maxLanesNoShoulder, unknownZero: ruleSet.unknownShoulderZero,
        sidewalk: ruleSet.allowSidewalkFallback, vetted: ruleSet.vettedBikeRoutes,
        cap: ruleSet.noUpperLimit ? 'none' : ruleSet.upperMaxSpeed,
      }, map: fromMap, model: fromModel });
    }
  }
}

assert.deepEqual(mismatches, [],
  `the map expression and the shared model must agree everywhere:\n${
    mismatches.map((m) => `  ${JSON.stringify(m)}`).join('\n')}`);

console.log(`Safety-model tests passed (${compared.toLocaleString()} property/rule combinations, `
  + `map expression and shared model agree).`);
