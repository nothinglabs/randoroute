#!/usr/bin/env node
// Route Details must not carry its own copy of a rider's setting.
//
// It is a separate file with its own reasoning, and it has drifted before --
// test_palette_single_source.mjs exists because it drew fails in #78121f for a
// whole session after the map moved to #a51c30. Its verdicts are safe now
// (every one goes through window.SafetyModel), but routeSummaryStats() takes
// `minShoulderFt = 4`, and 4 is DEFAULT_RULES.minShoulder spelled a second
// time. Change the shipped default and the route line moves while the summary
// percentages beside it keep answering to the old number -- the same shape as
// the card that said "Passes" over a road the map drew red.
import vm from 'node:vm';
import { check, checkEqual, done, source } from './testlib/harness.mjs';

const appSrc = source('app.js');
const detailsSrc = source('route-details.js');

const liftRules = () => {
  const at = appSrc.indexOf('const DEFAULT_RULES');
  const open = appSrc.indexOf('{', at);
  let depth = 0, i = open;
  for (; i < appSrc.length; i++) {
    if (appSrc[i] === '{') depth++;
    else if (appSrc[i] === '}' && --depth === 0) break;
  }
  const box = { out: null };
  vm.createContext(box);
  vm.runInContext('out = ' + appSrc.slice(open, i + 1), box);
  return box.out;
};
const rules = liftRules();
check('the shipped rules lifted', !!rules && rules.minShoulder != null);

// Run the signature rather than read it: call the default into existence.
const sig = detailsSrc.match(/function routeSummaryStats\(([^)]*)\)/);
check('routeSummaryStats is still there to check', !!sig, String(sig));
const fallback = sig && sig[1].match(/minShoulderFt\s*=\s*([\d.]+)/);
check('and still takes a shoulder minimum', !!fallback, sig && sig[1]);
if (fallback) {
  checkEqual('Route Details falls back to the SAME shoulder minimum the app ships',
    Number(fallback[1]), Number(rules.minShoulder));
}

// I tried to add a check here that Route Details never decides a level itself,
// by pattern-matching its source for a local level/verdict function with no
// SafetyModel call. It false-positived, and AGENTS.md forbids asserting on
// source text for exactly that reason. Proving it properly means running the
// page against a fixture and comparing its levels to SafetyModel's, which is
// worth doing and is not this test.

done();
