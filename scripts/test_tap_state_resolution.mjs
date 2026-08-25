#!/usr/bin/env node
// A tapped point resolves to the state it is actually in, from boot — with
// no search and no visit to the Maps screen first. The Portland strip
// between 45.5°N and the real Washington line sits inside BOTH states'
// padded bounding boxes, and the smallest-box fallback answers WASHINGTON
// there; only the polygon test answers Oregon. The polygons therefore have
// to be loaded by boot itself, or a rider who opens the app and taps a
// Portland destination routes their cross-state trip single-state on the
// home graph (which grinds, at length, toward a wrong answer).
import { appPage, check, done, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
try {
  const page = await appPage(browser, site.port, { desktop: true });
  await page.waitForFunction(() => window.map && map.loaded && map.loaded(),
    null, { timeout: 120000 });
  await page.evaluate(() => { document.getElementById('onboardingClose')?.click(); });

  // Boot must load the polygons on its own.
  const polygons = await page.waitForFunction(
    () => !!nationalFeatureCollection, null, { timeout: 20000 },
  ).then(() => true).catch(() => false);
  check('the state polygons load at boot without search or Maps', polygons);

  const resolved = await page.evaluate(() => {
    setRoutePoint('end', { lng: -122.65195, lat: 45.51738 }, 'Buckman, Portland');
    const buckman = routing.endStateId;
    setRoutePoint('end', { lng: -122.671, lat: 45.638 }, 'Vancouver WA');
    const vancouver = routing.endStateId;
    setRoutePoint('start', { lng: -122.3321, lat: 47.6062 }, 'Seattle');
    return { buckman, vancouver, start: routing.startStateId,
      multi: (() => { routing.endStateId = buckman; // restore the Oregon end
        return routingRequiresPartitionSession(); })() };
  });
  check('a Portland tap in the overlap strip resolves to Oregon',
    resolved.buckman === 'oregon', JSON.stringify(resolved));
  check('a Vancouver tap still resolves to Washington',
    resolved.vancouver === 'washington', JSON.stringify(resolved));
  check('and the cross-state pair engages the partition session',
    resolved.multi === true, JSON.stringify(resolved));
} finally {
  await browser.close();
  site.close();
}

done();
