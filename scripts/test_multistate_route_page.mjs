#!/usr/bin/env node
// The page planner selects the partition session for cross-state points,
// forwards the ordinary route request unchanged, and turns a missing transit
// state into a durable rider-facing install continuation.
import { appPage, check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
try {
  const page = await appPage(browser, site.port);
  await page.waitForFunction(() => typeof computeMultiStateRoute === 'function'
    && typeof installedMultiStateRouteSession === 'function', { timeout: 60000 });
  const routed = await page.evaluate(async () => {
    const originalInstalled = installedMultiStateRouteSession;
    const originalMessage = onRouterMessage;
    let request = null, delivered = null;
    installedMultiStateRouteSession = async () => ({ session: {
      route: async (value) => {
        request = value;
        return { type: value.type, id: value.id, ok: true,
          options: [{ ok: true }], routeStateIds: ['fixture-west', 'fixture-south'],
          loadedPartitionIds: ['fixture-detail'],
          routingDiagnostics: { partitionInput: { rawInputBytes: 12345 },
            attempts: [{ ok: false }, { ok: true }] },
        };
      },
    } });
    onRouterMessage = ({ data }) => { delivered = data; routing.routeRequestActive = false; };
    routing.start = [-122.33, 47.61];
    routing.end = [-123.09, 44.05];
    routing.startStateId = 'fixture-west';
    routing.endStateId = 'fixture-south';
    routing.vias = [];
    routing.blocks = [];
    computeRoute({ revealPanel: false });
    for (let tries = 0; tries < 100 && !delivered; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const answer = {
      pointStateIds: request?.pointStateIds,
      points: request?.points,
      type: request?.type,
      sameId: request?.id === delivered?.id,
      active: routing.multiStateActive,
      routeStates: document.body.dataset.routeStateIds,
      loadedCount: document.body.dataset.loadedPartitionCount,
      inputBytes: document.body.dataset.routePartitionInputBytes,
      retries: document.body.dataset.routePartitionRetries,
    };
    installedMultiStateRouteSession = originalInstalled;
    onRouterMessage = originalMessage;
    clearRoute();
    return answer;
  });
  check('the page sends cross-state endpoints to the partition session with state identity',
    routed.pointStateIds?.join('|') === 'fixture-west|fixture-south'
      && routed.points?.length === 2 && routed.type === 'route-options' && routed.sameId,
    JSON.stringify(routed));
  check('the page records route-state and loaded-detail diagnostics without exposing IDs in route copy',
    routed.active && routed.routeStates === 'fixture-west,fixture-south'
      && routed.loadedCount === '1' && routed.inputBytes === '12345'
      && routed.retries === '1', JSON.stringify(routed));

  const missing = await page.evaluate(async () => {
    const originalInstalled = installedMultiStateRouteSession;
    const originalCard = openNationalStateCard;
    let opened = null;
    installedMultiStateRouteSession = async () => ({ session: {
      route: async (value) => ({ type: value.type, id: value.id, ok: false,
        code: 'required-states', reason: 'One or more maps are required for this trip.',
        routeStateIds: ['fixture-west', 'fixture-middle', 'fixture-south'],
        requiredStateIds: ['fixture-middle'],
      }),
    } });
    openNationalStateCard = async (stateId) => { opened = stateId; };
    routing.start = [-122.33, 47.61];
    routing.end = [-123.09, 44.05];
    routing.startStateId = 'fixture-west';
    routing.endStateId = 'fixture-south';
    routing.vias = [];
    routing.blocks = [];
    computeRoute({ revealPanel: false });
    for (let tries = 0; tries < 100 && !opened; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const pending = JSON.parse(localStorage.getItem('jra-pending-map-route-intent-1') || 'null');
    const answer = { opened, pending,
      status: document.getElementById('routeActionText').textContent };
    installedMultiStateRouteSession = originalInstalled;
    openNationalStateCard = originalCard;
    clearPendingMapRouteIntent();
    clearRoute();
    return answer;
  });
  check('a missing transit state opens its map card and retains the same route request',
    missing.opened === 'fixture-middle' && missing.pending?.action === 'resume-route'
      && missing.pending?.requiredStateIds?.join() === 'fixture-middle'
      && /Required for this trip: fixture-middle/.test(missing.status),
    JSON.stringify(missing));

  const resumed = await page.evaluate(async () => {
    const originalFit = fitRouteBounds;
    const originalCompute = computeRoute;
    let framed = null, computed = 0;
    routing.start = [-122.385, 47.812];
    routing.end = [-122.499, 47.798];
    routing.startStateId = Region.id;
    routing.endStateId = Region.id;
    routing.vias = [];
    routing.blocks = [];
    localStorage.setItem('jra-pending-map-route-intent-1', JSON.stringify({
      version: 1, createdAt: Date.now(), action: 'resume-route',
      stateId: Region.id, requiredStateIds: [Region.id],
    }));
    fitRouteBounds = (route) => { framed = route; };
    computeRoute = () => { computed++; };
    const handled = await resumePendingMapRouteIntent();
    fitRouteBounds = originalFit;
    computeRoute = originalCompute;
    clearRoute();
    return { handled, framed, computed,
      pending: localStorage.getItem('jra-pending-map-route-intent-1') };
  });
  check('resuming after a required map install frames the retained trip before routing',
    resumed.handled && resumed.computed === 1 && resumed.framed?.s?.[0] === -122.385
      && resumed.framed?.e?.[0] === -122.499 && resumed.pending == null,
    JSON.stringify(resumed));
} finally {
  await browser.close();
  await site.close();
}

done();
