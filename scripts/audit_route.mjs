#!/usr/bin/env node
/*
 * Route auditing: run real trips through the real router and score them for
 * the shapes a rider calls "bizarre".
 *
 * Not a test -- nothing here passes or fails. It exists because judging a
 * route by eye does not scale: a bare polyline on white is nearly unreadable
 * (is that zigzag a hill climb or a bug?), and forty routes is far past what
 * anyone will squint at honestly. So this measures first and draws second.
 * The metrics rank which routes deserve human attention; scripts/audit_plot.py
 * draws the ones that do.
 *
 * Two things it must get right, both learned the hard way:
 *
 *  - The PORTFOLIO needs `weights` AND `directProbeWeights`. Omit the lens and
 *    the worker returns two candidates instead of four or six, none of them
 *    the "Shorter" route the rider actually sees. Every early probe in the
 *    investigation that produced this file was wrong for exactly that reason.
 *  - The RULES are app defaults (allowFreeways true, lanesNoShoulderOver 3),
 *    not a plausible-looking hand-written set.
 *
 * Both are lifted from app.js rather than copied, so this cannot drift away
 * from what the app asks for.
 *
 * Usage:
 *   node scripts/audit_route.mjs <spec.json> [outDir]
 *
 * A spec is { "state": "washington", "routes": [ { id, name, from:[lng,lat],
 * to:[lng,lat], note?, rules?: {overrides} } ] }.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { ROOT, routerWorker } from './testlib/harness.mjs';

/* ---------------------------------------------- what the app actually asks */
// Lifted from app.js source: a copy here would be a second source of truth
// for the very thing under audit, and would quietly rot.
const appSource = readFileSync(join(ROOT, 'app.js'), 'utf8');

// One sandbox for all of them, filled in source order: these constants refer
// to each other (DEFAULT_RULES reads ADVANCED_ROUTE_OPTION_DEFAULTS), so
// lifting each in isolation cannot work.
const appConstants = vm.createContext({ Object, Math, Number, String, Boolean, Array, JSON });
const declarationOf = (name) => {
  const match = appSource.match(
    new RegExp(`const ${name} = Object\\.freeze\\(\\{[\\s\\S]*?\\n\\}\\);`))
    || appSource.match(new RegExp(`const ${name} = Object\\.freeze\\(\\[[\\s\\S]*?\\]\\);`));
  if (!match) throw new Error(`app.js no longer defines ${name}`);
  return match[0];
};
for (const name of ['ADVANCED_ROUTE_OPTION_DEFAULTS', 'DEFAULT_RULES',
  'DEFAULT_ROUTING_WEIGHTS', 'DIRECT_LENS_SCALED_MULTIPLIERS',
  'DIRECT_LENS_SCALED_RATES']) {
  vm.runInContext(declarationOf(name), appConstants);
}
const liftFrozen = (name) => vm.runInContext(name, appConstants);

export const DEFAULT_WEIGHTS = liftFrozen('DEFAULT_ROUTING_WEIGHTS');
const LENS_MULTIPLIERS = liftFrozen('DIRECT_LENS_SCALED_MULTIPLIERS');
const LENS_RATES = liftFrozen('DIRECT_LENS_SCALED_RATES');
const LENS_EXPONENT = Number(
  /const DIRECT_LENS_EXPONENT = ([\d.]+)/.exec(appSource)?.[1] ?? 0.22);

/** app.js's directLensRoutingWeights(), over the default weights. */
export function directLensWeights(base = DEFAULT_WEIGHTS) {
  const weights = { ...base };
  const bound = (value) => Math.min(120, Math.max(0.1, value));
  for (const key of LENS_MULTIPLIERS) {
    if (Number.isFinite(weights[key])) {
      weights[key] = +bound(Math.pow(weights[key], LENS_EXPONENT)).toFixed(4);
    }
  }
  for (const key of LENS_RATES) {
    if (Number.isFinite(weights[key])) {
      weights[key] = +(weights[key] * LENS_EXPONENT).toFixed(5);
    }
  }
  return weights;
}

