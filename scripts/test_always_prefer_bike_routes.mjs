#!/usr/bin/env node
// “Always prefer bike routes” is intentionally a ROUTING lens and never a
// safety override. Prove both halves on one real failing, signed edge: its
// route-choice price falls to path-like territory, while SafetyModel's verdict
// stays failure. Also prove the new cost lens has its own A* cache signature
// without needlessly invalidating the identical safety-verdict cache.
import assert from 'node:assert/strict';
import { routerWorker } from './testlib/harness.mjs';

const RULES = {
  minShoulder: 4, maxSpeedNoShoulder: 35, upperMaxSpeed: 45,
  noUpperLimit: true, allowFreeways: false, allowMtbTrails: false,
  requireSafe: false, allowFerries: true, allowSidewalkFallback: true,
  preferPaved: true, inferShoulderFromEdge: true,
  lanesNoShoulderOver: 4, busyNoShoulder: 2,
};

const worker = routerWorker({ fresh: true });
assert.ok(worker.ready, 'the real routing graph must load');
const result = worker.run(`(() => {
  const base = ${JSON.stringify(RULES)};
  const preferred = { ...base, alwaysPreferBikeRoutes: true };
  useWeights(null);
  useVerdictCache(base);
  let edge = -1;
  for (let i = 0; i < E; i++) {
    const flags = eFlags[i];
    if (!(flags & 64) || (flags & (4 | 32)) || isDismountEdge(i)) continue;
    if (eFacility[i] || edgeShoulder(i, true) === PROHIBITED_SHOULDER) continue;
    if (edgeLevelFor(i, base, true) !== 4) continue;
    edge = i;
    break;
  }
  if (edge < 0) return { edge };

  const price = (rules) => {
    useVerdictCache(rules);
    const cost = edgeCostParts(edge, true, 'balanced', modeWeights('balanced'),
      rules, rules, false, false, 0, false);
    return {
      cost, additive: partsSteep + partsSurf,
      level: edgeLevelFor(edge, rules, true),
      safetyKey: safetyRulesSignature(rules),
      costKey: rulesSignature(rules),
    };
  };
  const off = price(base);
  const legacy = price({ ...base });
  const on = price(preferred);
  return {
    edge, flags: eFlags[edge], facility: eFacility[edge],
    off, legacy, on,
    directModelOff: SafetyModel.level(edgeFacts(edge, true), base),
    directModelOn: SafetyModel.level(edgeFacts(edge, true), preferred),
  };
})()`);

assert.ok(result.edge >= 0,
  'the graph must contain an ordinary signed bike-route edge that fails the rider rules');
assert.equal(result.flags & 64, 64, 'the probe must use a designated bike-route edge');
assert.equal(result.facility, 0,
  'the probe must measure route designation rather than a physical bike facility');
assert.equal(result.off.level, 4, 'the signed road must fail before the preference');
assert.equal(result.on.level, 4, 'the signed road must still fail after the preference');
assert.equal(result.directModelOff, 4, 'SafetyModel must call the road failing');
assert.equal(result.directModelOn, 4,
  'the cost-only preference must not change SafetyModel or the route colour');
assert.equal(result.legacy.cost, result.off.cost,
  'old states with no setting must behave exactly like the default-off setting');
assert.ok(result.on.cost < result.off.cost * 0.2,
  `the signed route should receive a strong, trail-like cost preference (`
  + `${result.off.cost.toFixed(2)} -> ${result.on.cost.toFixed(2)})`);
assert.equal(result.off.safetyKey, result.on.safetyKey,
  'a cost-only setting must reuse the identical safety-verdict cache');
assert.notEqual(result.off.costKey, result.on.costKey,
  'the A* cost and potential caches must separate off from on');

console.log(`Bike-route preference holds on real edge ${result.edge}: routing cost `
  + `${result.off.cost.toFixed(2)} -> ${result.on.cost.toFixed(2)}, safety remains level 4.`);
