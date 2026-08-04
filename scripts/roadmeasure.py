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
  hpms.geojson      FHWA HPMS -- ADT + year, the only source for city streets

MATCHING RULE, and why it is this and not something simpler.

A previous county import matched by nearest midpoint and produced 72 miles of
"matched" graph from 33.5 miles of source, by bleeding onto every crossing side
street. Two things fix that, and both are required:

  1. Match against the OSM way's OWN SPAN, not its midpoint. Graph edges average
     ~190 m, so a midpoint test says nothing about whether the source line
     accompanies the edge or merely touches it. A source must cover a MAJORITY
     of the way's interior sample points, each within MATCH_M.

  2. Require the two to be ALIGNED within BEARING_TOL_DEG. Without the bearing
     test a source line running along an arterial claims every residential
     street that crosses it. With it, the same import matched 42 miles instead
     of 72.

And when reporting how much matched, measure the MATCHED PORTION of each way,
never the whole way: a way runs far past the stretch a source line follows, so
counting all of it roughly doubles the figure and makes any over-match check
fire on healthy data.
"""
import gzip
import json
import math
import os

import numpy as np
import shapely

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
# Sample points along the way, evenly spaced and away from the endpoints, since
# an endpoint is where an edge meets roads it is not part of.
SAMPLE_COUNT = 5
SAMPLE_FRACS = tuple((i + 0.5) / SAMPLE_COUNT for i in range(SAMPLE_COUNT))
_SAMPLE_FRACS_ARR = np.array(SAMPLE_FRACS)
# How many samples the source layer must cover, between all of its aligned
# segments, to claim the way: a simple majority.
#
# An earlier rule demanded EVERY sample fall within MATCH_M of ONE source
# segment. That was built to stop a source line merely touching an edge, and it
# does -- but it also throws away sources that legitimately cover only part of
# one. The road log's segments are frequently far shorter than a graph edge, so
# no single record could span an edge and the match failed outright: on Pioneer
# Way East it rejected 4.13 of 5.83 miles whose nearest road-log line was
# touching the edge at zero distance.
#
# Majority coverage keeps the protection and drops the brittleness. It is in one
# respect stricter than what it replaces: every sample is bearing-checked where
# it sits, whereas the old rule checked alignment only at the midpoint.
MIN_SAMPLES_COVERED = 3


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


def resolve_source(path):
    """The plain file if present, else its .gz twin, else None.

    These sources take the better part of an hour to fetch and the container is
    reclaimed after a short idle period, taking anything untracked with it. The
    compressed copies are committed so a fresh container costs a decompress
    rather than a re-fetch; the plain files stay ignored.
    """
    if not path:
        return None
    if os.path.exists(path):
        return path
    if not path.endswith('.gz') and os.path.exists(path + '.gz'):
        return path + '.gz'
    return None


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
        path = resolve_source(path)
        if not path:
            print(f'  {label}: not present, skipped', flush=True)
            return
        opener = gzip.open if path.endswith('.gz') else open
        with opener(path, 'rt') as fh:
            fc = json.load(fh)
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
            # Source-line lengths, once. match() needs each candidate's length
            # for its bearing window, and shapely computes the whole array in
            # one C call here instead of one Python call per pair there.
            self._lengths = shapely.length(self.tree.geometries)
        print(f"  {label}: {len(self.geoms):,} segments", flush=True)

    def __bool__(self):
        return self.tree is not None

    def match(self, coords, shared=None):
        """Best source properties for one OSM way, or None.

        Matches when the source layer's aligned segments together cover a
        majority of the way's sample points, each within MATCH_M and aligned
        within BEARING_TOL_DEG where it was sampled. Reports the values of
        whichever single segment covers the most of it.

        `shared` is (sample_points, way_bearing) from RoadMeasures.match():
        four layers sample one way at the same five fractions, so the sampling
        is done once and handed to each rather than rebuilt per layer.

        The loop this replaces asked shapely one question per sample point and
        then per (segment, sample) pair -- five queries, then a distance, a
        projection, two interpolations and a bearing for every pair, each call
        paying shapely's per-call Python ceremony. Half the whole graph build
        was that ceremony. Every question is now asked once, over arrays, with
        the same numbers coming back: batched STRtree queries return pairs in
        the same per-point traversal order the loop saw, so even the
        tie-breaks below choose identically.
        """
        if self.tree is None or len(coords) < 2:
            return None
        if shared is None:
            line = LineString(coords)
            if line.length == 0:
                return None
            points = shapely.line_interpolate_point(
                line, _SAMPLE_FRACS_ARR, normalized=True)
            way_bearing = _bearing(coords[0], coords[-1])
        else:
            points, way_bearing = shared

        # Which samples does each nearby segment cover? A segment is only
        # credited with a sample it is genuinely beside AND aligned with, so a
        # crossing street can never accumulate coverage. dwithin IS the
        # distance test -- the old loop re-checked g.distance(point) after it,
        # which could never reject.
        pi, gi = self.tree.query(points, predicate='dwithin', distance=MATCH_DEG)
        if len(gi) == 0:
            self.misses += 1
            return None
        glines = self.tree.geometries[gi]
        pts = points[pi]
        lengths = self._lengths[gi]
        # _line_bearing_near(), elementwise: project each sample onto its
        # candidate, take a short window either side, and read the heading.
        at = shapely.line_locate_point(glines, pts)
        step = np.minimum(lengths / 2, MATCH_DEG * 4)
        lo = shapely.line_interpolate_point(glines, np.maximum(0.0, at - step))
        hi = shapely.line_interpolate_point(glines, np.minimum(lengths, at + step))
        lox, loy = shapely.get_x(lo), shapely.get_y(lo)
        hix, hiy = shapely.get_x(hi), shapely.get_y(hi)
        with np.errstate(invalid='ignore'):
            x = (hix - lox) * np.cos(np.radians((loy + hiy) / 2))
            y = hiy - loy
            src_bearing = np.degrees(np.arctan2(x, y))
            d = np.abs((src_bearing - way_bearing + 180) % 360 - 180)
            gap = np.minimum(d, 180 - d)
        keep = ((lengths > 0) & ~((lox == hix) & (loy == hiy))
                & (gap <= BEARING_TOL_DEG))

        covered = {}
        for k in np.flatnonzero(keep):
            covered.setdefault(int(gi[k]), set()).add(int(pi[k]))

        if not covered:
            self.misses += 1
            return None

        # Does the source layer accompany this way at all? Answered by the UNION
        # of what its aligned segments cover, not by any one of them. The road
        # log stores a road as a run of short consecutive records -- a 1 km way
        # can sit on five of them, each covering a single sample -- so asking
        # any single record to reach a majority rejects exactly the case this
        # rule exists to accept. Every contributing segment was individually
        # distance- and bearing-checked above, so a crossing street or a
        # parallel road still contributes nothing.
        union = set()
        for samples in covered.values():
            union |= samples
        if len(union) < MIN_SAMPLES_COVERED:
            self.misses += 1
            return None

        # Which record's values to report: the one covering the most of the way,
        # and where two tie, the one covering its middle.
        middle = len(points) // 2
        gi = max(covered, key=lambda k: (len(covered[k]), middle in covered[k]))
        self.hits += 1
        # Credit only the MATCHED PORTION. A way runs past the stretch a source
        # follows, so counting all of it roughly doubles the reported mileage
        # and makes any over-match check fire on healthy data.
        self.matched_m += length_m(coords) * len(union) / SAMPLE_COUNT
        return self.props[gi]

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


# Which inventory a traffic count came from. Stored per edge, shown on the card,
# and used to break ties -- so the values are part of the data format, not a
# presentation detail. See ADT_SOURCE_* in scripts/build_graph.py.
ADT_SOURCE_NONE = 0
ADT_SOURCE_COUNTY = 1     # CRAB county road log, a measured count
ADT_SOURCE_STATE = 2      # WSDOT traffic counts, a measured count
ADT_SOURCE_HPMS = 3       # FHWA HPMS; MODELLED on non-state roads, not counted

# A measured count and a modelled estimate are not the same claim, so where two
# sources describe one road the choice between them needs a stated reason rather
# than an accident of evaluation order.
#
# THE RULE: the most recent count wins; where the years tie, a measured count
# beats a modelled one.
#
# Recency is the tiebreaker because neither source is systematically better than
# the other. On the 27,279 graph edges where the county road log and HPMS both
# land, the median ratio between them is exactly 1.00 -- no bias in either
# direction, just scatter. With nothing to separate them on accuracy, the count
# taken closer to today is the better description of the road today.
#
# A count with no recorded year is treated as older than any dated one. It
# cannot be shown with a year, so it must not displace something that can.
MEASURED_SOURCES = (ADT_SOURCE_COUNTY, ADT_SOURCE_STATE)


def _better_count(candidate, incumbent):
    """Should `candidate` replace `incumbent`? Both are (adt, year, source)."""
    if incumbent is None:
        return True
    _, cand_year, cand_src = candidate
    _, held_year, held_src = incumbent
    cand_year = cand_year or 0
    held_year = held_year or 0
    if cand_year != held_year:
        return cand_year > held_year
    return (cand_src in MEASURED_SOURCES) and (held_src not in MEASURED_SOURCES)


class RoadMeasures:
    """All four sources together, resolved into one set of per-way values."""

    def __init__(self, roadlog=None, funcclass=None, aadt=None, hpms=None):
        self.roadlog = MeasureIndex(roadlog, 'CRAB road log')
        self.funcclass = MeasureIndex(funcclass, 'functional class')
        self.aadt = MeasureIndex(aadt, 'WSDOT AADT')
        self.hpms = MeasureIndex(hpms, 'FHWA HPMS')

    def __bool__(self):
        return (bool(self.roadlog) or bool(self.funcclass)
                or bool(self.aadt) or bool(self.hpms))

    def match(self, coords):
        """-> dict of measurements for one OSM way (may be empty).

        Keys, all optional:
          adt, adty   traffic volume and the year it was counted
          adtSrc      ADT_SOURCE_* -- which inventory the count came from,
                      resolved by _better_count above
          edge        bail-out space per side, ft (CRAB, derived)
          edgeClamp   1 when the lane-width clamp was applied to get it
          shP         reported PAVED shoulder, ft (CRAB, ~15% of rows)
          fc          FHWA functional class 1-7
          owner       FHWA roadway owner code (1 state, 2 county, 3 town, 4 city)
        """
        out = {}
        count = None   # (adt, year, source), resolved by _better_count

        # One sampling for all four layers: they interpolate the same way at
        # the same five fractions, so building the line and its sample points
        # per layer did the identical work four times over.
        line = LineString(coords) if len(coords) >= 2 else None
        if line is None or line.length == 0:
            shared = None
        else:
            shared = (shapely.line_interpolate_point(
                line, _SAMPLE_FRACS_ARR, normalized=True),
                _bearing(coords[0], coords[-1]))
        if shared is None:
            return out

        log = self.roadlog.match(coords, shared) if self.roadlog else None
        if log:
            if log.get('adt'):
                count = (int(log['adt']), log.get('adty'), ADT_SOURCE_COUNTY)
            edge = log.get('edge')
            if edge is not None:
                out['edge'] = float(edge)
                out['edgeClamp'] = 1 if log.get('clamped') else 0
            if log.get('shP') is not None:
                out['shP'] = float(log['shP'])

        state = self.aadt.match(coords, shared) if self.aadt else None
        if state and state.get('adt'):
            cand = (int(state['adt']), state.get('adty'), ADT_SOURCE_STATE)
            if _better_count(cand, count):
                count = cand

        hpms = self.hpms.match(coords, shared) if self.hpms else None
        if hpms:
            if hpms.get('adt'):
                cand = (int(hpms['adt']), hpms.get('adty'), ADT_SOURCE_HPMS)
                if _better_count(cand, count):
                    count = cand
            # HPMS carries a functional class for state routes, which WSDOT's
            # non-state layer by definition does not. Only fills a gap.
            if hpms.get('fc') and not out.get('fc'):
                out['fc'] = int(hpms['fc'])
            if hpms.get('owner') and not out.get('owner'):
                out['owner'] = int(hpms['owner'])

        fc = self.funcclass.match(coords, shared) if self.funcclass else None
        if fc:
            # The dedicated layer wins over HPMS for class and owner: it is the
            # current publication, where the HPMS release is from 2018.
            if fc.get('fc'):
                out['fc'] = int(fc['fc'])
            if fc.get('owner'):
                out['owner'] = int(fc['owner'])

        if count:
            out['adt'], out['adty'], out['adtSrc'] = count

        return out

    def report(self):
        self.roadlog.report()
        self.funcclass.report()
        self.aadt.report()
        self.hpms.report()
