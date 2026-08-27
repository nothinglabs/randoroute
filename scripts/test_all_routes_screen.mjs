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
  combined: (routing.allCandidates || []).filter((c) =>
    c.profileId?.startsWith('combined-corridor')).map((c) => ({
      id: c.profileId, why: c.why, from: c.refinedFrom, stage: c.stage,
    })),
  frontier: (routing.allCandidates || []).filter((c) => c.sectionFrontier).map((c) => ({
    id: c.profileId, why: c.why, from: c.refinedFrom, stage: c.stage,
  })),
  combinedIdsValid: validRouteProfileId('combined-corridor')
    && validRouteProfileId('combined-corridor-2')
    && !validRouteProfileId('combined-corridor-not-a-number'),
  frontierIdsValid: validRouteProfileId('section-frontier')
    && validRouteProfileId('section-frontier-2')
    && !validRouteProfileId('section-frontier-not-a-number'),
  frontierDescription: optimizationMethodDescription({ sectionFrontier: true }),
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
check('the land cross-breeder contributes a bounded combined corridor',
  state.combined.length >= 1 && state.combined.length <= 6,
  JSON.stringify(state.combined));
check('a combined corridor reaches the six-letter chooser',
  state.combined.some((c) => state.offeredIds.includes(c.id)),
  JSON.stringify({ combined: state.combined, offered: state.offeredIds }));
check('combined corridors name both parents and explain the real junction splice',
  state.combined.every((c) => c.from?.includes('+')
    && /exact shared road junction/i.test(c.why)),
  JSON.stringify(state.combined));
check('combined-corridor profile ids survive saved and shared route validation',
  state.combinedIdsValid);
check('the generalized section frontier never contributes more than its bounded candidate set',
  state.frontier.length <= 6,
  JSON.stringify(state.frontier));
// Under the 2026-08-26 field-directed weights the frontier composite lost
// this trip's chooser ranking to the combined-corridor variants — a fair
// loss, not a filter drop. The durable contract is that a built frontier
// candidate always competes to the final ranking (offered or not-chosen),
// never dies to its own machinery (dominated/duplicate would mean the
// composition added nothing; an absent stage would mean it broke).
check('a built section-frontier route competes to the final ranking',
  state.frontier.every((c) => ['offered', 'not-chosen'].includes(c.stage)),
  JSON.stringify({ frontier: state.frontier, offered: state.offeredIds }));
check('section-frontier routes name their sources and explain exact-junction composition',
  state.frontier.every((c) => c.from?.includes('+')
    && /non-dominated sections.*exact shared road junctions/i.test(c.why)),
  JSON.stringify(state.frontier));
check('section-frontier profile ids survive saved and shared route validation',
  state.frontierIdsValid);
check('section-frontier route details explain safety-first exact-junction composition',
  /exact shared road junctions/i.test(state.frontierDescription)
    && /safety/i.test(state.frontierDescription), state.frontierDescription);

/* ------------------------------------------- the button and the screen */
// The route chooser now contains routes only. The considered-routes screen
// lives in the Settings tab strip beside the optional weights tool, and only
// wakes once a trip is routed.
const placement = await pg.evaluate(() => {
  const buttons = [...document.querySelectorAll('#routeOptions button')];
  return {
    labels: buttons.map((button) => button.textContent.trim()),
    allRoutesAbsent: !document.querySelector('#routeOptions #moreRoutesBtn'),
    obsoleteGearAbsent: !document.getElementById('routeRemixBtn'),
  };
});
check('the chooser row contains only the six lettered routes',
  placement.obsoleteGearAbsent && placement.allRoutesAbsent
    && JSON.stringify(placement.labels) === JSON.stringify(['A', 'B', 'C', 'D', 'E', 'F']),
  JSON.stringify(placement));

const settingsAccess = await pg.evaluate(() => {
  selectPanelTab('settings');
  const button = document.getElementById('moreRoutesBtn');
  return { present: !!button, enabled: !button.disabled,
    inTabs: !!button?.closest('#settingsTabs'),
    outsideWeights: !button?.closest('#settings-weights'),
    label: button?.getAttribute('aria-label') };
});
check('the Settings tabs carry the considered-routes icon, awake for this trip',
  settingsAccess.present && settingsAccess.enabled && settingsAccess.inTabs
    && settingsAccess.outsideWeights && /considered/i.test(settingsAccess.label),
  JSON.stringify(settingsAccess));
