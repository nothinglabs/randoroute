# Issues

The working list for this project — what is open, what is parked and why, and
what was recently finished. Read this the way you would a teammate's handoff:
the *why* matters as much as the *what*. Update it when an issue opens, moves,
or closes; keep closed items brief and prune them once they stop being useful
context.

Conventions: the app is field-tested on a phone by the project owner, and many
items below block on a **field verdict** — the owner riding or browsing real
routes and reporting back. Don't simulate rides to close one of these.

## Open

### 1. Shoulder safety
Improve how road shoulders factor into safety verdicts. Not yet scoped —
waiting on examples from the field (specific roads scored wrong, and in which
direction). The shoulder model today: per-direction shoulder widths from the
WSDOT inventory, `minShoulder` rule, optional inference
(`inferShoulderFromEdge`), sidewalk fallback as last resort. See
`docs/SAFETY-MODEL.md` ("A shoulder can depend on which way you ride" and
rung 6).

### 2. Route selection & search UI — field verdict pending
The machinery shipped in v.601/.602; what remains is judging it on real trips
and reacting. Shipped and awaiting verdict:

- **Six letters (A–F)** with direct-lens candidates in every portfolio
  (`direct-lens`, `direct-lens-friendly` profiles).
- **Priced star**: recommendation minimizes
  `time + 1 s/m × (fail + dismount) + 0.2 s/m × ordinary-riding meters`,
  practical window 1.5× distance + 800 m / 1.4× time + 5 min per leg,
  fully-matching override priced at 600 s.
- **Adaptive ferry hybrids**: three refine seeds, two representatives per
  boat plan, plus cross-bred candidates (practical base × safest donor,
  spliced at ferry-group boundaries — `adaptive-corridor[-N]` profiles).
  Test trips: Seattle→Port Townsend, Duck Pond→Kenmore, Phinney→Mukilteo.

Follow-ups that hang on the verdict:
- **Remove the ⚙︎ remix dialog's mode choices?** If the six-letter mix
  reliably covers "more direct" wishes, the remix modes may be redundant.
  (The dialog also now hosts the ferry toggle, so the button stays either way.)
- **Practical-window anchor**: the window currently anchors on the absolute
  fastest candidate, which is often a bold lens route; anchoring on the
  fastest NON-lens candidate is the drafted alternative. Deliberately not
  done yet — one knob at a time.
- **Caution pricing in the star**: adding a small per-meter price for
  caution-level riding was step 3 of the ferry plan, deferred to avoid
  over-fitting before field data.

### 3. Road detail UI improvements
Owner has ideas; not yet described. Nothing started.

### 4. Voice navigation on iPhone — field verdict pending
Reported from the road: the voice sometimes talks over itself, and prompts
(especially the first of a ride) come too late. Fixed in v.604, awaiting a
field verdict:

- **Overlap.** `speechSynthesis.cancel()` is not synchronous on iOS Safari,
  and cancelling fires the current utterance's end callback *synchronously*,
  which re-entered the pump and started the replacement in the same tick.
  There is now a wall-clock barrier (`speechGapUntil`, 300 ms) armed BEFORE
  the engine is stopped. The watchdog that rescues a wedged queue also
  believes `synth.speaking` before forcing on, and the active utterance is
  held in a variable so iOS cannot garbage-collect it mid-speech.
- **Late prompts.** Announcement windows now scale with speed (immediate
  90–220 m at 12 s of travel, approach 350–700 m at 45 s) instead of being
  fixed at 90/350 m.
- **Setting off.** The first on-route fix speaks "Head <compass> on <road>"
  plus the first maneuver, taken from the route's own geometry — GPS heading
  needs movement the rider has not made yet. Once per navigation start, and
  suppressed when a connector or reroute prompt already oriented the rider.

If the field verdict is still "late", the next lever is announcing the first
maneuver on the *approach* window at start regardless of distance, or
lowering `SPEECH_INTERRUPT_GAP_MS`.

## Parked (has a trigger, waiting on it)

- **Phone cost-cache cap 8 → 16 slots.** Constrained devices cap the router's
  per-config cost caches at 8 slots (`configure` message in
  `router-worker.js`); long trips repeat ~3× slower than they could. Lifting
  it costs ~174 MB peak, which we won't spend until the v.595 crash fix
  (chunked PMTiles serving in `sw.js`) has soaked crash-free on the phone for
  a while. Trigger: owner declares the app stable.
- **Generalized route cross-breeding.** The ferry splice works because same
  ferries ⇒ identical terminal nodes ⇒ clean cut points. A non-ferry version
  would splice where candidates cross mid-route. Trigger: a real trip where
  corridor A's first half + corridor B's second half is wanted and no offered
  letter covers it.
- **iOS native build.** Four native-side changes in
  `ios/App/App/BridgeViewController.swift` were written without a compiler
  (see `docs/IOS-HANDOFF.md`) and need a macOS/Xcode build before they are
  believed. Trigger: access to a Mac.

## Recently closed (context that may still matter)

- **v.600 stuck / Pages deploy broken (2026-08-06).** Not the repo rename —
  a GitHub Actions/Pages major outage. During it we replaced the built-in
  Pages build with our own `.github/workflows/pages.yml` (checkout →
  configure-pages → upload artifact → deploy) and switched Settings → Pages
  to "GitHub Actions". That is now the permanent deploy path: push to `main`
  deploys the site.
- **Crash saga → v.595.** Repeated PWA crashes on zoom were the service
  worker's whole-archive blob memoization pinning ~140 MB; fixed by chunked
  (8 MB) PMTiles serving. The tile-cache cap experiment (v.592) made it
  worse and was reverted (v.594) — don't cap `maxTileCacheSize` again.
- **Routing performance (was issue 5).** Warm repeat 9.8→4.2 s, pin move
  14.3→5.7 s via content-keyed weight epochs, floor-slot LRU, and hoisted
  scoring. Closed 2026-08-07; the cache-cap lift above is its residue.
- **Source control (was issue 6).** Repo renamed `clauding` → `randoroute`,
  single branch `main`, stale branches deleted. Closed 2026-08-07.
- **Voice queue overlap + late prompts (v.604).** See open issue 4 — the code
  is in, the verdict is not.
- **Ferry toggle + gear button (v.603).** The route chooser's ⋮ became ⚙︎ and
  its dialog gained "Allow routes with ferries" — an admission gate like the
  freeway toggle, deliberately outside `DEFAULT_RULES` and presets. See
  `docs/SAFETY-MODEL.md`.
