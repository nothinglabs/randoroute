# Safety model

How a road gets its colour, its verdict, and its routing cost.

## The principle this file exists to enforce

**A setting that sounds objective must have an objective consequence.** If a
control is named like a fact or a permission —
*Minimum shoulder width to count as safe-ish*, *Route over freeway as last resort (still shows as failing)*
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

## A shoulder can depend on which way you ride

WSDOT surveys each **direction** of a state highway separately, and the two
genuinely disagree. On SR 104 at Kingston one point carries 0 ft one way and
5–6 ft the other; across 56 segments there the values are 0 ft ×20, 6 ft ×21,
5 ft ×9. Measured on the shipped graph:

| | edges | miles |
|---|---|---|
| shoulder differs by direction | 58,995 | — |
| **verdict** differs by direction | 10,656 | 333 |
| passes one way, **fails** the other | 2,564 | 45 |

The direction is encoded in WSDOT's route id: `i` for increasing milepost, `d`
for decreasing. 712 routes carry both.

**The route was always right.** `router-worker.js` scores each segment with
`edgeFacts(edge, forward)` and carries `edgeShoulder(edge, forward)`, so a drawn
route has always reflected the direction of travel, and the graph stores `esh`
and `esh_ba` separately for exactly this.

**The card was not.** It printed whichever of the two WSDOT features the tap
landed on, with nothing indicating a second answer existed — so a road could
read *"Shoulder 0 ft"* above *"Passes your rules"* while the router used 6 ft for
the way you were actually going. It now names both when they disagree, and says
nothing extra when they agree.

**The background road layer stays worst-case.** It draws one line for a road
with two answers, and of the two the safe reading is the one that can never make
a road look better than it might be.

Precedence for the shoulder itself, in `build_graph.py`: OSM tags are the base,
WSDOT `ShoulderWidth` overrides per direction where a match exists, and the CRAB
county paved shoulder is deliberately **never** written into it — it travels in
its own field so that adding a source cannot quietly move a road across a rule.

## The facts contract

The ladder was always shared. **The object handed to it was not**, and that is
where every "two views disagree about one road" bug came from.

`app.js` built the facts shape from normalised props, `router-worker.js` built
its own from typed arrays, and each of the five scorers filled whichever subset
its author remembered. Nothing checked them, because a forgotten field is not an
error in JavaScript — it is `undefined`, which the model reads as *unknown*,
which is a perfectly valid answer. Two shipped consequences:

- **SR 104 at Kingston** drew as failing, the card said *"nothing here demands
  space of its own"*, and the route over it coloured as passing. `scoreBLTS`
  never put AADT into the facts, so the card ignored a count it was printing two
  lines below the verdict.
- **`factsOf` read `n.facility` and no scorer ever set it**, so on every card a
  separated path and a painted lane were the same road.

Neither was a logic error. Both were omissions that looked like data.

What now enforces it, all in `safety-model.js`:

| piece | job |
|---|---|
| `FACT_KEYS` | the entire vocabulary — 16 facts, nothing else is a fact |
| `factsFrom(n)` | the only supported builder from normalised props; fills every key |
| `sealFacts(f)` | the same guarantee for builders that assemble directly, like the worker's `edgeFacts` |
| `missingFactKeys(f)` | how a test catches an omission at its source |
| `SOURCE_FACTS` | which facts each source *can* supply — a written-down gap, not an accidental one |

`test_fact_contract.mjs` holds every source to that declaration against **real
tile and graph data**: a fact claimed but never populated is a broken adapter, a
fact populated but not claimed means the table is stale, and shared facts must
agree on type and units across sources.

Two things it caught immediately. `scoreBLTS` was assigning WSDOT's **LTS stress
rating** to `baseScore`, which `factsFrom` maps to `infraScore` — the model's
answer to "how good is this bike infrastructure". Two unrelated meanings in one
field, inert only because `infra` is false for that source. And `good_facility`,
a coarse "there is something here" flag, was *lowering* a known facility level
to the riding-space floor; it may now only raise one.

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
renderer. It is instead cross-checked against the model over 18.1M
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
| 3 | burnt orange `#c25d05` | caution — ride it, but know what it is |
| 4 | maroon-red `#a51c30` | fails your rules; excluded when *Only show routes fully matching* is on |
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
| caution | perpendicular rungs in the danger red | `#c25d05` + `#a51c30` |
| fails | dashed, with the map showing through the gaps | `#a51c30` |
| bikes prohibited | wide translucent dashed ribbon, over the verdict | `#a51c30` at 42% |

**The colours were chosen numerically, not by eye.** Search for the pair that
maximises the *smallest* CIELAB distance between any two roles, evaluated under
normal, deuteranope and protanope vision. The original amber left caution only
**dE 13.2** from the bike-network lime — the weakest link in the palette, and
the reason caution and green looked alike. `#c25d05` with `#a51c30` pulls them
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
smears into a solid line, so lightness carries it alone. `addVerdictPatterns()`
builds the tiles and `roads__caution` draws them; because the rungs are
decoration on the road below they take the **same filter, width, class-masked
opacity and Layers toggles** as that line. Two bugs came from getting this
wrong: an overlay filtered on level alone drew verdicts the rider had switched
off, and one with a flat opacity made a failing freeway and a failing local
street fade at different zooms, because only the line underneath was
class-masked.

**A failure is a dash, not a pattern, and it is the same dash at every zoom.**
`roads__vh` carries level 4 alone — no `maxzoom`, no handover — as a
`FAIL_DASH` of `[2.6, 1.3]` in the fail red. A dasharray is authored in
line-width multiples, so it scales with the road rather than changing symbol at
a threshold. The gaps are genuinely transparent: `visibleRoadCategoryFilter()`
never matches level 4, so nothing paints underneath and the map shows through.
`roads__fail` (the grey pass/fail dash) stops at level 3 and `roads__vh` no
longer defers to it, so exactly one layer draws a failing road in either
display mode.

This replaced white diagonal slashes drawn above z13, which were wrong twice
over. They were `PATTERN_PROHIBITED` — the very image the bikes-prohibited
layer draws — so above z13 a road that merely fails your rules and a road
bicycles may not legally use were the same symbol. And they existed only above
z13, so a road changed appearance as the rider zoomed without anything about
the road changing. Removing the white, nearly 40% of that pattern's pixels, is
what makes the line read darker; the numerically-optimised palette above is
untouched. `test_fail_road_style.mjs` walks the rendered pixels at z12 and z15
and asserts ink and gaps at both.

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

### A drawn route animates its two worst verdicts, differently

On a planned route, failing and cautioning stretches move; everything else is
still. They do not move the same way, and that is the point:

