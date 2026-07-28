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

| role | texture | colour |
|---|---|---|
| bike lane | solid | `#b7c900` |
| off-street trail | same lime, dark dashed centreline | `#b7c900` + `#4c5c00` |
| passes | solid | `#168ad1` |
| caution | perpendicular rungs in the danger red | `#e8760a` + `#78121f` |
| fails | white diagonal slashes, like hazard tape | `#78121f` + white |
| bikes prohibited | wide translucent dashed ribbon, over the verdict | `#78121f` at 42% |

**The colours were chosen numerically, not by eye.** Search for the pair that
maximises the *smallest* CIELAB distance between any two roles, evaluated under
normal, deuteranope and protanope vision. The original amber left caution only
**dE 13.2** from the bike-network lime — the weakest link in the palette, and
the reason caution and green looked alike. `#e8760a` with `#78121f` raises the
weakest pair to **20.2**, and both keep the conventional warning/danger reading.

The ceiling with the lime and blue fixed is lime-vs-fail at dE 21–24; you
cannot do better without giving up the lime, which is the bike-network identity.
That is why texture, not hue, is the primary signal.

The caution rungs are drawn in the **danger red**, not white: a cautioned road
is one heading toward a failure, and saying so in the same red ties the two
together. Red on this orange holds a 3.69 contrast ratio, above the 3:1 minimum
for a graphical object. Deepening the orange further costs both separation from
the lime and the legibility of those rungs, so it is about as deep as it goes.

A trail and an on-street bike lane share the lime deliberately — both are bike
network — so the difference is carried by the trail's dashed centreline rather
than by a second green.

Patterns are authored at `pixelRatio` 2 and drawn only above
`PATTERN_MIN_ZOOM` (13). Below that a road is a few pixels wide and any texture
smears into a solid line, so lightness carries it alone. `addVerdictPatterns()` builds the tiles. `roads__caution` and `roads__slash`
draw them, and because they are decoration on the road below they take the
**same filter, width, class-masked opacity and Layers toggles** as that line.
Two bugs came from getting this wrong: an overlay filtered on level alone drew
verdicts the rider had switched off, and one with a flat opacity made a failing
freeway and a failing local street fade at different zooms, because only the
line underneath was class-masked.

`roads__vh` carries `maxzoom: PATTERN_MIN_ZOOM` and the slash carries the
matching `minzoom`, so they hand over at exactly one zoom, never both and never
neither. Below it a failure is a **solid** red line, above it the same red
slashed — one symbol gaining detail. It used to be a chunky dash below, which
read as a different symbol entirely and made the handover jarring.

**A prohibited road is a failing road**, the strongest kind, so it keeps its
failure colouring and the prohibition rides **on top** as a wide translucent
dashed ribbon — the same visual grammar as the designated-route ribbon, and
added last so it is the topmost layer of its source. Suppressing the failure in
favour of the prohibition left whole highway corridors, I-5 through the
U-District among them, with no safety colour at all: the strongest verdict we
have was rendering as the absence of one.

A prohibition is a regulatory fact laid over a safety verdict, never a
substitute for it. The **prohibited** overlay is deliberately left as its own dashed line
at every zoom — bikes being banned is a different statement from failing the
rider's rules, and it should not be folded into the same texture.

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
| 8 | `designated` | on a signed bike route, if trusted | 2 (3 with a soft caution) | `vettedBikeRoutes` |
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

### Rung 8 — what trusting a signed route does and does not override

`vettedBikeRoutes` sits at rung 8, so its reach is decided entirely by that
position. It overrides only the failures *below* it:

| failure | rung | overridden by trust |
|---|---|---|
| bikes prohibited | 1 | no |
| freeway | 3 | no |
| speed cap | 5 | no |
| **wide road** | 6 | **yes** |
| **shoulder under the minimum** | **10** | **yes** |

The wide-road failure is overridden in place rather than by moving the rung
above it, because moving it would also pre-empt the slow-road rung and cost a
slow signed street its level 1. A route signed along a wide road is one somebody
decided was ridable, so the lane count is describing a road already vouched for.
556 signed edges (16 mi) are rescued: 289 to a pass, 267 to a caution they pick
up from a limited-access or high-stress modifier.

