#!/usr/bin/env node
// Every settings control must be reachable on a phone.
//
// This exists because one was not. The Limits pane carried a hard
// `height: 196px` with `overflow-y: hidden`, and a comment that said why:
// "Limits has four small sliders; keep it a single stable sheet". Adding a
// fifth slider -- "Road is busier than" -- pushed "Never allow roads faster
// than" past the clip edge. It rendered, it worked, `getElementById` found it,
// and every existing test passed. It was simply invisible and untouchable, and
// the only reason it was caught is that a rider went looking for a setting they
// knew they had.
//
// A magic height encodes a control COUNT, so it is wrong the moment anyone adds
// one. Counting sliders here would repeat that mistake in test form. This
// measures the thing that actually matters instead: can a thumb reach it.
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

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  -- ' + x : ''}`); };

// Short phones are where a fixed-height pane bites first.
for (const [name, viewport] of [
  ['iPhone SE 375x667', { width: 375, height: 667 }],
  ['iPhone 16 402x874', { width: 402, height: 874 }],
]) {
  const pg = await (await b.newContext({ serviceWorkers: 'block', viewport,
    hasTouch: true, isMobile: true })).newPage();
  const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
  await pg.goto(`http://localhost:${port}/index.html`, { waitUntil: 'load' });
  await pg.waitForFunction(() => typeof routing !== 'undefined', { timeout: 60000 });
  await pg.waitForFunction(() => document.documentElement.classList.contains('app-ready'),
    { timeout: 60000 }).catch(() => {});
  await pg.evaluate(() => selectPanelTab('settings'));
  await pg.waitForTimeout(500);

  const paneHeights = [];
  for (const pane of ['presets', 'limits', 'options', 'voice']) {
    await pg.evaluate((id) => {
      document.querySelector(`[data-settings-pane="${id}"]`)?.click();
    }, pane);
    await pg.waitForTimeout(350);
    const result = await pg.evaluate(() => {
      const host = document.querySelector('.settings-pane:not([hidden])');
      if (!host) return { error: 'no visible pane' };
      const cs = getComputedStyle(host);
      const controls = [...host.querySelectorAll('input, select, button')];
      const paneBox = host.getBoundingClientRect();
      const unreachable = [];
      for (const el of controls) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        // Clipped by a pane that cannot be scrolled by a user. Programmatic
        // scrollTop still works on an overflow:hidden box, so asking "can it
        // scroll" is not the question -- asking whether the USER can is.
        const clipped = r.bottom > paneBox.bottom + 1 || r.top < paneBox.top - 1;
        const userCanScroll = cs.overflowY === 'auto' || cs.overflowY === 'scroll';
        if (clipped && !userCanScroll) {
          const row = el.closest('.rule, .rule-card, label');
          unreachable.push((row?.textContent || el.id || el.tagName).trim().slice(0, 48));
        }
      }
      return {
        overflowY: cs.overflowY,
        height: cs.height,
        scrollHeight: host.scrollHeight,
        clientHeight: host.clientHeight,
        clipsSilently: host.scrollHeight > host.clientHeight + 1
          && cs.overflowY !== 'auto' && cs.overflowY !== 'scroll',
        controls: controls.length,
        unreachable,
      };
    }, pane);
    check(`${name} / ${pane}: no control is clipped out of reach`,
      result.unreachable?.length === 0, (result.unreachable || []).join(' | '));
    check(`${name} / ${pane}: pane does not clip content it cannot scroll`,
      result.clipsSilently === false,
      `overflowY=${result.overflowY} scrollHeight=${result.scrollHeight} clientHeight=${result.clientHeight}`);
    paneHeights.push(result.clientHeight);
  }
  check(`${name}: every Settings pane matches the Limits height`,
    paneHeights.every((height) => Math.abs(height - paneHeights[1]) <= 1),
    JSON.stringify(paneHeights));

  // The specific control that went missing, by name, on every viewport.
  await pg.evaluate(() => document.querySelector('[data-settings-pane="limits"]')?.click());
  await pg.waitForTimeout(350);
  const cap = await pg.evaluate(() => {
    const el = document.getElementById('r-upperMaxSpeed');
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    const host = el.closest('.settings-pane');
    const p = host.getBoundingClientRect();
    return { found: true, insidePane: r.bottom <= p.bottom + 1 && r.top >= p.top - 1,
      onScreen: r.top >= 0 && r.bottom <= innerHeight + 1,
      label: [...document.querySelectorAll('label')]
        .find((l) => /Never allow roads faster/.test(l.textContent))?.textContent };
  });
  check(`${name}: "Never allow roads faster than" exists`, cap.found === true);
  check(`${name}: and sits inside its pane`, cap.insidePane === true, JSON.stringify(cap));
  check(`${name}: and is on screen without scrolling`, cap.onScreen === true, JSON.stringify(cap));
  check(`${name}: no page errors`, errs.length === 0, errs.slice(0, 2).join(' | '));
  await pg.close();
}

/* --------- the CSS must not re-encode a control count as a height --------- */
const css = await readFile(join(ROOT, 'styles.css'), 'utf8');
const pane = /\.settings-pane \{[^}]*\}/.exec(css)?.[0] || '';
if (/height:\s*\d+px/.test(pane) && !/min-height/.test(pane)) {
  check('settings-pane does not hard-code a height that encodes a control count',
    false, pane);
} else {
  check('settings-pane does not hard-code a height that encodes a control count', true);
}

await b.close(); s.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