| | texture | motion |
|---|---|---|
| **caution** | **solid**, orange | **radiates sideways** — the line is still; a blurred orange halo under the casing swells 13 → 26 px, 0.28 → 0.62 opacity, 3 → 7 blur, about 1.5 s a throb |
| **failure** | perpendicular ticks, red | **ticks travel along the line** — steady width, eight frames of dash pattern |

Motion has two axes here: across the line and along it. Each verdict gets one,
and never the other — nothing about the radiating verdict travels along the
route, and nothing about the marching one swells sideways.

An earlier version gave the caution a smaller version of the failure's throb.
That reads as "a bit less bad", not as a different verdict — the rider has to
compare two amplitudes to tell them apart, which is not something a glance can
do. Two different *kinds* of motion need no comparison.

A later version fixed the motion but not the texture: both verdicts were drawn
as broken warm lines on white casings, both animating, which is one visual event
however different the code is. Only one of them may be dashed at a time.

Which verdict gets which effect is a presentation choice, not a rule, and it has
been swapped once. It is declared in `setRoutePulses()` — `HALO_LAYER` and
`TICK_LAYER` — and nowhere else, so swapping is one edit. `test_route_pulse.mjs`
reads the wiring from there rather than restating it: what the test pins is that
the two motions differ in **kind** and that neither borrows the other's, not
which verdict currently has which.

The radiating verdict's core line is deliberately constant — crisp, unmoving,
full opacity. Pulsing the line itself is what made a verdict hard to fix the eye
on; moving the animation into a halo leaves something definite to look at.

Neither verdict animates the *line's* opacity: fading translucent red or amber
over the basemap turns it muddy and can make a rule failure read as an unpaved
or designated-route pattern. The halo is a separate layer under the white
casing, so its opacity never crosses the line colour.

The halo's blur grows more slowly than its width (3 → 7 against 13 → 26).
Matching them spread it thin enough at full swell that it vanished into a busy
basemap, which is the opposite of what a failure should do.

Under `prefers-reduced-motion` the halo holds wide and steady (19 px,
0.48 opacity) rather than disappearing — the halo *is* the verdict, not
decoration on top of it.

A caution at rest keeps its ticks. The texture carries the verdict whether or
not anything is moving, so it still reads in a screenshot.

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
| 6 | `slow-street` | a RECORDED limit of 15 mph or under | 1 | — |
| 7 | `needs-space` | too fast, too wide **or** too busy to share, and no shoulder or bike lane | 4 | `maxSpeedNoShoulder`, `lanesNoShoulderOver`, `busyNoShoulder`, `minShoulder` |
| 8 | `sidewalk-fallback` | would fail rung 7, but has a mapped sidewalk | 3 | `allowSidewalkFallback` |
| 9 | `shares-lane` | nothing about the road demands space of its own | 1 | — |
| 10 | `unknown` | no usable data on any criterion | 0 | — |
| 11 | `default` | needs space and has it | 2 | — |

A road that trips the needs-space rung and *does* have the space falls through
to `default` at level 2. That is deliberate: it is not the same thing as a
quiet lane, so it does not get the quiet lane's level 1.

`slow-street` (`SLOW_STREET_MAX_MPH`, 15) short-circuits the entire
needs-space family below it — shoulder, lanes, traffic count, sidewalk
fallback — AND the high-stress soft caution: at parking-lot speeds the rider
shares whatever space there is, and no warning teaches anything. Only a
recorded speed limit earns the shortcut; an unknown speed never does, and the
limited-access caution survives it (a 15 mph ramp is still a ramp). It sits
below `speed-cap` so "Never allow roads faster than" keeps meaning what it
says, and below `infra`, whose own score already governs dedicated paths.

### Soft cautions — the two modifiers

Two facts can turn a **pass** into a caution without ever failing a road. They
apply to rungs 8 and 10 only; a road that failed higher up is untouched, and
so is dedicated infrastructure, which returns at rung 4 before either is
consulted.

| modifier | setting | why it can only caution |
|---|---|---|
| limited-access highway, bike-legal | — (a fact, not a choice) | the road meets your rules; the hazard is its type |
| official stress rating ≥ 4 | — (a fact, not a choice); never applies where the road has a bike lane | see below |

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
excludes only level 4.

### A bike lane means the road passes — and is not therefore bike network

The stress caution is for roads whose space is not the rider's. A bike lane of
any kind is space that is, so the caution never applies to one. This is uniform
for every rider and has no setting: it is a statement about what a bike lane IS,
not a preference about how much risk to accept.

It suppresses the stress caution ONLY:

- it cannot reach a rung above — a bike lane over the rider's speed ceiling
  still fails, and so does a freeway or a prohibition;
- it does not clear `limited-access`, which is about ramps crossing the rider's
  path rather than about traffic (0 mi carry both today);
- physically separated lanes and shared-use paths never reach it at all. They
  return at the `infra` rung, above everything except `prohibited` and
  `freeway`.

**But the road does not become bike network.** Lime is a recommendation, not an
inventory. A painted lane on a road the agency rates 4 of 4 draws **blue**, with
the other passing roads: the rider is entitled to that space, and it is not a
lane worth advertising. `isBikeNetworkVerdict()` withholds the credit on the
rating, `bikeNetworkExpr()` says the same thing to the renderer for the `roads`
and `blts` tiles, and `isBikeNetwork()` in route-details.js mirrors both.
Separated lanes and paths are exempt — physical separation IS the credit, and a
rating cannot take it away.

**No route moves.** `modeMult` prices levels 2 and 3 identically — only 4 is
penalised and 1 gets the comfy-road bonus — and the traffic-stress penalty lives
in `trafficStressMult`, which reads the rating directly and never asks the
verdict. The facility bonus is likewise priced from the facility, not the
colour. So this decides the verdict, the colour, the route card's percentages
and what the voice says, and nothing else.

Scale: **107 mi across 3,815 edges** — 4.3% of the high-stress cautions, of
which 3,781 are a plain bike lane and 34 a buffered one.

The rating is still reported whatever the verdict — `evaluate()` returns
`highStress` at every level, the road card's traffic-stress row is
unconditional, and the spoken announcement carries it as an aside. The voice
describes the ROAD rather than the colour, so one of these draws blue and is
still announced as a bike lane:

    Bike lane, heavy traffic in 500 feet, for 2.1 miles.

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

### What satisfies a shoulder rule

A **shoulder** at or above `minShoulder`, or a **bike lane or better**
(`facility >= 2`). A sharrow is `facility == 1` and satisfies nothing: it is
paint in a shared travel lane, not space of your own. That is why the speed
sliders are named "…without shoulder or bike lane" and the width slider
"Minimum shoulder width to count as safe-ish" — those thresholds only bite a road that has
neither.

