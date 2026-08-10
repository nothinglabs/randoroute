#!/usr/bin/env python3
"""
Build Oregon's agency inputs from ODOT's TransGIS data catalogue.

BUILD-TIME ONLY. The app makes no runtime calls to ODOT; it renders from the
static files this script produces.

Source: one MapServer with ~460 layers, all linear-referenced on the same
`LRM_KEY` + milepost scheme, which is what makes the joins below possible:

  https://gis.odot.state.or.us/arcgis1006/rest/services/facs_stip/data_catalog/MapServer

  390  Bicycle Level of Traffic Stress (BLTS)   81,210 segs  DERIVED ANALYSIS
  127  Shoulder Width and Type                  20,407 segs  INVENTORY
  158  Posted Speed                              2,532 segs  INVENTORY
  126  Number of Lanes                           6,036 segs  INVENTORY
  136  Bicycle Facilities                        6,955 segs  REGISTRY
  166  Signed Routes                             2,835 segs  REGISTRY
  175  OHP Expressways                              96 segs  REGISTRY
  171  Federal Functional Class - State          3,437 segs  REGISTRY
  173  Federal Functional Class - Non-State     83,114 segs  REGISTRY

WHY THE JOINS, AND NOT SIMPLY LAYER 390 (lesson A1).

Layer 390 is a derived product and it ships COPIES of its inputs: `ShldWid`,
`Speed`, `NumTotLns` and `BikeType` are the values ODOT's inventories held on
the day the analysis was built. A copy is indistinguishable from a second,
confirming source unless the layers are classified first. So the BLTS rating
itself -- `SegmentBLT`, which exists nowhere else -- is taken from 390, and
every other fact is read from the inventory or registry that owns it, joined
by linear reference. The script prints how far the copies have drifted, which
is the measurement that makes the rule worth its cost here rather than an
argument imported from another state.

THE LINEAR REFERENCE, and the one thing about it that is not obvious.

`LRM_KEY` is highway number (3) + highway suffix (2) + DIRECTION (1) + roadway
(2): `00100D00` is Highway 1 mainline, decreasing mileposts. ODOT books a
divided highway as separate increasing and decreasing keys, and an undivided
one usually as increasing only -- so a decreasing BLTS segment frequently has
no same-direction shoulder record and must read the increasing one. When it
does, the sides swap: the left side of a road measured up-milepost is the RIGHT
side of the rider coming down it. That is lesson B5 as it lands in Oregon --
the inventory is directional, and carrying the direction all the way through is
the difference between a rider's own shoulder and the one across the centre
line.

OUTPUT is deliberately spelled in the field names build_graph.py and
build_roads.py already read (`RouteIdentifier`, `LTS_Bicycle`, `ShoulderWidth`,
`SpeedLimit`, `BikeFacilityType`, ...). Those names look like WSDOT's because
Washington was the first state, but they are the BUILD CONTRACT, not a WSDOT
product: a state's job is to translate its agency's vocabulary into them.

`RouteIdentifier` is emitted as the SIGNED route number plus an `i`/`d`
direction letter -- "101i", not ODOT's internal "009". The conflation gate
relaxes its distance tolerance when the agency line and the OSM way share a
route number, and OSM tags Oregon highways `US 101`, never `Highway 9`. Without
layer 166's signed-route join, every state highway in Oregon would have had to
match at the strict ~9 m tolerance.

Usage:
  python3 scripts/build_odot.py                        # everything
  python3 scripts/build_odot.py --only funcclass       # one output
"""
import argparse
import collections
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import arcgis  # noqa: E402

BASE = ("https://gis.odot.state.or.us/arcgis1006/rest/services/"
        "facs_stip/data_catalog/MapServer")
CACHE = "data/.cache/odot"

