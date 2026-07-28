/* County transportation overlays, on the display side.
 *
 * The WSDOT layers we already carry stop at the state highway system. A county
 * road is invisible to them no matter how well the county has mapped it --
 * which is why Deer Lake Road on Whidbey showed no shoulder, no speed and no
 * stress rating despite carrying Island County's own signed bike route.
 *
 * The county's BIKE ROUTES are not handled here. They are baked into
 * graph2.bin.gz and roads.pmtiles at build time by scripts/county_conflate.py,
 * because the map's colours come from tile properties that the renderer reads
 * directly -- a flag conflated in JavaScript could change routing and the cards
 * but never the colour, leaving a road routed as passing and drawn as failing.
 *
 * What is left here is what the display needs and the build cannot give it:
 * answering "what does this county say about this spot?" for a card, from the
 * bundle's own geometry. Traffic counts stay on this side deliberately -- they
 * never touch colour, and they are the part that churns.
 *
 * Loaded as a classic script by index.html and via importScripts() by the
 * router worker, so it must not use module syntax.
 *
 * A bundle is:
 *   { county, state, fips, built, sources,
 *     routes:  [ { name, status: 'existing'|'planned', network, coords } ],
 *     traffic: [ { name, adt, year, lanes, speed, coords } ] }
 */
