#!/usr/bin/env node
// A route that fails because a state's maps are not installed must offer the
// Maps screen from the failure card itself. Field: the card said "Update the
// required maps and try again" and offered nothing to tap -- a rider had to
// know where Maps lives. Other failures (no route found) must NOT grow the
// button.
import { appPage, check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
try {
  const page = await appPage(browser, site.port, { desktop: true });
  await page.waitForFunction(() => window.map && map.loaded && map.loaded(),
    null, { timeout: 120000 });
  const offered = await page.evaluate(() => {
    renderRouteCard({ ok: false, needsMaps: true,
      reason: 'Multi-state routing data is not installed for Oregon. Update the required maps and try again.' });
    const button = document.getElementById('routeMessageAction');
    return { present: !!button, label: button?.textContent || '' };
  });
  check('a missing-maps route failure offers the Maps screen',
    offered.present && offered.label === 'Open the Maps screen', JSON.stringify(offered));
  const opened = await page.evaluate(() => {
    document.getElementById('routeMessageAction').click();
    return {
      settingsActive: document.getElementById('tab-settings')?.classList.contains('active'),
      mapsPaneVisible: !document.getElementById('settings-maps')?.hidden,
      stateRows: document.getElementById('mapsStateList')?.children.length || 0,
    };
  });
  check('the button lands on the populated Maps pane',
    opened.settingsActive === true && opened.mapsPaneVisible === true && opened.stateRows > 0,
    JSON.stringify(opened));
  const plain = await page.evaluate(() => {
    renderRouteCard({ ok: false, reason: 'No route was found.' });
    return !!document.getElementById('routeMessageAction');
  });
  check('an ordinary route failure stays a plain message', plain === false, String(plain));
} finally {
  await browser.close();
  site.close();
}

done();