# ODOT's bicycle facility vocabulary -> the words the build contract uses.
#
# 'Shoulder Bikeway' is deliberately NOT a facility. It is a designation over a
# shoulder, and the shoulder itself is already measured by layer 127 -- letting
# it score as bike infrastructure is lesson D1 exactly: a designation excusing
# the road under it. 58.8 miles of Washington's Olympic Discovery Trail run
# along US 101; Oregon's shoulder bikeways are the same claim.
FACILITY_TYPE = {
    "BL": "Bike Lane",
    "SL": "Shared Lane",
    # "SH": Shoulder Bikeway -- see above.
    # "NO": the row exists to record ABSENCE; importing it as a facility would
    #       be worse than having no row at all.
}
BLTS_BIKETYPE = {"Bike Lane": "BL", "Shared Lane": "SL",
                 "Shoulder Bikeway": "SH", "None": "NO"}

# FHWA roadway owner, from ODOT's JRSDCT string. Same codes HPMS uses.
OWNER_STATE, OWNER_COUNTY, OWNER_TOWN, OWNER_CITY = 1, 2, 3, 4


def lrm_base(key):
    """LRM_KEY without its direction letter, so I and D records can meet."""
    key = str(key or "")
    if len(key) < 6:
        return key
    return key[:5] + "?" + key[6:]


def lrm_dir(key):
    key = str(key or "")
    c = key[5:6].upper() if len(key) >= 6 else ""
    return {"I": "i", "D": "d"}.get(c)


def mp_span(a):
    lo, hi = arcgis.num(a.get("BEGMP")), arcgis.num(a.get("ENDMP"))
    if lo is None or hi is None:
        return None
    return (min(lo, hi), max(lo, hi))


class SpanTable:
    """Linear-referenced records, queryable by (lrm base, milepost span).

    Every ODOT roadway layer is a run of short consecutive records against the
    same reference, so a join is 'which records overlap this span', and the
    winner is the one overlapping most of it.
    """

    def __init__(self, label):
        self.label = label
        self.by_base = collections.defaultdict(list)
        self.n = 0

    def add(self, key, span, value):
        self.by_base[lrm_base(key)].append((span[0], span[1], lrm_dir(key), value))
        self.n += 1

    def best(self, key, span):
        """-> (value, record_direction) with the largest overlap, or (None, None)."""
        rows = self.by_base.get(lrm_base(key))
        if not rows:
            return None, None
        lo, hi = span
        best, best_ov = None, 0.0
        for rlo, rhi, rdir, value in rows:
            ov = min(hi, rhi) - max(lo, rlo)
            if ov > best_ov or (best is None and ov >= 0 and hi == lo):
                best, best_ov = (value, rdir), max(ov, 0.0)
        return best if best else (None, None)


def fetch(layer, fields, label, geometry=True, where="1=1"):
    return list(arcgis.fetch_all(f"{BASE}/{layer}", fields, where=where,
                                 cache_dir=f"{CACHE}/{layer}", page=1000,
                                 order_by="OBJECTID", geometry=geometry,
                                 label=label))


# ------------------------------------------------------------------ tables
def shoulder_table():
    table = SpanTable("shoulder")
    for f in fetch(127, ["OBJECTID", "LRM_KEY", "BEGMP", "ENDMP",
                         "LS_PVMT_WD", "RS_PVMT_WD", "LS_CD_DESC", "RS_CD_DESC"],
                   "ODOT shoulder width and type", geometry=False):
        a = f["attributes"]
        span = mp_span(a)
        if not span:
            continue
        table.add(a.get("LRM_KEY"), span, {
            "ls": arcgis.num(a.get("LS_PVMT_WD")),
            "rs": arcgis.num(a.get("RS_PVMT_WD")),
        })
    return table


def simple_table(layer, field, label, cast=float):
    table = SpanTable(label)
    for f in fetch(layer, ["OBJECTID", "LRM_KEY", "BEGMP", "ENDMP", field],
                   label, geometry=False):
        a = f["attributes"]
        span = mp_span(a)
        value = arcgis.num(a.get(field))
        if not span or value is None:
            continue
        table.add(a.get("LRM_KEY"), span, cast(value))
    return table


def facility_table():
    table = SpanTable("facility")
    for f in fetch(136, ["OBJECTID", "LRM_KEY", "BEGMP", "ENDMP", "TYP_CD",
                         "ROADSIDE", "WD_MEAS", "INSP_YR"],
                   "ODOT bicycle facilities", geometry=False):
        a = f["attributes"]
        span = mp_span(a)
        if not span:
            continue
        table.add(a.get("LRM_KEY"), span, {
            "code": arcgis.text(a.get("TYP_CD")),
            "side": arcgis.text(a.get("ROADSIDE")),
            "width": arcgis.num(a.get("WD_MEAS")),
        })
    return table


