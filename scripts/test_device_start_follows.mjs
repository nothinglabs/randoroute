#!/usr/bin/env node
// A start set from "use my location" is a statement about where the rider IS.
// Nothing used to notice when that stopped being true.
//
// Reported from the road: stop a ride that began where you were standing, pick
// a new destination later and miles away, and the route is drawn from where you
// were standing. Not an error message, not a stale pin the rider might spot --
// a complete, plausible route with no relation to them.
//
// So a new destination re-reads the position. The distinction that has to hold
// is between a start the DEVICE gave and a start the RIDER chose: the first
// follows them, the second is a decision and must never move on its own.
import { appPage, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};

// Stand in for the device so the position can be moved between steps, and keep
// a log of everything the toast says. The toast is one slot shared with the
// router, so a routing result lands on top of a notice within a second or two --
// which is fine for a rider who has already read it, and fatal for a test that
// reads the slot afterwards. What has to be true is that the rider was TOLD.
await page.evaluate(() => {
  // Record the CALLS, not the DOM. This used to poll the toast element every
  // 20 ms, and under load the "start moved" toast could be shown and then
  // overwritten by "Calculating route options" inside a single tick -- a
  // once-in-a-few-runs flake. Wrapping the function the app tells riders
  // through captures every notice deterministically, however briefly it was
  // on screen; which is the thing this file actually asserts.
  window.__notices = [];
  const realToast = window.showRouteActionToast;
  window.showRouteActionToast = (text, opts) => {
    const line = `${text || ''} ${opts?.detail || ''}`.trim();
    if (line) window.__notices.push(line);
    return realToast(text, opts);
  };
  window.__here = { lng: -122.3321, lat: 47.6062 };
  window.__locationFails = false;
  window.getFreshDevicePosition = () => (window.__locationFails
    ? Promise.reject(new Error('Location permission is blocked'))
    : Promise.resolve({ coords: {
      longitude: window.__here.lng, latitude: window.__here.lat, accuracy: 8,
    }, timestamp: Date.now() }));
});

const settle = () => page.waitForFunction(
  () => !(document.getElementById('routeActionText')?.textContent || '').includes('Updating start'),
  { timeout: 15000 }).catch(() => {});

const defaultStart = await page.evaluate(() => ({
  actual: routing.start,
  rowHidden: document.querySelector('.route-endpoint-start-row')?.hidden,
  destinationVisible: !document.querySelector('.route-endpoint-end-row')?.hidden,
  displayed: document.querySelector('#rb-start [data-endpoint-value]')?.textContent,
  defaultsToDevice: routing.startDefaultsToDevice,
  removeVisible: !document.querySelector('[data-endpoint-remove="start"]')?.hidden,
}));
check('a blank planner shows both endpoints with Current location as the Start default',
  !defaultStart.actual && !defaultStart.rowHidden && defaultStart.destinationVisible
    && defaultStart.displayed === 'Current location (tap to change).'
    && defaultStart.defaultsToDevice && !defaultStart.removeVisible,
  JSON.stringify(defaultStart));

await page.evaluate(() => {
  window.__locationFails = true;
  setRoutePoint('end', { lng: -122.2015, lat: 47.6101 }, 'Bellevue');
});
await page.waitForFunction(() => !routing.startDefaultsToDevice);
const missingDefault = await page.evaluate(() => ({
  actual: routing.start,
  displayed: document.querySelector('#rb-start [data-endpoint-value]')?.textContent,
  defaultsToDevice: routing.startDefaultsToDevice,
  notices: window.__notices.join(' | '),
}));
check('an unavailable automatic location quietly leaves Start unset',
  !missingDefault.actual && missingDefault.displayed === 'Tap to set start.'
    && !missingDefault.defaultsToDevice && !/current location/i.test(missingDefault.notices),
  JSON.stringify(missingDefault));

const revealedStart = await page.evaluate(() => {
  clearRoute();
  window.__notices.length = 0;
  window.__locationFails = false;
  setRoutePoint('end', { lng: -122.2015, lat: 47.6101 }, 'Bellevue');
  return {
    rowHidden: document.querySelector('.route-endpoint-start-row')?.hidden,
    displayed: document.querySelector('#rb-start [data-endpoint-value]')?.textContent,
    defaultsToDevice: routing.startDefaultsToDevice,
  };
});
check('choosing Destination fills the visible Start with a Current location default',
  !revealedStart.rowHidden && revealedStart.displayed === 'Current location (tap to change).'
    && revealedStart.defaultsToDevice, JSON.stringify(revealedStart));
