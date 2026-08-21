#!/usr/bin/env python3
"""
Southern Nevada's bicycle facility registry -> the shared builder vocabulary.

BUILD-TIME ONLY. Writes maps/nevada/rtcsnv_facilities.geojson.

WHY A REGIONAL AGENCY AND NOT THE DOT
-------------------------------------
Nevada's DOT publishes no bicycle facility inventory at all -- its 83-layer
asset system (see build_ndot.py) has shoulders, speeds, lanes and counts and
nothing about bicycles. The registry that exists is the Regional Transportation
Commission of Southern Nevada's, covering Clark County: the Las Vegas valley,
Henderson, North Las Vegas, Boulder City and Mesquite -- about three quarters
of the state's population and effectively all of its urban riding.

That makes it a **registry** in the porting method's taxonomy: the maintained
system of record for one asset class, trusted for that asset class and nothing
else. It is field-collected (rows carry `coll_date`, `begin_lat`/`end_lat` and
a Mandli session id), and RTC publishes its planned network as a separate
Regional Transportation Plan item, so these three layers are existing
facilities.

  https://webgis.rtcsnv.com/arcgis/rest/services/Web/HUB/FeatureServer
    8  Enhanced Bicycle Lane   4,936 records
    9  Bicycle Lane           20,541 records
    10 Shared-Use Path         1,738 records

WHAT IS DELIBERATELY NOT DONE
-----------------------------
* `RouteIdentifier` is left unset. The shared matcher relaxes its distance
  tolerance from ~9 m to ~30 m when the source and the OSM way share a route
  NUMBER, and RTC's `route` column holds NDOT's internal linear-reference keys
  ("119CL+"), not signed route numbers. Handing those to the matcher would
  relax the tolerance against unrelated numbers. The cost is real -- a bike
  lane collected at the kerb of a six-lane arterial can sit farther from the
  OSM centreline than the strict tolerance allows -- and the match rate is
  reported in STATUS.md rather than bought with a wrong key.
* "Enhanced Bicycle Lane" becomes a **buffered** lane, not a separated one.
  RTC's own definition covers buffered and protected lanes together and the
  `protection` column is empty on every row, so the class that cannot overstate
  the facility is the one to use.
* Nothing here may excuse a road. A facility level changes routing preference
  and the card; the shoulder, speed and traffic rules still decide the verdict.

Usage:
  python3 maps/nevada/tools/build_rtcsnv.py
"""
import argparse
import json
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                '..', '..', '..', 'scripts'))
import arcgis  # noqa: E402

HUB = "https://webgis.rtcsnv.com/arcgis/rest/services/Web/HUB/FeatureServer"

# RTC layer -> the facility vocabulary build_graph.WSDOT_FACILITY_TYPE reads.
# Those names look like WSDOT's because Washington was imported first; they are
# the build contract, and an adapter's job is to translate into them.
LAYERS = {
    10: "Shared-Use Path",
    9: "Bike Lane",
    8: "Buffered Bike Lane",
}

FIELDS = ["OBJECTID", "NAME", "TYPE", "JURISDICTION", "BIKE_WIDTH",
          "BUFF_WIDTH", "coll_date"]


def build(out_path, cache_dir):
    features = []
    counts = Counter()
    for layer_id, facility in LAYERS.items():
        url = f"{HUB}/{layer_id}"
        for f in arcgis.fetch_all(url, FIELDS, cache_dir=cache_dir,
                                  label=f"RTC {facility}"):
            a = f.get("attributes") or {}
            paths = arcgis.paths_of(f.get("geometry"))
            if not paths:
                continue
            props = {
                "BikeFacilityType": facility,
                # load_official_index() requires this exactly; RTC's HUB layers
                # are its existing inventory, with planned mileage published
                # separately as the Regional Transportation Plan network.
                "Status": "Existing",
            }
            name = arcgis.text(a.get("NAME"))
            if name:
                props["StreetName"] = name
            buffer_ft = arcgis.num(a.get("BUFF_WIDTH"))
            if buffer_ft and buffer_ft > 0:
                props["BikeFacilityBufferWidth"] = round(float(buffer_ft), 1)
            collected = arcgis.text(a.get("coll_date"))
            if collected:
                props["Collected"] = collected
            for ring in paths:
                counts[facility] += 1
                features.append({
                    "type": "Feature",
                    "properties": props,
                    "geometry": {"type": "LineString", "coordinates": ring},
                })
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w") as fh:
        json.dump({"type": "FeatureCollection", "features": features}, fh)
    print(f"wrote {out_path}: {len(features):,} line parts", flush=True)
    for facility, n in counts.most_common():
        print(f"  {facility}: {n:,}", flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default="maps/nevada/rtcsnv_facilities.geojson")
    ap.add_argument("--cache", default="data/.cache/nevada-rtcsnv")
    args = ap.parse_args()
    build(args.out, args.cache)
