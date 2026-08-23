# Agency data coverage: Washington and Oregon

What fraction of each state's routable road network carries a **measured**
shoulder width, an **agency** bicycle stress rating, and an **agency** traffic
count — with the source behind each number.

Measured against the shipped routing graphs, not against a source's advertised
row count (lesson B3 in `docs/PORTING-LESSONS.md`). Reproduce with:

```bash
python3 scripts/measure_coverage.py --graph maps/washington/graph2.bin.gz --signals
python3 scripts/measure_coverage.py --graph maps/oregon/graph2.bin.gz --signals
```

Denominator: centreline miles of drivable road in the graph, separated paths
and ferry crossings excluded — 94,528 mi in Washington, 74,516 mi in Oregon.
It is not the state's published public-road mileage: unpaved tracks and
service roads the router does not use are not in it. Figures below are from
the graphs current on 2026-08-23.

## The three signals at a glance

| Signal | Washington | Oregon |
| --- | --- | --- |
| Shoulder width, at least one direction | **9.2%** (8,721 mi) | **10.2%** (7,638 mi) |
| — from an agency inventory | 8.5% | 10.2% |
| — from OSM tags alone | 0.8% | 0.1% |
| Agency bicycle stress rating (BLTS) | **8.4%** (7,969 mi) | **11.0%** (8,198 mi) |
| Agency traffic count (AADT) | **51.9%** (49,062 mi) | **25.7%** (19,122 mi) |

Every one of these is a state-highway dataset except Washington's traffic
count, which is 34.4 points county road log. That single difference is why the
two states' traffic rows differ by a factor of two and their shoulder and
stress rows do not.

## 1. Shoulder

### Washington — 9.2%

| | |
| --- | --- |
| Source | **WSDOT Bicycle and Pedestrian Level of Traffic Stress**, `ShoulderWidth` |
| Endpoint | `https://data.wsdot.wa.gov/geospatial/DOT_ActiveTransportation/BikePedLTS.zip` |
| Extent | 55,271 segments, 15,879 directional source miles, state highways only |
| Populated | 100% of segments carry a width; 42.2% of them record 0 ft |
| Directions | per-direction widths; 8.1% of the network has both, 9.2% at least one |
| 4 ft or wider | 6.2% of the network |

A second Washington source reports road width but deliberately does not feed
the shoulder rule:

| | |
| --- | --- |
| Source | **CRAB Certified County Road Log 2023** |
| Endpoint | `https://services9.arcgis.com/bwkxJJr72Wf3t8dm/arcgis/rest/services/CRAB_County_Road_Log_Certified_2023/FeatureServer/0` |
| Derived bail-out space | **38.8%** of the network (36,681 mi) — total edge space, paved or not |
| Reported paved shoulder | **5.0%** (4,756 mi); the field is populated on ~15% of county segments |

The road log's paved-shoulder field is carried for display only. A blank there
means "not separately inventoried", not "no shoulder", so it cannot be read as
an absence. See `docs/plan-county-road-log.md`.

### Oregon — 10.2%

| | |
| --- | --- |
| Source | **ODOT Shoulder Width and Type**, MapServer 127, joined onto BLTS sections |
| Endpoint | `https://gis.odot.state.or.us/arcgis1006/rest/services/facs_stip/data_catalog/MapServer/127` |
| Fields | `LS_PVMT_WD`, `LS_GRAV_WD`, `RS_PVMT_WD`, `RS_GRAV_WD` by route and milepost |
| Extent | 73,487 of 81,210 BLTS sections (90.5%), state highways only |
| Populated | 3.1% record 0 ft |
| Directions | 7.8% of the network has both, 10.2% at least one |
| 4 ft or wider | 7.5% of the network |

Oregon has **no county road inventory**: bail-out space is 0.0% and county
paved shoulder 0.0%, because ODOT publishes no statewide equivalent of the
CRAB road log. That was searched for during the import and recorded as absent
in `maps/oregon/STATUS.md` (lesson D7).

### Both states

Off the state highway system, a shoulder value exists only where an OSM mapper
tagged one: 711 mi in Washington, 45 mi in Oregon — 0.8% and 0.1% of the
network. The agency inventories fill only what OSM left blank and never
overrule an explicit tag, including an explicit zero.

## 2. Bicycle stress rating

| | Washington | Oregon |
| --- | --- | --- |
| Source | WSDOT `LTS_Bicycle` (BikePedLTS) | ODOT Bicycle LTS, MapServer 390 |
| Endpoint | as above | `https://gis.odot.state.or.us/arcgis1006/rest/services/facs_stip/data_catalog/MapServer/390` |
| Extent | state highways; 42,798 of 55,271 segments rated (77.4%) | state highways; 81,210 of 81,210 rated (100%) |
| Network coverage | 8.4% | 11.0% |

The two agencies' ratings are not equally informative. By source directional
mileage, 85.6% of Washington's rated network is LTS 4 and 11.3% is unrated;
Oregon's splits 48.6% LTS 2, 26.7% LTS 3, 23.7% LTS 4. On the graph:

| Rating | Washington | Oregon |
| --- | --- | --- |
| LTS 1 | 1 mi | 39 mi |
| LTS 2 | 72 mi | 3,414 mi |
| LTS 3 | 159 mi | 2,074 mi |
| LTS 4 | 7,737 mi | 2,671 mi |