await page.waitForFunction(() => Boolean(routing.start), null, { timeout: 5000 });
const resolvedDefault = await page.evaluate(() => ({
  name: routing.startName, follows: routing.startFromDevice, start: routing.start,
  removeVisible: !document.querySelector('[data-endpoint-remove="start"]')?.hidden,
}));
check('choosing a destination resolves the default From to a fresh device fix',
  resolvedDefault.name === 'My location' && resolvedDefault.follows
    && resolvedDefault.start[0] === -122.3321 && !resolvedDefault.removeVisible,
  JSON.stringify(resolvedDefault));

const plan = (fromDevice, at = { lng: -122.3321, lat: 47.6062 }) => page.evaluate(([device, here]) => {
  clearRoute();
  window.__notices.length = 0;
  window.__here = here;
  setRoutePoint('start', { lng: window.__here.lng, lat: window.__here.lat },
    device ? 'My location' : 'Pike Place Market', { fromDevice: device });
  setRoutePoint('end', { lng: -122.2015, lat: 47.6101 }, 'Bellevue');
}, [fromDevice, at]);

const readStart = () => page.evaluate(() => ({
  start: routing.start.map((v) => +v.toFixed(4)),
  name: routing.startName,
  follows: routing.startFromDevice,
  notice: window.__notices.join(' | '),
}));
const forgetNotices = () => page.evaluate(() => { window.__notices.length = 0; });

/* ------------------------------- a device start follows a new destination */
await plan(true);
await settle();
const planted = await readStart();
check('a start from the device is marked as one', planted.follows === true,
  JSON.stringify(planted));

// The rider stops, rides ten miles, and picks somewhere new.
await forgetNotices();
await page.evaluate(() => { window.__here = { lng: -122.2015, lat: 47.6740 }; });
await page.evaluate(() => setRoutePoint('end', { lng: -122.1215, lat: 47.6740 }, 'Redmond'));
await settle();
const moved = await readStart();
check('choosing a new destination moves the start to where the rider now is',
  moved.start[0] === -122.2015 && moved.start[1] === 47.674, JSON.stringify(moved));
check('and it is still a device start, so it keeps following',
  moved.follows === true && moved.name === 'My location', JSON.stringify(moved));
check('the rider is told the start moved', /moved to your location/i.test(moved.notice),
  moved.notice);

/* -------------------------------- a start the rider chose is left alone */
await plan(false);
await settle();
await forgetNotices();
await page.evaluate(() => { window.__here = { lng: -122.1215, lat: 47.6740 }; });
await page.evaluate(() => setRoutePoint('end', { lng: -122.1015, lat: 47.6640 }, 'Elsewhere'));
await settle();
const chosen = await readStart();
check('a start the rider picked does not move under them',
  chosen.start[0] === -122.3321 && chosen.name === 'Pike Place Market',
  JSON.stringify(chosen));

/* --------------------------------------------- standing still is not news */
await plan(true);
await settle();
await forgetNotices();
await page.evaluate(() => {
  // Ten metres away: the same place, as far as a rider is concerned.
  window.__here = { lng: -122.33218, lat: 47.6062 };
  setRoutePoint('end', { lng: -122.2515, lat: 47.6101 }, 'Somewhere else');
});
await settle();
const still = await readStart();
check('a rider who has not moved gets no announcement about it',
  !/moved to your location/i.test(still.notice), JSON.stringify(still));

/* ------------------------------------------- and a failure is not silent */
await plan(true);
await settle();
await forgetNotices();
await page.evaluate(() => {
  window.__locationFails = true;
  setRoutePoint('end', { lng: -122.2515, lat: 47.6301 }, 'Nowhere');
});
await page.waitForFunction(() => window.__notices.some((text) =>
  /Could not update your location/i.test(text)), { timeout: 15000 }).catch(() => {});
const failedFix = await readStart();
check('a start that could not be updated says so rather than pretending',
  /Could not update your location/i.test(failedFix.notice), JSON.stringify(failedFix));
check('and the route is still calculated from the start it has',
  failedFix.start[0] === -122.3321, JSON.stringify(failedFix));

/* --------------------------------------------- clearing restores the default */
const cleared = await page.evaluate(() => {
  window.__locationFails = false;
  clearRoute();
  return { follows: routing.startFromDevice, defaults: routing.startDefaultsToDevice };
});
check('clearing the route forgets the old fix and restores the Current location default',
  !cleared.follows && cleared.defaults, JSON.stringify(cleared));

check('no page errors', page.pageErrors.length === 0, page.pageErrors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
