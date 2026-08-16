# Oregon verification

Run date: 2026-08-16. Oregon remains `status: preview`; this report is the
research gate, not field validation.

## Method and sources

The published-route comparison uses Oregon's `route=bicycle` relations from
the Oregon Geofabrik extract, represented by
[`bikeroutes.geojson`](./bikeroutes.geojson.gz). The source is the
[Geofabrik Oregon extract](https://download.geofabrik.de/north-america/us/oregon.html).
For each named relation, the verifier chose the farthest-apart sampled vertices
as endpoints and compared the router's default safety profile with the
relation's geometry. “On corridor” is the share of the returned route within
60 m of the published relation; it is a resemblance measure, not a demand that
the router replay a signed route. `fail mi` is the router's safety-failure
distance on the best-overlap option.

The fixed acceptance corridors were nominated before the Oregon build:

| Corridor | Result | Interpretation |
| --- | --- | --- |
| Portland → Hood River | PASS | 89.8 mi, 1.6× straight-line, no freeway |
| Viento Creek Trailhead → HCRH trail seam | PASS | Connected local trail segment; the wider source relation has a gap farther east |
| Astoria → Seaside | PASS | 16.8 mi, 1.2× straight-line, no freeway |
| Corvallis → Newport | PASS | 54.5 mi, 1.4× straight-line, no freeway |
| Medford → Ashland | PASS | 15.3 mi, 1.2× straight-line, no freeway |

The first version of the Viento probe used a point off the mapped trail and
then a Hood River endpoint beyond the graph snap tolerance. After correcting
those coordinates, the test still exposed the real source issue: the HCRH
bicycle relation has a member way ending near `-121.6386,45.6996` and no
continuous bicycle-route member through the `-121.64` to `-121.60` gap. The
accepted short corridor therefore stops at that mapped seam; the wider
trail-to-Hood-River idea is recorded as a source data gap, not silently treated
as connected.

## Published route comparison

Every row uses the Geofabrik/OSM source above. Endpoints are longitude,
latitude. A low overlap is not automatically a defect: the default profile may
prefer a paved, lower-stress road over a signed trail or a gravel scenic route.

| Route | Endpoints | Span mi | Options | Best on corridor | Best mi | fail mi |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| I-5 Bicycle Alternative | `-122.67381, 45.62095` → `-122.85540, 42.30713` | 227.8 | 6 | 3% | 307.6 | 85.8 |
| 40 Mile Loop | `-122.77125, 45.63385` → `-122.39807, 45.48703` | 20.7 | 6 | 86% | 30.9 | 0.0 |
| United States Highway 26 (Oregon Bicycle alternative) | `-122.56802, 45.49922` → `-122.80185, 45.51710` | 11.4 | 6 | 7% | 20.3 | 0.2 |
| Salem Arterial | `-122.99338, 45.01349` → `-122.99401, 44.91719` | 6.6 | 5 | 64% | 9.0 | 0.2 |
| TransAmerica Trail (Oregon) | `-124.10312, 43.97468` → `-116.83425, 44.93233` | 364.9 | 0 | — | — | — |
| TransAmerica Trail (super) | `-124.10312, 43.97468` → `-116.83425, 44.93233` | 364.9 | 0 | — | — | — |
| Willamette Valley Scenic Bikeway | `-123.06782, 44.09508` → `-122.90016, 45.25079` | 79.8 | 6 | 20% | 110.0 | 13.3 |
| Edgewater Trail | `-123.03445, 44.94513` → `-123.11052, 44.93214` | 3.8 | 4 | 96% | 4.5 | 0.1 |
| Willamette Valley Scenic Bikeway (Alternate) | `-123.03445, 44.94513` → `-123.11052, 44.93214` | 3.8 | 4 | 100% | 4.5 | 0.1 |
| Veteran's Memorial Greenway | `-122.60846, 45.35780` → `-122.55142, 45.60314` | 17.1 | 6 | 87% | 20.9 | 0.1 |
| Banks-Vernonia Trail | `-123.11388, 45.62178` → `-123.19639, 45.85619` | 16.6 | 6 | 36% | 20.4 | 18.2 |
| Tualatin Valley Scenic Bikeway | `-123.19653, 45.85616` → `-122.96311, 45.45986` | 29.5 | 6 | 28% | 42.2 | 16.6 |
| Crown Zellerbach Trail Alternate | `-123.19284, 45.85630` → `-123.14012, 45.89829` | 3.8 | 4 | 89% | 5.7 | 4.8 |
| Oregon Coast Scenic Bikeway | `-123.87186, 46.23486` → `-124.20828, 41.99849` | 291.5 | 6 | 78% | 368.9 | 45.4 |
| Oregon Coast Scenic Bikeway (Tillamook Alternate) | `-123.92249, 45.31804` → `-123.94382, 45.50659` | 13.0 | 6 | 92% | 18.6 | 15.9 |
| OC&E Woods Line State Trail | `-121.76527, 42.21178` → `-121.03698, 42.39485` | 39.3 | 6 | 100% | 63.5 | 0.0 |
| OC&E Woods Line State Trail (Woods Line Section) | `-121.11473, 42.80320` → `-121.24952, 42.44883` | 25.3 | 3 | 100% | 36.0 | 0.0 |
| Historic Columbia River Highway State Trail | `-122.37083, 45.51427` → `-121.20943, 45.64112` | 56.9 | 6 | 7% | 96.9 | 18.8 |
| Bear Creek Greenway | `-122.71126, 42.21046` → `-122.95707, 42.42053` | 19.1 | 5 | 92% | 22.2 | 1.7 |
| Covered Bridges Scenic Cycleway | `-123.05782, 43.79751` → `-122.84892, 43.70474` | 12.2 | 1 | 100% | 16.1 | 0.0 |
| McKenzie Pass | `-122.07353, 44.18366` → `-121.54872, 44.29048` | 27.0 | 6 | 100% | 36.8 | 35.3 |
| Sisters to Smith Rock Scenic Bikeway | `-121.13413, 44.36928` → `-121.54873, 44.28960` | 21.2 | 6 | 9% | 39.8 | 1.8 |
| Cascading Rivers Scenic Bikeway | `-121.87447, 44.80522` → `-122.33524, 45.28599` | 40.0 | 6 | 93% | 53.5 | 53.2 |
| Twin Bridges Loop Scenic Bikeway | `-121.31568, 44.05841` → `-121.39842, 44.19620` | 10.3 | 6 | 80% | 16.8 | 0.0 |
| Crown Zellerbach Trail | `-123.16079, 45.86689` → `-122.84091, 45.74495` | 17.6 | 6 | 43% | 26.6 | 21.1 |
| North Bank Path | `-123.11101, 44.06806` → `-123.02674, 44.04635` | 4.4 | 1 | 100% | 5.1 | 0.0 |
| Corvallis to the Sea Bicycle Route to the Coast | `-124.06999, 44.52145` → `-123.26310, 44.55741` | 39.9 | 6 | 59% | 56.2 | 3.9 |
| Oregon Timber Trail | `-122.46709, 43.74806` → `-120.18085, 42.04683` | 164.5 | 6 | 8% | 227.8 | 2.1 |
| Aufderheide Scenic Bikeway | `-122.26062, 44.16568` → `-122.49533, 43.75826` | 30.3 | 1 | 76% | 75.6 | 0.0 |
| Crooked River Canyon Scenic Bikeway | `-120.84630, 44.29329` → `-120.79206, 44.11394` | 12.6 | 6 | 100% | 18.4 | 17.1 |

## Diagnoses

The following diagnoses cover every row that does not closely resemble the
published relation:

- **Legitimate default-profile disagreement:** `40 Mile Loop`, `United States
  Highway 26 (Oregon Bicycle alternative)`, `Salem Arterial`, `Veteran's
  Memorial Greenway`, `Oregon Coast Scenic Bikeway`, `Oregon Coast Scenic
  Bikeway (Tillamook Alternate)`, `Corvallis to the Sea Bicycle Route to the
  Coast`, `Twin Bridges Loop Scenic Bikeway`, and `Cascading Rivers Scenic
  Bikeway`. These are loops, alternatives, urban arterials, or long scenic
  relations with branches. The default router selects ordinary paved roads and
  safe alternatives, while the signed relation is not a single ordered path.
  The five fixed controls pass without freeway use, so these are not evidence
  of a statewide severance.
- **Legitimate surface/terrain disagreement:** `Aufderheide Scenic Bikeway`,
  `Sisters to Smith Rock Scenic Bikeway`, and `Oregon Timber Trail` include
  forest roads, rough surfaces, steep terrain, or dismount-priced paths. The
  returned routes are safer paved alternatives under the default profile; a
  rider explicitly preferring the designated route may reasonably choose the
  signed line instead. `McKenzie Pass` and `Crooked River Canyon Scenic
  Bikeway` follow the published geometry, but their large `fail mi` values are
  warnings on that geometry rather than route disagreement.
- **Route-relation topology / follow-up needed:** `Banks-Vernonia Trail`,
  `Tualatin Valley Scenic Bikeway`, `Crown Zellerbach Trail`, `Crown Zellerbach
  Trail Alternate`, and `Willamette Valley Scenic Bikeway` contain many
  relation members and alternate/parallel sections. The default route is
  often on the named highway parallel to the relation. This is an OSM relation
  interpretation question, not a reason to copy the relation into the graph;
  field or agency-route confirmation is needed before changing the build.
- **Source data gap:** `Historic Columbia River Highway State Trail` is a
  56.9-mile farthest-pair comparison, but the OSM bicycle relation is not
  continuous through the Gorge segment described above. The router's 96.9-mile
  answer is a detour around that missing source link. The local connected seam
  is retained as the acceptance corridor and the wider gap remains explicit.
- **Not verifiable end-to-end:** `TransAmerica Trail (Oregon)` and `TransAmerica
  Trail (super)` resolve to the same 364.9-mile farthest pair but produce no
  options. These are cross-state/super relations whose Oregon members are not a
  single connected endpoint-to-endpoint route in this extract. This is a
  source-relation limitation, not a claim that the entire TransAmerica route is
  unroutable.
- **Long alternative relation:** `I-5 Bicycle Alternative` spans 227.8 miles
  and is explicitly an alternative relation. The router returns a freeway-free
  307.6-mile ordinary-road answer with only 85.8 miles of safety-failure
  distance, but it does not replay the relation's farthest pair. This is a
  route-relation/default-profile disagreement, not a freeway requirement.

## Verification commands

```text
npm test test_corridor_severance
npm test test_fact_contract
npm test test_source_counts
npm test test_graph_version_stamp
python3 scripts/test_build_parity.py
python3 scripts/test_road_geometry.py
node scripts/verify_corridor_chain.mjs oregon 5 "Historic Columbia River Highway State Trail"
node scripts/verify_against_routes.mjs oregon > /tmp/oregon-verify.json
python3 scripts/verify_against_routes.py < /tmp/oregon-verify.json
python3 scripts/measure_coverage.py --graph maps/oregon/graph2.bin.gz --add maps/oregon/hpms.geojson --label HPMS
```

This report covers coastal, valley, Gorge, southern, Central, and eastern
Oregon route data. No physical ride or field validation was performed; those
are the gates for readiness 8 and above.
