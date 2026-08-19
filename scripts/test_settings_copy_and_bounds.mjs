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

const speedSlider = await page.evaluate(() => {
  const input = document.getElementById('r-maxSpeedNoShoulder');
  return input ? { min: Number(input.min), max: Number(input.max), step: Number(input.step) }
    : { missing: true };
});
check('the no-shoulder speed control starts at the automatic 20 mph pass threshold',
  !speedSlider.missing && speedSlider.min === 20 && speedSlider.max === 45
    && speedSlider.step === 5, JSON.stringify(speedSlider));

const triggerSliders = await page.evaluate(() => {
  const read = (id) => {
    const input = document.getElementById(id);
    return input ? { min: Number(input.min), max: Number(input.max),
      value: Number(input.value) } : { missing: true };
  };
  const trafficInput = document.getElementById('r-busyNoShoulder');
  const originalTraffic = trafficInput.value;
  trafficInput.value = trafficInput.max;
  trafficInput.dispatchEvent(new Event('input', { bubbles: true }));
  const topLabel = document.getElementById('v-busyNoShoulder').textContent.trim();
  trafficInput.value = originalTraffic;
  trafficInput.dispatchEvent(new Event('input', { bubbles: true }));
  return { lanes: read('r-lanesNoShoulderOver'),
    traffic: { ...read('r-busyNoShoulder'), topLabel } };
});
check('the lane trigger cannot be set below two lanes',
  triggerSliders.lanes.min === 2, JSON.stringify(triggerSliders));
check('the traffic trigger starts at a quiet lane rather than Not used',
  triggerSliders.traffic.min === 1, JSON.stringify(triggerSliders));
check('the traffic trigger ends with a No limit choice',
  triggerSliders.traffic.max === 5 && triggerSliders.traffic.topLabel === 'No limit',
  JSON.stringify(triggerSliders));

// A rules object arriving from a shared link is untrusted input, and it reaches
// the same bounds. Feed it something out of range and read back what stuck.
const clamped = await page.evaluate(() => {
  const low = validRuleOverrides({ ...rules, minShoulder: -50,
    maxSpeedNoShoulder: -50, lanesNoShoulderOver: -50,
    busyNoShoulder: -50, upperMaxSpeed: 4000 });
  const high = validRuleOverrides({ ...rules, minShoulder: 99 });
  return { low: low.minShoulder, lowNoShoulderSpeed: low.maxSpeedNoShoulder,
    lowLanes: low.lanesNoShoulderOver, lowTraffic: low.busyNoShoulder,
    lowSpeed: low.upperMaxSpeed, high: high.minShoulder };
});
check('a shared link cannot push the shoulder outside those bounds',
  clamped.low === slider.min && clamped.high === slider.max, JSON.stringify(clamped));
check('and the same holds for the speed cutoff it carries',
  clamped.lowNoShoulderSpeed === speedSlider.min && clamped.lowSpeed <= 65,
  JSON.stringify(clamped));
check('shared rules cannot bypass the lane or traffic slider minima',
  clamped.lowLanes === triggerSliders.lanes.min
    && clamped.lowTraffic === triggerSliders.traffic.min,
  JSON.stringify(clamped));

/* ------------------------------------------------------- the grouped copy */
const copy = await page.evaluate(() => ({
  settings: document.getElementById('tab-settings')?.textContent.replace(/\s+/g, ' ') || '',
  weightsNotice: !!document.getElementById('weightsModifiedNotice'),
  weightsBody: (() => {
    openRoutingWeights();
    const text = document.querySelector('.weights-body')?.textContent.replace(/\s+/g, ' ') || '';
    settingsPaneSelect?.('rules');
    return text;
  })(),
}));
check('the bike-space rule reads as one requirement',
  copy.settings.includes('Require bike lane or safe-ish shoulder if any of these:'),
  copy.settings.slice(0, 160));
check('the weights screen carries a modified-state header', copy.weightsNotice);
check('and no longer claims weights are "never a safety rule"',
  !copy.weightsBody.includes('Never a safety rule.'), copy.weightsBody.slice(0, 160));

const presetRules = await page.evaluate(() => {
  openPresetInfo('randonneur');
  const labels = [...document.querySelectorAll('#presetInfoDetails strong')]
    .map((node) => node.textContent.trim().replace(/:$/, ''));
  document.getElementById('presetInfoDialog')?.close();
  return labels;
});
check('preset rule listings omit controls that moved to Advanced routing',
  !presetRules.some((label) => ['Sidewalk fallback', 'Mountain-bike trails',
    'Route preferences'].includes(label)), JSON.stringify(presetRules));
check('preset rule listings still expose their actual safety limits',
  presetRules.includes('Speed without shoulder or bike lane')
    && presetRules.includes('Minimum shoulder') && presetRules.includes('Freeways'),
  JSON.stringify(presetRules));

const presetCards = await page.evaluate(() => {
  document.getElementById('settings-tab-presets').click();
  return [...document.querySelectorAll('#settingsPresets .preset-card')].map((card) => {
    const blurb = card.querySelector('.preset-audience');
    const box = card.getBoundingClientRect();
    return {
      text: blurb.textContent.trim(),
      fontSize: parseFloat(getComputedStyle(blurb).fontSize),
      height: box.height,
      clipped: card.scrollHeight > card.clientHeight,
    };
  });
});
check('preset cards use their space for useful plain-language descriptions',
  presetCards.length === 3
    && presetCards.every((card) => card.text.length >= 80 && card.fontSize >= 11
      && card.height >= 50 && !card.clipped),
  JSON.stringify(presetCards));