The speed cap stays absolute so *"Never allow roads faster than"* means what it
says, and prohibitions and freeways are never overridable.

Anything trust overrides also stops being filtered by *Only show routes fully
matching*, since the road then passes.

**A county's signed route is a designated route here.** `facts.designated` is
true for a national, state or county designation alike, so trusting signed routes
trusts all of them, and the wide-road and shoulder overrides above apply to a
county route exactly as they do to a USBR. That is intentional — each is an
agency saying it signs and maintains this road for bicycles — but it does widen
what one setting reaches, so the road card always names the agency that signed
it. The rider can see whose judgement they are trusting. Only **built** county
routes count; see "Adding another county".

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

## Adding another county

A state DOT stops at the state highway system. Everything below it — the county
roads most riding actually happens on — is invisible to WSDOT's layers no matter
how well the county has mapped it. Deer Lake Road on Whidbey is the case that
forced this: it carries Island County's own signed bike route and about 2,000
vehicles a day, and the app knew none of it, because the road is not a state
route.

Counties publish their own data one at a time, in their own GIS orgs, with their
own field names. So a county is **not** a build input to the statewide graph. It
is a bundle, conflated onto the graph at load:

```
scripts/build_county_data.py  →  data/county/<slug>.json(.gz)
county-data.js                →  conflates it onto edges at runtime
```

`graph2.bin.gz` never changes. Adding a county means adding one entry to
`COUNTIES` in the build script and one path to `COUNTY_BUNDLES` in `app.js`.

A bundle carries two things:

| field | what it is | what it does |
|---|---|---|
| `routes[]` | the county's own bike network, each `existing` or `planned` | an **existing** route sets `facts.designated`, exactly like a USBR |
| `traffic[]` | average daily traffic per road segment, with the year counted | **display only** — resolved by position on the card, never conflated onto an edge |

**Planned routes are drawn and never ridden.** `county-data.js` marks only
`existing` routes onto edges, so a planned corridor can never earn a routing
preference. It appears on the map faint and dotted, and its card says so. A plan
is not pavement.

### How a county line becomes a graph edge

Only the bike network is conflated onto edges. Traffic counts change nothing
about routing and both cards resolve them by position from the bundle itself, so
pushing them onto edges as well was duplicated work — and expensive: Island
County's road log is 597 miles of geometry against 33 miles of bike route.
Dropping it, plus integer grid keys and reading the graph's typed arrays instead
of accessors, took the load-time conflation from 994 ms to 75 ms.

County centrelines and OSM centrelines are drawn independently and sit a few
metres apart on the same asphalt, so the match is geometric, with two gates:

- within **18 m** of the edge's *span* (not its midpoint — graph edges average
  ~190 m, so a midpoint test would miss most of a road), and
- pointing the **same way within 40°**, either direction along it.

The bearing gate is what stops a signed route from bleeding onto every side
street that crosses it. Without it, Island County's 33.5 mi of built route
matched 72 mi of graph; with it, 42 mi — the remaining overshoot being edges that
straddle a route's endpoints, which is inherent to edge granularity and errs
toward continuity rather than gaps.

### County traffic counts

Average daily traffic is shown on road and route cards as three things together:
the raw count, a 1–5 rating, and **the year it was taken**.

| rating | vehicles/day | label |
|---|---|---|
| 1 | under 500 | Very light |
| 2 | 500–1,500 | Light |
| 3 | 1,500–3,000 | Moderate |
| 4 | 3,000–8,000 | Heavy |
| 5 | over 8,000 | Very heavy |

The breakpoints follow the volume thresholds used in bicycle level-of-traffic-
stress work, where roughly 1,500 and 3,000 vehicles a day are the points at which
a two-lane road stops feeling shared.

