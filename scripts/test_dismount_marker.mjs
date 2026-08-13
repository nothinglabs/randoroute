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
    traffic: (() => {
      const m = build(19, () => ({ measures: { adt: 21000 } })).other;
      return m.length > 0 && m.every((x) => x.kind === 'traffic');
    })(),
    // The dinosaur starts at the tier that starts driving cautions -- "a busy
    // through road" -- not only at main-highway volumes.
    busyTraffic: (() => {
      const m = build(19, () => ({ measures: { adt: 6500 } })).other;
      return m.length > 0 && m.every((x) => x.kind === 'traffic');
    })(),
    quietTraffic: build(19, () => ({ measures: { adt: 4000 } })).other.length,
    trafficOnInfra: build(19, () => ({ flags: 8, measures: { adt: 21000 } })).other.length,
    // A trusted bike lane keeps its lime unbadged however busy the road
    // beside it -- but a lane demoted to caution by a high stress rating
    // carries the dinosaur again.
    trafficOnBikeLane: build(19, () => ({ facility: 2, measures: { adt: 21000 } })).other.length,
    trafficOnStressedLane: (() => {
      const m = build(19, () => ({ facility: 2, lts: 4, measures: { adt: 21000 } })).other;
      return m.length > 0 && m.every((x) => x.kind === 'traffic');
    })(),
    rocks: build(19, () => ({ surface: 2 })).other.every((m) => m.kind === 'unpaved'),
    odd: build(19, () => ({ mtb: true })).other.every((m) => m.kind === 'odd'),
    // Steep AND unpaved together: one CLUSTERED badge per slot naming both.
    mixed: (() => {
      const m = build(19, () => ({ gradePct: 12, surface: 2 }));
      return { count: m.other.length,
        kinds: [...new Set(m.other.map((x) => x.kind))].sort() };
    })(),
    walkChain: build(19, () => ({ dismount: true, official: 8 })).walk.length,
    // The ! on rules failures: one per contiguous failed area, two on a long
    // one. Short failures and overlapping explanations must never erase it.
    failLong: build(19, () => ({ level: 4, mph: 50, sh: 0 })).other
      .filter((m) => m.kind === 'fail').length,
    failShort: build(5, () => ({ level: 4, mph: 50, sh: 0 })).other
      .filter((m) => m.kind === 'fail').length,
    failSteep: (() => {
      const m = build(19, () => ({ level: 4, mph: 50, sh: 0, gradePct: 12 })).other;
      return { fails: m.filter((x) => x.kind === 'fail').length,
        steeps: m.filter((x) => x.kind === 'steep').length };
    })(),
    failBlip: build(1, () => ({ level: 4, mph: 50, sh: 0 }), .0004).other
      .filter((m) => m.kind === 'fail').length,
    failDesignatedBlip: build(1, () => ({ level: 4, mph: 50, sh: 0, flags: 64 }), .0004).other
      .filter((m) => m.kind === 'fail-designated').length,
    failDesignationTransition: (() => {
      const m = build(12, (i) => ({ level: 4, mph: 50, sh: 0, flags: i >= 6 ? 64 : 0 }));
      return [...new Set(m.other.filter((x) => x.kind.startsWith('fail'))
        .map((x) => x.kind))].sort();
    })(),
    // A steep reading against a ferry slip is shoreline DEM artifact --
    // Clinton's flat dock booked 11% -- so the mountain is blind near a leg.
    dockSteep: build(19, (i) => (i < 5 ? { flags: 32 }
      : (i === 5 || i === 6 ? { gradePct: 14 } : {}))).other.length,
    inlandSteep: build(19, (i) => (i < 5 ? { flags: 32 }
      : (i === 12 || i === 13 ? { gradePct: 14 } : {}))).other.length,
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
check('heavy traffic on a road gets the dinosaur', plan.traffic === true);
check('and so does busy-through-road traffic, where cautions begin',
  plan.busyTraffic === true);
check('while a genuinely quiet road stays unbadged', plan.quietTraffic === 0,
  String(plan.quietTraffic));
check('but a busy road BESIDE separated infra does not badge the infra',
  plan.trafficOnInfra === 0, String(plan.trafficOnInfra));
check('a trusted bike lane on a busy road stays unbadged',
  plan.trafficOnBikeLane === 0, String(plan.trafficOnBikeLane));
check('a bike lane demoted to caution by its stress rating carries the dinosaur',
  plan.trafficOnStressedLane === true);
check('confirmed unpaved gets the rocks', plan.rocks === true);
check('a technical way gets the question mark', plan.odd === true);
check('a steep AND unpaved stretch clusters both kinds in every slot',
  plan.mixed.count >= 3 && plan.mixed.count <= 5
    && plan.mixed.kinds.length === 1 && plan.mixed.kinds[0] === 'steep+unpaved',
  JSON.stringify(plan.mixed));
check('a long walked stretch carries a chain of walkers',
  plan.walkChain >= 3 && plan.walkChain <= 5, String(plan.walkChain));
check('a long failed stretch carries two !, not a chain', plan.failLong === 2,
  String(plan.failLong));
