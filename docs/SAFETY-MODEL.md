# Safety model

How a road gets its colour, its verdict, and its routing cost.

These rules used to live only in code, in three separate implementations that
had quietly drifted apart — the router avoided a five-lane arterial while the
map painted it as bike network. This file is the single description. **If you
change a rule, change it in every place listed under "Where the ladder lives"
and update this file.**

## The four levels

| level | colour | means |
|---|---|---|
| 1 | blue `#168ad1`, or yellow-green if it is bike network | passes your rules |
| 2 | same as 1 | passes; kept distinct for routing |
| 3 | amber `#a65300` | caution — ride it, but know what it is |
| 4 | red `#b2182b` | fails your rules; excluded when *Only show routes fully matching* is on |
| 0 | grey `#999999` | not enough data to judge |

Colour is **not** decided by level alone. `readoutVerdictColor` checks levels
4, 3 and 0 first, then asks `isBikeNetworkVerdict(n)` — true when the feature
has `infra` or `good_facility`. So a level-1 road with a bike lane draws
yellow-green, and a level-1 road without one draws blue. On the map the same
split is expressed by `bikeNetworkExpr`.

## The verdict ladder

`effectiveLevel(n)` in `app.js`, in order. The first rule that matches wins.

| # | rule | result | setting |
|---|---|---|---|
| 1 | bikes prohibited | 4 | — |
| 2 | true motorway | 4 | `allowFreeways` governs routing, not this verdict |
| 3 | dedicated infrastructure (`infra`) | its own `baseScore` | — |
| 4 | speed over the absolute cap | 4 | `upperMaxSpeed`, `noUpperLimit` |
| 5 | at or over the lane threshold, with no shoulder and no bike lane | 4 | `maxLanesNoShoulder` |
| 6 | slow enough to share the lane | 1 | `urbanMaxSpeedNoShoulder`, `ruralMaxSpeedNoShoulder` |
| 7 | designated bike route, if trusted | 2 | `vettedBikeRoutes` |
| 8 | shoulder under the minimum, no bike facility | 4, or 3 with a sidewalk | `minShoulder`, `unknownShoulderZero`, `allowSidewalkFallback` |
| 9 | no usable data on any criterion | 0 | — |
| 10 | otherwise | 2 | — |

Rule 5 sits **before** rule 6 deliberately. Seattle signed every arterial at
25 mph in 2020, so without it a seven-lane road passes rule 6 outright — which
is exactly what 15th Ave NW in Ballard did.

### What satisfies a shoulder rule

A **shoulder** at or above `minShoulder`, or a **bike lane or better**
(`facility >= 2`). A sharrow is `facility == 1` and satisfies nothing: it is
paint in a shared travel lane, not space of your own. That is why the speed
sliders are named "…without shoulder or bike lane" and the width slider
"Minimum shoulder if no bike lane" — those thresholds only bite a road that has
neither.

### Rule 5 — the lane threshold

The setting is **the count that fails, not the widest road allowed**. At 4, a
four-lane road with neither a shoulder nor a bike lane fails; a three-lane road
passes. The slider is labelled "Lanes needing a shoulder or bike lane" and shows
"4+ lanes" so it reads the way the rule works.

Three things about the count, all deliberate:

- **Every car lane counts, turn lanes included.** OSM's `lanes` already totals
  them, so a road tagged `lanes=3` with `lanes:both_ways=1` is *three* lanes —
  one each way plus a centre turn lane — not four. The road card says
  "3, incl. centre turn lane" for exactly this reason; it used to say
  "3 + centre turn lane", which read as four.
- **No oneway adjustment.** Lanes are taken as tagged. A divided arterial's
  two-lane carriageway therefore counts as two, which is also the traffic you
  actually ride among. The cost is that a 2+2 divided arterial never trips this
  rule; the speed and shoulder rules still apply to it.
- **An unknown shoulder is not proof of space.** A wide road has to *show* a
  shoulder or a bike lane, so a missing `shoulder` tag does not exempt it. This
  is the opposite of how unknown data is treated elsewhere, and is why
  `unknownShoulderZero` has no effect on this rule.

**No sidewalk reprieve.** Unlike rule 8, a mapped sidewalk does not soften this
to a caution. A sidewalk does not make a four-lane road shareable. 10,854 of the
12,453 edges this rule newly fails have a mapped sidewalk, so this choice is
most of the rule's effect, not a corner case.

**Known cost: it can sever a corridor under `requireSafe`.** A 30-route
statewide sweep finds no severance on the default preset, but two on Casual
Cruiser: Longview→Kelso (the Allen Street bridge over the Cowlitz — 4 lanes,
25 mph, no shoulder, and the only crossing) and Renton→Kent (Interurban Ave S
through the Duwamish valley). Both are genuine sole links. The rider sees the
normal "no route fully matching" message and can raise this slider; that is the
intended escape hatch, but re-check it before tightening the default further.