await pg.click('#moreRoutesBtn');
await pg.waitForTimeout(400);
const opened = await pg.evaluate(() => document.getElementById('allRoutesDialog').open);
check('tapping it opens the screen', opened);

const rows = await pg.evaluate(() => {
  const list = [...document.querySelectorAll('.all-route-row')];
  return list.map((r) => ({
    label: r.querySelector('strong')?.textContent,
    desc: (r.querySelector('.all-route-desc')?.textContent || '').trim(),
    hasWhy: !!r.querySelector('.all-route-why')?.textContent.trim(),
    whyLen: (r.querySelector('.all-route-why')?.textContent || '').length,
    hasStageWhy: !!r.querySelector('.all-route-stage-why'),
    offered: r.classList.contains('is-offered'),
    stats: (r.querySelector('.all-route-stats')?.textContent || '').replace(/\s+/g, ' ').trim(),
    score: (r.querySelector('.all-route-score')?.textContent || '').replace(/\s+/g, ' ').trim(),
    profileId: r.dataset.profileId,
  }));
});
check('every candidate renders a row', rows.length === state.all,
  `${rows.length} rows vs ${state.all} candidates`);
check('every row explains why it was built',
  rows.every((r) => r.hasWhy && r.whyLen > 25),
  rows.filter((r) => !r.hasWhy || r.whyLen <= 25).map((r) => r.label).join(', '));
// The character line (field ask, 2026-08-26): a short glanceable phrase per
// route, usually unique. The ceiling moved 8 -> 10 words the same day ("ok
// to use a few more words"), then 10 -> 14 on 2026-08-27 ("use another 4
// words"), then 14 -> 17 later that day: caution and traffic belong on the
// line, so up to two tails may attach within the budget. A route-defining
// climb rides outside it as its own short sentence ("elevation gain should
// be own sentence", same day), and every line now ends with a mandatory
// fails/caution clause ("always say something about presence or lack of
// fail or caution", same day), so the hard ceiling is 22.
// "Usually" is the contract - collisions fall through to a shared fallback
// rather than forcing awkward one-offs - so the uniqueness floor is 70%.
const descWords = rows.map((r) => r.desc.split(/\s+/).filter(Boolean).length);
check('every row carries a 6-22 word character line',
  rows.every((r, i) => r.desc && descWords[i] >= 6 && descWords[i] <= 22),
  rows.map((r, i) => `${r.label}: [${descWords[i]}] ${r.desc}`)
    .filter((line, i) => descWords[i] < 6 || descWords[i] > 22).join(' | '));
check('every row says something about fails and caution',
  rows.every((r) => /fail|caution/i.test(r.desc)),
  rows.filter((r) => !/fail|caution/i.test(r.desc)).map((r) => r.desc).join(' | '));
check('character lines are usually unique across the set',
  new Set(rows.map((r) => r.desc)).size >= Math.ceil(rows.length * 0.7),
  `${new Set(rows.map((r) => r.desc)).size} distinct of ${rows.length}`);
// Ferry legs sit in levelM as level 2 by design; the stat line must subtract
// them or a half-ferry trip reports "180% pass" (field: 137%, 2026-08-26).
const ferryStats = await pg.evaluate(() => candidateStatLine({
  distM: 10000, ferryM: 5000, timeS: 3600, facilityM: 0,
  levelM: [0, 0, 9000, 500, 500],
}));
check('a ferry-heavy candidate reports riding-only percentages, never over 100',
  ferryStats.pass === 80 && ferryStats.caution === 10 && ferryStats.fail === 10,
  JSON.stringify(ferryStats));
// Safety in the character lines (field, 2026-08-26): heavy failing mileage
// outranks every other trait — a 24% fail route once described only its
// speed — counts pluralize properly, and no line talks about "the search".
const safetyDescs = await pg.evaluate(() => {
  const mk = (over) => ({ distM: 16093, timeS: 3600, ferryM: 0, trailM: 0,
    facilityM: 0, residentialM: 0, desigM: 0, unpavedM: 0, ascentM: 100,
    failM: 0, levelM: [0, 0, 16093, 0, 0], ...over });
  const set = [
    mk({ profileId: 'dirty', timeS: 3000, failM: 4000, levelM: [0, 0, 10093, 2000, 4000] }),
    mk({ profileId: 'one', failM: 1609, levelM: [0, 0, 12484, 2000, 1609] }),
    mk({ profileId: 'clean' }),
  ];
  const descs = candidateRouteDescriptions(set);
  return { dirty: descs.get('dirty'), one: descs.get('one'), clean: descs.get('clean') };
});
check('a heavy-fail route leads with the failure share, even when quickest',
  /% of this fails your safety rules — 1\.2 miles caution/.test(safetyDescs.dirty),
  JSON.stringify(safetyDescs));
