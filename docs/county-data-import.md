# Importing a county's bike data

How Island County was added, written so the next one is a procedure rather than
a rediscovery. Clallam is next.

## Why counties at all

WSDOT's layers stop at the state highway system. Below it — the county roads
most riding actually happens on — we have nothing but OSM tags, which are thin.
Deer Lake Road on Whidbey forced the issue: it carries Island County's own
signed bike route and about 2,000 vehicles a day, and the app knew neither,
because the road is not a state route.

## What we want, and what we refuse

**Wanted:**

1. **Clearly bikeable routes.** A network the county has *built* and signs.
2. **Road traffic levels.** Average daily traffic per road segment, with the
   year it was counted.

**Refused, deliberately:**

| not imported | why |
|---|---|
| planned / proposed corridors | A plan is not pavement. Island publishes 49 mi of planned route against 33 mi built; drawing it put more provisional line on the map than real network and read as noise. |
| mountain-bike / natural-tread trails | A different activity with different rules. We already gate MTB behind its own setting; a county trail inventory must not smuggle singletrack in as network. |
| hiking-only trails | Not bike infrastructure. Island's `Trails` layer is 837 features of which **58** say `BICYCLE = Yes`; the other 779 are park paths. |
| anything whose bike permission is blank | Blank is not "yes" and it is not "no". 646 of Island's 837 trail rows say nothing at all, so absence proves nothing in either direction. |

The refusals matter more than the acceptances. A county publishes one folder of
trail data and it mixes paved multi-use path, gravel logging road and 3-foot
natural tread. Importing it wholesale would route a road bike onto singletrack.

## The four steps

### 1. Discover — mechanical

Counties publish through ArcGIS. List the org's services, then **list each
service's layers**, because the layer is where the name lives:

```bash
curl -s "https://services6.arcgis.com/<ORG>/arcgis/rest/services?f=json"
curl -s "https://services6.arcgis.com/<ORG>/arcgis/rest/services/<SVC>/FeatureServer?f=json"
```

Island's bike network is layer 0, `BikeRoutes`, inside a service called
**`Bridge_to_Boat_v2`**. No keyword search over service names finds that — the
service is named after the route (Deception Pass bridge to the Clinton ferry
boat), not its contents. Crawl to layer depth or you will conclude the county
publishes nothing.

Search the org's own hub too; it lists datasets by title:

```bash
curl -s "https://data-<county>gis.opendata.arcgis.com/api/search/v1/collections/dataset/items?limit=100"
```

### 2. Profile — mechanical

For each candidate layer, pull the field list, then the distinct values of every
field with mileage against each. Do not skip to writing the adapter: the
profile is what tells you the data's real shape.

What profiling Island and Clallam actually exposed:

- `LeftPavedShoulderWidth` populated on **954 of 4,399** rows — so blank means
  "not separately inventoried", not "no shoulder".
- `ADTYear` ranging **1977 to 2019**, with 2,865 of 4,346 counts predating 2010.
- Clallam's `ODT_Use` field containing `Multi-Use`, `Multi-use`,
  `Multi-Use > No Horses`, `Multi-use >No Road Bike` and `Multi-use >no rd bike`
  — hand-typed, inconsistent inside a single layer.

That last one is the reason step 3 cannot be automated.

### 3. Map to our schema — needs judgement, once per county

One dict in `scripts/build_county_data.py`, about fifteen lines: which layer is
the network, which field carries the name, what marks a corridor as planned,
and which traffic fields are which.

```python
'island': {
    'name': 'Island', 'state': 'WA', 'fips': '53029',
    'routes': {
        'url': '.../Bridge_to_Boat_v2/FeatureServer/0',
        'name_field': 'Route',
        'planned_marker': '(Planned)',
    },
    'traffic': {
        'url': '.../Average_Daily_Trips/FeatureServer/0',
        'fields': {'name': 'RoadName', 'adt': 'ADT', 'year': 'ADTYear',
                   'lanes': 'NumThruLanes', 'speed': 'SpeedLimit'},
    },
},
```

The output schema is fixed, which is the whole reason this generalises — a
county is only ever a *mapping into it*:

```json
{ "county", "state", "fips", "built", "sources",
  "routes":  [ { "name", "status": "existing", "network", "coords" } ],
  "traffic": [ { "name", "adt", "year", "lanes", "speed", "coords" } ] }
```

Values are hand-typed and inconsistent, so this mapping is read and confirmed by
a person once. Guessing at field semantics is guessing about safety data, and we
do not do that.

### 4. Verify — mechanical, and non-negotiable

These are gates, not reports. Island needed every one of them:

| check | why it exists |
|---|---|
| matched mileage ÷ published mileage between **1.0 and 1.5** | Below 1.0 the snap missed the network. Above 1.5 it is bleeding onto cross streets — the first run matched **72 mi against 33.5 mi published** before the bearing test existed; with it, 42 mi. |
| a road you can check by hand carries the flag | Deer Lake Road. If a named road you traced manually is not flagged, nothing else in the report means anything. |
| no county line matched an OSM way more than 18 m away | The snap tolerance is a claim about centreline disagreement, not a licence to grab the next street. |
| every distinct value of every mapped field is accounted for | An unmapped value must fail the build, never be silently dropped. |

## How the data reaches the app

Two different paths, on purpose.

**Bike routes are baked in at build time.** Map colours come from
`roadLevelExpr`, which MapLibre evaluates in the renderer against vector-tile
properties — nothing computed in JavaScript can reach it. A county flag that
existed only at runtime could change routing and the cards but never the colour,
so a road would route as passing while drawn failing. So the flag is written
into both archives by `scripts/county_conflate.py`:

```bash
python3 scripts/build_graph.py --src data/washington-latest.osm.pbf \
        --county data/county/island.json          # sets EDGE_COUNTY_ROUTE (eOfficial bit 128)
python3 scripts/build_roads.py --src data/washington-latest.osm.pbf \
        --county data/county/island.json          # sets the cg tile property
tippecanoe -o data/roads.pmtiles ...              # see README
```

The cost is honest: adding or re-surveying a county's *routes* means rebuilding
`graph2.bin.gz` and `roads.pmtiles`. Batch counties so it happens once.

**Traffic counts stay a runtime overlay.** They never touch colour, they are
display-only, and they are the part that churns — a county re-counting a road
should be a 100 KB file, not a 38 MB archive. `county-data.js` resolves them by
position when a card is drawn.

## The matching rule

Identical in `scripts/county_conflate.py` (build) and `county-data.js`
(runtime), because they must not drift:

- within **18 m** of the way's own *span*, not its midpoint — graph edges
  average ~190 m, so a midpoint test misses most of a road
- headings aligned within **40°**, either direction along the line

The bearing test is load-bearing. Without it a signed route bleeds onto every
side street it crosses.

## What county data does and does not tell you

It says **what a segment is**. It does not say whether it is safe.

Clallam classifies the Olympic Discovery Trail into `Separated Trail`,
`Trail Route on Road`, `Connecting Road`, `Trail on Existing Gravel Logging
Road` — and flags 18 segments `No Road Bike`. It carries **no speed limit and no
shoulder width**. It cannot tell you that a stretch is 50 mph with a 2 ft
shoulder; only our own ladder can, from OSM speed and WSDOT/county shoulder.

So the value of importing a county is not that it judges safety for us. It is
that it stops the route layer lying about what is underneath: once Clallam says
55.8 mi of the ODT is "Complete – On Road", those miles get judged as the roads
they are.

See `docs/SAFETY-MODEL.md` for what the resulting flag does to the verdict —
in particular "Rung 8", where county trust and state trust are separate
settings over separate facts.
