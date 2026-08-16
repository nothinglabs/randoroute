# Reviewed supplemental route sources

OSM bicycle-route relations are the default route source for every map. This
file is the human approval gate for the unusual case where an authoritative
publisher documents useful routes that OSM omits or maps incompletely.

**Do not routinely search for or import supplemental routes while adding a
state.** A source belongs here only after external evidence identifies a real
gap and a human approves the source. Discovery alone is a note for review, not
permission to put the geometry into routing. The machine-readable companion is
[`route-sources.json`](./route-sources.json); its builder rejects sources that
are not marked `approved` here and there.

A published route is route guidance, not a safety measurement. Supplemental
routes receive exactly the same designation and preference behavior as OSM
routes. They never satisfy a shoulder, traffic, speed, surface, access, or
facility rule; those facts continue to determine the map color and warnings.

## Washington

### Island County — approved

- **Publisher:** Island County Public Works
- **Source:** [Island County Bike Routes, layer 1](https://maps.islandcountywa.gov/arcgis/rest/services/PublicWorksApps/Island_County_Bike_Map/MapServer/1)
- **Evidence:** The county describes North Whidbey, Central Whidbey, South
  Whidbey, and Camano as signed bicycle touring routes and publishes their
  line geometry. These routes add county-authored touring guidance beyond the
  statewide OSM relation catalogue.
- **Included:** `North Whidbey`, `Central Whidbey`, `South Whidbey`, `Camano`.
- **Excluded:** the layer's generic major/minor-road categories, roads marked
  not recommended for bicycles, and USBR 97 copies already supplied by OSM.
- **Caution:** The publisher describes these as routes for riders comfortable
  sharing roads with traffic. Approval means the alignments are intentional;
  it does not assert that their individual roads pass RandoRoute's rules.

## Oregon

### Oregon Scenic Bikeways — approved

- **Publisher:** Oregon Parks and Recreation Department
- **Source:** [Oregon State Parks Scenic Bikeways](https://stateparks.oregon.gov/index.cfm?do=things-to-do.scenic-bikeways)
- **Evidence:** Oregon State Parks identifies 18 official state-designated
  routes and links each to public GPS geometry. Comparison with the OSM route
  catalogue found official routes and portions that were absent or incomplete.
- **Included:** only the 18 route records explicitly listed in
  `route-sources.json`; a later addition to the website requires another human
  review before it enters the registry.
- **Caution:** Oregon explicitly warns that Scenic Bikeways use roads with car
  and truck traffic. State designation affects route preference only; it is
  not evidence that a road is safe.

## Adding another source

1. Demonstrate a meaningful omission or incomplete alignment in OSM using an
   authoritative published map or route file.
2. Record the publisher, stable source URL, exact included records, exclusions,
   date reviewed, and any status field that can mean planned or proposed.
3. Obtain human approval and add the source to this file and
   `route-sources.json` with `approved: true`.
4. Add or reuse a generic adapter in `scripts/build_supplemental_routes.py`.
   State- or agency-specific application code is not permitted.
5. Rebuild the region's route overlay and routing graph designation, then run
   the supplemental-route tests. Verify that designation changes preference
   but leaves every underlying safety verdict unchanged.
