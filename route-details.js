const ROUTE_DETAILS_KEY = 'wa-bike-route-details-1';
const ROUTE_DETAILS_POSITION_KEY = 'wa-bike-route-details-position-1';
const FLAG_FACILITY = 2;
const FLAG_FREEWAY = 4;
const FLAG_INFRA = 8;
const FLAG_FERRY = 32;
const FLAG_DESIGNATED = 64;
const FLAG_LIMITED_ACCESS = 128;
const OFFICIAL_MTB = 4;
const BIKE_NETWORK_COLOR = '#9fc400';
const PASS_COLOR = '#168ad1';
const CAUTION_COLOR = '#c46b00';
const FAIL_COLOR = '#b2182b';
let routePreviewMap = null;
const REQUESTED_DETAIL_TAB = new URLSearchParams(window.location.search).get('tab');
const MIN_REPORTED_GRADE_M = 20;
const MAX_CREDIBLE_GRADE_PCT = 40;
const HIGHWAY_NAME = /\b(highway|state route|sr\s*\d|us\s*(?:route\s*)?\d|i-?\s*\d)\b/i;
const FACILITY_NAME = {
  1: 'shared lane', 2: 'bike lane', 3: 'buffered bike lane',
  4: 'separated bike lane', 5: 'shared-use path',
};
const ROAD_CLASS_NAME = {
  1: 'residential street', 2: 'living street', 3: 'unclassified road',
  4: 'tertiary road', 5: 'tertiary link', 6: 'secondary road',
  7: 'secondary link', 8: 'primary road', 9: 'primary link',
  10: 'trunk road', 11: 'trunk link', 12: 'motorway', 13: 'motorway link',
};
function isBikeNetwork(seg) {
  const flags = seg.flags || 0;
  return !!(flags & FLAG_INFRA) || (seg.facility || 0) >= 2;
}

function isDesignated(seg) {
  return !!((seg.flags || 0) & FLAG_DESIGNATED);
}

function isMountainBikeTrail(seg) {
  return !!seg.mtb || !!((seg.official || 0) & OFFICIAL_MTB);
}