/**
 * The rider's default rules: exactly app.js's `rules` initialiser, which is
 * DEFAULT_RULES with two advanced options layered over it. Composed the same
 * way rather than transcribed, so a default that moves in app.js moves here.
 */
export function defaultRules() {
  const advanced = liftFrozen('ADVANCED_ROUTE_OPTION_DEFAULTS');
  return {
    ...liftFrozen('DEFAULT_RULES'),
    allowFerries: advanced.allowFerries,
    alwaysPreferBikeRoutes: advanced.alwaysPreferBikeRoutes,
  };
}

/* ------------------------------------------------------------- geometry */
const R = 6371000;
export function havM([lon1, lat1], [lon2, lat2]) {
  const p1 = (lat1 * Math.PI) / 180, p2 = (lat2 * Math.PI) / 180;
  const dp = p2 - p1, dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const bearing = ([lon1, lat1], [lon2, lat2]) => {
  const p1 = (lat1 * Math.PI) / 180, p2 = (lat2 * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  return Math.atan2(Math.sin(dl) * Math.cos(p2),
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl))
    * 180 / Math.PI;
};

/* -------------------------------------------------------------- metrics */
/**
 * Score one route's shape.
 *
 * `backtrackM` is the headline number and the one worth understanding. Let
 * progress(i) be how much closer to the destination the route has got by
 * point i, as the crow flies. On a sane route that curve only rises. Its
 * biggest DRAWDOWN -- the largest ground it ever gives back -- is exactly
 * what a rider means by "it went the wrong way and came back", and it is
 * scale-free: a 40 m jog around a one-way block scores 40, the Lake Forest
 * Park excursion scores hundreds, a wrong-side-of-the-lake blunder scores
 * thousands. Everything else here is supporting evidence.
 */
export function routeMetrics(coords, from, to) {
  const n = coords.length;
  const crowM = havM(from, to);
  const along = [0];
  for (let i = 1; i < n; i++) along.push(along[i - 1] + havM(coords[i - 1], coords[i]));
  const lengthM = along[n - 1] || 0;

  const progress = coords.map((c) => crowM - havM(c, to));
  let peak = -Infinity, backtrackM = 0, backtrackAtM = 0, backtrackEndM = 0, peakAtM = 0;
  for (let i = 0; i < n; i++) {
    if (progress[i] > peak) { peak = progress[i]; peakAtM = along[i]; }
    const draw = peak - progress[i];
    if (draw > backtrackM) { backtrackM = draw; backtrackAtM = peakAtM; backtrackEndM = along[i]; }
  }

  // Near-self-contact between parts of the route that are far apart along it:
  // the lollipop signature. The along-path gate is what keeps an ordinary
  // switchback -- close in space AND close along the path -- from counting.
  const GATE_M = 800;
  let selfTouchM = Infinity, selfTouchAtM = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (along[j] - along[i] < GATE_M) continue;
      const d = havM(coords[i], coords[j]);
      if (d < selfTouchM) { selfTouchM = d; selfTouchAtM = along[i]; }
    }
  }

  // Direction reversals, sampled every ~120 m so block-level jitter and
  // gentle curves do not register as U-turns.
  const marks = [];
  for (let i = 0, next = 0; i < n; i++) {
    if (along[i] >= next) { marks.push(coords[i]); next = along[i] + 120; }
  }
  let reversals = 0;
  for (let i = 2; i < marks.length; i++) {
    const a = bearing(marks[i - 2], marks[i - 1]);
    const b = bearing(marks[i - 1], marks[i]);
    let delta = Math.abs(b - a);
    if (delta > 180) delta = 360 - delta;
    if (delta > 150) reversals++;
  }

  return {
    lengthM: Math.round(lengthM),
    crowM: Math.round(crowM),
    detourFactor: crowM ? +(lengthM / crowM).toFixed(2) : null,
    backtrackM: Math.round(backtrackM),
    backtrackAtM: Math.round(backtrackAtM),
    backtrackEndM: Math.round(backtrackEndM),
    selfTouchM: selfTouchM === Infinity ? null : Math.round(selfTouchM),
    selfTouchAtM: Math.round(selfTouchAtM),
    reversals,
  };
}

/**
 * Which routes a human should look at, and why. Thresholds are deliberately
 * loose: this decides where to spend attention, not what is broken.
 */
