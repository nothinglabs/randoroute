/* The one definition of the safety verdict.
 *
 * This file exists because the ladder used to be written out four times -- once
 * for tap cards, once for the map's tile expression, once for route segments,
 * and once inside the router -- and they drifted. A sharrowed road with no
 * shoulder ended up drawn red, described as failing, and labelled "Passes your
 * rules" on the same card, because the Verdict line read the router's copy and
 * the rest read the app's. A wide-road rule added to the display copy alone
 * changed what riders were told and nothing about where they were sent.
 *
 * Every caller normalises its own storage into the same `facts` object and asks
 * this module. The MapLibre expression in app.js is the one implementation that
 * cannot share this code -- the renderer evaluates it declaratively -- so it is
 * cross-checked against this module by scripts/test_safety_model.mjs.
 *
 * Loaded as a classic script by index.html and via importScripts() by the
 * router worker, so it must not use module syntax.
 *
 * facts = {
 *   prohibited      bikes are banned outright
 *   ferry           a boat, not a road
 *   freeway         a true motorway
 *   infra           dedicated bike infrastructure (path, separated lane)
 *   infraScore      that infrastructure's own rating, or null if unrated
 *   facility        0 none, 1 sharrow, 2 bike lane, 3 buffered, 4 separated, 5 path
 *   limitedAccess   a WSDOT limited-access highway that is still bike-legal
 *   speed           mph, or null if unknown
 *   shoulder        ft, or null if unknown
 *   lanes           every car lane including turn lanes, 0 if untagged
 *   sidewalk        'present' | 'absent' | null
 *   urban           inside a Census urban area
 *   designated      on a signed USBR / regional bike route
 * }
 */
