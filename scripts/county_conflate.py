#!/usr/bin/env python3
"""Match county bike-route geometry onto OSM geometry, at build time.

This is the Python twin of the snapping in `county-data.js`, and it exists so
that the map, the router and the cards all read ONE county flag rather than
three independently-derived ones.

Why build time. The map's road colours come from `roadLevelExpr`, which MapLibre
evaluates in the renderer against vector-tile properties. Nothing computed in
JavaScript can reach it: the tiles carry what they carry. So a county
designation that is only conflated at runtime can change routing and the cards
but never the colour on the map -- and a rider then sees a road routed over and
described as passing while it is drawn failing. Baking the flag into
`roads.pmtiles` and `graph2.bin.gz` is what makes those three agree.

The cost is honest: adding or re-surveying a county's routes means rebuilding
those two archives. Their *traffic counts* stay a runtime overlay, because they
never touch colour and they are the part that actually churns.

The match, identical to the JS:
  - within 18 m of an OSM way's own span, not its midpoint
  - headings aligned within 40 degrees, either direction along the line

The bearing test is not optional. Without it, Island County's 33.5 miles of
signed route matched 72 miles of graph, bleeding onto every side street that
crossed it; with it, 42 -- the remainder being edges that straddle a route's
ends, which is inherent to segment granularity.
"""

import json
import math

SNAP_M = 18.0
STEP_M = 12.0
MAX_BEARING_DIFF = math.radians(40)
M_PER_DEG_LAT = 110_540.0


def _m_per_deg_lon(lat):
    return 111_320.0 * math.cos(math.radians(lat))


def load_bundles(paths):
    """Read county bundles, keeping only routes the county has BUILT.

    A planned corridor is a plan, not pavement. The build script that produces
    a bundle already drops them; requiring `existing` here as well means a
    county whose status field we map wrongly cannot quietly promote one.
    """
    bundles = []
    for path in paths or []:
        with open(path, encoding='utf-8') as handle:
            bundle = json.load(handle)
        routes = [r for r in bundle.get('routes', []) if r.get('status') == 'existing']
        if routes:
            bundles.append({'county': bundle.get('county'), 'routes': routes})
    return bundles


class CountyRouteIndex:
    """Grid over county route segments, queried by OSM geometry.

    Built once and asked a question per OSM way, which is the opposite of the
    runtime direction (walk the county line, find graph edges). Here the OSM
    side is the stream, so the county side is what gets indexed.
    """

    def __init__(self, bundles):
        self.cells = {}
        self.counties = {}
        self.empty = True
        segments = []
        for bundle in bundles:
            for route in bundle['routes']:
                coords = route['coords']
                for a, b in zip(coords, coords[1:]):
                    segments.append((a, b, bundle.get('county')))
        if not segments:
            return
        self.empty = False
        lat0 = sum(a[1] for a, _b, _c in segments) / len(segments)
        self.m_lon = _m_per_deg_lon(lat0)
        self.d_lon = SNAP_M / self.m_lon
        self.d_lat = SNAP_M / M_PER_DEG_LAT
        for a, b, county in segments:
            bearing = math.atan2((b[1] - a[1]) * M_PER_DEG_LAT,
                                 (b[0] - a[0]) * self.m_lon)
            entry = (a, b, bearing, county)
            # Rasterise the segment into every cell it crosses, so a long
            # segment is findable from anywhere along it.
            span = math.hypot((b[0] - a[0]) * self.m_lon, (b[1] - a[1]) * M_PER_DEG_LAT)
            steps = max(1, int(math.ceil(span / SNAP_M)))
            for s in range(steps + 1):
                t = s / steps
                lon = a[0] + (b[0] - a[0]) * t
                lat = a[1] + (b[1] - a[1]) * t
                self.cells.setdefault(
                    (int(math.floor(lon / self.d_lon)), int(math.floor(lat / self.d_lat))),
                    []).append(entry)

    @staticmethod
    def _dist_to_span(lon, lat, a, b, m_lon):
        ax = (a[0] - lon) * m_lon
        ay = (a[1] - lat) * M_PER_DEG_LAT
        bx = (b[0] - lon) * m_lon
        by = (b[1] - lat) * M_PER_DEG_LAT
        vx, vy = bx - ax, by - ay
        span = vx * vx + vy * vy
        t = 0.0 if span == 0 else max(0.0, min(1.0, -(ax * vx + ay * vy) / span))
        return math.hypot(ax + vx * t, ay + vy * t)

    @staticmethod
    def _aligned(one, two):
        diff = abs(one - two) % (2 * math.pi)
        if diff > math.pi:
            diff = 2 * math.pi - diff
        if diff > math.pi / 2:          # a road has no preferred end
            diff = math.pi - diff
        return diff <= MAX_BEARING_DIFF

    def county_for(self, coords):
        """The county whose signed route this OSM way follows, or None.

        A way qualifies when a sampled point along it lands within SNAP_M of a
        route segment pointing the same way. Sampling the OSM side rather than
        testing endpoints matters: OSM ways are long, and a route may join one
        partway along.
        """
        if self.empty or len(coords) < 2:
            return None
        for i in range(len(coords) - 1):
            a, b = coords[i], coords[i + 1]
            m_lon = _m_per_deg_lon(a[1])
            dx = (b[0] - a[0]) * m_lon
            dy = (b[1] - a[1]) * M_PER_DEG_LAT
            bearing = math.atan2(dy, dx)
            steps = max(1, int(math.ceil(math.hypot(dx, dy) / STEP_M)))
            for s in range(steps + 1):
                t = s / steps
                lon = a[0] + (b[0] - a[0]) * t
                lat = a[1] + (b[1] - a[1]) * t
                gx = int(math.floor(lon / self.d_lon))
                gy = int(math.floor(lat / self.d_lat))
                for ox in (-1, 0, 1):
                    for oy in (-1, 0, 1):
                        for sa, sb, sbearing, county in self.cells.get((gx + ox, gy + oy), ()):
                            if self._dist_to_span(lon, lat, sa, sb, self.m_lon) > SNAP_M:
                                continue
                            if not self._aligned(bearing, sbearing):
                                continue
                            return county or True
        return None
