/* The one definition of the verdict palette.
 *
 * This file exists because the colours were written out four times -- the map
 * in app.js, the route report in route-details.js, and again by hand in two
 * stylesheets -- and they drifted, repeatedly and visibly:
 *
 *   - route-details.js kept FAIL_COLOR = '#78121f' for a whole session after
 *     the fail red was brightened to #a51c30, so the report drew a different
 *     red from the map it was describing. Its own comment said "Keep in step
 *     with COLORS[3] in app.js", which is the smell: a comment is not a
 *     mechanism.
 *   - The "bikes prohibited" legend swatch carried rgba(120,18,31,.45) -- the
 *     old fail red in a notation a hex search does not find -- so a global
 *     replace missed it and the swatch showed a colour the map had stopped
 *     using.
 *   - The legend called the designated ribbon "light blue" when it had been
 *     olive-green for as long as the swatch beside it had been drawing it
 *     olive-green.
 *
 * Every one of those was a copy disagreeing with the original. There is now one
 * original.
 *
 * Loaded as a classic script by index.html and route-details.html, BEFORE the
 * stylesheets, so the custom properties it publishes exist before first paint
 * and no rule needs a hardcoded fallback. It must not use module syntax.
 *
 * In Node the IIFE's `this` is module.exports, so `require('./palette.js')`
 * reaches it for tests without a fake browser -- the same trick safety-model.js
 * relies on.
 *
 * Adding a colour: add it here, give it a CSS variable, and use
 * var(--name) in the stylesheets. Never spell a palette hex anywhere else.
 */
(function (root) {
  'use strict';

  // Internal levels 1 and 2 keep different routing costs but share one colour:
  // a rider is being told "this passes", and two blues would imply a
  // distinction they cannot act on.
  //
  // The values are chosen by maximising the smallest CIELAB distance between
  // any two roles under normal, deuteranope and protanope vision. The full
  // measurements and the reasoning live in docs/SAFETY-MODEL.md; the short
  // version is that these separate by LIGHTNESS, because hue is the axis
  // red-green colour blindness flattens.
  var LEVEL = {
    0: '#999999',   // not enough data to judge
    1: '#168ad1',   // passes your rules
    2: '#168ad1',   // passes; kept distinct for routing only
    3: '#c25d05',   // caution
    4: '#a51c30',   // fails your rules
  };

  var PALETTE = {
    LEVEL: LEVEL,
    unknown: LEVEL[0],
    pass: LEVEL[1],
    caution: LEVEL[3],
    fail: LEVEL[4],
    // A recorded bike facility. Lime, and the only role that earns it.
    bikeNetwork: '#b7c900',
    // Off-street trails: the same lime with a dark centreline and dotted
    // overlay, so "separated from traffic" reads as texture rather than a
    // second colour.
    trailCentreline: '#4c5c00',
    trailDots: '#687d00',
    // A signed route is advice, not infrastructure, so it is family with the
    // lime and duller than it.
    designated: '#5f8000',
    // "This is the piece I am telling you about." Not a verdict, so it must
    // never be mistaken for one -- it rides ALONGSIDE the road rather than over
    // it. A tapped road used to be painted over in solid yellow, which read as
    // a bike facility and hid the very thing the card was describing.
    //
    // Two tones, not one, because no single hue is safe here: the map is full
    // of blue passing roads, lime facilities, amber caution and red failure,
    // and red-green colour blindness flattens the hue axis anyway. So this
    // pair separates on LIGHTNESS instead, at both extremes at once -- near
    // white against every verdict colour, near black against the pale basemap.
    // Whichever it is crossing, one of the two stands out.
    selection: '#f4feff',
    selectionEdge: '#0c1c22',
  };

  // CSS custom property per role. Stylesheets use var(--name); nothing else
  // spells a hex. The -rgb pair exists so a rule can build its own alpha with
  // rgba(var(--verdict-fail-rgb), .45) instead of hand-converting the hex --
  // which is exactly how the prohibited swatch went stale.
  var CSS_VARS = {
    '--verdict-unknown': PALETTE.unknown,
    '--verdict-pass': PALETTE.pass,
    '--verdict-caution': PALETTE.caution,
    '--verdict-fail': PALETTE.fail,
    '--bike-network': PALETTE.bikeNetwork,
    '--trail-centreline': PALETTE.trailCentreline,
    '--trail-dots': PALETTE.trailDots,
    '--designated': PALETTE.designated,
    '--selection': PALETTE.selection,
    '--selection-edge': PALETTE.selectionEdge,
  };

  function toRgbTriple(hex) {
    var v = String(hex).replace('#', '');
    return [
      parseInt(v.slice(0, 2), 16),
      parseInt(v.slice(2, 4), 16),
      parseInt(v.slice(4, 6), 16),
    ].join(',');
  }

  PALETTE.CSS_VARS = CSS_VARS;
  PALETTE.toRgbTriple = toRgbTriple;

  // Publish to :root so the stylesheets derive from this file rather than
  // repeating it. Runs at load, before any rule is applied, because this script
  // is in <head> ahead of the stylesheets.
  PALETTE.applyCssVariables = function (doc) {
    var target = (doc || (typeof document !== 'undefined' ? document : null));
    if (!target || !target.documentElement) return false;
    var style = target.documentElement.style;
    for (var name in CSS_VARS) {
      if (!Object.prototype.hasOwnProperty.call(CSS_VARS, name)) continue;
      style.setProperty(name, CSS_VARS[name]);
      style.setProperty(name + '-rgb', toRgbTriple(CSS_VARS[name]));
    }
    return true;
  };

  if (typeof document !== 'undefined') PALETTE.applyCssVariables(document);

  root.RoutePalette = PALETTE;
}(typeof self !== 'undefined' ? self : this));
