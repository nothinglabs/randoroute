# Oregon import status

Status: preview. This file is the running record of the import; the readiness
number in `region.json` is updated only when its rubric gate is met.

## Source census — completed before any build

Census date: 2026-08-15. ArcGIS layer metadata was read from each URL's
`?f=pjson` response. A claimed source is one this import will fetch and
translate into the shared builder vocabulary. A parked source was inspected
and rejected for the field-level reason shown; geometry type alone is never the
reason (lesson A9).

| Signal | Verdict | Source and field-level finding |
| --- | --- | --- |
| Bicycle stress rating | **claimed** | ODOT **Bicycle Level of Traffic Stress (BLTS)**, [MapServer 390](https://gis.odot.state.or.us/arcgis1006/rest/services/facs_stip/data_catalog/MapServer/390). Derived analysis; `LRM_KEY`, `BEGMP`, `ENDMP`, `SegmentBLT`, `EFFECTV_DT`; the rating is display/context only and does not independently pass or fail a road. |
| Shoulder width (per side) | **claimed** | ODOT **Shoulder Width and Type**, [MapServer 127](https://gis.odot.state.or.us/arcgis1006/rest/services/facs_stip/data_catalog/MapServer/127). Inventory fields include `LRM_KEY`, `BEGMP`, `ENDMP`, `LS_PVMT_WD`, `LS_GRAV_WD`, `RS_PVMT_WD`, `RS_GRAV_WD`, and effective/process dates. Directional side handling is required. |
| Posted / legal speed | **claimed** | ODOT **Posted Speed**, [MapServer 158](https://gis.odot.state.or.us/arcgis1006/rest/services/facs_stip/data_catalog/MapServer/158). `LRM_KEY`, `BEGMP`, `ENDMP`, `SPEED`, `EFFECTV_DT`; legal speed on state-route sections. |
| Bike facility inventory | **claimed** | ODOT **Bicycle Facilities**, [MapServer 136](https://gis.odot.state.or.us/arcgis1006/rest/services/facs_stip/data_catalog/MapServer/136). Registry fields include `LRM_KEY`, `BEGMP`, `ENDMP`, `ROADSIDE`, `TYP_CD`, `WD_MEAS`, `COND_CD`, `NEED_IND`, `INSP_YR`, `NOTE`, and dates. Planned/needed-only records will not be treated as existing facilities. |
| Official bicycle prohibitions | **absent** | Searched ODOT's data catalogue and Oregon's bicycle-prohibition rules, including [OAR 734-020-0045](https://secure.sos.state.or.us/oard/viewSingleRule.action?ruleVrsnRsn=285158). No statewide prohibition line inventory was found. OSM's explicit `bicycle=no` remains the available prohibition signal; no agency restriction dataset is claimed. |
| Traffic volume **and year** | **claimed** | Two sources were inspected. Minimum coverage is [FHWA HPMS Oregon 2018](https://geo.dot.gov/server/rest/services/Hosted/Oregon_2018_PR/FeatureServer/0), line sections with `aadt`, `year_record`, `f_system`, and ownership fields. ODOT's current **state** AADT, [MapServer 155](https://gis.odot.state.or.us/arcgis1006/rest/services/facs_stip/data_catalog/MapServer/155), is also in scope: despite point display geometry, each record has `LRM_KEY`, `BEGMP`, `ENDMP`, `AADT`, and `EFFECTV_DT`, so it is section data under lesson A9. The ODOT **non-state** AADT layer, MapServer 156, is parked because its field list has only one `MP` plus `STREETNAME`, `LOCATION`, `SITE_ID`, and count fields—no route span to conflate. |
| Functional class / road owner | **claimed** | ODOT **Federal Functional Class - Non-State**, [MapServer 173](https://gis.odot.state.or.us/arcgis1006/rest/services/facs_stip/data_catalog/MapServer/173). `LRM_KEY`, `NEW_FC_CD`, `NEW_FC_TYP`, `FC_CD`, `JRSDCT`, and `EFFECTV_DT`; proposed/unknown codes will be dropped rather than guessed. |
| County road inventory | **absent** | Searched ODOT's data catalogue and the statewide road-inventory/certification sources described in the porting method. Oregon publishes no statewide county road-log equivalent carrying edge space, surface, or a complete county inventory; no substitute is claimed. This leaves shoulder inference with no Oregon input (lesson D7). |
| Long-term closures | **claimed — hand-maintained** | No statewide machine-readable closure layer is required for this stage. The shipped `route_closures.geojson` is the project's explicit, hand-maintained source and will contain only documented long-term closures, with an empty collection if none is known at build time. |

## Nominated verification corridors

These were chosen before any Oregon extract, agency data, tiles, or graph was
built. They cover the Columbia Gorge pinch point, the coast, the Willamette
Valley, Central Oregon, and southern Oregon. The Columbia corridor has both a
long end-to-end route and a short trail hop because lesson C2 says a long
detour can hide a local severance.

See `corridors.json` for the machine-checked endpoints.

## Current state of the import

- No Oregon build artefacts existed when the census and corridors were written.
- The intended ceiling is readiness 7, shipped as `"status": "preview"`.
- ODOT's current state-system AADT is in scope; non-state point AADT is a
  documented backlog, not silently treated as line coverage.
- No application code or another state's data may be changed for this import.

## Agency data stage

Completed 2026-08-15 from cached public ArcGIS pages:

- ODOT BLTS: 81,210 normalized segments; 49,975 received a shoulder value
  from the owning Shoulder Width and Type inventory. The normalized BLTS file
  carries the derived `LTS_Bicycle` rating, not the BLTS copies of speed,
  lane-count, or facility fields.
- ODOT shoulder inventory: 20,407 records. Directional side fallback is
  applied when an opposite-direction record is the only span available.
- ODOT Posted Speed: 2,532 source records, 2,549 line parts.
- ODOT Bicycle Facilities: 1,800 `BL` and 266 `SL` records, 2,091 line
  parts. `SH` (shoulder bikeway) and `NO` (no facility) were excluded.
- ODOT Federal Functional Class: 83,112 usable line features after dropping
  unknown/proposed class codes; 30,677 county-owned and 39,817 city-owned
  features have a recognized owner code.
- ODOT current state AADT: 6,544 route sections became 43,655 line parts by
  projecting each milepost span onto the matching ODOT route linework; all
  carry effective year 2024.
- FHWA HPMS Oregon 2018: 67,861 counted rows, 71,826 line parts, with the
  section record year carried as 2018 where present.

The source pages are cached under `data/.cache/` for rebuilds; normalized
inputs are committed in this folder as `.gz` source artefacts. The plain
GeoJSON expansion is a local build intermediate: `BUILD.md` will explicitly
inflate it before invoking builders whose current readers require plain JSON.
The built registry counts are now `blts: 81,210`, `bikeinfra: 37,418` after
the shared sharrow-only filter, and `roads: 215,485`.

## Portability finding

The shared state-highway candidate gate currently recognizes `I`, `US`, `SR`,
and `WA` route prefixes, but not Oregon's `OR` prefix. Official speed and
facility matching is independent of that gate; BLTS-derived stress and
shoulder matching use it for non-trunk state highways. This is a shared-code
portability bug, not an Oregon data fact, so it is recorded here and is not
being fixed within this import's allowed blast radius. The graph build reports
102,917 ODOT-conflated edges; the exact effect of the prefix gate is therefore
visible in that total but is not silently corrected in application code.

## Findings and blockers

This section will record any documentation defect, source mismatch, or build
blocker discovered during the import. The first census pass found no need for
shared application-code changes.

## Built artefacts and verification

Completed 2026-08-16:

- OSM extract: Oregon latest Geofabrik PBF; 309,278 graph-eligible ways kept.
- bikeinfra.geojson.gz: 37,418 retained overlay features after dropping 2,113
  sharrow-only ways in the shared overlay builder.
- bikeroutes.geojson.gz: 41 reconciled named routes: the OSM catalogue plus all
  18 reviewed Oregon Scenic Bikeways (9 matched to OSM counterparts and 9
  official-only). Ten source route-closure groups remain in
  route_closures.geojson.gz.
- roads.pmtiles: 215,485 street features from two road GeoJSON build parts.
- basemap.pmtiles: 39.4 MiB; overlays.pmtiles: 14.2 MiB.
- graph2.bin.gz: 631,212 nodes, 730,560 edges, 104,771 official-speed
  edges, 11,368 official-facility edges, 18,210 MTB-tagged edges, and 19,370
  densified dedicated-path edges.
- region.json remains "status": "preview" and now records readiness 7,
  after the gates below pass.

The required corridor-severance test passes all five Oregon corridors and the
existing Washington and prior-state corridors. The broad verification report
is in VERIFICATION.md; it covers 30 Oregon published route relations across
the Gorge, coast, Willamette Valley, southern, Central, and eastern regions.
The wider HCRH trail-to-Hood-River probe found an OSM route-relation gap, which
is retained as an explicit source finding rather than hidden by changing the
graph or app.

Coverage measurement from the shipped graph, using
measure_coverage.py --add maps/oregon/hpms.geojson --label HPMS:

- 74,503 road miles excluding paths and ferries.
- 18,979 miles with a traffic count (25.5%).
- 0 miles with county-derived bail-out space (0.0%), because Oregon has no
  county road-log source; this metric does not count the separate ODOT state
  shoulder inventory. The adapter matched shoulder values to 49,975 of 81,210
  BLTS sections and carries the directional values into the graph where the
  shared route gate matches.
- Traffic-count coverage by functional class: Interstate 100.0%, principal
  arterial 95.4%, minor arterial 90.9%, major collector 62.6%, minor collector
  2.6%, local street 0.2%.

The level-4/5/6/7 checks are green: agency speeds/facilities, HPMS traffic,
the verification report, ODOT stress/speed/facility/shoulder inputs, and
multi-region corridor coverage are all present. No field ride was performed,
so readiness 8 is not claimed.

## Documentation and source findings

- The porting guide's statement that build_routes.py emits only the route
  overlay is incomplete for this state: the build also emits the route-closure
  collection used by the state pack. The exact command and outputs are now
  recorded in BUILD.md.
- The shared road builder's help text still calls its agency inputs WSDOT
  inputs, but the Oregon adapter correctly supplies the generic field contract;
  no shared-code edit was needed.
- The OSM HCRH bicycle relation gap is a source-data issue requiring ODOT/OSM
  or field confirmation. It is not patched with synthetic geometry.