check('a short failed stretch carries one', plan.failShort === 1,
  String(plan.failShort));
check('a hill badge never suppresses the fail badge',
  plan.failSteep.fails >= 1 && plan.failSteep.steeps >= 3,
  JSON.stringify(plan.failSteep));
check('even a very short failed stretch gets !', plan.failBlip === 1, String(plan.failBlip));
check('a very short designated-route failure gets !?',
  plan.failDesignatedBlip === 1, String(plan.failDesignatedBlip));
check('normal and designated failure runs keep their own icons',
  plan.failDesignationTransition.join() === 'fail,fail-designated',
  JSON.stringify(plan.failDesignationTransition));
check('a steep reading at a ferry slip is artifact: no mountain on the dock',
  plan.dockSteep === 0, String(plan.dockSteep));
check('while the same climb clear of the slip keeps its mountain',
  plan.inlandSteep >= 1, String(plan.inlandSteep));

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
  const trafficImage = map.style.getImage('route-marker-traffic');
  const trafficPixels = trafficImage?.data?.data;
  const trafficWidth = trafficImage?.data?.width || 0;
  const trafficHeight = trafficImage?.data?.height || 0;
  const bodyPixel = (x, y) => {
    const offset = (y * trafficWidth + x) * 4;
    return trafficPixels?.[offset] === 126 && trafficPixels?.[offset + 1] === 38
      && trafficPixels?.[offset + 2] === 28 && trafficPixels?.[offset + 3] === 255;
  };
  const bodyCount = (x0, y0, x1, y1) => {
    let count = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) count += bodyPixel(x, y) ? 1 : 0;
    }
    return count;
  };
  const markers = map.querySourceFeatures('route-dismount');
  window.__markerAt = markers[0]?.geometry.coordinates;
  return {
    markerCount: new Set(markers.map((f) => String(f.geometry.coordinates))).size,
    markerLng: markers[0]?.geometry.coordinates?.[0],
    hasSource: !!map.getSource('route-dismount'),
    cssPx: image ? Math.round(image.data.width / image.pixelRatio) : 0,
    haloRadius: map.getPaintProperty('route-dismount-halo', 'circle-radius'),
    // Test the registered pixels, not marker-icons.js source text. These four
    // separated zones describe the tyrannosaur silhouette: a raised tail,
    // bulky body, oversized head, and feet. The old car has none of that
    // distinctive high-left/high-right profile.
    dinosaur: trafficPixels ? {
      dimensions: [trafficWidth, trafficHeight],
      tail: bodyCount(6, 14, 18, 22),
      torso: bodyCount(20, 20, 31, 31),
      head: bodyCount(31, 10, 41, 20),
      feet: bodyCount(18, 34, 36, 38),
    } : null,
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
check('the busy-road badge is a recognizable dinosaur silhouette',
  drawn.dinosaur?.dimensions?.join('x') === '48x48'
    && drawn.dinosaur.tail >= 10 && drawn.dinosaur.torso >= 30
    && drawn.dinosaur.head >= 30 && drawn.dinosaur.feet >= 10,
  JSON.stringify(drawn.dinosaur));

const failLayer = await page.evaluate(() => ({
  hasDesignatedImage: Boolean(map.style.getImage('route-marker-fail-designated')),
  allowOverlap: map.getLayoutProperty('route-fail-marker', 'icon-allow-overlap'),
  ignorePlacement: map.getLayoutProperty('route-fail-marker', 'icon-ignore-placement'),
}));
check('the !? icon is registered for active routes', failLayer.hasDesignatedImage,
  JSON.stringify(failLayer));
check('fail icons cannot be removed by symbol collisions',
  failLayer.allowOverlap === true && failLayer.ignorePlacement === true,
  JSON.stringify(failLayer));

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

// Every walked stretch draws AMBER on the route, tagged or synthesised: a
// dismount that painted as lime trail read as the best riding on the route
// while actually being a hike. The colour makes a long walked section
// obvious at every zoom; the walker chain says why.
const styles = await page.evaluate(() => ({
  tagged: routeVisualStyle(routeSegProps({ lenM: 150, mph: 0, sh: -1, flags: 8,
    facility: 5, level: 1, official: 136, dismount: true })),
  synthesised: routeVisualStyle(routeSegProps({ lenM: 150, mph: 0, sh: -1, flags: 8,
    facility: 5, level: 1, official: 8, dismount: true })),
  ordinaryTrail: routeVisualStyle(routeSegProps({ lenM: 150, mph: 0, sh: -1, flags: 8,
    facility: 5, level: 1, official: 0 })),
}));
check('a tagged dismount stretch draws caution', styles.tagged === 'caution',
  JSON.stringify(styles));
check('and so does a synthesised walk link', styles.synthesised === 'caution',
  JSON.stringify(styles));
check('while a ridable trail keeps its lime', styles.ordinaryTrail === 'trail',
  JSON.stringify(styles));

check('drawing the markers raises no page errors', page.pageErrors.length === 0,
  page.pageErrors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
