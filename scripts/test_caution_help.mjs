#!/usr/bin/env node
// Under the project's design rule, a setting that sounds objective must have an
// objective consequence, and the rider must be able to find out what it is. So:
// every rules control needs a help entry, and every reason a road can be amber
// needs to appear in the "What makes a road caution?" list.
//
// That list is generated from SafetyModel.CAUTION_CAUSES rather than written by
// hand, so this test checks the generator has something to say about each cause
// and that the help dialog is where it can say it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const modelSrc = fs.readFileSync(new URL('../safety-model.js', import.meta.url), 'utf8');

const sandbox = { self: {} };
vm.createContext(sandbox);
vm.runInContext(modelSrc, sandbox);
const { CAUTION_CAUSES } = sandbox.self.SafetyModel;

/* ------------------------------------- every cause is named and described */
const table = (name) => {
  const start = app.indexOf(`const ${name} = {`);
  assert.ok(start > 0, `${name} should exist in app.js`);
  return app.slice(start, app.indexOf('\n};', start));
};
const names = table('CAUTION_CAUSE_NAME');
const details = table('CAUTION_CAUSE_DETAIL');
for (const cause of CAUTION_CAUSES) {
  const key = /^[a-z]+$/.test(cause) ? cause : `'${cause}'`;
  assert.ok(names.includes(`${key}:`), `CAUTION_CAUSE_NAME is missing "${cause}"`);
  assert.ok(details.includes(`${key}:`), `CAUTION_CAUSE_DETAIL is missing "${cause}"`);
}

/* ------------------------------------------- the help list is generated */
assert.match(app, /function buildCautionCauseHelp\(\)[\s\S]*?for \(const cause of SafetyModel\.CAUTION_CAUSES\)/,
  'the caution help list must be generated from CAUTION_CAUSES, not hand-written');
assert.match(html, /<h3>What makes a road caution\?<\/h3>[\s\S]*?id="cautionCauseList"/,
  'the settings help should have a "What makes a road caution?" section to fill');
assert.match(app, /settingsHelpBtn'\)\.addEventListener\('click', \(\) => \{\s*buildCautionCauseHelp\(\);/,
  'the list should be rebuilt each time help opens, so it follows the current rules');
assert.match(html, /Amber is not a failure/,
  'the section should say plainly that caution is not a rule failure');

/* --------------------- every rules control has an entry in settings help */
const helpDialog = html.match(/<dialog id="settingsHelpDialog"[\s\S]*?<\/dialog>/)?.[0] || '';
assert.ok(helpDialog, 'the settings help dialog should exist');
// Labels as the rider reads them, taken from the control definitions.
const labels = [...app.matchAll(/check\('(\w+)', ['`]([^'`]+)['`]/g)].map((m) => m[2])
  .concat([...app.matchAll(/slider\('(\w+)', '([^']+)'/g)].map((m) => m[2]))
  .concat(['Lanes needing a shoulder or bike lane', 'Never allow roads faster than']);
const strip = (s) => s.replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
  .replace(/\$\{STRESS_AGENCY\}/g, 'WSDOT')
  .replace(/\s+/g, ' ').trim();
const helpText = strip(helpDialog);
const missing = labels
  .map(strip)
  .filter((label) => !/^(Speak|Status|Off-route)/.test(label))
  .filter((label) => !helpText.includes(label));
assert.deepEqual(missing, [],
  `every rules control needs a help entry; missing: ${missing.join(' | ')}`);

/* ---------------------- the legend must speak the map's own vocabulary */
const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const routeDetails = fs.readFileSync(new URL('../route-details.js', import.meta.url), 'utf8');
const colour = (level) => {
  const m = new RegExp(`\\n\\s*${level}: '(#[0-9a-f]{6})'`).exec(app);
  assert.ok(m, `COLORS[${level}] should be findable in app.js`);
  return m[1];
};
const CAUTION = colour(3);
const FAIL = colour(4);
assert.ok(css.includes(`.layer-toggle-swatch.caution`) && css.includes(CAUTION),
  `the legend caution swatch should use COLORS[3] (${CAUTION})`);
assert.ok(css.includes(`.layer-toggle-swatch.caution { background: repeating-linear-gradient(90deg,${CAUTION} 0 4px,${FAIL} 4px 6px); }`),
  'the caution swatch should show rungs in the danger red, exactly as the map draws them');
assert.match(css, /\.layer-toggle-swatch\.fails \{[^}]*repeating-linear-gradient\(115deg[^}]*#fff/,
  'the fails swatch should show the diagonal slashes the map draws');
assert.ok(css.includes(`.layer-toggle-swatch.fails { background: repeating-linear-gradient(115deg,${FAIL}`),
  `the legend fails swatch should use COLORS[4] (${FAIL})`);
assert.match(css, /\.layer-toggle-swatch\.prohibited \{[^}]*repeating-linear-gradient\(90deg/,
  'bikes-prohibited keeps its own dashed swatch, distinct from a rules failure');
// Caution has four causes; the legend must not name only one of them.
assert.doesNotMatch(app, /'Caution \(limited access\)'/,
  'the legend must not claim caution means limited access -- there are four causes');
assert.match(app, /\['caution', 'Caution — ride with care', 'caution'\]/,
  'the legend caution row should be cause-neutral');
// Route Details keeps its own palette copy; it must not drift.
assert.ok(routeDetails.includes(`const CAUTION_COLOR = '${CAUTION}'`),
  `route-details.js CAUTION_COLOR should match COLORS[3] (${CAUTION})`);
assert.ok(routeDetails.includes(`const FAIL_COLOR = '${FAIL}'`),
  `route-details.js FAIL_COLOR should match COLORS[4] (${FAIL})`);

/* ------------------------------------- the stress agency is written once */
const agencyUses = (app.match(/'WSDOT'/g) || []).length;
assert.equal(agencyUses, 1,
  'the stress agency name should live in STRESS_AGENCY alone, so another state is a one-line change');
// The model may explain itself with a real example in a comment, but no rule
// in it may depend on which agency published the rating.
const codeOnly = modelSrc.split('\n')
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n');
assert.doesNotMatch(codeOnly, /WSDOT|wsdot/,
  'safety-model.js may name an agency in commentary only, never in a rule');
assert.match(modelSrc, /stressRating/,
  'the model should speak of a Level of Traffic Stress rating, not an agency');

console.log(`Caution-help tests passed (${CAUTION_CAUSES.length} causes, `
  + `${labels.length} controls documented).`);
