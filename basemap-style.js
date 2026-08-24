/* Shared, fully local vector basemap for the web app and native shell. */
(function installBikeBasemap(global) {
  'use strict';

  const FONT_STACK = 'Klokantech Noto Sans Regular';
  // The context archive's z6-z8 OSM polygons can decode into tens of
  // thousands of features in one tile. MapLibre drops those oversized tiles
  // as rectangular holes on constrained renderers. A compact regional archive
  // carries coastline-correct ground there, while resident state polygons
  // retain boundaries and labels. Detailed context takes over once the same
  // data is split across smaller tiles.
  const CONTEXT_MIN_ZOOM = 9;
  const CONTEXT_URL = `pmtiles://${Region.dataUrl('basemap.pmtiles')}?v=5`;
  // The low-zoom regional archive is a map-pack dataset, so its cache identity
  // follows the content stamp in region.json rather than an application-code
  // constant. A rebuilt archive can then replace itself without requiring a
  // change here, and installed states use the same rule as the bundled state.
  const archiveDatasetVersion = (state, dataset, fallback = 1) =>
    encodeURIComponent(String(state?.versions?.[dataset] || fallback));
  const REGIONAL_URL = `pmtiles://${Region.dataUrl('regional.pmtiles')}`
    + `?v=${archiveDatasetVersion(Region, 'regional')}`;
  // Must be the SAME ?v as app.js's roads source: two spellings of one
  // archive are two browser-cache entries and two PMTiles instances, so a
  // first visit fetched the 80 MB file twice. The service worker normalizes
  // /data/ URLs, which is why installed PWAs never showed the double fetch.
  const ROADS_URL = `pmtiles://${Region.dataUrl('roads.pmtiles')}?v=24`;
  let protocol = null;
  let protocolCache = null;
  const registeredArchives = new Set();

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
      protocolCache = forgetFailedReads(new global.pmtiles.SharedPromiseCache());
      const archives = [
        Region.datasets.basemap ? CONTEXT_URL : null,
        Region.datasets.roads ? ROADS_URL : null,
      ].filter(Boolean);
      for (const url of archives) {
        protocol.add(new global.pmtiles.PMTiles(archiveKey(url), protocolCache));
        registeredArchives.add(archiveKey(url));
      }
    }
    global.maplibregl.addProtocol('pmtiles', withTileRetry(protocol.tile));
    return protocol;
  }

  function stateArchiveUrl(state, file, version) {
    return `pmtiles://maps/${state.id}/${file}?v=${version}`;
  }

  function registerArchive(url) {
    ensureProtocol();
    const key = archiveKey(url);
    if (!protocol || registeredArchives.has(key) || !global.pmtiles?.PMTiles) return;
    protocol.add(new global.pmtiles.PMTiles(key, protocolCache || undefined));
    registeredArchives.add(key);
  }

  const visibleSourceId = (stateId, dataset) =>
    `state-${stateId}-basemap-${dataset}`;
  const visibleLayerPrefix = (stateId) => `state-${stateId}-`;

  function viewportBounds(map) {
    const bounds = map.getBounds?.();
    if (!bounds) return null;
    const value = (method, corner, axis) => typeof bounds[method] === 'function'
      ? Number(bounds[method]()) : Number(bounds[corner]?.[axis]);
    const result = {
      minLon: value('getWest', '_sw', 'lng'),
      minLat: value('getSouth', '_sw', 'lat'),
      maxLon: value('getEast', '_ne', 'lng'),
      maxLat: value('getNorth', '_ne', 'lat'),
    };
    return Object.values(result).every(Number.isFinite) ? result : null;
  }

  function intersects(left, right) {
    return left.minLon <= right.maxLon && left.maxLon >= right.minLon
      && left.minLat <= right.maxLat && left.maxLat >= right.minLat;
  }

  function expandBounds(bounds, lonMargin, latMargin) {
    return {
      minLon: bounds.minLon - lonMargin, maxLon: bounds.maxLon + lonMargin,
      minLat: bounds.minLat - latMargin, maxLat: bounds.maxLat + latMargin,
    };
  }

  // A visible-state archive that cannot actually load — offline with chunks
  // never cached, or a deleted file — must detach rather than sit in the
  // style as a permanently un-loaded source: one wedged source keeps
  // map.loaded() false for the app's lifetime, which reads as the app never
  // starting. The next viewport change re-attaches and retries.
  //
  // Detach ONLY a source that has never finished loading. A transient tile
  // error on a spotty connection also arrives as a map error naming the
  // source, and detaching then made every layer of an installed neighbor
  // vanish mid-ride for one dropped request. Once a source has loaded, its
  // failures are the renderer's ordinary retry problem, not attachment's.
  function ensureVisibleStateErrorHook(map) {
    if (map.__visibleStateSourceErrorHook || typeof map.on !== 'function') return;
    map.__visibleStateSourceErrorHook = true;
    const everLoaded = new Set();
    map.__visibleStateEverLoaded = everLoaded;
    map.on('sourcedata', (event) => {
      const sourceId = String(event?.sourceId || '');
      if (sourceId && event?.isSourceLoaded) everLoaded.add(sourceId);
    });
    // A tile error on a source that HAS loaded is not attachment's problem —
    // but MapLibre never re-asks for a tile it was handed an error for, so a
    // burst of failed ranges (a torn cache, a dropped connection outlasting
    // the short low-level retry) leaves permanent holes: lakes without water,
    // roads without safety color, until the rider happens to pan them back
    // in. Reload the wounded source once things settle — debounced past the
    // burst, at most once per source per 45 s, straight from the local cache
    // when one is serving.
    const sourceHealAt = new Map();
    const sourceHealTimer = new Map();
    const scheduleSourceSelfHeal = (sourceId) => {
      if (sourceHealTimer.has(sourceId)) return;
      sourceHealTimer.set(sourceId, global.setTimeout(() => {
        sourceHealTimer.delete(sourceId);
        if (Date.now() - (sourceHealAt.get(sourceId) || 0) < 45000) return;
        const source = map.getSource?.(sourceId);
        if (!source || typeof source.setUrl !== 'function' || !source.url) return;
        sourceHealAt.set(sourceId, Date.now());
        try { source.setUrl(source.url); } catch (error) { /* the next error retries */ }
      }, 5000));
    };
    map.on('error', (event) => {
      const sourceId = String(event?.sourceId || event?.source?.id || '');
      const match = /^state-([a-z0-9-]+)-basemap-(regional|context|roads|overlays)$/.exec(sourceId);
      if (match && !everLoaded.has(sourceId)) {
        // One archive can fail while its siblings are already drawing. The
        // old state-wide removal turned an overlays header failure into lost
        // land, roads, waterways, and safety paint, then retried all three
        // archives together. Detach only the source MapLibre says is wedged;
        // the next sync reattaches that dataset without disturbing good tiles.
        try { removeVisibleStateSource(map, sourceId); } catch (error) { /* already gone */ }
        // A rider sitting still after a transient attach failure otherwise
        // waits for their next pan to get the state back. Retry through the
        // app's registered sync entry once things have settled.
        if (typeof map.__visibleStateResync === 'function' && !map.__visibleStateResyncTimer) {
          map.__visibleStateResyncTimer = global.setTimeout(() => {
            map.__visibleStateResyncTimer = null;
            try { map.__visibleStateResync(); } catch (error) { /* next moveend */ }
          }, 4000);
        }
        return;
      }
      if (sourceId && everLoaded.has(sourceId)) scheduleSourceSelfHeal(sourceId);
    });
  }

  function removeVisibleStateSource(map, sourceId) {
    for (const layer of [...(map.getStyle?.()?.layers || [])].reverse()) {
      if (layer.source === sourceId && map.getLayer?.(layer.id)) map.removeLayer(layer.id);
    }
    map.__visibleStateEverLoaded?.delete(sourceId);
    if (map.getSource?.(sourceId)) map.removeSource(sourceId);
  }

  function removeVisibleState(map, stateId) {
    const prefix = visibleLayerPrefix(stateId);
    // A detached source starts over: its next attachment must earn loaded
    // status again, so an attachment that wedges can still self-heal.
    for (const id of [...(map.__visibleStateEverLoaded || [])]) {
      if (id.startsWith(prefix)) map.__visibleStateEverLoaded.delete(id);
    }
    const layers = map.getStyle?.()?.layers || [];
    for (const layer of [...layers].reverse()) {
      if (layer.id.startsWith(prefix) && map.getLayer?.(layer.id)) map.removeLayer(layer.id);
    }
    for (const dataset of ['regional', 'roads', 'context', 'overlays']) {
      const id = visibleSourceId(stateId, dataset);
      if (map.getSource?.(id)) removeVisibleStateSource(map, id);
    }
  }

  // Only the home state is part of the initial style. Other installed state
  // archives enter when their bounds intersect the current detailed viewport,
  // and leave again when they cannot contribute. This keeps installed-state
  // count independent from renderer memory and prevents a cross-state route
  // from becoming bare ocean on its non-home side.
  function syncVisibleStateSources(map, states, homeStateId, { minZoom = 5 } = {}) {
    if (!map?.getStyle?.()) return [];
    ensureVisibleStateErrorHook(map);
    const bounds = viewportBounds(map);
    const zoom = Number(map.getZoom?.());
    const detailed = bounds && zoom >= minZoom;
    // Only a constrained style backed by the compact regional dataset carries
    // this source. Its installed neighbors can safely enter below the detailed
    // archive handoff without making desktop load an otherwise unused source.
    const regionalRenderer = !!map.getSource?.('basemap-regional');
    const regional = bounds && regionalRenderer && zoom >= 4;
    // Attach ahead of arrival and detach only well past departure. The first
    // version attached and detached on the exact viewport/bounds intersection,
    // so riding or panning along a state line cycled the neighbor's sources on
    // every moveend — and each re-attachment starts over with header,
    // directory and tile reads, which the field reads as that state's layers
    // "randomly missing". The margins are viewport-relative (capped so a wide
    // view cannot attach the whole country): a state enters a bit before its
    // edge scrolls in, and leaves only when the rider is a full viewport away.
    const spanLon = bounds ? Math.max(0, bounds.maxLon - bounds.minLon) : 0;
    const spanLat = bounds ? Math.max(0, bounds.maxLat - bounds.minLat) : 0;
    const attachLon = Math.min(0.35 * spanLon, 1.2);
    const attachLat = Math.min(0.35 * spanLat, 0.9);
    const attachBounds = bounds ? expandBounds(bounds, attachLon, attachLat) : null;
    const keepBounds = bounds ? expandBounds(bounds, 3 * attachLon, 3 * attachLat) : null;
    const candidates = (states || []).filter((state) => state?.id
      && state.id !== homeStateId && state.bounds
      && (state.datasets?.regional || state.datasets?.basemap || state.datasets?.roads));
    const wanted = new Map(candidates
      .filter((state) => ((regional && state.datasets?.regional)
          || (detailed && (state.datasets?.basemap || state.datasets?.roads)))
        && intersects(attachBounds, state.bounds))
      .map((state) => [state.id, state]));
    const keep = new Set(candidates
      .filter((state) => keepBounds && intersects(keepBounds, state.bounds))
      .map((state) => state.id));
    const existing = new Set();
    for (const layer of map.getStyle().layers || []) {
      const match = /^state-([a-z0-9-]+)-basemap-(?:regional-land-detail|land)$/.exec(layer.id);
      if (match) existing.add(match[1]);
    }
    for (const stateId of existing) {
      if (!wanted.has(stateId) && !keep.has(stateId)) removeVisibleState(map, stateId);
    }

    for (const state of [...wanted.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      const regionalId = visibleSourceId(state.id, 'regional');
      const contextId = visibleSourceId(state.id, 'context');
      const roadsId = visibleSourceId(state.id, 'roads');
      const overlaysId = visibleSourceId(state.id, 'overlays');
      const regionalUrl = stateArchiveUrl(state, 'regional.pmtiles',
        archiveDatasetVersion(state, 'regional'));
      const contextUrl = stateArchiveUrl(state, 'basemap.pmtiles', 5);
      const roadsUrl = stateArchiveUrl(state, 'roads.pmtiles', 24);
      const overlaysUrl = stateArchiveUrl(state, 'overlays.pmtiles', 2);
      if (regionalRenderer && state.datasets.regional && !map.getSource(regionalId)) {
        registerArchive(regionalUrl);
        map.addSource(regionalId, { type: 'vector', url: regionalUrl,
          attribution: '© OpenStreetMap contributors' });
      }
      if (detailed && state.datasets.basemap && !map.getSource(contextId)) {
        registerArchive(contextUrl);
        map.addSource(contextId, { type: 'vector', url: contextUrl,
          attribution: '© OpenStreetMap contributors · Natural Earth' });
      }
      if (detailed && state.datasets.roads && !map.getSource(roadsId)) {
        registerArchive(roadsUrl);
        map.addSource(roadsId, { type: 'vector', url: roadsUrl,
          attribution: '© OpenStreetMap contributors' });
      }
      if (detailed && state.datasets.overlays && !map.getSource(overlaysId)) {
        registerArchive(overlaysUrl);
        map.addSource(overlaysId, { type: 'vector', url: overlaysUrl,
          attribution: '© OpenStreetMap contributors' });
      }
      const style = map.getStyle();
      const templates = (style.layers || []).filter((layer) =>
        layer.id.startsWith('basemap-')
          && ['basemap-regional', 'basemap-context', 'basemap-roads'].includes(layer.source));
      for (const template of templates) {
        const source = template.source === 'basemap-regional' ? regionalId
          : template.source === 'basemap-context' ? contextId : roadsId;
        const id = `${visibleLayerPrefix(state.id)}${template.id}`;
        if (!map.getSource(source) || map.getLayer?.(id)) continue;
        const layer = JSON.parse(JSON.stringify({ ...template, id, source }));
        // Preserve the basemap's semantic stack one layer at a time. Adding
        // every neighboring-state layer as a block before the first label put
        // its land and neutral roads above the home state's waterways and
        // safety paint. In an overlap band, land could therefore cover a
        // river; everywhere in the neighboring state, its own neutral map
        // covered the cloned safety colors. Pairing each clone with its home
        // template keeps land below water, neutral roads below safety, and
        // labels above both regardless of state attachment order.
        map.addLayer(layer, map.getLayer?.(template.id) ? template.id : undefined);
      }
    }
    // Everything still attached after this sync — the freshly wanted states
    // plus those retained in the hysteresis band. The caller mirrors safety
    // layers from this list, so a retained state must not drop out of it.
    const attached = new Set(wanted.keys());
    for (const stateId of existing) {
      if (keep.has(stateId)) attached.add(stateId);
    }
    // The Census ground fill includes marine water, so every state whose
    // coastline-true regional archive is attached must be carved out of it —
    // the home state from style construction, neighbors as their regional
    // sources come and go. A state without a regional pack keeps its Census
    // backdrop until its map update ships one.
    if (map.getLayer?.('basemap-state-ground') && typeof map.setFilter === 'function') {
      const excluded = [];
      if (regionalRenderer) excluded.push(homeStateId);
      for (const state of candidates) {
        if (map.getSource(visibleSourceId(state.id, 'regional'))) excluded.push(state.id);
      }
      map.setFilter('basemap-state-ground', excluded.length
        ? ['!', ['in', ['get', 'id'], ['literal', excluded.sort()]]] : null);
    }
    return [...attached].sort((a, b) => a.localeCompare(b));
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
  const mediumRoads = ['secondary', 'secondary_link'];
  const minorRoads = ['tertiary', 'tertiary_link'];
  const localRoads = ['unclassified', 'residential', 'living_street'];
  const ROAD_CLASSES = {
    major: majorRoads,
    medium: mediumRoads,
    minor: minorRoads,
    local: localRoads,
  };
  // Local streets are by far the densest class. Revealing the entire grid at
  // z11 made a city-wide phone view turn into colored confetti and handed the
  // renderer thousands of extra line segments at once. Keep the regional road
  // hierarchy at metro scale, add tertiary streets at city scale, then bring
  // residential, unclassified and living streets in only once the rider is
  // looking at a neighborhood. Bike facilities and trails have their own
  // earlier reveal in app.js, so cycling structure does not disappear with the
  // background grid.
  const ROAD_MIN_ZOOM = { major: 5, medium: 8, minor: 10.25, local: 12.25 };

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

  function createStyle({ constrainedRenderer = false } = {}) {
    // The oversized-tile hole problem is a constrained-renderer failure:
    // measured against the released Washington archive, z4-z7 context tiles
    // peak at ~1.2 MB compressed and WebKit drops them under pressure, while
    // desktop renderers draw them fine. Only constrained maps trade the low
    // zoom band for the compact regional archive; everything else keeps the
    // detailed archive's full range.
    const contextMinZoom = constrainedRenderer ? CONTEXT_MIN_ZOOM : 4;
    if (!Region.localDataAvailable) return createNationalStyle();
    ensureProtocol();
    const regionalGround = constrainedRenderer && !!Region.datasets.regional;
    if (regionalGround) registerArchive(REGIONAL_URL);
    const style = {
      version: 8,
      glyphs: glyphUrl(),
      sources: {
        'basemap-state-ground': {
          type: 'geojson', data: assetUrl('maps/national-states.geojson'),
          attribution: 'U.S. Census Bureau 2025 Cartographic Boundary Files',
        },
        // Populated by the app from the installed states' place indexes: a
        // few hundred point features that do not depend on any tile archive,
        // so a constrained renderer that drops big context tiles still shows
        // which town is which. Empty until places load.
        ...(constrainedRenderer ? {
          'basemap-regional-places': {
            type: 'geojson', data: { type: 'FeatureCollection', features: [] },
          },
        } : {}),
        ...(regionalGround ? {
          'basemap-regional': {
            type: 'vector',
            url: REGIONAL_URL,
            attribution: '© OpenStreetMap contributors',
          },
        } : {}),
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
        // Administrative state polygons include inland and coastal water —
        // the Census outline of Washington FILLS Puget Sound, joins Whidbey
        // to the mainland and paves Green Lake. They are therefore a backdrop
        // ONLY for a state with no regional archive (an older installed
        // neighboring pack). A state whose coastline-true regional archive is
        // attached is EXCLUDED from this fill (syncVisibleStateSources keeps
        // the filter current as neighbor sources come and go):
        // inside its territory, land is regional land_detail and the sea is
        // the ocean background, which is the only way a marine strait can
        // stay water — the regional water layer carries lakes, not the sea.
        { id: 'basemap-state-ground', type: 'fill', source: 'basemap-state-ground',
          maxzoom: CONTEXT_MIN_ZOOM + 0.5,
          ...(regionalGround ? { filter: ['!=', ['get', 'id'], Region.id] } : {}),
          paint: { 'fill-color': '#f4f3ee', 'fill-opacity': 1 } },
        ...(regionalGround ? [
          // No maxzoom on either: overzoomed z8 regional tiles are the
          // permanent coastline-correct backdrop UNDER the detailed layers,
          // so the z9 handoff and any dropped detail tile degrade to a
          // slightly blocky true shoreline instead of to sea-as-land (the
          // capped version left z9-9.5 to the Census fill, which is exactly
          // the band where Whidbey drowned on every phone zoom-out).
          // Generalized land first: land_detail is the coastline band only,
          // and inland ground far from the coast lives solely in this layer
          // (an archive from before it shipped simply renders nothing here).
          { id: 'basemap-regional-land', type: 'fill', source: 'basemap-regional',
            'source-layer': 'land', minzoom: 4,
            paint: { 'fill-color': '#f4f3ee' } },
          { id: 'basemap-regional-land-detail', type: 'fill', source: 'basemap-regional',
            'source-layer': 'land_detail', minzoom: 4,
            paint: { 'fill-color': '#f4f3ee' } },
          { id: 'basemap-regional-water', type: 'fill', source: 'basemap-regional',
            'source-layer': 'water', minzoom: 4,
            paint: { 'fill-color': '#dcecf2', 'fill-outline-color': '#c5dce6' } },
        ] : []),
        { id: 'basemap-state-outline', type: 'line', source: 'basemap-state-ground',
          maxzoom: CONTEXT_MIN_ZOOM + 0.5,
          paint: { 'line-color': '#cbd2d4', 'line-width': 0.8 } },
        // The background is ocean, so ANY area without a land polygon renders as
        // open water. That makes a missing tile look like the rider is at sea,
        // which is the single most alarming way this map can fail -- and on a
        // phone it happens routinely, because a byte-range read over cell data
        // can fail or simply not have arrived yet while the map is being panned.
        //
        // `land` used to stop at maxzoom 8, leaving `land_detail` as the only
        // thing between the rider and the ocean above that zoom. Uncapping it
        // lets MapLibre overzoom the coarse tile, so there is always a land
        // backdrop: a detail tile that has not arrived now degrades to slightly
        // blocky coastline instead of to open sea. The coarse tiles are few,
        // small, and load early, which is exactly what a fallback needs.
        //
        // Order matters and is load-bearing: `basemap-water` is drawn AFTER both
        // land layers, so real lakes, rivers and the Sound still paint on top of
        // the coarse backdrop and shorelines stay correct wherever the water
        // tile is present.
        { id: 'basemap-land', type: 'fill', source: 'basemap-context',
          'source-layer': 'land', minzoom: contextMinZoom,
          paint: { 'fill-color': '#f4f3ee' } },
        { id: 'basemap-land-detail', type: 'fill', source: 'basemap-context',
          'source-layer': 'land_detail', minzoom: contextMinZoom,
          paint: { 'fill-color': '#f4f3ee' } },
        { id: 'basemap-green', type: 'fill', source: 'basemap-context', 'source-layer': 'green',
          minzoom: contextMinZoom,
          paint: {
            'fill-color': ['match', ['get', 'k'],
              'wetland', '#dfeadf',
              ['forest', 'national_park', 'protected'], '#e4eddf',
              'golf', '#e8efdc',
              '#edf1e5'],
            'fill-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.72, 11, 0.88],
          } },
        { id: 'basemap-water', type: 'fill', source: 'basemap-context', 'source-layer': 'water',
          minzoom: contextMinZoom,
          paint: { 'fill-color': '#dcecf2', 'fill-outline-color': '#c5dce6' } },
        { id: 'basemap-waterways', type: 'line', source: 'basemap-context',
          'source-layer': 'waterway', minzoom: contextMinZoom,
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
        lineLayer('basemap-minor-casing', ROAD_MIN_ZOOM.minor, roadMatch(minorRoads), true),
        lineLayer('basemap-minor', ROAD_MIN_ZOOM.minor, roadMatch(minorRoads), false),
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
        roadLabel('basemap-minor-labels', ROAD_MIN_ZOOM.minor + 0.7,
          minorRoads, [10, 11.5, 15, 14.5]),
        roadLabel('basemap-local-labels', ROAD_MIN_ZOOM.local + 0.35,
          localRoads, [12, 11, 17, 14.5]),
        // Before the context place labels so those win the collision where
        // both render; on a constrained renderer whose big context tiles
        // dropped, these still name the towns.
        ...(constrainedRenderer ? [{
          id: 'basemap-regional-places', type: 'symbol', source: 'basemap-regional-places',
          minzoom: 5, maxzoom: 13,
          layout: {
            'text-field': ['get', 'name'], 'text-font': [FONT_STACK],
            'text-size': ['interpolate', ['linear'], ['zoom'],
              5, ['case', ['>=', ['get', 'population'], 100000], 16.5, 12.5],
              9, ['case', ['>=', ['get', 'population'], 25000], 17.5, 13]],
            'text-padding': 10,
            'text-allow-overlap': false,
            'symbol-sort-key': ['-', 0, ['coalesce', ['get', 'population'], 0]],
          },
          paint: {
            'text-color': '#4f5d64',
            'text-halo-color': '#f8f8f4',
            'text-halo-width': 1.7,
            'text-halo-blur': 0.4,
          },
        }] : []),
        { id: 'basemap-place-labels', type: 'symbol', source: 'basemap-context',
          'source-layer': 'places', minzoom: contextMinZoom,
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
        { id: 'basemap-state-labels', type: 'symbol', source: 'basemap-state-ground',
          maxzoom: CONTEXT_MIN_ZOOM,
          layout: {
            'text-field': ['get', 'abbreviation'], 'text-font': [FONT_STACK],
            'text-size': ['interpolate', ['linear'], ['zoom'], 5, 10, 8, 13],
            'text-allow-overlap': false, 'text-padding': 4,
          },
          paint: {
            'text-color': '#718087', 'text-halo-color': '#f4f3ee',
            'text-halo-width': 1,
          } },
      ],
    };
    return withoutMissingSources(style);
  }

  function createNationalStyle() {
    return {
      version: 8,
      glyphs: glyphUrl(),
      sources: {
        'national-states': {
          type: 'geojson', data: 'maps/national-states.geojson',
          promoteId: 'id',
          attribution: 'U.S. Census Bureau 2025 Cartographic Boundary Files',
        },
      },
      layers: [
        { id: 'national-ocean', type: 'background',
          paint: { 'background-color': '#dcecf2' } },
        { id: 'national-state-fill', type: 'fill', source: 'national-states',
          paint: {
            'fill-color': ['match', ['feature-state', 'availability'],
              'installed', '#8cc6a9', 'available', '#90bfe5', '#d4d9dc'],
            'fill-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0.98, 0.88],
          } },
        { id: 'national-state-outline', type: 'line', source: 'national-states',
          paint: {
            'line-color': ['case', ['boolean', ['feature-state', 'selected'], false],
              '#005f52', '#ffffff'],
            'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 2.5, 0.9],
          } },
        { id: 'national-state-labels', type: 'symbol', source: 'national-states',
          layout: {
            'text-field': ['get', 'abbreviation'], 'text-font': [FONT_STACK],
            'text-size': ['interpolate', ['linear'], ['zoom'], 2, 9, 5, 13],
            'text-allow-overlap': false, 'text-padding': 2,
          },
          paint: {
            'text-color': '#405561', 'text-halo-color': '#f7f8f6',
            'text-halo-width': 1,
          } },
      ],
    };
  }

  // A state under construction may have a place index and no tiles yet. A
  // style whose source URL 404s does not degrade gracefully in MapLibre: the
  // style never finishes loading, so `load` never fires and the whole app sits
  // on its launch screen. Ship only the sources the state declares, and drop
  // the layers that would be left pointing at nothing -- the background
  // remains, which is a map of ocean and a scale bar, honestly empty rather
  // than hung.
  function withoutMissingSources(style) {
    const shipped = { 'basemap-context': 'basemap', 'basemap-roads': 'roads' };
    const missing = new Set(Object.keys(shipped)
      .filter((source) => !Region.datasets[shipped[source]]));
    if (!missing.size) return style;
    for (const source of missing) delete style.sources[source];
    style.layers = style.layers.filter((layer) => !missing.has(layer.source));
    return style;
  }

  global.BikeBasemap = {
    FONT_STACK,
    ROAD_CLASSES,
    ROAD_MIN_ZOOM,
    ensureProtocol,
    createStyle,
    syncVisibleStateSources,
  };
})(window);