function safetyVerdict(seg) {
  if (seg.level === 4) return { label: 'Fails rules', className: 'fail' };
  if (isMountainBikeTrail(seg)) return { label: 'Mountain-bike trail', className: 'caution' };
  if (seg.level === 3) return { label: 'Caution', className: 'caution' };
  if (!seg.level) return { label: 'Insufficient data', className: 'unknown' };
  if (seg.bikeNetworkAll ?? isBikeNetwork(seg)) return { label: 'Bike network', className: 'bike' };
  if (seg.designatedAll ?? isDesignated(seg)) return { label: 'Designated route', className: 'designated' };
  return { label: 'Passes rules', className: 'pass' };
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

function fmtMi(m) { return (m / 1609.34).toFixed(1); }
function fmtFt(m) { return Math.round(m * 3.28084).toLocaleString(); }
function fmtDist(m) { return m < 160.934 ? `${fmtFt(m)} ft` : `${fmtMi(m)} mi`; }
function fmtDur(s) {
  const min = Math.round(s / 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} m`;
}
function lngLat(point) {
  if (!Array.isArray(point) || point.length < 2) return null;
  const lng = Number(point[0]), lat = Number(point[1]);
  return Number.isFinite(lng) && Number.isFinite(lat)
    && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90 ? [lng, lat] : null;
}
function itemLocation(item) {
  return lngLat(item.locationStart) || lngLat(item.locationEnd);
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
function googleStreetViewUrl([lng, lat], heading = null) {
  const headingParam = Number.isFinite(heading) ? `&heading=${Math.round(heading)}` : '';
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat.toFixed(6)},${lng.toFixed(6)}${headingParam}`;
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
  link.href = googleStreetViewUrl(location, heading);
  link.target = '_blank';
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}
function routePercent(meters, total, preciseSmall = false) {
  if (!(meters > 0) || !(total > 0)) return '0%';
  const pct = Math.min(100, 100 * meters / total);
  if (preciseSmall && pct < 0.1) return '<0.1%';
  if (preciseSmall && pct < 1) return `${pct.toFixed(1)}%`;
  if (preciseSmall && pct > 99 && pct < 100) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}
function routeSummaryStats(segs) {
  const levels = [0, 0, 0, 0, 0];
  let bikeNetworkM = 0, roadM = 0, roadSpeedM = 0;
  for (const seg of segs || []) {
    const flags = seg.flags || 0;
    if (flags & FLAG_FERRY) continue;
    const len = Number(seg.lenM) || 0;
    const level = Number(seg.level) || 0;
    if (level >= 1 && level <= 4) levels[level] += len;
    if ((flags & FLAG_INFRA) || (seg.facility || 0) >= 2) bikeNetworkM += len;
    // Every road speed counts here, including roads with bike lanes. Dedicated
    // paths have no motor-vehicle speed in the graph and are not road speeds.
    const mph = Number(seg.mph);
    if (!(flags & FLAG_INFRA) && Number.isFinite(mph) && mph > 0) {
      roadM += len;
      roadSpeedM += mph * len;
    }
  }
  return {
    levels, bikeNetworkM,
    avgRoadSpeedMph: roadM > 0 ? Math.round(roadSpeedM / roadM) : null,
  };
}
function credibleSegmentGradePct(seg) {
  const grade = Number(seg?.gradePct);
  const len = Number(seg?.lenM);
  if (!Number.isFinite(grade) || !Number.isFinite(len)
      || len < MIN_REPORTED_GRADE_M || Math.abs(grade) > MAX_CREDIBLE_GRADE_PCT) return 0;
  return grade;
}
function routeGradeStats(segs) {
  let uphillM = 0;
  let uphillRiseM = 0;
  let maxGradePct = 0;
  for (const seg of segs || []) {
    if ((seg.flags || 0) & FLAG_FERRY) continue;
    const grade = credibleSegmentGradePct(seg);
    const len = Number(seg.lenM) || 0;
    if (grade > 0.5 && len > 0) {
      uphillM += len;
      uphillRiseM += len * grade / 100;
    }
    maxGradePct = Math.max(maxGradePct, grade);
  }
  return {
    avgUphillPct: uphillM > 0 ? 100 * uphillRiseM / uphillM : 0,
    maxGradePct,
  };
}
function roadName(seg) { return seg.name || 'Unnamed road'; }
function isHighway(seg) {
  const f = seg.flags || 0;
  return !(f & (FLAG_FREEWAY | FLAG_LIMITED_ACCESS | FLAG_INFRA | FLAG_FERRY))
    && (seg.mph >= 45 || HIGHWAY_NAME.test(seg.name || ''));
}
function failReason(seg, rules) {
  const f = seg.flags || 0;
  if (f & FLAG_FREEWAY) return 'limited-access freeway — last resort only';
  if (!rules.noUpperLimit && seg.mph > rules.upperMaxSpeed) {
    return `${seg.mph} mph is above your ${rules.upperMaxSpeed} mph maximum`;
  }
  let shoulder = seg.sh;
  if (shoulder < 0 && rules.unknownShoulderZero) shoulder = 0;
  if ((seg.facility || 0) < 2 && !(f & FLAG_DESIGNATED)
      && shoulder >= 0 && shoulder < rules.minShoulder) {
    return seg.sh < 0 ? 'shoulder is unknown and treated as 0 ft'
      : `${shoulder} ft shoulder is below your ${rules.minShoulder} ft minimum`;
  }
  return 'does not meet your selected riding rules';
}

function failedRoadDetails(seg, rules) {
  const flags = seg.flags || 0;
  const failsSpeed = !rules.noUpperLimit && seg.mph > rules.upperMaxSpeed;
  let shoulder = seg.sh;
  if (shoulder < 0 && rules.unknownShoulderZero) shoulder = 0;
  const failsShoulder = (seg.facility || 0) < 2 && !(flags & FLAG_DESIGNATED)
    && shoulder >= 0 && shoulder < rules.minShoulder;
  const facts = [failReason(seg, rules)];
  if (seg.mph > 0 && !failsSpeed) facts.push(`${seg.mph} mph`);
  if (seg.sh >= 0 && !failsShoulder) facts.push(`${seg.sh} ft shoulder`);
  if (FACILITY_NAME[seg.facility]) facts.push(FACILITY_NAME[seg.facility]);
  if (flags & FLAG_FREEWAY) facts.push('freeway');
  else if (flags & FLAG_LIMITED_ACCESS) facts.push('limited access');
  else if (ROAD_CLASS_NAME[seg.roadClass]) facts.push(ROAD_CLASS_NAME[seg.roadClass]);
  return facts.join(' · ');
}

// Consecutive graph edges with the same meaning become one readable road item.
function sections(segs, include, describe) {
  const out = [];
  let previousIndex = -2;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (!include(seg)) { previousIndex = -2; continue; }
    const info = describe(seg);
    const key = `${info.name}\u0000${info.meta}`;
    const last = out[out.length - 1];
    const itemLenM = Number(info.lenM ?? seg.lenM) || 0;
    const locationStart = info.locationStart ?? seg.locationStart;
    const locationEnd = info.locationEnd ?? seg.locationEnd;
    if (last && previousIndex === i - 1 && last.key === key) {
      last.lenM += itemLenM;
      last.endIndex = i;
      if (info.coordEnd != null) last.coordEnd = info.coordEnd;
      if (locationEnd != null) last.locationEnd = locationEnd;
    } else out.push({ key, name: info.name, meta: info.meta, lenM: itemLenM,
      startIndex: i, endIndex: i, coordStart: info.coordStart, coordEnd: info.coordEnd,
      locationStart, locationEnd,
      safetyLabel: info.safetyLabel || '', safetyClass: info.safetyClass || '' });
    previousIndex = i;
  }
  return out;
}