check('a single failing mile reads singular in the safety clause',
  /1 mile fail, 1\.2 miles caution/.test(safetyDescs.one), JSON.stringify(safetyDescs));
check('a clean route says so outright',
  /no fails or caution/.test(safetyDescs.clean), JSON.stringify(safetyDescs));
check('descriptions never talk about the search itself',
  !/search/i.test(Object.values(safetyDescs).join(' ')), JSON.stringify(safetyDescs));
// The extra-fact tail (field, 2026-08-27): a clean quick route with real
// trail mileage spends its wider budget on a second fact instead of
// stopping at one, and stays within 17 words.
const enriched = await pg.evaluate(() => {
  const mk = (over) => ({ distM: 16093, timeS: 3600, ferryM: 0, trailM: 0,
    facilityM: 0, residentialM: 0, desigM: 0, unpavedM: 0, ascentM: 100,
    failM: 0, levelM: [0, 0, 16093, 0, 0], ...over });
  const set = [
    mk({ profileId: 'quick', timeS: 3000, trailM: 6437, facilityM: 6437 }),
    mk({ profileId: 'plain', distM: 17000 }),
  ];
  const d = candidateRouteDescriptions(set);
  return { quick: d.get('quick'), plain: d.get('plain') };
});
const quickWords = enriched.quick.split(/\s+/).filter(Boolean).length;
check('a composition line carries a second fact within the 17-word budget',
  /, (with|climbing|plus)/.test(enriched.quick) && quickWords > 10 && quickWords <= 17,
  JSON.stringify({ ...enriched, quickWords }));
// The mandatory safety clause (field ask, 2026-08-27: always say
// something about presence or lack of fails and caution): fail-clean
// routes with caution say both, crossing-sized fails read as a count, a
// route-defining climb is its own trailing sentence, and caution that is
// mostly official traffic stress says so.
const cautionAndHills = await pg.evaluate(() => {
  const mk = (over) => ({ distM: 32187, timeS: 7200, ferryM: 0, trailM: 0,
    facilityM: 0, residentialM: 0, desigM: 0, unpavedM: 0, ascentM: 100,
    failM: 0, levelM: [0, 0, 24140, 8047, 0], ...over });
  const set = [
    mk({ profileId: 'cleanish', ascentM: 700 }),
    mk({ profileId: 'dirty', timeS: 7000, failM: 5000,
      levelM: [0, 0, 19140, 8047, 5000] }),
    mk({ profileId: 'traffic', timeS: 7100, highStressM: 6437,
      trafficCautionM: 6437 }),
    mk({ profileId: 'passing', timeS: 7150, highStressM: 12875,
      levelM: [0, 0, 32187, 0, 0] }),
    mk({ profileId: 'dabs', timeS: 7160, ascentM: 700, failM: 260,
      failRunCount: 2, failRunLongestM: 100,
      levelM: [0, 0, 31927, 0, 260] }),
  ];
  const d = candidateRouteDescriptions(set);
  return { cleanish: d.get('cleanish'), dirty: d.get('dirty'),
    traffic: d.get('traffic'), passing: d.get('passing'),
    dabs: d.get('dabs') };
});
check('a fail-clean route with caution states both plainly',
  /no fails, 5 miles caution/.test(cautionAndHills.cleanish),
  JSON.stringify(cautionAndHills));
check('a route-defining climb is its own trailing sentence',
  /\. Climbs 2300 feet$/.test(cautionAndHills.cleanish),
  JSON.stringify(cautionAndHills));
check('fail and caution miles ride every line that needs them',
  /3\.1 miles fail, 5 miles caution/.test(cautionAndHills.dirty),
  JSON.stringify(cautionAndHills));
check('caution that is mostly official traffic stress says so',
  /5 miles caution, mostly heavy traffic/.test(cautionAndHills.traffic),
  JSON.stringify(cautionAndHills));
// Field, 2026-08-27: four car markers on a "meets rules" stretch and the
// line said nothing about traffic — the official rating is reported at
// every level, so long high-stress stretches are named even when they pass.
check('long high-stress stretches are named even when the rules pass them',
  /with 8 miles in heavy traffic/.test(cautionAndHills.passing),
  JSON.stringify(cautionAndHills));
