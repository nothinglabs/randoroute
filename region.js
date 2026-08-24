/* WHICH STATE this session is running on, and everything that differs by state.
 *
 * Everything a state contributes is configuration, not logic, and it lives in
 * `maps/<state>/region.json` beside that state's data. The safety model, the
 * router, the cost weights and the map styling are all state-agnostic already
 * -- `safety-model.js` deliberately knows about a traffic-stress *rating* and
 * never about the agency that published it. What was left scattered through
 * app.js was the handful of facts that genuinely are Washington's: where the
 * data covers, where the map opens, what to call the agency on a card, and how
 * that agency spells its own route ids and facility types.
 *
 * This file holds none of those values. It picks a state out of the generated
 * `maps/states.js` index and shapes it into the `Region` object the rest of the
 * app reads. Adding a state is adding a folder; no file outside maps/ names one.
 *
 * Porting to another state should be writing a region.json and following
 * `docs/PORTING-TO-ANOTHER-STATE.md`, not grepping for "WSDOT".
 *
 * Loaded as a classic script by index.html after maps/states.js, and copied
 * into the native shell, so it must not use module syntax. In Node the IIFE's
 * `this` is module.exports, so tests can require() it.
 */
(function (root) {
  // In a browser and in the service worker, maps/states.js has already run and
  // published the index onto the same global. In Node a require() lands on a
  // fresh module.exports, so fetch it the CommonJS way.
  let states = root.MAP_STATES;
  if (!states && typeof require === 'function') {
    try { states = require('./maps/states.js').MAP_STATES; } catch (e) { /* browser */ }
  }
  if (!states || !states.length) throw new Error('region.js: maps/states.js has not been loaded');

  // States installed from a map store (map-store.js records them; it loads
  // before this file in the page). A bundled state wins an id collision --
  // the origin is authoritative for what it ships. The service worker and
  // Node land here without MapStore and simply see the bundled index; the
  // worker serves installed states by URL pattern without needing to know
  // their names.
  if (root.MapStore) {
    const bundledIds = new Set(root.MAP_STATES_BUNDLED === false ? []
      : Array.isArray(root.MAP_STATES_BUNDLED_IDS)
        ? root.MAP_STATES_BUNDLED_IDS : states.map((state) => state.id));
    const installed = root.MapStore.installedRegionConfigs()
      .filter((state) => !bundledIds.has(state.id));
    if (installed.length) {
      const installedIds = new Set(installed.map((state) => state.id));
      states = [...states.filter((state) => !installedIds.has(state.id)), ...installed];
    }
  }

  // Which state this session opens with. A rider switches on the Maps screen;
  // that writes STORED_STATE_KEY and reloads, and this reads it back. Switching
  // state means loading another folder -- there is no other difference.
  //
  // The default is the released state with the HIGHEST readiness, folder
  // order breaking ties -- never simply the first folder: releasing a second
  // state must not silently change what a new rider opens the app to just
  // because it sorts earlier ("oregon" ahead of "washington" did exactly
  // that). Readiness is the rubric-scored trust level, so the default is the
  // most trustworthy map, and the legacy meaning of defaultStateId -- which
  // state pre-multistate persisted data was about -- keeps pointing at the
  // original state for the same reason.
  const STORED_STATE_KEY = 'jra-map-state-1';
  const released = states.filter((state) => state.status === 'released');
  const fallback = released.length
    ? released.reduce((best, state) =>
      ((state.readiness || 0) > (best.readiness || 0) ? state : best))
    : states[0];
  let stored = null;
  try {
    stored = root.localStorage ? root.localStorage.getItem(STORED_STATE_KEY) : null;
  } catch (e) { /* private mode, or a worker with no storage */ }
  // A stored id that no longer has a folder -- an app update that dropped a
  // state, or a hand-edited value -- falls back rather than leaving the app
  // pointed at a directory that will 404 on every tile.
  const active = states.find((state) => state.id === stored) || fallback;
  const localDataAvailable = !root.MapStore
    || root.MapStore.availability(active.id) !== 'remote';
  const activeDatasets = localDataAvailable ? active.datasets
    : Object.fromEntries(Object.keys(active.datasets || {}).map((key) => [key, false]));

  const suffixes = active.routeDirectionSuffixes || {};
  const suffixLetters = Object.keys(suffixes);
  const suffixPattern = suffixLetters.length
    ? new RegExp(`[${suffixLetters.join('')}]$`, 'i') : null;

  root.Region = {
    /* ---------------------------------------------------------- identity */
    // Shown in loading copy and appended to a geocoded address that omits it.
    name: active.name,
    id: active.id,
    // The folder holding every file this state ships: tiles, graph, overlays,
    // places, and the notes describing how they were built. Nothing outside
    // maps/<state>/ is state-specific data, and no app code names a state.
    dataRoot: `maps/${active.id}`,

    /* ---------------------------------------------------------- coverage */
    // The routing graph stops at the state line, so a place search hit outside
    // this box can never be routed to and is dropped rather than offered.
    // Generous by a little: clipping a genuine border town is worse than
    // offering one unroutable result.
    bounds: active.bounds,

    // Where the map opens for a rider with no saved view.
    defaultCenter: active.defaultCenter,
    defaultZoom: active.defaultZoom,

    // The full routing graph's decompressed size (the catalogue's
    // sourceRawBytes for this state). The app compares it to the device
    // routing budget: a state whose graph exceeds what one allocation may
    // hold routes its own trips through the partition session instead of the
    // monolithic home worker. Absent for a state imported before this fact
    // was recorded; the monolith path then remains the default.
    graphRawBytes: active.graphRawBytes || null,

    /* ------------------------------------------------------- attribution */
    // The state authority behind each enrichment, as it appears on a road card
    // and in the settings copy. OSM is the universal base everywhere; these
    // name whoever adds to it here. All three are the same agency in
    // Washington, and need not be elsewhere.
    stressAgency: active.stressAgency,           // publishes the 1-4 stress rating
    restrictionAgency: active.restrictionAgency, // publishes bicycle prohibitions
    speedAgency: active.speedAgency,             // publishes legal speed limits

    // The agency's own product names, as cited on a road card and in the
    // layer list.
    facilitySourceName: active.facilitySourceName,
    stressLayerName: active.stressLayerName,
    restrictionLayerName: active.restrictionLayerName,

    /* -------------------------------------------- the agency's own spelling */
    // WSDOT numbers Interstates with these route prefixes and records no
    // separate "is an interstate" field, so the fact is recovered from the
    // route id -- 11,098 of 55,271 segments. A state that publishes the fact
    // directly leaves this empty.
    interstateRoutePrefixes: active.interstateRoutePrefixes || [],

    // How this state's agency spells a route ref ("SR 520", "OR 224"). The
    // graph and tile builds gate agency conflation on these (--region), and
    // route-common.js builds its name-based highway test from them.
    stateRoutePrefixes: active.stateRoutePrefixes || null,

    // The agency's facility vocabulary, mapped onto the shared 0-5 level the
    // rest of the app speaks. Without it a card could only say "there is
    // something here", and a shared-use path scored the same as a painted lane.
    facilityLevels: active.facilityLevels || {},
    // Feature counts for the overlay layers, shown in the layer list. A vector
    // tile carries no global count, so these are baked at build time -- and
    // they were baked into SOURCES in app.js, which meant Oregon's layer list
    // reported Washington's numbers. A state fact belongs in the state.
    sourceCounts: active.sourceCounts || {},

    /* ------------------------------------------------- what this state ships */
    // Which files the folder actually holds. A preview state may carry only a
    // place index, and the app has to say so rather than spin on a graph
    // download that will 404.
    datasets: activeDatasets,
    // A slim shell can name a state before its acquisition is on the device.
    // That session is the resident national orientation map, not a broken
    // attempt to load absent state archives.
    localDataAvailable,
    // Who to credit: the OSM extract this state was cut from, and the agency
    // services behind its enrichment. The credits screen renders this rather
    // than a list written into the HTML, which would name one state's agency
    // on every state's screen.
    attribution: active.attribution || { agencySources: [] },
    // Content hashes of the shipped artefacts, stamped by the build scripts.
    // The service worker refreshes an offline copy whose stamp moved.
    versions: active.versions || {},
    status: active.status,
    readiness: active.readiness,

    // Every state with a folder, for the Maps screen. Read-only description --
    // switching is app.js's job, because it has to warn about losing a route.
    states,
  };

  // Where a named data file lives for the loaded state. Every fetch in the app,
  // the worker and the service worker goes through this rather than a literal
  // path, so pointing the app at another state is a folder change.
  root.Region.dataUrl = (file) => `${root.Region.dataRoot}/${file}`;
  root.Region.storageKey = STORED_STATE_KEY;
  // Where a rider who has never chosen lands -- and, for anything the app
  // persisted before there was more than one state, which state that data was
  // about.
  root.Region.defaultStateId = fallback.id;

  root.Region.contains = (lon, lat) => {
    const b = root.Region.bounds;
    return lon >= b.minLon && lon <= b.maxLon && lat >= b.minLat && lat <= b.maxLat;
  };

  // WSDOT route ids carry the direction as a trailing letter -- `005i` and
  // `005d` are the increasing- and decreasing-milepost sides of route 005 --
  // and the road card uses it to say which shoulder a figure describes.
  //
  // A state whose ids do not work this way declares no suffixes: the id comes
  // back unchanged and the direction null, so the card omits the direction and
  // stops looking for an opposite-side sibling. That is exactly what already
  // happens in Washington for a route with no suffix.
  root.Region.routeBase = (routeIdentifier) => {
    const id = String(routeIdentifier || '');
    return suffixPattern ? id.replace(suffixPattern, '') : id;
  };
  root.Region.routeDirection = (routeIdentifier) => {
    const id = String(routeIdentifier || '');
    if (!suffixPattern || !suffixPattern.test(id)) return null;
    return suffixes[id.slice(-1).toLowerCase()] || null;
  };
}(typeof self !== 'undefined' ? self : this));
