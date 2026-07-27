#!/usr/bin/env node
// Load the production graph and worker without a browser, then print compact
// route-option outcomes. Useful after every graph rebuild.
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';

const scenarios = process.argv[2] ? JSON.parse(process.argv[2]) : [
  { name: 'Seattle neighborhood', points: [[-122.391, 47.689], [-122.350, 47.673]] },
  { name: 'SR 104 / Olympic Peninsula', points: [[-122.76876, 48.11328], [-123.11194, 48.08264]] },
];
const graph = zlib.gunzipSync(fs.readFileSync(new URL('../data/graph2.bin.gz', import.meta.url)));
const messages = [];
const context = vm.createContext({
  console, Date, Math, Map, Set, TextDecoder,
  ArrayBuffer, DataView, Float32Array, Float64Array, Int8Array, Int16Array,
  Int32Array, Uint8Array, Uint16Array, Uint32Array,
  postMessage(message) { messages.push(message); },
});
context.importScripts = (...names) => {
  // The worker loads the shared verdict model with importScripts(); mirror that
  // here so a test context is the same environment the browser gives it.
  for (const n of names) {
    vm.runInContext(fs.readFileSync(new URL(`../${n}`, import.meta.url), 'utf8'), context);
  }
};
vm.runInContext(fs.readFileSync(new URL('../router-worker.js', import.meta.url), 'utf8'), context);
const buffer = graph.byteOffset === 0 && graph.byteLength === graph.buffer.byteLength
  ? graph.buffer : graph.buffer.slice(graph.byteOffset, graph.byteOffset + graph.byteLength);
context.onmessage({ data: { type: 'graph', buffer } });

const rules = {
  allowFreeways: true, minShoulder: 4, unknownShoulderZero: true,
  allowMtbTrails: false, vettedBikeRoutes: true,
  freeMaxSpeed: 35, upperMaxSpeed: 45, noUpperLimit: true, requireSafe: false,
};
const sweepProfiles = [
  ['quick', 'direct', false, false], ['quick-bike', 'direct', true, false],
  ['quick-residential', 'direct', false, true], ['quick-friendly', 'direct', true, true],
  ['efficient', 'balanced', false, false], ['bike', 'balanced', true, false],
  ['residential', 'balanced', false, true], ['bike-residential', 'balanced', true, true],
  ['gentle', 'low', false, false], ['gentle-bike', 'low', true, false],
  ['gentle-residential', 'low', false, true], ['friendly', 'low', true, true],
];
function distanceM(a, b) {
  const r = 6371000, p1 = a[1] * Math.PI / 180, p2 = b[1] * Math.PI / 180;
  const dp = p2 - p1, dl = (b[0] - a[0]) * Math.PI / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}
