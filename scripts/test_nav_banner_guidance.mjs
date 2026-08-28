#!/usr/bin/env node
// On a device without wake-lock support, the "Screen may sleep" notice must
// inform and then get out of the way. The banner's message slot outranks
// turn guidance, and this notice was the one status with no clearing event —
// a simulated ride showed it as the headline for the ENTIRE session, so a
// rider on such a device never saw a single maneuver instruction.
import { check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)'
  + ' AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const site = await serveRepo();
const browser = await launchBrowser();
try {
  const context = await browser.newContext({ serviceWorkers: 'block',
    userAgent: IPHONE_UA, viewport: { width: 430, height: 900 },
    hasTouch: true, isMobile: true,
    permissions: ['geolocation'],
    geolocation: { latitude: 47.5810, longitude: -122.4020 } });
  // Deterministically the no-wake-lock world: headless Chromium sometimes
  // grants the lock, and this test is about the device that cannot.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'wakeLock', { get: () => undefined });
  });
  const page = await context.newPage();
  await page.goto(`http://localhost:${site.port}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.map && map.loaded && map.loaded(),
    null, { timeout: 120000 });
  await page.waitForFunction(() =>
    document.documentElement.classList.contains('app-ready'), null, { timeout: 120000 });
  await page.evaluate(() => {
    document.getElementById('onboardingClose')?.click();
    document.getElementById('onboardingDialog')?.close?.();
  });
  await page.evaluate(() => {
    routing.start = [-122.4020, 47.5810];
    routing.startName = 'Alki';
    routing.end = [-122.3565, 47.6370];
    routing.endName = 'Queen Anne';
    computeRoute();
  });
  await page.waitForFunction(() =>
    routing.options?.length > 0 && !routing.routeRequestActive, null, { timeout: 300000 });
  await page.waitForFunction(() => !document.getElementById('navStartButton').hidden,
    null, { timeout: 30000 });
  const chooserMarkSize = await page.evaluate(() =>
    Math.round(document.getElementById('routeTipsBtn').getBoundingClientRect().height));
  await page.evaluate(() => document.getElementById('navStartButton').click());
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const dialog = document.getElementById('routeStartDialog');
    if (dialog?.open) {
      const go = [...dialog.querySelectorAll('button')]
        .find((b) => /start|begin|navigate|anyway|skip/i.test(b.textContent));
      (go || dialog.querySelector('button'))?.click();
    }
  });
  await page.waitForFunction(() => turnNav.active === true, null, { timeout: 20000 });

  // Ride a few fixes so location is ready and a next maneuver exists.
  const coords = await page.evaluate(() => routing.last.coords);
  for (let i = 0; i < 10; i++) {
    const at = coords[Math.min(i * 2, coords.length - 1)];
    await context.setGeolocation({ latitude: at[1], longitude: at[0] });
    await page.waitForTimeout(300);
  }
  const early = await page.evaluate(() =>
    document.getElementById('navBannerText')?.textContent || '');
  check('the no-wake-lock device is told its screen may sleep',
    /screen may sleep/i.test(early)
      // The 8 s window can already have passed on a slow boot; guidance
      // showing instead is the fixed behavior, not a failure.
      || /^(Left turn|Right turn|Slight |Straight|Hairpin|Continue|Now:|Caution)/.test(early), early);

  // Within the notice's hand-back window, guidance owns the banner again.
  await page.waitForFunction(() => {
    const text = document.getElementById('navBannerText')?.textContent || '';
    return turnNav.active && !/screen may sleep/i.test(text) && text.length > 0;
  }, null, { timeout: 15000 });
  const later = await page.evaluate(() => ({
    banner: document.getElementById('navBannerText')?.textContent || '',
    active: turnNav.active,
  }));
  check('and the banner hands back to turn guidance within seconds',
    later.active && /^(Left turn|Right turn|Slight |Straight|Hairpin|Continue|Now:|Caution|Off route|You have arrived)/.test(later.banner),
    JSON.stringify(later));

  // The banner carries the maneuver, not the trip's progress: distance done,
  // distance left and the estimate live on the Navigating card's own progress
  // bar, and printing them twice cost the banner a line (field ask,
  // 2026-08-28). The card must still carry them.
  const progress = await page.evaluate(() => {
    const meta = document.getElementById('navBannerMeta');
    const card = document.getElementById('navProgressDist');
    const eta = document.getElementById('navProgressEta');
    const etaBox = eta?.getBoundingClientRect();
    const pane = document.getElementById('navCard')?.getBoundingClientRect()
      || { right: window.innerWidth };
    return { bannerMeta: meta?.textContent || '', bannerMetaHidden: !!meta?.hidden,
      cardDist: card?.textContent || '', cardEta: eta?.textContent || '',
      etaGap: Math.round(pane.right - (etaBox?.right ?? pane.right)) };
  });
  check('the banner no longer repeats the trip progress',
    !/done|to go/i.test(progress.bannerMeta), JSON.stringify(progress));
  check('the Navigating card still reports distance done and left',
    /done/.test(progress.cardDist) && /left|Waiting/.test(progress.cardDist),
    JSON.stringify(progress));
  check('the estimate keeps clear of the curved right edge',
    progress.etaGap >= 14, JSON.stringify(progress));

  // The head row's "?" sat on top of the destination line (field, 2026-08-28).
  // Both are in the Navigating card, in different rows that the card's own
  // negative offset pulls together, so the only proof is measured boxes.
  const helpMark = await page.evaluate(() => {
    const destEl = document.getElementById('navDest');
    // The name that caused it: long enough to run the width of the card.
    destEl.textContent = 'To: Gas Works Park north lawn by the sundial, Wallingford';
    const tips = document.getElementById('navTipsBtn').getBoundingClientRect();
    const dest = destEl.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(destEl).paddingRight) || 0;
    return { textRight: Math.round(dest.right - pad), tipsLeft: Math.round(tips.left),
      clipped: destEl.scrollWidth > destEl.clientWidth,
      verticalGap: Math.round(dest.top - tips.bottom),
      tipsSize: Math.round(tips.height) };
  });
  check('a long destination name stops before the help mark',
    helpMark.textRight <= helpMark.tipsLeft + 1, JSON.stringify(helpMark));
  check('both help marks are the same size',
    helpMark.tipsSize === chooserMarkSize, `${helpMark.tipsSize} vs ${chooserMarkSize}`);
} finally {
  await browser.close();
  site.close();
}

done();
