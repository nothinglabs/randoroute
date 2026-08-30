#!/usr/bin/env node
// What the rider SEES for the two 2026-08-29 changes, checked on a drawn route.
//
//   1. A failing sharrowed road wears the "Bike route fails rules" badge --
//      the same one a signed route wears. Officialdom marked it; it still
//      fails. A failing road with no marking keeps the bare fail badge, which
//      is what makes the first badge mean anything.
//   2. A failing road with a TAGGED sidewalk plants the dismount icon between
//      its fail badges, and the fail badges all survive: they are promises.
//   3. The card says so too. A rider who never opens Details still learns the
//      sidewalk is there -- and the map and the card must agree about it, or
//      this is another "card lies by omission".
import { appPage, check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
try {
  const page = await appPage(browser, site.port, { desktop: true });
  await page.waitForFunction(() => window.map && map.loaded && map.loaded(),
    null, { timeout: 120000 });

  const seen = await page.evaluate(async () => {
    const lat = 47.55;
    // Four 200 m blocks per stretch, passing stretches between them so the
    // failing runs never merge into one.
    const kindsBy = [
      { n: 4, seg: { level: 4, mph: 45, sh: 0, facility: 1 } },              // sharrow
      { n: 3, seg: { level: 1, mph: 30, sh: 6, facility: 0 } },              // gap
      { n: 4, seg: { level: 4, mph: 45, sh: 0, facility: 0 } },              // bare fail
      { n: 3, seg: { level: 1, mph: 30, sh: 6, facility: 0 } },              // gap
      // Fails on LANES inside the speed limit, so rung 7 cannot fire and the
      // bailout is the only thing that can mention the sidewalk.
      { n: 4, seg: { level: 4, mph: 30, sh: 0, lanes: 4, facility: 0, official: 16 } },
    ];
    const segs = [];
    for (const block of kindsBy) {
      for (let i = 0; i < block.n; i++) segs.push({ ...block.seg, lenM: 200 });
    }
    const coords = Array.from({ length: segs.length + 1 },
      (_, i) => [-122.30 + i * 0.0026, lat]);
    segs.forEach((s, i) => { s.c0 = i; s.c1 = i + 1; });
    drawRoute(coords, [], segs);
    await new Promise((resolve) => setTimeout(resolve, 700));

    const badge = {};
    for (const f of map.getSource('route-marker').serialize().data.features) {
      badge[f.properties.kind] = (badge[f.properties.kind] || 0) + 1;
    }
    const dismount = {};
    for (const f of map.getSource('route-dismount').serialize().data.features) {
      dismount[f.properties.kind] = (dismount[f.properties.kind] || 0) + 1;
    }
    // The card's own sentence, for the lanes-driven failing stretch.
    const facts = scoreRouteSeg({ level: 4, mph: 30, sh: 0, lanes: 4,
      facility: 0, official: 16 });
    const noWalk = scoreRouteSeg({ level: 4, mph: 30, sh: 0, lanes: 4,
      facility: 0, official: 0 });
    return { badge, dismount,
      why: explainLevel(facts), whyNoSidewalk: explainLevel(noWalk),
      legend: ACTIVE_ROUTE_ICON_DEFINITIONS.map((d) => d[1]) };
  });

  check('a failing sharrowed road wears the bike-route-fails badge',
    (seen.badge['fail-designated'] || 0) >= 1, JSON.stringify(seen.badge));
  check('an unmarked failing road keeps the bare fail badge',
    (seen.badge.fail || 0) >= 1, JSON.stringify(seen.badge));
  check('a failing road with a tagged sidewalk plants the dismount icon',
    (seen.dismount.sidewalk || 0) >= 1, JSON.stringify(seen.dismount));
  check('the card names the sidewalk without opening Details',
    /sidewalk is mapped here/i.test(seen.why), seen.why);
  check('an identical road with no tagged sidewalk says no such thing',
    !/sidewalk is mapped here/i.test(seen.whyNoSidewalk), seen.whyNoSidewalk);
  check('the legend entry covers both meanings of the walker icon',
    seen.legend.includes('Dismount / sidewalk present'), JSON.stringify(seen.legend));
} finally {
  await browser.close();
  site.close();
}
done();
