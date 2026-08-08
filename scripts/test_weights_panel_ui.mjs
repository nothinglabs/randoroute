#!/usr/bin/env node
// The weights panel as a rider meets it: reachable from the trip menu, every slider
// wired to the weight its label claims, and the revert affordances working.
//
// The static coverage test proves the KEYS line up. This proves the rendered
// DOM does -- that the assembled base+mode+suffix keys survive into real
// `data-weight` attributes, that dragging one writes to routingWeights, and
// that the trip-menu item opens the same dialog Settings does.
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
const pg = await (await b.newContext({ serviceWorkers: 'block', viewport: { width: 1200, height: 820 } })).newPage();
const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
await pg.goto(`http://localhost:${port}/index.html`, { waitUntil: 'load' });
await pg.waitForFunction(() => window.map && map.loaded && map.loaded(), { timeout: 30000 }).catch(() => {});
await pg.waitForTimeout(1500);

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  -- ' + x : ''}`); };

/* -------------------------------- 1. the trip-menu item opens the panel */
const btn = await pg.$('#appWeightsBtn');
check('trip menu has a weights item', !!btn);
await pg.click('#rb-more');
const visible = await pg.evaluate(() => {
  const el = document.getElementById('appWeightsBtn');
  const r = el.getBoundingClientRect();
  const menu = document.getElementById('routeMoreMenu').getBoundingClientRect();
  return { w: r.width, h: r.height, onScreen: r.top >= 0 && r.right <= innerWidth,
    insideMenu: r.left >= menu.left && r.right <= menu.right,
    menuItems: [...document.querySelectorAll('#routeMoreMenu > button')]
      .map((button) => button.lastElementChild?.textContent.trim()),
    helpRemoved: !document.getElementById('appHelpBtn'),
    noFloatingControl: !document.querySelector('body > #appWeightsBtn') };
});
check('weights item is on screen and a real menu target',
  visible.onScreen && visible.insideMenu && visible.w >= 180 && visible.h >= 40,
  JSON.stringify(visible));
check('the compact menu contains only Swap and Weights with no floating controls',
  visible.menuItems.join('|') === 'Swap start & destination|Routing weights'
    && visible.helpRemoved && visible.noFloatingControl,
  JSON.stringify(visible));

await pg.click('#appWeightsBtn');
await pg.waitForTimeout(400);
check('clicking it opens the weights dialog',
  await pg.evaluate(() => document.getElementById('weightsDialog').open));

/* --------------------------- 2. every rendered slider names a real weight */
const wired = await pg.evaluate(() => {
  const inputs = [...document.querySelectorAll('#routingWeightsEditor input[data-weight]')];
  const keys = inputs.map((i) => i.dataset.weight);
  const unknown = keys.filter((k) => !(k in DEFAULT_ROUTING_WEIGHTS));
  const missing = Object.keys(DEFAULT_ROUTING_WEIGHTS).filter((k) => !keys.includes(k));
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  // A slider whose value does not round-trip is one whose min/max/step cannot
  // express the default -- it would silently snap on first render.
  const snapped = inputs.filter((i) => Number(i.value) !== routingWeights[i.dataset.weight])
    .map((i) => `${i.dataset.weight}: shows ${i.value}, holds ${routingWeights[i.dataset.weight]}`);
  return { count: keys.length, unknown, missing, dupes, snapped };
});
check('every slider names a weight that exists', wired.unknown.length === 0, wired.unknown.join(', '));
check('every weight has a slider', wired.missing.length === 0, wired.missing.join(', '));
check('no weight has two sliders', wired.dupes.length === 0, wired.dupes.join(', '));
check('no slider snaps its value on render', wired.snapped.length === 0, wired.snapped.slice(0, 4).join(' | '));
check('the panel renders every weight', wired.count === 62, `rendered ${wired.count}`);

/* ------------------------------- 3. each cost block explains itself once */
const structure = await pg.evaluate(() => {
  const costs = [...document.querySelectorAll('.weight-cost')];
  return {
    costs: costs.length,
    noHeading: costs.filter((c) => !c.querySelector('h4')?.textContent.trim()).length,
    noHint: costs.filter((c) => !c.querySelector('.weight-hint')).length,
    groups: document.querySelectorAll('.weights-group').length,
    // Three sliders under one heading is the whole point of the regroup.
    triples: costs.filter((c) => c.querySelectorAll('input').length === 3).length,
  };
});
check('costs are described once each', structure.noHeading === 0 && structure.costs > 15,
  JSON.stringify(structure));
check('most cost blocks carry an explanation', structure.noHint <= 4,
  `${structure.noHint} without a hint`);
