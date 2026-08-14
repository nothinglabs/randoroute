#!/usr/bin/env node
// The six help topics live in one dialog with one tab strip, instead of six
// separate dialogs. This checks that in the built page: which tabs exist, that
// each one really has content behind it, that the remaining entry points around the
// app land on the right tab, and that none of the old dialogs are still there.
//
// It used to check the same things by matching regular expressions against
// index.html, app.js and styles.css -- `/settingsHelpBtn[\s\S]{0,160}
// openHelp\('settings'\)/` and friends. Those pass on a comment, fail on a
// rename, and say nothing about whether the button opens anything. The layout
// claims they made about the stylesheet are measured in
// test_unified_help_ui.mjs, against the rendered box.
import { chromiumPath, playwright, serveRepo } from './testlib/harness.mjs';

const { chromium } = await playwright();
const site = await serveRepo();
const browser = await chromium.launch({
  executablePath: chromiumPath(), args: ['--use-gl=swiftshader'],
});
const page = await (await browser.newContext({
  serviceWorkers: 'block', viewport: { width: 390, height: 844 },
  hasTouch: true, isMobile: true,
})).newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};

await page.goto(site.url, { waitUntil: 'load' });
await page.waitForFunction(() => typeof openHelp === 'function', { timeout: 60000 });

const TOPICS = ['getting-started', 'routes', 'layers', 'settings', 'save-share', 'technical'];

const structure = await page.evaluate(() => ({
  dialogs: document.querySelectorAll('dialog#helpDialog').length,
  tabs: [...document.querySelectorAll('[data-help-tab]')].map((tab) => tab.dataset.helpTab),
  // A panel with no children is a tab that opens onto nothing, which is what a
  // renamed template id would produce.
  panels: [...document.querySelectorAll('.help-panel[data-help-source]')].map((panel) => ({
    source: panel.dataset.helpSource,
    children: panel.childElementCount,
    words: panel.textContent.trim().split(/\s+/).length,
  })),
}));
check('all help topics share one dialog', structure.dialogs === 1, `${structure.dialogs} found`);
check('the tab strip carries every topic, in a stable order',
  structure.tabs.join(',') === TOPICS.join(','), structure.tabs.join(','));
check('every tab has real content behind it', structure.panels.length === TOPICS.length
  && structure.panels.every((panel) => panel.children > 0 && panel.words > 20),
  JSON.stringify(structure.panels));

const accuracy = await page.evaluate(() => {
  const copy = (topic) => document.querySelector(`[data-help-tab="${topic}"]`)
    ?.getAttribute('aria-controls');
  const text = (topic) => document.getElementById(copy(topic))?.textContent
    .replace(/\s+/g, ' ').trim() || '';
  return {
    gettingStarted: text('getting-started'),
    routes: text('routes'),
    layers: text('layers'),
    settings: text('settings'),
    advancedButton: !!document.getElementById('settingsAdvancedWeightsBtn'),
  };
});
check('Getting started describes both actions offered by generic Find',
  accuracy.gettingStarted.includes('Map') && accuracy.gettingStarted.includes('Route It'),
  accuracy.gettingStarted.slice(0, 240));
check('route help points ferry controls at Routing weights > Route options',
  accuracy.routes.includes('Routing weights') && accuracy.routes.includes('Route options')
    && !accuracy.routes.includes('Advanced routing →'), accuracy.routes.slice(0, 300));
check('route help distinguishes a rule failure from an impassable prohibition',
  accuracy.routes.includes('separate pale prohibited overlay')
    && accuracy.routes.includes('never routed'), accuracy.routes.slice(-700));
check('Layers help is portable across states and explains the icon guide',
  accuracy.layers.includes('State transportation data')
    && accuracy.layers.includes('Route Icons')
    && !accuracy.layers.includes('WSDOT'), accuracy.layers.slice(0, 500));
check('Settings help documents current voice and advanced controls without a weights launcher',
  accuracy.settings.includes('Keep the screen awake while navigating')
    && accuracy.settings.includes('Announce route safety levels')
    && accuracy.settings.includes('Show advanced options and routing weights')
    && !accuracy.advancedButton,
  accuracy.settings.slice(-600));

// The remaining contextual ways into help each land on their own topic. The
// Getting started topic remains in the tab strip without occupying map UI.
const ENTRY_POINTS = [
  ['routeTipsBtn', 'routes'],
  ['routeIncompleteTipsBtn', 'routes'],
  ['navTipsBtn', 'routes'],
  ['layersHelpBtn', 'layers'],
  ['settingsHelpBtn', 'settings'],
  ['routesHelpBtn', 'save-share'],
  ['techDetailsBtn', 'technical'],
];
for (const [buttonId, topic] of ENTRY_POINTS) {
  const result = await page.evaluate((id) => {
    document.getElementById('helpDialog')?.close();
    const button = document.getElementById(id);
    if (!button) return { missing: true };
    button.click();
    const dialog = document.getElementById('helpDialog');
    const selected = [...document.querySelectorAll('[data-help-tab]')]
      .find((tab) => tab.getAttribute('aria-selected') === 'true');
    const panel = selected && document.getElementById(selected.getAttribute('aria-controls'));
    return {
      open: !!dialog?.open,
      topic: selected?.dataset.helpTab || null,
      visible: !!panel && !panel.hidden,
      title: document.getElementById('helpDialogTitle')?.textContent || '',
    };
  }, buttonId);
  check(`${buttonId} opens help on "${topic}"`,
    !result.missing && result.open && result.topic === topic && result.visible && result.title,
    JSON.stringify(result));
}
await page.evaluate(() => document.getElementById('helpDialog')?.close());

// The old dialogs are gone -- not merely unreferenced in the markup, but not
// in the document at all, and not reachable from the app either.
const legacy = await page.evaluate(() => ['appHelpDialog', 'routeTipsDialog',
  'layersHelpDialog', 'settingsHelpDialog', 'routesHelpDialog', 'techDetailsDialog']
  .filter((id) => document.getElementById(id)));
check('none of the six old dialogs survive', legacy.length === 0, legacy.join(', '));

check('opening every help topic raises no errors', errors.length === 0, errors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
