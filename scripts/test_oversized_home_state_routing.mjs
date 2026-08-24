#!/usr/bin/env node
// A state whose full graph exceeds the device routing budget must route its
// OWN trips through the partition session — the California case, proven with
// Washington standing in: the budget override drops below Washington's
// 145.8 MB graphRawBytes, and a Seattle-to-Seattle trip is expected to route
// on an admitted partition corridor with the monolithic worker never loaded.
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
  await context.addInitScript(() => { window.JRA_ROUTING_BUDGET_BYTES = 104857600; });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${site.port}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.map && map.loaded && map.loaded(), null,
    { timeout: 60000 });

  const gates = await page.evaluate(() => ({
    budget: deviceRoutingBudgetBytes(),
    oversized: homeGraphExceedsDeviceBudget(),
    graphRawBytes: Region.graphRawBytes,
  }));
  check('the budget override marks the home graph as oversized',
    gates.budget === 104857600 && gates.oversized === true
      && gates.graphRawBytes === 145828781, JSON.stringify(gates));

  await page.evaluate(() => {
    setRoutePoint('start', { lng: -122.33006, lat: 47.60383 }, 'Seattle');
    setRoutePoint('end', { lng: -122.3035, lat: 47.6553 }, 'University of Washington');
  });
  await page.waitForFunction(() => (routing.options || []).some((option) => option.ok),
    null, { timeout: 600000 });
  const outcome = await page.evaluate(() => ({
    multiState: routing.multiStateActive,
    homeWorker: !!routing.worker,
    states: document.body.dataset.routeStateIds || '',
    partitions: Number(document.body.dataset.loadedPartitionCount),
    inputBytes: Number(document.body.dataset.routePartitionInputBytes),
    options: (routing.options || []).filter((option) => option.ok).length,
    distM: routing.last?.distM,
  }));
  // Portfolio breadth on real corridors is owned by the production portfolio
  // tests; a short urban pair legitimately collapses to two distinct options
  // after dominated-option pruning. This test owns the routing PATH.
  check('an in-state trip routes through the partition session under budget',
    outcome.multiState && outcome.states === 'washington'
      && outcome.partitions >= 1 && outcome.inputBytes <= 104857600
      && outcome.options >= 2, JSON.stringify(outcome));
  check('the monolithic home worker never loads for an oversized home state',
    outcome.homeWorker === false, JSON.stringify(outcome));
  check('the routed distance is a plausible Seattle city trip',
    outcome.distM > 5000 && outcome.distM < 25000, String(outcome.distM));
  check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  site.close();
}

done();
