/*
 * The route-marker images, painted pixel-by-pixel because the offline style
 * ships no font glyphs -- a symbol layer with `text-field` would draw nothing.
 *
 * ONE home for every badge: the main map (app.js) and the route preview
 * (route-details.js) both load this file, so a walked stretch shows the same
 * walking figure everywhere. The preview used to keep its own painter and was
 * still drawing the warning triangle the main map had deliberately retired.
 *
 * Plain script, plain globals, like palette.js: no module system in the app.
 */

function ensureUnpavedSlatImage(targetMap, imageId = 'route-unpaved-slats') {
  if (targetMap.hasImage(imageId)) return;
  // Fixed-size symbols stay stable across zoom levels. Dense, narrow bars read
  // as a surface texture while extending beyond the route stroke.
  const width = 2, height = 12;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      data[offset] = 35;
      data[offset + 1] = 54;
      data[offset + 2] = 66;
      data[offset + 3] = 218;
    }
  }
  targetMap.addImage(imageId, { width, height, data }, { pixelRatio: 1 });
}

// The route-marker badge family: one round badge, glyphs painted onto it.
// Integer rows/columns only throughout -- a fractional index into the pixel
// buffer paints nothing.
const STEEP_MARKER_SCALE = 3;
function paintMarkerBadge(ringColor) {
  const s = STEEP_MARKER_SCALE;
  const width = 16 * s, height = 16 * s;
  const data = new Uint8Array(width * height * 4);
  const paint = (x, y, color) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const offset = (y * width + x) * 4;
    data[offset] = color[0]; data[offset + 1] = color[1];
    data[offset + 2] = color[2]; data[offset + 3] = color[3];
  };
  const cx = 8 * s, cy = 8 * s, r = 7.6 * s;
  const badge = [255, 251, 240, 255];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r) paint(x, y, d >= r - 1.4 * s ? ringColor : badge);
    }
  }
  const disc = (px, py, pr, color) => {
    for (let y = Math.round(py - pr); y <= Math.round(py + pr); y++) {
      for (let x = Math.round(px - pr); x <= Math.round(px + pr); x++) {
        if (Math.hypot(x - px, y - py) <= pr) paint(x, y, color);
      }
    }
  };
  const stroke = (x1, y1, x2, y2, w, color) => {
    const steps = Math.max(2, Math.round(Math.hypot(x2 - x1, y2 - y1)));
    for (let i = 0; i <= steps; i++) {
      disc(x1 + (x2 - x1) * (i / steps), y1 + (y2 - y1) * (i / steps), w / 2, color);
    }
  };
  const inside = (x, y) =>
    Math.hypot(Math.round(x) - cx, Math.round(y) - cy) <= r - 1.4 * s;
  return { s, width, height, data, paint, disc, stroke, inside };
}

// A walking figure on the amber badge: the sign says get off and walk. This
// replaced the warning triangle when dismount markers became a spaced chain
// along the walked stretch -- a triangle repeated every 700 m read as a
// string of alarms, where a walker repeated reads as "you are walking here".
function ensureDismountMarkerImage(targetMap, imageId = 'route-dismount-marker-icon') {
  if (targetMap.hasImage(imageId)) return;
  const b = paintMarkerBadge([138, 86, 0, 255]);
  const s = b.s, ink = [81, 47, 0, 255];
  b.disc(8.7 * s, 4.4 * s, 1.15 * s, ink);          // head
  b.stroke(8.5 * s, 5.6 * s, 7.9 * s, 9 * s, 1.6 * s, ink);   // torso, leaning in
  b.stroke(8.2 * s, 6.6 * s, 10 * s, 8.3 * s, 1.1 * s, ink);  // arm forward
  b.stroke(7.9 * s, 9 * s, 9.7 * s, 12.2 * s, 1.3 * s, ink);  // striding leg
  b.stroke(7.9 * s, 9 * s, 6.3 * s, 12.2 * s, 1.3 * s, ink);  // trailing leg
  targetMap.addImage(imageId, { width: b.width, height: b.height, data: b.data },
    { pixelRatio: 2 });
}

