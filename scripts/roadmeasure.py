#!/usr/bin/env python3
"""
Conflate the statewide road measurements onto OSM graph edges.

BUILD-TIME ONLY. Imported by build_graph.py and build_roads.py so the graph and
the vector tiles carry identical numbers; a value that reaches the router but
not the map (or the reverse) is how the card came to disagree with the colour.

Three sources, all matched the same way:

  roadlog.geojson   CRAB county road log -- bail-out space per side, ADT + year
  funcclass.geojson WSDOT non-state functional class -- class, owner
  aadt.geojson      WSDOT traffic counts -- ADT + year, state routes

MATCHING RULE, and why it is this and not something simpler.

A previous county import matched by nearest midpoint and produced 72 miles of
"matched" graph from 33.5 miles of source, by bleeding onto every crossing side
street. Two things fix that, and both are required:

  1. Match against the OSM way's OWN SPAN, not its midpoint. Graph edges average
     ~190 m, so a midpoint test says nothing about whether the source line
     accompanies the edge or merely touches it. Interior sample points must all
     lie within MATCH_M of the source geometry.

  2. Require the two to be ALIGNED within BEARING_TOL_DEG. Without the bearing
     test a source line running along an arterial claims every residential
     street that crosses it. With it, the same import matched 42 miles instead
     of 72.

And when reporting how much matched, measure the MATCHED PORTION of each way,
never the whole way: a way runs far past the stretch a source line follows, so
counting all of it roughly doubles the figure and makes any over-match check
fire on healthy data.
"""
import json
import math
import os

from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

# ~18 m at Washington latitudes. Wide enough for the routine offset between an
# OSM centerline and an agency centerline, tight enough to exclude a parallel
# frontage road.
MATCH_M = 18.0
MATCH_DEG = MATCH_M / 111_320.0
# Two lines describing the same road agree in heading within this, allowing for
# the source's coarser digitising. A crossing street differs by ~90.
BEARING_TOL_DEG = 40.0
# Interior fractions; endpoints are excluded because that is where an edge meets
# roads it is not part of.
SAMPLE_FRACS = (0.2, 0.5, 0.8)