(function (root) {
  'use strict';

  // Top of the lanes slider means "no limit" rather than a literal count.
  var MAX_LANES_NO_LIMIT = 6;
  // A bike lane or better is space of your own. A sharrow (1) is paint in a
  // shared travel lane and satisfies nothing.
  var FACILITY_RIDING_SPACE = 2;

  // Every rung, in order. The first that matches wins. `rule` is what the card
  // explains and what tests assert on, so these keys are part of the contract.
  var RULES = ['prohibited', 'ferry', 'freeway', 'infra', 'speed-cap', 'wide-road',
    'slow-road', 'designated', 'sidewalk-fallback', 'shoulder', 'unknown', 'default'];

  // `freeMaxSpeed` is the pre-split single limit, still present in shared links
  // and in settings saved before the urban/rural split.
  function noShoulderMaxSpeed(facts, rules) {
    var legacy = Number(rules.freeMaxSpeed) || 35;
    return facts.urban
      ? (Number(rules.urbanMaxSpeedNoShoulder) || legacy)
      : (Number(rules.ruralMaxSpeedNoShoulder) || legacy);
  }

  // The rider's pessimistic option: an untagged shoulder counts as 0 ft, so a
  // fast road must PROVE it has one. Slow roads never reach the shoulder rung.
  function effectiveShoulder(facts, rules) {
    if (facts.shoulder == null && rules.unknownShoulderZero) return 0;
    return facts.shoulder;
  }

  function hasRidingSpace(facts, shoulder, rules) {
    if ((facts.facility || 0) >= FACILITY_RIDING_SPACE) return true;
    return shoulder != null && shoulder >= rules.minShoulder;
  }

  // You cannot share a lane with traffic on a wide road. The setting is the
  // count that FAILS, not the widest road allowed. Lanes are counted exactly as
  // tagged -- turn lanes included, no oneway adjustment -- and an unknown
  // shoulder is not proof of space, so it does not exempt.
  function wideRoadNeedsSpace(facts, shoulder, rules) {
    var limit = Number(rules.maxLanesNoShoulder) || 0;
    var lanes = Number(facts.lanes) || 0;
    if (!lanes || !limit || limit >= MAX_LANES_NO_LIMIT) return false;
    return lanes >= limit && !hasRidingSpace(facts, shoulder, rules);
  }

  // A mapped sidewalk is an opt-in stand-in for a shoulder. It applies to the
  // shoulder rung only: anything that failed higher up never reaches it.
  function sidewalkFallbackApplies(facts, shoulder, rules) {
    return !!rules.allowSidewalkFallback
      && facts.sidewalk === 'present'
      && (facts.facility || 0) < FACILITY_RIDING_SPACE
      && facts.speed != null && facts.speed > noShoulderMaxSpeed(facts, rules)
      && shoulder != null && shoulder < rules.minShoulder;
  }

  function shoulderFails(facts, shoulder, rules) {
    return (facts.facility || 0) < FACILITY_RIDING_SPACE
      && shoulder != null && shoulder < rules.minShoulder;
  }

  /* Returns { level, rule, shoulder, limitedAccess }.
   *
   * `rule` names the rung that decided it, so the card's explanation is
   * generated from the same evaluation that produced the colour. They cannot
   * disagree, which is the whole point of this module. */
  function evaluate(facts, rules) {
    var limited = !!facts.limitedAccess;
    var shoulder = effectiveShoulder(facts, rules);
    var out = function (level, rule) {
      return { level: level, rule: rule, shoulder: shoulder, limitedAccess: limited };
    };

    if (facts.prohibited) return out(4, 'prohibited');
    // On the boat, road rules do not apply.
    if (facts.ferry) return out(2, 'ferry');
    // A motorway is always a failure. Whether the router may use one anyway is
    // rules.allowFreeways, which is a routing permission and never a verdict.
    if (facts.freeway) return out(4, 'freeway');
    // Dedicated infrastructure: its own type is the rating. Car speed and
    // shoulder rules do not apply to a path.
    if (facts.infra) return out(facts.infraScore == null ? 0 : facts.infraScore, 'infra');

    // WSDOT's LTS_Bicycle deliberately does NOT appear here. 79.9% of its
    // segments are rated 4, so on this dataset it is near a constant meaning
    // "state highway" -- which the speed and shoulder rungs already infer, and
    // infer more finely. It stays a routing cost and a reported fact.

    // An absolute ceiling: it comes before the slow-road and designated
    // shortcuts so "Never allow roads faster than" means what it says.
    if (!rules.noUpperLimit && facts.speed != null && facts.speed > rules.upperMaxSpeed) {
      return out(4, 'speed-cap');
    }
    // Before the slow-road rung: Seattle signed every arterial at 25 mph in
    // 2020, so speed alone would pass a five-lane road outright.
    if (wideRoadNeedsSpace(facts, shoulder, rules)) return out(4, 'wide-road');
    if (facts.speed != null && facts.speed <= noShoulderMaxSpeed(facts, rules)) {
      return out(limited ? 3 : 1, 'slow-road');
    }
    if (facts.designated && rules.vettedBikeRoutes) return out(limited ? 3 : 2, 'designated');

    if (shoulderFails(facts, shoulder, rules)) {
      if (sidewalkFallbackApplies(facts, shoulder, rules)) return out(3, 'sidewalk-fallback');
      return out(4, 'shoulder');
    }
    // Nothing known about any criterion. Only reachable when the rider has
    // turned off "Unknown shoulder = 0 ft"; with it on, an untagged shoulder is
    // data and the shoulder rung above has already decided.
    if (facts.speed == null && shoulder == null
        && (facts.facility || 0) < FACILITY_RIDING_SPACE) {
      return out(0, 'unknown');
    }
    return out(limited ? 3 : 2, 'default');
  }

  function level(facts, rules) { return evaluate(facts, rules).level; }

  root.SafetyModel = {
    MAX_LANES_NO_LIMIT: MAX_LANES_NO_LIMIT,
    FACILITY_RIDING_SPACE: FACILITY_RIDING_SPACE,
    RULES: RULES,
    evaluate: evaluate,
    level: level,
    hasRidingSpace: hasRidingSpace,
    wideRoadNeedsSpace: wideRoadNeedsSpace,
    sidewalkFallbackApplies: sidewalkFallbackApplies,
    noShoulderMaxSpeed: noShoulderMaxSpeed,
    effectiveShoulder: effectiveShoulder,
  };
}(typeof self !== 'undefined' ? self : this));
