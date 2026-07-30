# Safety model

How a road gets its colour, its verdict, and its routing cost.

## The principle this file exists to enforce

**A setting that sounds objective must have an objective consequence.** If a
control is named like a fact or a permission —
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
| caution | perpendicular rungs in the danger red | `#c25d05` + `#78121f` |
| fails | white diagonal slashes, like hazard tape | `#78121f` + white |
| bikes prohibited | wide translucent dashed ribbon, over the verdict | `#78121f` at 42% |

**The colours were chosen numerically, not by eye.** Search for the pair that
maximises the *smallest* CIELAB distance between any two roles, evaluated under
normal, deuteranope and protanope vision. The original amber left caution only
**dE 13.2** from the bike-network lime — the weakest link in the palette, and
the reason caution and green looked alike. `#c25d05` with `#78121f` pulls them
apart, and both keep the conventional warning/danger reading.

The governing pair is **caution against the bike-network lime under
deuteranopia**, where a bright orange and that lime converge. A note in the code
used to claim the orange was already as deep as it could go without losing that
separation. Measured, the opposite holds — darkening it raises the weakest pair,
because it moves away from the lime by lightness rather than by hue, and hue is
the axis deuteranopia flattens:

| caution | vs lime | vs fail |
|---|---|---|
| `#e8760a` (former) | 14.9 | 59.3 |
| `#c25d05` (current) | **18.3** | 46.3 |
| `#b85604` | 21.0 | 42.7 |

Separation from the maroon fail rungs drawn over the caution falls as the orange
deepens, but stays far above every other pair, so the lime is what sets the
floor.

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

### A drawn route animates its two worst verdicts

On a planned route, failing and cautioning stretches move; everything else is
still. Both animate **size, not opacity** — fading translucent red or amber over
the basemap turns it muddy and can make a rule failure read as an unpaved or
designated-route pattern.

| | throb | casing | amplitude |
|---|---|---|---|
| failure | 6.5 → 9.5 px | 12.5 → 14.5 px | 3.0 px |
| caution | 6.5 → 9.1 px | 11 → 13.6 px | 2.6 px |

A full throb is about 1.5 s. Both carry a white casing that pulses with the
line, which is most of what makes either read from across a screen: an earlier
caution moved 1.1 px with no casing and was invisible on a phone.

The failure still leads, but only just. The two verdicts are told apart by
colour and by the failure's dashes, so the caution does not have to stay quiet
to stay distinct — and a caution nobody notices is not doing its job.

The caution runs a quarter period behind the failure. Sharing one phase made the
whole route appear to breathe as a single animation, which is the opposite of
the point. When a route has neither verdict, both layers rest at their base size
rather than wherever the last animation frame happened to stop.

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
| 8 | `sidewalk-fallback` | would fail the shoulder rung, but has a mapped sidewalk | 3 | `allowSidewalkFallback` |
| 9 | `shoulder` | shoulder under the minimum, no bike lane | 4 | `minShoulder`, `unknownShoulderZero` |
| 10 | `unknown` | no usable data on any criterion | 0 | — |
| 11 | `default` | nothing failed, nothing shortcut it | 2 | — |

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

### No rung lets a designation excuse a road

There was one, and it was removed. `vettedBikeRoutes` and `vettedCountyRoutes`
let a signed route override the wide-road and shoulder failures; both settings
and the rung are gone.

The reason is what signed-route data actually contains. Clallam County's Olympic
Discovery Trail alignment — the most carefully classified route data found in
Washington — runs **58.8 of its 157.9 miles along ordinary road**, and the county
says so in its own `ROUTE_TYPE` field. That road includes **US 101 at 60 mph with
no shoulder**, **SR 112 at 55 mph with two feet**, and **La Push Road at 50 mph
with none**. With the override on, 44 miles of that read as *"passes your rules"*.

OSM's national and regional relations are no better and give you less to work
with: the same trail is a single undifferentiated line that cannot tell you any
of it is highway.

