// Bitfields, category keys, grade credibility, formatters and the shared
// predicates all come from route-common.js, one home for the three consumers.
const ROUTE_DETAILS_POSITION_KEY = 'wa-bike-route-details-position-1';
// Read from palette.js, not restated. These four used to be spelled out here,
// and FAIL_COLOR sat at #78121f for a whole session after the map moved to
// #a51c30 -- so this report drew a different red from the map it describes.
// The comment that used to sit here said "Keep in step with COLORS[3] in
// app.js", which is the whole problem: a comment is not a mechanism.
const BIKE_NETWORK_COLOR = RoutePalette.bikeNetwork;
const PASS_COLOR = RoutePalette.pass;
const CAUTION_COLOR = RoutePalette.caution;
const FAIL_COLOR = RoutePalette.fail;
let routePreviewMap = null;
let routePreviewFailPulseTimer = null;
const REQUEST_PARAMS = new URLSearchParams(window.location.search);
const REQUESTED_DETAIL_TAB = REQUEST_PARAMS.get('tab');
const REQUESTED_CONCERN = REQUEST_PARAMS.get('concern');
const STEEP_UPHILL_CONCERN_PCT = 10;
const FACILITY_NAME = {
  // A sharrow is paint in a shared traffic lane; the caveat travels with the
  // name here just as it does on the main map's road card.
  1: 'sharrow (no dedicated space)', 2: 'bike lane', 3: 'buffered bike lane',
  4: 'separated bike lane', 5: 'shared-use path',
};
const ROAD_CLASS_NAME = {
  1: 'residential street', 2: 'living street', 3: 'unclassified road',
  4: 'tertiary road', 5: 'tertiary link', 6: 'secondary road',
  7: 'secondary link', 8: 'primary road', 9: 'primary link',
  10: 'trunk road', 11: 'trunk link', 12: 'motorway', 13: 'motorway link',
};
function isBikeNetwork(seg) {
  // The shared rule, off the same facts record the verdict is read from. This
  // used to be a hand-mirrored copy of app.js's version, which is how the two
  // came to disagree about a separated lane on a high-stress road.
  return window.SafetyModel.isBikeNetwork(routeSegmentFacts(seg));
}

function isOffStreetTrail(seg) {
  return Number(seg?.facility) === 5;
}

function isDesignated(seg) {
  return !!((seg.flags || 0) & FLAG_DESIGNATED);
}

function isMountainBikeTrail(seg) {
  return !!seg.mtb || !!((seg.official || 0) & OFFICIAL_MTB);
}

// A stored segment does not always carry a level: an older release wrote none,
// and level 0 means "not scored", not "fine". Trusting it printed a FREEWAY as
// "Road meets rules" on this page while the map and the route card, which re-score,
// drew it failing. Score it here the same way rather than believing the zero.
// test_route_category_agreement.mjs holds the two classifiers together.
// `details` is a const declared further down and read only at call time. The
// typeof guard is for the tests, which lift these functions out of the file and
// evaluate them where no route has been loaded at all.
function activeDetailRules() {
  return (typeof details !== 'undefined' && details && details.rules) || {};
}

function routeSegmentLevel(seg, rules = activeDetailRules()) {
  // This page is a report, not another source of truth. Re-evaluate the exact
  // segment facts under the saved rider rules every time instead of trusting a
  // cached byte written by whichever app version created the route.
  if (seg?.dismountEscalated) return 4;
  // A walked endpoint stub (the walked sidewalk escape) is a structural fact
  // from the worker, like the escalation above: the road fails on its own
  // numbers but the route walks it, which no re-evaluation here can know.
  if (seg?.walkAccess) return 3;
  const level = window.SafetyModel.evaluate(routeSegmentFacts(seg), rules).level;
  return seg?.facilityGap && level < 3 ? 3 : level;
}

// One non-ferry segment belongs to exactly one of these five map categories.
// The ordering mirrors routeVisualStyle() in app.js, including its special
// treatment for crossings and allowed mountain-bike trails.
function routeDisplayCategory(seg, rules = activeDetailRules()) {
  if (!seg || ((seg.flags || 0) & FLAG_FERRY)) return null;
  // `displayCategory` is another cached rendering byte, just like `level`.
  // Saved routes can carry one from an older build or different rider rules,
  // so accepting it here would undo routeSegmentLevel()'s fact-based verdict
  // and let this report disagree with the current map and route card.
  if (seg.crossing === 1) return 'pass';
  const level = routeSegmentLevel(seg, rules);
  if (level === 4) return 'fail';
  // Walking is a caution here too, or an older stored route would paint its
  // dismount stretches lime while the live map paints them amber.
  if (level === 3 || isMountainBikeTrail(seg) || isDismountSegment(seg)) return 'caution';
  if (isOffStreetTrail(seg)) return 'trail';
  if (isBikeNetwork(seg)) return 'bike';
  return 'pass';
}

// safety-model.js is loaded before this file, so ask it rather than keeping a
// copy of the fallback chain here. The copy was correct today and would have
// gone stale the first time that chain changed -- the card would then have
// quoted one threshold while the verdict used another.
function noShoulderMaxSpeed(seg, rules = {}) {
  return window.SafetyModel.noShoulderMaxSpeed(routeSegmentFacts(seg), rules);
}

// Rebuild the same complete facts record the map and router score. Route
// Details used to carry its own partial shoulder test here; that left old
// exemptions (sharrows, designated routes, and the removed urban/rural split)
// in concern cards after the shared safety model had moved on.
function routeSegmentFacts(seg) {
  const flags = seg?.flags || 0;
  const official = seg?.official || 0;
  const facility = Number(seg?.facility) || 0;
  const measures = seg?.measures || null;
  return window.SafetyModel.sealFacts({
    // Never true here, and deliberately so: these are segments the router
    // CHOSE, and it does not route over an edge bicycles are banned from.
    // scoreRouteSeg() in app.js holds the same invariant, and the two have to
    // agree -- reading the -128 sentinel on this side only meant the same
    // segment could fail on this page and pass on the route card.
    prohibited: false,
    ferry: !!(flags & FLAG_FERRY),
    freeway: !!(flags & FLAG_FREEWAY),
    infra: !!(flags & FLAG_INFRA) || facility >= 4,
    infraScore: 1,
    facility,
    limitedAccess: !!(flags & FLAG_LIMITED_ACCESS),
    speed: flags & FLAG_FERRY ? null : Number(seg?.mph) || null,
    shoulder: Number(seg?.sh) >= 0 ? Number(seg.sh) : null,
    edgeSpace: measures?.edge ?? null,
    lanes: Number(seg?.lanes) || 0,
    sidewalk: official & OFFICIAL_SIDEWALK ? 'present'
      : official & OFFICIAL_SIDEWALK_NO ? 'absent' : null,
    urban: !!(official & OFFICIAL_URBAN),
    stressRating: Number(seg?.lts) || null,
    adt: measures?.adt ?? null,
    fc: measures?.fc ?? null,
  });
}

function isSidewalkFallbackSegment(seg, rules = {}) {
  const facts = routeSegmentFacts(seg);
  return window.SafetyModel.sidewalkFallbackApplies(
    facts, window.SafetyModel.effectiveShoulder(facts, rules), rules);
}

// Re-evaluate the cause from the same facts as the verdict. `other` is a
// deliberate last line of defence: an amber segment must never disappear from
// Concerns merely because a new cause was added elsewhere first.
function routeCautionCause(seg, rules = {}) {
  if (seg?.walkAccess) return 'dismount';
  if (seg?.facilityGap && routeSegmentLevel(seg, rules) === 3) return 'facility-gap';
  const verdict = window.SafetyModel.evaluate(routeSegmentFacts(seg), rules);
  if (verdict.level === 3 && verdict.caution) return verdict.caution;
  if (isDismountSegment(seg)) return 'dismount';
  if (isMountainBikeTrail(seg)) return 'mountain-bike';
  return routeDisplayCategory(seg, rules) === 'caution' ? 'other' : null;
}

function cautionConcernKind(seg, rules = {}) {
  if (routeDisplayCategory(seg, rules) !== 'caution') return null;
  const cause = routeCautionCause(seg, rules);
  return ['limited-access', 'sidewalk-fallback', 'high-stress', 'dismount',
    'mountain-bike', 'facility-gap']
    .includes(cause) ? cause : 'other';
}

function safetyVerdict(seg) {
  const level = routeSegmentLevel(seg);
  if (level === 4) return { label: 'Road fails rules', className: 'fail' };
  if (isSidewalkFallbackSegment(seg, details?.rules)
      || isMountainBikeTrail(seg) || level === 3) {
    return { label: 'Use caution', className: 'caution' };
  }
  if (seg.trailAll ?? isOffStreetTrail(seg)) return { label: 'Off-street trail', className: 'trail' };
  if (seg.bikeNetworkAll ?? isBikeNetwork(seg)) return { label: 'Trusted bike lane', className: 'bike' };
  return { label: 'Other road passing rules', className: 'pass' };
}

const embeddedDetails = window.self !== window.top;
if (embeddedDetails) document.body.classList.add('embedded');

document.getElementById('backToMap').addEventListener('click', () => {
  if (window.self !== window.top) {
    window.parent.postMessage({ type: 'close-route-details' }, window.location.origin);
    return;
  }
  window.location.href = 'index.html';
});