def signed_route_table():
    """LRM span -> the number a rider (and OSM) would call this road."""
    table = SpanTable("signed route")
    for f in fetch(166, ["OBJECTID", "LRM_KEY", "BEGMP", "ENDMP",
                         "I_SIGN", "US_SIGN_1", "US_SIGN_2", "OR_SIGN_1", "OR_SIGN_2"],
                   "ODOT signed routes", geometry=False):
        a = f["attributes"]
        span = mp_span(a)
        if not span:
            continue
        # An Interstate number first, then US, then state: that is the order a
        # way's OSM `ref` puts them in when a road carries more than one.
        for field in ("I_SIGN", "US_SIGN_1", "US_SIGN_2", "OR_SIGN_1", "OR_SIGN_2"):
            value = arcgis.text(a.get(field))
            if value and value.strip().rstrip("WEBNS").isdigit():
                table.add(a.get("LRM_KEY"), span, int(value.strip().rstrip("WEBNS")))
                break
            if value and value.strip().isdigit():
                table.add(a.get("LRM_KEY"), span, int(value.strip()))
                break
    return table


def expressway_table():
    table = SpanTable("expressway")
    for f in fetch(175, ["OBJECTID", "LRM_KEY", "BEGMP", "ENDMP"],
                   "ODOT OHP expressways", geometry=False):
        a = f["attributes"]
        span = mp_span(a)
        if span:
            table.add(a.get("LRM_KEY"), span, 1)
    return table


