#!/usr/bin/env node
// A tap on a road draws the stretch of road the card is describing, rather
// than a pin marking the pixel the finger landed on -- the card is about that
// piece of road, so showing it says more than a dot does. A tap on nothing
// keeps the pin, because there the point really is the subject.
//
// The route's start and destination are a third case: they already have a role
// in the trip, so their card names it and drops both Navigate (nothing to
// assign) and the road block (which would ask the router to avoid the place it
// is routing to). Their own marker is the anchor, so no pin is dropped on it.
import { appPage, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);
await page.waitForFunction(() => typeof inspectRoadAt === 'function'
  && typeof openEndpointCard === 'function' && map.getLayer('tap-highlight'),
{ timeout: 90000 });

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

const roadTap = await page.evaluate(() => {
  roadInfoSuppressedUntil = 0;
  dismissRoadInfo();
  const original = featureAt;
  const line = [[-122.34, 47.61], [-122.335, 47.615], [-122.33, 47.62]];
  featureAt = () => ({
    layer: { id: 'test-highlight-hit' },
    properties: { n: 'Test Avenue', s: 30, w: 2, h: 'residential', u: 1 },
    geometry: { type: 'LineString', coordinates: line },
  });
  HIT_SRC['test-highlight-hit'] = SOURCES.find((item) => item.id === 'roads');
  const point = { x: 220, y: 400 };
  const opened = inspectRoadAt(point, map.unproject([point.x, point.y]));
  featureAt = original;
  return {
    opened,
    cardShown: document.getElementById('readout').classList.contains('show'),
    visible: map.getLayoutProperty('tap-highlight', 'visibility'),
    haloVisible: map.getLayoutProperty('tap-highlight-halo', 'visibility'),
    drawn: map.getSource('tap-highlight')._data?.geometry?.coordinates?.length,
    matchesTapped: JSON.stringify(map.getSource('tap-highlight')._data.geometry.coordinates)
      === JSON.stringify(line),
    pins: document.querySelectorAll('.search-result-marker').length,
  };
});
check('tapping a road opens its card and draws that stretch',
  roadTap.opened && roadTap.cardShown && roadTap.visible === 'visible'
    && roadTap.haloVisible === 'visible' && roadTap.drawn === 3, JSON.stringify(roadTap));
check('the drawn stretch is exactly the tapped geometry, not an approximation',
  roadTap.matchesTapped === true, JSON.stringify(roadTap));
check('and no pin is dropped, because the road is the subject',
  roadTap.pins === 0, JSON.stringify(roadTap));

// Both of these shipped broken once. The layers are created with the permanent
// ones at style load, but drawRoute() adds the route's layers later and they
// land above -- so the highlight painted UNDER the drawn route, the very case
// a rider taps most. And the card was positioned at the tap, sitting directly
// on the stretch it was describing. Checking the visibility property proved
// neither.
const painted = await page.evaluate(() => {
  const ids = map.getStyle().layers.map((layer) => layer.id);
  const card = document.getElementById('readout').getBoundingClientRect();
  // Where the finger actually landed -- the stretch runs through it, so a card
  // clear of this point is a card clear of what it is describing.
  const canvas = map.getCanvas().getBoundingClientRect();
  const point = { x: canvas.left + 220, y: canvas.top + 400 };
  return {
    above: ids.slice(ids.indexOf('tap-highlight') + 1),
    coversTap: point.x >= card.left && point.x <= card.right
      && point.y >= card.top && point.y <= card.bottom,
    placement: document.getElementById('readout').dataset.pinPlacement,
  };
});
check('the highlight is drawn above every other layer, including the route',
  painted.above.length === 0, JSON.stringify(painted.above));
check('and the card is placed clear of the stretch it describes',
  painted.coversTap === false
    && ['above', 'below', 'left', 'right'].includes(painted.placement),
  JSON.stringify(painted));

