# Oregon — readiness 7/10

`status: preview`. Imported from the documentation alone, by an agent that has
never been to Oregon. **Nobody has ridden anything this produces.**

## The gate met for 7

Level 7 is *"verification extended past one metro to the state's distinct
regions"*. `VERIFICATION.md` checks **30 published corridors** — every named
`route=bicycle` corridor in the extract long enough to route across — covering
the coast, the Coast Range, the Willamette Valley, the Columbia Gorge, the
Cascades, the Central Oregon high desert, the Klamath Basin, the Rogue Valley
and the eastern rangeland. Every disagreement is diagnosed; two are diagnosed
as *unknown* and say so.

The gates below it, in order:

| | gate | met by |
| --- | --- | --- |
| 1 | app opens on the state | `test_region_portable`, `test_maps_states_screen` |
| 2 | `places.json` + `basemap.pmtiles` | 1,461 settlements; 41 MiB basemap with the detailed OSM coastline |
| 3 | `roads.pmtiles` + `graph2.bin.gz` | 629,607 nodes / 1,375,271 arcs; 32 MiB road tiles |
| 4 | agency speeds and facilities conflated; corridor severance passes | ODOT posted speed and bicycle facilities; `test_corridor_severance` green on all six nominated corridors |
| 5 | traffic volume + a written verification report | FHWA HPMS 2018, 67,861 sections; `VERIFICATION.md` |
| 6 | stress rating, prohibitions and shoulder inventory where published; `measure_coverage.py` recorded | ODOT BLTS 1–4, ODOT shoulder width per side; no prohibition layer exists (below); numbers in section 3 |
| 7 | verification across the state's distinct regions | `VERIFICATION.md` §3 |

**8 is not claimable and will not be until a rider reports back.** That is the
design of the rubric, not a shortfall of the work.

## What works

| | |
| --- | --- |
| Routing | Yes — 629,607 nodes / 1,375,271 arcs, elevation-aware from 8,446 z12 Terrarium tiles |
| Street map | Yes — `roads.pmtiles`, 308,347 ways with names, speeds and shoulders |
| Basemap | Yes — land, water, green space, place labels, detailed OSM Pacific coastline |
| Traffic stress | Yes — ODOT BLTS 1–4 on state highways, 81,210 segments |
| Legal speeds | Yes — ODOT Posted Speed on state highways; class estimates elsewhere |
| Shoulders | Yes — ODOT inventory per side on state highways (73,575 BLTS segments carry one); OSM tags elsewhere, and there are almost none (below) |
| Bike facilities | Yes — ODOT Bicycle Facility Inventory (1,800 bike-lane and 266 shared-lane records) plus OSM |
| Prohibitions | **No agency source.** OSM `bicycle=no` only |
| Traffic volume | Yes — FHWA HPMS 2018 |
| Designated routes | Yes — 45 corridors from OSM relations, including every Oregon Scenic Bikeway |
| Place search | Yes — 1,461 settlements, offline |
| Ferries | None in the network. Oregon has no bicycle-carrying ferry route |

## Coverage, measured

`python3 scripts/measure_coverage.py --graph maps/oregon/graph2.bin.gz`:

```
road miles (excluding paths and ferries)  74,481
  with a traffic count                       18,786   25.2%
  with bail-out space                             0    0.0%

traffic-count coverage by road class:
  Interstate                 1,555        1,082    69.6%
  Freeway/expressway           219          180    82.0%
  Principal arterial         3,915        3,727    95.2%
  Minor arterial             3,962        3,592    90.7%
  Major collector           15,424        9,601    62.3%
  Minor collector           23,775          585     2.5%
  Local street              25,632           18     0.1%
```

Read the spread, not the headline. **95% of principal-arterial miles carry a
count and 0.1% of local streets do.** Washington's equivalent figures are 35.4%
overall and 23.4% on local streets — Oregon is *better* on the arterials and
essentially blind on the streets people actually live on, because Washington has
a statewide county road log with counts on it and **Oregon has no equivalent at
all**. Every verdict on an Oregon residential street is inference from road
class.