**`facility >= 2` must be the threshold in every implementation.** When it was
`>= 2` in `app.js` but `> 0` in `router-worker.js`, a sharrowed road with no
shoulder drew red and its card read *"Verdict: Passes your rules"* directly
above *"Why: Fails: shoulder unknown"* — the Verdict line reads the worker's
`edgeLevel` via `p.level`, the Why line and the colour re-derive from `app.js`.
Any drift between the two shows up as a self-contradicting card, and lets
`requireSafe` route down roads the map paints as failing.

### Rung 6 — one rung, three triggers

Speed, lanes and traffic are three ways of asking one question: **how much of
this lane is actually available to a rider?** They are therefore a single rung,
and the settings read as one sentence in the panel:

> **Require a bike lane or safe-ish width shoulder.**
> Speed limit is over — `maxSpeedNoShoulder`
> Lanes of traffic more than — `lanesNoShoulderOver`
> Road is busier than — `busyNoShoulder`
>
> Minimum shoulder width to count as safe-ish — `minShoulder`

The three triggers are **ORed**. Any one of them means the road needs space of
its own; the road then fails only if it does not have any. `spaceReasons()`
returns *every* trigger that fired, and the card names all of them — "Fails:
needs a bike lane or a safe-ish-width shoulder — 45 mph, 4 lanes". Naming only the first
would invite a rider to change the wrong setting.

**They were separate rungs and the ordering was a bug.** A `wide-road` rung sat
above a `slow-road` rung specifically because Seattle signed every arterial at
25 mph in 2020, so on speed alone a seven-lane road passed outright — which is
exactly what 15th Ave NW in Ballard did. That ordering was load-bearing and
invisible. Merged, there is no order left to get wrong.

#### Trigger 1 — speed

`facts.speed > maxSpeedNoShoulder`. Strictly greater, so a road *at* the limit
shares the lane. Default 35 mph; the slider runs 15–45. See "One speed limit,
not two" below for why this is one setting and not an urban/rural pair.

#### Trigger 2 — lanes

`facts.lanes > lanesNoShoulderOver`. The setting is phrased "Lanes of traffic
more than", so the number shown is **the widest road that still passes** — at 3,
a four-lane road with neither shoulder nor bike lane fails and a three-lane road
does not. It runs 1–5, then "No limit" at the top stop (`MAX_LANES_NO_LIMIT`,
6), which switches the trigger off. A saved value from the old wider range
clamps to the top stop and reads as No limit.

It reads "more than" rather than the old "at or over" because that is how a
rider states the rule aloud, and because the two phrasings are off by one — a
silent way to move every road one lane in the wrong direction.

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
- **A missing `lanes` tag never trips it.** Coverage tracks road importance —
  ~100% of `secondary`, 3–5% of `residential` — so an absent tag means "small
  road", not "unproven", and `lanesNeedSpace` returns false on it.

#### Trigger 3 — traffic

The rider picks a **road type**, not a number. Nobody has an intuition for
"3,000 vehicles a day"; everyone knows what a neighbourhood street feels like.
`BUSY_LEVELS` in `safety-model.js` is the list, and it is the contract:

| id | slider reads | count over | else class at or above |
|---|---|---|---|
| 0 | Not used | — | — |
| 1 | a quiet lane | 500/day | 6 minor collector |
| 2 | a neighborhood street | 2,000/day | 5 major collector |
| 3 | a busy through road | 6,000/day | 4 minor arterial |
| 4 | a main highway | 15,000/day | 3 principal arterial |

**Each level carries both a count and a class, and that is what makes the
setting work everywhere.** Only about half the network has a traffic count. The
count is a measurement and wins whenever there is one; the functional class
stands in for the rest. `fc` runs the FHWA way, *smaller is bigger road*, so the
class test is `fc <= level.fc`.

The card says which of the two decided — "2,357 vehicles/day" or "Minor
arterial, no count" — because they are different kinds of claim, and the whole
discipline of the measurement import is never flattening them together.