check('crossing-sized fails read as a count, not vanishing mileage',
  /just 2 short fails, no caution/.test(cautionAndHills.dabs),
  JSON.stringify(cautionAndHills));
// Phone-width geometry: inserting the character line once knocked the stats
// into the thumbnail grid column, blowing every row wider than the screen
// (field screenshot, 2026-08-26). Title and stats must share the content
// column, clear of the sketch, with no horizontal overflow.
await pg.setViewportSize({ width: 390, height: 840 });
const phoneLayout = await pg.evaluate(() => {
  const row = document.querySelector('.all-route-row');
  const head = row.querySelector('.all-route-head');
  const stats = row.querySelector('.all-route-stats');
  const thumb = row.querySelector('.all-route-thumb');
  const body = document.querySelector('.all-routes-body');
  return {
    bodyOverflow: body.scrollWidth - body.clientWidth,
    headLeft: Math.round(head.getBoundingClientRect().left),
    statsLeft: Math.round(stats.getBoundingClientRect().left),
    thumbRight: Math.round(thumb.getBoundingClientRect().right),
  };
});
check('phone width keeps rows column-aligned with no horizontal overflow',
  phoneLayout.bodyOverflow <= 0 && phoneLayout.headLeft === phoneLayout.statsLeft
    && phoneLayout.headLeft >= phoneLayout.thumbRight, JSON.stringify(phoneLayout));
await pg.setViewportSize({ width: 1280, height: 900 });
check('every discarded row explains what dropped it',
  rows.filter((r) => !r.offered).every((r) => r.hasStageWhy),
  rows.filter((r) => !r.offered && !r.hasStageWhy).map((r) => r.label).join(', '));
check('rows carry distance and the safety levels',
  rows.every((r) => /mi/.test(r.stats) && /pass/.test(r.stats)
    && /caution/.test(r.stats) && /fail/.test(r.stats)),
  rows[0]?.stats);
check('every row shows the actual suggestion score and its weighted components',
  rows.every((r) => /Suggestion score/.test(r.score) && /travel/.test(r.score)
    && /fails/.test(r.score) && /walk/.test(r.score)
    && /ordinary roads/.test(r.score) && /trails/.test(r.score)),
  rows[0]?.score);
check('the recommended row explains why it received the star',
  rows.some((r) => /Starred/.test(r.score)), rows.find((r) => /Starred/.test(r.score))?.score);

/* ----------------------------- the meta summary and choice comparators -- */
const summary = await pg.evaluate(() => {
  const meta = document.querySelector('.all-routes-meta');
  const text = (meta?.textContent || '').replace(/\s+/g, ' ').trim();
  const stageOf = new Map((routing.allCandidates || []).map((c) => [c.profileId, c.stage]));
  const labels = new Set((routing.allCandidates || []).map((c) => c.label));
  const rowsByStage = [...document.querySelectorAll('.all-route-row')].map((r) => ({
    stage: stageOf.get(r.dataset.profileId),
    stageWhy: (r.querySelector('.all-route-stage-why:last-of-type')?.textContent || '')
      .replace(/\s+/g, ' ').trim(),
    similarity: (r.querySelector('.all-route-stage-why')?.textContent || '')
      .replace(/\s+/g, ' ').trim(),
  }));
  return { text, rowsByStage, labels: [...labels] };
});
check('a meta summary leads the list with built and offered counts',
  new RegExp(`${state.all} routes built`).test(summary.text)
    && new RegExp(`${state.offered} offered`).test(summary.text), summary.text);
check('the summary spans the corpus: distance, time, and rules-pass ranges',
  /Distance [\d.]+–[\d.]+ mi/.test(summary.text)
    && /time \d+h\d+–\d+h\d+/.test(summary.text)
    && /passing your rules \d+–\d+%/.test(summary.text), summary.text);
check('the summary names the recommended route and its basis',
  /Recommended: .+ — Starred/.test(summary.text), summary.text);
const named = (line) => summary.labels.some((label) => line.includes(label));
const offeredRows = summary.rowsByStage.filter((r) => r.stage === 'offered');
check('every offered row reports its closest boardmate with a shared-road score',
  offeredRows.length >= 2 && offeredRows.every((r) =>
    /Similarity: closest to .+ \d+% shared roads/.test(r.similarity) && named(r.similarity)),
  JSON.stringify(offeredRows.find((r) => !/Similarity/.test(r.similarity))));
