#!/usr/bin/env node
// Settings, checked by using them.
//
// This file used to match regular expressions against app.js and index.html --
// `/minShoulder:\s*\[2,\s*10\]/`, `/scheduleRescore\(\)/`,
// `doesNotMatch(/\bcomputeRoute\s*\(/)`. Every one of those pins a spelling
// rather than a behaviour: they break when a variable is renamed and pass when
// the clamp is applied to the wrong value. What the rider actually needs is
// that the shoulder control cannot go below 2 ft, that a rules payload arriving
// from a shared link is clamped to the same bounds, and that re-picking the
// preset already in force does nothing at all.
import { chromiumPath, playwright, serveRepo } from './testlib/harness.mjs';

const { chromium } = await playwright();
const site = await serveRepo();
const browser = await chromium.launch({
  executablePath: chromiumPath(), args: ['--use-gl=swiftshader'],
});
const page = await (await browser.newContext({
  serviceWorkers: 'block', viewport: { width: 1200, height: 900 },
})).newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};

await page.goto(site.url, { waitUntil: 'load' });
await page.waitForFunction(() => typeof applyRoutingPreset === 'function', { timeout: 60000 });
await page.evaluate(() => selectPanelTab('settings'));

/* ------------------------------------------------- the shoulder slider bound */
const slider = await page.evaluate(() => {
  const input = document.querySelector('#settingsSliders input[data-rule="minShoulder"]')
    || document.querySelector('input[data-rule="minShoulder"]')
    || document.getElementById('r-minShoulder');
  if (!input) return { missing: true };
  const label = input.closest('.rule')?.textContent.replace(/\s+/g, ' ').trim() || '';
  return { min: Number(input.min), max: Number(input.max), step: Number(input.step), label };
});
check('the shoulder control cannot be set below 2 ft',
  !slider.missing && slider.min === 2 && slider.max === 10, JSON.stringify(slider));
check('and it is labelled as the safe-ish width',
  /safe-ish/i.test(slider.label), slider.label);

// A rules object arriving from a shared link is untrusted input, and it reaches
// the same bounds. Feed it something out of range and read back what stuck.
const clamped = await page.evaluate(() => {
  const low = validRuleOverrides({ ...rules, minShoulder: -50, upperMaxSpeed: 4000 });
  const high = validRuleOverrides({ ...rules, minShoulder: 99 });
  return { low: low.minShoulder, lowSpeed: low.upperMaxSpeed, high: high.minShoulder };
});
check('a shared link cannot push the shoulder outside those bounds',
  clamped.low === slider.min && clamped.high === slider.max, JSON.stringify(clamped));
check('and the same holds for the speed cutoff it carries',
  clamped.lowSpeed <= 65, JSON.stringify(clamped));

/* ------------------------------------------------------- the grouped copy */
const copy = await page.evaluate(() => ({
  settings: document.getElementById('tab-settings')?.textContent.replace(/\s+/g, ' ') || '',
  weightsNotice: !!document.getElementById('weightsModifiedNotice'),
  weightsBody: (() => {
    document.getElementById('weightsDialog')?.showModal?.();
    const text = document.querySelector('.weights-body')?.textContent.replace(/\s+/g, ' ') || '';
    document.getElementById('weightsDialog')?.close?.();
    return text;
  })(),
}));
check('the bike-space rule reads as one requirement',
  copy.settings.includes('Require a bike lane or safe-ish width shoulder.'),
  copy.settings.slice(0, 160));
check('the weights screen carries a modified-state header', copy.weightsNotice);
check('and no longer claims weights are "never a safety rule"',
  !copy.weightsBody.includes('Never a safety rule.'), copy.weightsBody.slice(0, 160));

/* ------------------------------------- re-picking the active preset is a no-op */
const reapply = await page.evaluate(async () => {
  const preset = ROUTING_PRESETS[1];
  applyRoutingPreset(preset.id);
  await new Promise((resolve) => setTimeout(resolve, 250));
  // Count the work a preset change causes, then ask for the same one again.
  let rescores = 0, routes = 0;
  const realRescore = window.scheduleRescore || scheduleRescore;
  const realCompute = computeRoute;
  window.scheduleRescore = (...args) => { rescores++; return realRescore(...args); };
  window.computeRoute = (...args) => { routes++; return realCompute(...args); };
  const rulesBefore = JSON.stringify(rules);
  applyRoutingPreset(preset.id);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const same = { rescores, routes, unchanged: JSON.stringify(rules) === rulesBefore };
  applyRoutingPreset(ROUTING_PRESETS[2].id);
  await new Promise((resolve) => setTimeout(resolve, 250));
  return { same, changedRules: JSON.stringify(rules) !== rulesBefore };
});
check('re-picking the preset already in force changes nothing',
  reapply.same.unchanged, JSON.stringify(reapply));
check('and picking a different one does', reapply.changedRules, JSON.stringify(reapply));

check('using the settings pane raises no errors', errors.length === 0, errors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