The slider shows the figure alongside the label ("a neighborhood street
(~2,000/day)") so a rider who does want the number has it, without having to
reason in numbers to use the control.

Default is level 2. **This is the first rule that lets the statewide traffic
data change a verdict** — see "Which signals reach which decision" below.

#### The shoulder test, and what an unknown shoulder means

Once a road needs space, it fails only if `shoulderFails()`: no bike lane or
better **and** a known shoulder below `minShoulder`.

It is `shoulderFails`, deliberately **not** `!hasRidingSpace`. With *Unknown
shoulder = 0 ft* turned off, an untagged shoulder is not evidence of absence —
`effectiveShoulder` leaves it null to say exactly that — and treating null as
"no space" would quietly re-impose the pessimistic reading on a rider who
switched it off. The old wide-road rung did precisely that, and the 13M-combination
sweep in `scripts/test_safety_model.mjs` is what caught it during the merge.

So the untagged-is-zero floor now governs all three triggers uniformly, where it used
to be ignored by the lane rule. That is a real behaviour change, and the right
one: one rung, one shoulder test.

**A sidewalk reprieve, but only for speed.** `sidewalkFallbackApplies` still
requires the speed to be over the limit, so a road that trips the rung on lanes
or traffic alone gets no fallback. A sidewalk does not make a four-lane road
shareable. Of the edges the lane trigger fails, 10,854 of 12,453 have a mapped
sidewalk, so that restriction is most of the trigger's effect, not a corner case.

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

Do keep measuring it, though — a future tightening (a stricter `minShoulder`, or
raising `busyNoShoulder` in a preset) should be swept the same way so the
severance count is a known number rather than a surprise.

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

### Rung 7 — the sidewalk fallback

`allowSidewalkFallback` (default on) is the only way out of a rung-6 failure. It
fires when all of: the setting is on, the sidewalk is positively mapped
`present` (untagged does not count), there is no bike facility, the speed is
known and *above* the no-shoulder limit, and the shoulder is known and *below*
`minShoulder`.

Note the speed condition. A road that trips rung 6 on lanes or traffic but is
within the speed limit gets no fallback, however well its sidewalks are mapped.

It turns a 4 into a 3 — so "Only show routes fully matching" stops excluding
the road — and adds `Rule override: Sidewalk fallback` to the card. It is not a
soft landing: the router prices it at **×1.9** direct, **×3.8** balanced,
**×8.0** low-stress, so a route takes a long detour to avoid one.

That is worth stating plainly because level 3 means two different things
depending on which rung produced it, which is why `readoutVerdict` names the
rung: "Caution — sidewalk instead of a shoulder" versus "Caution —
limited-access highway".

## Two ways a card can lie by omission

Both of these shipped. Neither was a wrong value — in each case the right value
existed and simply never reached the rider.

**Feature properties must be scalars.** MapLibre serialises GeoJSON feature
properties, so a nested object put on a route feature comes back from the tap
layer as a string and every lookup on it silently reads `undefined`. The route
card lost its traffic and edge-space rows and fell back to the OSM road class,
while the road card over the same street kept all three. Measurements travel on
the route feature flattened under the **roads tile's own key names**, which both
fixes the round trip and lets one reader, `tileMeasures`, serve both cards.

**An informational ribbon never hides the road beneath it.** The
designated-route overlay draws above roads by design, so tapping it returned the
ribbon's own card — a name, a network, and a note reading "the scored road or
facility supplies the safety verdict" — while showing nothing about that road.
On the Olympic Discovery Trail: the corridor that runs 58.8 miles along ordinary
road, including US 101 at 60 mph with no shoulder, and the reason no designation
may excuse anything. The rider was shown the designation and denied the verdict.
`featureAt` returns a **scored** feature whatever the draw order, and a ribbon
answers only when nothing scored is under the tap. The road card names the route
it carries regardless.

**A card must not be the only voice disagreeing with the map.** One decision
layer unified the *judgement*; it never unified the *evidence*. `SOURCES`
carries three scorers over three descriptions of the same road, and `blts` is
hit-tested but **never painted** — `applyDisplayMode()` filters its paint
layers off, because the agency's increasing- and decreasing-milepost inventory
lines would draw on top of one another, and the state-highway verdict is
conflated onto the OSM centreline in `roads.pmtiles` instead. The card kept
evaluating the tapped inventory record. On OR 224 at Three Lynx it read
"Passes your rules" on a road the map drew red and the router detours 45 miles
to avoid; the router and the map agreed, and the card was the outlier.

So the verdict now comes from the **painted** road — `UNPAINTED_SOURCES` names
the sources this applies to, and `paintedRoadAt()` finds it — while the agency
record keeps the detail rows, which is what it is good for. Where the two
disagree the card says so in an *Agency record* row rather than hiding it.
`test_verdict_agreement.mjs` asserts the invariant for every state that ships a
graph, sampling real edges and comparing `SafetyModel.evaluate()` (what the card
calls) against `edgeLevel()` (what the router calls).

**And a tap must resolve to the nearest thing, not the topmost.**
`queryRenderedFeatures` returns everything in the pad box in draw order. At the
seam between two records of one highway that is a coin flip, and ODOT books 3 ft
on one segment and 4 ft on the next — two taps a moment apart, two opposite
verdicts. Where records genuinely coincide, a measured shoulder beats an
unpopulated one (an absent measurement is not a measurement of zero, whatever
the ladder scores an *unknown* shoulder as) and the narrowest measured value
wins. The two directions of a road are not duplicates: only records sharing a
`RouteIdentifier` reconcile, so `wsdotShoulderText()` still reports both sides.

The shared lesson: agreeing on one reader is not enough. The data has to survive
the trip, the card has to be reachable, and it has to be reading the same road
the rider is looking at.

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
2. Change `stressAgency` in `region.js` — the one place the name is written. It
   feeds the road card, the setting label and the explanation text. (It used to
   say "one place in `app.js`"; it was nine, until `region.js` existed.)
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
| lanes | **yes** (rung 6, trigger 2) | yes |
| traffic volume (ADT) | **yes** (rung 6, trigger 3) | no |
| FHWA functional class | **yes** (rung 6, trigger 3 — only where no ADT) | no |
| official stress rating (LTS) | **caution only**, always on | yes |
| OSM road class (secondary/primary/…) | no | yes |
| surface, grade, curve hazard, sidewalk exposure | no | yes |
| bail-out space (derived) | **no — shown only** | no |
| road owner | **no — shown only** | no |

ADT and functional class moved into the verdict when `busyNoShoulder` shipped,
and that was the point of importing them. They are still gated behind one rider
setting with an off position, and they can only ever say "this road needs space
of its own" — the shoulder test still decides whether it has any.

**Functional class is used as a class, never converted to a vehicles-per-day
figure.** It is a fallback for the half of the network with no count, matched
level-for-level against the count thresholds in `BUSY_LEVELS`, and the card says
which of the two answered.

**OSM road class stays out of the verdict** and is not interchangeable with the
FHWA one here. It is whatever a mapper typed: 81% of "arterials" are one or two
lanes, while 15th Ave NE has four-lane stretches tagged merely `tertiary`. The
FHWA class is assigned by a local agency, reviewed by WSDOT and approved by
FHWA, with federal-aid money attached — which is why trigger 3 reads `fc` and
not `highway`.

## The statewide road measurements

Four sources. They exist because the app measured 9.2% of its road mileage and
estimated the rest,
and that asymmetry had a specific consequence on the ground: the router
preferred a state highway to the quiet county roads beside it, because the
highway was the only thing it had evidence about.

| source | what it gives | source extent |
|---|---|---|
| CRAB certified county road log | bail-out space (derived), ADT + year | 39,187 mi |
| WSDOT non-state functional class | FHWA class, roadway owner | ~19,000 mi |
| WSDOT traffic counts | ADT + year, state routes | ~7,000 mi |
| FHWA HPMS (WA submittal) | AADT + year | federal-aid network |

What lands on the routing graph after conflation:

| | before | after |
|---|---|---|
| traffic count | 0 | **48,998 mi (51.8%)** |
| bail-out space | 8,721 mi (9.2%) | **36,653 mi (38.8%)** |

By functional class: Interstate 100%, minor arterial 94.7%, principal arterial
92.1%, major collector 87.1%, minor collector 46.6%, local 30.9%. The gradient
is the reason trigger 3 falls back to class — the roads with no count are
overwhelmingly the small ones, which is itself information.

Where two counts cover the same edge, the newer year wins; on a tie a directly
measured count (county or state inventory) beats a modelled HPMS one. That is
`_better_count()` in `scripts/roadmeasure.py`.

They are matched to OSM ways by span and bearing — a **majority** of interior
samples within 18 m of the source line, headings aligned within 40°. Requiring
*every* sample to be covered was the single largest loss in the pipeline:
relaxing it to 3 of 5 added ~9,847 mi of traffic coverage, more than adding
HPMS as a whole source did (+5,699 mi).

Measurements are written identically into the graph (format 12) and the vector
tiles, so the router, the tap card and the route card read one number.

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

**The normalisation is for the card only.** Rung 6's traffic trigger reads
`facts.fc`, which every adapter fills from the *official* class alone — never
from the OSM one mapped through this table. A mapper's `tertiary` must not be
able to fail a road for being busy; an agency's reviewed Major collector may.

Routing cost is unchanged by any of this: the OSM class still drives the
class-based soft cost exactly as before, and the FHWA class drives no cost.
Making the official class feed routing where OSM has none is a real improvement
and a separate decision.

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
own Census 2020 point-in-polygon flag remains the displayed area context.
Neither boundary selects a speed or shoulder rule.

### One speed limit, not two

Rung 6's speed trigger used to read two settings, 30 mph in a Census urban area
and 35 outside one. They are now a single `maxSpeedNoShoulder`, defaulting to 35.

The split asked a rider to hold an opinion about a distinction the road does not
make. A 35 mph lane with no shoulder is the same lane whether or not a polygon
contains it, and the direction of the old default was itself arguable: it was
*stricter* in town, where speeds are better enforced and there is somewhere to
turn off, than in the country, where a rider is more exposed.

The urban flag is still carried in the graph, still shown on the card as
context, and still available to any future rule. It simply no longer forks this
one.

Saved settings from before the collapse are migrated by taking the **rural**
value, since the single default is the old rural value — so a rider who never
touched either lands exactly on the new default. `freeMaxSpeed`, which predates
even the urban/rural split, is still honoured behind both.

## Every rider setting, and what it objectively does

| setting | UI label | verdict effect | routing effect |
|---|---|---|---|
| `maxSpeedNoShoulder` | Speed limit is over | rung 6, trigger 1 | via the verdict |
| `lanesNoShoulderOver` | Lanes of traffic more than | rung 6, trigger 2 | also `wideRoad*` cost |
| `busyNoShoulder` | Road is busier than | rung 6, trigger 3 | via the verdict |
| `minShoulder` | Minimum shoulder width to count as safe-ish | what satisfies rung 6 | via the verdict |
| `upperMaxSpeed` / `noUpperLimit` | Never allow roads faster than | rung 5 | via the verdict |
| `allowSidewalkFallback` | Allow sidewalk fallback | rung 7 exists at all | ×1.9 / ×3.8 / ×8.0 |
| `allowFreeways` | Route over freeway as last resort (still shows as failing) | **none** — a freeway always fails | traversable at all, ×60 |
| `allowMtbTrails` | Allow mountain bike trails | none | traversable at all, `mtbTrail` |
| `allowFerries` | Allow routes with ferries (Settings → Options) | none | traversable at all |
| `requireSafe` | Only show routes fully matching safety rules | none | excludes every level-4 edge |
| `preferPaved` | Strongly prefer paved surfaces | none | surface cost |
| `prefDesig` | Heavily prefer bike routes & trails | none | designation bonus |
| `prefResidential` | Prefer residential streets | none | `residential` bonus |

The first seven are named objectively and change the verdict. The rest are
named as permissions or preferences and change only where you are sent — which
is what their names promise.

The three rung-6 triggers plus `minShoulder` are presented as one indented group
under the heading **"Require a bike lane or safe-ish width shoulder."**, because
they are one rule read as one sentence. Presenting them as four independent
sliders was what let the old speed/lane ordering hide.

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

A dismount is one of two things in the graph, and the app treats them
differently. **Tagged** — a mapper wrote `bicycle=dismount`; the edge carries
`official` bit 128 alongside the pricing bit 8. **Synthesised** — a walk link
the graph build created from an untagged footway or path purely to keep the
network connected (bit 8 without 128). Both are priced identically — walking
pace, a six-minute entry penalty, and a ×4 search-cost multiplier on the
walked time (×8 on an edge over 100 m, which is how a long unrideable trail
appears in the graph): walking the bike is a bad outcome, not merely a slow
one, and the multiplier is proportional by construction because it scales the
walked seconds themselves. Both count as CAUTION in the route's level
percentages (matching the amber they draw), and both are priced into the
recommendation at the same one second per meter as failing road. One
judgment applies to tagged dismounts alone: a contiguous tagged run longer
than 100 m reports as FAILING the rules — a gate or a dock approach is a
shrug; a real stretch of signed trail you cannot ride is a route that failed
to be a bike route. Synthesised walk links stay amber whatever their length:
red at every park connector would teach the rider to ignore the red that
stands for a real sign. Both kinds are listed in the route-concerns
report, and both carry walking-figure markers on the drawn route: the route
marker pass chains them about 700 m apart along the whole walked stretch, so
a long one cannot sit off screen behind a single entry pin. BOTH also draw
as caution (amber) wherever a route is shown — a walked stretch must never
read as prime lime trail, and colour is the warning that works at every
zoom, with the walker chain saying why. (The same
pass places mountain icons on 10%+ climbs, a car on busy-tier traffic —
the "busy through road" level, 6,000+/day, where cautions begin — but only
where the stretch draws as caution or a bare pass, never on trusted
bike/trail paint, a serrated-ground icon on confirmed-unpaved surface, and
a question mark on technical ways, one icon per slot even where causes
overlap. A rules-failing stretch that carries none of those gets a red !
— one per contiguous failed area, two on a long one — whose whole job is
to draw the tap that opens the card naming the failed rule.) Only
tagged dismounts raise the louder warnings: the "Dismount" mileage in the
stats and the spoken "Walk your bike" (a synthesised stretch is silent in
the voice). A warning at every synthesised park connector would teach the
rider to ignore the one that stands for a real sign.

Note that the causes carry very different routing costs — a sidewalk fallback is
×8 in low-stress mode, a high-stress rating is priced through
`trafficStressMult`, and a limited-access caution is barely priced at all. Amber
is one colour over several meanings, which is why the card names which.

## Routing cost

Subjective by design: it chooses among *legal* roads and never makes one legal
or illegal. Every multiplier applied to an edge, in `router-worker.js`:

**The search is weighted A\*** (`SEARCH_OVERSHOOT`, 1.15): a found route's
cost is mathematically bounded at 1.15× the true optimum, and in practice the
verification legs in `test_route_potential.mjs` come back exactly optimal —
the weighting prunes lateral exploration far from the corridor, not the
corridor itself. This bought roughly half the portfolio's search time. It
never affects which roads are *legal* or how any road is *scored*; 1.0
restores exact A\*.

**The direct-lens candidate.** Every ordinary portfolio also runs ONE search
under a "more direct" flattening. `directLensRoutingWeights()` raises every
subjective multiplier to exponent 0.22 and scales the per-mph speed rates,
without editing the rider's stored weights. Physics (climb/turn seconds, ferry
wait, elevation factors), last-resort walls, safety rules, verdicts, and colors
remain unchanged. The result joins the pool as the `direct-lens` profile before
dedupe and ranking. It exists because the facility pull can own every profile at once:
on Ravenna → Phinney Ridge all nineteen normal candidates collapsed onto one
greenway corridor while the flattened search found a genuinely shorter one
that would otherwise be missed. Like the
discovery lens, it is a search preference only — safety metrics, colours and
the star's pricing come from the rider's unchanged rules and weights, so a
bold lens route is offered with its failing meters reported honestly and
almost never starred. The portfolio offers up to SIX letters (A–F) so
the lens's find does not push an ordinary choice out. In the worker, weight
sets keep their cache epoch (`useWeights` is content-keyed), so the
main → lens → main round trip inside a request costs nothing in cache
warmth and the lens's own arc costs cache under its own epoch.

