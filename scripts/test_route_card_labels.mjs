#!/usr/bin/env node
// Does the route card's legend actually FIT on a phone?
//
// The suite used to answer this by searching app.js for the label string,
// which proves only that somebody typed it. "Trusted Bike Lanes" was typed,
// and shipped rendered as "Trusted Bike La..." -- the assertion passed the
// whole time. Truncation is a rendered property, so measure it: lay the card
// out at real phone widths and compare each label's scrollWidth against the
// box it was given.
import { appPage, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};

// A route card with every category present, rendered through the real builder
// so the measurement is of the shipped markup and the shipped CSS.
const show = () => page.evaluate(() => {
  const metrics = {
    ok: true,
    distM: 25260, timeS: 5100, segs: [], coords: [],
    levelM: [0, 12000, 4000, 1000, 500], ferryM: 0, failM: 500,
    categoryM: { trail: 12000, bike: 4000, pass: 3000, caution: 1000, fail: 500 },
    maxGradePct: 6, unpavedM: 0, inclineOver5M: 900,
  };
  renderRouteCard(metrics);
  const card = document.getElementById('routeCard');
  card.hidden = false;
  return [...card.querySelectorAll('.rc-category-item')].map((row) => {
    const label = row.querySelector('span:last-child');
    return {
      text: label.textContent,
      scroll: label.scrollWidth,
      client: label.clientWidth,
      cardOverflow: card.scrollWidth - card.clientWidth,
    };
  });
});

// 390 is an iPhone 14/15; 375 an SE/13 mini; 360 the narrowest Android in wide
// use. All three have to show the label whole.
for (const width of [430, 390, 375, 360]) {
  await page.setViewportSize({ width, height: 860 });
  const rows = await show();
  check(`the card renders five category rows at ${width}px`, rows.length === 5,
    JSON.stringify(rows.map((r) => r.text)));
  for (const row of rows) {
    // 1px of slack for sub-pixel rounding; anything more is a clipped glyph.
    check(`"${row.text}" fits at ${width}px`, row.scroll <= row.client + 1,
      `needs ${row.scroll}px, has ${row.client}px`);
  }
  // The legend's own column, not the whole card: #routeControls (the A-E
  // chooser) overhangs the card by 12px at every width and has done since
  // before these labels existed. That is a real defect but a different one,
  // and rolling it in here would make this file fail for a reason it does not
  // test.
  const listOverflow = await page.evaluate(() => {
    const list = document.querySelector('#routeCard .rc-category-list');
    const card = document.getElementById('routeCard');
    if (!list || !card) return null;
    return Math.round(list.getBoundingClientRect().right
      - card.getBoundingClientRect().right);
  });
  check(`the legend stays inside the card at ${width}px`, listOverflow <= 1,
    `overhangs by ${listOverflow}px`);
}

// The term a rider first meets in Layers is the full phrase, and that list has
// the room for it.
const legend = await page.evaluate(() => {
  const hit = [...document.querySelectorAll('#tab-layers label, #tab-layers .rule-check')]
    .map((n) => n.textContent.replace(/\s+/g, ' ').trim())
    .find((t) => /trusted bike lane/i.test(t));
  return hit || null;
});
check('the Layers legend names trusted bike lanes in full', !!legend, String(legend));

check('no page errors', page.pageErrors.length === 0, page.pageErrors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
