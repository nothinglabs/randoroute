#!/usr/bin/env node
// Street View shares the screen with the route: panorama on top, the app's own
// map below, and a tap on that map walks the panorama along the line.
//
// The load-bearing detail is that the dialog opens NON-modally. A modal dialog
// makes everything behind it inert, so the map would be visible and dead --
// the split would look right and do nothing. The other one is the basemap
// toggle: while Google's map covers the lower band the MapLibre canvas is
// hidden, so the page never carries two live map surfaces plus a panorama, the
// compositing load that made iOS discard the app.
import { appPage, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);
await page.waitForFunction(() => typeof openStreetView === 'function'
  && typeof routing !== 'undefined' && routing.ready === true, { timeout: 120000 });

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

// A straight synthetic route so the snap target is predictable. The panorama
// iframe is neutered: this test is about the split's wiring, not about
// reaching Google.
const opened = await page.evaluate(() => {
  const coords = [];
  for (let i = 0; i <= 20; i++) coords.push([-122.34 + i * 0.0008, 47.66]);
  routing.last = { ok: true, coords, segs: [{ c0: 0, c1: coords.length - 1, name: 'North 63rd Street' }] };
  openStreetView(47.66, -122.34, 90);
  const dialog = document.getElementById('streetViewDialog');
  return {
    open: dialog.open,
    // A non-modal dialog does NOT match :modal; that is the whole point.
    modal: dialog.matches(':modal'),
    splitOpen: streetView.splitOpen,
    barShown: !document.getElementById('svSplitBar').hidden,
    bodyClass: document.body.classList.contains('street-view-open'),
    mapVisible: getComputedStyle(document.getElementById('map')).visibility,
    external: document.getElementById('streetViewExternal').textContent,
  };
});
// The padding is eased rather than jumped, so read it once the camera settles.
const padded = await page.evaluate(async () => {
  const settled = Date.now() + 4000;
  while (map.getPadding().top < 100 && Date.now() < settled) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return map.getPadding().top;
});
check('the panorama opens with the split showing', opened.open && opened.splitOpen
  && opened.barShown && opened.bodyClass, JSON.stringify(opened));
check('non-modally, so the map underneath still takes taps',
  opened.modal === false, JSON.stringify(opened));
check('and that map stays visible rather than hidden as before',
  opened.mapVisible === 'visible', JSON.stringify(opened));
check('the camera is padded so the route clears the panorama',
  padded > 100, String(padded));
check('the external link is named as a launch out of the app',
  /Launch Google Maps/.test(opened.external), opened.external);

/* ------------------------------------- tapping the map walks the panorama */
const tapped = await page.evaluate(() => {
  const before = streetView.at.slice();
  // Well off the line, but inside the snap radius: it must land ON the route.
  map.fire('click', { lngLat: { lng: -122.332, lat: 47.6615 }, point: { x: 10, y: 10 } });
  const src = document.getElementById('streetViewFrame').src;
  return { before, after: streetView.at.slice(), src };
});
check('a tap moves the panorama', tapped.after[0] !== tapped.before[0], JSON.stringify(tapped));
check('snapping onto the route line, not the raw tap',
  Math.abs(tapped.after[1] - 47.66) < 1e-6, JSON.stringify(tapped));
check('and facing the way the route runs',
  /heading=90/.test(tapped.src), tapped.src.slice(0, 160));

// Far from any route: taken literally rather than dragged to a distant line.
const farTap = await page.evaluate(() => {
  map.fire('click', { lngLat: { lng: -122.30, lat: 47.70 }, point: { x: 10, y: 10 } });
  return streetView.at.slice();
});
check('a tap far from the route is used as tapped',
  Math.abs(farTap[1] - 47.70) < 1e-6, JSON.stringify(farTap));

/* ------------------------------------------------- the Google basemap toggle */
const google = await page.evaluate(() => {
  const toggle = document.getElementById('svGoogleBasemap');
  toggle.checked = true;
  toggle.dispatchEvent(new Event('change'));
  return {
    shown: !document.getElementById('svGoogleMap').hidden,
    src: document.getElementById('svGoogleMapFrame').src,
    mapVisible: getComputedStyle(document.getElementById('map')).visibility,
    hint: document.getElementById('svSplitHint').textContent,
  };
});
check('the toggle swaps in a Google map', google.shown
  && /maps\/embed\/v1\/view/.test(google.src), JSON.stringify(google));
check('and hides the app map rather than compositing it unseen',
  google.mapVisible === 'hidden', JSON.stringify(google));
check('saying plainly that the route is not drawn there',
  /not drawn/.test(google.hint), google.hint);

const back = await page.evaluate(() => {
  const toggle = document.getElementById('svGoogleBasemap');
  toggle.checked = false;
  toggle.dispatchEvent(new Event('change'));
  return {
    hidden: document.getElementById('svGoogleMap').hidden,
    src: document.getElementById('svGoogleMapFrame').src,
    mapVisible: getComputedStyle(document.getElementById('map')).visibility,
  };
});
check('toggling back restores the app map and stops the Google frame',
  back.hidden && back.src === 'about:blank' && back.mapVisible === 'visible',
  JSON.stringify(back));

/* --------------------------------------------------------- closing tidies up */
const closed = await page.evaluate(async () => {
  document.getElementById('streetViewDialog').close();
  // Poll rather than wait on moveend: earlier animations in this test leave
  // their own moveend pending, and one of those resolves before the reset ease
  // has even started.
  const settled = Date.now() + 4000;
  while (map.getPadding().top > 1 && Date.now() < settled) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    splitOpen: streetView.splitOpen,
    barHidden: document.getElementById('svSplitBar').hidden,
    bodyClass: document.body.classList.contains('street-view-open'),
    frame: document.getElementById('streetViewFrame').src,
    padding: map.getPadding().top,
  };
});
check('closing ends the split and stops the panorama',
  closed.splitOpen === false && closed.barHidden && !closed.bodyClass
    && closed.frame === 'about:blank', JSON.stringify(closed));
check('and gives the map its whole viewport back',
  closed.padding < 5, JSON.stringify(closed));

// A tap after closing is an ordinary map tap again, not a panorama move.
const afterClose = await page.evaluate(() => {
  const before = streetView.at.slice();
  map.fire('click', { lngLat: { lng: -122.335, lat: 47.66 }, point: { x: 10, y: 10 } });
  return { before, after: streetView.at.slice(), open: document.getElementById('streetViewDialog').open };
});
check('and the map stops being a panorama picker',
  afterClose.after.join() === afterClose.before.join() && !afterClose.open,
  JSON.stringify(afterClose));

check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