Washington's rating is close to a constant meaning "this is a state highway",
which is why `docs/SAFETY-MODEL.md` keeps it out of the verdict and uses it as
a caution and a routing cost only. Oregon's discriminates, and is likewise
treated as display and cost rather than a gate.

Neither state publishes a bicycle stress rating off its own highway system.
Everywhere else — most of where people ride — the rating a rider sees comes
from the app's own model over class, speed, shoulder and volume.

## 3. Traffic volume

### Washington — 51.9%

| Source | Endpoint | Coverage | Vintage |
| --- | --- | --- | --- |
| CRAB county road log `ADTVolume` | `services9.arcgis.com/.../CRAB_County_Road_Log_Certified_2023/FeatureServer/0` | **34.4%** (32,543 mi) | 1949–2023, median **2014**; 50.7% before 2015 |
| WSDOT Traffic Counts (AADT) | `https://data.wsdot.wa.gov/arcgis/rest/services/Shared/TrafficData/MapServer/1` | **7.6%** (7,214 mi) | all 2025 |
| FHWA HPMS, Washington 2018 | `https://geo.dot.gov/server/rest/services/Hosted/Washington_2018_PR/FeatureServer/0` | **9.8%** (9,305 mi) | all 2018 |

Across all counted miles the median count year is 2018 and 33.6% predate 2015
— all of that in the county road log, whose oldest certified counts are from
the 1940s.

### Oregon — 25.7%

| Source | Endpoint | Coverage | Vintage |
| --- | --- | --- | --- |
| ODOT AADT, state system | `.../data_catalog/MapServer/155` | **11.0%** (8,201 mi) | all 2024 |
| FHWA HPMS, Oregon 2018 | `https://geo.dot.gov/server/rest/services/Hosted/Oregon_2018_PR/FeatureServer/0` | **14.7%** (10,921 mi) | all 2018 |

Nothing in Oregon's traffic data predates 2015. ODOT's **non-state** AADT layer
(MapServer 156) carries a single `MP` and no route span, so it cannot be
conflated onto line geometry; it is parked, not claimed.

## Which roads are covered

Shoulder and stress are both essentially "the state highway system"; traffic
is where the two states diverge.

**Washington**

| Class | miles | shoulder | stress | traffic |
| --- | --- | --- | --- | --- |
| Interstate | 973 | 99.0% | 72.0% | 100.0% |
| Freeway/expressway | 2,239 | 86.7% | 79.2% | 58.0% |
| Principal arterial | 3,347 | 63.8% | 62.0% | 92.2% |
| Minor arterial | 5,304 | 37.7% | 36.6% | 94.9% |
| Major collector | 14,713 | 10.7% | 10.0% | 87.2% |
| Minor collector | 30,808 | 0.2% | 0.0% | 46.6% |
| Local street | 37,143 | 0.1% | 0.0% | 30.9% |

**Oregon**

| Class | miles | shoulder | stress | traffic |
| --- | --- | --- | --- | --- |
| Interstate | 1,083 | 96.9% | 97.3% | 100.0% |
| Freeway/expressway | 651 | 95.4% | 95.5% | 23.3% |
| Principal arterial | 3,949 | 82.6% | 84.5% | 95.6% |
| Minor arterial | 3,908 | 44.8% | 48.3% | 93.4% |
| Major collector | 15,584 | 6.0% | 8.3% | 62.9% |
| Minor collector | 23,808 | 0.1% | 0.0% | 2.6% |
| Local street | 25,532 | 0.0% | 0.0% | 0.2% |

By FHWA roadway owner, state-owned road is measured in both states —
Washington 98.4% shoulder / 98.0% stress / 100% traffic across 6,933 mi,
Oregon 87.8% / 95.1% / 100% across 7,978 mi. County road is measured for
traffic in Washington (99.2% of 14,227 mi) and 59.5% in Oregon, and for
shoulder in neither (0.8% and 0.4%).

The single largest difference a rider would feel is the collector tier.
Washington knows the traffic on 87.2% of its major collectors and 46.6% of its
minor collectors; Oregon knows 62.9% and 2.6%. Those are the roads a rural
route is built from.

## What would move each number

| Gap | Washington | Oregon |
| --- | --- | --- |
| Ridable shoulder off the state system | CRAB reports a paved shoulder on ~15% of county segments and it is display-only today; nothing else exists | no source exists — a county road log equivalent would have to be assembled county by county |
| Stress off the state system | neither agency publishes one; the app's model is the only rating | same |
| Traffic on local and minor-collector road | 30.9% / 46.6% today; city street counts are not published statewide | 0.2% / 2.6%; ODOT's non-state AADT is point data and needs a route span to be usable |
| Count freshness | half the county road log's counted mileage predates 2015 | nothing predates 2018 |

## Recorded findings

- **`maps/washington/region.json` under-reports its own sources.** Its
  `attribution.agencySources` lists four WSDOT layers and omits the CRAB county
  road log, WSDOT Traffic Counts, WSDOT non-state functional class and FHWA
  HPMS — four sources that between them supply 51.9% of the state's traffic
  coverage and 38.8% of its bail-out space. Oregon's `region.json` lists its
  equivalents. The rider-facing attribution is therefore incomplete for
  Washington.
- **`maps/oregon/STATUS.md` records 49,975 BLTS sections receiving a shoulder
  value.** The shipped `blts.geojson.gz` carries 73,487 of 81,210 (90.5%);
  the lower figure predates the `.764` route-prefix rebuild.