Conflation rates from the graph build: functional class matched 258,637 of
711,484 ways (36.4%, 25,944 mi); HPMS matched 230,178 (32.4%, 18,259 mi);
105,238 edges carry ODOT state-highway attributes.

## Why 7 and not higher, in terms of coverage

1. **No rider has seen any of it.** Everything above is desk verification
   against published route geometry. That alone caps this at 7.
2. **No county road inventory exists.** This is the single largest structural
   difference from Washington. WSDOT's build gets bail-out space, per-side
   shoulder and counted volume on 115,582 county segments from CRAB; Oregon's
   nearest equivalent, ODOT's non-state functional class layer, carries **class
   and jurisdiction and nothing else** — no width, no count, no surface. The
   `inferShoulderFromEdge` rule that recovers 1,696 miles of verdict in
   Washington can never fire in Oregon: bail-out space is 0.0% of the network.
3. **Off-state-highway stress is inferred, not measured.** ODOT publishes BLTS
   for the state highway system only — 81,210 segments — which is most of the
   mileage riders *tour* and almost none of the mileage they *commute*.
4. **OSM shoulder tags are effectively absent.** 650 ways in the whole state
   carry any `shoulder*` tag, out of 850,087 highway ways. Off the state system
   a missing shoulder is indistinguishable from an unmeasured one.
5. **No published bicycle prohibitions.** ODOT's data catalogue has no
   equivalent of WSDOT's Permanent Bike Restrictions; Oregon's freeway bans live
   in OAR 734-020-0045 as prose. The graph honours OSM `bicycle=no`, which is
   how I-5 and I-205 are excluded, and the road card correctly attributes it to
   the OSM tag rather than to ODOT.
6. **Traffic counts are 2018 (HPMS) where they exist off the state system.**
   ODOT publishes current AADT — 6,544 state and 5,028 non-state sites — but as
   **points**, not linework, and `roadmeasure.py` conflates lines. Those counts
   are fetched and unused; see the known-backlog note below.
7. **Elevation is z12 Terrarium, ~38 m posts.** Fine for grade over a stretch,
   coarse for a short pitch, and Oregon has more sustained mountain grade than
   Washington's populated west side.

## Known quirks

* **The Historic Columbia River Highway State Trail is severed at Mitchell
  Point** in this data, so Portland → Hood River routes around Mount Hood
  instead of along the river. `VERIFICATION.md` §4 has the diagnosis. It is an
  OSM gap, not a build defect, and it is the first thing a rider should check.
* The coverage box is a rectangle over a state whose northern border is a
  river, so it reaches into Washington. Vancouver and Longview appear in place
  search and are unroutable — the mirror image of the note in Washington's
  `STATUS.md`, and the accepted cost of not clipping Astoria and Portland.
* The ODOT shoulder inventory is booked per side against increasing mileposts.
  For 33,941 of 73,575 segments the only record available runs the other way
  and the sides are swapped to give the rider their own shoulder. That
  transformation follows ODOT's stated convention and has not been checked
  against a photograph.
* ODOT's BLTS layer ships copies of the inventories it was derived from. Those
  copies are **not** read (lesson A1); the drift measured while building
  `blts.geojson` is 7.1% on shoulder width, 3.3% on speed and 12.0% on facility
  type, so reading them would have been reading stale data on roughly one
  segment in ten.
* `data/hpms-oregon.geojson` carries HPMS's own `speed` and `through_lanes`
  fields, fetched and deliberately unused — same reasoning as Washington.
  ODOT's point AADT layers (155/156) are **fetched by nobody yet** and are the
  one known unclaimed signal in this state (lesson A8).

## What a rider should check first

1. **Mitchell Point.** Is the State Trail through, on the ground?
2. **US 101 on the coast.** The router now offers a 455-mile line against a
   364-mile signed route, down from 481 with 134 failing miles before the ODOT
   shoulder data landed. Does the remaining 27.5 miles of "failing" match what
   it feels like to ride?
3. **A forest road.** Aufderheide Drive and Corvallis to the Sea both got
   *worse* after the functional-class conflation. If a remote Forest Service
   collector now reads as a busy road, the class proxy is being applied where it
   does not belong — 60% of Oregon is federal land, which is not the network
   Washington's thresholds were tuned on.