check('mode triples render as three sliders under one heading', structure.triples >= 8,
  `${structure.triples} triples`);

/* ------------------------------------ 4. dragging writes through, revert works */
const drag = await pg.evaluate(() => {
  const input = document.querySelector('#routingWeightsEditor input[data-weight="busyHeavyBalanced"]');
  if (!input) return { error: 'busyHeavyBalanced slider not found' };
  const before = routingWeights.busyHeavyBalanced;
  input.value = String(Number(input.max));
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const after = routingWeights.busyHeavyBalanced;
  const row = input.closest('.weight-row');
  const marked = row.classList.contains('changed');
  const revert = row.querySelector('.weight-revert');
  const revertShown = revert && !revert.hidden;
  revert.click();
  return { before, after, restored: routingWeights.busyHeavyBalanced,
    marked, revertShown, stillMarked: row.classList.contains('changed') };
});
check('dragging a slider writes to routingWeights',
  drag.after === Number(drag.after) && drag.after !== drag.before, JSON.stringify(drag));
check('a changed row is marked and offers a revert', drag.marked && drag.revertShown);
check('revert restores exactly the default',
  drag.restored === drag.before && !drag.stillMarked, JSON.stringify(drag));

/* ---- 4b. the revert sits beside the value, not on a row of its own ---- */
// The slider spans every grid column and claims its own row. Without an
// explicit position the button auto-places BELOW it, adding a third row to
// every changed control -- which is exactly what shipped and showed up on a
// phone. Presence alone did not catch it, so this checks geometry.
const revertBox = await pg.evaluate(() => {
  const input = document.querySelector('#routingWeightsEditor input[data-weight="facilityPath"]');
  // Away from the default, in whichever direction has room. Driving it to the
  // min silently did nothing on the day the default became the min, and the
  // geometry below then measured a hidden button's empty rectangle.
  input.value = String(Number(input.value) === Number(input.min)
    ? Number(input.max) : Number(input.min));
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const row = input.closest('.weight-row');
  const revert = row.querySelector('.weight-revert');
  const r = revert.getBoundingClientRect();
  const slider = input.getBoundingClientRect();
  const out = row.querySelector('output').getBoundingClientRect();
  const result = {
    aboveSlider: r.bottom <= slider.top + 1,
    sharesRowWithValue: !(r.bottom <= out.top || r.top >= out.bottom),
    rightOfValue: r.left >= out.right - 1,
    rowHeight: row.getBoundingClientRect().height,
  };
  row.querySelector('.weight-revert').click();
  return result;
});
check('revert sits on the value row, not below the slider',
  revertBox.aboveSlider && revertBox.sharesRowWithValue, JSON.stringify(revertBox));
check('revert sits to the right of the value', revertBox.rightOfValue, JSON.stringify(revertBox));
// Two rows of content: label+value+revert, then the slider. A third row means
// the button wrapped again.
check('a changed row stays two rows tall', revertBox.rowHeight < 70,
  `${revertBox.rowHeight}px`);

/* --------------------------------- 5. the tuned badge tracks off-defaults */
const badge = await pg.evaluate(() => {
  const button = document.getElementById('appWeightsBtn');
  const notice = document.getElementById('weightsModifiedNotice');
  const clean = button.classList.contains('tuned');
  const noticeClean = notice.hidden;
  const input = document.querySelector('#routingWeightsEditor input[data-weight="uphillFactor"]');
  input.value = String(Number(input.max));
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const dirty = button.classList.contains('tuned');
  const title = button.title;
  const noticeDirty = !notice.hidden && notice.textContent.includes('Weights have been modified');
  input.closest('.weight-row').querySelector('.weight-revert').click();
  return { clean, dirty, title, noticeClean, noticeDirty,
    backToClean: button.classList.contains('tuned'), noticeBackToClean: notice.hidden };
});
check('the menu item is unmarked at defaults', badge.clean === false);
check('the menu item marks itself once a weight is off default',
  badge.dirty === true && /changed/.test(badge.title), badge.title);
check('and clears again when reverted', badge.backToClean === false);
check('the page-level modified header follows the same state',
  badge.noticeClean && badge.noticeDirty && badge.noticeBackToClean, JSON.stringify(badge));

/* ------------------------------------- 6. Settings opens the same dialog */
await pg.evaluate(() => document.getElementById('weightsDialog').close());
const viaSettings = await pg.evaluate(() => {
  document.getElementById('settingsAdvancedWeightsBtn')?.click();
  return document.getElementById('weightsDialog').open;
});
check('Settings > Advanced still opens the same panel', viaSettings === true);

check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
await b.close(); s.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
