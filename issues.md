# Human TODO List

This is a short, human-focused list of project TODOs. It is not an LLM
notepad, brainstorming log, or automatic issue tracker. Add, remove, reorder,
or rewrite items only when directed by a human, and keep the list concise.

Some items block on a **field verdict**: the project owner riding or browsing
real routes and reporting back. Do not simulate rides to close them.

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

### 4. Have an agent import Oregon from the docs alone
The repo ships one state. Oregon was removed deliberately: the point is to find
out whether `docs/PORTING-TO-ANOTHER-STATE.md` and `docs/PORTING-LESSONS.md`
carry enough for an agent that was not here to import a state unaided.

Oregon specifically, because the owner has ridden it and can check the result —
an import nobody can verify is worthless as evidence. Write down what you expect
BEFORE the agent runs (corridors, roads that should fail, trails that should
read as trails), or there is a pull toward grading on whatever it did well.

Target is **7/10** on the rubric in `maps/README.md`, not 9: levels 8 and up
require a rider, by design. The agent's deliverables are the state plus
`VERIFICATION.md` and filled-in `Travelled` lines in `PORTING-LESSONS.md`.

A failure is the more useful outcome — it names the lesson the docs failed to
carry.

## Parked (has a trigger, waiting on it)

- **Generalized route cross-breeding.** The ferry splice works because same
  ferries ⇒ identical terminal nodes ⇒ clean cut points. A non-ferry version
  would splice where candidates cross mid-route. Trigger: a real trip where
  corridor A's first half + corridor B's second half is wanted and no offered
  letter covers it.