**This rating does not enter the verdict and does not change routing.** Nothing
in `safety-model.js` reads it. That is deliberate on two grounds: coverage is one
county so far, and the counts are wildly uneven in age — of Island County's 4,346
segments, 2,865 were counted before 2010, some as far back as 1977. A number that
old cannot be allowed to fail a road. The card always prints the count year, and
marks anything older than ten years as dated, because a count with no date on it
is a guess presented as a measurement.

If traffic volume is ever promoted into the verdict, it belongs in this document
first, with a stated rule for what a missing or stale count means.

### What a county bundle does not do

The county road log also carries lane width, pavement width and a posted speed
limit. Only the speed is surfaced, and only as a labelled county figure on the
card — it does not override the speed the model uses. Nothing derives a shoulder
from pavement width: on Deer Lake Road the county records "16 ft lanes, no
shoulder", which almost certainly describes 32 ft of pavement with ~4–5 ft of
usable edge per side, but that is an inference from a single entered value and
the county has not asserted a shoulder. Inferring one would put a number the
rider would read as measured behind a rule that fails roads.

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
| county signed bike route (existing) | via rung 8, same as a state one | yes |
| county signed bike route (planned) | **no** | **no** |
| county traffic count (ADT) | **no** | **no** — display only |
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
| bike facility | `facility*` | separated lane or path can justify a detour |
| signed bike route (national, state **or county**) | `designated`, `strongDesignated` | a recommendation, worth a detour but not a fact about the road |
| residential street | `residential` | quieter grid |
| climbing | `climb*SecPerM`, `uphillFactor` | time model plus a preference |
| turns | `turn*Sec` | fewer manoeuvres |
| route diversity | `diversity*` | keeps the five offered routes genuinely different |

### Bonuses

Two multipliers are discounts rather than penalties, and they follow three rules.

**A physical facility always speaks for itself.** If an edge has one, its
`facility*` weight applies and designation is not consulted. These used to
compete through `Math.min`, which was written when `strongDesignated` was 0.86 —
weaker than every facility weight. Lowering it to 0.5 silently inverted that
comparison and made a signed road with no infrastructure beat a road with a
painted bike lane (0.68).

**A signed route earns its bonus unless the edge fails.** A caution does not
disqualify it: the rider's rules are met, and two of the three causes are facts
about the road rather than anything they set. Gating on "passes cleanly" instead
excluded 12,115 of the 17,097 edges where designation is the only preference,
11,576 purely for carrying an LTS 4 rating.

**A WSDOT limited-access edge earns it too.** Its `limited*` penalty is applied
separately and stands on its own; withholding the bonus as well counted it
twice, and priced a signed shoulder route along a state highway identically to
any other highway — the case where a designation carries the most information.

**A county's own signed route earns the same bonus as a state one.** It is the
same kind of claim — an agency put up signs and maintains them — and a rider who
asked to prefer signed routes meant all of them. Only routes the county marks
`existing` are ever flagged, so a planned corridor is never preferred.

Ferries, freeways and dismount edges are still excluded: there, a preference
would erase an access cost rather than express a taste.

Weights live in `DEFAULT_WEIGHTS` (`router-worker.js`), mirrored in `app.js` so
the desktop weight editor stays reproducible. Three modes — direct, balanced,
low-stress — scale most of them; that is what makes routes A–E differ.

**Level 3 does not mean one thing for routing.** A `sidewalk-fallback` caution
carries ×8 in low-stress mode; a `limited-access` caution carries `limited*`;
a `wide-road` or `shoulder` outcome is a fail, not a caution, and is excluded
under strict matching. The card names which one it is for that reason.

## What the map deliberately does not draw

A hiking trail is not bike infrastructure. `OSM_NOT_HIKING_EXPR` removes
`bicycle=no` features on a path, footway, bridleway, track, service way or
steps from every layer of the `osm` source — **4,664 of its 41,625 features,
4,368 mi**, mostly unnamed fragments, and the bulk of the clutter around parks.

Nothing is lost by it: `build_graph.py` drops `bicycle=no` outright, so these
were never routable and existed only to be drawn.

A prohibited **road** is a different matter and stays visible. You might
otherwise consider riding it, so being told you cannot is worth the ink.

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
