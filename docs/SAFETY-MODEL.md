# Safety model

How a road gets its colour, its verdict, and its routing cost.

## The principle this file exists to enforce

**A setting that sounds objective must have an objective consequence.** If a
control is named like a fact or a permission — *Trust designated bike routes*,
*Minimum shoulder if no bike lane*, *Route over freeway as last resort (still shows as failing)*
— then changing it must change the verdict shown on the map in a defined,
reproducible way. A control that sounds like it governs safety but only nudges
routing cost is a lie to the rider.

**The verdict must be traceable on the card.** Every input the verdict consumed
appears on the road and route cards, together with the rule that fired and why,
in plain language. A rider should be able to reconstruct the verdict from the
card without reading code, and the street card and the route card must say the
same thing about the same road.

**Routing may be subjective, but never unexplained.** Choosing among *legal*
roads is a matter of taste, so preferences, weights and soft costs are
legitimate there. Every one of them is enumerated under "Routing cost" below. A
cost may never make a road pass or fail — that is the verdict's job alone.

**This file is the specification, not a summary of the code.** If the code and
this file disagree, the code is wrong.

## One definition, four readers

The ladder lives in **`safety-model.js`** and nowhere else. Each caller
normalises its own storage into the same `facts` object and asks:

| caller | adapter | used for |
|---|---|---|
| `app.js` `effectiveLevel()` | `factsOf()` | tap cards, GeoJSON sources |
| `app.js` `fallbackRouteLevel()` | `routeSegFacts()` | route segments |
| `router-worker.js` `edgeLevel()` | `edgeFacts()` | **routing** — the only copy `requireSafe` reads |
| `app.js` `roadLevelExpr()` | — | vector road tiles (the map colours) |

The fourth cannot share the code: MapLibre evaluates it declaratively in the
renderer. It is instead cross-checked against the model over ~1.2M
property/rule combinations by `scripts/test_safety_model.mjs`, which is how a
divergence in the sidewalk-fallback branch was caught.

This structure exists because the ladder was previously written out four times
and drifted. Two bugs reached riders as a result: a sharrowed road drawn red
whose card read *"Verdict: Passes your rules"* above *"Why: Fails: shoulder
unknown"*, and a wide-road rule added to the display copy alone, which changed
what riders were told and nothing about where they were sent.

## The four levels

| level | colour | means |
|---|---|---|
| 1 | blue `#168ad1`, or yellow-green if it is bike network | passes your rules |
| 2 | same as 1 | passes; kept distinct for routing |
| 3 | amber `#a65300` | caution — ride it, but know what it is |
| 4 | red `#b2182b` | fails your rules; excluded when *Only show routes fully matching* is on |
| 0 | grey `#999999` | not enough data to judge |

### Texture carries the verdict, not hue

Simulated against deuteranopia and protanopia, the fail red, the caution amber
and the bike-network green all collapse into one olive family. Only the pass
blue survives. Hue therefore cannot be the signal, so each verdict has a
texture, and the colours are chosen for **lightness** separation rather than
hue separation:

| verdict | texture | colour |
|---|---|---|
| prohibited / fails | white diagonal slashes, like hazard tape | `#b2182b` with white |
| caution | perpendicular ticks, like rungs across the road | `#efab3c` with white |
| passes | solid | `#168ad1` |
| bike network | solid | `#b7c900` |

Caution's amber was lightened from `#a65300`: against the fail red that scored a
contrast ratio of **1.26** — the same tone — so once hue collapsed there was
nothing left to tell them apart. `#efab3c` scores **3.45**.

Patterns are authored at `pixelRatio` 2 and drawn only above
`PATTERN_MIN_ZOOM` (13). Below that a road is a few pixels wide and any texture
smears into a solid line, so lightness carries it alone. `addVerdictPatterns()`
builds the tiles; `roads__caution` and `roads__slash` draw them over the solid
colour, are re-filtered whenever the rules change, and — because they are
decoration on the road below — carry the **same category filter and the same
Layers toggles** as that road. An overlay that ignores the toggles will draw
verdicts a rider has switched off.