function lngLat(point) {
  if (!Array.isArray(point) || point.length < 2) return null;
  const lng = Number(point[0]), lat = Number(point[1]);
  return Number.isFinite(lng) && Number.isFinite(lat)
    && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90 ? [lng, lat] : null;
}
function itemLocation(item) {
  return lngLat(item.locationStart) || lngLat(item.locationEnd);
}
function surfaceLabel(surface) {
  const value = Number(surface);
  return Number.isInteger(value) && value >= 0 && value < SURFACE_LABEL.length
    ? SURFACE_LABEL[value] : SURFACE_LABEL[0];
}
function itemStreetViewHeading(item) {
  const start = lngLat(item.locationStart);
  const end = lngLat(item.locationEnd);
  if (!start || !end || (start[0] === end[0] && start[1] === end[1])) return null;
  const toRad = (value) => value * Math.PI / 180;
  const lat1 = toRad(start[1]), lat2 = toRad(end[1]);
  const deltaLng = toRad(end[0] - start[0]);
  const y = Math.sin(deltaLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2)
    - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function openItemStreetView(item) {
  const location = itemLocation(item);
  if (!location) return;
  const [lng, lat] = location;
  const heading = itemStreetViewHeading(item);
  if (window.self !== window.top) {
    window.parent.postMessage({ type: 'open-street-view', lat, lng, heading }, window.location.origin);
    return;
  }
  const link = document.createElement('a');
  link.href = googleStreetViewUrl(lat, lng, heading);
  link.target = '_blank';
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}
function routeSummaryStats(segs, minShoulderFt = 4) {
  const levels = [0, 0, 0, 0, 0];
  let bikeNetworkM = 0, roadM = 0, roadSpeedM = 0, unpavedM = 0, dismountM = 0, ferryM = 0;
  let inclineOver5M = 0;
  const categoryM = Object.fromEntries(ROUTE_CATEGORY_KEYS.map((key) => [key, 0]));
  let maxRoadSpeedMph = 0, roadAtOrAbove55M = 0, roadAtOrAbove45M = 0, roadAtOrAbove35M = 0;
  let highSpeedNoBikeAccommodationOrShoulderM = 0;
  minShoulderFt = Number.isFinite(Number(minShoulderFt))
    ? Math.max(2, Number(minShoulderFt)) : 4;
  for (const seg of segs || []) {
    const flags = seg.flags || 0;
    const len = Number(seg.lenM) || 0;
    if (flags & FLAG_FERRY) { ferryM += len; continue; }
    // routeSegmentLevel, not the raw stored byte: a stored zero is "not
    // scored", and this file's own rule is to rescore it, not trust it.
    const level = routeSegmentLevel(seg);
    if (level >= 1 && level <= 4) levels[level] += len;
    if (isConfirmedUnpavedSurface(seg.surface)) unpavedM += len;
    if (credibleSegmentGradePct(seg) > 5) inclineOver5M += len;
    if (isTaggedDismountSegment(seg)) dismountM += len;
    const category = routeDisplayCategory(seg);
    if (Object.prototype.hasOwnProperty.call(categoryM, category)) categoryM[category] += len;
    if ((flags & FLAG_INFRA) || (seg.facility || 0) >= 2) bikeNetworkM += len;
    // Every road speed counts here, including roads with bike lanes. Dedicated
    // paths have no motor-vehicle speed in the graph and are not road speeds.
    const mph = Number(seg.mph);
    if (!(flags & FLAG_INFRA) && Number.isFinite(mph) && mph > 0) {
      roadM += len;
      roadSpeedM += mph * len;
      maxRoadSpeedMph = Math.max(maxRoadSpeedMph, mph);
      if (mph >= 55) roadAtOrAbove55M += len;
      if (mph >= 45) roadAtOrAbove45M += len;
      if (mph >= 35) roadAtOrAbove35M += len;
      const hasBikeAccommodation = (seg.facility || 0) >= 2;
      const shoulderFt = Number(seg.sh);
      if (mph >= 30 && !hasBikeAccommodation
          && !(Number.isFinite(shoulderFt) && shoulderFt >= minShoulderFt)) {
        highSpeedNoBikeAccommodationOrShoulderM += len;
      }
    }
  }
  return {
    levels, categoryM, bikeNetworkM, unpavedM, inclineOver5M, dismountM, ferryM,
    avgRoadSpeedMph: roadM > 0 ? Math.round(roadSpeedM / roadM) : null,
    maxRoadSpeedMph: roadM > 0 ? Math.round(maxRoadSpeedMph) : null,
    roadAtOrAbove55M, roadAtOrAbove45M, roadAtOrAbove35M,
    highSpeedNoBikeAccommodationOrShoulderM,
    minShoulderFt,
  };
}

function sustainedUphillGradeConcerns(segs, thresholdPct = STEEP_UPHILL_CONCERN_PCT) {
  const concerns = [];
  for (const sample of sustainedUphillGradeSamples(segs)) {
    if (!(sample.gradePct > thresholdPct)) continue;
    const start = segs[sample.startIndex];
    const end = segs[sample.endIndex];
    if (!start || !end) continue;
    const name = roadName(end);
    const previous = concerns[concerns.length - 1];
    if (previous && previous.name === name && previous.stateId === (end.stateId || null)
        && sample.startIndex <= previous.endIndex + 1) {
      previous.endIndex = sample.endIndex;
      previous.coordEnd = end.c1;
      previous.locationEnd = end.locationEnd;
      previous.lenM += Number(end.lenM) || 0;
      previous.maxGradePct = Math.max(previous.maxGradePct, sample.gradePct);
      previous.meta = `${previous.maxGradePct.toFixed(1)}% sustained uphill`;
      continue;
    }
    concerns.push({
      name,
      stateId: end.stateId || null,
      meta: `${sample.gradePct.toFixed(1)}% sustained uphill`,
      lenM: sample.lenM,
      startIndex: sample.startIndex,
      endIndex: sample.endIndex,
      coordStart: start.c0,
      coordEnd: end.c1,
      locationStart: start.locationStart,
      locationEnd: end.locationEnd,
      maxGradePct: sample.gradePct,
    });
  }
  return concerns;
}
function roadName(seg) { return seg.name || 'Unnamed road'; }
function segmentState(seg) { return routeStateConfig(seg?.stateId) || window.Region || null; }
function isHighway(seg) {
  const f = seg.flags || 0;
  return !(f & (FLAG_FREEWAY | FLAG_LIMITED_ACCESS | FLAG_INFRA | FLAG_FERRY))
    && (seg.mph >= 45 || stateHighwayName(seg.name, seg.stateId));
}
function failReason(seg, rules) {
  const facts = routeSegmentFacts(seg);
  const verdict = window.SafetyModel.evaluate(facts, rules);
  if (verdict.rule === 'prohibited') {
    return `${segmentState(seg)?.restrictionAgency || 'Official data / OSM'}: bicycles are prohibited`;
  }
  if (verdict.rule === 'freeway') return 'Limited-access freeway — last resort only';
  if (verdict.rule === 'speed-cap') return `Above your ${rules.upperMaxSpeed} mph maximum`;
  if (verdict.rule === 'needs-space') {
    if (window.SafetyModel.shoulderWasInferred(facts, rules))
      return `${verdict.shoulder} ft inferred shoulder — below your ${rules.minShoulder} ft minimum`;
    return seg.sh < 0 ? `No shoulder recorded — below your ${rules.minShoulder} ft minimum`
      : `${verdict.shoulder} ft shoulder — below your ${rules.minShoulder} ft minimum`;
  }
  return 'Does not meet your selected riding rules';
}

function failedRoadDetails(seg, rules) {
  const flags = seg.flags || 0;
  const safetyFacts = routeSegmentFacts(seg);
  const verdict = window.SafetyModel.evaluate(safetyFacts, rules);
  const spaceReasons = verdict.rule === 'needs-space'
    ? window.SafetyModel.spaceReasons(safetyFacts, rules) : [];
  const facts = [];
  if (seg.mph > 0) facts.push(`${seg.mph} mph`);
  if (spaceReasons.includes('speed'))
    facts.push(`Shoulder or bike lane required above ${noShoulderMaxSpeed(seg, rules)} mph`);
  if (spaceReasons.includes('lanes'))
    facts.push(`${seg.lanes} lanes — bike space required above ${rules.lanesNoShoulderOver}`);
  if (spaceReasons.includes('traffic') && seg.measures?.adt)
    facts.push(`${Number(seg.measures.adt).toLocaleString()} vehicles/day`);
  if (spaceReasons.includes('class')) facts.push('Busy-road class requires bike space');
  if (seg.sh >= 0) facts.push(`${seg.sh} ft shoulder`);
  else if (window.SafetyModel.shoulderWasInferred(safetyFacts, rules))
    facts.push(`${verdict.shoulder} ft inferred shoulder`);
  if (FACILITY_NAME[seg.facility]) facts.push(FACILITY_NAME[seg.facility]);
  if (!(flags & FLAG_FREEWAY) && (flags & FLAG_LIMITED_ACCESS)) facts.push('Limited access');
  else if (ROAD_CLASS_NAME[seg.roadClass]) facts.push(ROAD_CLASS_NAME[seg.roadClass]);
  return { meta: failReason(seg, rules), metaFacts: facts };
}

// Consecutive graph edges with the same meaning become one readable road item.
function sections(segs, include, describe) {
  const out = [];
  let previousIndex = -2;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (!include(seg)) { previousIndex = -2; continue; }
    const info = describe(seg);
    const stateId = info.stateId || seg.stateId || null;
    const key = `${stateId || ''}\u0000${info.name}\u0000${info.meta}\u0000${JSON.stringify(info.metaFacts || [])}`;
    const last = out[out.length - 1];
    const itemLenM = Number(info.lenM ?? seg.lenM) || 0;
    const locationStart = info.locationStart ?? seg.locationStart;
    const locationEnd = info.locationEnd ?? seg.locationEnd;
    if (last && previousIndex === i - 1 && last.key === key) {
      last.lenM += itemLenM;
      last.endIndex = i;
      if (info.coordEnd != null) last.coordEnd = info.coordEnd;
      if (locationEnd != null) last.locationEnd = locationEnd;
    } else out.push({ key, stateId, name: info.name, meta: info.meta, lenM: itemLenM,
      startIndex: i, endIndex: i, coordStart: info.coordStart, coordEnd: info.coordEnd,
      locationStart, locationEnd,
      surface: info.surface ?? seg.surface ?? 0,
      metaFacts: Array.isArray(info.metaFacts) ? info.metaFacts : [],
      riskScore: Number(info.riskScore) || 0,
      safetyLabel: info.safetyLabel || '', safetyClass: info.safetyClass || '' });
    previousIndex = i;
  }
  return out;
}