function ensureRouteMarkerImages(targetMap) {
  if (targetMap.hasImage('route-marker-steep')) return;
  const painted = {};
  const add = (id, b) => {
    painted[id] = b;
    targetMap.addImage(id,
      { width: b.width, height: b.height, data: b.data }, { pixelRatio: 2 });
  };
  { // steep: two peaks; a hill profile reads as "mountain" at 16 px.
    const b = paintMarkerBadge([90, 62, 8, 255]);
    const peak = (px, py, half, color) => {
      const top = Math.round(py), bottom = Math.round(12 * b.s);
      for (let y = top; y <= bottom; y++) {
        const grow = ((y - top) / (bottom - top)) * half;
        for (let x = Math.round(px - grow); x <= Math.round(px + grow); x++) {
          if (b.inside(x, y)) b.paint(x, y, color);
        }
      }
    };
    peak(6 * b.s, 6.4 * b.s, 4.4 * b.s, [138, 86, 0, 255]);
    peak(10.4 * b.s, 4.4 * b.s, 4.6 * b.s, [90, 62, 8, 255]);
    add('route-marker-steep', b);
  }
  { // traffic: a side-view car -- rounded chassis, glazed cabin, two wheels.
    const b = paintMarkerBadge([140, 28, 28, 255]);
    const s = b.s, body = [176, 32, 32, 255], glass = [223, 236, 244, 255],
      tyre = [36, 26, 26, 255], hub = [205, 205, 210, 255];
    // Cabin: a trapezoid, windshield raked toward the front (right).
    for (let y = Math.round(5.3 * s); y <= Math.round(7.9 * s); y++) {
      const t = (y - 5.3 * s) / (2.6 * s);
      const left = 5.4 * s - 0.5 * s * t, right = 9.8 * s + 1.5 * s * t;
      for (let x = Math.round(left); x <= Math.round(right); x++) b.paint(x, y, body);
    }
    // Chassis with rounded nose and tail.
    for (let y = Math.round(7.9 * s); y <= Math.round(10.3 * s); y++) {
      for (let x = Math.round(3.3 * s); x <= Math.round(12.7 * s); x++) b.paint(x, y, body);
    }
    b.disc(4 * s, 9.1 * s, 1.2 * s, body);
    b.disc(12 * s, 9.1 * s, 1.2 * s, body);
    // Two windows split by the door pillar.
    for (let y = Math.round(5.9 * s); y <= Math.round(7.6 * s); y++) {
      const t = (y - 5.9 * s) / (1.7 * s);
      const right = 9.7 * s + 1 * s * t;
      for (let x = Math.round(6.1 * s); x <= Math.round(right); x++) {
        if (Math.abs(x - 8.1 * s) > 0.4 * s) b.paint(x, y, glass);
      }
    }
    b.disc(5.5 * s, 10.5 * s, 1.45 * s, tyre);
    b.disc(10.5 * s, 10.5 * s, 1.45 * s, tyre);
    b.disc(5.5 * s, 10.5 * s, 0.55 * s, hub);
    b.disc(10.5 * s, 10.5 * s, 0.55 * s, hub);
    add('route-marker-traffic', b);
  }
  { // unpaved: a serrated ground profile -- the steep badge's mountain
    // flattened into a wide band of small jagged teeth. Reads "rough
    // surface" where the tall twin peaks read "climb".
    const b = paintMarkerBadge([92, 78, 60, 255]);
    const s = b.s, dark = [104, 85, 61, 255], deep = [84, 68, 49, 255];
    const tooth = (px, py, half, baseY, color) => {
      const top = Math.round(py), bottom = Math.round(baseY);
      for (let y = top; y <= bottom; y++) {
        const grow = ((y - top) / Math.max(1, bottom - top)) * half;
        for (let x = Math.round(px - grow); x <= Math.round(px + grow); x++) {
          if (b.inside(x, y)) b.paint(x, y, color);
        }
      }
      // A small cap preserves the irregular gravel edge without turning each
      // tooth into a needle-sharp mountain peak at phone scale.
      b.disc(px, py + 0.3 * s, 0.62 * s, color);
    };
    // Alternating tooth heights give the ragged edge; the solid band under
    // them makes it one surface rather than a row of tiny mountains.
    tooth(3.9 * s, 8.4 * s, 1.3 * s, 10.2 * s, dark);
    tooth(6 * s, 7.6 * s, 1.4 * s, 10.2 * s, deep);
    tooth(8.1 * s, 8.6 * s, 1.3 * s, 10.2 * s, dark);
    tooth(10.1 * s, 7.9 * s, 1.4 * s, 10.2 * s, deep);
    tooth(12 * s, 8.7 * s, 1.2 * s, 10.2 * s, dark);
    for (let y = Math.round(10.2 * s); y <= Math.round(11.7 * s); y++) {
      for (let x = Math.round(3 * s); x <= Math.round(13 * s); x++) {
        if (b.inside(x, y)) b.paint(x, y, y > 11 * s ? deep : dark);
      }
    }
    add('route-marker-unpaved', b);
  }
  { // fail: a bold exclamation -- "a rule failed here; tap for which".
    const b = paintMarkerBadge([176, 32, 32, 255]);
    const s = b.s, ink = [176, 32, 32, 255];
    b.stroke(8 * s, 5.3 * s, 8 * s, 6.2 * s, 1.7 * s, ink);
    b.stroke(8 * s, 6.2 * s, 8 * s, 9 * s, 1.4 * s, ink);
    b.disc(8 * s, 11.2 * s, 0.95 * s, ink);
    add('route-marker-fail', b);
  }
  { // fail-designated: one strong warning mark in a two-tone badge. The old
    // badge squeezed a tiny bicycle beside a tiny exclamation point; at map
    // size that became a ragged cluster of unrelated pixels. This keeps the
    // ordinary fail badge's immediately recognisable `!`, while the olive
    // lower rim matches the designated-route map underlay. The distinction is
    // carried by the badge itself instead of a second microscopic pictogram.
    const b = paintMarkerBadge([176, 32, 32, 255]);
    const s = b.s;
    const failInk = [176, 32, 32, 255];
    const routeInk = [95, 128, 0, 255];

    // Repaint only the lower portion of the existing outer ring. A broad arc
    // survives downsampling cleanly and reads as one polished badge rather
    // than two icons fighting for the same 24 pixels.
    const cx = 8 * s, cy = 8 * s, outer = 7.6 * s, inner = outer - 1.4 * s;
    for (let y = Math.round(10.2 * s); y < b.height; y++) {
      for (let x = 0; x < b.width; x++) {
        const distance = Math.hypot(x - cx, y - cy);
        if (distance >= inner && distance <= outer) b.paint(x, y, routeInk);
      }
    }

    // A centred, squared exclamation stays crisp after MapLibre downsamples
    // the 3x backing image. It is deliberately almost the size of the plain
    // fail glyph: designation must never weaken the warning.
    const bx = Math.round(8 * s), halfWidth = Math.round(0.82 * s);
    for (let y = Math.round(4.6 * s); y <= Math.round(8.6 * s); y++) {
      for (let x = bx - halfWidth; x <= bx + halfWidth; x++) {
        b.paint(x, y, failInk);
      }
    }
    b.disc(bx, 10.55 * s, 0.92 * s, failInk);
    add('route-marker-fail-designated', b);
  }
  // Combined badges: a spot can be steep AND trafficked, and one badge must
  // not hide the other -- the marker chain emits every active kind as ONE
  // clustered image (field: "a traffic icon will seem to hide that there is
  // a hill at the same spot"). Every combination is composited eagerly, in
  // canonical order; buildRouteMarkerData joins kinds with '+' in the same
  // order. Leftmost badge paints last so the primary kind sits on top of
  // the overlap seam.
  const COMBO_KINDS = ['steep', 'traffic', 'unpaved'];
  const overlap = Math.round(4 * STEEP_MARKER_SCALE);
  const composite = (parts) => {
    const w = parts[0].width, h = parts[0].height, step = w - overlap;
    const width = w + step * (parts.length - 1);
    const data = new Uint8Array(width * h * 4);
    for (let index = parts.length - 1; index >= 0; index--) {
      const part = parts[index], x0 = index * step;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const srcAt = (y * part.width + x) * 4;
          if (part.data[srcAt + 3] === 0) continue;
          const dst = (y * width + x0 + x) * 4;
          data[dst] = part.data[srcAt]; data[dst + 1] = part.data[srcAt + 1];
          data[dst + 2] = part.data[srcAt + 2]; data[dst + 3] = part.data[srcAt + 3];
        }
      }
    }
    return { width, height: h, data };
  };
  const combos = (list, from) => {
    for (let i = from; i < COMBO_KINDS.length; i++) {
      const next = [...list, COMBO_KINDS[i]];
      if (next.length > 1) {
        targetMap.addImage('route-marker-' + next.join('+'),
          (({ width, height, data }) => ({ width, height, data }))(
            composite(next.map((kind) => painted['route-marker-' + kind]))),
          { pixelRatio: 2 });
      }
      combos(next, i + 1);
    }
  };
  combos([], 0);
}
