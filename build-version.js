/* The one definition of the routing graph's version AND its URL.
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
 * Bump GRAPH_DATA_VERSION when the graph is rebuilt, and GRAPH_FORMAT_VERSION
 * when router-worker.js changes the binary contract. Once, here.
 */
(function (root) {
  root.GRAPH_DATA_VERSION = 'sha-98d5168cff37';
  // Keeps a just-updated worker from being handed a graph cached by an older
  // service worker during the first post-update load.
  root.GRAPH_FORMAT_VERSION = 'bgr10-1';
  root.GRAPH_URL = `data/graph2.bin.gz?format=${root.GRAPH_FORMAT_VERSION}`
    + `&gv=${root.GRAPH_DATA_VERSION}`;
  // The tile archives get the same treatment the graph got, for the same
  // reason: the offline copies are cached by URL and were otherwise refreshed
  // only by reinstalling the app. sw.js compares these stamps on activation
  // and refetches an archive whose stamp changed. Stamped by
  // scripts/stamp_tiles_version.mjs after a tile rebuild -- run it, never
  // hand-edit.
  root.ROADS_TILES_VERSION = 'sha-dd29b387e828';
  root.BASEMAP_TILES_VERSION = 'sha-77136fe2672a';
}(typeof self !== 'undefined' ? self : this));
