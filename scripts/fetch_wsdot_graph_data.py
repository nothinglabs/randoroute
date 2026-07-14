#!/usr/bin/env python3
"""Download the official WSDOT inputs used to enrich the routing graph.

The files are build-time inputs and are intentionally git-ignored.  ArcGIS
returns WGS84 GeoJSON so build_graph.py can conflate the linework directly
with OSM without an extra GIS conversion step.
"""

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen


FACILITIES_URL = (
    "https://data.wsdot.wa.gov/arcgis/rest/services/Shared/"
    "ActiveTransportationData/FeatureServer/6/query"
)
LEGAL_SPEEDS_URL = (
    "https://data.wsdot.wa.gov/arcgis/rest/services/Shared/"
    "RoadwayCharacteristicData/FeatureServer/4/query"
)


def download(url, where, fields, output):
    features = []
    offset = 0
    while True:
        params = {
            "where": where,
            "outFields": ",".join(["OBJECTID", *fields]),
            "returnGeometry": "true",
            "outSR": "4326",
            "orderByFields": "OBJECTID",
            "resultOffset": str(offset),
            "resultRecordCount": "1000",
            "f": "geojson",
        }
        request_url = f"{url}?{urlencode(params)}"
        request = Request(request_url, headers={"User-Agent": "wa-bike-safety-build/1"})
        with urlopen(request, timeout=120) as response:
            page = json.load(response)
        if "error" in page:
            raise RuntimeError(page["error"])
        batch = page.get("features", [])
        features.extend(batch)
        offset += len(batch)
        if not page.get("exceededTransferLimit"):
            break
        if not batch:
            raise RuntimeError("WSDOT pagination stopped before the final page")
    data = {
        "type": "FeatureCollection",
        "features": features,
        "source": url.rsplit("/query", 1)[0],
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(data, separators=(",", ":")))
    print(f"wrote {output}: {len(features):,} features")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--facilities-out", default="data/wsdot_bike_facilities.geojson")
    parser.add_argument("--speeds-out", default="data/wsdot_legal_speeds.geojson")
    args = parser.parse_args()
    download(
        FACILITIES_URL,
        "Status='Existing'",
        [
            "RouteIdentifier", "RoadName", "Status", "BikeFacilityType",
            "BikeFacilityWidth", "BikeFacilityBufferWidth",
            "BikeFacilitySeparationMaterial", "BikeFacilitySides", "SnapshotDate",
        ],
        args.facilities_out,
    )
    download(
        LEGAL_SPEEDS_URL,
        "SpeedLimit > 0",
        ["RouteIdentifier", "SpeedLimit", "SnapshotDate"],
        args.speeds_out,
    )


if __name__ == "__main__":
    main()