Colour is **not** decided by level alone. `readoutVerdictColor` checks levels
4, 3 and 0 first, then asks `isBikeNetworkVerdict(n)` — true when the feature
has `infra` or `good_facility`. So a level-1 road with a bike lane draws
yellow-green, and a level-1 road without one draws blue. On the map the same
split is expressed by `bikeNetworkExpr`.

## The verdict ladder

`evaluate(facts, rules)` in `safety-model.js`, in order. The first rung that
matches wins, and its name is returned as `rule` — the card's headline and its
explanation are both generated from that one answer, so they cannot describe
different rules.

| # | `rule` | condition | result | setting |
|---|---|---|---|---|
| 1 | `prohibited` | bikes banned (OSM `bicycle=no`, WSDOT restriction) | 4 | — |
| 2 | `ferry` | a boat, not a road | 2 | — |
| 3 | `freeway` | a true motorway | 4 | — (see below) |
| 4 | `infra` | dedicated bike infrastructure | its own `infraScore` | — |
| 5 | `speed-cap` | speed over the absolute ceiling | 4 | `upperMaxSpeed`, `noUpperLimit` |
| 6 | `wide-road` | at or over the lane threshold, no shoulder and no bike lane | 4 | `maxLanesNoShoulder` |
| 7 | `slow-road` | slow enough to share the lane | 1 | `urbanMaxSpeedNoShoulder`, `ruralMaxSpeedNoShoulder` |
| 8 | `designated` | on a signed bike route, if trusted | 2 | `vettedBikeRoutes` |
| 9 | `sidewalk-fallback` | would fail the shoulder rung, but has a mapped sidewalk | 3 | `allowSidewalkFallback` |
| 10 | `shoulder` | shoulder under the minimum, no bike lane | 4 | `minShoulder`, `unknownShoulderZero` |
| 11 | `unknown` | no usable data on any criterion | 0 | — |
| 12 | `default` | nothing failed, nothing shortcut it | 2 | — |

### Soft cautions — the two modifiers

Two facts can turn a **pass** into a caution without ever failing a road. They
apply to rungs 7, 8 and 12 only; a road that failed higher up is untouched, and
so is dedicated infrastructure, which returns at rung 4 before either is
consulted.

| modifier | setting | why it can only caution |
|---|---|---|
| limited-access highway, bike-legal | — (a fact, not a choice) | the road meets your rules; the hazard is its type |
| official stress rating ≥ 4 | — (a fact, not a choice) | see below |

When both apply, limited-access wins the headline: it is the more specific
statement about the road.

`evaluate()` returns `caution` naming which one fired, and the card headline,
the "Why" line and the help list are all generated from that key.

### Why an official stress rating can only ever caution

WSDOT publishes a **Level of Traffic Stress** (the Mekuria/Furth scale, 1 low to
4 high) for state highways. Among segments that carry a rating, **79.9% are 4**
(61.8% of all segments; the rest are unrated). On this data the rating is close
to a constant meaning "this is a state highway".

That makes it useless as a gate and valuable as a warning:

- **As a fail** it would sever ~166k edges — every state highway at once.
- **As the only signal** it would tell you nothing, because it says 4 almost
  everywhere it says anything.
- **As a caution** it is honest: the road meets your measured rules, and the
  agency that owns it still rates it at the top of the stress scale.

68,190 edges (2,792 mi) move from pass to caution on the
default preset; 6,088 (138 mi) on Casual Cruiser, where the tighter speed rules
already fail most of them. It changes no routing cost and can sever nothing, because `requireSafe`
excludes only level 4. There is no setting for it: an official rating is a fact
about the road, and a caution costs the rider nothing to be told.

### Rung 3 — freeways, and why the toggle is not a verdict

A motorway **always** fails. `allowFreeways` — *"Route over freeway as last
resort (fails)"* — is a **routing permission**, not a safety opinion:

- **off**: the router may not traverse a freeway edge at all.
- **on**: it may, as a genuine last resort (×60 cost), and those segments report
  as failing and count toward the route's "fails rules" mileage.
- **on, with strict matching**: the segments are level 4, so they are excluded
  anyway. The toggle is inert.

