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
import { chromium } from 'playwright';
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
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-gl=swiftshader'] });
const pg = await (await b.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } })).newPage();
const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
await pg.goto(`http://localhost:${port}/index.html`, { waitUntil: 'load' });
await pg.waitForFunction(() => window.map && map.loaded && map.loaded(), { timeout: 40000 }).catch(() => {});
await pg.waitForFunction(() => typeof routing !== 'undefined' && routing.ready, { timeout: 60000 });

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
const btn = await pg.$('#moreRoutesBtn');
check('a More button sits after the offered routes', !!btn);
const placement = await pg.evaluate(() => {
  const more = document.getElementById('moreRoutesBtn');
  const buttons = [...document.querySelectorAll('#routeOptions button')];
  const last = buttons[buttons.length - 1];
  const prev = buttons[buttons.length - 2];
  return { isLast: last === more,
    rightOfPrev: more.getBoundingClientRect().left >= prev.getBoundingClientRect().left,
    distinct: getComputedStyle(more).backgroundColor
      !== getComputedStyle(prev).backgroundColor };
});
check('More comes after the last route', placement.isLast && placement.rightOfPrev);
check('More is styled apart from the lettered routes', placement.distinct);

await pg.click('#moreRoutesBtn');
await pg.waitForTimeout(400);
const opened = await pg.evaluate(() => document.getElementById('allRoutesDialog').open);
check('tapping More opens the screen', opened);

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

check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
await b.close(); s.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
