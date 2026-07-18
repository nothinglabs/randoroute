const ROUTE_DETAILS_KEY = 'wa-bike-route-details-1';
const ROUTE_DETAILS_POSITION_KEY = 'wa-bike-route-details-position-1';
const FLAG_FACILITY = 2;
const FLAG_FREEWAY = 4;
const FLAG_INFRA = 8;
const FLAG_FERRY = 32;
const FLAG_DESIGNATED = 64;
const FLAG_LIMITED_ACCESS = 128;
const OFFICIAL_MTB = 4;
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

if (window.self !== window.top) document.body.classList.add('embedded');

function fmtMi(m) { return (m / 1609.34).toFixed(1); }
function fmtFt(m) { return Math.round(m * 3.28084).toLocaleString(); }
function fmtDist(m) { return m < 160.934 ? `${fmtFt(m)} ft` : `${fmtMi(m)} mi`; }
function fmtDur(s) {
  const min = Math.round(s / 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} m`;
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
    if (last && previousIndex === i - 1 && last.key === key) {
      last.lenM += itemLenM;
      last.endIndex = i;
      if (info.coordEnd != null) last.coordEnd = info.coordEnd;
    } else out.push({ key, name: info.name, meta: info.meta, lenM: itemLenM,
      startIndex: i, endIndex: i, coordStart: info.coordStart, coordEnd: info.coordEnd,
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
      last.flags |= seg.flags || 0;
      last.facility = Math.max(last.facility || 0, seg.facility || 0);
      last.official |= seg.official || 0;
      last.mph = Math.max(last.mph, seg.mph || 0);
      last.level = Math.max(last.level, seg.level || 0);
      last.bikeNetworkAll = last.bikeNetworkAll && isBikeNetwork(seg);
      last.designatedAll = last.designatedAll && isDesignated(seg);
      last.hazard = Math.max(last.hazard || 0, seg.hazard || 0);
      if (seg.level === 4) last.failM += seg.lenM;
    } else {
      out.push({
        name,
        startIndex: index,
        endIndex: index,
        lenM: seg.lenM,
        flags: seg.flags || 0,
        facility: seg.facility || 0,
        official: seg.official || 0,
        mph: seg.mph || 0,
        level: seg.level || 0,
        bikeNetworkAll: isBikeNetwork(seg),
        designatedAll: isDesignated(seg),
        hazard: seg.hazard || 0,
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
      previous.facility = Math.max(previous.facility || 0, bridge.facility || 0, next.facility || 0);
      previous.official |= (bridge.official || 0) | (next.official || 0);
      previous.mph = Math.max(previous.mph, bridge.mph, next.mph);
      previous.level = Math.max(previous.level, bridge.level, next.level);
      previous.bikeNetworkAll = previous.bikeNetworkAll
        && bridge.bikeNetworkAll && next.bikeNetworkAll;
      previous.designatedAll = previous.designatedAll
        && bridge.designatedAll && next.designatedAll;
      previous.hazard = Math.max(previous.hazard || 0, bridge.hazard || 0, next.hazard || 0);
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
  // The canvas has zero size while its panel is hidden — draw after reveal.
  if (tabId === 'elevation') requestAnimationFrame(drawElevation);
}

function drawElevation() {
  const canvas = document.getElementById('elevationCanvas');
  const profile = details?.profile;
  const distM = details?.summary?.distM;
  if (!canvas || canvas.hidden || !Array.isArray(profile) || profile.length < 2 || !(distM > 0)) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300, h = canvas.clientHeight || 220;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  let lo = Infinity, hi = -Infinity;
  for (const [, e] of profile) { if (e < lo) lo = e; if (e > hi) hi = e; }
  if (hi - lo < 30) { const mid = (hi + lo) / 2; lo = mid - 15; hi = mid + 15; }
  const padT = 24, padB = 26, padL = 8, padR = 8;
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
  ctx.beginPath();
  ctx.moveTo(X(profile[0][0]), Y(profile[0][1]));
  for (const [d, e] of profile) ctx.lineTo(X(d), Y(e));
  ctx.strokeStyle = '#2c7bb6';
  ctx.lineWidth = 1.8;
  ctx.stroke();
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
  if (!document.getElementById('panel-elevation')?.hidden) drawElevation();
});

function selectedDetailTab() {
  return document.querySelector('[data-detail-tab][aria-selected="true"]')?.dataset.detailTab || 'concerns';
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
    selectDetailTab(['concerns', 'steps', 'elevation'].includes(state.tab) ? state.tab : 'concerns');
    requestAnimationFrame(() => window.scrollTo(0, Math.max(0, Number(state.scrollY) || 0)));
    return true;
  } catch (e) { return false; }
}

const details = loadDetails();
const hasRoute = !!(details && details.summary && Array.isArray(details.segs));
const report = document.getElementById('report');
const steps = document.getElementById('steps');
const summary = document.getElementById('summary');
const optimization = document.getElementById('optimization');
const alert = document.getElementById('routeAlert');
const mapTapHint = document.getElementById('mapTapHint');

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
  summary.textContent = 'No current route.';
  report.innerHTML = '<div class="no-route">Set a start and destination on the map to see freeways, highways, and any road-rule concerns here.</div>';
  steps.innerHTML = '<div class="no-route">Set a start and destination on the map to see the road-by-road route steps here.</div>';
  const elevationEmpty = document.getElementById('elevationEmpty');
  elevationEmpty.hidden = false;
  elevationEmpty.textContent = 'Set a start and destination on the map to see the elevation profile here.';
  if (!restoreDetailPosition()) selectDetailTab('concerns');
} else {
  const { rules = {}, summary: totals, segs } = details;
  mapTapHint.hidden = false;
  if (Array.isArray(details.profile) && details.profile.length >= 2) {
    const elevationSummary = document.getElementById('elevationSummary');
    elevationSummary.hidden = false;
    elevationSummary.textContent = `${fmtMi(totals.distM)} mi · ↗ ${fmtFt(totals.ascentM)} ft climb · ↘ ${fmtFt(totals.descentM)} ft descent`;
    document.getElementById('elevationCanvas').hidden = false;
  } else {
    const elevationEmpty = document.getElementById('elevationEmpty');
    elevationEmpty.hidden = false;
    elevationEmpty.textContent = 'The elevation profile will appear here after the route is next recalculated.';
  }
  summary.textContent = `${fmtMi(totals.distM)} mi · ${fmtDur(totals.timeS)} · ${fmtFt(totals.ascentM)} ft climb`;
  if (details.optimization?.description) {
    optimization.hidden = false;
    optimization.textContent = `${details.optimization.label || 'Selected option'}: ${details.optimization.description}`;
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
      s.gradePct > 0 ? `${s.gradePct}% climb` : null,
      s.mph ? `${s.mph} mph` : null,
      s.sh >= 0 ? `${s.sh} ft shoulder` : 'shoulder unknown',
    ].filter(Boolean).join(' · '),
    coordStart: s.hazC0 ?? s.c0, coordEnd: s.hazC1 ?? s.c1,
    lenM: s.hazardLenM || s.lenM,
  }));
  const routeSteps = buildRouteSteps(segs);
  const ferries = sections(segs, (s) => !!(s.flags & FLAG_FERRY), () => ({
    name: 'Ferry crossing', meta: 'Ferry segment',
  }));

  if (totals.failM > 0) {
    alert.hidden = false;
    const freewayM = freeways.reduce((sum, item) => sum + item.lenM, 0);
    alert.textContent = `${freewayM ? `${fmtDist(freewayM)} on a freeway. ` : ''}${fmtDist(totals.failM)} of this route does not meet your riding rules.`;
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
  if (Number(details.snapStartM) > 80) snapNotes.push(`the start pin connects to the riding network ${fmtDist(details.snapStartM)} away`);
  if (Number(details.snapEndM) > 80) snapNotes.push(`the destination pin connects to the riding network ${fmtDist(details.snapEndM)} away`);
  if (snapNotes.length) {
    const note = document.createElement('p');
    note.className = 'snap-note';
    note.textContent = `Heads up: ${snapNotes.join(', and ')}. Move the pin closer to a road if that looks wrong.`;
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
  if (!restoreDetailPosition()) selectDetailTab('concerns');
}


window.addEventListener('pagehide', saveDetailPosition);