The label carries "(still shows as failing)" so the rider can see that the
verdict is fixed and they are only choosing whether the router may use a failing
road. Freeways are also excluded from the terminal-access carve-out that
otherwise lets short failing blocks be used at a leg's endpoints — nobody's
driveway is on a motorway, and the label has to mean excluded whenever failing
roads are.
| 10 | otherwise | 2 | — |

The lane rung sits **before** the slow-road rung deliberately. Seattle signed every arterial at
25 mph in 2020, so without it a seven-lane road passes rule 6 outright — which
is exactly what 15th Ave NW in Ballard did.

### What satisfies a shoulder rule

A **shoulder** at or above `minShoulder`, or a **bike lane or better**
(`facility >= 2`). A sharrow is `facility == 1` and satisfies nothing: it is
paint in a shared travel lane, not space of your own. That is why the speed
sliders are named "…without shoulder or bike lane" and the width slider
"Minimum shoulder if no bike lane" — those thresholds only bite a road that has
neither.

**`facility >= 2` must be the threshold in every implementation.** When it was
`>= 2` in `app.js` but `> 0` in `router-worker.js`, a sharrowed road with no
shoulder drew red and its card read *"Verdict: Passes your rules"* directly
above *"Why: Fails: shoulder unknown"* — the Verdict line reads the worker's
`edgeLevel` via `p.level`, the Why line and the colour re-derive from `app.js`.
Any drift between the two shows up as a self-contradicting card, and lets
`requireSafe` route down roads the map paints as failing.

### Rung 6 — the lane threshold

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

**No sidewalk reprieve.** Unlike the shoulder rung, a mapped sidewalk does not soften this
to a caution. A sidewalk does not make a four-lane road shareable. 10,854 of the
12,453 edges this rule newly fails have a mapped sidewalk, so this choice is
most of the rule's effect, not a corner case.

**It can sever a corridor under `requireSafe`, and that is accepted.** A
30-route statewide sweep finds no severance on the default preset, and two on
Casual Cruiser: Longview→Kelso (the Allen Street bridge over the Cowlitz —
4 lanes, 25 mph, no shoulder, and the only crossing) and Renton→Kent
(Interurban Ave S through the Duwamish valley). Both are genuine sole links.

This is a deliberate choice, not a defect to engineer around: if the only way
through is a road the rider's own rules reject, *"no route fully matching"* is
the honest answer. Inventing a pass for it would make every other verdict less
trustworthy. The rider gets the standard message and can raise this slider or
turn off strict matching.

Do keep measuring it, though — a future tightening (default 3, or a stricter
`minShoulder`) should be swept the same way so the severance count is a known
number rather than a surprise.

`maxLanesNoShoulder` runs 2–5, then "No limit" at the top stop
(`MAX_LANES_NO_LIMIT`, 6). It stops there because "6 lanes without a shoulder is
fine" is not a rule anyone would choose over switching the rule off. A saved
value from a wider range clamps to the top stop, which reads as No limit.

### Rung 9/10 — the shoulder rung and its sidewalk fallback

`allowSidewalkFallback` (default on) applies to **rung 10 only**. It fires when
all of: the setting is on, the sidewalk is positively mapped `present`
(untagged does not count), there is no bike facility, the speed is known and
*above* the no-shoulder limit, and the shoulder is known and *below*
`minShoulder`.

It turns a 4 into a 3 — so "Only show routes fully matching" stops excluding
the road — and adds `Rule override: Sidewalk fallback` to the card. It is not a
soft landing: the router prices it at **×1.9** direct, **×3.8** balanced,
**×8.0** low-stress, so a route takes a long detour to avoid one.

That is worth stating plainly because level 3 means two different things
depending on which rung produced it, which is why `readoutVerdict` names the
rung: "Caution — sidewalk instead of a shoulder" versus "Caution —
limited-access highway".

## Adding another state

The safety model knows about a **rating**, never an agency. `facts.stressRating`
is a Level of Traffic Stress from 1 to 4 on the published scale; nothing in
`safety-model.js` mentions WSDOT, and nothing may.

To add, say, Arizona:

1. Write a build step that produces an LTS 1–4 per edge from ADOT's data,
   normalising their scale to 1–4 if it differs, into the same `eLanes`-adjacent
   `eLts` byte that `scripts/build_blts.py` fills today.
