/* County transportation overlays: bike networks and traffic counts.
 *
 * The WSDOT layers we already carry stop at the state highway system. A county
 * road is invisible to them no matter how well the county has mapped it --
 * which is why Deer Lake Road on Whidbey showed no shoulder, no speed and no
 * stress rating despite carrying Island County's own signed bike route.
 *
 * Counties publish this data one at a time, in their own GIS orgs, with their
 * own schemas. So a county arrives as a self-describing bundle built by
 * scripts/build_county_data.py, and is conflated onto the routing graph HERE,
 * at load time -- never baked into graph2.bin.gz. Adding a county is shipping
 * one more file, not rebuilding the state.
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

  /* ------------------------------------------------------------ conflation */

  // How close a graph edge has to pass to a county line to be the same road.
  // County centerlines and OSM centerlines are drawn independently, so they sit
  // a few metres apart even when they describe the same asphalt. Too tight and
  // a signed route lands on nothing; too loose and it bleeds onto the parallel
  // driveway. 18 m clears normal centerline disagreement and stays inside a
  // typical block.
  var SNAP_M = 18;
  // Sample interval along a county line, comfortably inside the snap radius so
  // no graph edge can slip between two consecutive samples.
  var STEP_M = 12;

  var M_PER_DEG_LAT = 110540;
  function metersPerDegLon(lat) {
    return 111320 * Math.cos(lat * Math.PI / 180);
  }

  /* Graph edges average ~190 m, so an edge cannot be represented by its
   * midpoint: a county line running the length of it would come nowhere near.
   * Each edge is therefore rasterized into every grid cell its span touches,
   * and matched by true point-to-SEGMENT distance.
   *
   * Doing that for all 856k statewide edges would cost far more memory than a
   * phone should spend on one county, so only edges inside the bundle's own
   * bounding box are indexed. A county overlay can only ever affect its own
   * county, which is exactly the property that lets counties be added one at a
   * time.
   */
  function buildEdgeIndex(edges, bbox) {
    var lat0 = (bbox.minLat + bbox.maxLat) / 2;
    var mLon = metersPerDegLon(lat0);
    var dLon = SNAP_M / mLon;
    var dLat = SNAP_M / M_PER_DEG_LAT;
    // Integer cell keys, not "gx:gy" strings. A bundle probes this grid ~85,000
    // times and each probe reads nine cells, so string concatenation alone was
    // three quarters of a million throwaway allocations and most of the cost.
    // The grid is anchored to the county's own bounding box, which makes the
    // key a plain array offset.
    var gx0 = Math.floor(bbox.minLon / dLon) - 2;
    var gy0 = Math.floor(bbox.minLat / dLat) - 2;
    var width = Math.floor(bbox.maxLon / dLon) - gx0 + 4;
    var cells = new Map();
    var indexed = 0;

    function put(gx, gy, edge) {
      var key = (gy - gy0) * width + (gx - gx0);
      var bucket = cells.get(key);
      if (bucket) {
        if (bucket[bucket.length - 1] !== edge) bucket.push(edge);
      } else {
        cells.set(key, [edge]);
      }
    }

    // Read the graph's own typed arrays directly. Going through accessor
    // functions cost 3.4 million closure calls just to reject the 98% of edges
    // that are not in this county, which dominated everything else.
    var eA = edges.edgeA;
    var eB = edges.edgeB;
    var nLon = edges.nodeLon;
    var nLat = edges.nodeLat;
    for (var i = 0; i < edges.count; i++) {
      var na = eA[i];
      var nb = eB[i];
      var alat = nLat[na];
      var blat = nLat[nb];
      // Cheap reject first, latitude before longitude: a county spans a small
      // band of latitude and this throws out most of the state in one compare.
      if (alat < bbox.minLat ? blat < bbox.minLat : (blat > bbox.maxLat && alat > bbox.maxLat)) continue;
      if (alat > bbox.maxLat && blat > bbox.maxLat) continue;
      var alon = nLon[na];
      var blon = nLon[nb];
      if (alon < bbox.minLon && blon < bbox.minLon) continue;
      if (alon > bbox.maxLon && blon > bbox.maxLon) continue;
      indexed++;
      var dx = (blon - alon) * mLon;
      var dy = (blat - alat) * M_PER_DEG_LAT;
      var steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / SNAP_M));
      for (var s = 0; s <= steps; s++) {
        var t = s / steps;
        var lon = alon + (blon - alon) * t;
        var lat = alat + (blat - alat) * t;
        put(Math.floor(lon / dLon), Math.floor(lat / dLat), i);
      }
    }
    return {
      cells: cells, dLon: dLon, dLat: dLat, mLon: mLon,
      gx0: gx0, gy0: gy0, width: width, indexed: indexed,
    };
  }

  // Candidate edges whose span passes near (lon, lat), deduped via `seen`.
  function near(index, lon, lat, out, seen, stamp) {
    var cx = Math.floor(lon / index.dLon) - index.gx0;
    var cy = Math.floor(lat / index.dLat) - index.gy0;
    var cells = index.cells;
    var width = index.width;
    for (var dy = -1; dy <= 1; dy++) {
      var row = (cy + dy) * width + cx;
      for (var dx = -1; dx <= 1; dx++) {
        var bucket = cells.get(row + dx);
        if (bucket === undefined) continue;
        for (var k = 0; k < bucket.length; k++) {
          var e = bucket[k];
          if (seen[e] === stamp) continue;
          seen[e] = stamp;
          out.push(e);
        }
      }
    }
    return out;
  }

  // Metres from a point to an edge's span, not to its midpoint.
  function distToEdge(edges, e, lon, lat, mLon) {
    var na = edges.edgeA[e];
    var nb = edges.edgeB[e];
    var ax = (edges.nodeLon[na] - lon) * mLon;
    var ay = (edges.nodeLat[na] - lat) * M_PER_DEG_LAT;
    var bx = (edges.nodeLon[nb] - lon) * mLon;
    var by = (edges.nodeLat[nb] - lat) * M_PER_DEG_LAT;
    var vx = bx - ax;
    var vy = by - ay;
    var span = vx * vx + vy * vy;
    var t = span === 0 ? 0 : Math.max(0, Math.min(1, -(ax * vx + ay * vy) / span));
    return Math.hypot(ax + vx * t, ay + vy * t);
  }

  // Walk a polyline in ~STEP_M steps, calling visit(lon, lat, bearing) at each.
  // The bearing is the county line's own local heading, which the caller uses
  // to reject roads that merely cross it.
  function walk(coords, visit) {
    var bearing = 0;
    for (var i = 0; i < coords.length - 1; i++) {
      var a = coords[i];
      var b = coords[i + 1];
      var mLon = metersPerDegLon(a[1]);
      var dx = (b[0] - a[0]) * mLon;
      var dy = (b[1] - a[1]) * M_PER_DEG_LAT;
      bearing = Math.atan2(dy, dx);
      var steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / STEP_M));
      for (var s = 0; s < steps; s++) {
        var t = s / steps;
        visit(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, bearing);
      }
    }
    var last = coords[coords.length - 1];
    visit(last[0], last[1], bearing);
  }

  // Within SNAP_M of a county line, an intersecting side street is just as
  // close as the road the line actually follows. Requiring the two to point the
  // same way (either way along it -- direction of travel is irrelevant)
  // separates "this is that road" from "this touches that road".
  var MAX_BEARING_DIFF = 40 * Math.PI / 180;

  function bearingOf(edges, e, mLon) {
    var na = edges.edgeA[e];
    var nb = edges.edgeB[e];
    return Math.atan2((edges.nodeLat[nb] - edges.nodeLat[na]) * M_PER_DEG_LAT,
      (edges.nodeLon[nb] - edges.nodeLon[na]) * mLon);
  }

  function alignedWith(a, b) {
    var d = Math.abs(a - b) % (2 * Math.PI);
    if (d > Math.PI) d = 2 * Math.PI - d;
    if (d > Math.PI / 2) d = Math.PI - d;   // a road has no preferred end
    return d <= MAX_BEARING_DIFF;
  }

  // `builtRoutesOnly` bounds the box to the geometry actually being conflated,
  // so the edge index covers the bike network rather than every county road.
  function bundleBounds(bundles, pad, builtRoutesOnly) {
    var box = { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };
    function add(lines, routesOnly) {
      for (var i = 0; i < lines.length; i++) {
        if (routesOnly && lines[i].status !== 'existing') continue;
        var coords = lines[i].coords || [];
        for (var j = 0; j < coords.length; j++) {
          var c = coords[j];
          if (c[0] < box.minLon) box.minLon = c[0];
          if (c[0] > box.maxLon) box.maxLon = c[0];
          if (c[1] < box.minLat) box.minLat = c[1];
          if (c[1] > box.maxLat) box.maxLat = c[1];
        }
      }
    }
    for (var b = 0; b < bundles.length; b++) {
      if (!bundles[b]) continue;
      add(bundles[b].routes || [], builtRoutesOnly);
      if (!builtRoutesOnly) add(bundles[b].traffic || [], false);
    }
    if (!isFinite(box.minLon)) return null;
    var dLat = pad / M_PER_DEG_LAT;
    var dLon = pad / metersPerDegLon((box.minLat + box.maxLat) / 2);
    box.minLon -= dLon; box.maxLon += dLon;
    box.minLat -= dLat; box.maxLat += dLat;
    return box;
  }

  /**
   * Conflate the county bike NETWORK onto a graph.
   *
   * `edges` is the graph's own storage, passed as typed arrays rather than
   * accessors so that rejecting the 98% of edges outside the county is a few
   * array reads instead of a few million function calls:
   *   { count, edgeA, edgeB, nodeLon, nodeLat }
   *
   * Returns { route, stats } where route[i] is 0 or 1 (on a BUILT county bike
   * route). Planned routes are deliberately never marked: a plan is not
   * pavement, and marking one would send a rider down a corridor that does not
   * exist yet.
   *
   * Traffic counts are NOT conflated here. They change nothing about routing,
   * and both cards that display them already resolve them by position through
   * lookup() -- so pushing them onto edges as well was pure duplicated work,
   * and expensive: Island County's road log is 597 miles of geometry against
   * 33 miles of bike route, which made it eighteen times the cost of the part
   * that actually matters. If traffic is ever promoted into routing, it comes
   * back here, and docs/SAFETY-MODEL.md changes with it.
   */
  function conflate(bundles, edges) {
    var route = new Uint8Array(edges.count);
    var stats = { routeEdges: 0, indexed: 0, counties: [] };
    var empty = { route: route, stats: stats };
    if (!bundles || !bundles.length || !edges.count) return empty;

    var bbox = bundleBounds(bundles, SNAP_M * 4, true);
    if (!bbox) return empty;
    var index = buildEdgeIndex(edges, bbox);
    stats.indexed = index.indexed;
    if (!index.indexed) return empty;

    var scratch = [];
    var seen = new Int32Array(edges.count);
    var stamp = 0;

    for (var b = 0; b < bundles.length; b++) {
      var bundle = bundles[b];
      if (!bundle) continue;
      var beforeRoutes = stats.routeEdges;
      var routes = bundle.routes || [];
      for (var r = 0; r < routes.length; r++) {
        if (routes[r].status !== 'existing') continue;
        walk(routes[r].coords, function (lon, lat, bearing) {  // eslint-disable-line no-loop-func
          scratch.length = 0;
          stamp++;
          near(index, lon, lat, scratch, seen, stamp);
          for (var k = 0; k < scratch.length; k++) {
            var e = scratch[k];
            if (route[e]) continue;
            if (distToEdge(edges, e, lon, lat, index.mLon) > SNAP_M) continue;
            if (!alignedWith(bearing, bearingOf(edges, e, index.mLon))) continue;
            route[e] = 1;
            stats.routeEdges++;
          }
        });
      }
      stats.counties.push({
        county: bundle.county, state: bundle.state, built: bundle.built,
        routeEdges: stats.routeEdges - beforeRoutes,
      });
    }
    return { route: route, stats: stats };
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

  function lookupIndex(bundles) {
    var cells = new Map();
    var box = bundleBounds(bundles, 0);
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
    SNAP_M: SNAP_M,
    bounds: bounds,
    TAP_M: TAP_M,
    TRAFFIC_LEVELS: TRAFFIC_LEVELS,
    STALE_AFTER_YEARS: STALE_AFTER_YEARS,
    conflate: conflate,
    lookupIndex: lookupIndex,
    lookup: lookup,
    trafficLevel: trafficLevel,
    trafficIsStale: trafficIsStale,
    routesToGeoJSON: routesToGeoJSON,
  };
}(typeof self !== 'undefined' ? self : this));
