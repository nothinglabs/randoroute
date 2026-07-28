/* Shared, fully local vector basemap for the web app and native shell. */
(function installBikeBasemap(global) {
  'use strict';

  const FONT_STACK = 'Klokantech Noto Sans Regular';
  const CONTEXT_URL = 'pmtiles://data/basemap.pmtiles?v=5';
  const ROADS_URL = 'pmtiles://data/roads.pmtiles?v=19';
  let protocol = null;

  // A PMTiles tile is a byte-range read. On a phone one of those can fail for
  // reasons that have nothing to do with the archive -- a dropped cell
  // connection, a range request the CDN answers with a plain 200, an ETag that
  // moved under a redeploy. MapLibre does not retry a tile it was handed an
  // error for: it keeps whatever it had, so the map renders with rectangular
  // holes along tile boundaries (land polygons missing, bare ocean showing
  // through) until the rider happens to pan that area back into view.
  //
  // Retrying here, below MapLibre, is the only place a transient failure can be
  // absorbed without the map ever learning about it. Aborts (the tile left the
  // viewport) are passed straight through -- they are not failures.
  const TILE_RETRY_DELAYS_MS = [120, 320, 800];

  function withTileRetry(tile) {
    return function retryingTile(params, abortController) {
      let attempt = 0;
      const run = () => Promise.resolve(tile(params, abortController)).catch((error) => {
        const aborted = abortController && abortController.signal
          && abortController.signal.aborted;
        if (aborted || attempt >= TILE_RETRY_DELAYS_MS.length) throw error;
        const delay = TILE_RETRY_DELAYS_MS[attempt++];
        return new Promise((resolve, reject) => {
          global.setTimeout(() => run().then(resolve, reject), delay);
        });
      });
      return run();
    };
  }

  // Retrying is not enough on its own. PMTiles memoizes the archive header and
  // every directory read in a promise cache, and it stores that promise before
  // it is settled -- so a read that REJECTS is remembered as the answer for the
  // rest of the session. One dropped range request therefore poisons an entire
  // directory: every tile beneath it fails instantly, without touching the
  // network, and a retry just re-reads the same rejection. That is what turns a
  // momentary connection blip into a permanent rectangular hole in the map.
  //
  // Only successful reads deserve to be cached. This drops any entry whose
  // promise rejected, so the next attempt genuinely goes back to the archive.
  function forgetFailedReads(cache) {
    const entries = cache && cache.cache;
    if (!entries || typeof entries.set !== 'function') return cache;
    const set = entries.set.bind(entries);
    entries.set = (key, entry) => {
      const result = set(key, entry);
      Promise.resolve(entry && entry.data).catch(() => {
        // Only evict this exact entry: a later attempt may already have
        // replaced it with a good one.
        if (entries.get(key) === entry) entries.delete(key);
      });
      return result;
    };
    return cache;
  }

  // The archive path as PMTiles keys it: everything after the protocol.
  function archiveKey(url) {
    return url.slice('pmtiles://'.length);
  }

  function ensureProtocol() {
    if (protocol || !global.pmtiles || !global.maplibregl) return protocol;
    protocol = new global.pmtiles.Protocol();
    // Register the archives up front, sharing one self-healing cache, so the
    // Protocol never has to construct its own (uncorrected) one lazily.
    if (global.pmtiles.SharedPromiseCache && global.pmtiles.PMTiles) {
      const cache = forgetFailedReads(new global.pmtiles.SharedPromiseCache());
      for (const url of [CONTEXT_URL, ROADS_URL]) {
        protocol.add(new global.pmtiles.PMTiles(archiveKey(url), cache));
      }
    }
    global.maplibregl.addProtocol('pmtiles', withTileRetry(protocol.tile));
    return protocol;
  }

  function assetUrl(path) {
    return new URL(path, global.location.href).href;
  }

  function glyphUrl() {
    return `${new URL('.', global.location.href).href}fonts/{fontstack}/{range}.pbf`;
  }

  const roadMatch = (classes) => ['match', ['get', 'h'], classes, true, false];
  const named = ['all', ['has', 'n'], ['!=', ['get', 'n'], '']];
  const majorRoads = [
    'motorway', 'motorway_link', 'trunk', 'trunk_link',
    'primary', 'primary_link',
  ];
  const mediumRoads = [
    'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
  ];
  const localRoads = ['unclassified', 'residential', 'living_street'];
  const ROAD_CLASSES = {
    major: majorRoads,
    medium: mediumRoads,
    local: localRoads,
  };
  const ROAD_MIN_ZOOM = { major: 5, medium: 8, local: 11 };

  function lineLayer(id, minzoom, filter, casing) {
    const local = id.includes('-local');
    return {
      id,
      type: 'line',
      source: 'basemap-roads',
      'source-layer': 'roads',
      minzoom,
      filter,
      // Safety colors replace this road interior with flat-ended segments.
      // Match that cap here (for both casing and fill) so a round white base
      // road cannot protrude as a semicircle beyond the safety color.
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: casing ? {
        // A firmer, wider casing makes the underlying street network readable
        // without competing with the saturated bike-safety overlays above it.
        'line-color': '#b7c1c5',
        'line-width': local
          ? ['interpolate', ['linear'], ['zoom'], 11, 3.4, 14, 6.5, 17, 11.4]
          : ['interpolate', ['linear'], ['zoom'],
              5, 1.4, 8, 2.25, 11, 4, 14, 7.4, 17, 12.5],
        'line-opacity': local
          ? ['interpolate', ['linear'], ['zoom'], 11, 0.78, 14, 0.88, 17, 0.94]
          : 0.96,
      } : {
        'line-color': ['match', ['get', 'h'],
          ['motorway', 'motorway_link'], '#f3dec1',
          ['trunk', 'trunk_link', 'primary', 'primary_link'], '#fff5df',
          '#ffffff'],
        'line-width': local
          ? ['interpolate', ['linear'], ['zoom'], 11, 1.85, 14, 4.05, 17, 8.2]
          : ['interpolate', ['linear'], ['zoom'],
              5, 0.6, 8, 1.1, 11, 2.2, 14, 4.7, 17, 9],
        'line-opacity': local
          ? ['interpolate', ['linear'], ['zoom'], 11, 0.82, 14, 0.91, 17, 0.97]
          : 0.98,
      },
    };
  }

  function roadLabel(id, minzoom, classes, sizeStops) {
    return {
      id,
      type: 'symbol',
      source: 'basemap-roads',
      'source-layer': 'roads',
      minzoom,
      filter: ['all', named, roadMatch(classes)],
      layout: {
        'symbol-placement': 'line',
        // Larger labels are much easier to read from a handlebar-mounted
        // phone. Extra spacing lets MapLibre drop collisions instead of making
        // the map feel more crowded.
        'symbol-spacing': 370,
        'text-field': ['get', 'n'],
        'text-font': [FONT_STACK],
        'text-size': ['interpolate', ['linear'], ['zoom'], ...sizeStops],
        'text-max-angle': 35,
        'text-padding': 4,
        'text-keep-upright': true,
      },
      paint: {
        'text-color': '#69767d',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.7,
        'text-halo-blur': 0.35,
      },
    };
  }

  function createStyle() {
    ensureProtocol();
    return {
      version: 8,
      glyphs: glyphUrl(),
      sources: {
        'basemap-context': {
          type: 'vector',
          url: CONTEXT_URL,
          attribution: '© OpenStreetMap contributors · Natural Earth',
        },
        'basemap-roads': {
          type: 'vector',
          url: ROADS_URL,
          attribution: '© OpenStreetMap contributors',
        },
      },
      layers: [
        { id: 'basemap-ocean', type: 'background', paint: { 'background-color': '#dcecf2' } },
        { id: 'basemap-land', type: 'fill', source: 'basemap-context',
          'source-layer': 'land', maxzoom: 8,
          paint: { 'fill-color': '#f4f3ee' } },
        { id: 'basemap-land-detail', type: 'fill', source: 'basemap-context',
          'source-layer': 'land_detail', minzoom: 8,
          paint: { 'fill-color': '#f4f3ee' } },
        { id: 'basemap-green', type: 'fill', source: 'basemap-context', 'source-layer': 'green',
          paint: {
            'fill-color': ['match', ['get', 'k'],
              'wetland', '#dfeadf',
              ['forest', 'national_park', 'protected'], '#e4eddf',
              'golf', '#e8efdc',
              '#edf1e5'],
            'fill-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.72, 11, 0.88],
          } },
        { id: 'basemap-water', type: 'fill', source: 'basemap-context', 'source-layer': 'water',
          paint: { 'fill-color': '#dcecf2', 'fill-outline-color': '#c5dce6' } },
        { id: 'basemap-waterways', type: 'line', source: 'basemap-context',
          'source-layer': 'waterway', minzoom: 8,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': '#b9d8e4',
            'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 12, 1.2, 16, 2.4],
            'line-opacity': 0.9,
          } },
        lineLayer('basemap-major-casing', ROAD_MIN_ZOOM.major, roadMatch(majorRoads), true),
        lineLayer('basemap-major', ROAD_MIN_ZOOM.major, roadMatch(majorRoads), false),
        lineLayer('basemap-medium-casing', ROAD_MIN_ZOOM.medium, roadMatch(mediumRoads), true),
        lineLayer('basemap-medium', ROAD_MIN_ZOOM.medium, roadMatch(mediumRoads), false),
        lineLayer('basemap-local-casing', ROAD_MIN_ZOOM.local, roadMatch(localRoads), true),
        lineLayer('basemap-local', ROAD_MIN_ZOOM.local, roadMatch(localRoads), false),
        { id: 'basemap-water-labels', type: 'symbol', source: 'basemap-context',
          'source-layer': 'water', minzoom: 9, filter: named,
          layout: {
            'text-field': ['get', 'n'], 'text-font': [FONT_STACK],
            'text-size': ['interpolate', ['linear'], ['zoom'], 9, 12, 14, 15],
            'text-padding': 7,
          },
          paint: {
            'text-color': '#6d94a4', 'text-halo-color': '#e8f3f7',
            'text-halo-width': 1.2,
          } },
        { id: 'basemap-green-labels', type: 'symbol', source: 'basemap-context',
          'source-layer': 'green', minzoom: 11, filter: named,
          layout: {
            'text-field': ['get', 'n'], 'text-font': [FONT_STACK],
            'text-size': 12.5, 'text-padding': 6,
          },
          paint: {
            'text-color': '#668063', 'text-halo-color': '#f2f5ed',
            'text-halo-width': 1.2,
          } },
        roadLabel('basemap-major-labels', 7, majorRoads, [7, 12, 13, 15.5]),
        roadLabel('basemap-medium-labels', 10, mediumRoads, [10, 11.5, 15, 14.5]),
        roadLabel('basemap-local-labels', 12.2, localRoads, [12, 11, 17, 14.5]),
        { id: 'basemap-place-labels', type: 'symbol', source: 'basemap-context',
          'source-layer': 'places',
          layout: {
            'text-field': ['get', 'n'],
            'text-font': [FONT_STACK],
            'text-size': ['interpolate', ['linear'], ['zoom'],
              5, ['case', ['>=', ['get', 'p'], 100000], 16.5, 13],
              9, ['case', ['>=', ['get', 'p'], 25000], 17.5, 13],
              13, ['case', ['match', ['get', 'k'], ['city', 'town'], true, false], 16.5, 13]],
            'text-padding': 10,
            'text-allow-overlap': false,
            'symbol-sort-key': ['-', 0, ['coalesce', ['get', 'p'], 0]],
          },
          paint: {
            'text-color': '#4f5d64',
            'text-halo-color': '#f8f8f4',
            'text-halo-width': 1.7,
            'text-halo-blur': 0.4,
          } },
      ],
    };
  }

  global.BikeBasemap = {
    FONT_STACK,
    ROAD_CLASSES,
    ROAD_MIN_ZOOM,
    ensureProtocol,
    createStyle,
  };
})(window);