2. Change `STRESS_AGENCY` in `app.js` — the one place the name is written. It
   feeds the road card, the setting label and the explanation text.
3. Nothing else. The rung, the modifier, the map expression, the help list and
   the tests all work unchanged.

The same seam already exists implicitly for three other signals, all currently
WSDOT-sourced and all following the same shape — **OSM is the universal base, a
state authority enriches it**:

| signal | universal source | state authority adds |
|---|---|---|
| speed limit | OSM `maxspeed`, else class estimate | legal speeds |
| limited access | — | the limited-access flag |
| bicycle prohibition | OSM `bicycle=no` | permanent restrictions |
| traffic stress | — | Level of Traffic Stress |

Urban/rural context comes from the US Census and is already national.

## Which signals reach which decision

Not every signal we hold is allowed to change a verdict. Several are
deliberately routing-only: they express preference, not safety.

| signal | verdict | routing cost |
|---|---|---|
| bikes prohibited, motorway | yes | yes |
| speed | yes | yes |
| shoulder | yes | yes |
| bike facility type | yes | yes |
| lanes | **yes** (rung 6) | yes |
| official stress rating (LTS) | **caution only**, always on | yes |
| OSM road class (secondary/primary/…) | no | yes |
| surface, grade, curve hazard, sidewalk exposure | no | yes |

Road class stays out of the verdict on purpose. It is an administrative label,
not a physical fact: 81% of "arterials" are one or two lanes, while 15th Ave NE
has four-lane stretches tagged merely `tertiary`. Lane count is the physical
fact, so that is what rung 6 gates on.

## Every rider setting, and what it objectively does

| setting | UI label | verdict effect | routing effect |
|---|---|---|---|
| `minShoulder` | Minimum shoulder if no bike lane | rung 10 threshold | via the verdict |
| `unknownShoulderZero` | Unknown shoulder = 0 ft | untagged counts as 0 at rung 10 | via the verdict |
| `urbanMaxSpeedNoShoulder` | Urban max speed without shoulder or bike lane | rung 7 threshold | via the verdict |
| `ruralMaxSpeedNoShoulder` | Rural max speed without shoulder or bike lane | rung 7 threshold | via the verdict |
| `maxLanesNoShoulder` | Lanes needing a shoulder or bike lane | rung 6 threshold | also `wideRoad*` cost |
| `upperMaxSpeed` / `noUpperLimit` | Never allow roads faster than | rung 5 | via the verdict |
| `allowSidewalkFallback` | Allow sidewalk fallback | rung 9 exists at all | ×1.9 / ×3.8 / ×8.0 |
| `vettedBikeRoutes` | Trust designated bike routes | rung 8 exists at all | via the verdict |
| `allowFreeways` | Route over freeway as last resort (still shows as failing) | **none** — a freeway always fails | traversable at all, ×60 |
| `allowMtbTrails` | Allow mountain bike trails | none | traversable at all, `mtbTrail` |
| `requireSafe` | Only show routes fully matching safety rules | none | excludes every level-4 edge |
| `preferPaved` | Strongly prefer paved surfaces | none | surface cost |
| `prefDesig` | Heavily prefer bike routes & trails | none | designation bonus |
| `prefResidential` | Prefer residential streets | none | `residential` bonus |

The first eight are named objectively and change the verdict. The last six are
named as permissions or preferences and change only where you are sent — which
is what their names promise.

## What makes a road caution

Amber never means "failed". It means the road meets the rider's rules and there
is something about it they should know. Routes use these roads freely, including
under *Only show routes fully matching safety rules*, which excludes level 4
only.

| cause | key | meaning |
|---|---|---|
| limited-access highway | `limited-access` | bike-legal, meets your rules, but it is highway shoulder riding past ramps |
| sidewalk instead of a shoulder | `sidewalk-fallback` | fails your shoulder rule; a mapped sidewalk stands in, and routes avoid it strongly |
| officially rated high stress | `high-stress` | the state DOT rates it 4 of 4 on the LTS scale |
| dismount required | `dismount` | legal to bring a bike, but you must walk it |

