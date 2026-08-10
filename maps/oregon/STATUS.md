# Oregon — readiness 2/10

`status: preview`. A first import, deliberately incomplete. It exists so the
multi-state machinery has a second state to be exercised against, and so the
work still to do is visible rather than hypothetical.

Selecting Oregon on the Maps screen loads real Oregon data. It will not plan a
route, and it says so.

## What works

| | |
| --- | --- |
| Basemap | Yes — land, water, green space, place labels, OSM coastline |
| Place search | Yes — 1,461 settlements and ferry terminals, offline |
| Map opens on | Portland (−122.6765, 45.5231) |
| Coverage box | −124.7…−116.4 lon, 41.9…46.3 lat |

## What does not

| | Why |
| --- | --- |
| Routing | No `graph2.bin.gz`. The app reports this instead of retrying a 404. |
| Street map | No `roads.pmtiles` — no street geometry, names, speeds or shoulders |
| Traffic stress | No ODOT stress data imported |
| Legal speeds | No ODOT speed data imported |
| Shoulders | Nothing |
| Bike facilities | Nothing |
| Prohibitions | Nothing |
| Designated routes | Nothing |
| Turn navigation | Depends on routing |

The `region.json` names ODOT as the stress, restriction and speed agency, and
lists Oregon's Interstate route prefixes. Those values are **written but not
exercised** — no ODOT data has been conflated, so nothing reads them yet. They
are a starting point for whoever finishes the import, not a claim.

`facilityLevels` and `routeDirectionSuffixes` are empty. Oregon's route ids do
not carry WSDOT's `i`/`d` milepost-direction suffix, and the region falls back
correctly: `routeBase` returns the id unchanged and `routeDirection` returns
null, so a card omits the direction rather than inventing one.

## To finish the import

Roughly in order, and roughly in the order Washington was built:

1. **`roads.pmtiles`** — `build_roads.py` over the Oregon extract. It currently
   takes WSDOT-shaped inputs (`--blts`, `--roadlog`, `--funcclass`, `--aadt`)
   for its enrichment; all of them are optional, so a first pass produces
   OSM-only street tiles with class-estimated speeds.
2. **`graph2.bin.gz`** — `build_graph.py` over the same extract, plus a DEM for
   Oregon (`fetch_dem.sh` is hardcoded to Washington's tile range and needs a
   bounding box argument).
3. **`bikeroutes.geojson`** and the small overlays — `build_routes.py` works on
   any extract, unchanged.
4. **ODOT data** — the real work. Oregon publishes bicycle facility inventories
   and roadway characteristics through its own ArcGIS services; a
   `fetch_odot_graph_data.py` alongside `fetch_wsdot_graph_data.py` is the
   shape of it. Until then `stressAgency` and friends are just labels.

Nothing on that list requires a change to application code. Build the files,
flip the flags in `datasets`, run `npm run maps:registry`.

## Caveat

Not ridden. Not checked against the ground in any way. The basemap is a
mechanical build from the Geofabrik extract and has been eyeballed only for the
coastline coming out the right way round.