**Adaptive ferry hybrids.** On a ferry trip, a dedicated pass re-searches the
LAND sections of an itinerary one at a time under the conservative discovery
lens and splices the seed's boats back verbatim, producing "same ferries,
calmer crossing" hybrids. Three seeds are refined: the safest itinerary, the
best-priced one, and the rider's MAINSTREAM one — the best-priced whose
failing share is under 5%. The last exists because the first two can both
miss it: on Seattle → Port Townsend the safest seed built an 88.7 mi hybrid
and the best-priced seed a 10%-failing sprint's, while the starred 71 mi
route — whose traffic-heavy Whidbey section was the whole complaint — was
refined by neither until it seeded its own 77.5 mi becalmed hybrid. Each
distinct boat plan keeps TWO representatives in the seed pool (safest and
best-priced); keeping only the safest had hidden the mainstream candidate
behind a calmer sibling with the same ferries.

Same-boat parents are also cross-bred at their terminal nodes. A donor land
section is used only when it is actually safer or better-priced than the base
section; being on the safer *whole route* is not enough. The six-letter chooser
explicitly reserves the safest of these cross-bred children. This matters on
Seattle → Port Townsend: the practical route owns the excellent trail-heavy
approach to Mukilteo, while a longer candidate owns the calm Whidbey crossing.
Their useful composition was already generated but used to remain only in the
troubleshooting list because the chooser reserved whichever adaptive candidate
happened to receive the first internal ID.

