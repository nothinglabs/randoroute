/* The one definition of WHICH STATE this build covers.
 *
 * Everything here is configuration, not logic. The safety model, the router,
 * the cost weights and the map styling are all state-agnostic already --
 * `safety-model.js` deliberately knows about a traffic-stress *rating* and
 * never about the agency that published it. What was left scattered through
 * app.js was the handful of facts that genuinely are Washington's: where the
 * data covers, where the map opens, what to call the agency on a card, and how
 * that agency spells its own route ids and facility types.
 *
 * Porting to another state should be reading this file and `docs/PORTING-TO-
 * ANOTHER-STATE.md`, not grepping for "WSDOT".
 *
 * Loaded as a classic script by index.html and copied into the native shell, so
 * it must not use module syntax. In Node the IIFE's `this` is module.exports,
 * so tests can require() it.
 */
(function (root) {
  root.Region = {
    /* ---------------------------------------------------------- identity */
    // Shown in loading copy and appended to a geocoded address that omits it.
    name: 'Washington',

    /* ---------------------------------------------------------- coverage */
    // The routing graph stops at the state line, so a place search hit outside
    // this box can never be routed to and is dropped rather than offered.
    // Generous by a little: clipping a genuine border town is worse than
    // offering one unroutable result.
    bounds: { minLon: -124.9, maxLon: -116.8, minLat: 45.5, maxLat: 49.1 },

    // Where the map opens for a rider with no saved view.
    defaultCenter: [-122.3321, 47.6062],
    defaultZoom: 11,

    /* ------------------------------------------------------- attribution */
    // The state authority behind each enrichment, as it appears on a road card
    // and in the settings copy. OSM is the universal base everywhere; these
    // name whoever adds to it here. All three are the same agency in
    // Washington, and need not be elsewhere.
    stressAgency: 'WSDOT',        // publishes the 1-4 Level of Traffic Stress
    restrictionAgency: 'WSDOT',   // publishes permanent bicycle prohibitions
    speedAgency: 'WSDOT',         // publishes legal speed limits

    // How the layer list names the two state-sourced overlays.
    // The agency's own product names, as cited on a road card.
    facilitySourceName: 'WSDOT Active Transportation Data',
    stressLayerName: 'WSDOT BLTS (state highways)',
    restrictionLayerName: 'Bikes prohibited (WSDOT)',

    /* -------------------------------------------- the agency's own spelling */
    // WSDOT numbers Interstates with these route prefixes and records no
    // separate "is an interstate" field, so the fact is recovered from the
    // route id -- 11,098 of 55,271 segments. Another state that publishes the
    // fact directly can leave this empty.
    interstateRoutePrefixes: ['005', '082', '090', '182', '205', '405', '705'],

    // The agency's facility vocabulary, mapped onto the shared 0-5 level the
    // rest of the app speaks. Without it a card could only say "there is
    // something here", and a shared-use path scored the same as a painted lane.
    facilityLevels: {
      'Shared-Use Path': 5,
      'Sidepath': 5,
      'One-Way Separated Bike Lane': 4,
      'Two-Way Separated Bike Lane': 4,
      'Buffered Bike Lane': 3,
      'Bike Lane': 2,
    },

    // WSDOT route ids carry the direction as a trailing letter -- `005i` and
    // `005d` are the increasing- and decreasing-milepost sides of route 005 --
    // and the road card uses it to say which shoulder a figure describes.
    //
    // A state whose ids do not work this way returns the id unchanged from
    // `routeBase` and null from `routeDirection`; the card then omits the
    // direction and stops looking for an opposite-side sibling, which is
    // exactly what happens today for a route with no suffix.
    routeBase: (routeIdentifier) => String(routeIdentifier || '').replace(/[id]$/i, ''),
    routeDirection: (routeIdentifier) => {
      const id = String(routeIdentifier || '');
      if (/i$/i.test(id)) return 'increasing mileposts';
      if (/d$/i.test(id)) return 'decreasing mileposts';
      return null;
    },
  };

  root.Region.contains = (lon, lat) => {
    const b = root.Region.bounds;
    return lon >= b.minLon && lon <= b.maxLon && lat >= b.minLat && lat <= b.maxLat;
  };
}(typeof self !== 'undefined' ? self : this));