// Concern data is stored per graph edge, so the same named road can otherwise
// produce many nearly identical cards. Combine those cards for scanning, but
// retain the worst representative segment for Map and Street View actions.
// Unnamed roads stay separate because a long route may contain unrelated ways
// that share that fallback label.
function consolidateConcernItems(items) {
  const combined = [];
  const byName = new Map();
  for (const source of items || []) {
    const normalizedName = String(source.name || '').trim().toLocaleLowerCase();
    const canCombine = normalizedName && normalizedName !== 'unnamed road';
    const key = canCombine ? `${source.stateId || ''}\u0000${normalizedName}` : null;
    const existing = key ? byName.get(key) : null;
    if (!existing) {
      const item = { ...source, lenM: Number(source.lenM) || 0, occurrenceCount: 1 };
      combined.push(item);
      if (key) byName.set(key, item);
      continue;
    }
    const totalLenM = existing.lenM + (Number(source.lenM) || 0);
    const occurrenceCount = existing.occurrenceCount + 1;
    if ((Number(source.riskScore) || 0) > (Number(existing.riskScore) || 0)) {
      Object.assign(existing, source);
    }
    existing.lenM = totalLenM;
    existing.occurrenceCount = occurrenceCount;
  }
  return combined.sort((a, b) =>
    (Number(b.riskScore) || 0) - (Number(a.riskScore) || 0)
      || (Number(b.lenM) || 0) - (Number(a.lenM) || 0));
}

function populateSectionBody(body, items, emptyText, cls, numbered, note) {
  if (note) {
    const sectionNote = document.createElement('p');
    sectionNote.className = 'detail-note';
    sectionNote.textContent = note;
    body.appendChild(sectionNote);
  }
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = emptyText;
    body.appendChild(empty);
    return;
  }
  const list = document.createElement('ol');
  list.className = `detail-list${numbered ? ' numbered' : ''}`;
  for (const item of items) {
    const li = document.createElement('li');
    li.className = `detail-item ${cls}`;
    if (item.roadName) li.classList.add('direction-item');
    if (item.safetyClass) li.classList.add(`safety-${item.safetyClass}`);
    const content = item.startIndex == null ? li : document.createElement('button');
    if (content !== li) {
      li.classList.add('clickable');
      content.type = 'button';
      content.className = 'step-button';
      content.setAttribute('aria-label', `${item.name}, ${fmtDist(item.lenM)}${item.safetyLabel ? `, ${item.safetyLabel}` : ''}. Show on map`);
      content.addEventListener('click', () => showRouteStep(item));
    }
    const line = document.createElement('div');
    line.className = 'line';
    const name = document.createElement('span');
    name.textContent = item.name;
    if (item.safetyLabel) {
      const safety = document.createElement('span');
      safety.className = 'step-safety';
      safety.textContent = item.safetyLabel;
      name.prepend(safety);
    }
    const distance = document.createElement('span');
    distance.className = 'distance';
    distance.textContent = fmtDist(item.lenM);
    line.append(name, distance);
    const meta = document.createElement('div');
    meta.className = 'meta';
    const itemState = routeStateConfig(item.stateId);
    const statePrefix = details?.routeStateIds?.length > 1 && itemState?.name
      ? `${itemState.name} · ` : '';
    if (item.metaFacts?.length) {
      meta.classList.add('meta-structured');
      const reason = document.createElement('span');
      reason.className = 'meta-reason';
      reason.textContent = `${statePrefix}${item.meta}`;
      const facts = document.createElement('span');
      facts.className = 'meta-facts';
      for (const factText of item.metaFacts) {
        const fact = document.createElement('span');
        fact.textContent = factText;
        facts.appendChild(fact);
      }
      meta.append(reason, facts);
    } else {
      meta.textContent = `${statePrefix}${item.meta}`;
    }
    content.append(line, meta);
    if (content !== li) li.appendChild(content);
    const location = itemLocation(item);
    if (location) {
      const actionName = item.roadName || item.name;
      const actions = document.createElement('div');
      actions.className = 'segment-actions';
      const streetView = document.createElement('button');
      streetView.type = 'button';
      streetView.className = 'segment-streetview';
      const streetLine = document.createElement('span');
      streetLine.textContent = 'Street';
      const viewLine = document.createElement('span');
      viewLine.textContent = 'View';
      streetView.append(streetLine, viewLine);
      streetView.setAttribute('aria-label', `Open ${actionName} in Google Street View`);
      streetView.addEventListener('click', () => openItemStreetView(item));
      const mapButton = document.createElement('button');
      mapButton.type = 'button';
      mapButton.className = 'segment-map-button';
      const mapLabel = document.createElement('span');
      mapLabel.textContent = 'Map';
      const mapIcon = document.createElement('span');
      mapIcon.className = 'segment-map-icon';
      mapIcon.setAttribute('aria-hidden', 'true');
      mapIcon.textContent = '⌖';
      mapButton.append(mapLabel, mapIcon);
      mapButton.setAttribute('aria-label', `Show ${actionName} on the route map`);
      mapButton.addEventListener('click', () => showRouteStep(item));
      actions.append(mapButton, streetView);
      li.appendChild(actions);
    }
    list.appendChild(li);
  }
  body.appendChild(list);
}

function setConcernSectionExpanded(section, expanded) {
  const button = section?.querySelector('.concern-section-toggle');
  const body = section?.querySelector('.concern-section-body');
  if (!button || !body) return;
  button.setAttribute('aria-expanded', String(expanded));
  section.classList.toggle('expanded', expanded);
  section.classList.toggle('collapsed', !expanded);
  body.hidden = !expanded;
  if (expanded) {
    if (!body.childNodes.length) section.renderConcernBody?.();
  } else {
    // The underlying route-detail data remains available, while removing the
    // hundreds of hidden cards that made long routes expensive to keep open.
    body.replaceChildren();
  }
}

function renderSection(host, title, items, emptyText, cls = '', numbered = false, sectionId = '', note = '', collapsible = false) {
  const total = items.reduce((sum, item) => sum + item.lenM, 0);
  const section = document.createElement('section');
  section.className = `detail-section ${cls}${collapsible ? ' concern-section collapsed' : ''}`;
  if (sectionId) {
    section.id = sectionId;
  }
  const heading = document.createElement('h2');
  let toggle = null;
  if (collapsible) {
    toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'concern-section-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    const titleLabel = document.createElement('span');
    titleLabel.className = 'concern-section-title';
    titleLabel.textContent = title;
    const summaryLabel = document.createElement('span');
    summaryLabel.className = 'concern-section-summary';
    summaryLabel.textContent = `${fmtDist(total)} · ${items.length} ${items.length === 1 ? 'item' : 'items'}`;
    const chevron = document.createElement('span');
    chevron.className = 'concern-section-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '›';
    toggle.append(titleLabel, summaryLabel, chevron);
    heading.appendChild(toggle);
  } else {
    heading.append(document.createTextNode(title));
    const totalLabel = document.createElement('span');
    totalLabel.textContent = items.length ? fmtDist(total) : 'None';
    heading.appendChild(totalLabel);
  }
  section.appendChild(heading);
  const body = document.createElement('div');
  body.className = collapsible ? 'concern-section-body' : 'detail-section-body';
  section.appendChild(body);
  section.renderConcernBody = () => populateSectionBody(body, items, emptyText, cls, numbered, note);
  if (collapsible) {
    body.hidden = true;
    toggle.addEventListener('click', () =>
      setConcernSectionExpanded(section, toggle.getAttribute('aria-expanded') !== 'true'));
  } else {
    section.renderConcernBody();
  }
  host.appendChild(section);
}

function showRouteStep(step) {
  saveDetailPosition();
  const message = {
    type: 'highlight-route-step',
    startIndex: step.startIndex,
    endIndex: step.endIndex,
    name: step.name,
    coordStart: step.coordStart,
    coordEnd: step.coordEnd,
  };
  if (window.self !== window.top) {
    window.parent.postMessage(message, window.location.origin);
    return;
  }
  // Direct visits to route-details.html use the same handoff after returning
  // to the map; the app consumes this once its saved route is redrawn.
  try { sessionStorage.setItem('wa-bike-step-highlight', JSON.stringify(message)); } catch (e) { /* nonfatal */ }
  window.location.href = 'index.html';
}

function scrollToConcernSection(sectionId) {
  const section = document.getElementById(sectionId);
  if (!section) return;
  setConcernSectionExpanded(section, true);
  requestAnimationFrame(() => {
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    section.querySelector('.concern-section-toggle')?.focus({ preventScroll: true });
  });
}

