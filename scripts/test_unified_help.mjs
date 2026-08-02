#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

assert.equal((html.match(/<dialog id="helpDialog"/g) || []).length, 1,
  'all help topics must share one help dialog');

const topics = ['getting-started', 'routes', 'layers', 'settings', 'save-share', 'technical'];
assert.deepEqual([...html.matchAll(/data-help-tab="([^"]+)"/g)].map((match) => match[1]), topics,
  'the unified help tabs must include every existing help destination in a stable order');

for (const source of [
  'appHelpTemplate', 'routeTipsTemplate', 'layersHelpTemplate',
  'settingsHelpTemplate', 'routesHelpTemplate', 'techDetailsTemplate',
]) {
  assert.ok(html.includes(`<template id="${source}">`), `${source} content source is missing`);
  assert.ok(html.includes(`data-help-source="${source}"`), `${source} is not attached to a help panel`);
}

for (const button of ['appHelpBtn', 'routeTipsBtn', 'layersHelpBtn', 'settingsHelpBtn', 'routesHelpBtn']) {
  assert.ok(html.includes(`id="${button}"`), `${button} entry point must remain in place`);
}

const mappings = [
  [/appHelpBtn[\s\S]{0,120}openHelp\('getting-started'\)/, 'app help'],
  [/routeTipsBtn[\s\S]{0,100}openRouteTips/, 'route help'],
  [/layersHelpBtn[\s\S]{0,120}openHelp\('layers'\)/, 'layers help'],
  [/settingsHelpBtn[\s\S]{0,160}openHelp\('settings'\)/, 'settings help'],
  [/routesHelpBtn[\s\S]{0,180}openHelp\('save-share'\)/, 'save and share help'],
  [/techDetailsBtn[\s\S]{0,120}openHelp\('technical'\)/, 'technical help'],
];
for (const [pattern, label] of mappings) assert.match(app, pattern, `${label} must open its associated tab`);

for (const legacy of [
  'appHelpDialog', 'routeTipsDialog', 'layersHelpDialog',
  'settingsHelpDialog', 'routesHelpDialog', 'techDetailsDialog',
]) {
  assert.ok(!html.includes(`id="${legacy}"`), `${legacy} must not remain as a separate dialog`);
  assert.ok(!app.includes(`getElementById('${legacy}')`), `${legacy} must not remain in app behavior`);
}

assert.match(app, /\['ArrowLeft', 'ArrowRight', 'Home', 'End'\]/,
  'the tab list must support keyboard navigation');
assert.match(styles, /\.help-dialog\[open\][^{]*\{[^}]*display:\s*flex/,
  'the unified help view must use its fixed header and scrollable article layout');
assert.match(styles, /\.help-tabs[^}]*overflow-x:\s*auto/,
  'desktop help tabs may retain their compact overflow fallback');
assert.match(styles, /@media \(max-width:\s*600px\)[\s\S]*?\.help-tabs\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(3/,
  'all six phone tabs must be visible in a two-row grid without swiping');
assert.match(styles, /\.help-panels[^}]*overflow-y:\s*auto/,
  'only the active help article should scroll');

console.log('Unified tabbed help tests passed.');
