# Washington Bike Safety Visualizer

A statewide bicycle-safety map for Washington State. It colors roads by how
stressful they are to ride, using WSDOT's Bicycle Level of Traffic Stress (BLTS)
data.

**Visualization only** — no routing, no route planning, no live network queries
at runtime. Everything renders from local static data files prepared ahead of
time. The whole runtime is a static file server handing out `index.html` +
`data/blts.geojson`.

> **Status: Phase 1 (WSDOT BLTS).** The architecture is built so a second,
> fully-local OpenStreetMap bike-infrastructure source can be added in Phase 2
> with its own toggle and scorer, flowing through the same scoring engine.

## Run it

Any static file server works — no build server, no tiling server:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/
```

## Features

- **MapLibre GL JS** map of Washington on a **CARTO Positron** raster basemap.
- Roads colored 1–4 (safest → avoid) plus "unknown", using the colorblind-safe
  **Okabe-Ito** palette.
- **Data-source toggle** (Phase 1 ships one: WSDOT BLTS).
- **Riding rules** — a control group that re-scores and re-colors the map
  **live, client-side, with no refetch**:
  - *Allow freeways* — whether limited-access highways are shown as rideable.
  - *Min shoulder width* — narrower shoulders get penalized.
  - *"Free" max speed* — at/below this, a road is comfortable regardless of shoulder.
  - *Upper max speed* — above this, high-stress unless the shoulder/facility is adequate.
  - *No upper limit* — disables the high-speed hard cap.
- Hover a segment for a **local readout** of its own properties (no lookups).

## Architecture

`app.js` is deliberately source-agnostic so Phase 2 slots in cleanly:

- **Sources** live in a registry (`SOURCES`). Each has its own toggle, layer,
  and **scorer**.
- A **scorer** maps a source's raw properties to *normalized* props:
  `baseScore`, `shoulder_width`, `maxspeed_num`, `prohibited`, `restricted`,
  `limited_access`, `good_facility`.
- **`effectiveLevel(normalized)`** is the single, source-agnostic function that
  reads normalized props + the current riding rules and returns the effective
  1–4 color level (0 = unknown). Re-scoring runs over cached features and
  updates the map source in place — instant, no network.

## Data (build-time)

`data/blts.geojson` is baked from WSDOT's export and committed. It is **not**
fetched at runtime. To regenerate it:

```bash
# 1. Download WSDOT's static bulk export (File Geodatabase, EPSG:2927)
curl -o data/BikePedLTS.zip \
  https://data.wsdot.wa.gov/geospatial/DOT_ActiveTransportation/BikePedLTS.zip
unzip -d data data/BikePedLTS.zip

# 2. Reproject to EPSG:4326 and emit compact GeoJSON (~55k line features)
pip install geopandas pyogrio pyproj shapely
python3 scripts/build_blts.py --src data/BikePedLTS.gdb --out data/blts.geojson
```

Source: WSDOT "Bicycle and Pedestrian Level of Traffic Stress (LTS)". The
`LTS_Bicycle` field (1–4) is WSDOT's authoritative rating; `999`/missing is
their no-data sentinel and renders gray. Limited-access segments
(`AccessControlTypeCode` F/M/P) drive the freeway toggle.

The raw `BikePedLTS.zip` / `.gdb` are git-ignored; only the derived
`blts.geojson` is committed.

## Vendored library

`vendor/maplibre-gl.{js,css}` is MapLibre GL JS v4.7.1, vendored locally so the
app is fully self-contained (the only third-party runtime request is the CARTO
basemap tiles).
