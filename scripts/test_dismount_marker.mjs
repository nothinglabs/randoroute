#!/usr/bin/env node
// Route markers: one vocabulary, one spacing clock, never a pile of icons.
//
// Walking, steep climbing, heavy traffic, unpaved surface, and technical
// ways each flag on the route line itself, ~700 m apart, and where several
// apply to one stretch exactly ONE icon is placed per slot. The walking
// marker keeps its enlarged tap target: a tap on the figure answers with the
// segment underneath.
import { appPage, chromiumPath, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};

/* ------------------------------------------------ the planner, direct */
const plan = await page.evaluate(() => {
  const build = (count, propsFor, stepLng = .002) => {
    const lat = 47.55;
    const coords = Array.from({ length: count + 1 }, (_, i) => [-122.30 + i * stepLng, lat]);
    const sdata = {
      type: 'FeatureCollection',
      features: coords.slice(0, -1).map((_, i) => ({ type: 'Feature',
        properties: routeSegProps({ lenM: 150, c0: i, c1: i + 1, level: 1,
          mph: 25, sh: 4, ...propsFor(i) }),
        geometry: { type: 'LineString', coordinates: coords.slice(i, i + 2) } })),
    };
    const out = buildRouteMarkerData(sdata);
    return { walk: out.walk.features.map((f) => f.geometry.coordinates),
      other: out.other.features.map((f) => ({ kind: f.properties.kind,
        at: f.geometry.coordinates })) };
  };
  const gapM = (a, b) => Math.hypot((b[0] - a[0]) * 75200, (b[1] - a[1]) * 111320);
  const climb = build(19, () => ({ gradePct: 12 }));
  const gaps = climb.other.slice(1).map((m, i) => Math.round(gapM(climb.other[i].at, m.at)));
  return {
    climbCount: climb.other.length,
    climbKinds: [...new Set(climb.other.map((m) => m.kind))],
    gaps,
    flat: build(19, () => ({ gradePct: 0 })).other.length,
    blip: build(1, () => ({ gradePct: 14 }), .0004).other.length,
    absurd: build(19, () => ({ gradePct: 60 })).other.length,
    traffic: build(19, () => ({ measures: { adt: 21000 } })).other
      .every((m) => m.kind === 'traffic'),
    trafficOnInfra: build(19, () => ({ flags: 8, measures: { adt: 21000 } })).other.length,
    rocks: build(19, () => ({ surface: 2 })).other.every((m) => m.kind === 'unpaved'),
    odd: build(19, () => ({ mtb: true })).other.every((m) => m.kind === 'odd'),
    // Steep AND unpaved together: one icon per slot, never two.
    mixed: (() => {
      const m = build(19, () => ({ gradePct: 12, surface: 2 }));
      return { count: m.other.length,
        kinds: [...new Set(m.other.map((x) => x.kind))].sort() };
    })(),
    walkChain: build(19, () => ({ dismount: true, official: 8 })).walk.length,
  };
});
check(`a 2.8 km 12% climb carries a chain of mountains (${plan.climbCount})`,
  plan.climbCount >= 3 && plan.climbCount <= 5
    && plan.climbKinds.join() === 'steep', JSON.stringify(plan.climbKinds));
check('spaced apart, never crowded', plan.gaps.every((g) => g >= 600),
  JSON.stringify(plan.gaps));
check('flat riding carries none', plan.flat === 0, String(plan.flat));
check('a 30 m spike is noise, not a climb', plan.blip === 0, String(plan.blip));
check('an incredible grade is the data error it is', plan.absurd === 0, String(plan.absurd));
check('heavy traffic on a road gets the car', plan.traffic === true);
check('but a busy road BESIDE separated infra does not badge the infra',
  plan.trafficOnInfra === 0, String(plan.trafficOnInfra));
