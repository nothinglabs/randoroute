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

## Findings and blockers

This section will record any documentation defect, source mismatch, or build
blocker discovered during the import. The first census pass found no need for
shared application-code changes.