function buildRouteSteps(segs, directions = []) {
  const directionBySegment = new Map((directions || [])
    .filter((direction) => Number.isInteger(direction?.segmentIndex) && direction.text)
    .map((direction) => [direction.segmentIndex, direction.text]));
  const out = [];
  for (let index = 0; index < segs.length; index++) {
    const seg = segs[index];
    if (seg.flags & FLAG_FERRY) continue;
    const segLevel = routeSegmentLevel(seg);
    const name = roadName(seg);
    const last = out[out.length - 1];
    if (last && last.endIndex === index - 1 && last.name === name
        && last.stateId === (seg.stateId || null)
        && !directionBySegment.has(index)) {
      last.lenM += seg.lenM;
      last.endIndex = index;
      last.coordEnd = seg.c1;
      last.locationEnd = seg.locationEnd;
      last.flags |= seg.flags || 0;
      last.facility = Math.max(last.facility || 0, seg.facility || 0);
      last.official |= seg.official || 0;
      last.mph = Math.max(last.mph, seg.mph || 0);
      last.level = Math.max(last.level, segLevel);
      last.bikeNetworkAll = last.bikeNetworkAll && isBikeNetwork(seg);
      last.trailAll = last.trailAll && isOffStreetTrail(seg);
      last.designatedAll = last.designatedAll && isDesignated(seg);
      last.hazard = Math.max(last.hazard || 0, seg.hazard || 0);
      last.crossingM += seg.crossing ? Number(seg.lenM) || 0 : 0;
      if (segLevel === 4) last.failM += seg.lenM;
    } else {
      out.push({
        name,
        stateId: seg.stateId || null,
        instruction: directionBySegment.get(index) || '',
        startIndex: index,
        endIndex: index,
        coordStart: seg.c0,
        coordEnd: seg.c1,
        locationStart: seg.locationStart,
        locationEnd: seg.locationEnd,
        surface: seg.surface || 0,
        lenM: seg.lenM,
        flags: seg.flags || 0,
        facility: seg.facility || 0,
        official: seg.official || 0,
        mph: seg.mph || 0,
        level: segLevel,
        bikeNetworkAll: isBikeNetwork(seg),
        trailAll: isOffStreetTrail(seg),
        designatedAll: isDesignated(seg),
        hazard: seg.hazard || 0,
        crossingM: seg.crossing ? Number(seg.lenM) || 0 : 0,
        failM: segLevel === 4 ? seg.lenM : 0,
      });
    }
  }
  // Graph geometry can insert a tiny unnamed connector at each block
  // boundary. If the same street continues immediately afterward, fold that
  // connector into the street instead of presenting a series of fake turns.
  for (let i = 1; i + 1 < out.length;) {
    const bridge = out[i];
    const previous = out[i - 1];
    const next = out[i + 1];
    const severe = bridge.flags & (FLAG_FREEWAY | FLAG_LIMITED_ACCESS | FLAG_INFRA);
    if (bridge.name === 'Unnamed road' && bridge.lenM <= 100 && !severe
        && previous.name === next.name && previous.stateId === bridge.stateId
        && bridge.stateId === next.stateId) {
      previous.lenM += bridge.lenM + next.lenM;
      previous.flags |= bridge.flags | next.flags;
      previous.endIndex = next.endIndex;
      previous.coordEnd = next.coordEnd;
      previous.locationEnd = next.locationEnd;
      previous.facility = Math.max(previous.facility || 0, bridge.facility || 0, next.facility || 0);
      previous.official |= (bridge.official || 0) | (next.official || 0);
      previous.mph = Math.max(previous.mph, bridge.mph, next.mph);
      previous.level = Math.max(previous.level, bridge.level, next.level);
      previous.bikeNetworkAll = previous.bikeNetworkAll
        && bridge.bikeNetworkAll && next.bikeNetworkAll;
      previous.trailAll = previous.trailAll && bridge.trailAll && next.trailAll;
      previous.designatedAll = previous.designatedAll
        && bridge.designatedAll && next.designatedAll;
      previous.hazard = Math.max(previous.hazard || 0, bridge.hazard || 0, next.hazard || 0);
      previous.crossingM += bridge.crossingM + next.crossingM;
      previous.failM += bridge.failM + next.failM;
      out.splice(i, 2);
    } else {
      i++;
    }
  }
  return out.map((step) => ({
    ...step,
    roadName: step.name,
    name: step.instruction || (step.name === 'Unnamed road'
      ? (step.startIndex === 0 ? 'Start' : 'Continue')
      : `${step.startIndex === 0 ? 'Start' : 'Continue'} on ${step.name}`),
    safetyLabel: safetyVerdict(step).label,
    safetyClass: safetyVerdict(step).className,
    meta: stepMeta(step),
  }));
}

function stepMeta(step) {
  const flags = step.flags || 0;
  const bits = [];
  if (step.crossingM > 0) bits.push(`${fmtDist(step.crossingM)} intersection crossing`);
  if (isMountainBikeTrail(step)) bits.push('mountain-bike trail');
  if (step.hazard) bits.push('possible limited-visibility uphill curve');
  if (step.mph) bits.push(`${step.mph} mph`);
  if (flags & FLAG_FREEWAY) bits.push('freeway');
  else if (flags & FLAG_LIMITED_ACCESS) bits.push('limited access');
  else if (FACILITY_NAME[step.facility]) bits.push(FACILITY_NAME[step.facility]);
  else if (flags & FLAG_INFRA) bits.push('bike infrastructure');
  else if (flags & FLAG_DESIGNATED) bits.push('bike route');
  else if (flags & FLAG_FACILITY) bits.push('bike facility');
  const state = segmentState(step);
  if ((step.official & 2) && state?.facilitySourceName) bits.push(state.facilitySourceName);
  if (step.official & 1) bits.push(`${state?.speedAgency || 'Transportation agency'} legal speed`);
  else if (stateHighwayName(step.name, step.stateId) || step.mph >= 45) bits.push('highway');
  if (step.failM > 0) bits.push(`includes ${fmtDist(step.failM)} that fails rules`);
  else if (flags & FLAG_LIMITED_ACCESS) bits.push('caution');
  return bits.join(' · ') || 'follow this road';
}

function loadDetails() {
  try { return JSON.parse(localStorage.getItem(ROUTE_DETAILS_KEY) || 'null'); } catch (e) { return null; }
}