const blankTap = await page.evaluate(() => {
  roadInfoSuppressedUntil = 0;
  dismissRoadInfo();
  const original = featureAt;
  featureAt = () => null;
  const point = { x: 180, y: 360 };
  inspectRoadAt(point, map.unproject([point.x, point.y]));
  featureAt = original;
  return {
    pins: document.querySelectorAll('.search-result-marker').length,
    visible: map.getLayoutProperty('tap-highlight', 'visibility'),
  };
});
check('a tap on open map still gets its pin, and no stretch',
  blankTap.pins === 1 && blankTap.visible === 'none', JSON.stringify(blankTap));

const cleared = await page.evaluate(() => {
  dismissRoadInfo();
  return {
    visible: map.getLayoutProperty('tap-highlight', 'visibility'),
    drawn: map.getSource('tap-highlight')._data?.geometry?.coordinates?.length,
    pins: document.querySelectorAll('.search-result-marker').length,
  };
});
check('closing the card takes the stretch and the pin away with it',
  cleared.visible === 'none' && cleared.drawn === 0 && cleared.pins === 0,
  JSON.stringify(cleared));

/* --------------------------------------------------- the trip's own endpoints */
const endpoint = await page.evaluate(() => {
  routing.worker = { postMessage: () => {} };
  routing.ready = true;
  setRoutePoint('start', { lng: -122.335, lat: 47.61 }, 'Gas Works Park');
  setRoutePoint('end', { lng: -122.31, lat: 47.65 }, 'Green Lake');
  roadInfoSuppressedUntil = 0;
  openEndpointCard('start');
  const readout = document.getElementById('readout');
  return {
    shown: readout.classList.contains('show'),
    heading: readout.querySelector('.rt-title')?.textContent,
    actions: [...readout.querySelectorAll('.readout-primary-actions > button')]
      .map((button) => button.textContent.replace(/\s+/g, ' ').trim()),
    roadBlock: !!readout.querySelector('.readout-road-block'),
    summary: readout.querySelector('.readout-safety-summary')?.textContent,
    pins: document.querySelectorAll('.search-result-marker').length,
  };
});
check('tapping the start opens a card named for the point',
  endpoint.shown && endpoint.heading === 'Gas Works Park', JSON.stringify(endpoint));
check('which says the point is where the trip begins',
  /starts here/i.test(endpoint.summary || ''), endpoint.summary);
check('with no Navigate button, because the role is already assigned',
  !endpoint.actions.some((label) => /Navigate/.test(label)), JSON.stringify(endpoint.actions));
check('and no road block on the place the router is routing to',
  endpoint.roadBlock === false, JSON.stringify(endpoint));
check('and no pin dropped on top of the endpoint marker',
  endpoint.pins === 0, JSON.stringify(endpoint));
check('Street View and Details survive on an endpoint card',
  endpoint.actions.some((label) => /Street View/.test(label))
    && endpoint.actions.some((label) => /Details/.test(label)),
  JSON.stringify(endpoint.actions));

const destination = await page.evaluate(() => {
  roadInfoSuppressedUntil = 0;
  openEndpointCard('end');
  const readout = document.getElementById('readout');
  return {
    heading: readout.querySelector('.rt-title')?.textContent,
    summary: readout.querySelector('.readout-safety-summary')?.textContent,
  };
});
check('the destination says the trip ends there',
  destination.heading === 'Green Lake' && /ends here/i.test(destination.summary || ''),
  JSON.stringify(destination));

// An ordinary map point still offers Navigate -- only endpoints lose it.
const ordinary = await page.evaluate(() => {
  roadInfoSuppressedUntil = 0;
  dismissRoadInfo();
  renderReadout(null, { lng: -122.30, lat: 47.70 }, { x: 200, y: 400 });
  return [...document.querySelectorAll('#readout .readout-primary-actions > button')]
    .map((button) => button.textContent.replace(/\s+/g, ' ').trim());
});
check('an ordinary point keeps Navigate',
  ordinary.some((label) => /Navigate/.test(label)), JSON.stringify(ordinary));

check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