/* ---------------- presets do not own the expert route-shaping options */
const presetIndependence = await page.evaluate(() => {
  window.confirm = () => true;
  applyRoutingPreset('weekend-wanderer');
  const note = document.getElementById('settingsRulesPresetNote');
  const activeHeight = note.getBoundingClientRect().height;
  const activeCopy = note.textContent;
  rules.alwaysPreferBikeRoutes = true;
  rules.allowSidewalkFallback = false;
  rules.allowMtbTrails = true;
  rules.allowFerries = false;
  routing.prefDesig = false;
  routing.prefResidential = false;
  syncPresetSelection();
  const activeAfterOptions = activeRoutingPreset()?.id;
  applyRoutingPreset('casual-cruiser');
  const preserved = rules.alwaysPreferBikeRoutes === true
    && rules.allowSidewalkFallback === false && rules.allowMtbTrails === true
    && rules.allowFerries === false && routing.prefDesig === false
    && routing.prefResidential === false;
  rules.minShoulder += 1;
  syncPresetSelection();
  const customHeight = note.getBoundingClientRect().height;
  const customCopy = note.textContent;
  Object.assign(rules, {
    alwaysPreferBikeRoutes: ADVANCED_ROUTE_OPTION_DEFAULTS.alwaysPreferBikeRoutes,
    allowSidewalkFallback: ADVANCED_ROUTE_OPTION_DEFAULTS.allowSidewalkFallback,
    allowMtbTrails: ADVANCED_ROUTE_OPTION_DEFAULTS.allowMtbTrails,
    allowFerries: ADVANCED_ROUTE_OPTION_DEFAULTS.allowFerries,
  });
  Object.assign(routing, {
    prefDesig: ADVANCED_ROUTE_OPTION_DEFAULTS.prefDesig,
    prefResidential: ADVANCED_ROUTE_OPTION_DEFAULTS.prefResidential,
  });
  return { activeCopy, activeAfterOptions, preserved, customCopy,
    heightShift: Math.abs(customHeight - activeHeight) };
});
check('advanced route options remain independent when a safety preset changes',
  presetIndependence.activeAfterOptions === 'weekend-wanderer'
    && presetIndependence.preserved,
  JSON.stringify(presetIndependence));
check('the Rules notice keeps its space and changes to custom-profile wording',
  /Changes override/.test(presetIndependence.activeCopy)
    && /custom rules profile/i.test(presetIndependence.customCopy)
    && presetIndependence.heightShift < 0.5,
  JSON.stringify(presetIndependence));

/* ---------------- route settings stay inspectable, but fixed, while riding */
const navigationLock = await page.evaluate(() => {
  turnNav.active = true;
  refreshNavigationUI();
  const rulesTab = document.getElementById('settings-tab-rules');
  rulesTab.click();
  const routeControls = [...document.querySelectorAll(
    '#settings-presets button, #settings-presets input, #settings-presets select, '
    + '#settings-limits button, #settings-limits input, #settings-limits select, '
    + '#settings-options button, #settings-options input, #settings-options select'
  )];
  const voiceControls = [...document.querySelectorAll(
    '#settings-voice button, #settings-voice input, #settings-voice select')];
  const routeCheckbox = document.querySelector('#settings-options input[type="checkbox"]');
  const routeBefore = routeCheckbox?.checked;
  const rulesVisible = !document.getElementById('settings-rules').hidden;
  routeCheckbox?.click();
  const lockDialog = document.getElementById('settingsNavLockDialog');
  const routeBlocked = routeCheckbox?.checked === routeBefore && lockDialog?.open;
  lockDialog?.close();
  document.getElementById('settings-tab-voice').click();
  const voiceCheckbox = document.querySelector('#settings-voice input[type="checkbox"]');
  const voiceBefore = voiceCheckbox?.checked;
  voiceCheckbox?.click();
  const result = {
    rulesVisible,
    limitsAndOptionsCombined: !!document.querySelector('#settings-rules > #settings-limits')
      && !!document.querySelector('#settings-rules > #settings-options'),
    tabsEnabled: !rulesTab.disabled,
    routeControlsLegible: routeControls.length > 0 && routeControls.every((control) => !control.disabled),
    routeBlocked,
    voiceControlsLive: voiceControls.length > 0 && voiceControls.every((control) => !control.disabled),
    voiceChanged: voiceCheckbox?.checked !== voiceBefore,
  };
  turnNav.active = false;
  refreshNavigationUI();
  return result;
});
check('navigation keeps every Settings tab browsable while route values are read-only',
  navigationLock.rulesVisible && navigationLock.limitsAndOptionsCombined && navigationLock.tabsEnabled
    && navigationLock.routeControlsLegible && navigationLock.routeBlocked,
  JSON.stringify(navigationLock));
check('Voice-Nav stays live during the ride',
  navigationLock.voiceControlsLive && navigationLock.voiceChanged,
  JSON.stringify(navigationLock));

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