**Combined land corridors.** A bounded, search-free pass can also combine two
ordinary ferry-free candidates when they meet at the exact same routing-graph
node. This covers the non-ferry version of the same field need: one candidate
has the useful first half, another has the useful second half, and no global
cost profile asks for both. A visual line crossing is never enough—the roads
must share a real graph junction. Each side of the splice must contribute at
least 1 km; children with a repeated node, no meaningful geometry change, or
no improvement against either parent are rejected. At most ten distinct
parents seed the pass and six children enter the portfolio; those children
still pass through the ordinary reasonable-time, dedupe, dominance,
recommendation, and six-slot selection pipeline. Stable
`combined-corridor[-N]` profile IDs let a selected combination survive sharing,
pinning, and recomputation like any other route.

**Candidate-union section frontier.** The one-cut pass above cannot discover a
route that needs the first section from A, the middle from B, and the last from
A again. A second bounded pass therefore makes a compact directed graph from
only the edges already present in up to ten strong candidates, then runs a
multi-objective label search over that union. It can switch candidates any
number of times, but only at exact shared graph nodes. It does **not** run
another statewide A* search and cannot invent a road the candidate portfolio
did not already find.

Each partial route carries nine additive objectives: failing distance,
concrete danger, caution distance, distance outside the trusted bike network,
distance outside an off-street trail, rough-surface distance, ascent, travel
time, and total distance. The two coverage objectives preserve the intended
hierarchy: a trusted lane beats ordinary passing road, and a trail beats the
lane. A label that is no better on every objective and worse on at least one
is discarded. The
remaining Pareto set is deliberately approximate and phone-bounded: at most
eight labels survive at a node, and at most six materially different children
enter the ordinary portfolio. The output includes a practical safety-first
choice plus useful extrema for safety, caution, network coverage, and climbing;
the normal recommendation price and six-letter selection still make the final
decision.

This mechanism is **not ferry-specific**. Ferry-free routes form an ordinary
candidate-union group. When boats are present, candidates are grouped by the
exact ordered ferry-edge signature, and a child is accepted only if it preserves
that signature. The constraint prevents a land-section recombination from
silently adding, dropping, reordering, or changing a crossing; it is not what
makes the algorithm work. Every child is also rejected if it repeats a graph
node, duplicates an existing route, or is dominated by an existing candidate.
Stable `section-frontier[-N]` profile IDs preserve selection, sharing, pinning,
and recomputation.

**Allowing ferries at all** is a rider toggle in **Settings → Options**. Off
is an admission gate exactly like the freeway
and MTB toggles: the ferry edge does not exist to the search (or to the A*
goal bound, whose cache keys on the rules signature, so a tighter no-ferry
bound never leaks into a ferry-allowed request). It never changes a verdict
or a color. The key is deliberately absent from `DEFAULT_RULES` and every
preset — it is a travel option, not a safety rule, so applying a preset
neither resets nor claims it. It persists across trips and rides along in a
shared route like any other rule. With ferries
off, an island with no bridge is honestly unreachable.

**The recommended route** (the starred letter) is chosen from the candidates
whose every leg stays within a practical detour of the quickest option
(1.5× distance + 800 m, 1.4× time + 5 min per leg — time is the binding
clause; a tighter distance bound once stranded the star on a 56%-failing
corridor), by minimizing
`time + 1 s × (failing + dismount meters) + 0.2 s × ordinary-road meters`
`− 0.12 s × trail meters`
— where ordinary-riding meters are everything that is neither trail nor
trusted lane (facility ≥ 2; sharrows never qualify, ferries are removed as
not-riding). The three categories are deliberately not flattened: ordinary
passing road is acceptable, a trusted lane is better, and removing motor
traffic on an off-street trail is better again. A mile of ordinary road costs
about five and a half minutes against a lane; a mile of trail earns about 3.2
minutes beyond a lane. Fail avoidance pays a PRICE rather than holding a veto,
and ride QUALITY has a vote,
sized from a field case where the star saved 21 minutes by spending 12
extra kilometers off the bike network and the rider wanted the other route. Under the old lexicographic rule any reduction in absolute
failing meters beat any amount of time inside that window, which on
Seattle–Everett starred a 40.4 mi / 3h19 route over 33.0 mi / 2h43 to avoid
651 m of failing shoulder — a difference that rounds to the same "1% fails"
on both route cards. At one second per meter, avoiding a mile of failing
road is worth up to ~27 minutes of extra riding, no more. Ties break toward
the strictly safer route; the strictly safest candidate keeps its own
lettered slot regardless. A fully rules-matching route can still take the
star from a failing one within a wider bound (1.8× distance per leg), but
the switch pays the same price test: zero-fail is worth at most ten extra
minutes of score beyond what the fail meters already charged. As an
unconditional veto this override once starred a 40.1 mi / 3h22 zero-fail
loop over a 30.7 mi / 2h33 route carrying ~1% failing distance — a
49-minute detour taken automatically.