function selectDetailTab(tabId) {
  document.querySelectorAll('[data-detail-tab]').forEach((tab) => {
    const selected = tab.dataset.detailTab === tabId;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  document.querySelectorAll('.detail-panel').forEach((panel) => {
    panel.hidden = panel.id !== `panel-${tabId}`;
  });
}

const NAV_PROGRESS_M = Number(new URLSearchParams(location.search).get('navProgress'));

function speedProfileSegments(segs) {
  const profile = [];
  let distanceM = 0;
  for (const seg of segs || []) {
    const lenM = Math.max(0, Number(seg?.lenM) || 0);
    const startM = distanceM;
    distanceM += lenM;
    const flags = Number(seg?.flags) || 0;
    if (!(lenM > 0) || (flags & FLAG_FERRY)) continue;
    // Dedicated paths have no legal motor-vehicle speed in the graph. Show
    // them at a readable, conservative biking speed instead of a zero line.
    const isPath = (flags & FLAG_INFRA) || Number(seg?.facility) === 5;
    const mph = isPath ? 15 : Number(seg?.mph);
    if (!Number.isFinite(mph) || mph <= 0) continue;
    profile.push({
      startM, endM: distanceM, mph,
      color: routeDisplayCategory(seg),
    });
  }
  return profile;
}

function routeSegmentAtDistance(distanceM) {
  const segs = Array.isArray(details?.segs) ? details.segs : [];
  if (!segs.length) return null;
  const targetM = Math.max(0, Number(distanceM) || 0);
  let elapsedM = 0;
  for (let index = 0; index < segs.length; index++) {
    const seg = segs[index];
    elapsedM += Math.max(0, Number(seg?.lenM) || 0);
    if (targetM <= elapsedM || index === segs.length - 1) {
      return {
        startIndex: index,
        endIndex: index,
        name: roadName(seg),
        coordStart: seg?.c0,
        coordEnd: seg?.c1,
      };
    }
  }
  return null;
}

function chartDistanceAtPointer(canvas, event, padL, padR) {
  const rect = canvas.getBoundingClientRect();
  const chartWidth = Math.max(1, rect.width - padL - padR);
  const x = Math.min(chartWidth, Math.max(0, event.clientX - rect.left - padL));
  return x / chartWidth * (Number(details?.summary?.distM) || 0);
}

function bindExpandedChartMapTap(canvas, dialog, padL, padR) {
  if (!canvas || !dialog) return;
  canvas.classList.add('chart-map-target');
  canvas.setAttribute('aria-label', 'Route chart. Tap a position to show that route segment on the map.');
  canvas.addEventListener('click', (event) => {
    const segment = routeSegmentAtDistance(chartDistanceAtPointer(canvas, event, padL, padR));
    if (!segment) return;
    dialog.close();
    showRouteStep(segment);
  });
}

function drawSpeedProfile(canvas) {
  const segments = speedProfileSegments(details?.segs);
  const distM = Number(details?.summary?.distM) || Math.max(0, ...segments.map((seg) => seg.endM));
  if (!canvas || !segments.length || !(distM > 0)) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300, h = canvas.clientHeight || 88;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const minSpeed = 10;
  const maxSpeed = Math.max(minSpeed + 10, Math.ceil(Math.max(...segments.map((seg) => seg.mph)) / 10) * 10);
  const padT = 10, padB = 18, padL = 6, padR = 6;
  const X = (distance) => padL + Math.min(1, Math.max(0, distance / distM)) * (w - padL - padR);
  const Y = (mph) => padT + (1 - Math.min(maxSpeed - minSpeed, Math.max(0, mph - minSpeed)) / (maxSpeed - minSpeed)) * (h - padT - padB);
  // Light horizontal guides make the speed scale readable without competing
  // with the lime and red route overlays.
  ctx.strokeStyle = 'rgba(120,140,155,.18)';
  ctx.fillStyle = '#71818c';
  ctx.font = '700 9px system-ui';
  ctx.textBaseline = 'middle';
  for (let mph = minSpeed; mph < maxSpeed; mph += 10) {
    const y = Y(mph);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    if (mph === minSpeed) ctx.fillText(`${mph} mph`, padL + 3, y - 5);
    else if (mph % 20 === 0) ctx.fillText(`${mph}`, padL + 3, y - 5);
  }
  const colors = {
    trail: BIKE_NETWORK_COLOR, bike: BIKE_NETWORK_COLOR, pass: PASS_COLOR,
    caution: CAUTION_COLOR, fail: FAIL_COLOR,
  };
  let previous = null;
  for (const segment of segments) {
    const y = Y(segment.mph);
    if (previous && Math.abs(previous.endM - segment.startM) < .1) {
      ctx.beginPath();
      ctx.moveTo(X(segment.startM), Y(previous.mph));
      ctx.lineTo(X(segment.startM), y);
      ctx.strokeStyle = '#b8c6cf';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(X(segment.startM), y);
    ctx.lineTo(X(segment.endM), y);
    ctx.strokeStyle = colors[segment.color];
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'butt';
    ctx.stroke();
    previous = segment;
  }
  ctx.fillStyle = '#607482';
  ctx.font = '700 9px system-ui';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${maxSpeed} mph`, padL + 2, padT - 1);
  ctx.textAlign = 'left';
}

function drawElevation(canvas, compact = false) {
  const profile = details?.profile;
  const distM = details?.summary?.distM;
  if (!canvas || !Array.isArray(profile) || profile.length < 2 || !(distM > 0)) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300, h = canvas.clientHeight || (compact ? 92 : 300);
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  let lo = Infinity, hi = -Infinity;
  for (const [, e] of profile) { if (e < lo) lo = e; if (e > hi) hi = e; }
  if (hi - lo < 30) { const mid = (hi + lo) / 2; lo = mid - 15; hi = mid + 15; }
  const padT = compact ? 15 : 24, padB = compact ? 15 : 26, padL = compact ? 4 : 8, padR = compact ? 4 : 8;
  const X = (d) => padL + (d / distM) * (w - padL - padR);
  const Y = (e) => padT + (1 - (e - lo) / (hi - lo)) * (h - padT - padB);
  ctx.beginPath();
  ctx.moveTo(X(profile[0][0]), Y(profile[0][1]));
  for (const [d, e] of profile) ctx.lineTo(X(d), Y(e));
  ctx.lineTo(X(profile[profile.length - 1][0]), h - padB);
  ctx.lineTo(X(profile[0][0]), h - padB);
  ctx.closePath();
  ctx.fillStyle = 'rgba(44,123,182,0.18)';
  ctx.fill();
  // Ridden portion shaded green — matches the app's Navigating Route view and
  // the map's darkening of the route already covered.
  if (Number.isFinite(NAV_PROGRESS_M) && NAV_PROGRESS_M > 0 && NAV_PROGRESS_M < distM) {
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, X(NAV_PROGRESS_M), h); ctx.clip();
    ctx.beginPath();
    ctx.moveTo(X(profile[0][0]), Y(profile[0][1]));
    for (const [d, e] of profile) ctx.lineTo(X(d), Y(e));
    ctx.lineTo(X(profile[profile.length - 1][0]), h - padB);
    ctx.lineTo(X(profile[0][0]), h - padB);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,121,92,0.28)';
    ctx.fill();
    ctx.restore();
  }
  ctx.beginPath();
  ctx.moveTo(X(profile[0][0]), Y(profile[0][1]));
  for (const [d, e] of profile) ctx.lineTo(X(d), Y(e));
  ctx.strokeStyle = '#2c7bb6';
  ctx.lineWidth = 1.8;
  ctx.stroke();
  // Live ride position, when navigation handed one over: see where you are
  // relative to the climbs ahead.
  if (Number.isFinite(NAV_PROGRESS_M) && NAV_PROGRESS_M > 0 && NAV_PROGRESS_M < distM) {
    const x = X(NAV_PROGRESS_M);
    ctx.beginPath();
    ctx.moveTo(x, padT - (compact ? 4 : 6));
    ctx.lineTo(x, h - padB);
    ctx.strokeStyle = '#00795c';
    ctx.lineWidth = 2.2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, padT - (compact ? 4 : 6), compact ? 2.4 : 3.4, 0, Math.PI * 2);
    ctx.fillStyle = '#00795c';
    ctx.fill();
  }
  if (compact) {
    ctx.fillStyle = '#607482';
    ctx.font = '700 9px system-ui';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`${fmtFt(hi)} ft`, padL + 2, 2);
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${fmtFt(lo)} ft`, padL + 2, h - 2);
    ctx.textAlign = 'right';
    ctx.fillText(`${(distM / 1609.34).toFixed(1)} mi`, w - padR - 2, h - 2);
    ctx.textAlign = 'left';
    return;
  }
  ctx.fillStyle = '#98a2ad';
  ctx.font = '13px system-ui';
  ctx.fillText(`${fmtFt(hi)} ft`, padL + 2, padT - 2);
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${fmtFt(lo)} ft`, padL + 2, h - padB - 3);
  // X axis in miles: pick a tick step that yields a handful of labels.
  const totalMi = distM / 1609.34;
  const step = [0.25, 0.5, 1, 2, 5, 10, 20, 50, 100].find((s) => totalMi / s <= 7) || 200;
  ctx.strokeStyle = 'rgba(120,140,155,0.22)';
  ctx.lineWidth = 1;
  ctx.textBaseline = 'bottom';
  for (let mi = step; mi < totalMi - step * 0.3; mi += step) {
    const x = X(mi * 1609.34);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, h - padB);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillText(`${+mi.toFixed(2)}`, x, h - 6);
  }
  ctx.textAlign = 'right';
  ctx.fillText(`${totalMi.toFixed(1)} mi`, w - padR - 2, h - 6);
  ctx.textAlign = 'left';
}
window.addEventListener('resize', () => {
  drawElevation(document.getElementById('elevationPreviewCanvas'), true);
  drawSpeedProfile(document.getElementById('speedProfileCanvas'));
  routePreviewMap?.resize();
  if (document.getElementById('elevationDialog')?.open) {
    drawElevation(document.getElementById('elevationDialogCanvas'));
  }
  if (document.getElementById('speedDialog')?.open) {
    drawSpeedProfile(document.getElementById('speedDialogCanvas'));
  }
});

function selectedDetailTab() {
  return document.querySelector('[data-detail-tab][aria-selected="true"]')?.dataset.detailTab || 'stats';
}

function saveDetailPosition() {
  if (!details?.savedAt) return;
  try {
    sessionStorage.setItem(ROUTE_DETAILS_POSITION_KEY, JSON.stringify({
      savedAt: details.savedAt, tab: selectedDetailTab(), scrollY: window.scrollY,
    }));
  } catch (e) { /* nonfatal */ }
}

function restoreDetailPosition() {
  if (!details?.savedAt) return false;
  try {
    const state = JSON.parse(sessionStorage.getItem(ROUTE_DETAILS_POSITION_KEY) || 'null');
    if (!state || state.savedAt !== details.savedAt) return false;
    selectDetailTab(['stats', 'concerns', 'steps'].includes(state.tab) ? state.tab : 'stats');
    requestAnimationFrame(() => window.scrollTo(0, Math.max(0, Number(state.scrollY) || 0)));
    return true;
  } catch (e) { return false; }
}

function restoreInitialDetailTab() {
  if (REQUESTED_CONCERN === 'concern-unpaved') {
    selectDetailTab('concerns');
    requestAnimationFrame(() => scrollToConcernSection(REQUESTED_CONCERN));
    return;
  }
  if (['stats', 'concerns', 'steps'].includes(REQUESTED_DETAIL_TAB)) {
    selectDetailTab(REQUESTED_DETAIL_TAB);
    return;
  }
  if (!restoreDetailPosition()) selectDetailTab('stats');
}

const details = loadDetails();
const hasRoute = !!(details && details.summary && Array.isArray(details.segs));
const report = document.getElementById('report');
const steps = document.getElementById('steps');
const summary = document.getElementById('summary');
const summaryCard = document.getElementById('routeSummaryCard');
const summarySub = document.getElementById('summarySub');
const summaryRoadSpeed = document.getElementById('summaryRoadSpeed');
const summaryMix = document.getElementById('summaryMix');
const speedShoulderNote = document.getElementById('speedShoulderNote');
const elevationSteepWarning = document.getElementById('elevationSteepWarning');
const noRouteSummary = document.getElementById('noRouteSummary');
const alert = document.getElementById('routeAlert');
const concernDetailsHint = document.getElementById('concernDetailsHint');
const unpavedRouteWarning = document.getElementById('unpavedRouteWarning');

elevationSteepWarning.addEventListener('click', () => {
  selectDetailTab('concerns');
  requestAnimationFrame(() => scrollToConcernSection('concern-steep-grades'));
});
unpavedRouteWarning.addEventListener('click', () => {
  selectDetailTab('concerns');
  requestAnimationFrame(() => scrollToConcernSection('concern-unpaved'));
});

function renderRouteOptionTabs() {
  const host = document.getElementById('routeOptionTabs');
  const options = Array.isArray(details?.routeOptions) ? details.routeOptions : [];
  // Direct visits have no live map to update. The embedded page only exposes
  // choices when it can hand the new selection back to the app.
  host.hidden = !embeddedDetails || options.length < 2;
  if (host.hidden) return;
  host.innerHTML = options.map((option) => `<button type="button" role="tab"
      data-route-details-option="${option.index}" aria-selected="${!!option.selected}"
      aria-label="Choose ${option.label === 'Shared' ? 'shared route' : `route ${option.label}`}">
      ${option.label}</button>`).join('');
  host.querySelectorAll('[data-route-details-option]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-selected') === 'true') return;
      window.parent.postMessage({
        type: 'select-route-details-option',
        index: Number(button.dataset.routeDetailsOption),
        tab: selectedDetailTab(),
      }, window.location.origin);
    });
  });
}

function routePreviewPoints() {
  const coords = Array.isArray(details?.routeCoords) ? details.routeCoords : [];
  const indices = Array.isArray(details?.routeCoordIndices) ? details.routeCoordIndices : [];
  const maxIndex = Math.max(1, ...(details?.segs || []).map((seg) => Number(seg?.c1) || 0));
  return coords.map((coord, position) => {
    const point = lngLat(coord);
    if (!point) return null;
    const storedIndex = Number(indices[position]);
    return {
      point,
      // Old saved routes lacked source indexes. Spread those points over the
      // route as a graceful fallback until Details is next refreshed.
      routeIndex: Number.isFinite(storedIndex)
        ? storedIndex : maxIndex * position / Math.max(1, coords.length - 1),
    };
  }).filter(Boolean);
}

const ROUTE_PREVIEW_STYLES = {
  pass: PASS_COLOR, bike: BIKE_NETWORK_COLOR, trail: BIKE_NETWORK_COLOR,
  caution: CAUTION_COLOR, fail: FAIL_COLOR,
};

function routePreviewStyle(seg) {
  return routeDisplayCategory(seg) || 'pass';
}

function routePreviewColor(seg) {
  return ROUTE_PREVIEW_STYLES[routePreviewStyle(seg)];
}

function routePreviewEdges(points) {
  const segs = details?.segs || [];
  let segmentAt = 0;
  return points.slice(0, -1).map((point, index) => {
    const routeIndex = (point.routeIndex + points[index + 1].routeIndex) / 2;
    while (segmentAt + 1 < segs.length && routeIndex >= Number(segs[segmentAt]?.c1)) segmentAt++;
    const seg = segs[segmentAt];
    return { style: routePreviewStyle(seg), unpaved: isConfirmedUnpavedSurface(seg?.surface),
      dismount: isDismountSegment(seg) };
  });
}

function routePreviewEdgeStyles(points) {
  return routePreviewEdges(points).map((edge) => edge.style);
}

function routePreviewEdgeColors(points) {
  return routePreviewEdgeStyles(points).map((style) => ROUTE_PREVIEW_STYLES[style]);
}

function routePreviewRenderData() {
  const pointData = routePreviewPoints();
  const points = pointData.map((entry) => entry.point);
  const edges = routePreviewEdges(pointData);
  const edgeStyles = edges.map((edge) => edge.style);
  const features = [];
  let start = 0, style = edgeStyles[0];
  for (let edge = 1; edge < edgeStyles.length; edge++) {
    if (edgeStyles[edge] === style) continue;
    features.push({ type: 'Feature', properties: { style },
      geometry: { type: 'LineString', coordinates: points.slice(start, edge + 1) } });
    start = edge;
    style = edgeStyles[edge];
  }
  if (points.length >= 2) features.push({ type: 'Feature', properties: { style },
    geometry: { type: 'LineString', coordinates: points.slice(start) } });
  const unpavedFeatures = [];
  let currentUnpaved = null;
  edges.forEach((edge, index) => {
    if (!edge.unpaved) {
      currentUnpaved = null;
      return;
    }
    const coordinates = [points[index], points[index + 1]];
    const previous = currentUnpaved?.geometry.coordinates.at(-1);
    if (currentUnpaved && previous?.[0] === coordinates[0][0] && previous?.[1] === coordinates[0][1]) {
      currentUnpaved.geometry.coordinates.push(coordinates[1]);
      return;
    }
    currentUnpaved = {
      type: 'Feature', properties: {},
      geometry: { type: 'LineString', coordinates },
    };
    unpavedFeatures.push(currentUnpaved);
  });
  const unpaved = { type: 'FeatureCollection', features: unpavedFeatures };
  const dismountFeatures = [];
  let inDismount = false;
  edges.forEach((edge, index) => {
    if (edge.dismount && !inDismount && points[index]) {
      dismountFeatures.push({ type: 'Feature', properties: {},
        geometry: { type: 'Point', coordinates: points[index] } });
    }
    inDismount = edge.dismount;
  });
  const dismount = { type: 'FeatureCollection', features: dismountFeatures };
  return { points, colored: { type: 'FeatureCollection', features }, unpaved, dismount };
}

// Both preview images come from marker-icons.js -- the same painters the main
// map uses, so the preview cannot drift back to the retired warning triangle.

function setRoutePreviewFailPulse(on) {
  if (on && !routePreviewFailPulseTimer) {
    let t = 0;
    routePreviewFailPulseTimer = setInterval(() => {
      if (!routePreviewMap?.getLayer('route-preview-fail')) return;
      t += 0.11;
      const pulse = Math.abs(Math.sin(t));
      // Keep failures red at every phase. A translucent red pulse over the
      // basemap blends into an ambiguous purple-gray dash.
      routePreviewMap.setPaintProperty('route-preview-fail', 'line-opacity', 0.92 + 0.08 * pulse);
      routePreviewMap.setPaintProperty('route-preview-fail', 'line-width', 4.8 + 1.4 * pulse);
    }, 80);
  } else if (!on && routePreviewFailPulseTimer) {
    clearInterval(routePreviewFailPulseTimer);
    routePreviewFailPulseTimer = null;
  }
}

window.addEventListener('pagehide', () => setRoutePreviewFailPulse(false));

function initializeRoutePreviewMap() {
  const host = document.getElementById('routePreviewMap');
  const preview = routePreviewRenderData();
  if (!host || preview.points.length < 2 || !window.maplibregl) return false;
  if (routePreviewMap) { routePreviewMap.resize(); return true; }
  routePreviewMap = new maplibregl.Map({
    container: host,
    interactive: false,
    attributionControl: false,
    style: BikeBasemap.createStyle(),
    center: preview.points[0], zoom: 13, maxZoom: 17, maxPitch: 0,
  });
  routePreviewMap.on('load', () => {
    routePreviewMap.addSource('route-preview-all', { type: 'geojson', data: {
      type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: preview.points },
    } });
    routePreviewMap.addSource('route-preview-colored', { type: 'geojson', data: preview.colored });
    routePreviewMap.addSource('route-preview-unpaved', { type: 'geojson', data: preview.unpaved });
    routePreviewMap.addSource('route-preview-dismount', { type: 'geojson', data: preview.dismount });
    routePreviewMap.addSource('route-preview-markers', { type: 'geojson', data: {
      type: 'FeatureCollection', features: [
        { type: 'Feature', properties: { marker: 'start' }, geometry: { type: 'Point', coordinates: preview.points[0] } },
        { type: 'Feature', properties: { marker: 'end' }, geometry: { type: 'Point', coordinates: preview.points.at(-1) } },
      ],
    } });
    routePreviewMap.addLayer({ id: 'route-preview-casing', type: 'line', source: 'route-preview-all',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#fff', 'line-width': 8, 'line-opacity': .96 } });
    const addRouteLayer = (style, paint) => routePreviewMap.addLayer({
      id: `route-preview-${style}`, type: 'line', source: 'route-preview-colored',
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint,
      filter: ['==', ['get', 'style'], style],
    });
    addRouteLayer('pass', { 'line-color': PASS_COLOR, 'line-width': 4.8 });
    addRouteLayer('bike', { 'line-color': BIKE_NETWORK_COLOR, 'line-width': 4.8 });
    addRouteLayer('trail', { 'line-color': BIKE_NETWORK_COLOR, 'line-width': 5.2, 'line-dasharray': [.3, 1.1] });
    addRouteLayer('caution', { 'line-color': CAUTION_COLOR, 'line-width': 4.8 });
    addRouteLayer('fail', { 'line-color': FAIL_COLOR, 'line-width': 4.8, 'line-dasharray': [1.5, 1] });
    addRouteLayer('unknown', { 'line-color': '#98a2ad', 'line-width': 4.8 });
    ensureUnpavedSlatImage(routePreviewMap, 'route-preview-unpaved-slats');
    ensureDismountMarkerImage(routePreviewMap, 'route-preview-dismount-marker-icon');
    routePreviewMap.addLayer({ id: 'route-preview-unpaved-slats', type: 'symbol', source: 'route-preview-unpaved',
      layout: {
        'symbol-placement': 'line', 'symbol-spacing': 10,
        'icon-image': 'route-preview-unpaved-slats',
        'icon-size': ['interpolate', ['linear'], ['zoom'],
          5, 0.55, 7, 0.6, 9, 0.68, 11, 0.76, 13, 0.84, 15, 0.9],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true, 'icon-rotation-alignment': 'map',
        'icon-pitch-alignment': 'map', 'icon-keep-upright': false,
      },
      paint: { 'icon-opacity': 0.7 } });
    routePreviewMap.addLayer({ id: 'route-preview-dismount-halo', type: 'circle', source: 'route-preview-dismount',
      paint: { 'circle-radius': 9, 'circle-color': '#fff7d6', 'circle-opacity': .96,
        'circle-stroke-color': '#8a5600', 'circle-stroke-width': 1.2 } });
    routePreviewMap.addLayer({ id: 'route-preview-dismount-marker', type: 'symbol', source: 'route-preview-dismount',
      layout: { 'icon-image': 'route-preview-dismount-marker-icon', 'icon-size': .8,
        'icon-allow-overlap': true, 'icon-ignore-placement': true } });
    setRoutePreviewFailPulse(preview.colored.features.some((feature) => feature.properties.style === 'fail'));
    routePreviewMap.addLayer({ id: 'route-preview-markers', type: 'circle', source: 'route-preview-markers',
      paint: { 'circle-radius': 5, 'circle-color': ['match', ['get', 'marker'], 'start', '#00795c', '#e87817'],
        'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    const bounds = preview.points.reduce((bounds, point) => bounds.extend(point),
      new maplibregl.LngLatBounds(preview.points[0], preview.points[0]));
    routePreviewMap.fitBounds(bounds, { padding: 22, duration: 0, maxZoom: 15 });
  });
  return true;
}

renderRouteOptionTabs();

const detailTabs = [...document.querySelectorAll('[data-detail-tab]')];
detailTabs.forEach((tab) => {
  tab.addEventListener('click', () => selectDetailTab(tab.dataset.detailTab));
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = detailTabs.indexOf(tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? detailTabs.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + detailTabs.length) % detailTabs.length;
    detailTabs[next].focus();
    selectDetailTab(detailTabs[next].dataset.detailTab);
  });
});

if (!hasRoute) {
  noRouteSummary.hidden = false;
  noRouteSummary.textContent = 'No current route.';
  report.innerHTML = '<div class="no-route">Set a start and destination on the map to see freeways, highways, and any road-rule concerns here.</div>';
  steps.innerHTML = '<div class="no-route">Set a start and destination on the map to see the road-by-road route steps here.</div>';
  restoreInitialDetailTab();
} else {
  const { rules = {}, summary: totals, segs } = details;
  const routeStats = routeSummaryStats(segs, rules.minShoulder);
  const calculatedGrades = routeGradeStats(segs);
  const storedAvgUphillPct = Number(totals.avgUphillPct);
  const avgUphillPct = Number.isFinite(storedAvgUphillPct)
      && storedAvgUphillPct >= 0 && storedAvgUphillPct <= MAX_CREDIBLE_GRADE_PCT
    ? storedAvgUphillPct : calculatedGrades.avgUphillPct;
  // Recalculate from stored segments so an already-open route benefits from
  // the sustained-grade method without requiring another route search.
  const maxGradePct = calculatedGrades.maxGradePct;
  const steepGrades = consolidateConcernItems(sustainedUphillGradeConcerns(segs)
    .map((item) => ({ ...item, riskScore: Number(item.maxGradePct) || 0 })));
  const steepUphillM = steepGrades.reduce((sum, item) => sum + item.lenM, 0);
  const ridingM = Math.max(1,
    ROUTE_CATEGORY_KEYS.reduce((sum, key) => sum + routeStats.categoryM[key], 0));
  const categoryPct = routeCategoryPercentages(routeStats.categoryM);
  const unpavedPct = routePercent(routeStats.unpavedM, ridingM, true);
  const hasSignificantUnpaved = routeStats.unpavedM > SIGNIFICANT_UNPAVED_M;
  const unpavedSummaryMetric = hasSignificantUnpaved
    ? `<button class="route-summary-secondary-item mix-unpaved-warning" id="summaryUnpavedWarningLink" type="button" aria-label="Review unpaved route concerns"><span class="route-summary-unpaved-swatch" aria-hidden="true"></span><b>${unpavedPct}</b><span class="route-summary-category-label">Unpaved</span><em class="route-summary-category-mi">${fmtCategoryMi(routeStats.unpavedM)}</em></button>`
    : `<span class="route-summary-secondary-item"><span class="route-summary-unpaved-swatch" aria-hidden="true"></span><b>${unpavedPct}</b><span class="route-summary-category-label">Unpaved</span><em class="route-summary-category-mi">${fmtCategoryMi(routeStats.unpavedM)}</em></span>`;
  // Share AND distance. A percentage alone does not tell a rider what they are
  // in for: 10% caution is a pleasant surprise on a four-mile ride and thirteen
  // miles of it on a century. The label carries a class rather than being found
  // by position -- a test and the stylesheet both used `span:last-child`, and
  // appending this column silently made both of them null.
  const categoryRows = ROUTE_CATEGORY_LABELS
    .map(([key, label]) => `<span class="route-summary-category-item category-${key}"><span class="route-summary-category-swatch ${key}" aria-hidden="true"></span><b>${categoryPct[key]}%</b><span class="route-summary-category-label">${label}</span><em class="route-summary-category-mi">${fmtCategoryMi(routeStats.categoryM[key])}</em></span>`).join('');
  document.getElementById('routeQuickSummary').hidden = false;
  summaryCard.hidden = false;
  const tripNotes = [
    details.routeStateIds?.length > 1
      ? `<span class="route-summary-trip-note">${details.routeStateIds.map((stateId) => routeStateConfig(stateId)?.name || stateId).join(' → ')}</span>` : '',
    routeStats.ferryM > 0 ? `<span class="route-summary-trip-note"><span aria-hidden="true">⛴︎</span><b>Ferry</b> ${fmtMi(routeStats.ferryM)} mi</span>` : '',
    routeStats.dismountM > 0 ? `<span class="route-summary-trip-note"><span aria-hidden="true">⚠︎</span><b>Dismount</b> ${fmtMi(routeStats.dismountM)} mi</span>` : '',
  ].filter(Boolean).join('');
  summary.innerHTML = `<strong>${fmtMi(totals.distM)} mi</strong><small>${fmtDur(totals.timeS)}</small>${tripNotes}`;
  summarySub.innerHTML = `<span class="elevation-metric"><b>Climb</b><strong>↗ ${fmtFt(totals.ascentM)} ft</strong></span><span class="elevation-metric"><b>Descent</b><strong>↘ ${fmtFt(totals.descentM)} ft</strong></span><span class="elevation-metric"><b>Avg. grade</b><strong>${avgUphillPct.toFixed(1)}% uphill</strong></span><span class="elevation-metric"><b>Max grade</b><strong>${maxGradePct.toFixed(1)}%</strong></span><span class="elevation-metric"><b>5%+ uphill</b><strong>${fmtMi(routeStats.inclineOver5M)} mi</strong></span><span class="elevation-metric"><b>10%+ uphill</b><strong>${fmtMi(steepUphillM)} mi</strong></span>`;
  elevationSteepWarning.hidden = !(maxGradePct > STEEP_GRADE_WARNING_PCT);
  const hasRoadSpeed = routeStats.avgRoadSpeedMph != null;
  const speedMiles = (meters) => hasRoadSpeed ? `${fmtMi(meters)} mi` : 'N/A';
  summaryRoadSpeed.innerHTML = `<span class="speed-limit-metric"><span>At least <strong>35 mph</strong></span><b>${speedMiles(routeStats.roadAtOrAbove35M)}</b></span><span class="speed-limit-metric"><span>At least <strong>45 mph</strong></span><b>${speedMiles(routeStats.roadAtOrAbove45M)}</b></span><span class="speed-limit-metric"><span>At least <strong>55 mph</strong></span><b>${speedMiles(routeStats.roadAtOrAbove55M)}</b></span>`;
  summaryMix.innerHTML = `<div class="route-summary-mix-items">${categoryRows}</div><div class="route-summary-secondary">${unpavedSummaryMetric}</div>`;
  document.getElementById('summaryUnpavedWarningLink')?.addEventListener('click', () => {
    selectDetailTab('concerns');
    requestAnimationFrame(() => scrollToConcernSection('concern-unpaved'));
  });
  unpavedRouteWarning.hidden = !hasSignificantUnpaved;
  if (hasSignificantUnpaved) {
    document.getElementById('unpavedWarningText').textContent =
      `This route has ${fmtMiles(routeStats.unpavedM)} mi of unpaved surface.`;
  }
  speedShoulderNote.hidden = false;
  speedShoulderNote.innerHTML = `<b>${speedMiles(routeStats.highSpeedNoBikeAccommodationOrShoulderM)}</b> on ≥30 mph roads without bike accommodation or a ≥${routeStats.minShoulderFt} ft shoulder`;
  const speedProfile = document.getElementById('speedProfile');
  const speedSegments = speedProfileSegments(segs);
  speedProfile.hidden = !speedSegments.length;
  if (speedSegments.length) {
    const speedPreview = document.getElementById('speedProfilePreview');
    const speedDialog = document.getElementById('speedDialog');
    document.getElementById('speedProfileCanvas').setAttribute('aria-label',
      `Speed limits along ${fmtMi(totals.distM)} miles. Bike facilities and trails are lime, passing roads blue, cautions amber, and failing roads red.`);
    speedPreview.addEventListener('click', () => {
      speedDialog.showModal();
      requestAnimationFrame(() => drawSpeedProfile(document.getElementById('speedDialogCanvas')));
    });
    document.getElementById('speedDialogClose').addEventListener('click', () => speedDialog.close());
    bindExpandedChartMapTap(document.getElementById('speedDialogCanvas'), speedDialog, 6, 6);
    requestAnimationFrame(() => drawSpeedProfile(document.getElementById('speedProfileCanvas')));
  }
  const routePreview = document.getElementById('routePreview');
  routePreview.hidden = routePreviewPoints().length < 2;
  if (!routePreview.hidden) requestAnimationFrame(initializeRoutePreviewMap);
  if (Array.isArray(details.profile) && details.profile.length >= 2) {
    const elevationPreview = document.getElementById('elevationPreview');
    const elevationDialog = document.getElementById('elevationDialog');
    elevationPreview.hidden = false;
    document.getElementById('elevationDialogSummary').textContent = `${fmtMi(totals.distM)} mi · ↗ ${fmtFt(totals.ascentM)} ft climb · ${avgUphillPct.toFixed(1)}% avg uphill · ${maxGradePct.toFixed(1)}% max grade`;
    elevationPreview.addEventListener('click', () => {
      elevationDialog.showModal();
      requestAnimationFrame(() => drawElevation(document.getElementById('elevationDialogCanvas')));
    });
    document.getElementById('elevationDialogClose').addEventListener('click', () => elevationDialog.close());
    bindExpandedChartMapTap(document.getElementById('elevationDialogCanvas'), elevationDialog, 8, 8);
    requestAnimationFrame(() => drawElevation(document.getElementById('elevationPreviewCanvas'), true));
  } else {
    document.getElementById('elevationPreviewEmpty').hidden = false;
  }
  const freeways = consolidateConcernItems(sections(segs, (s) => !!(s.flags & FLAG_FREEWAY), (s) => ({
    name: roadName(s),
    meta: [s.mph ? `${s.mph} mph` : null, 'limited-access freeway'].filter(Boolean).join(' · '),
    riskScore: 1000 + (Number(s.mph) || 0),
  })));
  const limitedAccess = consolidateConcernItems(sections(segs,
    (s) => !(s.flags & FLAG_FREEWAY) && (!!(s.flags & FLAG_LIMITED_ACCESS)
      || cautionConcernKind(s, rules) === 'limited-access'), (s) => ({
      name: roadName(s),
      meta: [s.mph ? `${s.mph} mph` : null, 'limited-access highway'].filter(Boolean).join(' · '),
      riskScore: Number(s.mph) || 0,
    })));
  const highways = consolidateConcernItems(sections(segs, isHighway, (s) => ({
    name: roadName(s),
    meta: s.mph ? `${s.mph} mph highway` : 'Highway',
    riskScore: Number(s.mph) || 0,
  })));
  const failing = consolidateConcernItems(sections(segs,
    (s) => routeSegmentLevel(s, rules) === 4, (s) => ({
    name: roadName(s), ...failedRoadDetails(s, rules),
    // Speed dominates the representative choice, so a combined 50/60 mph
    // road reports the 60 mph condition. Freeways remain the worst class.
    riskScore: ((s.flags || 0) & FLAG_FREEWAY ? 10000 : 0)
      + (Number(s.mph) || 0) * 100
      + Math.max(0, (Number(rules.minShoulder) || 4) - Math.max(0, Number(s.sh) || 0)),
  })));
  const dismounts = consolidateConcernItems(sections(segs,
    (s) => isDismountSegment(s) || cautionConcernKind(s, rules) === 'dismount', (s) => ({
    name: roadName(s), meta: 'Dismount required — walk your bike',
    riskScore: Number(s.lenM) || 0,
  })));
  const facilityGaps = consolidateConcernItems(sections(segs,
    (s) => cautionConcernKind(s, rules) === 'facility-gap', (s) => ({
      name: roadName(s),
      meta: 'Protected bike space briefly enters a one-way shared-traffic lane on a through road',
      riskScore: 500 + (Number(s.mph) || 0),
    })));
  const sidewalkFallbacks = consolidateConcernItems(sections(segs,
    (s) => isSidewalkFallbackSegment(s, rules)
      || cautionConcernKind(s, rules) === 'sidewalk-fallback', (s) => ({
    name: roadName(s),
    meta: `${s.mph} mph · mapped sidewalk fallback`,
    riskScore: Number(s.mph) || 0,
  })));
  const mountainBike = consolidateConcernItems(sections(segs,
    (s) => isMountainBikeTrail(s) || cautionConcernKind(s, rules) === 'mountain-bike', (s) => ({
    name: roadName(s),
    meta: `Allowed mountain-bike trail · ${s.mtb ? 'OSM MTB tag' : 'OSM MTB route'}`,
    riskScore: Number(s.mtb) || 0,
  })));
  const highStress = consolidateConcernItems(sections(segs,
    (s) => cautionConcernKind(s, rules) === 'high-stress', (s) => ({
      name: roadName(s),
      stateId: s.stateId || null,
      meta: `${segmentState(s)?.stressAgency || 'Transportation agency'} rates it ${Number(s.lts) || 4} of 4 for traffic stress`,
      riskScore: Number(s.lts) || 4,
    })));
  const otherCautions = consolidateConcernItems(sections(segs,
    (s) => cautionConcernKind(s, rules) === 'other', (s) => ({
      name: roadName(s),
      meta: 'Marked “Use caution” on the route',
      riskScore: Number(s.mph) || 0,
    })));
  const unpaved = consolidateConcernItems(sections(segs,
    (s) => isConfirmedUnpavedSurface(s.surface), (s) => ({
      name: roadName(s),
      meta: `Confirmed ${surfaceLabel(s.surface).toLowerCase()} surface · OSM data`,
      riskScore: Number(s.surface) || 0,
    })));
  const curveHazards = consolidateConcernItems(sections(segs, (s) => !!s.hazard, (s) => ({
    name: roadName(s),
    meta: [
      'Possible limited-visibility uphill curve',
      credibleSegmentGradePct(s) > 0 ? `${credibleSegmentGradePct(s)}% climb` : null,
      s.mph ? `${s.mph} mph` : null,
      s.sh >= 0 ? `${s.sh} ft shoulder` : 'shoulder unknown',
    ].filter(Boolean).join(' · '),
    coordStart: s.hazC0 ?? s.c0, coordEnd: s.hazC1 ?? s.c1,
    locationStart: s.hazardLocationStart ?? s.locationStart,
    locationEnd: s.hazardLocationEnd ?? s.locationEnd,
    lenM: s.hazardLenM || s.lenM,
    riskScore: credibleSegmentGradePct(s) * 100 + (Number(s.mph) || 0),
  })));
  const routeSteps = buildRouteSteps(segs, details.directions);
  const ferries = sections(segs, (s) => !!(s.flags & FLAG_FERRY), () => ({
    name: 'Ferry crossing', meta: 'Ferry segment',
  }));
  const concernTitles = {
    failing: 'Does not meet your rules',
    dismount: 'Dismount points — walk your bike',
    facilityGap: 'Bike-facility traffic conflicts',
    steepGrades: 'Steep uphill grades\n(over 10%)',
    limitedAccess: 'Limited-access highways',
    highStress: 'Officially rated high-stress roads',
    mountainBike: 'Mountain-bike trails',
    curveHazards: 'Possible limited-visibility uphill curves',
    unpaved: 'Unpaved surfaces',
    sidewalkFallback: 'Sidewalk fallback',
    otherCautions: 'Other route cautions',
  };

  alert.hidden = false;
  alert.classList.remove('good', 'caution');
  if (failing.length || dismounts.length || facilityGaps.length || sidewalkFallbacks.length || mountainBike.length
      || limitedAccess.length || highStress.length || otherCautions.length
      || curveHazards.length || steepGrades.length || unpaved.length) {
    const failingM = failing.reduce((sum, item) => sum + item.lenM, 0);
    const dismountM = dismounts.reduce((sum, item) => sum + item.lenM, 0);
    const facilityGapM = facilityGaps.reduce((sum, item) => sum + item.lenM, 0);
    const limitedM = limitedAccess.reduce((sum, item) => sum + item.lenM, 0);
    const highStressM = highStress.reduce((sum, item) => sum + item.lenM, 0);
    const otherCautionM = otherCautions.reduce((sum, item) => sum + item.lenM, 0);
    const mountainBikeM = mountainBike.reduce((sum, item) => sum + item.lenM, 0);
    const unpavedM = unpaved.reduce((sum, item) => sum + item.lenM, 0);
    if (!failingM) alert.classList.add('caution');
    const notes = [];
    if (failingM) notes.push({ label: concernTitles.failing, distance: fmtDist(failingM), sectionId: 'concern-fails' });
    if (dismountM) notes.push({ label: concernTitles.dismount, distance: fmtDist(dismountM), sectionId: 'concern-dismount' });
    if (facilityGapM) notes.push({ label: concernTitles.facilityGap, distance: fmtDist(facilityGapM), sectionId: 'concern-facility-gap' });
    if (steepGrades.length) notes.push({ label: concernTitles.steepGrades, distance: fmtDist(steepUphillM), sectionId: 'concern-steep-grades' });
    if (limitedM) notes.push({ label: concernTitles.limitedAccess, distance: fmtDist(limitedM), sectionId: 'concern-limited-access' });
    if (highStressM) notes.push({ label: concernTitles.highStress, distance: fmtDist(highStressM), sectionId: 'concern-high-stress' });
    if (otherCautionM) notes.push({ label: concernTitles.otherCautions, distance: fmtDist(otherCautionM), sectionId: 'concern-other-cautions' });
    if (mountainBikeM) notes.push({ label: concernTitles.mountainBike, distance: fmtDist(mountainBikeM), sectionId: 'concern-mountain-bike' });
    if (curveHazards.length) notes.push({
      label: concernTitles.curveHazards,
      distance: fmtDist(curveHazards.reduce((sum, item) => sum + item.lenM, 0)),
      sectionId: 'concern-uphill-curves',
    });
    if (unpavedM) notes.push({ label: concernTitles.unpaved, sectionId: 'concern-unpaved',
      distance: unpavedM < 160.934 ? fmtDist(unpavedM) : `${fmtMiles(unpavedM)} mi` });
    if (sidewalkFallbacks.length) notes.push({
      label: concernTitles.sidewalkFallback,
      distance: fmtDist(sidewalkFallbacks.reduce((sum, item) => sum + item.lenM, 0)),
      sectionId: 'concern-sidewalk-fallback',
    });
    const title = document.createElement('strong');
    title.className = 'route-alert-title';
    title.textContent = 'Route concerns';
    const list = document.createElement('ul');
    list.className = 'route-alert-list';
    list.style.setProperty('--summary-rows', Math.ceil(notes.length / 2));
    notes.forEach(({ label, distance, sectionId }) => {
      const item = document.createElement('li');
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'route-alert-link';
      link.setAttribute('aria-label', `Open ${label.replace('\n', ' ')} details`);
      link.addEventListener('click', () => scrollToConcernSection(sectionId));
      const labelText = document.createElement('span');
      labelText.className = 'route-alert-label';
      labelText.textContent = label;
      const distanceText = document.createElement('span');
      distanceText.className = 'route-alert-distance';
      distanceText.textContent = distance;
      link.append(labelText, distanceText);
      item.appendChild(link);
      list.appendChild(item);
    });
    alert.replaceChildren(title, list);
    concernDetailsHint.hidden = false;
  } else {
    alert.classList.add('good');
    alert.textContent = 'No route concerns were found under your current riding rules.';
    concernDetailsHint.hidden = true;
  }

  const snapNotes = [];
  if (Number(details.snapStartM) > 80) snapNotes.push(`Start off route by ${fmtDist(details.snapStartM)}`);
  if (Number(details.snapEndM) > 80) snapNotes.push(`Destination off route by ${fmtDist(details.snapEndM)}`);
  if (snapNotes.length) {
    const note = document.createElement('p');
    note.className = 'snap-note';
    note.textContent = `Note: ${snapNotes.join(' · ')}.`;
    alert.insertAdjacentElement('afterend', note);
  }

  // Put the strongest actionable concerns first. Broad road-type context and
  // deliberately allowed fallbacks sit lower in the report.
  if (failing.length) renderSection(report, concernTitles.failing, failing, '', 'fail', false, 'concern-fails', '', true);
  if (dismounts.length) renderSection(report, concernTitles.dismount, dismounts, '', 'caution', false, 'concern-dismount', '', true);
  if (facilityGaps.length) renderSection(report, concernTitles.facilityGap, facilityGaps, '', 'caution', false, 'concern-facility-gap', 'Protected bike space briefly enters a shared traffic lane; the router strongly avoids this transition.', true);
  if (steepGrades.length) renderSection(report, concernTitles.steepGrades, steepGrades, '', 'caution', false, 'concern-steep-grades', 'Note: May contain errors due to data quality.', true);
  if (freeways.length) renderSection(report, 'Freeways', freeways, '', 'freeway', false, 'concern-freeways', '', true);
  if (limitedAccess.length) renderSection(report, concernTitles.limitedAccess, limitedAccess, '', 'caution', false, 'concern-limited-access', '', true);
  if (highStress.length) renderSection(report, concernTitles.highStress, highStress, '', 'caution', false, 'concern-high-stress', 'Official Level of Traffic Stress is road context, not a failure of your rules.', true);
  if (otherCautions.length) renderSection(report, concernTitles.otherCautions, otherCautions, '', 'caution', false, 'concern-other-cautions', 'These segments are shown so every amber route section has a matching concern item.', true);
  if (mountainBike.length) renderSection(report, concernTitles.mountainBike, mountainBike, '', 'caution', false, 'concern-mountain-bike', '', true);
  if (curveHazards.length) renderSection(report, concernTitles.curveHazards, curveHazards, '', 'caution', false, 'concern-uphill-curves', '', true);
  if (unpaved.length) renderSection(report, concernTitles.unpaved, unpaved, '', 'caution', false, 'concern-unpaved', 'Known unpaved surfaces receive a modest route-choice cost; Settings can make the preference strong.', true);
  if (highways.length) renderSection(report, 'Highways', highways, '', '', false, 'concern-highways', '', true);
  if (sidewalkFallbacks.length) renderSection(report, concernTitles.sidewalkFallback, sidewalkFallbacks, '', 'caution', false, 'concern-sidewalk-fallback', 'Uses mapped sidewalks as a route fallback.', true);
  if (!freeways.length && !limitedAccess.length && !highStress.length && !otherCautions.length
      && !highways.length && !dismounts.length && !facilityGaps.length && !sidewalkFallbacks.length && !failing.length && !unpaved.length && !mountainBike.length
      && !curveHazards.length && !steepGrades.length) {
    report.innerHTML = '<div class="no-route">No dismount, freeway, limited-access highway, unpaved, highway, steep-grade, or rule-failing sections were found on this route.</div>';
  }
  if (Array.isArray(details.legs) && details.legs.length > 1) {
    renderSection(steps, 'Legs', details.legs.map((leg, i) => ({
      name: `Leg ${i + 1}`,
      lenM: leg.distM,
      meta: `${fmtDur(leg.timeS)}${leg.failM > 0 ? ` · ${fmtDist(leg.failM)} fails rules` : ''}`,
    })), '');
  }
  renderSection(steps, 'Turn-by-turn directions', routeSteps, 'No street-level directions are available for this route.', '', true);
  if (ferries.length) renderSection(steps, 'Ferry crossings', ferries, '', 'caution', true);
  restoreInitialDetailTab();
}


window.addEventListener('pagehide', saveDetailPosition);