A designation is an agency recommending a way through. It is not a measurement of
the road, and the rules below measure the road. A route drawn along a highway
does not change what the highway is.

Designation still *does* something: it earns a routing preference
(`designated` ×0.94, `strongDesignated` ×0.5 under *Heavily prefer bike routes &
trails*), which makes a qualifying road cheaper to route over. That bonus is
gated on the edge passing, so it can never pull a rider onto a failing road.
Preference, never permission.

### Rung 8/9 — the shoulder rung and its sidewalk fallback

`allowSidewalkFallback` (default on) applies to **rung 9 only**. It fires when
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

For the full method — finding sources, conflating them, and the disciplines that
keep a proxy from becoming a verdict — see `docs/PORTING-TO-ANOTHER-STATE.md`.
What follows is the narrower seam for the traffic-stress rating.

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
| traffic volume (ADT) | **no — shown only** | no |
| bail-out space (derived) | **no — shown only** | no |
| FHWA functional class, road owner | **no — shown only** | no |

Road class stays out of the verdict on purpose. It is an administrative label,
not a physical fact: 81% of "arterials" are one or two lanes, while 15th Ave NE
has four-lane stretches tagged merely `tertiary`. Lane count is the physical
fact, so that is what rung 6 gates on.

## The statewide road measurements

Three sources, imported and displayed, feeding no decision at all yet. They
exist because the app measured 9.2% of its road mileage and estimated the rest,
and that asymmetry had a specific consequence on the ground: the router
preferred a state highway to the quiet county roads beside it, because the
highway was the only thing it had evidence about.

| source | what it gives | coverage |
|---|---|---|
| CRAB certified county road log | bail-out space (derived), ADT + year | 39,187 mi |
| WSDOT non-state functional class | FHWA class, roadway owner | ~19,000 mi |
| WSDOT traffic counts | ADT + year, state routes | ~7,000 mi |

They are matched to OSM ways by span and bearing — every interior sample within
18 m of the source line, headings aligned within 40° — and written identically
into the graph (format 11) and the vector tiles, so the router, the tap card and
the route card read one number.

### Three different kinds of claim, never flattened

This is the whole discipline of the feature, and it is the lesson of the
designated-route mistake: a published line looked like a safety guarantee
because nothing on the card said what kind of thing it was.

- **Traffic volume is a measurement.** `2,357/day (county 2016)`. County and
  state counts are the same kind of fact and are shown the same way; the tag
  says which inventory it came from and when. County counts run 1940–2023 and
  only 24% are 2018 or newer, so the year is doing real work — it needs no
  adjective, and a count with no recorded year shows none rather than implying
  a recent one.

- **Bail-out space is derived**, from operational width minus lanes times lane
  width, per side. It is total edge space, paved or not — somewhere to go when a
  truck comes past — and it is **not a ridable shoulder**. The card shows
  `~5 ft (derived)`; the label and that tag carry the distinction, and this file
  carries the reasoning, because a card that explains itself in prose is a card
  nobody reads. Where a county recorded a through-lane wider than 13 ft it has
  entered half the pavement as the lane, so the lane is assumed to be 12 ft and
  the remainder treated as edge space; those rows are marked, and the error
  direction is conservative — folding a shoulder into a lane makes a road look
  worse, never better.

- **Functional class is a proxy.** Against 113,293 real counts it tracks volume
  monotonically across a 60× spread, from 18,300 vehicles/day at principal
  arterial to 297 at local, which is why it is worth carrying where no count
  exists. It is shown as `Minor collector (FHWA, county)` — as a class, and
  **never converted into a vehicles-per-day figure**. It is assigned by a local agency, reviewed by WSDOT, approved by
  FHWA, and federal-aid eligibility depends on it — so it is an assertion with
  money attached, not a reading off an instrument.

Roadway owner — city, county, town, state — is context and provenance only. It
is never a verdict: "city street" does not mean calm, and W Pioneer Ave in
Puyallup is a city street *and* an urban principal arterial.

### One class, two sources

