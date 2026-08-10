#!/usr/bin/env node
// A tap on a road draws the stretch of road the card is describing, rather
// than a pin marking the pixel the finger landed on -- the card is about that
// piece of road, so showing it says more than a dot does. A tap on nothing
// keeps the pin, because there the point really is the subject.
//
// It marks the road WITHOUT painting over it. Two bright lines ride alongside
// and ripple outward; the verdict colour stays visible between them.
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
  && typeof openEndpointCard === 'function' && typeof TAP_HIGHLIGHT_LAYERS !== 'undefined'
  && TAP_HIGHLIGHT_LAYERS.every((id) => map.getLayer(id)),
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
    shown: TAP_HIGHLIGHT_LAYERS.filter((id) =>
      map.getLayoutProperty(id, 'visibility') === 'visible'),
    layers: TAP_HIGHLIGHT_LAYERS,
    drawn: map.getSource('tap-highlight')._data?.geometry?.coordinates?.length,
    matchesTapped: JSON.stringify(map.getSource('tap-highlight')._data.geometry.coordinates)
      === JSON.stringify(line),
    pins: document.querySelectorAll('.search-result-marker').length,
  };
});
check('tapping a road opens its card and draws that stretch',
  roadTap.opened && roadTap.cardShown && roadTap.drawn === 3
    && roadTap.shown.length === roadTap.layers.length, JSON.stringify(roadTap));
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
  const first = Math.min(...TAP_HIGHLIGHT_LAYERS.map((id) => ids.indexOf(id)));
  return {
    above: ids.slice(first).filter((id) => !TAP_HIGHLIGHT_LAYERS.includes(id)),
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

/* ------------------------------------------ it must not overwrite the verdict */
// The first version painted a solid yellow core straight over the tapped road.
// That covered the segment's own safety colour with something that reads as a
// bike facility -- so tapping a road to ask "how safe is this?" replaced the
// answer with a lie, and a colour-blind rider had no way to tell. Nothing here
// may sit on the road: every layer is offset clear of it, so the verdict colour
// survives underneath, and the effect is carried by position and motion rather
// than by hue.
const flanking = await page.evaluate(() => {
  const paint = (id) => ({
    offset: map.getPaintProperty(id, 'line-offset'),
    width: map.getPaintProperty(id, 'line-width'),
    color: map.getPaintProperty(id, 'line-color'),
  });
  const verdictColours = new Set([
    ...Object.values(RoutePalette.LEVEL), RoutePalette.bikeNetwork,
    RoutePalette.designated, RoutePalette.trailCentreline, RoutePalette.trailDots,
  ]);
  return {
    layers: TAP_HIGHLIGHT_LAYERS.map(paint),
    borrowsAVerdictColour: TAP_HIGHLIGHT_LAYERS
      .some((id) => verdictColours.has(map.getPaintProperty(id, 'line-color'))),
    sides: TAP_HIGHLIGHT_LAYERS
      .map((id) => Math.sign(map.getPaintProperty(id, 'line-offset'))),
    scale: tapRippleScale(),
  };
});
// 4.5 px is the half-width of the widest line the map draws (the route) AT FULL
// ZOOM, so an inner edge beyond that is clear of anything it can be laid over --
// including the case a rider taps most, a road on their own route.
//
// Times the zoom scale, because 4.5 was a full-zoom figure applied at every
// zoom, which is the same mistake the rails themselves used to make: the route
// line thins as you zoom out and the rails now thin with it. The guarantee that
// the highlight does not paint over the road is separately MEASURED below, on
// real pixels; this is the cheap geometric check that catches a gross
// regression first.
const clearance = 4.5 * flanking.scale;
check('every part of the highlight is offset clear of the road it marks',
  flanking.layers.length >= 2
    && flanking.layers.every((layer) => Math.abs(layer.offset) - layer.width / 2 >= clearance),
  `clearance ${clearance.toFixed(2)} px at scale ${flanking.scale.toFixed(2)}: `
  + JSON.stringify(flanking.layers));
check('and it flanks both sides, not one',
  flanking.sides.includes(-1) && flanking.sides.includes(1),
  JSON.stringify(flanking.sides));
check('in a colour no verdict uses, so it cannot be read as one',
  flanking.borrowsAVerdictColour === false,
  JSON.stringify(flanking.layers.map((layer) => layer.color)));

/* --------------------------------------------- and prove it on real pixels */
// The properties above describe the intent; this reads the frame. A highlight
// that covers the road is the whole bug, and only the rendered image can say
// whether it does -- the first version's offsets looked fine on paper too,
// because it had none.
//
// Tap a real road, find where its line actually is on screen, and compare that
// column of pixels with and without the highlight drawn.
const rendered = await page.evaluate(async () => {
  const canvas = map.getCanvas();
  const settled = () => new Promise((resolve) => {
    map.once('idle', resolve);
    map.triggerRepaint();
  });
  const frame = () => {
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    copy.getContext('2d').drawImage(canvas, 0, 0);
    return copy.getContext('2d');
  };
  const ratio = canvas.width / canvas.clientWidth;
  const at = (ctx, x, y) => {
    const d = ctx.getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data;
    return `${d[0]},${d[1]},${d[2]}`;
  };

  dismissRoadInfo();
  // Somewhere with a dense street grid, so a tap lands on a scored road.
  map.jumpTo({ center: [-122.3447, 47.6605], zoom: 16 });
  await settled();
  const tap = { x: Math.round(canvas.clientWidth / 2), y: Math.round(canvas.clientHeight / 2) };

  roadInfoSuppressedUntil = 0;
  if (!inspectRoadAt(tap, map.unproject([tap.x, tap.y]))) return { tapped: false };
  const drawn = map.getSource('tap-highlight')._data.geometry;
  const line = drawn.type === 'MultiLineString' ? drawn.coordinates[0] : drawn.coordinates;
  // A vertex near the middle of the drawn stretch: on the road, and away from
  // the ends where the rails' round caps curl in.
  const centre = map.project(line[Math.floor(line.length / 2)]);
  // Perpendicular to the road, so "across the line" is across the rails too.
  const a = map.project(line[0]);
  const b = map.project(line[line.length - 1]);
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const normal = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
  const across = (offset) => ({
    x: centre.x + normal.x * offset, y: centre.y + normal.y * offset,
  });

  dismissRoadInfo();
  await settled();
  const clean = frame();
  roadInfoSuppressedUntil = 0;
  inspectRoadAt(tap, map.unproject([tap.x, tap.y]));
  stopTapRipple();
  restTapRipple();
  await settled();
  const marked = frame();

  const road = [];
  for (let offset = -3; offset <= 3; offset++) {
    const p = across(offset);
    road.push({ offset, before: at(clean, p.x, p.y), after: at(marked, p.x, p.y) });
  }
  const flank = [];
  for (const offset of [-9, -8, -7, 7, 8, 9]) {
    const p = across(offset);
    flank.push({ offset, before: at(clean, p.x, p.y), after: at(marked, p.x, p.y) });
  }
  return { tapped: true, road, flank };
});
check('a tap lands on a real road for the pixel check', rendered.tapped === true);
check('the road under the highlight is pixel-for-pixel what it was without it',
  rendered.road.every((s) => s.before === s.after), JSON.stringify(rendered.road));
check('while the ground beside it is not, because that is where the marker went',
  rendered.flank.some((s) => s.before !== s.after), JSON.stringify(rendered.flank));

/* ----------------------------- and it is sized against the road, not the screen */
// The rails were fixed pixel offsets, so their footprint was the same ~45 px
// whether the road beneath was 10 px wide or 2. Zoomed out that buried the very
// thing the highlight points at (field report: "too much, especially if zoomed
// out; less huge, and consistent at various zoom levels"). Consistency here
// means the same SHAPE against the road, which means riding a zoom ramp like
// every other line on the map does.
const scaled = await page.evaluate(async () => {
  const settled = () => new Promise((resolve) => {
    map.once('idle', resolve);
    map.triggerRepaint();
  });
  const read = async (z) => {
    map.jumpTo({ center: [-122.3447, 47.6605], zoom: z });
    await settled();
    restTapRipple();
    const id = TAP_HIGHLIGHT_LAYERS[0];
    return {
      offset: Math.abs(map.getPaintProperty(id, 'line-offset')),
      width: map.getPaintProperty(id, 'line-width'),
    };
  };
  return { far: await read(11), near: await read(16) };
});
check('the highlight is drawn narrower when zoomed out',
  scaled.far.offset < scaled.near.offset && scaled.far.width < scaled.near.width,
  JSON.stringify(scaled));
check('and not so narrow it disappears', scaled.far.offset > 2 && scaled.far.width > 1,
  JSON.stringify(scaled));
check('while up close it keeps the clearance it was measured for',
  scaled.near.offset >= 8, JSON.stringify(scaled));

// A still highlight is a highlight: reduced motion, and a screenshot, both get
// the flanking pair held at full strength rather than caught mid-fade.
const moving = await page.evaluate(() => new Promise((resolve) => {
  const read = () => TAP_HIGHLIGHT_LAYERS.map((id) => ({
    offset: map.getPaintProperty(id, 'line-offset'),
    opacity: map.getPaintProperty(id, 'line-opacity'),
  }));
  // The pixel check above deliberately froze the ripple to compare frames.
  // Start it the way a tap does, rather than reading whatever it left behind.
  startTapRipple();
  const first = read();
  setTimeout(() => {
    const later = read();
    restTapRipple();
    resolve({
      first, later, rested: read(),
      changed: JSON.stringify(first) !== JSON.stringify(later),
    });
  }, 400);
}));
check('the pair travels outward rather than sitting still',
  moving.changed === true, JSON.stringify({ first: moving.first, later: moving.later }));
check('and holding it still leaves it visible, for reduced motion and screenshots',
  moving.rested.every((layer) => layer.opacity > 0.5 && Math.abs(layer.offset) > 0),
  JSON.stringify(moving.rested));

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
    hidden: TAP_HIGHLIGHT_LAYERS.every((id) =>
      map.getLayoutProperty(id, 'visibility') === 'none'),
  };
});
check('a tap on open map still gets its pin, and no stretch',
  blankTap.pins === 1 && blankTap.hidden, JSON.stringify(blankTap));

const cleared = await page.evaluate(() => {
  dismissRoadInfo();
  return {
    hidden: TAP_HIGHLIGHT_LAYERS.every((id) =>
      map.getLayoutProperty(id, 'visibility') === 'none'),
    drawn: map.getSource('tap-highlight')._data?.geometry?.coordinates?.length,
    pins: document.querySelectorAll('.search-result-marker').length,
    // A 60 ms timer left running behind a closed card is a repaint every frame
    // for the rest of the session.
    animating: tapRippleTimer !== null,
  };
});
check('closing the card takes the stretch and the pin away with it',
  cleared.hidden && cleared.drawn === 0 && cleared.pins === 0
    && cleared.animating === false, JSON.stringify(cleared));

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