const dupRows = summary.rowsByStage.filter((r) => r.stage === 'duplicate');
check('duplicate rows name their twin and the shared fraction',
  dupRows.every((r) => /same roads as .+ — \d+% shared/.test(r.stageWhy) && named(r.stageWhy)),
  JSON.stringify(dupRows.find((r) => !/% shared/.test(r.stageWhy))));
const domRows = summary.rowsByStage.filter((r) => r.stage === 'dominated');
check('dominated rows name who covers them and by how much',
  domRows.every((r) => /covers this corridor \(\d+% shared\)/.test(r.stageWhy)),
  JSON.stringify(domRows.find((r) => !/covers this corridor/.test(r.stageWhy))));
const slowRows = summary.rowsByStage.filter((r) => r.stage === 'too-slow');
check('too-slow rows carry the time comparison',
  slowRows.every((r) => /against the quickest \d+h\d+ \([\d.]+×\)/.test(r.stageWhy)),
  JSON.stringify(slowRows.find((r) => !/against the quickest/.test(r.stageWhy))));
const nearRows = summary.rowsByStage.filter((r) => r.stage === 'not-chosen');
check('not-chosen rows point at their closest offered route',
  nearRows.every((r) => /Closest offered route: .+, \d+% shared/.test(r.stageWhy)),
  JSON.stringify(nearRows.find((r) => !/Closest offered route/.test(r.stageWhy))));

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
    settingsOpen: settingsMenuIsOpen(),
    // The rider-visible claim: the Route tab is showing again. The weights
    // PANE's hidden flag is Settings-internal bookkeeping -- with Settings
    // itself closed it shows nothing, and it legitimately stays the active
    // pane so reopening Settings returns where the rider left.
    routeTabActive: document.getElementById('tab-route').classList.contains('active'),
    hasGeometry: (routing.last?.segs || []).length > 0,
    inChooser: routing.options.some((o) => o.optimization?.profileId === routing.last?.optimization?.profileId),
  }));
  check('tapping a discarded route returns to the main map',
    after.dialogOpen === false && after.settingsOpen === false && after.routeTabActive === true,
    JSON.stringify(after));
  check('and loads that exact route', after.active === target.profileId,
    `wanted ${target.profileId}, got ${after.active} (was ${before})`);
  check('with real geometry, not just a summary', after.hasGeometry);
  check('and it joins the chooser so you can switch back', after.inChooser);
}

/* -------- fresh lineups: a refinement re-letters, selection follows letter */
// The frozen-lineup system is gone by field decision: a refinement (road
// block included) generates, sorts and letters its portfolio normally, and
// continuity is the SELECTION -- the rider's letter is re-selected in the
// fresh lineup, falling to the last letter when the lineup is shorter.
await pg.evaluate(() => {
  document.querySelector('#routeOptions button[data-route-option="0"]')?.click();
});
const beforeBlock = await pg.evaluate(() => ({
  letter: (routing.last?.optimization?.label || '').replace(/^Route /, ''),
}));
await pg.evaluate(() => addRoadBlock({ lng: -122.28, lat: 47.80 }));
await pg.waitForFunction(() => routing.routeRequestActive === false
  && !document.getElementById('routeOptions')?.classList.contains('loading'),
null, { timeout: 300000 });
const afterBlock = await pg.evaluate(() => ({
  letters: routing.options.map((option) =>
    (option.optimization?.label || '').replace(/^Route /, '')),
  selectedLetter: (routing.last?.optimization?.label || '').replace(/^Route /, ''),
  selectedIsOffered: routing.options.includes(routing.last),
  greyedSlots: document.querySelectorAll('#routeOptions button.route-option-missing').length,
}));
check('a road block re-letters the portfolio normally, with no greyed slots',
  afterBlock.letters.length >= 1 && afterBlock.greyedSlots === 0
    && afterBlock.letters.every((letter, i) => letter === String.fromCharCode(65 + i)),
  JSON.stringify(afterBlock));
check('and the selection follows the letter: the same one, or the closest',
  afterBlock.selectedIsOffered
    && (afterBlock.selectedLetter === beforeBlock.letter
      || (!afterBlock.letters.includes(beforeBlock.letter)
        && afterBlock.selectedLetter === afterBlock.letters.at(-1))),
  JSON.stringify({ before: beforeBlock, after: afterBlock }));

check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
await b.close(); s.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
