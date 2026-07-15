const ROUTE_DETAILS_KEY = 'wa-bike-route-details-1';
const ROUTE_DETAILS_POSITION_KEY = 'wa-bike-route-details-position-1';
const FLAG_FACILITY = 2;
const FLAG_FREEWAY = 4;
const FLAG_INFRA = 8;
const FLAG_FERRY = 32;
const FLAG_DESIGNATED = 64;
const FLAG_LIMITED_ACCESS = 128;
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
const SAFETY_NAME = { 1: 'Comfy', 2: 'Meets rules', 3: 'Caution', 4: 'Fails rules' };

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
  const facts = [];
  if (seg.mph > 0) {
    const source = seg.official & 1 ? 'WSDOT' : flags & 1 ? 'estimated' : null;
    facts.push(`${seg.mph} mph speed limit${source ? ` (${source})` : ''}`);
  } else {
    facts.push('speed limit unknown');
  }
  facts.push(seg.sh >= 0 ? `${seg.sh} ft shoulder` : 'shoulder unknown');
  if (FACILITY_NAME[seg.facility]) {
    facts.push(`${FACILITY_NAME[seg.facility]}${seg.official & 2 ? ' (WSDOT)' : ''}`);
  }
  if (flags & FLAG_FREEWAY) facts.push('freeway');
  else if (flags & FLAG_LIMITED_ACCESS) facts.push('limited-access highway');
  else if (ROAD_CLASS_NAME[seg.roadClass]) facts.push(ROAD_CLASS_NAME[seg.roadClass]);
  facts.push(`Fails: ${failReason(seg, rules)}`);
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
      safetyLabel: info.safetyLabel || '' });
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
      if (item.level) li.classList.add(`safety-l${item.level}`);
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
      previous.hazard = Math.max(previous.hazard || 0, bridge.hazard || 0, next.hazard || 0);
      previous.failM += bridge.failM + next.failM;
      out.splice(i, 2);
    } else {
      i++;
    }
  }
  return out.map((step) => ({
    ...step,
    safetyLabel: SAFETY_NAME[step.level] || 'Unknown',
    meta: `${stepMeta(step)} · Tap to show on map`,
  }));
}

function stepMeta(step) {
  const flags = step.flags || 0;
  const bits = [];
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
    if (['concerns', 'steps', 'tips'].includes(state.tab)) selectDetailTab(state.tab);
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
  summary.textContent = 'No current route — start with the routing tips.';
  report.innerHTML = '<div class="no-route">Set a start and destination on the map to see freeways, highways, and any road-rule concerns here.</div>';
  steps.innerHTML = '<div class="no-route">Set a start and destination on the map to see the road-by-road route steps here.</div>';
  if (!restoreDetailPosition()) selectDetailTab('tips');
} else {
  const { rules = {}, summary: totals, segs } = details;
  summary.textContent = `${fmtMi(totals.distM)} mi · ${fmtDur(totals.timeS)} · ${fmtFt(totals.ascentM)} ft climb${totals.stress?.grade ? ` · Stress grade ${totals.stress.grade}` : ''}`;
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
    name: roadName(s), meta: `${failedRoadDetails(s, rules)} · Tap to show on map`,
  }));
  const curveHazards = sections(segs, (s) => !!s.hazard, (s) => ({
    name: roadName(s),
    meta: `Possible limited-visibility uphill curve · ${s.gradePct > 0 ? `${s.gradePct}% net climb · ` : ''}${s.mph ? `${s.mph} mph · ` : ''}${s.sh >= 0 ? `${s.sh} ft shoulder` : 'shoulder unknown'} · geometry/elevation estimate, not measured sight distance · Tap to show on map`,
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
    if (limitedAccess.length || curveHazards.length) {
      const limitedM = limitedAccess.reduce((sum, item) => sum + item.lenM, 0);
      alert.classList.add('caution');
      const notes = [];
      if (limitedM) notes.push(`${fmtDist(limitedM)} on a limited-access highway`);
      if (curveHazards.length) notes.push(`${fmtDist(curveHazards.reduce((sum, item) => sum + item.lenM, 0))} with a possible uphill-curve visibility caution`);
      alert.textContent = `${notes.join(' · ')}. These are called out for judgment but are not road-rule failures.`;
    } else {
      alert.classList.add('good');
      alert.textContent = 'No route concerns were found under your current riding rules.';
    }
  }

  // Put the actionable rule violations first; road-type context follows.
  // A freeway can appear in both sections because one answers “what failed?”
  // while the other answers “what kind of road is this?”.
  if (failing.length) renderSection(report, 'Does not meet your rules', failing, '', 'fail');
  if (curveHazards.length) renderSection(report, 'Possible limited-visibility uphill curves', curveHazards, '', 'caution');
  if (freeways.length) renderSection(report, 'Freeways', freeways, '', 'freeway');
  if (limitedAccess.length) renderSection(report, 'Limited-access highways', limitedAccess, '', 'caution');
  if (highways.length) renderSection(report, 'Highways', highways, '');
  if (!freeways.length && !limitedAccess.length && !highways.length && !failing.length
      && !curveHazards.length) {
    report.innerHTML = '<div class="no-route">No freeway, limited-access highway, highway, or rule-failing sections were found on this route.</div>';
  }
  renderSection(steps, 'Follow these roads in order', routeSteps, 'No street-level steps are available for this route.', '', true);
  if (ferries.length) renderSection(steps, 'Ferry crossings', ferries, '', 'caution', true);
  if (!restoreDetailPosition()) selectDetailTab('concerns');
}


window.addEventListener('pagehide', saveDetailPosition);
