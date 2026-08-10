# Washington — readiness 8/10

`status: released`. This is the state the app was built around, and the only
one that has been ridden with.

## What works

| | |
| --- | --- |
| Routing | Yes — 1,167,067 nodes / 2,529,517 arcs, elevation-aware, ferries included |
| Street map | Yes — `roads.pmtiles`, ~339k ways with names, speeds and shoulders |
| Basemap | Yes — land, water, green space, place labels, detailed OSM coastline |
| Traffic stress | Yes — WSDOT BLTS 1–4 on state highways (~55k segments) |
| Legal speeds | Yes — WSDOT Roadway Characteristic Data on state routes; class estimates elsewhere |
| Shoulders | Yes — WSDOT inventory on state routes (both directions), OSM tags elsewhere |
| Bike facilities | Yes — WSDOT Active Transportation Data plus OSM |
| Prohibitions | Yes — WSDOT Permanent Bike Restrictions, excluded from the graph outright |
| Traffic volume | Yes — WSDOT AADT on state routes, FHWA HPMS elsewhere |
| Designated routes | Yes — 114 USBR/regional relations from OSM |
| Place search | Yes — 2,602 settlements and ferry terminals, offline |
| Turn navigation | Yes |

## Why 8 and not 10

1. **Off-state-highway stress is inferred, not measured.** WSDOT publishes BLTS
   for state routes only. Everywhere else — which is most of where people ride
   — the rating comes from the app's own model over OSM class, speed, shoulder
   and volume. It is a good model; it is not a survey.
2. **Shoulder data is thin off the state system.** The WSDOT inventory stops at
   state routes. County and city roads have only whatever OSM carries, which is
   sparse, and a missing shoulder tag is not the same as no shoulder. This is
   the single largest gap and is tracked as an open issue.
3. **Speed limits are estimated on most roads.** Class-based defaults
   (residential → 25 mph) are flagged `e=1` and labelled as estimates in the UI,
   but they are still estimates.
4. **Surface data follows OSM's coverage.** Rural gravel is often untagged.
5. **Elevation is z12 Terrarium, ~38 m posts.** Fine for grade over a stretch,
   coarse for a short steep pitch.

## Known quirks

* The coverage box reaches over the Columbia into Portland, because the border
  is a river and this is a rectangle. A handful of unroutable Oregon place-search
  hits is the accepted cost of not clipping Vancouver and Longview.
* Restriction joins ignore milepost direction, so the opposite direction of a
  prohibited segment is also flagged. Conservative on purpose.
* `route_closures.geojson` is hand-maintained. It is accurate when someone
  updates it and stale when nobody does.

## Field testing

Ridden regularly in the Puget Sound region. Eastern Washington, the Olympic
Peninsula and the Columbia Basin are built from the same data but have had far
less real-world checking.
