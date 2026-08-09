#!/usr/bin/env node
import { chromiumPath, playwright, serveRepo } from './testlib/harness.mjs';

const { chromium } = await playwright();
const site = await serveRepo();
const browser = await chromium.launch({
  executablePath: chromiumPath(),
  args: ['--use-gl=swiftshader'],
});
const context = await browser.newContext({
  serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
}

await page.goto(site.url, { waitUntil: 'load' });
await page.waitForFunction(() => typeof openHelp === 'function', { timeout: 60000 });

const topics = ['getting-started', 'routes', 'layers', 'settings', 'save-share', 'technical'];
const populated = await page.evaluate((expected) => expected.map((topic) => {
  const tab = document.querySelector(`[data-help-tab="${topic}"]`);
  const panel = tab && document.getElementById(tab.getAttribute('aria-controls'));
  return { topic, children: panel?.childElementCount || 0 };
}), topics);
check('every help tab has its existing content', populated.every((item) => item.children > 0),
  JSON.stringify(populated));

const entryPoints = [
  ['routeTipsBtn', 'routes'],
  ['routeIncompleteTipsBtn', 'routes'],
  ['navTipsBtn', 'routes'],
  ['layersHelpBtn', 'layers'],
  ['settingsHelpBtn', 'settings'],
  ['routesHelpBtn', 'save-share'],
];
for (const [buttonId, topic] of entryPoints) {
  const result = await page.evaluate(({ buttonId: id, topic: expected }) => {
    const help = document.getElementById('helpDialog');
    if (help.open) help.close();
    if (id === 'routesHelpBtn') document.getElementById('routesDialog').showModal();
    document.getElementById(id).click();
    const tab = document.querySelector(`[data-help-tab="${expected}"]`);
    const panel = document.getElementById(tab.getAttribute('aria-controls'));
    return {
      open: help.open,
      selected: tab.getAttribute('aria-selected'),
      visible: !panel.hidden,
    };
  }, { buttonId, topic });
  check(`${buttonId} opens ${topic}`, result.open && result.selected === 'true' && result.visible,
    JSON.stringify(result));
}

const technical = await page.evaluate(() => {
  openHelp('getting-started');
  document.getElementById('techDetailsBtn').click();
  const tab = document.querySelector('[data-help-tab="technical"]');
  return {
    selected: tab.getAttribute('aria-selected'),
    title: document.getElementById('helpDialogTitle').textContent,
    panelVisible: !document.getElementById(tab.getAttribute('aria-controls')).hidden,
  };
});
check('Tech Details stays inside Help and selects its tab',
  technical.selected === 'true' && technical.panelVisible && technical.title === 'Technical details',
  JSON.stringify(technical));

await page.evaluate(() => openHelp('getting-started'));
await page.focus('#helpTabGettingStarted');
await page.keyboard.press('ArrowRight');
check('arrow keys switch tabs', await page.evaluate(() =>
  document.getElementById('helpTabRoutes').getAttribute('aria-selected') === 'true'));

await page.evaluate(() => openHelp('settings'));
const layout = await page.evaluate(() => {
  const dialog = document.getElementById('helpDialog').getBoundingClientRect();
  const head = document.querySelector('#helpDialog > .full-help-head').getBoundingClientRect();
  const tabs = document.getElementById('helpTabs');
  const tabBox = tabs.getBoundingClientRect();
  const panels = document.getElementById('helpPanels');
  const panelBox = panels.getBoundingClientRect();
  const tabBoxes = [...tabs.querySelectorAll('[data-help-tab]')]
    .map((tab) => tab.getBoundingClientRect());
  return {
    dialog: { top: dialog.top, right: dialog.right, bottom: dialog.bottom, left: dialog.left },
    ordered: head.bottom <= tabBox.top + 1 && tabBox.bottom <= panelBox.top + 1,
    tabsAllVisible: tabBoxes.every((box) => box.left >= tabBox.left - 1
      && box.right <= tabBox.right + 1 && box.top >= tabBox.top - 1 && box.bottom <= tabBox.bottom + 1),
    tabRows: new Set(tabBoxes.map((box) => Math.round(box.top))).size,
    articleScrollable: panels.scrollHeight > panels.clientHeight
      && ['auto', 'scroll'].includes(getComputedStyle(panels).overflowY),
    cautionRows: document.querySelectorAll('#cautionCauseList li').length,
  };
});
check('the help view remains inside the phone viewport',
  layout.dialog.top >= 0 && layout.dialog.left >= 0
    && layout.dialog.right <= 390 && layout.dialog.bottom <= 844,
  JSON.stringify(layout.dialog));
check('header, tabs, and article do not overlap', layout.ordered, JSON.stringify(layout));
check('all six tabs are visible without horizontal swiping',
  layout.tabsAllVisible && layout.tabRows === 2, JSON.stringify(layout));
check('only the long active article scrolls vertically', layout.articleScrollable, JSON.stringify(layout));
check('settings cautions render when its tab is selected', layout.cautionRows > 0,
  `rendered ${layout.cautionRows}`);
check('the page has no JavaScript errors', errors.length === 0, errors.join(' | '));

await context.close();
await browser.close();
site.close();

console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