| influence | function / weight | what it expresses |
|---|---|---|
| speed above the comfort limit | `speedStress`, `speedOver*` / `speedBelow*` | graded pressure toward slower roads; the `Below` pair charges a slow road with no riding space |
| curve/grade hazard | `hazardMult`, `curve*1-3` | recorded hazard on the edge |
| traffic volume | `majorRoadMult`, `busyLight/Medium/Heavy*` | measured AADT first, FHWA functional class second, OSM tag last |
| lanes and WSDOT LTS | `trafficStressMult`, `wideRoad*`, `stressedRoad*` | traffic exposure; paint gives partial relief, a separated lane full |
| urban road tagged `sidewalk=no` at 30+ mph | `sidewalkExposureMult` | nowhere to bail out |
| riding on the sidewalk fallback | `sidewalkFallbackMult` | ×1.9 direct, ×3.8 balanced, ×8.0 low-stress |
| freeway | `freeway` (×60) | last resort only |
| WSDOT limited access | `limitedAccess*` | bike-legal but unpleasant |
| mountain-bike trail | `mtbTrail` | opt-in, heavily penalised |
| bike facility | `facility*` | separated lane or path can justify a detour |
| signed bike route | `designated`, `strongDesignated` | a recommendation, worth a detour but not a fact about the road |
| residential street | `residential` | quieter grid |
| climbing | `climb*SecPerM`, `uphillFactor` | time model plus a preference |
| turns | `turn*Sec` | fewer manoeuvres |
| route diversity | `diversity*` | keeps the six offered routes genuinely different |

### Bonuses

Two multipliers are discounts rather than penalties, and they follow three rules.

Facility multipliers are **profile-independent** — they apply unchanged in
direct, balanced and low-stress mode alike. Lowering one therefore moves every
option in the portfolio, not just the low-stress end, and can remove the short
end of it entirely: dropping the set to 0.30/0.40/0.45/0.50 took the shortest
Olympia–Centralia option from 28.7 mi to 39.8 mi, because the direct profile
also now preferred the trail. Measured facility share across four corridors
rose 0–8 points; failing distance on the quickest options rose slightly, since
a little more failing road is now worth paying to reach a trail.

### An untagged shoulder is always 0 ft

There was an `unknownShoulderZero` setting, defaulting on. It is gone, and the
pessimistic reading is now unconditional.

"No data" and "no shoulder" are indistinguishable from the saddle, so treating
the first as evidence of safety let a fast road pass on an absence of evidence.
The optimistic branch also produced the ladder's only route to level 0
(`unknown`), which was unreachable with the default on; that rung is removed
too. Level 0 survives for ferries and as a paint fallback, but nothing in the
ladder produces it.

`effectiveShoulder()` is now three steps with no branch on rider preference: a
recorded tag, then the edge-space inference, then zero. Slow roads never reach
the shoulder rung at all, so this does not fail quiet streets for lacking a tag.

### Inferring a shoulder from edge space

`inferShoulderFromEdge` — *"Guess shoulder width from other data when it isn't
documented"*. **On for The Randonneur only.** Weekend Wanderer and Casual
Cruiser switch it off: both exist to honour slower roads literally, and Casual
Cruiser filters routes to fully matching road, where a guessed shoulder must not
be what admits one. Where OSM recorded no shoulder but the
CRAB road log logged edge space, the space **less 1 ft** counts as shoulder.

Edge space is what is left of the operational width once the lanes are removed,
and `build_roadlog.py` halves it at derivation, so it is already **per side**
and compares directly against `minShoulder`. It is explicitly *not* a ridable
shoulder — it may be gravel, rumble strip or ditch lip — which is what the 1 ft
margin is for, and why this is a rider-facing toggle rather than a silent
improvement.

Three constraints, all pinned by `test_safety_model.mjs`, which calls
`effectiveShoulder()` and `shoulderWasInferred()` rather than reading them:

- **It only fills a gap.** A recorded shoulder always wins, including a
  recorded 0 ft, which is evidence of absence.
- **A zero infers nothing.** `edge_space()` clamps a negative result to 0, and a
  negative result means the recorded lane widths exceed the recorded operational
  width — a paperwork error. Inferring a hard 0 ft from that would turn bad data
  into a failing road.
- **It is consulted before the zero floor.** Untagged is unconditionally 0 ft,
  so an inference placed after it could never fire at all.

An inference can now only ever be kinder: the baseline is a hard 0 ft, which is
the harshest reading available. It used to cut both ways, back when a rider
could switch the zero off and an inference could turn "unknown, not held against
it" into "known narrow".

Measured on the shipped graph at Randonneur defaults: of 102,121 network miles,
20,892 carry edge space with no recorded shoulder. The inference moves
**9,548 edges / 1,696 mi**, all of them 4→2 (9,404) or 3→2 (144), and **nothing
gets worse** — zero is already the floor. Failing mileage across the network
drops from **14,906 mi to 13,220 mi**, an 11% reduction.

That measurement is why it is on by default. Only ~7% of road features carry a
shoulder tag, so with the zero floor unconditional the map would otherwise call
most of the network failing on *absence of data* rather than on evidence. Where
the county logged edge space there is real evidence, and using it is strictly
better than pretending the road has nothing.

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

**A WSDOT limited-access edge earns it too.** Its `limitedAccess*` penalty is applied
separately and stands on its own; withholding the bonus as well counted it
twice, and priced a signed shoulder route along a state highway identically to
any other highway — the case where a designation carries the most information.


Ferries, freeways and dismount edges are still excluded: there, a preference
would erase an access cost rather than express a taste.

### Traffic volume

`majorRoadMult` answers one question — how much traffic is on this road — from
three sources, strongest evidence first:

| evidence | tier thresholds |
|---|---|
| measured AADT | >2,000 light · >6,000 medium · >15,000 heavy |
| FHWA functional class | 5 light · 4 medium · ≤3 heavy |
| OSM `highway` tag | tertiary light · secondary medium · primary/trunk heavy |

Thresholds are the `BUSY_LEVELS` numbers from `safety-model.js`, so the verdict
and the cost cannot disagree about what "busy" means. Any recorded bike
facility, path flag or limited-access edge is exempt.

`useMeasuredTraffic` (0–1, default 1) blends from the OSM answer toward the
measured one. **At 0 the function is exactly the pre-measurement behaviour**,
which is what makes the import falsifiable on a real ride rather than an
unfalsifiable improvement.

Measured over all 635,995 eligible edges, the measurement disagrees with the
OSM tag on 171,466 — but **150,079 of those move down and only 21,387 up**. The
dominant case is a road OSM calls `secondary` that FHWA classes a minor
collector, or that counted under 2,000/day; it sheds its arterial penalty.
Only 4,728 edges are OSM-class gaps the measurement fills, which is why this
prices off the count rather than merely extending the proxy to more roads.

### Weight naming

Weights live in `DEFAULT_WEIGHTS` (`router-worker.js`), mirrored in `app.js` so
the desktop weight editor stays reproducible. Three modes — direct, balanced,
low-stress — scale most of them; that is what makes routes A–F differ.

