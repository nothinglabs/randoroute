#!/usr/bin/env node
// A lost WebGL context must not leave a permanently frozen map. iOS reclaims
// GL contexts under memory pressure; MapLibre stops its frame loop on
// webglcontextlost and resumes only if the BROWSER restores the context,
// which memory-pressured WebKit frequently never does. The rider sees a dead
// map and calls it a crash. The app gives the browser a moment to restore,
// then reboots the shell once behind a hash guard -- the same self-heal the
// archive verifier uses -- and the fresh boot clears the guard so a later
// loss can heal again.
import { appPage, check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
try {
  const page = await appPage(browser, site.port, { desktop: true });
  await page.waitForFunction(() => window.map && map.loaded && map.loaded(),
    null, { timeout: 120000 });

  // A synthetic loss event, not WEBGL_lose_context: Chromium sometimes
  // restores a really-lost context on its own, which is exactly the case the
  // heal must NOT fire for -- and it makes the test a coin flip. The
  // synthetic event drives MapLibre's own listener (it aborts the frame
  // loop) and no restore will ever follow, which is precisely the WebKit
  // memory-pressure case the heal exists for. The window token is the
  // reboot's witness: only a real reload can erase it.
  await page.evaluate(() => {
    window.__preLossToken = true;
    map.getCanvas().dispatchEvent(new Event('webglcontextlost'));
  });

  // The heal is: wait ~3 s for a voluntary restore, then reload behind the
  // mark. Poll the END STATE across the navigation: a live map again, with
  // the guard already cleared for the next loss.
  await page.waitForFunction(() => window.map && map.loaded && map.loaded()
    && location.hash === '' && !window.__preLossToken, null, { timeout: 45000 });
  const healed = await page.evaluate(() => ({
    alive: map.loaded(), hash: location.hash, rebooted: !window.__preLossToken,
  }));
  check('a lost context comes back as a live map through a real reboot',
    healed.alive && healed.rebooted, JSON.stringify(healed));
  check('and the healthy boot cleared the guard for the next loss',
    healed.hash === '', JSON.stringify(healed));

  // Losses recurring within minutes are sustained memory pressure, and each
  // reload restarts the pressure that caused the last one -- a crash loop
  // with extra steps. The second loss may still heal; the third must hold
  // the page and say so instead of rebooting again.
  await page.evaluate(() => {
    window.__preLossToken = true;
    map.getCanvas().dispatchEvent(new Event('webglcontextlost'));
  });
  await page.waitForFunction(() => window.map && map.loaded && map.loaded()
    && location.hash === '' && !window.__preLossToken, null, { timeout: 45000 });
  await page.evaluate(() => {
    window.__preLossToken = true;
    map.getCanvas().dispatchEvent(new Event('webglcontextlost'));
  });
  await page.waitForTimeout(6500);
  const throttled = await page.evaluate(() => ({
    stayed: window.__preLossToken === true,
    hash: location.hash,
    toast: document.getElementById('routeActionText')?.textContent || '',
  }));
  check('a third loss inside the window does not reboot again',
    throttled.stayed && throttled.hash === '', JSON.stringify(throttled));
  check('and the rider is told instead',
    /graphics context/i.test(throttled.toast), JSON.stringify(throttled));
} finally {
  await browser.close();
  site.close();
}

done();
