#!/usr/bin/env node
// A phone holds one statewide graph at a time. A cross-state trip runs on the
// partition session with no home worker resident; map zooms trim the session
// router's disposable caches; and returning to a single-state trip lazily
// rebuilds the home engine through the ordinary ensureRouter path.
import { check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)'
  + ' AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const site = await serveRepo();
const browser = await launchBrowser();
try {
  const context = await browser.newContext({
    serviceWorkers: 'block', userAgent: IPHONE_UA,
    viewport: { width: 430, height: 900 }, hasTouch: true, isMobile: true,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${site.port}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.map && map.loaded && map.loaded(), null,
    { timeout: 60000 });

  // Vancouver WA → Portland OR: the smallest real cross-state corridor.
  await page.evaluate(() => {
    setRoutePoint('start', { lng: -122.6615, lat: 45.6387 }, 'Vancouver');
    setRoutePoint('end', { lng: -122.6765, lat: 45.5231 }, 'Portland');
  });
  await page.waitForFunction(() => (routing.options || []).some((option) => option.ok),
    null, { timeout: 600000 });
  const crossState = await page.evaluate(() => ({
    multiState: routing.multiStateActive,
    homeWorker: !!routing.worker,
    engineReady: routeEngineReady(),
    states: document.body.dataset.routeStateIds || '',
  }));
  check('a cross-state portfolio runs with no home graph resident',
    crossState.multiState && !crossState.homeWorker && crossState.engineReady
      && crossState.states.includes('oregon') && crossState.states.includes('washington'),
    JSON.stringify(crossState));

  const trimmed = await page.evaluate(() => new Promise((resolve) => {
    const worker = activeMultiStateRouting.bridge?.router;
    if (!worker) return resolve('no-bridge-router');
    const listen = (ev) => {
      if (ev.data?.type === 'trimmed') {
        worker.removeEventListener('message', listen);
        resolve(true);
      }
    };
    worker.addEventListener('message', listen);
    map.jumpTo({ center: [-122.6765, 45.5231], zoom: 12 });
    setTimeout(() => { worker.removeEventListener('message', listen); resolve(false); }, 10000);
  }));
  check('map zoom trims the session router caches with the home worker gone',
    trimmed === true, String(trimmed));

  // Both endpoints in Washington again: the session cancels and the home
  // engine rebuilds itself for an ordinary single-state portfolio.
  await page.evaluate(() => {
    setRoutePoint('end', { lng: -122.6519, lat: 45.6335 }, 'Clark College',
      { stateId: 'washington' });
  });
  await page.waitForFunction(() => routing.ready && !routing.multiStateActive
    && (routing.options || []).some((option) => option.ok), null, { timeout: 600000 });
  const returned = await page.evaluate(() => ({
    homeWorker: !!routing.worker,
    ready: routing.ready,
    multiState: routing.multiStateActive,
  }));
  check('returning to a single-state trip rebuilds the home engine lazily',
    returned.homeWorker && returned.ready && !returned.multiState,
    JSON.stringify(returned));
  check('no page errors across the engine hand-offs', errors.length === 0,
    errors.join(' | '));
} finally {
  await browser.close();
  site.close();
}

done();
