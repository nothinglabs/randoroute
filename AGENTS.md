# Working agreement

Instructions for any coding agent working in this repository. `CLAUDE.md` is a
one-line `@AGENTS.md` import, because Claude Code reads `CLAUDE.md` and other
tools read `AGENTS.md` -- one file, both doors. Put tool-specific guidance below
the import in `CLAUDE.md`, not here; everything in this file is about the
project, not about whoever is reading it.

## The issue list

`issues.md` in the repo root is the shared work list — open issues, parked
items with their triggers, and recently closed context. Read it at session
start; update it when an issue opens, moves, or closes.

## Tests

`npm test` runs everything. Eighteen to twenty minutes in the cloud container
(bounded by `test_safety_model.mjs`), and it is green.

The hold that used to sit here is gone, along with what caused it. As of
2026-07-31 the suite was 53 standalone scripts with no runner, ~20 minutes
serial, and roughly 500 assertions that matched **regular expressions against
the source text** of `app.js` and `router-worker.js` — pinning function
signatures, brace placement and whitespace. Those broke on renames and passed
through real regressions, which is what made running the suite feel worthless.
They are deleted. What is left runs the code.

The rules that remain:

- **Never assert on source text.** No `assert.match(appSrc, /…/)`. If a
  behaviour cannot be observed by running something, it is not a test. Extract
  and *evaluate* a function if you must (`scripts/test_route_pulse.mjs` does),
  but assert on what it does, never on how it reads.
- **Use `scripts/testlib/harness.mjs`.** It owns the graph load, the router
  worker's fake-browser context, the static server, and Playwright resolution.
  A new test should not rebuild any of that.
- `safety-model.js` is `require()`-able as-is — its IIFE ends with
  `}(typeof self !== 'undefined' ? self : this))` and in Node CJS `this` is
  `module.exports`. Import it. Do not evaluate it in a hand-built sandbox.
- Verify the specific change you made. `npm test <substring>` runs a subset.
- A test that needs tooling the container lacks exits **77** and prints
  `SKIP: <reason>`; the runner reports it as SKIP, not PASS. Three can do this
  today (`tippecanoe-decode`, build inputs). Never make a missing tool look
  like coverage.

The suite needs `shapely`, `osmium` and `Pillow` (`pip install shapely osmium
Pillow`) for the data tests, and Playwright for the forty-two browser tests.

### The long poles

`test_safety_model.mjs` (~600 s) bounds the suite's wall time, then
`test_route_potential.mjs` (~290 s), which proves the A* bound admissible, and
`test_adaptive_corridor_ferries.mjs` (~275 s). `test_route_portfolio.mjs` and
`test_corridor_severance.mjs` (~100–110 s each) are the ones that matter most:
they catch a scoring change that severs a corridor. The runner runs files
concurrently, so wall time is roughly the slowest file rather than the sum.

## Maps and states

Everything state-specific — data and configuration — is in `maps/<state>/`. No
file outside `maps/` names a state; `region.js` resolves whichever one the rider
selected into the global `Region`, and every data path in the app, the router
worker and the service worker comes from `Region.dataUrl(...)`.

The deliberate exception is the reviewed supplemental-route registry:
`maps/ROUTE-SOURCES.md` and `maps/route-sources.json`. It sits one level above
state folders so deleting and re-importing a state cannot erase a human source
decision. OSM bicycle relations remain the default. Do not discover or import
another route source as a routine part of a state import; only use this optional
pipeline when external evidence documents a real gap and a human has approved
the exact source and records in that registry.

**Commissioned to import a state?** `docs/IMPORT-A-STATE.md` is the brief.

**Importing a state starts at `docs/PORTING-TO-ANOTHER-STATE.md`.** Its "Start
here" section gives the reading order across all four documents, the build
sequence, the test that proves each stage, and the known blockers. Do not start
from a `BUILD.md` — that is a runbook for a state that is already understood.

`maps/README.md` is the contract. The short version:

- A state's truth is `maps/<state>/region.json`, including which files it
  actually has (`datasets`) and their content hashes (`versions`).
- `maps/states.js` is **generated** — `npm run maps:registry` after adding a
  state or editing a `region.json` by hand. The stampers regenerate it for you.
- Washington is the only state that ships. The machinery is deliberately not
  tested by a second real folder -- `test_maps_states_screen.mjs` invents two
  states and serves them over the generated index, so `maps/` can hold one state
  or fifty without a test moving.
- `readiness` in a `region.json` is scored against the rubric in
  `maps/README.md`, not self-assessed. Levels 8 and up require a rider; an agent
  importing a state tops out at 7 by design.
- If a change needs an edit to application code to support a state, that is the
  bug — the fact belongs in `region.json`.
- `docs/PORTING-LESSONS.md` holds the accumulated tuning rationale and the
  failure catalogue, mined from commit history. Lessons have stable IDs and a
  per-state `Travelled` ledger; when a state confirms or refutes one, update
  that line rather than rewriting the lesson.

## Working on iOS

`docs/IOS-HANDOFF.md` first. The native app is Capacitor wrapping this same web
app, so the only native-only code is `ios/App/App/BridgeViewController.swift`;
everything else is the shared JS that `npm test` already covers. The handoff
records the latest Xcode/simulator audit and the physical-device checks that
cannot be replaced by desktop testing.

`mobile-shell/` is generated by `npm run ios:sync`. Never edit it.

## Before the first commit of a session

The container's disk has twice rolled back to an older commit while `origin`
kept the real history, so committing from a stale tree would silently delete
work. Check first, every session:

```
git fetch origin main
git log --oneline HEAD..origin/main     # must be empty
```

If it is not empty, `git reset --hard origin/main` before doing
anything else.

## Other standing rules

- Keep replies short. Surface decisions instead of burying them; do not make
  design choices silently.
- **Get specific approval before starting any potentially 20+ minute piece of
  work** (a rebuild, a large download, a refactor, a long investigation).
  Name the work and its rough cost first; an earlier general go-ahead does
  not cover a new expensive step.
- The user does the field testing on a phone. Do not simulate rides or run long
  routing comparisons to prove a change is safe.
- All mechanics of the safety model belong in `docs/SAFETY-MODEL.md` — the
  specification, not a summary of the code.
- Bump `APP_VERSION` in `app.js` and `version.json` together; bump `VERSION` in
  `sw.js` when the app shell changes.
- **Nothing in this repository is "not yours".** A defect written in an earlier
  session, by an earlier agent, is yours the moment you are working in that
  file. Do not reach for "pre-existing" or "not mine" — it is a way of
  distancing yourself from something you are already touching, and it reads as
  exactly that. Two source-text assertions survived the sweep that deleted five
  hundred of them, sat in a file that got edited twice in one session, and were
  each time described as somebody else's. When they were finally rewritten they
  turned out to be asserting a UI shape the app had not had in a long time.
- **Running low on context is not a reason to stop working.** It is a normal,
  expected condition, not an emergency and not an excuse. Plan for the handoff
  instead: commit and push what is finished, write down precisely where you
  stopped and what you learned, and leave the next session — which may be you
  after compaction — enough to continue without re-deriving anything. Deciding
  that a task is too big for the remaining budget, and saying so instead of
  starting it, is the same failure as not doing the work.
