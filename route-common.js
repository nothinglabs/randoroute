/*
 * Facts and formatters shared by the three route consumers -- the main app
 * (app.js), the Route Details page (route-details.js), and the router worker
 * (router-worker.js via importScripts). Plain script, plain globals, like
 * palette.js and marker-icons.js: no module system in the app.
 *
 * Everything here used to exist as two or three hand-kept copies, and the
 * grade math had already drifted (the details page recomputed maxGradePct
 * unrounded, so a route at 18.04% tripped the steep warning on one screen
 * and not the other). One home now; agreement is structural.
 */

/* ---- the worker segment's bitfields, named once ---- */
const FLAG_FACILITY = 2;
const FLAG_FREEWAY = 4;
const FLAG_INFRA = 8;
const FLAG_FERRY = 32;
const FLAG_DESIGNATED = 64;
const FLAG_LIMITED_ACCESS = 128;
const OFFICIAL_MTB = 4;
const OFFICIAL_DISMOUNT = 8;
const OFFICIAL_SIDEWALK = 16;
const OFFICIAL_SIDEWALK_NO = 32;
const OFFICIAL_URBAN = 64;
const OFFICIAL_DISMOUNT_TAG = 128;
const PROHIBITED_SHOULDER = -128;

const SURFACE_LABEL = ['Unknown', 'Paved', 'Gravel / compacted', 'Unpaved'];
const ROUTE_CATEGORY_KEYS = ['trail', 'bike', 'pass', 'caution', 'fail'];
// The five category rows as every surface renders them, labels included.
const ROUTE_CATEGORY_LABELS = [
  ['trail', 'Trails'],
  ['bike', 'Trusted Bike Lane'],
  ['pass', 'Passes Rules'],
  ['caution', 'Needs Caution'],
  ['fail', 'Fails Rules'],
];
const HIGHWAY_NAME = /\b(highway|state route|sr\s*\d|us\s*(?:route\s*)?\d|i-?\s*\d)\b/i;
const SIGNIFICANT_UNPAVED_M = 1609.344;
// Above this sustained grade the route card and the details page both raise
// the steep-grade warning. It was a bare `> 18` in four places.
const STEEP_GRADE_WARNING_PCT = 18;
// The stored route the two pages exchange through localStorage.
const ROUTE_DETAILS_KEY = 'wa-bike-route-details-1';

/* ---- grade credibility, one ruling ---- */
// The graph carries grade on fragments only a few meters long, where ordinary
// one-meter elevation quantization turns into impossible values (180%).
// Report only grades sustained over enough horizontal distance to be
// meaningful, and reject obvious DEM artifacts.
const MIN_REPORTED_GRADE_M = 20;
const MAX_CREDIBLE_GRADE_PCT = 40;
// A single 20 m graph edge can still reflect a small DEM step. Route maxima
// therefore use the steepest sustained 100 m of riding instead.
const SUSTAINED_GRADE_WINDOW_M = 100;

function isConfirmedUnpavedSurface(surface) {
  const value = Number(surface);
  return value === 2 || value === 3;
}

function isDismountSegment(segment) {
  return !!segment?.dismount || !!((segment?.official || 0) & OFFICIAL_DISMOUNT);
}

// Only the dismounts a mapper wrote down (bicycle=dismount) warn out loud --
// the Dismount mileage, the voice, the preview markers. The walk links the
// graph build synthesises from untagged footways price and report identically
// otherwise, but a warning at every park-path connector would teach riders to
// ignore the marker that matters.
//
// Both bits, not just the tag bit: 128 meant "bridge or tunnel" in the graph
// one data version back, and a route stored under that graph would otherwise
// read its bridges as dismounts until the rider next routes.
function isTaggedDismountSegment(segment) {
  const need = OFFICIAL_DISMOUNT | OFFICIAL_DISMOUNT_TAG;
  return (((segment?.official || 0) & need) === need);
}

function credibleSegmentGradePct(seg) {
  const grade = Number(seg?.gradePct);
  const len = Number(seg?.lenM);
  if (!Number.isFinite(grade) || !Number.isFinite(len)
      || len < MIN_REPORTED_GRADE_M || Math.abs(grade) > MAX_CREDIBLE_GRADE_PCT) return 0;
  return grade;
}

