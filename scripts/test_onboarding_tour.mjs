#!/usr/bin/env node
// The app tour must WORK, not merely exist: every screenshot it promises has
// to load, the preset step has to really apply a preset, and the whole flow
// has to be walkable with a thumb on a phone.
//
// The images are curated captures shipped in onboarding/ (see its README) and
// precached by the service worker BY NAME, so the likeliest rot is a renamed
// or missing file: the dialog would open fine and show broken image icons.
// naturalWidth catches that against the real static server.
import { appPage, launchBrowser, serveRepo, check, done } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);
await page.waitForFunction(() => typeof openHelp === 'function' && typeof openOnboarding === 'function',
  null, { timeout: 120000 });

// ---- launch: the button lives in Help > Getting started and is thumb-sized
const launch = await page.evaluate(async () => {
  openHelp('getting-started');
  await new Promise((r) => setTimeout(r, 250));
  const button = document.getElementById('startTourBtn');
  const rect = button?.getBoundingClientRect();
  button?.click();
  await new Promise((r) => setTimeout(r, 400));
  return {
    buttonHeight: rect ? Math.round(rect.height) : 0,
    helpClosed: !document.getElementById('helpDialog').open,
    tourOpen: document.getElementById('onboardingDialog').open,
  };
});
check('Help > Getting started carries a thumb-sized tour button', launch.buttonHeight >= 36,
  `${launch.buttonHeight}px`);
check('the tour opens and Help gets out of its way', launch.helpClosed && launch.tourOpen,
  JSON.stringify(launch));

// ---- content: every step image resolves, exactly one step shows at a time
const content = await page.evaluate(async () => {
  const steps = [...document.querySelectorAll('.onboarding-step')];
  const images = [...document.querySelectorAll('.onboarding-step img')];
  await Promise.all(images.map((img) => img.complete ? null
    : new Promise((r) => { img.onload = r; img.onerror = r; })));
  return {
    stepCount: steps.length,
    visible: steps.filter((step) => !step.hidden).length,
    firstVisible: !steps[0].hidden,
    brokenImages: images.filter((img) => !img.naturalWidth).map((img) => img.src),
    missingAlt: images.filter((img) => !img.alt).length,
    dots: document.querySelectorAll('.onboarding-dot').length,
  };
});
check('the tour has its steps and shows exactly the first',
  content.stepCount >= 6 && content.visible === 1 && content.firstVisible,
  JSON.stringify(content));
check('every step screenshot loads from the shipped assets',
  content.brokenImages.length === 0, content.brokenImages.join(' '));
check('every screenshot carries alt text', content.missingAlt === 0, `${content.missingAlt} missing`);
check('the dots track the steps', content.dots === content.stepCount, JSON.stringify(content));

// ---- walk: Next reaches the preset step, Back comes home, labels flip
const walk = await page.evaluate(async () => {
  const next = document.getElementById('onboardingNext');
  const back = document.getElementById('onboardingBack');
  const backDisabledAtStart = back.disabled;
  const steps = [...document.querySelectorAll('.onboarding-step')];
  for (let i = 0; i < steps.length - 1; i++) next.click();
  const lastShown = !steps[steps.length - 1].hidden;
  const finishLabel = next.textContent;
  back.click();
  const backedUp = !steps[steps.length - 2].hidden;
  next.click();
  return { backDisabledAtStart, lastShown, finishLabel, backedUp,
    presetCards: document.querySelectorAll('.onboarding-preset').length };
});
check('Back sleeps on step one and Next walks to the end',
  walk.backDisabledAtStart && walk.lastShown && walk.backedUp, JSON.stringify(walk));
check('the last step offers Finish and one preset card per preset',
  walk.finishLabel === 'Finish' && walk.presetCards === 3, JSON.stringify(walk));

// ---- preset: tapping a card really applies it, marks it, and survives reopen
const preset = await page.evaluate(async () => {
  const card = document.querySelector('.onboarding-preset[data-preset-id="casual-cruiser"]');
  const cardHeight = Math.round(card.getBoundingClientRect().height);
  card.click();
  const applied = activeRoutingPreset()?.id;
  const marked = document.querySelector('.onboarding-preset.selected')?.dataset.presetId;
  const requireSafeFollowed = rules.requireSafe === true;
  document.getElementById('onboardingNext').click();
  const closedAfterFinish = !document.getElementById('onboardingDialog').open;
  openOnboarding();
  const reopenedAtStart = !document.querySelectorAll('.onboarding-step')[0].hidden;
  const stillMarked = document.querySelector('.onboarding-preset.selected')?.dataset.presetId;
  document.getElementById('onboardingClose').click();
  return { cardHeight, applied, marked, requireSafeFollowed, closedAfterFinish,
    reopenedAtStart, stillMarked };
});
check('tapping a preset card applies that preset to the live rules',
  preset.applied === 'casual-cruiser' && preset.marked === 'casual-cruiser'
    && preset.requireSafeFollowed, JSON.stringify(preset));
check('preset cards are thumb-sized', preset.cardHeight >= 44, `${preset.cardHeight}px`);
check('Finish closes; reopening starts over with the choice still marked',
  preset.closedAfterFinish && preset.reopenedAtStart && preset.stillMarked === 'casual-cruiser',
  JSON.stringify(preset));

// ---- legibility on the phone profile
const legibility = await page.evaluate(() => {
  openOnboarding();
  const sizes = [...document.querySelectorAll('.onboarding-step:not([hidden]) h3, .onboarding-step:not([hidden]) p, .onboarding-next, .onboarding-back')]
    .map((el) => parseFloat(getComputedStyle(el).fontSize));
  const buttons = ['onboardingNext', 'onboardingBack', 'onboardingClose']
    .map((id) => Math.round(document.getElementById(id).getBoundingClientRect().height));
  document.getElementById('onboardingClose').click();
  return { minFont: Math.min(...sizes), minButton: Math.min(...buttons) };
});
check('tour text stays legible', legibility.minFont >= 11, `${legibility.minFont}px`);
check('tour buttons stay thumb-sized', legibility.minButton >= 36, `${legibility.minButton}px`);

check('no page errors', page.pageErrors.length === 0, page.pageErrors.join(' | '));

await browser.close();
await site.close();
done();