export function suspicion(metrics) {
  const flags = [];
  if (metrics.backtrackM >= 150) flags.push(`backtrack ${metrics.backtrackM}m`);
  if (metrics.detourFactor >= 1.6) flags.push(`detour x${metrics.detourFactor}`);
  if (metrics.selfTouchM !== null && metrics.selfTouchM < 60) {
    flags.push(`self-touch ${metrics.selfTouchM}m`);
  }
  if (metrics.reversals >= 6) flags.push(`${metrics.reversals} reversals`);
  return flags;
}

/* ----------------------------------------------------------------- runner */
export function auditRoute(worker, route, rulesBase) {
  const rules = { ...rulesBase, ...(route.rules || {}) };
  const weights = DEFAULT_WEIGHTS;
  const reply = worker.post({
    type: 'route-options', id: `audit-${route.id}`, points: [route.from, route.to],
    rules, weights, directProbeWeights: directLensWeights(weights),
  });
  if (!reply || reply.type !== 'route-options' || !reply.ok || !reply.options?.length) {
    return { id: route.id, name: route.name, ok: false,
      reason: reply?.reason || reply?.type || 'no options', rules };
  }
  const options = reply.options.map((option, index) => {
    const metrics = routeMetrics(option.coords, route.from, route.to);
    return {
      letter: option.optimization?.label || `#${index}`,
      profileId: option.optimization?.profileId || null,
      recommended: !!option.optimization?.recommended,
      dismountM: Math.round(option.dismountM || 0),
      ferryM: Math.round(option.ferryM || 0),
      metrics,
      flags: suspicion(metrics),
      coords: option.coords,
      segNames: [...new Set((option.segs || []).map((s) => s.name).filter(Boolean))],
    };
  });
  return { id: route.id, name: route.name, note: route.note || '', ok: true,
    from: route.from, to: route.to, rules, options };
}

/* -------------------------------------------------------------------- cli */
if (process.argv[1] && process.argv[1].endsWith('audit_route.mjs')) {
  const specPath = process.argv[2];
  const outDir = process.argv[3] || 'audit-out';
  if (!specPath) {
    console.error('usage: node scripts/audit_route.mjs <spec.json> [outDir]');
    process.exit(2);
  }
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const state = spec.state || undefined;
  const worker = routerWorker(state ? { state, fresh: true } : { fresh: true });
  if (!worker.ready) {
    console.error(`graph did not load for state=${state || '(default)'}`);
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  const rulesBase = { ...defaultRules(), ...(spec.rules || {}) };
  const summary = [];
  for (const route of spec.routes) {
    const started = Date.now();
    let result;
    try {
      result = auditRoute(worker, route, rulesBase);
    } catch (error) {
      result = { id: route.id, name: route.name, ok: false, reason: `threw: ${error.message}` };
    }
    result.state = worker.state;
    result.elapsedMs = Date.now() - started;
    writeFileSync(join(outDir, `${route.id}.json`), JSON.stringify(result));
    if (!result.ok) {
      console.log(`${route.id}  ${route.name}  NO ROUTE (${result.reason})`);
      summary.push({ id: route.id, ok: false, reason: result.reason });
      continue;
    }
    for (const option of result.options) {
      const m = option.metrics;
      console.log(`${route.id}  ${option.letter}${option.recommended ? '*' : ' '} `
        + `${(m.lengthM / 1609).toFixed(1)}mi x${m.detourFactor} `
        + `back ${m.backtrackM}m self ${m.selfTouchM ?? '-'}m rev ${m.reversals} `
        + `${option.profileId || ''} ${option.flags.length ? '<< ' + option.flags.join(', ') : ''}`);
    }
    summary.push({ id: route.id, ok: true,
      flagged: result.options.filter((o) => o.flags.length).map((o) => o.letter) });
  }
  writeFileSync(join(outDir, '_summary.json'), JSON.stringify(summary, null, 1));
  const flaggedCount = summary.filter((s) => s.ok && s.flagged.length).length;
  console.log(`\n${spec.routes.length} routes, ${flaggedCount} with flagged options -> ${outDir}`);
}