# ----------------------------------------------------------------- outputs
def build_blts(out_path):
    """maps/oregon/blts.geojson -- the state-highway conflation source."""
    shoulders = shoulder_table()
    speeds = simple_table(158, "SPEED", "ODOT posted speed", int)
    lanes = simple_table(126, "NO_LANES", "ODOT number of lanes", int)
    facilities = facility_table()
    signed = signed_route_table()
    expressways = expressway_table()

    features = []
    drift = {"shoulder_n": 0, "shoulder_diff": 0, "speed_n": 0, "speed_diff": 0,
             "facility_n": 0, "facility_diff": 0}
    stats = collections.Counter()
    for f in fetch(390, ["OBJECTID", "LRM_KEY", "BEGMP", "ENDMP", "SegmentBLT",
                         "ShldWid", "Speed", "NumTotLns", "BikeType", "HWYNAME",
                         "FuncClass", "RurUrb", "AADTbyDir"],
                   "ODOT bicycle level of traffic stress"):
        a = f["attributes"]
        span = mp_span(a)
        paths = arcgis.paths_of(f.get("geometry"))
        if not span or not paths:
            continue
        key = a.get("LRM_KEY")
        direction = lrm_dir(key)

        lts = str(a.get("SegmentBLT") or "")
        lts = int(lts[-1]) if lts[-1:].isdigit() else None

        # ---- shoulder, from the inventory, on the rider's own side.
        sh_rec, sh_dir = shoulders.best(key, span)
        shoulder = None
        if sh_rec:
            same = (sh_dir == direction) or sh_dir is None or direction is None
            shoulder = sh_rec["rs"] if same else sh_rec["ls"]
            stats["shoulder_same_dir" if same else "shoulder_flipped"] += 1
            copy = arcgis.num(a.get("ShldWid"))
            if copy is not None and shoulder is not None:
                drift["shoulder_n"] += 1
                drift["shoulder_diff"] += 1 if abs(copy - shoulder) >= 1 else 0

        # ---- posted speed, from the inventory.
        speed, _ = speeds.best(key, span)
        copy = arcgis.num(a.get("Speed"))
        if speed is not None and copy is not None:
            drift["speed_n"] += 1
            drift["speed_diff"] += 1 if abs(copy - speed) >= 5 else 0

        lane_count, _ = lanes.best(key, span)
        if lane_count is None:
            lane_count = arcgis.num(a.get("NumTotLns"))
            stats["lanes_from_blts_copy"] += 1

        # ---- facility, from the registry.
        fac_rec, _ = facilities.best(key, span)
        facility = FACILITY_TYPE.get(fac_rec["code"]) if fac_rec else None
        copy = BLTS_BIKETYPE.get(str(a.get("BikeType") or "").strip())
        if fac_rec and copy:
            drift["facility_n"] += 1
            drift["facility_diff"] += 1 if copy != fac_rec["code"] else 0

        route, _ = signed.best(key, span)
        express, _ = expressways.best(key, span)

        props = {
            # Signed number + direction letter: see the module docstring.
            "RouteIdentifier": (f"{route}{direction or ''}" if route
                                else f"{str(key)[:3]}{direction or ''}"),
            "LTS_Bicycle": lts,
            "ShoulderWidth": shoulder,
            "SpeedLimit": speed,
            "LaneCount": int(lane_count) if lane_count else None,
            "BikeFacilityType": facility,
            "LimitedAccess": 1 if express else 0,
            # ODOT publishes no bicycle-prohibition layer. Oregon's freeway
            # bans live in OAR 734-020-0045 as prose, and in OSM as
            # `bicycle=no`, which build_graph.py already honours. Emitting 0
            # here is a statement that this source has nothing to say, not that
            # every state highway is open.
            "Prohibited": 0,
            "Urban": 1 if str(a.get("RurUrb") or "") == "Urban" else 0,
            "HighwayName": arcgis.text(a.get("HWYNAME")),
        }
        stats["segments"] += 1
        stats["with_lts"] += 1 if lts else 0
        stats["with_shoulder"] += 1 if shoulder is not None else 0
        stats["with_speed"] += 1 if speed is not None else 0
        stats["with_facility"] += 1 if facility else 0
        stats["with_signed_route"] += 1 if route else 0
        for path in paths:
            features.append({"type": "Feature", "properties": props,
                             "geometry": {"type": "LineString", "coordinates": path}})

    write(out_path, features)
    print(f"\n  BLTS segments        {stats['segments']:,}")
    print(f"  with an LTS rating   {stats['with_lts']:,}")
    print(f"  with a shoulder      {stats['with_shoulder']:,} "
          f"({stats['shoulder_same_dir']:,} same-direction, "
          f"{stats['shoulder_flipped']:,} read across the centre line)")
    print(f"  with a posted speed  {stats['with_speed']:,}")
    print(f"  with a facility      {stats['with_facility']:,}")
    print(f"  with a signed route  {stats['with_signed_route']:,}")
    print("\n  How far the derived layer's COPIES have drifted from the "
          "inventories (lesson A1):")
    for name, tol in (("shoulder", "1 ft"), ("speed", "5 mph"), ("facility", "type")):
        n, diff = drift[f"{name}_n"], drift[f"{name}_diff"]
        pct = (100.0 * diff / n) if n else 0.0
        print(f"    {name:9} {diff:,} of {n:,} disagree by more than {tol} ({pct:.1f}%)")


def build_speeds(out_path):
    features = []
    signed = signed_route_table()
    for f in fetch(158, ["OBJECTID", "LRM_KEY", "BEGMP", "ENDMP", "SPEED"],
                   "ODOT posted speed"):
        a = f["attributes"]
        span, paths = mp_span(a), arcgis.paths_of(f.get("geometry"))
        speed = arcgis.num(a.get("SPEED"))
        if not span or not paths or not speed or speed <= 0:
            continue
        key = a.get("LRM_KEY")
        route, _ = signed.best(key, span)
        props = {"SpeedLimit": int(speed),
                 "RouteIdentifier": (f"{route}{lrm_dir(key) or ''}" if route
                                     else f"{str(key)[:3]}{lrm_dir(key) or ''}")}
        for path in paths:
            features.append({"type": "Feature", "properties": props,
                             "geometry": {"type": "LineString", "coordinates": path}})
    write(out_path, features)