(function (root) {
  'use strict';

  var M_PER_DEG_LAT = 110540;
  function metersPerDegLon(lat) {
    return 111320 * Math.cos(lat * Math.PI / 180);
  }

  /* ----------------------------------------------------------- point lookup */

  /* The router knows county data per graph edge, but a road the rider TAPS
   * comes from a vector tile and has no edge behind it. So the same bundles
   * answer a second question -- "what does the county say about this spot?" --
   * against their own geometry.
   *
   * Tolerance is looser than the conflation snap because a tap is aimed by
   * thumb, and the caller has already decided which road was hit.
   */
  var TAP_M = 30;

  // Bounding box of the built routes and traffic lines, for grid sizing.
  function lookupBounds(bundles) {
    var box = { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };
    for (var b = 0; b < bundles.length; b++) {
      if (!bundles[b]) continue;
      var groups = [bundles[b].routes || [], bundles[b].traffic || []];
      for (var gi = 0; gi < groups.length; gi++) {
        for (var i = 0; i < groups[gi].length; i++) {
          var coords = groups[gi][i].coords || [];
          for (var j = 0; j < coords.length; j++) {
            var c = coords[j];
            if (c[0] < box.minLon) box.minLon = c[0];
            if (c[0] > box.maxLon) box.maxLon = c[0];
            if (c[1] < box.minLat) box.minLat = c[1];
            if (c[1] > box.maxLat) box.maxLat = c[1];
          }
        }
      }
    }
    return isFinite(box.minLon) ? box : null;
  }

  function lookupIndex(bundles) {
    var cells = new Map();
    var box = lookupBounds(bundles);
    if (!box) return null;
    var mLon = metersPerDegLon((box.minLat + box.maxLat) / 2);
    var dLon = TAP_M / mLon;
    var dLat = TAP_M / M_PER_DEG_LAT;
    function put(gx, gy, entry) {
      var key = gx + ':' + gy;
      var bucket = cells.get(key);
      if (bucket) bucket.push(entry); else cells.set(key, [entry]);
    }
    function add(items, kind, bundle) {
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (kind === 'route' && item.status !== 'existing') continue;
        var coords = item.coords;
        for (var j = 0; j < coords.length - 1; j++) {
          var entry = { kind: kind, item: item, a: coords[j], b: coords[j + 1], bundle: bundle };
          var lo = Math.min(coords[j][0], coords[j + 1][0]);
          var hi = Math.max(coords[j][0], coords[j + 1][0]);
          var la = Math.min(coords[j][1], coords[j + 1][1]);
          var ha = Math.max(coords[j][1], coords[j + 1][1]);
          for (var gx = Math.floor(lo / dLon); gx <= Math.floor(hi / dLon); gx++) {
            for (var gy = Math.floor(la / dLat); gy <= Math.floor(ha / dLat); gy++) put(gx, gy, entry);
          }
        }
      }
    }
    for (var b = 0; b < bundles.length; b++) {
      if (!bundles[b]) continue;
      add(bundles[b].routes || [], 'route', bundles[b]);
      add(bundles[b].traffic || [], 'traffic', bundles[b]);
    }
    return { cells: cells, dLon: dLon, dLat: dLat, mLon: mLon };
  }

  function distToSpan(lon, lat, a, b, mLon) {
    var ax = (a[0] - lon) * mLon;
    var ay = (a[1] - lat) * M_PER_DEG_LAT;
    var bx = (b[0] - lon) * mLon;
    var by = (b[1] - lat) * M_PER_DEG_LAT;
    var vx = bx - ax;
    var vy = by - ay;
    var span = vx * vx + vy * vy;
    var t = span === 0 ? 0 : Math.max(0, Math.min(1, -(ax * vx + ay * vy) / span));
    return Math.hypot(ax + vx * t, ay + vy * t);
  }

  /**
   * What county data covers (lon, lat), or null. Pass the index from
   * lookupIndex() so it is built once, not once per tap.
   */
  function lookup(index, lon, lat) {
    if (!index) return null;
    var cx = Math.floor(lon / index.dLon);
    var cy = Math.floor(lat / index.dLat);
    var bestRoute = null;
    var bestTraffic = null;
    var bestRouteD = Infinity;
    var bestTrafficD = Infinity;
    var county = null;
    for (var gx = cx - 1; gx <= cx + 1; gx++) {
      for (var gy = cy - 1; gy <= cy + 1; gy++) {
        var bucket = index.cells.get(gx + ':' + gy);
        if (!bucket) continue;
        for (var k = 0; k < bucket.length; k++) {
          var entry = bucket[k];
          var d = distToSpan(lon, lat, entry.a, entry.b, index.mLon);
          if (d > TAP_M) continue;
          county = county || entry.bundle.county;
          if (entry.kind === 'route') {
            if (d < bestRouteD) { bestRouteD = d; bestRoute = entry.item; }
          } else if (d < bestTrafficD) { bestTrafficD = d; bestTraffic = entry.item; }
        }
      }
    }
    if (!bestRoute && !bestTraffic) return null;
    return {
      county: county,
      route: bestRoute ? bestRoute.name : null,
      adt: bestTraffic ? bestTraffic.adt : null,
      adtYear: bestTraffic && bestTraffic.year ? bestTraffic.year : null,
      // The county's own speed limit, which is often the only one there is:
      // OSM leaves most county roads untagged and the app then estimates.
      countySpeed: bestTraffic && bestTraffic.speed ? bestTraffic.speed : null,
      roadName: bestTraffic ? bestTraffic.name : null,
    };
  }

  /* --------------------------------------------------------- traffic rating */

  /* Average daily traffic is a raw count, and a raw count means nothing to a
   * rider who does not already know what 2,000 vehicles a day feels like. The
   * rating below turns it into 1-5.
   *
   * The breakpoints follow the volume thresholds used in bicycle level-of-
   * traffic-stress work (Mekuria/Furth and the FHWA Bikeway Selection Guide),
   * where roughly 1,500 and 3,000 vehicles per day are the points at which a
   * two-lane road stops feeling shared and starts feeling like traffic.
   *
   * IMPORTANT: this rating is DISPLAY ONLY. It does not enter the safety
   * verdict and it does not change routing. Nothing in safety-model.js reads
   * it. That is deliberate -- see "County traffic counts" in
   * docs/SAFETY-MODEL.md -- because coverage is one county so far and half the
   * counts predate 2010.
   */
  var TRAFFIC_LEVELS = [
    { level: 1, max: 500, label: 'Very light', blurb: 'A car every few minutes.' },
    { level: 2, max: 1500, label: 'Light', blurb: 'Steady but easy to share.' },
    { level: 3, max: 3000, label: 'Moderate', blurb: 'Regular traffic; expect to be passed often.' },
    { level: 4, max: 8000, label: 'Heavy', blurb: 'Near-constant traffic for a two-lane road.' },
    { level: 5, max: Infinity, label: 'Very heavy', blurb: 'Arterial volumes.' },
  ];

  function trafficLevel(adt) {
    if (adt == null || !(adt > 0)) return null;
    for (var i = 0; i < TRAFFIC_LEVELS.length; i++) {
      if (adt <= TRAFFIC_LEVELS[i].max) return TRAFFIC_LEVELS[i];
    }
    return TRAFFIC_LEVELS[TRAFFIC_LEVELS.length - 1];
  }

  // A count is a measurement with a date on it. Counties re-count a road when
  // they get to it, so one log can hold a 2017 reading beside a 1977 one, and
  // presenting either as "today" would be a guess dressed up as data.
  var STALE_AFTER_YEARS = 10;

  function trafficIsStale(year, now) {
    if (!year) return true;
    var thisYear = (now || new Date()).getFullYear();
    return thisYear - year > STALE_AFTER_YEARS;
  }

  // The routes of a bundle as a FeatureCollection, for drawing. Planned routes
  // are included -- seeing what a county intends to build is useful -- and
  // carry status so the map can style them as the proposals they are.
  function routesToGeoJSON(bundles) {
    var features = [];
    for (var b = 0; b < bundles.length; b++) {
      if (!bundles[b]) continue;
      var routes = bundles[b].routes || [];
      for (var i = 0; i < routes.length; i++) {
        features.push({
          type: 'Feature',
          properties: {
            n: routes[i].name,
            status: routes[i].status,
            t: routes[i].network || 'lcn',
            county: bundles[b].county,
            state: bundles[b].state,
          },
          geometry: { type: 'LineString', coordinates: routes[i].coords },
        });
      }
    }
    return { type: 'FeatureCollection', features: features };
  }

  // The built network's bounding box, padded, or null. Callers use it to ask
  // "could this county possibly matter here?" before doing real work.
  function bounds(bundles, padM) {
    return bundleBounds(bundles || [], padM || 0, true);
  }

  root.CountyData = {
    TAP_M: TAP_M,
    TRAFFIC_LEVELS: TRAFFIC_LEVELS,
    STALE_AFTER_YEARS: STALE_AFTER_YEARS,
    lookupIndex: lookupIndex,
    lookup: lookup,
    trafficLevel: trafficLevel,
    trafficIsStale: trafficIsStale,
    routesToGeoJSON: routesToGeoJSON,
  };
}(typeof self !== 'undefined' ? self : this));
