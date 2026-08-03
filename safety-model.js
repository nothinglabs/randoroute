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
 *   stressRating    official Level of Traffic Stress, 1-4, or null if unrated
 * }
 *
 * `stressRating` names a published standard (Mekuria/Furth LTS), never an
 * agency. Washington supplies it from WSDOT's LTS_Bicycle; another state
 * supplies it from its own DOT. This module must never learn which. See
 * "Adding another state" in docs/SAFETY-MODEL.md.
 */
(function (root) {
  'use strict';

  // Top of the lanes slider means "no limit" rather than a literal count.
  var MAX_LANES_NO_LIMIT = 6;
  // A bike lane or better is space of your own. A sharrow (1) is paint in a
  // shared travel lane and satisfies nothing.
  var FACILITY_RIDING_SPACE = 2;

  // ---- the facts contract ---------------------------------------------
  // Every caller asks the ladder the same question, so every caller must build
  // the same object. This used to be written out separately in app.js and
  // router-worker.js, and the two drifted: a scorer that forgot a field simply
  // produced `undefined`, the model read it as "unknown", and the road silently
  // got a different verdict in that view than in every other. That is how a
  // state highway came to read "nothing here demands space of its own" on the
  // card while the map drew it failing -- the card's builder never carried the
  // traffic count.
  //
  // FACT_KEYS is the whole vocabulary. factsFrom() is the only supported way to
  // build one, and it fills every key explicitly so a missing input is a
  // recorded `null` rather than an absent property.
  var FACT_KEYS = ['prohibited', 'ferry', 'freeway', 'infra', 'infraScore',
    'facility', 'limitedAccess', 'speed', 'shoulder', 'edgeSpace', 'lanes',
    'sidewalk', 'urban', 'stressRating', 'adt', 'fc'];

  function num(value) {
    return value == null || value === '' || isNaN(Number(value)) ? null : Number(value);
  }

  // `n` is a source's normalised props. Anything a source cannot supply must be
  // absent or null here; the point is that the RESULT always has every key.
  function factsFrom(n) {
    n = n || {};
    var measures = n.measures || null;
    var facility = num(n.facility);
    if (facility == null) facility = 0;
    // good_facility is a source's coarse "there is a bike facility here" flag.
    // It may only RAISE the level to the riding-space floor, never lower a
    // known one: a source that reports a separated lane (4) must not be pulled
    // down to 2 because its coarse flag happens to be set.
    if (n.good_facility && facility < FACILITY_RIDING_SPACE) facility = FACILITY_RIDING_SPACE;
    return {
      prohibited: !!n.prohibited,
      ferry: !!n.ferry,
      freeway: !!n.freeway,
      infra: !!n.infra,
      infraScore: num(n.baseScore),
      facility: facility,
      limitedAccess: !!n.limited_access,
      speed: num(n.maxspeed_num),
      shoulder: num(n.shoulder_width),
      // Per-side county edge space, the input to the shoulder guess.
      edgeSpace: measures ? num(measures.edge) : null,
      lanes: num(n.lanes) || 0,
      sidewalk: n.sidewalk || null,
      urban: !!n.urban,
      stressRating: num(n.stressRating),
      // The busy trigger reads a measured count where there is one and the
      // functional class where there is not.
      adt: measures ? num(measures.adt) : null,
      fc: measures ? num(measures.fc) : null,
    };
  }

  // Defaults for a key a builder did not set. These are not "unknown" for the
  // booleans and counts -- a road with no lane count has zero lanes, not an
  // unknowable number -- so they have to be stated rather than left to
  // `undefined`, which reads as false-y in some places and null-ish in others.
  var FACT_DEFAULTS = {
    prohibited: false, ferry: false, freeway: false, infra: false, urban: false,
    facility: 0, lanes: 0,
    infraScore: null, limitedAccess: false, speed: null, shoulder: null,
    edgeSpace: null, sidewalk: null, stressRating: null, adt: null, fc: null,
  };

  // For builders that assemble facts directly rather than from normalised props
  // -- router-worker.js reads typed arrays, so it cannot use factsFrom(). This
  // guarantees the same complete shape, and missingFactKeys() lets a test catch
  // the omission at the point it happens rather than as a mystery verdict.
  function sealFacts(facts) {
    var out = {};
    for (var i = 0; i < FACT_KEYS.length; i++) {
      var k = FACT_KEYS[i];
      out[k] = facts && facts[k] !== undefined ? facts[k] : FACT_DEFAULTS[k];
    }
    return out;
  }
  function missingFactKeys(facts) {
    var out = [];
    for (var i = 0; i < FACT_KEYS.length; i++) {
      if (!facts || facts[FACT_KEYS[i]] === undefined) out.push(FACT_KEYS[i]);
    }
    return out;
  }

  // Which facts a source is ABLE to supply. A gap here is a declared property of
  // the data, not an oversight, and test_fact_contract holds each source to it:
  // a fact listed but never populated is a broken adapter, and a fact populated
  // but not listed means this table is out of date. Either way the mismatch is
  // caught instead of surfacing as two views disagreeing about one road.
  var SOURCE_FACTS = {
    // Full OSM road network -- the only source that carries everything.
    roads: ['prohibited', 'freeway', 'facility', 'limitedAccess', 'speed',
      'shoulder', 'edgeSpace', 'lanes', 'sidewalk', 'urban', 'stressRating',
      'adt', 'fc'],
    // WSDOT state highways. No sidewalk survey, no functional class, and its
    // own AADT rather than the conflated one.
    blts: ['prohibited', 'freeway', 'facility', 'limitedAccess', 'speed',
      'shoulder', 'lanes', 'urban', 'stressRating', 'adt'],
    // OSM bike infrastructure. A facility, judged by TYPE: it carries no speed,
    // no lane count and no traffic, and the `infra` rung answers before any of
    // those would be consulted.
    osm: ['prohibited', 'infra', 'infraScore', 'facility', 'shoulder'],
    // A drawn route's segments, built from graph edges.
    routeseg: ['ferry', 'freeway', 'infra', 'infraScore', 'facility',
      'limitedAccess', 'speed', 'shoulder', 'edgeSpace', 'lanes', 'sidewalk',
      'urban', 'stressRating', 'adt', 'fc'],
    // The router, straight off the binary graph.
    edge: ['prohibited', 'ferry', 'freeway', 'infra', 'infraScore', 'facility',
      'limitedAccess', 'speed', 'shoulder', 'edgeSpace', 'lanes', 'sidewalk',
      'urban', 'stressRating', 'adt', 'fc'],
  };


  // Level of Traffic Stress at or above this is high stress. The scale is
  // 1-4 low to high; 4 is "suitable only for the strong and fearless".
  var STRESS_CAUTION_AT = 4;

  // Every rung, in order. The first that matches wins. `rule` is what the card
  // explains and what tests assert on, so these keys are part of the contract.
  var RULES = ['prohibited', 'ferry', 'freeway', 'infra', 'speed-cap',
    'needs-space', 'sidewalk-fallback', 'shares-lane', 'default'];

  // How busy a road has to be before it needs space of its own. A rider picks a
  // familiar road type, not a number: nobody has an intuition for "3,000
  // vehicles a day", but everyone knows what a neighbourhood street feels like.
  //
  // Each level carries BOTH a traffic threshold and the equivalent functional
  // class, and that is what makes the setting work everywhere. Only about half
  // the network has a traffic count; the class covers the rest. The count is a
  // measurement and wins whenever there is one, the class is the fallback, and
  // the card says which of the two decided.
  //
  // `fc` is the FHWA functional system, where SMALLER is bigger road:
  // 1 Interstate, 3 principal arterial, 5 major collector, 7 local street.
  var BUSY_LEVELS = [
    { id: 0, label: 'don\u2019t use traffic', adt: null, fc: null },
    { id: 1, label: 'a quiet lane', adt: 500, fc: 6 },
    { id: 2, label: 'a neighborhood street', adt: 2000, fc: 5 },
    { id: 3, label: 'a busy through road', adt: 6000, fc: 4 },
    { id: 4, label: 'a main highway', adt: 15000, fc: 3 },
  ];
  function busyLevel(rules) {
    var id = Number(rules.busyNoShoulder) || 0;
    return BUSY_LEVELS[id] || BUSY_LEVELS[0];
  }

  // Why a road can be amber rather than green or blue. Every entry must appear
  // in the "What makes a road caution?" help section; a test enforces it.
  var CAUTION_CAUSES = ['limited-access', 'sidewalk-fallback', 'high-stress', 'dismount'];

  // `freeMaxSpeed` is the pre-split single limit, still present in shared links
  // and in settings saved before the urban/rural split.
  // One speed, urban or rural. This was two settings, 30 in town and 35 out of
  // it, and the split asked a rider to hold an opinion about a distinction the
  // road does not make: a 35 mph lane with no shoulder is the same lane whether
  // or not a Census polygon contains it. The urban flag is still carried and
  // still shown on the card as context; it simply no longer forks this rule.
  //
  // `urbanMaxSpeedNoShoulder` and `ruralMaxSpeedNoShoulder` are read here only
  // so a rider arriving with either in saved state keeps a sensible limit
  // instead of silently dropping to the legacy fallback. Rural wins, because
  // the single default is the old rural value.
  function noShoulderMaxSpeed(facts, rules) {
    return Number(rules.maxSpeedNoShoulder)
      || Number(rules.ruralMaxSpeedNoShoulder)
      || Number(rules.urbanMaxSpeedNoShoulder)
      || Number(rules.freeMaxSpeed)
      || 35;
  }

  // Edge space is what the CRAB road log leaves over once the lanes are taken
  // out of the operational width: somewhere to go when a truck comes past. It
  // is explicitly NOT a ridable shoulder -- paved or not, it may be gravel,
  // rumble strip or ditch lip. Subtracting a foot converts "space exists" into
  // "space you would actually ride on", and is the whole reason this is a
  // rider-facing toggle rather than something applied silently.
  //
  // Already per side: build_roadlog.py halves the leftover once, at derivation,
  // so it compares directly against minShoulder without further division.
  var EDGE_SPACE_MARGIN_FT = 1;
  function inferredShoulder(facts, rules) {
    if (!rules.inferShoulderFromEdge) return null;
    if (facts.edgeSpace == null) return null;
    // Zero is not "no shoulder", it is "no usable answer". edge_space() in
    // build_roadlog.py clamps a negative result to 0, and a negative result
    // means the recorded lane widths exceed the recorded operational width --
    // a data error. Inferring a hard 0 ft from that would turn bad paperwork
    // into a failing road, so an unpositive figure falls through as unknown.
    if (!(facts.edgeSpace > 0)) return null;
    return Math.max(0, facts.edgeSpace - EDGE_SPACE_MARGIN_FT);
  }

  // An untagged shoulder counts as 0 ft, always: a fast road must PROVE it has
  // one. This used to be the `unknownShoulderZero` toggle, defaulting on. It is
  // no longer a choice -- "no data" and "no shoulder" cannot be distinguished
  // from the rider's seat, and the optimistic reading let a 55 mph road with no
  // recorded shoulder pass on an absence of evidence.
  //
  // Order is load-bearing. A real tag always wins, then the edge-space
  // inference fills a gap, and only then does the road fall back to zero. If
  // the fallback came first the inference could never fire at all.
  //
  // Slow roads never reach the shoulder rung, so this does not fail quiet
  // streets for lacking a tag.
  function effectiveShoulder(facts, rules) {
    if (facts.shoulder != null) return facts.shoulder;
    var inferred = inferredShoulder(facts, rules);
    if (inferred != null) return inferred;
    return 0;
  }
  // Did this verdict rest on an inferred figure rather than a recorded one? The
  // card has to be able to say so: a rider who sees "5 ft shoulder" needs to
  // know whether that was surveyed or derived.
  function shoulderWasInferred(facts, rules) {
    return facts.shoulder == null && inferredShoulder(facts, rules) != null;
  }

  function hasRidingSpace(facts, shoulder, rules) {
    if ((facts.facility || 0) >= FACILITY_RIDING_SPACE) return true;
    return shoulder != null && shoulder >= rules.minShoulder;
  }

  // ---- the three reasons a road needs space of its own ----------------
  // Each answers the same question differently: how much of this lane is
  // actually available to a rider. They are ORed, and `spaceReasons` reports
  // every one that applied so the card can say what it was.

  // Too fast to share.
  function speedNeedsSpace(facts, rules) {
    return facts.speed != null && facts.speed > noShoulderMaxSpeed(facts, rules);
  }

  // Too wide to share. Lanes are counted exactly as tagged -- turn lanes
  // included, no oneway adjustment. The setting reads "more lanes than X", so
  // the comparison is strictly greater; MAX_LANES_NO_LIMIT turns it off.
  function lanesNeedSpace(facts, rules) {
    var over = Number(rules.lanesNoShoulderOver) || 0;
    var lanes = Number(facts.lanes) || 0;
    if (!lanes || !over || over >= MAX_LANES_NO_LIMIT) return false;
    return lanes > over;
  }

  // Too busy to share. A traffic count decides when there is one, because it is
  // a measurement; otherwise the road's functional class stands in for it.
  function trafficNeedsSpace(facts, rules) {
    var level = busyLevel(rules);
    if (!level.id) return false;
    if (facts.adt != null) return facts.adt > level.adt;
    return facts.fc != null && facts.fc <= level.fc;
  }

  // Which of them fired, in the order a rider would say them aloud.
  function spaceReasons(facts, rules) {
    var reasons = [];
    if (speedNeedsSpace(facts, rules)) reasons.push('speed');
    if (lanesNeedSpace(facts, rules)) reasons.push('lanes');
    if (trafficNeedsSpace(facts, rules)) reasons.push(facts.adt != null ? 'traffic' : 'class');
    return reasons;
  }

  function needsSpace(facts, rules) {
    return speedNeedsSpace(facts, rules) || lanesNeedSpace(facts, rules)
      || trafficNeedsSpace(facts, rules);
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
    // Two facts about a road can turn a pass into a caution without ever
    // failing it. Neither can rescue a road that failed a rung above.
    var highStress = Number(facts.stressRating) >= STRESS_CAUTION_AT;
    // A road with a bike lane of any kind is not cautioned for traffic. The
    // lane is space the rider is entitled to, which is a different thing from a
    // shoulder, and the caution rung exists for roads whose space is not
    // theirs. Uniform for every rider: this is a statement about what a bike
    // lane IS, not a preference about how much risk to accept.
    //
    // It suppresses the stress caution ONLY. The hard rungs above are
    // untouched, so a bike lane on a road over the rider's speed ceiling still
    // fails, and it does not clear the limited-access caution, which is about
    // ramps crossing the rider's path rather than about traffic. Physically
    // separated lanes and paths never reach here -- they return at the `infra`
    // rung above.
    //
    // What it does NOT do is make the road bike network. The rating is still
    // reported in `highStress` below, and the colour logic withholds the lime
    // on that basis: the road passes, and it is not a lane we would advertise.
    var paintedLane = Number(facts.facility) >= 2;
    // A limited-access highway is the more specific statement, so it wins the
    // headline when both are true.
    var softCaution = limited ? 'limited-access'
      : (highStress && !paintedLane) ? 'high-stress' : null;
    var out = function (level, rule, caution) {
      return {
        level: level, rule: rule, shoulder: shoulder, limitedAccess: limited,
        highStress: highStress,
        caution: level === 3 ? (caution || softCaution) : null,
      };
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

    // An official stress rating is deliberately NOT a rung of its own, and can
    // only ever caution. On WSDOT's data four in five rated segments are 4, so
    // as a pass/fail it would sever ~166k edges or blanket-amber every state
    // highway. As a modifier it downgrades a road that would otherwise pass and
    // leaves every failure and every dedicated path exactly as it was.

    // An absolute ceiling: it comes before the slow-road shortcut so
    // "Never allow roads faster than" means what it says.
    if (!rules.noUpperLimit && facts.speed != null && facts.speed > rules.upperMaxSpeed) {
      return out(4, 'speed-cap');
    }
    // Before the slow-road rung: Seattle signed every arterial at 25 mph in
    // 2020, so speed alone would pass a five-lane road outright.
    //
    // No designation of any kind can excuse a road here. A signed route is a
    // recommendation by an agency, not a measurement of the road: Clallam's
    // Olympic Discovery Trail alignment runs 58.8 mi along ordinary road,
    // including US 101 at 60 mph with no shoulder. The rules below judge the
    // road, and a route drawn along it does not change what it is.
    // One rung, three triggers. Too fast, too wide, or too busy to share a
    // lane -- all of them the same question, so they give the same answer and
    // the card can name whichever applied.
    //
    // Speed and lanes used to be separate rungs, which meant a five-lane
    // arterial signed at 25 mph passed on the speed rung after the lane rung
    // had already been consulted. Merging them removes the ordering entirely.
    if (needsSpace(facts, rules)) {
      // shoulderFails, not !hasRidingSpace. With "Unknown shoulder = 0 ft"
      // turned off, an untagged shoulder is not evidence of absence, so it must
      // not fail -- and effectiveShoulder leaves it null to say so. Treating
      // null as "no space" would quietly re-impose the pessimistic reading on a
      // rider who switched it off.
      if (shoulderFails(facts, shoulder, rules)) {
        if (sidewalkFallbackApplies(facts, shoulder, rules)) {
          return out(3, 'sidewalk-fallback', 'sidewalk-fallback');
        }
        return out(4, 'needs-space');
      }
      // It needs space and it has some. Not the same as a quiet lane, so it
      // does not get the quiet lane's level.
      return out(softCaution ? 3 : 2, 'default');
    }
    // Nothing about this road demands space of its own.
    if (facts.speed != null) return out(softCaution ? 3 : 1, 'shares-lane');
    // There was an 'unknown' rung here, reachable only when a rider turned off
    // "Unknown shoulder = 0 ft". With that setting gone, effectiveShoulder()
    // never returns null and the rung could never fire. Level 0 still exists
    // for ferries and as a paint fallback; nothing in the ladder produces it.
    return out(softCaution ? 3 : 2, 'default');
  }

  function level(facts, rules) { return evaluate(facts, rules).level; }

  root.SafetyModel = {
    MAX_LANES_NO_LIMIT: MAX_LANES_NO_LIMIT,
    FACILITY_RIDING_SPACE: FACILITY_RIDING_SPACE,
    STRESS_CAUTION_AT: STRESS_CAUTION_AT,
    RULES: RULES,
    CAUTION_CAUSES: CAUTION_CAUSES,
    evaluate: evaluate,
    level: level,
    hasRidingSpace: hasRidingSpace,
    BUSY_LEVELS: BUSY_LEVELS,
    busyLevel: busyLevel,
    needsSpace: needsSpace,
    spaceReasons: spaceReasons,
    speedNeedsSpace: speedNeedsSpace,
    lanesNeedSpace: lanesNeedSpace,
    trafficNeedsSpace: trafficNeedsSpace,
    sidewalkFallbackApplies: sidewalkFallbackApplies,
    noShoulderMaxSpeed: noShoulderMaxSpeed,
    FACT_KEYS: FACT_KEYS,
    SOURCE_FACTS: SOURCE_FACTS,
    factsFrom: factsFrom,
    sealFacts: sealFacts,
    missingFactKeys: missingFactKeys,
    effectiveShoulder: effectiveShoulder,
    shoulderWasInferred: shoulderWasInferred,
    EDGE_SPACE_MARGIN_FT: EDGE_SPACE_MARGIN_FT,
  };
}(typeof self !== 'undefined' ? self : this));
