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

  /* ---- one ladder, two readers ----------------------------------------
   *
   * The rungs are written ONCE, against a tiny algebra, and read two ways:
   * `evaluate()` walks them over a facts object and returns the full verdict;
   * `levelExpr()` compiles the same rungs into a MapLibre expression for the
   * road tiles, which the renderer evaluates without calling any of this code.
   *
   * That second reader is the whole reason this exists. MapLibre paints from
   * declarative expressions -- it cannot call a JS function per feature -- so
   * the ladder used to be TYPED OUT A SECOND TIME, in app.js roadLevelExpr().
   * The two drifted, repeatedly, in production: a sharrowed road drawn red but
   * labelled "Passes your rules"; a wide-road rule that moved the map and not
   * the router; a bike lane on a high-stress road that the model passed and
   * the tiles cautioned; and a WSDOT-recorded facility (tile `f`, no `ft`)
   * that every card counted as riding space and the map did not. A sweep test
   * caught them AFTERWARDS, one at a time, and only where the sweep happened
   * to look. Deriving both readings from one definition is what stops them
   * being able to differ at all.
   *
   * A ladder value is `{ val, known }` -- real values for `evaluate()`,
   * MapLibre fragments for `levelExpr()`. Every threshold the ladder compares
   * against comes from `rules`, so it is always a plain JS number; only the
   * left-hand side changes shape between the two readers.
   */

  function jsValue(v) { return { val: v == null ? null : v, known: v != null }; }

  var JS_OPS = {
    value: jsValue,
    and: function (parts) {
      for (var i = 0; i < parts.length; i++) if (!parts[i]) return false;
      return true;
    },
    or: function (parts) {
      for (var i = 0; i < parts.length; i++) if (parts[i]) return true;
      return false;
    },
    not: function (a) { return !a; },
    known: function (v) { return v.known; },
    isTrue: function (v) { return !!v.val; },
    isText: function (v, text) { return v.val === text; },
    // Known-and-compares. A null never satisfies a threshold: "no recorded
    // speed" is not "under the limit", which is the distinction that keeps an
    // untagged road off the slow-road rung.
    gt: function (v, n) { return v.known && Number(v.val) > n; },
    ge: function (v, n) { return v.known && Number(v.val) >= n; },
    lt: function (v, n) { return v.known && Number(v.val) < n; },
    le: function (v, n) { return v.known && Number(v.val) <= n; },
    minusAtLeast: function (v, n, floor) {
      return jsValue(Math.max(floor, Number(v.val) - n));
    },
    // First matching pair wins, exactly as the if-chain it replaces did.
    pick: function (pairs, fallback) {
      for (var i = 0; i < pairs.length; i++) if (pairs[i][0]) return pairs[i][1];
      return fallback;
    },
    pickValue: function (pairs, fallback) {
      for (var i = 0; i < pairs.length; i++) if (pairs[i][0]) return pairs[i][1];
      return fallback;
    },
  };

  // MapLibre fragments, folded wherever an operand is already a plain boolean.
  // Folding is not cosmetic: a fact a source cannot supply arrives as a literal
  // `false`, and folding is what deletes its rung from the emitted expression
  // instead of shipping dead branches to the renderer.
  function isBool(x) { return typeof x === 'boolean'; }

  var EXPR_OPS = {
    // A literal, in the same `{ val, known }` shape a tile fact arrives in --
    // returning the bare number here compiled the shoulder fallback to `null`
    // instead of 0 ft.
    value: function (v) { return { val: v, known: v != null }; },
    and: function (parts) {
      var out = [];
      for (var i = 0; i < parts.length; i++) {
        if (parts[i] === false) return false;
        if (parts[i] !== true) out.push(parts[i]);
      }
      if (!out.length) return true;
      return out.length === 1 ? out[0] : ['all'].concat(out);
    },
    or: function (parts) {
      var out = [];
      for (var i = 0; i < parts.length; i++) {
        if (parts[i] === true) return true;
        if (parts[i] !== false) out.push(parts[i]);
      }
      if (!out.length) return false;
      return out.length === 1 ? out[0] : ['any'].concat(out);
    },
    not: function (a) { return isBool(a) ? !a : ['!', a]; },
    known: function (v) { return v.known; },
    isTrue: function (v) { return isBool(v.val) ? v.val : v.val; },
    isText: function (v, text) {
      return v.known === false ? false : ['==', v.val, text];
    },
    gt: function (v, n) { return EXPR_OPS.and([v.known, ['>', v.val, n]]); },
    ge: function (v, n) { return EXPR_OPS.and([v.known, ['>=', v.val, n]]); },
    lt: function (v, n) { return EXPR_OPS.and([v.known, ['<', v.val, n]]); },
    le: function (v, n) { return EXPR_OPS.and([v.known, ['<=', v.val, n]]); },
    minusAtLeast: function (v, n, floor) {
      return { val: ['max', floor, ['-', v.val, n]], known: true };
    },
    pick: function (pairs, fallback) {
      var cases = [];
      for (var i = 0; i < pairs.length; i++) {
        if (pairs[i][0] === false) continue;
        if (pairs[i][0] === true) return cases.length
          ? ['case'].concat(cases, [pairs[i][1]]) : pairs[i][1];
        cases.push(pairs[i][0], pairs[i][1]);
      }
      return cases.length ? ['case'].concat(cases, [fallback]) : fallback;
    },
    pickValue: function (pairs, fallback) {
      var flat = [];
      for (var i = 0; i < pairs.length; i++) flat.push([pairs[i][0], pairs[i][1].val]);
      return { val: EXPR_OPS.pick(flat, fallback.val), known: true };
    },
  };

  /* The ladder itself. `A` is one of the two op tables above; `F` is the facts,
   * each entry a `{ val, known }` in that reader's representation.
   *
   * Returns the rungs in order plus the pieces `evaluate()` needs to name what
   * it found -- so the label a card prints and the condition that produced the
   * level are the same expression, not two that have to be kept in step. */
  function buildLadder(A, F, rules) {
    // Thresholds are pure functions of the rider's settings, so they are plain
    // JS on both paths and never enter the algebra.
    var minShoulder = Number(rules.minShoulder);
    var noShoulderMax = noShoulderMaxSpeed(null, rules);
    var busy = busyLevel(rules);
    var lanesOver = Number(rules.lanesNoShoulderOver) || 0;

    var paintedLane = A.ge(F.facility, FACILITY_RIDING_SPACE);
    var highStress = A.ge(F.stressRating, STRESS_CAUTION_AT);
    var limited = A.isTrue(F.limitedAccess);
    // A bike lane is space the rider is entitled to, and the stress caution is
    // for roads whose space is not theirs. See docs/SAFETY-MODEL.md.
    var stressCaution = A.and([highStress, A.not(paintedLane)]);
    var softCaution = A.or([limited, stressCaution]);

    // effectiveShoulder(), rung for rung: a recorded tag, then the edge-space
    // inference, then zero. The order is load-bearing -- fallback first and the
    // inference could never fire.
    var shoulderPairs = [[A.known(F.shoulder), F.shoulder]];
    if (rules.inferShoulderFromEdge) {
      // `> 0`, not `known`: build_roadlog.py clamps a negative leftover to 0,
      // and a zero is a data error rather than a measured absence.
      shoulderPairs.push([A.gt(F.edgeSpace, 0),
        A.minusAtLeast(F.edgeSpace, EDGE_SPACE_MARGIN_FT, 0)]);
    }
    var shoulder = A.pickValue(shoulderPairs, A.value(0));

    // One rung, three triggers: too fast, too wide, or too busy to share.
    var tooFast = A.gt(F.speed, noShoulderMax);
    var tooWide = (!lanesOver || lanesOver >= MAX_LANES_NO_LIMIT)
      ? false : A.gt(F.lanes, lanesOver);
    // A measured count decides where there is one; otherwise the functional
    // class stands in, where a SMALLER number is a bigger road.
    var tooBusy = !busy.id ? false
      : A.or([A.gt(F.adt, busy.adt),
        A.and([A.not(A.known(F.adt)), A.le(F.fc, busy.fc)])]);
    var wantsSpace = A.or([tooFast, tooWide, tooBusy]);

    var shoulderFails = A.and([A.not(paintedLane), A.lt(shoulder, minShoulder)]);
    // The fallback answers the SHOULDER question, so it needs a known speed
    // over the limit -- not the lane or traffic trigger.
    var sidewalkFallback = !rules.allowSidewalkFallback ? false
      : A.and([A.isText(F.sidewalk, 'present'), A.not(paintedLane), tooFast,
        A.lt(shoulder, minShoulder)]);

    var cautionOr = function (plain) { return A.pick([[softCaution, 3]], plain); };
    var speedCap = rules.noUpperLimit ? false
      : A.gt(F.speed, Number(rules.upperMaxSpeed));

    return {
      shoulder: shoulder,
      limited: limited,
      highStress: highStress,
      stressCaution: stressCaution,
      rungs: [
        { rule: 'prohibited', when: A.isTrue(F.prohibited), level: 4 },
        // On the boat, road rules do not apply.
        { rule: 'ferry', when: A.isTrue(F.ferry), level: 2 },
        // Whether the router may USE one is rules.allowFreeways, which is a
        // routing permission and never a verdict.
        { rule: 'freeway', when: A.isTrue(F.freeway), level: 4 },
        // Dedicated infrastructure: its own type is the rating, so car speed
        // and shoulder rules do not apply to it.
        { rule: 'infra', when: A.isTrue(F.infra),
          level: A.pick([[A.known(F.infraScore), F.infraScore.val]], 0) },
        // Before the slow-road rung, so "Never allow roads faster than" means
        // what it says.
        { rule: 'speed-cap', when: speedCap, level: 4 },
        { rule: 'sidewalk-fallback',
          when: A.and([wantsSpace, shoulderFails, sidewalkFallback]), level: 3 },
        { rule: 'needs-space', when: A.and([wantsSpace, shoulderFails]), level: 4 },
        // Needs space and has some. Not the same as a quiet lane, so not its
        // level.
        { rule: 'default', when: wantsSpace, level: cautionOr(2) },
        // Nothing about this road demands space of its own.
        { rule: 'shares-lane', when: A.known(F.speed), level: cautionOr(1) },
        { rule: 'default', when: true, level: cautionOr(2) },
      ],
    };
  }

  // The facts as `evaluate()` sees them: real values, straight off the record.
  function jsFacts(facts) {
    var out = {};
    for (var i = 0; i < FACT_KEYS.length; i++) {
      out[FACT_KEYS[i]] = jsValue(facts[FACT_KEYS[i]]);
    }
    // `lanes` and `facility` are counts with a real zero, never unknowns.
    out.lanes = jsValue(Number(facts.lanes) || 0);
    out.facility = jsValue(Number(facts.facility) || 0);
    return out;
  }

  /* The ladder compiled for a tile source. `tileFacts` is a function the caller
   * supplies -- it knows its own tile schema -- which returns the same fact
   * record built from MapLibre fragments. A fact the source cannot answer comes
   * back a literal `false`/unknown and its rung folds away. */
  function levelExpr(rules, tileFacts) {
    var built = buildLadder(EXPR_OPS, tileFacts(EXPR_OPS), rules);
    var pairs = [];
    for (var i = 0; i < built.rungs.length; i++) {
      pairs.push([built.rungs[i].when, built.rungs[i].level]);
    }
    return EXPR_OPS.pick(pairs, 0);
  }

  /* ---- lime, once ------------------------------------------------------
   *
   * "Is this bike network?" -- the question behind the lime colour, the route
   * card's percentage and the Route Details category. It was answered in five
   * places: isBikeNetworkVerdict(), routeVisualStyle() and bikeNetworkExpr()
   * in app.js, and isBikeNetwork() in route-details.js. Three of them had the
   * separated-lane exemption and one did not, so a separated lane on a road
   * rated 4 of 4 drew LIME on the map and read "not bike network" on the tap
   * card for the same feature. Same shape of bug as the ladder, same fix.
   *
   * Lime is a recommendation, not an inventory: a painted lane on a road the
   * agency rates worst-on-scale passes the rules and draws blue. Physical
   * separation is the one credit a rating cannot take away.
   */
  var FACILITY_SEPARATED = 4;
  function bikeNetworkRule(A, F) {
    var separated = A.or([A.isTrue(F.infra), A.ge(F.facility, FACILITY_SEPARATED)]);
    var painted = A.ge(F.facility, FACILITY_RIDING_SPACE);
    var highStress = A.ge(F.stressRating, STRESS_CAUTION_AT);
    return A.or([separated, A.and([painted, A.not(highStress)])]);
  }
  function isBikeNetwork(facts) { return bikeNetworkRule(JS_OPS, jsFacts(facts)); }
  function bikeNetworkExpr(tileFacts) {
    return bikeNetworkRule(EXPR_OPS, tileFacts(EXPR_OPS));
  }

  /* Returns { level, rule, shoulder, limitedAccess }.
   *
   * `rule` names the rung that decided it, so the card's explanation is
   * generated from the same evaluation that produced the colour. They cannot
   * disagree, which is the whole point of this module. */
  function evaluate(facts, rules) {
    var built = buildLadder(JS_OPS, jsFacts(facts), rules);
    // An official stress rating is deliberately NOT a rung of its own, and can
    // only ever caution. On WSDOT's data four in five rated segments are 4, so
    // as a pass/fail it would sever ~166k edges or blanket-amber every state
    // highway. As a modifier it downgrades a road that would otherwise pass and
    // leaves every failure and every dedicated path exactly as it was.
    //
    // A limited-access highway is the more specific statement, so it wins the
    // headline when both are true. Both conditions come back from the ladder
    // rather than being restated here: the label a card prints and the
    // condition that set the level are then one expression, not two.
    var softCaution = built.limited ? 'limited-access'
      : built.stressCaution ? 'high-stress' : null;

    for (var i = 0; i < built.rungs.length; i++) {
      var rung = built.rungs[i];
      if (!rung.when) continue;
      // The sidewalk fallback is the one rung that names its own cause; every
      // other level 3 is a soft caution on an otherwise passing road.
      var caution = rung.rule === 'sidewalk-fallback' ? 'sidewalk-fallback' : softCaution;
      return {
        level: rung.level, rule: rung.rule,
        shoulder: built.shoulder.val, limitedAccess: built.limited,
        highStress: built.highStress,
        caution: rung.level === 3 ? caution : null,
      };
    }
    // Unreachable: the last rung is unconditional. Level 0 still exists for
    // ferries and as a paint fallback; nothing in the ladder produces it.
    return { level: 0, rule: 'default', shoulder: built.shoulder.val,
      limitedAccess: built.limited, highStress: built.highStress, caution: null };
  }

  function level(facts, rules) { return evaluate(facts, rules).level; }

  root.SafetyModel = {
    MAX_LANES_NO_LIMIT: MAX_LANES_NO_LIMIT,
    FACILITY_RIDING_SPACE: FACILITY_RIDING_SPACE,
    STRESS_CAUTION_AT: STRESS_CAUTION_AT,
    RULES: RULES,
    CAUTION_CAUSES: CAUTION_CAUSES,
    evaluate: evaluate,
    // The same ladder evaluate() just walked, compiled for a renderer that
    // cannot call it. See buildLadder().
    levelExpr: levelExpr,
    // Lime, for the four callers that used to each decide it themselves.
    FACILITY_SEPARATED: FACILITY_SEPARATED,
    isBikeNetwork: isBikeNetwork,
    bikeNetworkExpr: bikeNetworkExpr,
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