function ferryNames(option) {
  return option.segs.filter((seg) => seg.flags & 32).map((seg) => seg.name);
}
function landSectionsM(option) {
  const sections = [0];
  for (const seg of option.segs) {
    if (seg.flags & 32) sections.push(0);
    else sections[sections.length - 1] += Number(seg.lenM) || 0;
  }
  return sections;
}
function matchesExpectation(option, expectation) {
  const miles = option.distM / 1609.344;
  if (expectation.minDistanceMi != null && miles < expectation.minDistanceMi) return false;
  if (expectation.maxDistanceMi != null && miles > expectation.maxDistanceMi) return false;
  if (expectation.minFacilityMi != null
      && option.facilityM / 1609.344 < expectation.minFacilityMi) return false;
  if (expectation.maxFailM != null && option.failM > expectation.maxFailM) return false;
  if (expectation.discoveryMaxSpeed != null
      && option.optimization.discoveryMaxSpeed !== expectation.discoveryMaxSpeed) return false;
  if (expectation.ferries
      && JSON.stringify(ferryNames(option)) !== JSON.stringify(expectation.ferries)) return false;
  const land = landSectionsM(option).map((meters) => meters / 1609.344);
  if (expectation.landMinMi?.some((minimum, index) => minimum != null && land[index] < minimum)) return false;
  if (expectation.landMaxMi?.some((maximum, index) => maximum != null && land[index] > maximum)) return false;
  return true;
}
for (let index = 0; index < scenarios.length; index++) {
  const scenario = scenarios[index];
  const scenarioRules = { ...rules, ...(scenario.rules || {}) };
  if (scenario.graphProbe) {
    context.graphProbe = scenario.graphProbe;
    const nearby = vm.runInContext(`(() => {
      const [lon, lat, radiusM] = graphProbe;
      const result = [];
      for (let node = 0; node < N; node++) {
        const distance = havM(lon, lat, nodeLon[node], nodeLat[node]);
        if (distance > radiusM) continue;
        const outgoing = [];
        for (let cursor = outStart[node]; cursor < outStart[node + 1]; cursor++) {
          const edge = outEdge[cursor];
          outgoing.push({
            target: outTarget[cursor], edge, name: edgeName(edge),
            meters: Math.round(eLen[edge]), flags: eFlags[edge], facility: eFacility[edge],
          });
        }
        result.push({
          node, distance: Math.round(distance * 10) / 10,
          lon: nodeLon[node], lat: nodeLat[node], outgoing,
        });
      }
      return result;
    })()`, context);
    console.log(`${scenario.name}: graph probe ${JSON.stringify(nearby)}`);
  }
  messages.length = 0;
  context.onmessage({ data: { type: 'route-options', id: index + 1,
    points: scenario.points, rules: scenarioRules, forceDesignated: !!scenario.forceDesignated,
    forceResidential: !!scenario.forceResidential, preferredProfileId: scenario.preferredProfileId,
    weights: scenario.weights, debug: !!scenario.debugStages } });
  const result = messages.at(-1);
  if (!result?.ok) {
    console.log(`${scenario.name}: FAIL — ${result?.reason || 'no response'}`);
    continue;
  }
  console.log(`${scenario.name}: ${result.options.length} option(s), ${result.ms} ms`);
  if (!result.options.every((option, optionIndex, options) =>
    optionIndex === 0 || options[optionIndex - 1].distM <= option.distM)) {
    console.error('  ORDER FAIL — route letters are not shortest through longest');
    process.exitCode = 1;
  }
  if (result.options.filter((option) => option.optimization?.recommended).length !== 1) {
    console.error('  RECOMMENDATION FAIL — expected exactly one recommended option');
    process.exitCode = 1;
  }
  if (result.debug) console.log('  stages:', JSON.stringify(result.debug));
  for (const option of result.options) {
    const probeText = scenario.probe
      ? `; ${Math.round(Math.min(...option.coords.map((p) => distanceM(p, scenario.probe))))} m from probe`
      : '';
    console.log(`  ${option.optimization.label} [${option.optimization.profileId}; bike=${option.optimization.prefDesignated ? 'y' : 'n'}; residential=${option.optimization.prefResidential ? 'y' : 'n'}]: ${(option.distM / 1609.344).toFixed(1)} mi; `
      + `${Math.round(option.failM)} m fail; `
      + `${Math.round(option.hazardM || 0)} m curve caution; `
      + `${Math.round(option.freewayM)} m freeway; `
      + `${Math.round(option.mtbM || 0)} m mountain-bike trail; `
      + `${(option.desigM / 1609.344).toFixed(1)} mi designated; `
      + `${(option.facilityM / 1609.344).toFixed(1)} mi bike facility; `
      + `${(option.residentialM / 1609.344).toFixed(1)} mi residential${probeText}`);
    if (scenario.printFerries) {
      const ferries = ferryNames(option);
      console.log(`    ferries: ${ferries.length ? ferries.join(' -> ') : 'none'}`);
      const landSections = landSectionsM(option);
      console.log(`    land: ${landSections.map((meters) => `${(meters / 1609.344).toFixed(1)} mi`).join(' | ')}`);
    }
    if (scenario.segmentNameSummary) {
      const matchingM = option.segs.reduce((sum, seg) =>
        (seg.name || '').includes(scenario.segmentNameSummary) ? sum + (Number(seg.lenM) || 0) : sum, 0);
      console.log(`    ${scenario.segmentNameSummary}: ${(matchingM / 1609.344).toFixed(2)} mi`);
    }
    if (scenario.inspectBounds
        && (!scenario.inspectProfileId || option.optimization.profileId === scenario.inspectProfileId)) {
      const [west, south, east, north] = scenario.inspectBounds;
      const segments = option.segs.filter((seg) => {
        const points = option.coords.slice(seg.c0, seg.c1 + 1);
        return points.some(([lon, lat]) => lon >= west && lon <= east && lat >= south && lat <= north);
      });
      if (segments.length) {
        console.log('    inspected segments:');
        for (const seg of segments) console.log(`      ${seg.name || '(unnamed)'}; ${seg.lenM} m; ${seg.mph} mph; shoulder=${seg.sh}; facility=${seg.facility}; flags=${seg.flags}; official=${seg.official}; level=${seg.level}`);
      }
    }
    if (scenario.printLegs) {
      console.log(`    legs: ${option.legs.map((leg, legIndex) =>
        `${legIndex + 1}=${(leg.distM / 1609.344).toFixed(1)} mi/${Math.round(leg.failM)} m fail/${(leg.desigM / 1609.344).toFixed(1)} mi designated/${(leg.facilityM / 1609.344).toFixed(1)} mi facility`).join(' | ')}`);
    }
    if (scenario.printTransitions
        && (!scenario.inspectProfileId || option.optimization.profileId === scenario.inspectProfileId)) {
      console.log('    transitions:');
      let run = null;
      const flush = () => {
        if (!run) return;
        console.log(`      ${run.name}; ${Math.round(run.meters)} m; ${JSON.stringify(run.start)} -> ${JSON.stringify(run.end)}; flags=${run.flags}; facility=${run.facility}`);
      };
      for (const seg of option.segs) {
        const name = seg.name || '(unnamed)';
        const start = option.coords[seg.c0], end = option.coords[seg.c1];
        if (run && run.name === name && run.flags === seg.flags && run.facility === seg.facility) {
          run.meters += Number(seg.lenM) || 0;
          run.end = end;
        } else {
          flush();
          run = { name, meters: Number(seg.lenM) || 0, start, end, flags: seg.flags, facility: seg.facility };
        }
      }
      flush();
    }
  }
  if (scenario.profileSweep) {
    console.log('  all base profiles:');
    for (const [id, mode, prefDesignated, prefResidential] of sweepProfiles) {
      messages.length = 0;
      context.onmessage({ data: { type: 'route', id: 1000 + index,
        points: scenario.points, rules: scenarioRules, mode, profileId: id,
        prefDesignated, prefResidential, weights: scenario.weights } });
      const option = messages.at(-1);
      if (!option?.ok) continue;
      console.log(`    ${id}: ${(option.distM / 1609.344).toFixed(1)} mi; `
        + `${option.failM.toFixed(2)} m fail; ${option.limitedAccessM.toFixed(2)} m limited; `
        + `${(option.mtbM || 0).toFixed(2)} m mountain-bike trail; `
        + `${(option.desigM / 1609.344).toFixed(1)} mi designated; `
        + `${(option.facilityM / 1609.344).toFixed(1)} mi facility; `
        + `${(option.residentialM / 1609.344).toFixed(1)} mi residential`);
      if (scenario.printLegs) {
        console.log(`      legs: ${option.legs.map((leg, legIndex) =>
          `${legIndex + 1}=${(leg.distM / 1609.344).toFixed(1)} mi/${Math.round(leg.failM)} m fail/${(leg.desigM / 1609.344).toFixed(1)} mi designated/${(leg.facilityM / 1609.344).toFixed(1)} mi facility`).join(' | ')}`);
      }
    }
  }
  if (scenario.expectAny) {
    const match = result.options.find((option) => matchesExpectation(option, scenario.expectAny));
    if (match) console.log(`  EXPECTATION PASS — ${match.optimization.label}`);
    else {
      console.error(`  EXPECTATION FAIL — ${JSON.stringify(scenario.expectAny)}`);
      process.exitCode = 1;
    }
  }
  if (scenario.expectFullyMatching) {
    const match = result.options.find((option) => option.failM <= 0.5
      && option.optimization.fullyMatchingRules);
    if (match) console.log(`  FULLY MATCHING PASS — ${match.optimization.label}`);
    else {
      console.error('  FULLY MATCHING FAIL — no all-matching option was surfaced');
      process.exitCode = 1;
    }
  }
}
