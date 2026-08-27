/* The one definition of the routing graph's URL, and of the code contract the
 * binary formats obey.
 *
 * app.js and sw.js both need it and used to spell it out separately, each with
 * a comment saying "Must match GRAPH_DATA_VERSION in <the other file>". Two
 * comments pointing at each other is not a mechanism, and the failure is
 * silent: the service worker's cache is keyed by URL, so a rebuilt graph under
 * an unchanged name is served from cache forever, and a rider keeps the graph
 * they first downloaded. Nothing would have looked wrong.
 *
 * Loaded as a classic script by index.html and via importScripts() by sw.js, so
 * it must not use module syntax. In Node the IIFE's `this` is module.exports,
 * so tests can require() it.
 *
 * The URL belongs here for the same reason. app.js asked for the graph at
 * `?format=...&gv=...` while sw.js precached it at `?gv=...`, and the worker
 * matches that path with ignoreSearch:false -- so the copy downloaded during
 * install never matched the copy the app asked for. The install's 32 MB sat
 * unused, the app fetched its own second copy, and a freshly installed PWA
 * could not route offline until some later online session happened to cache
 * the app's spelling of the URL. Two files spelling out one URL is not a
 * mechanism; the query string is part of the identity, so it is built here.
 *
 * What is NOT here any more is the content hashes. A graph hash describes one
 * state's data, so it belongs with that state: build_graph.py and
 * stamp_tiles_version.mjs write into `maps/<state>/region.json`, and this file
 * reads whichever state is loaded. GRAPH_FORMAT_VERSION stays, because it
 * describes router-worker.js rather than any state's data -- bump it when the
 * binary contract changes.
 */
(function (root) {
  // In the browser and the worker, region.js has already run on this global.
  // In Node a require() lands on a fresh module.exports, so go get it.
  let region = root.Region;
  if (!region && typeof require === 'function') {
    try { region = require('./region.js').Region; } catch (e) { /* browser */ }
  }
  if (!region) throw new Error('build-version.js: region.js has not been loaded');

  // The offline data cache's name, shared by the two writers: sw.js precaches
  // and refreshes the loaded state's data there, and map-store.js installs
  // downloaded states into it. Two files spelling out one cache name is the
  // same non-mechanism as two files spelling out one URL was.
  root.DATA_CACHE_NAME = 'data-offline-map-v9';

  root.GRAPH_DATA_VERSION = region.versions.graph || '';
  // Keeps a just-updated worker from being handed a graph cached by an older
  // service worker during the first post-update load.
  root.GRAPH_FORMAT_VERSION = 'bgr13-1';
  // Through the region: the graph lives in the loaded state's folder, and no
  // file outside maps/<state>/ names a state.
  root.GRAPH_URL = `${region.dataUrl('graph2.bin.gz')}`
    + `?format=${root.GRAPH_FORMAT_VERSION}&gv=${root.GRAPH_DATA_VERSION}`;
  // The tile archives get the same treatment the graph got, for the same
  // reason: the offline copies are cached by URL and were otherwise refreshed
  // only by reinstalling the app. sw.js compares these stamps on activation
  // and refetches an archive whose stamp changed. Stamped by
  // scripts/stamp_tiles_version.mjs after a tile rebuild -- run it, never
  // hand-edit.
  root.ROADS_TILES_VERSION = region.versions.roads || '';
  root.REGIONAL_TILES_VERSION = region.versions.regional || '';
  root.BASEMAP_TILES_VERSION = region.versions.basemap || '';
  root.OVERLAY_TILES_VERSION = region.versions.overlays || '';
}(typeof self !== 'undefined' ? self : this));
