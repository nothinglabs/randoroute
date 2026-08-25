#!/usr/bin/env node
// A Maps-screen state card must hold every control it can carry. The
// worst-case row — a non-home installed state: radio, name, size, Update,
// Remove, On-device badge — needs ~330px; the old 210px grid minimum crushed
// the state name to zero width and pushed the badge outside the card (field
// screenshot, desktop). The card now guarantees the name real width and
// wraps the control group instead of overflowing.
import { appPage, check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
try {
  const page = await appPage(browser, site.port, { desktop: true });
  await page.waitForFunction(() => window.map && map.loaded && map.loaded(),
    null, { timeout: 120000 });
  await page.evaluate(() => {
    document.getElementById('onboardingClose')?.click();
    document.getElementById('onboardingDialog')?.close?.();
  });
  const card = await page.evaluate(() => {
    settingsPaneSelect?.('maps');
    setPanelOpen?.(true);
    selectPanelTab?.('settings');
    const host = document.getElementById('mapsStateList');
    // The worst-case row, built with the app's own classes: the real list
    // only shows it once a second state is store-installed with an update
    // pending, which no fresh world has.
    const row = document.createElement('label');
    row.className = 'maps-state';
    row.innerHTML = `
      <input type="radio" name="mapsStateProbe">
      <span class="maps-state-name"><span>Washington</span>
        <span class="maps-state-detail">Routing, street detail, place search</span></span>
      <span class="maps-state-size">207 MB</span>
      <button type="button" class="maps-state-download maps-state-update">Update</button>
      <button type="button" class="maps-state-remove">Remove</button>
      <span class="maps-state-badge">On device</span>`;
    host.prepend(row);
    const box = row.getBoundingClientRect();
    return {
      overflowX: row.scrollWidth - row.clientWidth,
      badgeInside: row.querySelector('.maps-state-badge')
        .getBoundingClientRect().right <= box.right + 1,
      nameW: Math.round(row.querySelector('.maps-state-name > span')
        .getBoundingClientRect().width),
    };
  });
  check('the fullest state card keeps every control inside itself',
    card.overflowX <= 0 && card.badgeInside, JSON.stringify(card));
  check('and the state name keeps readable width',
    card.nameW >= 70, JSON.stringify(card));
} finally {
  await browser.close();
  site.close();
}

done();
