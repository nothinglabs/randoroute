#!/usr/bin/env node
// PORTING-LESSONS.md is append-only institutional memory. Its own rules say
// lessons have stable IDs, are never renumbered, and are retired rather than
// deleted -- but a rule in a file is advisory, and the file is edited by
// every import (each one fills in Travelled lines and may add lessons). This
// pins the rule mechanically: every lesson ID that has ever shipped must
// still exist, each exactly once, with its Travelled ledger line intact.
//
// Adding lessons is free. When one is genuinely retired (the documented
// process), remove its ID here in the same commit -- that is the review
// moment the append-only rule exists to force.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, check, done } from './testlib/harness.mjs';

const SHIPPED_IDS = [
  'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9',
  'B1', 'B2', 'B3', 'B4', 'B5', 'B6',
  'C1', 'C2', 'C3', 'C4',
  'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9',
  'E1', 'E2', 'E3', 'E4', 'E5', 'E6',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6',
  'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7',
];

const text = readFileSync(join(ROOT, 'docs/PORTING-LESSONS.md'), 'utf8');
const headings = [...text.matchAll(/^### ([A-Z][0-9]+) — /gm)].map((match) => match[1]);

check('every shipped lesson ID still exists',
  SHIPPED_IDS.every((id) => headings.includes(id)),
  `missing: ${SHIPPED_IDS.filter((id) => !headings.includes(id)).join(', ')}`);
check('no lesson ID appears twice',
  new Set(headings).size === headings.length,
  headings.filter((id, index) => headings.indexOf(id) !== index).join(', '));
check('new lessons are additions, not renumberings: every heading is well-formed',
  headings.length >= SHIPPED_IDS.length,
  `${headings.length} headings vs ${SHIPPED_IDS.length} shipped`);

// Every lesson carries a Travelled ledger -- the whole reason IDs exist. An
// import that adds a lesson without one has broken the format.
const sections = text.split(/^### /m).slice(1);
const missingTravelled = sections
  .filter((section) => /^[A-Z][0-9]+ — /.test(section) && !/\*Travelled[.:]?\*/.test(section))
  .map((section) => section.slice(0, section.indexOf(' ')));
check('every lesson carries its Travelled ledger', missingTravelled.length === 0,
  `missing: ${missingTravelled.join(', ')}`);

done();
