#!/usr/bin/env node
// A tapped route segment's debug pane leads with what riding it takes against
// what the SEARCH charged for it (2026-08-29). The ratio between the two is
// the diagnostic that explains a detour: a cycletrack prices at a fraction of
// its travel time, a failing shoulder at several times.
//
// Both numbers come from the worker's own pricing -- timeS from edgeTimeS,
// costS from edgeCost, the terms the relaxation loop charged -- so this pins
// that they arrive on the segment, survive the trip onto the map feature, and
// render as facts rather than being buried in the JSON.
import { appDefaultRules, appPage, check, done, launchBrowser, routerWorker,
  serveRepo } from './testlib/harness.mjs';

const worker = routerWorker();
check('worker loads the graph', worker.ready);

const trip = worker.post({ type: 'route-options', id: 52,
  start: [-122.3321, 47.6062], end: [-122.3830, 47.6680], rules: appDefaultRules() });
check('the trip routes', !!trip?.ok, trip?.reason);

const segs = JSON.parse(worker.run(`(() => {
  const c = lastCandidates.values().next().value;
  return JSON.stringify((c.segs || []).map((s) => ({
    lenM: s.lenM, timeS: s.timeS, costS: s.costS, level: s.level,
    facility: s.facility, ferry: !!(s.flags & 32),
  })));
})()`));
check('every segment carries a length, a travel time and a search cost',
  segs.length > 10 && segs.every((s) => Number.isFinite(s.lenM)
    && Number.isFinite(s.timeS) && Number.isFinite(s.costS)),
  JSON.stringify(segs.find((s) => !Number.isFinite(s.costS)) || segs[0]));
check('the cost is a real price, never negative',
  segs.every((s) => s.costS >= 0), JSON.stringify(segs.find((s) => s.costS < 0)));
// The whole point of showing both: they differ, and differ per segment. A
// route whose every arc priced at exactly its travel time would mean the
// weights had stopped doing anything.
const ratios = segs.filter((s) => s.timeS > 0 && !s.ferry)
  .map((s) => s.costS / s.timeS);
check('cost and travel time are not the same number',
  ratios.length > 5 && Math.max(...ratios) - Math.min(...ratios) > 0.5,
  JSON.stringify({ min: Math.min(...ratios).toFixed(2), max: Math.max(...ratios).toFixed(2) }));
// A protected facility must be cheaper to the search than it is to ride;
// that discount is why the router seeks these out.
const facilityRatios = segs.filter((s) => s.facility >= 2 && s.timeS > 0 && !s.ferry)
  .map((s) => s.costS / s.timeS);
check('a protected facility prices below its travel time',
  !facilityRatios.length || Math.min(...facilityRatios) < 1,
  JSON.stringify({ facilitySegs: facilityRatios.length,
    min: facilityRatios.length ? Math.min(...facilityRatios).toFixed(2) : null }));

// And the pane leads with them: facts above the JSON, not buried in it, and
// no empty strip on a record that carries no segment numbers.
const site = await serveRepo();
const browser = await launchBrowser();
try {
  const page = await appPage(browser, site.port);
  const pane = await page.evaluate(() => {
    openMapTapDebug('4th Avenue Cycletrack', { title: '4th Avenue Cycletrack',
      rawProperties: { name: '4th Avenue Cycletrack', lenM: 77, timeS: 14, costS: 3.1 } });
    const facts = document.getElementById('mapDebugFacts');
    const pre = document.getElementById('mapDebugOutput');
    const items = [...facts.querySelectorAll('.map-debug-fact')].map((i) => i.textContent);
    const shown = !facts.hidden;
    const above = !!(facts.compareDocumentPosition(pre) & Node.DOCUMENT_POSITION_FOLLOWING);
    openMapTapDebug('Point on map', { title: 'Point on map', rawProperties: {} });
    const hiddenForPlainPoint = facts.hidden;
    document.getElementById('mapDebugDialog').close();
    return { items, shown, above, hiddenForPlainPoint };
  });
  check('the pane leads with the segment cost facts, above the JSON',
    pane.shown && pane.above && pane.items.length === 5, JSON.stringify(pane));
  check('and reports travel, cost, cost per mile and their ratio',
    /14 s/.test(pane.items[0]) && /3\.1 s/.test(pane.items[1])
      && /65 s/.test(pane.items[2]) && /0\.22×/.test(pane.items[3]),
    JSON.stringify(pane.items));
  check('a record with no segment numbers shows no strip',
    pane.hiddenForPlainPoint, JSON.stringify(pane));
} finally {
  await browser.close();
  site.close();
}

done();
