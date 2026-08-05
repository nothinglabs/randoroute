#!/usr/bin/env node
// The "More" screen: every candidate the portfolio built, offered or discarded,
// with the reason it exists and the reason it was dropped.
//
// This is a troubleshooting view, so the properties that matter are about
// HONESTY rather than polish:
//
//   1. It lists strictly more than the five offered routes, or the button
//      should not be there at all.
//   2. Every offered route appears, so the list is the whole portfolio and not
//      a separate pile of rejects.
//   3. Every row says why it was built AND, if dropped, what dropped it. A row
//      with no explanation is worse than no row.
//   4. Tapping a DISCARDED route actually loads it -- that path goes through
//      the worker's portfolio cache, not the five already in hand, so it is the
//      one that can silently do nothing.
// Playwright is installed globally in this container, not under the project, so
// resolving it is the harness's job rather than each test file's.
import { playwright, chromiumPath } from './testlib/harness.mjs';
const { chromium } = await playwright();
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const T = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.gz': 'application/gzip', '.png': 'image/png', '.pmtiles': 'application/octet-stream', '.bin': 'application/octet-stream', '.pbf': 'application/octet-stream' };
const s = createServer(async (q, r) => {
  try {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    const full = join(ROOT, p); const st = await stat(full);
    const ct = T[extname(p)] || 'application/octet-stream';
    const range = q.headers.range;
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (m) {
        const a = +m[1], b2 = m[2] ? +m[2] : st.size - 1;
        const buf = (await readFile(full)).subarray(a, b2 + 1);
        r.writeHead(206, { 'content-type': ct, 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${b2}/${st.size}`, 'content-length': buf.length });
        return r.end(buf);
      }
    }
    const d = await readFile(full);
    r.writeHead(200, { 'content-type': ct, 'accept-ranges': 'bytes' }); r.end(d);
  } catch { r.writeHead(404); r.end('x'); }
});
await new Promise((r) => s.listen(0, r));
const port = s.address().port;
const b = await chromium.launch({ executablePath: chromiumPath(), args: ['--use-gl=swiftshader'] });
const pg = await (await b.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } })).newPage();
const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
await pg.goto(`http://localhost:${port}/index.html`, { waitUntil: 'load' });
// Generous on purpose. Six browser files run concurrently under software GL,
// so startup here competes for CPU with five other Chromiums; a wait tuned for
// an idle machine fails on a busy one and reads as a bug in the app.
pg.setDefaultTimeout(180000);
await pg.waitForFunction(() => window.map && map.loaded && map.loaded(), { timeout: 120000 }).catch(() => {});
await pg.waitForFunction(() => typeof routing !== 'undefined' && routing.ready, { timeout: 180000 });

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  -- ' + x : ''}`); };

// A trip long enough that the portfolio discards candidates.
await pg.evaluate(() => {
  routing.start = [-122.3321, 47.6062];
  routing.end = [-122.29704, 47.95067];
  computeRoute();
});
await pg.waitForFunction(() => routing.options?.length > 0 && !routing.routeRequestActive,
  { timeout: 180000 });
await pg.waitForTimeout(800);

const state = await pg.evaluate(() => ({
  offered: routing.options.length,
  all: (routing.allCandidates || []).length,
  key: !!routing.candidatesKey,
  stages: (routing.allCandidates || []).map((c) => c.stage),
  labels: (routing.allCandidates || []).map((c) => c.label),
  offeredIds: routing.options.map((o) => o.optimization?.profileId),
  allIds: (routing.allCandidates || []).map((c) => c.profileId),
}));
check('the portfolio reports more candidates than it offers',
  state.all > state.offered, `${state.all} built, ${state.offered} offered`);
check('a candidates key came through for the fetch path', state.key);
check('every offered route is in the list',
  state.offeredIds.every((id) => state.allIds.includes(id)),
  `offered ${state.offeredIds} vs all ${state.allIds}`);
check('no duplicate profile ids in the list',
  new Set(state.allIds).size === state.allIds.length, state.allIds.join(','));
// Letters must be unique or a rider cannot name what they are looking at.
check('every candidate has a distinct label',
  new Set(state.labels).size === state.labels.length, state.labels.join(' | '));
check('offered candidates are marked offered',
  state.stages.filter((x) => x === 'offered').length === state.offered,
  state.stages.join(','));

/* ------------------------------------------- the button and the screen */
// The chooser's tail is the route-mix "⋮" button; the considered-routes
// screen lives on the WEIGHTS page now, beside the rest of the router's
// workings, and only wakes once a trip is routed.
const placement = await pg.evaluate(() => {
  const remix = document.getElementById('routeRemixBtn');
  const buttons = [...document.querySelectorAll('#routeOptions button')];
  const lastLetter = buttons[buttons.indexOf(remix) - 1];
  const paint = (el) => el && getComputedStyle(el).backgroundColor;
  return {
    inChooser: !!remix && !document.querySelector('#routeOptions #moreRoutesBtn'),
    last: buttons[buttons.length - 1] === remix,
    rightOfLetters: remix.getBoundingClientRect().left >= lastLetter.getBoundingClientRect().left,
    distinct: paint(remix) !== paint(lastLetter),
    label: remix?.textContent.trim(),
  };
});
check('the chooser row ends with the route-mix ⋮ button, and only that',
  placement.inChooser && placement.last && placement.rightOfLetters
    && placement.label === '⋮', JSON.stringify(placement));
check('styled apart from the lettered routes', placement.distinct);

const weights = await pg.evaluate(() => {
  openRoutingWeights();
  const button = document.getElementById('moreRoutesBtn');
  return { present: !!button, enabled: !button.disabled,
    label: button?.textContent.trim() };
});
check('the weights page carries the considered-routes button, awake for this trip',
  weights.present && weights.enabled && /considered/i.test(weights.label),
  JSON.stringify(weights));
await pg.click('#moreRoutesBtn');
await pg.waitForTimeout(400);
const opened = await pg.evaluate(() => document.getElementById('allRoutesDialog').open);
check('tapping it opens the screen', opened);

const rows = await pg.evaluate(() => {
  const list = [...document.querySelectorAll('.all-route-row')];
  return list.map((r) => ({
    label: r.querySelector('strong')?.textContent,
    hasWhy: !!r.querySelector('.all-route-why')?.textContent.trim(),
    whyLen: (r.querySelector('.all-route-why')?.textContent || '').length,
    hasStageWhy: !!r.querySelector('.all-route-stage-why'),
    offered: r.classList.contains('is-offered'),
    stats: (r.querySelector('.all-route-stats')?.textContent || '').replace(/\s+/g, ' ').trim(),
    profileId: r.dataset.profileId,
  }));
});
check('every candidate renders a row', rows.length === state.all,
  `${rows.length} rows vs ${state.all} candidates`);
check('every row explains why it was built',
  rows.every((r) => r.hasWhy && r.whyLen > 25),
  rows.filter((r) => !r.hasWhy || r.whyLen <= 25).map((r) => r.label).join(', '));
check('every discarded row explains what dropped it',
  rows.filter((r) => !r.offered).every((r) => r.hasStageWhy),
  rows.filter((r) => !r.offered && !r.hasStageWhy).map((r) => r.label).join(', '));
check('rows carry distance and the safety levels',
  rows.every((r) => /mi/.test(r.stats) && /pass/.test(r.stats)
    && /caution/.test(r.stats) && /fail/.test(r.stats)),
  rows[0]?.stats);

/* ------------------------------- thumbnails are drawn and comparable ---- */
// The sketches share one bounding box on purpose: these are all routes between
// the same two points, so per-row autoscaling would normalise away exactly the
// difference the picture exists to show. Two routes of very different length
// must therefore produce visibly different path extents.
const thumbs = await pg.evaluate(() => {
  const rows = [...document.querySelectorAll('.all-route-row')];
  return rows.map((r) => {
    const svg = r.querySelector('.all-route-thumb');
    const base = svg?.querySelector('.thumb-base');
    const box = base?.getBBox?.();
    return {
      hasSvg: !!svg,
      hasPath: !!base && (base.getAttribute('d') || '').length > 20,
      w: box ? Math.round(box.width) : 0,
      h: box ? Math.round(box.height) : 0,
      dots: svg ? svg.querySelectorAll('circle').length : 0,
      nan: (base?.getAttribute('d') || '').includes('NaN'),
      viewBox: svg?.getAttribute('viewBox'),
      d: base?.getAttribute('d') || '',
    };
  });
});
check('every row draws a thumbnail', thumbs.every((t) => t.hasSvg && t.hasPath),
  JSON.stringify(thumbs.find((t) => !t.hasSvg || !t.hasPath)));
check('no thumbnail has NaN coordinates', thumbs.every((t) => !t.nan));
check('each thumbnail marks a start and an end',
  thumbs.every((t) => t.dots === 2), thumbs.map((t) => t.dots).join(','));
check('thumbnails share one viewBox',
  new Set(thumbs.map((t) => t.viewBox)).size === 1, thumbs[0]?.viewBox);
// Routes between the same two points share endpoints -- and, under weights
// that pull every profile toward the same trail corridor, often share their
// cross-axis extent too. Five genuinely different Mukilteo routes (16-93%
// shared points) all spanned 23 px here, their real widths within 150 m of
// each other over an 11 km band. A bounding box cannot see HOW a route
// wanders inside the band, so compare the drawn geometry itself: the offered
// candidates are meaningfully-different routes by the portfolio's own
// dedupe, and each must arrive as its own distinct polyline. (Discarded
// rows are excluded: literal duplicates rightly draw identically.)
const offeredThumbs = thumbs.filter((t, i) => rows[i]?.offered);
const distinctPaths = new Set(offeredThumbs.map((t) => t.d)).size;
check('routes that wander differently draw differently',
  offeredThumbs.length >= 2 && distinctPaths === offeredThumbs.length,
  `${distinctPaths} distinct paths among ${offeredThumbs.length} offered thumbnails`);
// Aspect. Seattle -> Mukilteo is ~0.34 degrees north-south against ~0.04 east
// -west, so every sketch must be clearly TALLER than it is wide. This is the
// assertion that catches a sheared projection: mixing degrees on one axis with
// Mercator radians on the other drew this trip as a horizontal sliver, and
// every other check here still passed.
const upright = thumbs.filter((t) => t.h > t.w * 1.5).length;
check('a north-south trip draws taller than wide',
  upright === thumbs.length,
  thumbs.map((t) => `${t.w}x${t.h}`).join(' '));

// Measured against the viewBox each thumbnail actually declares, not against
// inlined numbers. This assertion used to hardcode the 96x72 box and so failed
// the moment the preview was resized, which says nothing about overflow.
const [boxW, boxH] = (thumbs[0]?.viewBox || '0 0 0 0').split(' ').slice(2).map(Number);
const overflowing = thumbs.filter((t) => t.w > boxW + 1 || t.h > boxH + 1);
check('no thumbnail overflows its box',
  boxW > 0 && boxH > 0 && overflowing.length === 0,
  overflowing.length ? JSON.stringify(overflowing) : `box ${boxW}x${boxH}`);

/* -------------------- tapping a DISCARDED route actually loads it ------- */
const target = await pg.evaluate(() => {
  const offeredIds = new Set(routing.options.map((o) => o.optimization?.profileId));
  const row = [...document.querySelectorAll('.all-route-row')]
    .find((r) => !offeredIds.has(r.dataset.profileId));
  if (!row) return null;
  return { profileId: row.dataset.profileId, label: row.querySelector('strong').textContent };
});
check('there is a discarded route to try', !!target, JSON.stringify(target));
if (target) {
  const before = await pg.evaluate(() => routing.last?.optimization?.profileId);
  await pg.evaluate((id) => {
    [...document.querySelectorAll('.all-route-row')]
      .find((r) => r.dataset.profileId === id).click();
  }, target.profileId);
  await pg.waitForFunction((id) => !document.getElementById('allRoutesDialog').open
    && routing.last?.optimization?.profileId === id, target.profileId, { timeout: 30000 })
    .catch(() => {});
  const after = await pg.evaluate(() => ({
    active: routing.last?.optimization?.profileId,
    dialogOpen: document.getElementById('allRoutesDialog').open,
    hasGeometry: (routing.last?.segs || []).length > 0,
    inChooser: routing.options.some((o) => o.optimization?.profileId === routing.last?.optimization?.profileId),
  }));
  check('tapping a discarded route closes the screen', after.dialogOpen === false);
  check('and loads that exact route', after.active === target.profileId,
    `wanted ${target.profileId}, got ${after.active} (was ${before})`);
  check('with real geometry, not just a summary', after.hasGeometry);
  check('and it joins the chooser so you can switch back', after.inChooser);
}

/* --------- the frozen lineup: a refinement keeps letters and recipes ----- */
// The chooser policy: letters pin to search recipes for the life of a trip.
// A road block re-runs the SAME recipes under the SAME letters -- including
// the considered-routes pick parked above -- and keeps the selected route, so
// the rider sees what their change did instead of a reshuffled portfolio.
await pg.evaluate(() => {
  document.querySelector('#routeOptions button[data-route-option="0"]')?.click();
});
const beforePin = await pg.evaluate(() => ({
  pin: routing.pinnedLetters.map((entry) => ({ ...entry })),
  selected: routing.last?.optimization?.profileId,
}));
check('the trip carries a pinned lineup, grown by the considered-routes pick',
  beforePin.pin.length >= 6 && !!beforePin.selected, JSON.stringify(beforePin));
await pg.evaluate(() => addRoadBlock({ lng: -122.28, lat: 47.80 }));
await pg.waitForFunction(() => routing.lastRequestPinned === true
  && !document.getElementById('routeOptions')?.classList.contains('loading'),
{ timeout: 300000 });
const afterPin = await pg.evaluate(() => ({
  pin: routing.pinnedLetters.map((entry) => ({ ...entry })),
  selected: routing.last?.optimization?.profileId,
  missing: routing.missingLetters,
  chooserLetters: [...document.querySelectorAll('#routeOptions button[data-route-option] span, #routeOptions button.route-option-missing span')]
    .map((span) => span.textContent.trim()),
}));
check('a road block keeps every letter bound to its recipe',
  JSON.stringify(afterPin.pin) === JSON.stringify(beforePin.pin), JSON.stringify(afterPin));
check('and keeps the selected route selected',
  afterPin.selected === beforePin.selected
    || afterPin.missing.some((entry) => entry.profileId === beforePin.selected),
  JSON.stringify({ before: beforePin.selected, after: afterPin.selected, missing: afterPin.missing }));
check('every pinned letter renders, routable or not',
  afterPin.chooserLetters.length >= afterPin.pin.length,
  JSON.stringify(afterPin.chooserLetters));

check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
await b.close(); s.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