`SafetyModel.CAUTION_CAUSES` is that list, and the in-app help section "What
makes a road caution?" is **generated from it** by `buildCautionCauseHelp()`, so
a fifth cause cannot be added without appearing in help. A test asserts every
entry has both a name and a description.

Note that the causes carry very different routing costs — a sidewalk fallback is
×8 in low-stress mode, a high-stress rating is priced through
`trafficStressMult`, and a limited-access caution is barely priced at all. Amber
is one colour over several meanings, which is why the card names which.

## Routing cost

Subjective by design: it chooses among *legal* roads and never makes one legal
or illegal. Every multiplier applied to an edge, in `router-worker.js`:

| influence | function / weight | what it expresses |
|---|---|---|
| speed above the comfort limit | `speedStress` | graded pressure toward slower roads |
| curve/grade hazard | `hazardMult` | recorded hazard on the edge |
| road class | `majorRoadMult`, `arterial*` | tertiary < secondary < primary |
| lanes and WSDOT LTS | `trafficStressMult`, `wideRoad*`, `stressedRoad*` | traffic exposure; paint gives partial relief, a separated lane full |
| urban road tagged `sidewalk=no` at 30+ mph | `sidewalkExposureMult` | nowhere to bail out |
| riding on the sidewalk fallback | `sidewalkFallbackMult` | ×1.9 direct, ×3.8 balanced, ×8.0 low-stress |
| freeway | `freeway` (×60) | last resort only |
| WSDOT limited access | `limited*` | bike-legal but unpleasant |
| mountain-bike trail | `mtbTrail` | opt-in, heavily penalised |
| bike facility | facility bonus | separated lane or path can justify a detour |
| residential street | `residential` | quieter grid |
| climbing | `climb*SecPerM`, `uphillFactor` | time model plus a preference |
| turns | `turn*Sec` | fewer manoeuvres |
| route diversity | `diversity*` | keeps the five offered routes genuinely different |

Weights live in `DEFAULT_WEIGHTS` (`router-worker.js`), mirrored in `app.js` so
the desktop weight editor stays reproducible. Three modes — direct, balanced,
low-stress — scale most of them; that is what makes routes A–E differ.

**Level 3 does not mean one thing for routing.** A `sidewalk-fallback` caution
carries ×8 in low-stress mode; a `limited-access` caution carries `limited*`;
a `wide-road` or `shoulder` outcome is a fail, not a caution, and is excluded
under strict matching. The card names which one it is for that reason.

## Data notes worth knowing

- **Lanes** come from OSM `lanes`, falling back to WSDOT `LaneCount`. Coverage
  tracks road importance: ~100% of `secondary`, 3-5% of `residential`. A missing
  tag therefore means "small road", never "unproven", and must leave scoring
  unchanged.
- **On a oneway, `lanes` counts one direction.** A four-lane arterial split into
  two oneway carriageways reads as two lanes each. Rung 6 does **not** correct
  for this — see above — so such an arterial does not trip it.
- **`lanes` includes turn lanes**, and `lanes:both_ways` is a subset of that
  total, not an addition to it. One known gap: when a way tags
  `lanes:forward`/`lanes:backward` but no `lanes`, our fallback sums only those
  two and drops the centre lane. **22 ways statewide**, out of 3,177 with a
  centre turn lane. Fix it in `lane_class()` at the next rebuild.
- **The WSDOT stress layer carries no motorway flag.** An Interstate express
  lane therefore arrived looking like any other limited-access highway and was
  described as a caution — "ride it with caution" on a road bikes may not use.
  `isWsdotInterstate()` recovers the fact from the route id (prefixes 005, 082,
  090, 182, 205, 405, 705 — 11,098 of 55,271 segments), so those fail instead.
- **WSDOT `LTS_Bicycle`** covers state highways only, and 79.9% of its segments
  are rated 4. On this dataset it is close to a constant meaning "this is a state
  highway", so it is deliberately kept out of the verdict: the speed and shoulder
  rules infer the same thing more finely, separating a 6 ft shoulder from a 0 ft
  one where the rating flattens both to 4. Letting it decide would either fail
  166k edges or paint almost every highway amber. It stays a routing cost and a
  reported fact on the road card.
- **Shoulder is usually untagged on city streets.** `unknownShoulderZero`
  decides whether that counts against a road.
