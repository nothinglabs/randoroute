#!/usr/bin/env node
// Groundwork for loading more than one state. The screen is deliberately inert
// in this build: it shows all fifty states so the shape of the feature is
// visible, but Washington is the only dataset that ships, so every other row
// refuses the tap rather than accepting it and doing nothing. The one thing a
// rider can do here is close it -- and nothing they do may change the map.
import { appPage, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port, { desktop: true });
await page.waitForFunction(() => typeof openMapsDialog === 'function', { timeout: 60000 });

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

const tab = await page.evaluate(() => {
  const button = document.getElementById('settings-tab-maps');
  return {
    exists: !!button,
    label: button?.textContent,
    // It opens a screen, so it must not claim to control a tab panel.
    role: button?.getAttribute('role'),
    haspopup: button?.getAttribute('aria-haspopup'),
    inTablist: !!button?.closest('[role="tablist"]'),
  };
});
check('Settings offers a Maps tab that announces itself as opening a dialog',
  tab.exists && tab.label === 'Maps' && tab.haspopup === 'dialog'
    && tab.role === null && tab.inTablist === false, JSON.stringify(tab));

await page.evaluate(() => openMapsDialog());
const screen = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#mapsStateList .maps-state')];
  const boxes = rows.map((row) => row.querySelector('input'));
  return {
    open: document.getElementById('mapsDialog').open,
    lead: document.querySelector('.maps-lead')?.textContent,
    count: rows.length,
    first: rows[0]?.textContent.trim(),
    last: rows[rows.length - 1]?.textContent.trim(),
    checked: rows.filter((_, i) => boxes[i].checked).map((row) =>
      row.querySelector('span').textContent),
    enabled: rows.filter((_, i) => !boxes[i].disabled).map((row) =>
      row.querySelector('span').textContent),
    // A full-screen surface, not a small dialog wedged over the map.
    fullScreen: document.getElementById('mapsDialog').classList.contains('full-help-dialog'),
  };
});
check('it opens a full-screen list of all fifty states, alphabetically',
  screen.open && screen.fullScreen && screen.count === 50
    && screen.first.startsWith('Alabama') && screen.last.startsWith('Wyoming'),
  JSON.stringify({ ...screen, checked: screen.checked, enabled: screen.enabled }));
check('the title says how many states may be loaded',
  /up to two states/i.test(screen.lead || ''), screen.lead);
check('Washington is the only state checked, and the only one selectable',
  screen.checked.join() === 'Washington' && screen.enabled.join() === 'Washington',
  JSON.stringify(screen));

// An unavailable state must refuse the tap rather than take it and do nothing.
const inert = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#mapsStateList .maps-state')];
  const oregon = rows.find((row) => row.textContent.includes('Oregon'));
  const box = oregon.querySelector('input');
  box.click();
  return { checked: box.checked, disabled: box.disabled };
});
check('tapping an unavailable state changes nothing',
  inert.checked === false && inert.disabled === true, JSON.stringify(inert));

// Washington is the only map there is; it cannot be turned off into a state
// where the app claims to have no map at all.
const cannotUnload = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#mapsStateList .maps-state')];
  const wa = rows.find((row) => row.textContent.includes('Washington'));
  const box = wa.querySelector('input');
  box.checked = false;
  box.dispatchEvent(new Event('change'));
  return box.checked;
});
check('and the loaded state cannot be unloaded', cannotUnload === true, String(cannotUnload));

const closed = await page.evaluate(() => {
  document.querySelector('#mapsDialog [data-close]').click();
  return document.getElementById('mapsDialog').open;
});
check('closing is the one action the screen actually performs', closed === false);

check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