`maxLanesNoShoulder` runs 2–5, then "No limit" at the top stop
(`MAX_LANES_NO_LIMIT`, 6). It stops there because "6 lanes without a shoulder is
fine" is not a rule anyone would choose over switching the rule off. A saved
value from a wider range clamps to the top stop, which reads as No limit.

### Rule 8 — the sidewalk fallback

`allowSidewalkFallback` (default on) applies to **rule 8 only**. It fires when
all of: the setting is on, the sidewalk is positively mapped `present`
(untagged does not count), there is no bike facility, the speed is known and
*above* the no-shoulder limit, and the shoulder is known and *below*
`minShoulder`.

It turns a 4 into a 3 — so "Only show routes fully matching" stops excluding
the road — and adds `Rule override: Sidewalk fallback` to the card. It is not a
soft landing: the router prices it at **×1.9** direct, **×3.8** balanced,
**×8.0** low-stress, so a route takes a long detour to avoid one.

That is worth stating plainly because level 3 means two different things
depending on which rule produced it. A rule-8 caution is heavily avoided. A
limited-access caution (rule 6/7/10, flag 128) carries no such cost.

## Which signals reach which decision

Not every signal we hold is allowed to change a verdict. Several are
deliberately routing-only: they express preference, not safety.

| signal | verdict | routing cost |
|---|---|---|
| bikes prohibited, motorway | yes | yes |
| speed | yes | yes |
| shoulder | yes | yes |
| bike facility type | yes | yes |
| lanes | **yes** (rule 5) | yes |
| WSDOT `LTS_Bicycle` | no — see below | yes |
| OSM road class (secondary/primary/…) | no | yes |
| surface, grade, curve hazard, sidewalk exposure | no | yes |

Road class stays out of the verdict on purpose. It is an administrative label,
not a physical fact: 81% of "arterials" are one or two lanes, while 15th Ave NE
has four-lane stretches tagged merely `tertiary`. Lane count is the physical
fact, so that is what rule 5 gates on.

## Where the ladder lives

Four implementations. All must agree.

| file | form | covers |
|---|---|---|
| `app.js` `effectiveLevel()` | JS, per feature | GeoJSON sources, tap cards |
| `app.js` `roadLevelExpr()` | MapLibre expression | vector road tiles — the map colours |
| `app.js` `routeSegLevel()` | JS, per packed segment | route-segment colours and cards |
| `router-worker.js` `edgeLevel()` | JS, per graph edge | **routing** — the only copy `requireSafe` reads |
| `app.js` `scoreOSM/scoreRoad/scoreBLTS` | JS | normalises each source into the shared shape |
| `scripts/build_osm.py` `classify()` | Python | which ways enter `bikeinfra.geojson` |

A rule added only to `effectiveLevel()` changes what the map says and nothing
about where you are sent. `edgeLevel()` is what excludes an edge under
*Only show routes fully matching*.

Routing cost is separate and lives in `router-worker.js`
(`majorRoadMult`, `trafficStressMult`, `speedStress`, `hazardMult`,
`sidewalkExposureMult`). Its weights are in `DEFAULT_ROUTING_WEIGHTS`, mirrored
in `app.js` so the desktop weight editor stays reproducible. A cost never makes
a road legal or illegal — it only decides which legal road is preferred.

## Data notes worth knowing

- **Lanes** come from OSM `lanes`, falling back to WSDOT `LaneCount`. Coverage
  tracks road importance: ~100% of `secondary`, 3-5% of `residential`. A missing
  tag therefore means "small road", never "unproven", and must leave scoring
  unchanged.
- **On a oneway, `lanes` counts one direction.** A four-lane arterial split into
  two oneway carriageways reads as two lanes each. Rule 5 does **not** correct
  for this — see above — so such an arterial does not trip it.
- **`lanes` includes turn lanes**, and `lanes:both_ways` is a subset of that
  total, not an addition to it. One known gap: when a way tags
  `lanes:forward`/`lanes:backward` but no `lanes`, our fallback sums only those
  two and drops the centre lane. **22 ways statewide**, out of 3,177 with a
  centre turn lane. Fix it in `lane_class()` at the next rebuild.
- **WSDOT `LTS_Bicycle`** covers state highways only, and 79.9% of its segments
  are rated 4. On this dataset it is close to a constant meaning "this is a state
  highway", so it is deliberately kept out of the verdict: the speed and shoulder
  rules infer the same thing more finely, separating a 6 ft shoulder from a 0 ft
  one where the rating flattens both to 4. Letting it decide would either fail
  166k edges or paint almost every highway amber. It stays a routing cost and a
  reported fact on the road card.
- **Shoulder is usually untagged on city streets.** `unknownShoulderZero`
  decides whether that counts against a road.