function renderSection(host, title, items, emptyText, cls = '', numbered = false) {
  const total = items.reduce((sum, item) => sum + item.lenM, 0);
  const section = document.createElement('section');
  section.className = `detail-section ${cls}`;
  const heading = document.createElement('h2');
  heading.append(document.createTextNode(title));
  const totalLabel = document.createElement('span');
  totalLabel.textContent = items.length ? fmtDist(total) : 'None';
  heading.appendChild(totalLabel);
  section.appendChild(heading);
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = emptyText;
    section.appendChild(empty);
  } else {
    const list = document.createElement('ol');
    list.className = `detail-list${numbered ? ' numbered' : ''}`;
    for (const item of items) {
      const li = document.createElement('li');
      li.className = `detail-item ${cls}`;
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
      meta.textContent = item.meta;
      content.append(line, meta);
      if (content !== li) li.appendChild(content);
      const location = itemLocation(item);
      if (location) {
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
        streetView.setAttribute('aria-label', `Open ${item.name} in Google Street View`);
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
        mapButton.setAttribute('aria-label', `Show ${item.name} on the route map`);
        mapButton.addEventListener('click', () => showRouteStep(item));
        actions.append(mapButton, streetView);
        li.appendChild(actions);
      }
      list.appendChild(li);
    }
    section.appendChild(list);
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

function buildRouteSteps(segs) {
  const out = [];
  for (let index = 0; index < segs.length; index++) {
    const seg = segs[index];
    if (seg.flags & FLAG_FERRY) continue;
    const name = roadName(seg);
    const last = out[out.length - 1];
    if (last && last.endIndex === index - 1 && last.name === name) {
      last.lenM += seg.lenM;
      last.endIndex = index;
      last.coordEnd = seg.c1;
      last.locationEnd = seg.locationEnd;
      last.flags |= seg.flags || 0;
      last.facility = Math.max(last.facility || 0, seg.facility || 0);
      last.official |= seg.official || 0;
      last.mph = Math.max(last.mph, seg.mph || 0);
      last.level = Math.max(last.level, seg.level || 0);
      last.bikeNetworkAll = last.bikeNetworkAll && isBikeNetwork(seg);
      last.designatedAll = last.designatedAll && isDesignated(seg);
      last.hazard = Math.max(last.hazard || 0, seg.hazard || 0);
      last.crossingM += seg.crossing ? Number(seg.lenM) || 0 : 0;
      if (seg.level === 4) last.failM += seg.lenM;
    } else {
      out.push({
        name,
        startIndex: index,
        endIndex: index,
        coordStart: seg.c0,
        coordEnd: seg.c1,
        locationStart: seg.locationStart,
        locationEnd: seg.locationEnd,
        lenM: seg.lenM,
        flags: seg.flags || 0,
        facility: seg.facility || 0,
        official: seg.official || 0,
        mph: seg.mph || 0,
        level: seg.level || 0,
        bikeNetworkAll: isBikeNetwork(seg),
        designatedAll: isDesignated(seg),
        hazard: seg.hazard || 0,
        crossingM: seg.crossing ? Number(seg.lenM) || 0 : 0,
        failM: seg.level === 4 ? seg.lenM : 0,
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
        && previous.name === next.name) {
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
  if (step.official & 1) bits.push('WSDOT legal speed');
  else if (HIGHWAY_NAME.test(step.name) || step.mph >= 45) bits.push('highway');
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
      color: Number(seg.level) === 4 ? 'fail'
        : Number(seg.level) === 3 ? 'caution'
          : Number(seg.level) === 0 ? 'unknown'
            : isBikeNetwork(seg) ? 'bike' : 'pass',
    });
  }
  return profile;
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
  const maxSpeed = Math.max(20, Math.ceil(Math.max(...segments.map((seg) => seg.mph)) / 10) * 10);
  const padT = 10, padB = 18, padL = 6, padR = 6;
  const X = (distance) => padL + Math.min(1, Math.max(0, distance / distM)) * (w - padL - padR);
  const Y = (mph) => padT + (1 - Math.min(maxSpeed, mph) / maxSpeed) * (h - padT - padB);
  // Light horizontal guides make the speed scale readable without competing
  // with the lime and red route overlays.
  ctx.strokeStyle = 'rgba(120,140,155,.18)';
  ctx.fillStyle = '#71818c';
  ctx.font = '700 9px system-ui';
  ctx.textBaseline = 'middle';
  for (let mph = 10; mph < maxSpeed; mph += 10) {
    const y = Y(mph);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    if (mph === 10 || mph % 20 === 0) ctx.fillText(`${mph}`, padL + 3, y - 5);
  }
  const colors = {
    bike: BIKE_NETWORK_COLOR, pass: PASS_COLOR, caution: CAUTION_COLOR,
    fail: FAIL_COLOR, unknown: '#98a2ad',
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
const noRouteSummary = document.getElementById('noRouteSummary');
const alert = document.getElementById('routeAlert');

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
  pass: PASS_COLOR, designated: PASS_COLOR, bike: BIKE_NETWORK_COLOR,
  trail: BIKE_NETWORK_COLOR, caution: CAUTION_COLOR, fail: FAIL_COLOR,
  unknown: '#98a2ad',
};

function routePreviewStyle(seg) {
  if (!seg || seg.crossing === 1) return 'pass';
  if (Number(seg.level) === 4) return 'fail';
  if (Number(seg.level) === 3 || isMountainBikeTrail(seg)) return 'caution';
  if (!Number(seg.level)) return 'unknown';
  if (isBikeNetwork(seg)) return Number(seg.facility) === 5 ? 'trail' : 'bike';
  return isDesignated(seg) ? 'designated' : 'pass';
}

function routePreviewColor(seg) {
  return ROUTE_PREVIEW_STYLES[routePreviewStyle(seg)];
}

function routePreviewEdgeStyles(points) {
  const segs = details?.segs || [];
  let segmentAt = 0;
  return points.slice(0, -1).map((point, index) => {
    const routeIndex = (point.routeIndex + points[index + 1].routeIndex) / 2;
    while (segmentAt + 1 < segs.length && routeIndex >= Number(segs[segmentAt]?.c1)) segmentAt++;
    return routePreviewStyle(segs[segmentAt]);
  });
}

function routePreviewEdgeColors(points) {
  return routePreviewEdgeStyles(points).map((style) => ROUTE_PREVIEW_STYLES[style]);
}

function routePreviewRenderData() {
  const pointData = routePreviewPoints();
  const points = pointData.map((entry) => entry.point);
  const edgeStyles = routePreviewEdgeStyles(pointData);
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
  return { points, colored: { type: 'FeatureCollection', features } };
}

function initializeRoutePreviewMap() {
  const host = document.getElementById('routePreviewMap');
  const preview = routePreviewRenderData();
  if (!host || preview.points.length < 2 || !window.maplibregl) return false;
  if (routePreviewMap) { routePreviewMap.resize(); return true; }
  routePreviewMap = new maplibregl.Map({
    container: host,
    interactive: false,
    attributionControl: false,
    style: {
      version: 8,
      sources: { positron: { type: 'raster', tiles: [
        'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
        'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
        'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      ], tileSize: 256, attribution: '© OpenStreetMap contributors © CARTO' } },
      layers: [{ id: 'positron', type: 'raster', source: 'positron' }],
    },
    center: preview.points[0], zoom: 13, maxZoom: 17, maxPitch: 0,
  });
  routePreviewMap.on('load', () => {
    routePreviewMap.addSource('route-preview-all', { type: 'geojson', data: {
      type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: preview.points },
    } });
    routePreviewMap.addSource('route-preview-colored', { type: 'geojson', data: preview.colored });
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
    addRouteLayer('designated', { 'line-color': PASS_COLOR, 'line-width': 5.2, 'line-dasharray': [1.6, 1.15] });
    addRouteLayer('bike', { 'line-color': BIKE_NETWORK_COLOR, 'line-width': 4.8 });
    addRouteLayer('trail', { 'line-color': BIKE_NETWORK_COLOR, 'line-width': 5.2, 'line-dasharray': [.3, 1.1] });
    addRouteLayer('caution', { 'line-color': CAUTION_COLOR, 'line-width': 4.8 });
    addRouteLayer('fail', { 'line-color': FAIL_COLOR, 'line-width': 4.8, 'line-dasharray': [1.5, 1] });
    addRouteLayer('unknown', { 'line-color': '#98a2ad', 'line-width': 4.8 });
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
  const routeStats = routeSummaryStats(segs);
  const calculatedGrades = routeGradeStats(segs);
  const storedAvgUphillPct = Number(totals.avgUphillPct);
  const storedMaxGradePct = Number(totals.maxGradePct);
  const avgUphillPct = Number.isFinite(storedAvgUphillPct)
      && storedAvgUphillPct >= 0 && storedAvgUphillPct <= MAX_CREDIBLE_GRADE_PCT
    ? storedAvgUphillPct : calculatedGrades.avgUphillPct;
  const maxGradePct = Number.isFinite(storedMaxGradePct)
      && storedMaxGradePct >= 0 && storedMaxGradePct <= MAX_CREDIBLE_GRADE_PCT
    ? storedMaxGradePct : calculatedGrades.maxGradePct;
  const ridingM = Math.max(1, totals.distM - (totals.ferryM || 0));
  const bikePct = routePercent(routeStats.bikeNetworkM, ridingM);
  const passPct = routePercent((routeStats.levels[1] || 0) + (routeStats.levels[2] || 0), ridingM, true);
  const cautionPct = routePercent(routeStats.levels[3] || 0, ridingM, true);
  const failPct = routePercent(totals.failM || 0, ridingM, true);
  document.getElementById('routeQuickSummary').hidden = false;
  summaryCard.hidden = false;
  summary.innerHTML = `${fmtMi(totals.distM)} mi <small>· ${fmtDur(totals.timeS)}</small>`;
  summarySub.innerHTML = `<span><b>Climb:</b> ↗ ${fmtFt(totals.ascentM)} ft</span><span><b>Descent:</b> ↘ ${fmtFt(totals.descentM)} ft</span><span><b>Grades:</b> ${avgUphillPct.toFixed(1)}% avg · ${maxGradePct.toFixed(1)}% max${totals.ferryM > 0 ? ` · ⛴ ${fmtMi(totals.ferryM)} mi ferry` : ''}</span>`;
  summaryRoadSpeed.innerHTML = `<b>${routeStats.avgRoadSpeedMph == null ? 'N/A' : `${routeStats.avgRoadSpeedMph} mph`}</b><span>avg. road speed limit<br>all roads</span>`;
  summaryMix.innerHTML = `<div class="route-summary-mix-items"><span class="route-summary-mix-item"><span class="route-summary-swatch" style="background:${BIKE_NETWORK_COLOR}"></span><b>${bikePct}</b> trails / bike lanes</span><span class="route-summary-mix-item"><span class="route-summary-swatch" style="background:${PASS_COLOR}"></span><b>${passPct}</b> pass rules</span><span class="route-summary-mix-item ${routeStats.levels[3] > 0 ? 'mix-caution' : ''}"><span class="route-summary-swatch" style="background:${CAUTION_COLOR}"></span><b>${cautionPct}</b> caution</span><span class="route-summary-mix-item ${totals.failM > 0 ? 'mix-fail' : ''}"><span class="route-summary-swatch" style="background:${FAIL_COLOR}"></span><b>${failPct}</b> fail rules</span></div>`;
  const speedProfile = document.getElementById('speedProfile');
  const speedSegments = speedProfileSegments(segs);
  speedProfile.hidden = !speedSegments.length;
  if (speedSegments.length) {
    document.getElementById('speedProfileCanvas').setAttribute('aria-label',
      `Speed limits along ${fmtMi(totals.distM)} miles. Bike facilities and trails are lime, passing roads blue, cautions amber, and failing roads red.`);
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
    requestAnimationFrame(() => drawElevation(document.getElementById('elevationPreviewCanvas'), true));
  } else {
    document.getElementById('elevationPreviewEmpty').hidden = false;
  }
  const freeways = sections(segs, (s) => !!(s.flags & FLAG_FREEWAY), (s) => ({
    name: roadName(s),
    meta: [s.mph ? `${s.mph} mph` : null, 'limited-access freeway'].filter(Boolean).join(' · '),
  }));
  const limitedAccess = sections(segs,
    (s) => !(s.flags & FLAG_FREEWAY) && !!(s.flags & FLAG_LIMITED_ACCESS), (s) => ({
      name: roadName(s),
      meta: [s.mph ? `${s.mph} mph` : null, 'limited-access highway'].filter(Boolean).join(' · '),
    }));
  const highways = sections(segs, isHighway, (s) => ({
    name: roadName(s),
    meta: s.mph ? `${s.mph} mph highway` : 'Highway',
  }));
  const failing = sections(segs, (s) => s.level === 4, (s) => ({
    name: roadName(s), meta: failedRoadDetails(s, rules),
  }));
  const mountainBike = sections(segs, isMountainBikeTrail, (s) => ({
    name: roadName(s),
    meta: `Allowed mountain-bike trail · ${s.mtb ? 'OSM MTB tag' : 'OSM MTB route'}`,
  }));
  const curveHazards = sections(segs, (s) => !!s.hazard, (s) => ({
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
  }));
  const routeSteps = buildRouteSteps(segs);
  const ferries = sections(segs, (s) => !!(s.flags & FLAG_FERRY), () => ({
    name: 'Ferry crossing', meta: 'Ferry segment',
  }));

  if (totals.failM > 0) {
    // The detailed concerns immediately below state the failing distance and roads.
    alert.hidden = true;
  } else {
    alert.hidden = false;
    if (mountainBike.length || limitedAccess.length || curveHazards.length) {
      const limitedM = limitedAccess.reduce((sum, item) => sum + item.lenM, 0);
      const mountainBikeM = mountainBike.reduce((sum, item) => sum + item.lenM, 0);
      alert.classList.add('caution');
      const notes = [];
      if (mountainBikeM) notes.push(`${fmtDist(mountainBikeM)} on mountain-bike trail`);
      if (limitedM) notes.push(`${fmtDist(limitedM)} on a limited-access highway`);
      if (curveHazards.length) notes.push(`${fmtDist(curveHazards.reduce((sum, item) => sum + item.lenM, 0))} with a possible uphill-curve visibility caution`);
      alert.textContent = `${notes.join(' · ')}. These are called out for judgment but are not road-rule failures.`;
    } else {
      alert.classList.add('good');
      alert.textContent = 'No route concerns were found under your current riding rules.';
    }
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

  // Put the actionable rule violations first; road-type context follows.
  // A freeway can appear in both sections because one answers “what failed?”
  // while the other answers “what kind of road is this?”.
  if (failing.length) renderSection(report, 'Does not meet your rules', failing, '', 'fail');
  if (mountainBike.length) renderSection(report, 'Mountain-bike trails', mountainBike, '', 'caution');
  if (curveHazards.length) renderSection(report, 'Possible limited-visibility uphill curves', curveHazards, '', 'caution');
  if (freeways.length) renderSection(report, 'Freeways', freeways, '', 'freeway');
  if (limitedAccess.length) renderSection(report, 'Limited-access highways', limitedAccess, '', 'caution');
  if (highways.length) renderSection(report, 'Highways', highways, '');
  if (!freeways.length && !limitedAccess.length && !highways.length && !failing.length && !mountainBike.length
      && !curveHazards.length) {
    report.innerHTML = '<div class="no-route">No freeway, limited-access highway, highway, or rule-failing sections were found on this route.</div>';
  }
  if (Array.isArray(details.legs) && details.legs.length > 1) {
    renderSection(steps, 'Legs', details.legs.map((leg, i) => ({
      name: `Leg ${i + 1}`,
      lenM: leg.distM,
      meta: `${fmtDur(leg.timeS)}${leg.failM > 0 ? ` · ${fmtDist(leg.failM)} fails rules` : ''}`,
    })), '');
  }
  renderSection(steps, 'Follow these roads in order', routeSteps, 'No street-level steps are available for this route.', '', true);
  if (ferries.length) renderSection(steps, 'Ferry crossings', ferries, '', 'caution', true);
  restoreInitialDetailTab();
}


window.addEventListener('pagehide', saveDetailPosition);