def build_facilities(out_path):
    features = []
    signed = signed_route_table()
    kept = collections.Counter()
    for f in fetch(136, ["OBJECTID", "LRM_KEY", "BEGMP", "ENDMP", "TYP_CD",
                         "ROADSIDE", "WD_MEAS"],
                   "ODOT bicycle facilities"):
        a = f["attributes"]
        span, paths = mp_span(a), arcgis.paths_of(f.get("geometry"))
        code = arcgis.text(a.get("TYP_CD"))
        kept[code] += 1
        facility = FACILITY_TYPE.get(code)
        if not span or not paths or not facility:
            continue
        key = a.get("LRM_KEY")
        route, _ = signed.best(key, span)
        width = arcgis.num(a.get("WD_MEAS"))
        props = {
            "BikeFacilityType": facility,
            # The contract's gate: only an EXISTING facility scores. ODOT's
            # inventory is of what is on the ground, so every row qualifies --
            # except the 'NO' rows, which record absence and are dropped above.
            "Status": "Existing",
            "RouteIdentifier": (f"{route}{lrm_dir(key) or ''}" if route
                                else f"{str(key)[:3]}{lrm_dir(key) or ''}"),
            "BikeFacilitySides": arcgis.text(a.get("ROADSIDE")),
        }
        if width and width > 0:
            props["BikeFacilityWidthFt"] = round(float(width), 1)
        for path in paths:
            features.append({"type": "Feature", "properties": props,
                             "geometry": {"type": "LineString", "coordinates": path}})
    write(out_path, features)
    print(f"  rows by ODOT code: {dict(kept)}")
    print("  'SH' (shoulder bikeway) and 'NO' (none) are deliberately dropped: "
          "a designation over a shoulder is not bike infrastructure (lesson D1), "
          "and a row recording absence is not a facility.")


def owner_of(jurisdiction):
    text = str(jurisdiction or "").upper()
    if text.startswith("STATE") or "OREGON DEPT" in text or text.startswith("ODOT"):
        return OWNER_STATE
    if text.startswith("COUNTY"):
        return OWNER_COUNTY
    if text.startswith("CITY"):
        return OWNER_CITY
    return None


def build_funcclass(out_path):
    features = []
    stats = collections.Counter()
    for layer, label, jurisdiction_field in (
            (171, "ODOT federal functional class (state)", None),
            (173, "ODOT federal functional class (non-state)", "JRSDCT")):
        fields = ["OBJECTID", "BEGMP", "ENDMP", "NEW_FC_CD", "NEW_FC_TYP", "URBAN"]
        if jurisdiction_field:
            fields.append(jurisdiction_field)
        for f in fetch(layer, fields, label):
            a = f["attributes"]
            paths = arcgis.paths_of(f.get("geometry"))
            if not paths:
                continue
            fc = arcgis.num(a.get("NEW_FC_CD"))
            fc = int(fc) if fc and 1 <= fc <= 7 else None
            if not fc:
                stats["no class"] += 1
                continue
            owner = (OWNER_STATE if jurisdiction_field is None
                     else owner_of(a.get(jurisdiction_field)))
            props = {"fc": fc}
            if owner:
                props["owner"] = owner
            stats[f"fc{fc}"] += 1
            for path in paths:
                features.append({"type": "Feature", "properties": props,
                                 "geometry": {"type": "LineString", "coordinates": path}})
    write(out_path, features)
    print("  by FHWA class: " + ", ".join(
        f"{k}={stats[k]:,}" for k in sorted(stats) if k.startswith("fc")))


def write(path, features):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w") as fh:
        json.dump({"type": "FeatureCollection", "features": features}, fh,
                  separators=(",", ":"))
    size = os.path.getsize(path) / 1024 / 1024
    print(f"  -> {path}  {len(features):,} features, {size:.1f} MiB")


OUTPUTS = {
    "blts": ("maps/oregon/blts.geojson", build_blts),
    "speeds": ("data/odot_legal_speeds.geojson", build_speeds),
    "facilities": ("data/odot_bike_facilities.geojson", build_facilities),
    "funcclass": ("data/funcclass-oregon.geojson", build_funcclass),
}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", choices=sorted(OUTPUTS), action="append")
    args = ap.parse_args()
    for name in (args.only or sorted(OUTPUTS)):
        path, builder = OUTPUTS[name]
        print(f"\n=== {name} -> {path}")
        builder(path)


if __name__ == "__main__":
    main()
