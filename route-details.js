const ROUTE_DETAILS_KEY = 'wa-bike-route-details-1';
const FLAG_FACILITY = 2;
const FLAG_FREEWAY = 4;
const FLAG_INFRA = 8;
const FLAG_FERRY = 32;
const FLAG_LIMITED_ACCESS = 128;
const HIGHWAY_NAME = /\b(highway|state route|sr\s*\d|us\s*(?:route\s*)?\d|i-?\s*\d)\b/i;

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
  const reasons = [];
  if (f & FLAG_FREEWAY) reasons.push('limited-access freeway — last resort only');
  let shoulder = seg.sh;
  if (shoulder < 0 && rules.unknownShoulderZero) shoulder = 0;
  if (!(f & FLAG_FACILITY) && shoulder >= 0 && shoulder < rules.minShoulder) {
    reasons.push(seg.sh < 0 ? 'shoulder is unknown and treated as 0 ft' : `${shoulder} ft shoulder is below your ${rules.minShoulder} ft minimum`);
  }
  if (!rules.noUpperLimit && seg.mph > rules.upperMaxSpeed) {
    reasons.push(`${seg.mph} mph is above your ${rules.upperMaxSpeed} mph maximum`);
  }
  return reasons.length ? reasons.join(' · ') : 'does not meet your selected riding rules';
}

// Consecutive edges with the same meaning become one useful, named report
// entry. This turns a 500 ft freeway merge into a single readable line.
function sections(segs, include, describe) {
  const out = [];
  let previousIndex = -2;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (!include(seg)) { previousIndex = -2; continue; }
    const info = describe(seg);
    const key = `${info.name}\u0000${info.meta}`;
    const last = out[out.length - 1];
    if (last && previousIndex === i - 1 && last.key === key) last.lenM += seg.lenM;
    else out.push({ key, name: info.name, meta: info.meta, lenM: seg.lenM });
    previousIndex = i;
  }
  return out;
}

function renderSection(host, title, items, emptyText, cls = '') {
  const total = items.reduce((sum, item) => sum + item.lenM, 0);
  const section = document.createElement('section');
  section.className = `detail-section ${cls}`;
  section.innerHTML = `<h2>${title}<span>${items.length ? fmtDist(total) : 'None'}</span></h2>`;
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = emptyText;
    section.appendChild(empty);
  } else {
    const list = document.createElement('ul');
    list.className = 'detail-list';
    for (const item of items) {
      const li = document.createElement('li');
      li.className = `detail-item ${cls}`;
      li.innerHTML = `<div class="line"><span>${item.name}</span><span class="distance">${fmtDist(item.lenM)}</span></div><div class="meta">${item.meta}</div>`;
      list.appendChild(li);
    }
    section.appendChild(list);
  }
  host.appendChild(section);
}

function loadDetails() {
  try { return JSON.parse(localStorage.getItem(ROUTE_DETAILS_KEY) || 'null'); } catch (e) { return null; }
}

const details = loadDetails();
const report = document.getElementById('report');
const summary = document.getElementById('summary');
const alert = document.getElementById('routeAlert');

if (!details || !details.summary || !Array.isArray(details.segs)) {
  summary.textContent = 'No current route is available.';
  report.innerHTML = '<div class="no-route">Plan a route on the map, then use “Route concerns & highlights” to see its road-by-road report.</div>';
} else {
  const { rules = {}, summary: totals, segs } = details;
  summary.textContent = `${fmtMi(totals.distM)} mi · ${fmtDur(totals.timeS)} · ${fmtFt(totals.ascentM)} ft climb`;
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
    name: roadName(s), meta: failReason(s, rules),
  }));

  if (totals.failM > 0) {
    alert.hidden = false;
    const freewayM = freeways.reduce((sum, item) => sum + item.lenM, 0);
    alert.textContent = `${freewayM ? `${fmtDist(freewayM)} on a freeway. ` : ''}${fmtDist(totals.failM)} of this route does not meet your riding rules.`;
  } else {
    alert.hidden = false;
    if (limitedAccess.length) {
      const limitedM = limitedAccess.reduce((sum, item) => sum + item.lenM, 0);
      alert.classList.add('caution');
      alert.textContent = `${fmtDist(limitedM)} on a limited-access highway. It meets your current riding rules, but is shown as a caution.`;
    } else {
      alert.classList.add('good');
      alert.textContent = 'No route concerns were found under your current riding rules.';
    }
  }

  // This page is intentionally a short concern report, not a route inventory.
  if (freeways.length) renderSection(report, 'Freeways', freeways, '', 'freeway');
  if (limitedAccess.length) renderSection(report, 'Limited-access highways', limitedAccess, '', 'caution');
  if (highways.length) renderSection(report, 'Highways', highways, '');
  if (failing.length) renderSection(report, 'Does not meet your rules', failing, '', 'fail');
  if (!freeways.length && !limitedAccess.length && !highways.length && !failing.length) {
    report.innerHTML = '<div class="no-route">No freeway, limited-access highway, highway, or rule-failing sections were found on this route.</div>';
  }
}