def _bearing(a, b):
    lon1, lat1 = a
    lon2, lat2 = b
    x = (lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    y = lat2 - lat1
    return math.degrees(math.atan2(x, y))


def _bearing_gap(a, b):
    """Smallest angle between two undirected headings (0..90)."""
    d = abs((b - a + 180) % 360 - 180)
    return min(d, 180 - d)


def _line_bearing_near(line, point):
    """Heading of the source line in the neighbourhood of `point`."""
    total = line.length
    if total == 0:
        return None
    at = line.project(point)
    step = min(total / 2, MATCH_DEG * 4) or total / 2
    lo = line.interpolate(max(0.0, at - step))
    hi = line.interpolate(min(total, at + step))
    if lo.equals(hi):
        return None
    return _bearing((lo.x, lo.y), (hi.x, hi.y))


class MeasureIndex:
    """One source layer, indexed for span+bearing matching."""

    def __init__(self, path, label):
        self.label = label
        self.geoms = []
        self.props = []
        self.tree = None
        self.matched_m = 0.0
        self.hits = 0
        self.misses = 0
        if not path or not os.path.exists(path):
            print(f'  {label}: not present, skipped', flush=True)
            return
        fc = json.load(open(path))
        for f in fc.get('features', []):
            g = f.get('geometry') or {}
            if g.get('type') != 'LineString':
                continue
            cs = g.get('coordinates') or []
            if len(cs) < 2:
                continue
            self.geoms.append(LineString(cs))
            self.props.append(f.get('properties') or {})
        if self.geoms:
            self.tree = STRtree(self.geoms)
        print(f'  {label}: {len(self.geoms):,} segments', flush=True)

    def __bool__(self):
        return self.tree is not None

    def match(self, coords):
        """Best source properties for one OSM way, or None.

        Returns the candidate whose geometry stays closest across all interior
        samples, subject to every sample being within MATCH_M and the two
        headings agreeing within BEARING_TOL_DEG.
        """
        if self.tree is None or len(coords) < 2:
            return None
        line = LineString(coords)
        if line.length == 0:
            return None
        points = [line.interpolate(f, normalized=True) for f in SAMPLE_FRACS]

        # One `dwithin` query over the whole way, rather than a buffer polygon
        # per sample point: same candidates, a third of the cost, and this runs
        # once per OSM way across the whole state.
        candidates = self.tree.query(line, predicate='dwithin', distance=MATCH_DEG)
        best = None
        way_bearing = _bearing(coords[0], coords[-1])
        mid = points[len(points) // 2]
        for gi in candidates:
            g = self.geoms[int(gi)]
            # Rule 1: the source must accompany the way across its own span, not
            # merely touch it somewhere. Checked sample by sample with an early
            # exit -- most candidates fail on the first one, and this loop is
            # the whole cost of the conflation.
            total = 0.0
            ok = True
            for p in points:
                d = g.distance(p)
                if d > MATCH_DEG:
                    ok = False
                    break
                total += d
            if not ok:
                continue
            # Rule 2: aligned, or it is a road that crosses rather than one that
            # coincides. Only reached by candidates that already ran alongside.
            src_bearing = _line_bearing_near(g, mid)
            if src_bearing is None:
                continue
            if _bearing_gap(way_bearing, src_bearing) > BEARING_TOL_DEG:
                continue
            if best is None or total < best[0]:
                best = (total, int(gi))
        if best is None:
            self.misses += 1
            return None
        self.hits += 1
        # Rule 3 for reporting: credit the matched PORTION of this way, which is
        # its own length here because every sample matched. Callers that match a
        # sub-span must add only that sub-span.
        self.matched_m += length_m(coords)
        return self.props[best[1]]

    def report(self):
        if self.tree is None:
            return
        total = self.hits + self.misses
        pct = (100.0 * self.hits / total) if total else 0.0
        print(f'  {self.label}: matched {self.hits:,} of {total:,} ways '
              f'({pct:.1f}%), {self.matched_m / 1609.344:,.0f} mi', flush=True)


def length_m(coords):
    total = 0.0
    for a, b in zip(coords, coords[1:]):
        dx = (b[0] - a[0]) * math.cos(math.radians((a[1] + b[1]) / 2)) * 111_320.0
        dy = (b[1] - a[1]) * 110_540.0
        total += math.hypot(dx, dy)
    return total


class RoadMeasures:
    """All three sources together, resolved into one set of per-way values."""

    def __init__(self, roadlog=None, funcclass=None, aadt=None):
        self.roadlog = MeasureIndex(roadlog, 'CRAB road log')
        self.funcclass = MeasureIndex(funcclass, 'functional class')
        self.aadt = MeasureIndex(aadt, 'WSDOT AADT')

    def __bool__(self):
        return bool(self.roadlog) or bool(self.funcclass) or bool(self.aadt)

    def match(self, coords):
        """-> dict of measurements for one OSM way (may be empty).

        Keys, all optional:
          adt, adty   traffic volume and the year it was counted
          adtSrc      'county' | 'state' -- which inventory the count came from
          edge        bail-out space per side, ft (CRAB, derived)
          edgeClamp   1 when the lane-width clamp was applied to get it
          shP         reported PAVED shoulder, ft (CRAB, ~15% of rows)
          fc          FHWA functional class 1-7
          owner       FHWA roadway owner code (1 state, 2 county, 3 town, 4 city)
        """
        out = {}

        log = self.roadlog.match(coords) if self.roadlog else None
        if log:
            if log.get('adt'):
                out['adt'] = int(log['adt'])
                out['adty'] = log.get('adty')
                out['adtSrc'] = 'county'
            edge = log.get('edge')
            if edge is not None:
                out['edge'] = float(edge)
                out['edgeClamp'] = 1 if log.get('clamped') else 0
            if log.get('shP') is not None:
                out['shP'] = float(log['shP'])

        # A current state-route count beats a county count, which can be from
        # the 1970s. Only replaces it when there is actually a number.
        state = self.aadt.match(coords) if self.aadt else None
        if state and state.get('adt'):
            out['adt'] = int(state['adt'])
            out['adty'] = state.get('adty')
            out['adtSrc'] = 'state'

        fc = self.funcclass.match(coords) if self.funcclass else None
        if fc:
            if fc.get('fc'):
                out['fc'] = int(fc['fc'])
            if fc.get('owner'):
                out['owner'] = int(fc['owner'])

        return out

    def report(self):
        self.roadlog.report()
        self.funcclass.report()
        self.aadt.report()