check('confirmed unpaved gets the rocks', plan.rocks === true);
check('a technical way gets the question mark', plan.odd === true);
check('a steep AND unpaved stretch still gets one icon per slot',
  plan.mixed.count >= 3 && plan.mixed.count <= 5
    && plan.mixed.kinds.every((k) => k === 'steep' || k === 'unpaved'),
  JSON.stringify(plan.mixed));
check('a long walked stretch carries a chain of walkers',
  plan.walkChain >= 3 && plan.walkChain <= 5, String(plan.walkChain));

/* --------------------------------- drawn on the map, with the tap target */
const drawn = await page.evaluate(async () => {
  const lat = 47.60;
  const coords = Array.from({ length: 7 }, (_, i) => [-122.34 + i * .002, lat]);
  const segs = coords.slice(0, -1).map((_, i) => ({
    lenM: 150, c0: i, c1: i + 1, level: 1, mph: 25, sh: 4,
    dismount: i >= 2 && i <= 3, official: i >= 2 && i <= 3 ? 136 : 0,
  }));
  map.jumpTo({ center: [-122.34 + 3 * .002, lat], zoom: 15 });
  drawRoute(coords, [], segs);
  await new Promise((resolve) => { map.once('idle', resolve); setTimeout(resolve, 8000); });
  const image = map.style.getImage('route-dismount-marker-icon');
  const markers = map.querySourceFeatures('route-dismount');
  window.__markerAt = markers[0]?.geometry.coordinates;
  return {
    markerCount: new Set(markers.map((f) => String(f.geometry.coordinates))).size,
    markerLng: markers[0]?.geometry.coordinates?.[0],
    hasSource: !!map.getSource('route-dismount'),
    cssPx: image ? Math.round(image.data.width / image.pixelRatio) : 0,
    haloRadius: map.getPaintProperty('route-dismount-halo', 'circle-radius'),
  };
});
check('the walked stretch carries a walker on the map',
  drawn.markerCount >= 1 && drawn.hasSource, JSON.stringify(drawn));
check('inside the walked stretch, not somewhere else',
  drawn.markerLng > -122.34 + 2 * .002 - .0002 && drawn.markerLng < -122.34 + 4 * .002 + .0002,
  `marker at lng ${drawn.markerLng}`);
check('the icon draws well above the old 18 px', drawn.cssPx >= 24, `${drawn.cssPx} CSS px`);
check('the halo is sized to cover it', drawn.haloRadius * 2 >= drawn.cssPx,
  `radius ${drawn.haloRadius} against a ${drawn.cssPx} px icon`);

const taps = await page.evaluate((radius) => {
  const at = map.project(window.__markerAt);
  const inspect = (dx, dy) => {
    const feature = featureAt({ x: at.x + dx, y: at.y + dy });
    return feature ? { layer: feature.layer.id, dismount: feature.properties.dismount } : null;
  };
  const onMarker = (dx, dy) => dismountMarkerAt({ x: at.x + dx, y: at.y + dy });
  const elsewhere = map.project([window.__markerAt[0] + .004, window.__markerAt[1]]);
  return {
    centre: inspect(0, 0),
    edge: inspect(0, -(radius - 2)),
    onCentre: onMarker(0, 0),
    onEdge: onMarker(0, -(radius - 2)),
    onBeyond: onMarker(0, radius * 3),
    onElsewhere: dismountMarkerAt({ x: elsewhere.x, y: elsewhere.y }),
  };
}, drawn.haloRadius);
check('tapping the walker reports the dismount',
  taps.centre?.layer === 'route-seg-hit' && taps.centre?.dismount === 1, JSON.stringify(taps));
check('and so does tapping its edge, clear of the route line',
  taps.edge?.layer === 'route-seg-hit' && taps.edge?.dismount === 1, JSON.stringify(taps));
check('the marker owns the taps that land on it', taps.onCentre && taps.onEdge,
  JSON.stringify(taps));
check('and no others', !taps.onBeyond && !taps.onElsewhere, JSON.stringify(taps));

check('drawing the markers raises no page errors', page.pageErrors.length === 0,
  page.pageErrors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
