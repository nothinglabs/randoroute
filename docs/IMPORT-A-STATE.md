# Import a state — the assignment

This is the standing brief for commissioning a state import. It is not the
method: `docs/PORTING-TO-ANOTHER-STATE.md` is, and reading it is your first
instruction. This file says what you are being asked to deliver, what you will
deliberately not be told, and how to report back.

Substitute the state you were given for **`<STATE>`** throughout.

---

## The assignment

Import `<STATE>` into this repository, to **readiness 7** on the rubric in
`maps/README.md`.

**Target 7, do not chase it.** Each level has a gate. Do not award a level whose
gate you have not actually met, and do not claim one in order to be finished. If
you stop at 4, stop at 4 and say why — a truthful 4 with a clear account of what
blocked 5 is a better outcome than a 7 nobody can check.

7 is your ceiling by design. Levels 8 and above require someone to ride the
routes, and no amount of research substitutes for that. You are not expected to
reach 8; you are expected to leave the state in a condition where somebody can.

## Start here

1. `docs/PORTING-TO-ANOTHER-STATE.md` — the entry point. Its "Start here"
   section gives the reading order across the four documents, the build
   sequence, the test that proves each stage, and the known blockers. Read it
   before you fetch anything.
2. `docs/PORTING-LESSONS.md` — what went wrong the first time, with the
   measurements that settled each question. Read it before you start, and again
   whenever something looks off. Most of those failures did not present as data
   problems.

Washington is the reference implementation. `maps/washington/BUILD.md` is its
runbook — adapt it, do not follow it literally, and do not start from it (see
the entry point on why).

## Deliverables

- [ ] `maps/<state>/region.json`, validated by `npm run maps:registry`
- [ ] `maps/<state>/STATUS.md` — what works, what does not, and the readiness
      level with the gate you met for it. Washington's is the model: it explains
      its score in terms of **coverage**, not effort.
- [ ] `maps/<state>/BUILD.md` — every command that produced every file, in
      order, so the next person can rebuild it without you.
- [ ] `maps/<state>/VERIFICATION.md` — the level-5 gate. `maps/README.md` says
      what it must contain. The part that matters: **every disagreement between
      the router and a known-good route needs a diagnosis**, not just a note
      that it differs. Data gap, severed link, legitimate safety disagreement,
      or unknown — say which.
- [ ] Filled-in `Travelled` lines in `docs/PORTING-LESSONS.md`, for every lesson
      you hit. **Including the ones that turned out not to apply** — a lesson
      that fails to travel is worth more than one that holds, because it is the
      only way to find out which of those are Washington artefacts.
- [ ] `npm test` green.

## Working agreement

- **Work on a branch.** Do not push to `main`.
- **Do not modify another state's data**, or the shared model, router, or map
  styling. If you find yourself needing to, that is a finding — write it down
  (see below) rather than working around it. The entry point says the same
  thing: a state fact reaching shared logic is the bug.
- **Commit each artefact the moment it builds**, not at the end of the work.
  The container is reclaimed after an idle period and takes everything untracked
  with it. A long build will not survive a quiet stretch, and this has cost a
  built and verified graph before.
- **Nominate your corridors before you build anything.** Four or five real
  routes across the state, written down first. They are the spec for stage 5,
  and choosing them afterwards means choosing the ones that happened to work.

## Fix what you find

**If the documentation is wrong, incomplete, or sends you down a wrong path,
fix it as part of the work and say so in the commit.**

This is not a courtesy. The documents were written by someone who had the whole
project in their head, and the open question is whether they carry enough for
someone who does not. You are the first reader who is not that person. Every
place you had to guess, backtrack, or work something out that a document should
have told you is a defect in the document, and reporting it is as valuable as
the import itself.

Keep a running list as you go — you will not remember them at the end.

## What you will not be told, and why

- **Which sources the state publishes.** Finding them is the method being
  tested, and it is the step most likely to go wrong. `PORTING-TO-ANOTHER-STATE.md`
  §2 tells you how to look; it does not tell you what you will find.
- **What the commissioner expects the result to look like.** They know this
  state and have written down predictions they are holding back deliberately.
  If you knew which corridors would be checked, you would optimise for those.

Ask if you are blocked. Do not ask to be told the answer to either of these.

## How to report back

When you stop — at 7 or short of it — say:

1. The level reached, and the gate you met for it.
2. What you could not verify, and what it would take.
3. The documentation defects you found, and whether you fixed them.
4. Anything that needed a change outside `maps/<state>/`, and why.