Every mode-scaled weight **ends** in its mode: `Direct`, `Balanced`,
`LowStress`. One function, `modeSuffix()`, builds that suffix, so a new mode
cannot reach some cost functions and miss others. The suffix used to be `Low`
while the UI called it "friendly", which collided with the `friendly`
`ROUTE_PROFILES` id (low-stress mode with both preferences on) — three names
for two things.

`RENAMED_ROUTING_WEIGHTS` in `app.js` carries a rider's saved custom values
across the rename. Values are unchanged, so it is not a behaviour migration and
needs no `ROUTING_WEIGHTS_VERSION` bump.

The editor is reachable from **Settings → Advanced** and from the **⚖ button on
the map**, which marks itself when any weight sits off its default.
`test_weights_editor_coverage.mjs` proves every weight has exactly one slider
and that `app.js` and `router-worker.js` agree key for key;
`test_weights_panel_ui.mjs` proves the same in a real browser.

**Level 3 does not mean one thing for routing.** A `sidewalk-fallback` caution
carries ×8 in low-stress mode; a `limited-access` caution carries `limitedAccess*`;
a `needs-space` outcome is a fail, not a caution, and is excluded
under strict matching. The card names which one it is for that reason.

### A sharrow is not bike infrastructure

Facility level 1 is a shared-lane marking: paint in a traffic lane, no space of
a rider's own. It gets **no bike-network lime** and does **not** count toward a
route's "trails / lanes" percentage. It keeps its small routing weight
(`facilityShared` 0.82) — it may still be worth a mild preference — so this is a
statement about what the map claims, not about what the router prefers.

The rule has to be enforced in three places that cannot import each other, and
it had leaked in all three:

| where | was | now |
|---|---|---|
| `routeVisualStyle()` — the route line | `facility >= 1` | `facility >= 2` |
| `facilityM` in `router-worker.js` — the headline % | `eFacility >= 1` | `eFacility >= 2` |
| `bikeNetworkExpr('osm')` — the OSM layer | `true` | excludes `shared_lane` |

The OSM case is the subtle one: `build_osm.py` scores `shared_lane` as **2**,
the same as a painted lane, so that source genuinely contains sharrows and could
never be painted wholesale. The raw `cycleway*` tags survive into the tiles via
`KEEP_TAGS`, so the filter is declarative and needed no tile rebuild.

The road tiles (`ft >= 2`) and the ladder (`FACILITY_RIDING_SPACE`) were already
correct. `test_safety_model.mjs` holds them together: it checks the threshold through
`hasRidingSpace()`, and its map-expression sweep covers every facility value
against the shared ladder.

Statewide the graph carries **385 mi of sharrow** against 7,884 mi of real
facility, so this is a small correction in mileage and a large one in honesty.

## The "More" screen — all routes considered

A troubleshooting view, reached from the **More** button after Route E. It lists
every candidate the portfolio built for the current points: the six offered and
everything discarded, each with the reason it was built and the reason it was
dropped.

The pipeline is `raw → reasonable → unique → useful → choices → selected`, and
each candidate is tagged with the earliest stage it failed to reach:

| stage | meaning |
|---|---|
| `offered` | one of the routes on the map |
| `not-chosen` | survived every filter; the slots were filled by more distinct routes |
| `dominated` | another option shares the corridor and is no slower and no less safe |
| `duplicate` | effectively the same roads as a named option |
| `too-slow` | far slower than the quickest without being safer |

Offered routes keep their A–F letters; extras continue G, H, … and fall back to
numbering past Z.

**Payload.** Candidate *summaries* ship with every route reply (~5 KB); full
geometry does not. Sending every candidate whole measures **3.4–4.2 MB** on a
Puget Sound trip, which is too large a structured clone to pay on every request
for a screen opened occasionally. Tapping a discarded route fetches it via
`route-candidate` from a worker-side cache of the last portfolio, keyed by the
request, so a stale tap after the pins move is refused rather than answered
wrongly.

**What it revealed immediately.** On Seattle → Mukilteo the portfolio builds 10
candidates and offers 5 — and all 5 discards are `duplicate`, not hidden
diversity. The router is not concealing better routes there; it genuinely found
5 distinct ones out of 10 attempts. That is the question the screen exists to
answer.

## Corridor severance: one missing link costs 45 miles

A short way that is open to bikes and closed to cars is a **link**, not a
driveway. Dropping one severs a corridor, and nothing about it looks like a
failure: routes still return, no test errors, the ride is simply always long.

This has now happened twice, the same way:

| way type | link | cost |
|---|---|---|
| `highway=track` + `bicycle=yes` | 70 m joining two halves of a rail-trail (Issaquah-Preston, High Point) | forced onto highway shoulders |
| `highway=service` + `bicycle=yes` | 89 m joining Hoffman Hill Blvd to Mounts Rd SW (OSM w12189384) | **+15 mi on Tacoma-Olympia** |

`classify_way()` accepted `bike in ('designated', 'yes')` for path, footway,
bridleway and track, but demanded `bicycle == 'designated'` for service. That
one word dropped w12189384 — `access=no bicycle=yes foot=yes motor_vehicle=no
service=emergency_access` — and with it the only surface link out of DuPont.
What remained was 1.3 mi of I-5, and at `freeway: 60` the router preferred a
45-mile detour through Spanaway and Yelm.

Measured before and after the rebuild:

| | before | after |
|---|---|---|
| Tacoma → Olympia | 53.9 mi | **38.8 mi** |
| DuPont → Nisqually (4.3 mi straight) | 46.4 mi | **6.6 mi** |

Statewide the rule change admits 227 ways / 87 mi, all bike-permitted and
car-excluded — the same narrow combination the rule already trusted, spelled
differently.

**How it was found, and why that matters.** Not by a test. A rider compared
against a route posted to Reddit, which named the chain road by road: *"Center
Dr to McNeil to Hoffman Hill Rd to Mounts Rd. Take that over 5."* Every junction
in that chain existed in the graph except one. Before that, the long route
looked like a legitimate safety trade-off, and an investigation that measured
the network's floor with every rule disabled concluded — wrongly — that no
shorter path existed. A floor measured on a graph with a hole in it just
measures the hole.

`test_corridor_severance.mjs` now guards this as an invariant: a route exists,
needs no freeway, and is not absurd against the straight line. It caught the
DuPont gap at 10.7x with three control corridors passing.
`test_bike_service_links.py` pins the rule itself — `designated` and `yes` must
behave identically in every infra category, while a plain or car-open service
way stays out, since that narrowness is what keeps every parking aisle in the
state from becoming bike infrastructure.

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
- **Shoulder is usually untagged on city streets.** The zero floor
  decides whether that counts against a road.