function sustainedUphillGradeSamples(segs) {
  const samples = [];
  const window = [];
  let windowM = 0;
  let windowRiseM = 0;
  for (let index = 0; index < (segs || []).length; index++) {
    const seg = segs[index];
    if ((seg.flags || 0) & FLAG_FERRY) {
      window.length = 0;
      windowM = 0;
      windowRiseM = 0;
      continue;
    }
    const lenM = Number(seg.lenM) || 0;
    if (!(lenM > 0)) continue;
    const gradePct = credibleSegmentGradePct(seg);
    window.push({ index, lenM, gradePct });
    windowM += lenM;
    windowRiseM += lenM * gradePct / 100;
    while (windowM > SUSTAINED_GRADE_WINDOW_M && window.length) {
      const first = window[0];
      const trimM = Math.min(windowM - SUSTAINED_GRADE_WINDOW_M, first.lenM);
      first.lenM -= trimM;
      windowM -= trimM;
      windowRiseM -= trimM * first.gradePct / 100;
      if (first.lenM <= .001) window.shift();
    }
    if (windowM >= SUSTAINED_GRADE_WINDOW_M && window.length) {
      samples.push({ startIndex: window[0].index, endIndex: index,
        gradePct: 100 * windowRiseM / windowM, lenM: windowM });
    }
  }
  return samples;
}

function routeGradeStats(segs) {
  let uphillM = 0;
  let uphillRiseM = 0;
  for (const seg of segs || []) {
    if ((seg.flags || 0) & FLAG_FERRY) continue;
    const grade = credibleSegmentGradePct(seg);
    const len = Number(seg.lenM) || 0;
    if (grade > 0.5 && len > 0) {
      uphillM += len;
      uphillRiseM += len * grade / 100;
    }
  }
  const maxGradePct = sustainedUphillGradeSamples(segs)
    .reduce((max, sample) => Math.max(max, sample.gradePct), 0);
  // Rounded to 0.1 here, in the ONE place these numbers are made: the stored
  // copy and any recomputed copy feed the same display and the same
  // STEEP_GRADE_WARNING_PCT comparison.
  return {
    avgUphillPct: uphillM > 0 ? Math.round(10 * 100 * uphillRiseM / uphillM) / 10 : 0,
    maxGradePct: Math.round(10 * maxGradePct) / 10,
  };
}

/* ---- formatters ---- */
const fmtMi = (m) => (m / 1609.34).toFixed(1);
// A tenth of a mile stops carrying information once the number reaches double
// digits: "24.3 mi of gravel" is precision the underlying surface data does not
// have, and it reads as a measurement rather than an estimate.
const fmtMiles = (m) => {
  const miles = m / 1609.34;
  return miles >= 10 ? String(Math.round(miles)) : miles.toFixed(1);
};
const fmtFt = (m) => Math.round(m * 3.28084).toLocaleString();
const fmtDist = (m) => m < 160.934 ? `${fmtFt(m)} ft` : `${fmtMi(m)} mi`;
function fmtDur(s) {
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} m`;
}

function routePercent(meters, total, preciseSmall = false) {
  if (!(meters > 0) || !(total > 0)) return '0%';
  const pct = Math.min(100, 100 * meters / total);
  if (preciseSmall && pct < 0.1) return '<0.1%';
  if (preciseSmall && pct < 1) return `${pct.toFixed(1)}%`;
  if (preciseSmall && pct > 99 && pct < 100) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

// Whole-number percentages are easier to scan in the compact route chooser.
// Allocate rounding remainders as a group so the five displayed values always
// add to exactly 100. A category with real distance keeps at least 1%, avoiding
// a misleading "0%" beside a visible short amber or red segment.
function routeCategoryPercentages(categoryM) {
  const total = ROUTE_CATEGORY_KEYS.reduce((sum, key) => sum + (Number(categoryM?.[key]) || 0), 0);
  const out = Object.fromEntries(ROUTE_CATEGORY_KEYS.map((key) => [key, 0]));
  if (!(total > 0)) return out;
  const rows = ROUTE_CATEGORY_KEYS.map((key, index) => {
    const meters = Math.max(0, Number(categoryM?.[key]) || 0);
    const raw = 100 * meters / total;
    return { key, index, meters, raw, value: meters > 0 ? Math.max(1, Math.floor(raw)) : 0 };
  });
  let assigned = rows.reduce((sum, row) => sum + row.value, 0);
  while (assigned < 100) {
    const row = [...rows].sort((a, b) =>
      (b.raw - b.value) - (a.raw - a.value) || a.index - b.index)[0];
    row.value++; assigned++;
  }
  while (assigned > 100) {
    const row = [...rows].filter((candidate) => candidate.value > (candidate.meters > 0 ? 1 : 0))
      .sort((a, b) => (b.value - b.raw) - (a.value - a.raw) || b.value - a.value)[0];
    if (!row) break;
    row.value--; assigned--;
  }
  for (const row of rows) out[row.key] = row.value;
  return out;
}

function googleStreetViewUrl(lat, lng, heading = null) {
  const headingParam = Number.isFinite(heading) ? `&heading=${Math.round(heading)}` : '';
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat.toFixed(6)},${lng.toFixed(6)}${headingParam}`;
}