OSM's `highway` tag and FHWA's functional system answer the same question — what
job does this road do — on two scales. The card showed both, leaving a rider to
reconcile "Secondary road" with "Minor arterial". They are now normalised onto
the **FHWA scale**, because that one is federally standardised and so is the one
that survives leaving Washington.

| OSM | FHWA |
|---|---|
| motorway, motorway_link | Freeway or expressway |
| trunk, primary (+ links) | Principal arterial |
| secondary (+ link) | Minor arterial |
| tertiary (+ link) | Major collector |
| unclassified | Minor collector |
| residential, living_street | Local street |

The correspondence is the conventional US tagging one and it is approximate:
trunk and primary both land on principal arterial, and nothing in OSM
distinguishes an Interstate, so `motorway` reports as freeway rather than
claiming class 1.

Where an official class exists it wins, and the row says which source it came
from — `(FHWA, county)` or `(OSM)`. These are not equally strong claims: FHWA's
is assigned by an agency and reviewed, OSM's is whatever a mapper typed.

**Routing is unchanged by this.** The OSM class still drives the class-based
soft cost exactly as before, and the FHWA class still drives nothing. Making the
official class feed routing where OSM has none is a real improvement and a
separate decision.

### What is deliberately not imported

**Speed limits from any county layer.** The road log carries no speed field, and
the counties' separate speed layers actively hurt: a road known to be pleasant
to ride was re-labelled from an estimated 35 mph to an actual 55 and began
failing. On a rural county road the posted limit is frequently the statutory
default — 50 mph outside cities, RCW 46.61.400 — on a road where no limit was
ever set, which records the absence of a decision rather than a measured hazard.

**The county's reported paved shoulder does not feed the shoulder rule.** It is
carried in its own field and shown on its own row. Writing it into the edge
shoulder would move roads across a rule as a side effect of an import, which is
exactly the kind of silent change this file exists to prevent. Whether it should
is a separate decision, not yet taken.

**Their definition of "urban" is not adopted.** WSDOT's urban/rural descends
from the FHWA *adjusted* urban boundary — the Census line smoothed and extended,
then approved for federal-aid purposes — and is generally larger than ours. Our
own Census 2020 point-in-polygon test remains the sole driver of the urban speed
rule. WSDOT's call is carried only so a disagreement can be seen.

## Every rider setting, and what it objectively does

| setting | UI label | verdict effect | routing effect |
|---|---|---|---|
| `minShoulder` | Minimum shoulder if no bike lane | rung 9 threshold | via the verdict |
| `unknownShoulderZero` | Unknown shoulder = 0 ft | untagged counts as 0 at rung 9 | via the verdict |
| `urbanMaxSpeedNoShoulder` | Urban max speed without shoulder or bike lane | rung 7 threshold | via the verdict |
| `ruralMaxSpeedNoShoulder` | Rural max speed without shoulder or bike lane | rung 7 threshold | via the verdict |
| `maxLanesNoShoulder` | Lanes needing a shoulder or bike lane | rung 6 threshold | also `wideRoad*` cost |
| `upperMaxSpeed` / `noUpperLimit` | Never allow roads faster than | rung 5 | via the verdict |
| `allowSidewalkFallback` | Allow sidewalk fallback | rung 8 exists at all | ×1.9 / ×3.8 / ×8.0 |
| `allowFreeways` | Route over freeway as last resort (still shows as failing) | **none** — a freeway always fails | traversable at all, ×60 |
| `allowMtbTrails` | Allow mountain bike trails | none | traversable at all, `mtbTrail` |
| `requireSafe` | Only show routes fully matching safety rules | none | excludes every level-4 edge |
| `preferPaved` | Strongly prefer paved surfaces | none | surface cost |
| `prefDesig` | Heavily prefer bike routes & trails | none | designation bonus |
| `prefResidential` | Prefer residential streets | none | `residential` bonus |

The first six are named objectively and change the verdict. The rest are
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
| signed bike route | `designated`, `strongDesignated` | a recommendation, worth a detour but not a fact about the road |
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
