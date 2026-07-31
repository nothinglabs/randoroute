/* The one definition of the graph-data version.
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
 * Bump this when the graph is rebuilt. Once, here.
 */
(function (root) {
  root.GRAPH_DATA_VERSION = '2026-07-30-service-links';
}(typeof self !== 'undefined' ? self : this));
