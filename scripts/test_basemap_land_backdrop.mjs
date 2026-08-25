#!/usr/bin/env node
// The map must never look like the rider is at sea.
//
// `basemap-ocean` is a full-canvas background painted water-colour, and land is
// drawn on top of it. That means any area with no land polygon renders as open
// water — so a byte-range read that fails, or simply has not arrived yet while
// the rider is panning, turns solid ground into ocean. basemap-style.js already
// documents the failure ("rectangular holes along tile boundaries, land polygons
// missing, bare ocean showing through") and retries the read; retrying narrows
// the window but cannot close it.
//
// The structural guard is a coarse `land` layer with no maxzoom, sitting under
// `land_detail`. MapLibre overzooms it, so there is always a land backdrop and a
// missing detail tile degrades to slightly blocky coastline instead of to sea.
// `basemap-water` is drawn AFTER both, so real water still paints on top.
//
// This test hides `land_detail` to stand in for "the detail tiles did not
// arrive", which is the exact condition a rider hits on cell data.
//
// Measured from SCREENSHOTS, not gl.readPixels: the drawing buffer is not
// preserved, so readPixels returns an all-black frame and every number taken
// that way is meaningless. That mistake produced a confident, wrong "0% ocean"
// during the investigation that led to this file.
// Playwright is installed globally in this container, not under the project, so
// resolving it is the harness's job rather than each test file's.
import { launchBrowser, serveRepo } from './testlib/harness.mjs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const OUT = mkdtempSync(join(tmpdir(), 'landbackdrop-'));
const python = process.env.PYTHON || 'python3';

// Ocean #dcecf2, land #f4f3ee.
function analyse(file) {
  const py = `
from PIL import Image
im = Image.open(${JSON.stringify(file)}).convert('RGB')
px = im.load(); w, h = im.size
ocean = land = tot = 0
for y in range(0, h, 3):
    for x in range(0, w, 3):
        r, g, b = px[x, y]; tot += 1
        if abs(r-220) < 10 and abs(g-236) < 10 and abs(b-242) < 10: ocean += 1
        if abs(r-244) < 8 and abs(g-243) < 8 and abs(b-238) < 8: land += 1
print(ocean*100//tot, land*100//tot)
`;
  const res = spawnSync(python, ['-c', py], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error('pixel analysis failed: ' + res.stderr);
  const [ocean, land] = res.stdout.trim().split(/\s+/).map(Number);
  return { ocean, land };
}

const site = await serveRepo();
const browser = await launchBrowser();
const pg = await (await browser.newContext({ serviceWorkers: 'block', viewport: { width: 500, height: 500 } })).newPage();
await pg.goto(site.url, { waitUntil: 'load' });
await pg.waitForFunction(() => window.map && map.getLayer?.('basemap-land'), { timeout: 60000 });
// Georgetown: inland Seattle, real water present but most of the frame is land.
await pg.evaluate(() => { map.jumpTo({ center: [-122.3130, 47.5150], zoom: 13 }); });
await pg.waitForFunction(() => map.isSourceLoaded('basemap-context')
  && map.queryRenderedFeatures({ layers: ['basemap-land'] }).length > 0,
{ timeout: 60000 });
// A fixed post-toggle wait raced the renderer when the suite shares the CPU
// three ways: the screenshot caught a half-painted frame. Wait for the map's
// own idle after a forced repaint, then two animation frames for the
// compositor, with a short fixed tail.
const settled = async () => {
  await pg.evaluate(() => new Promise((resolve) => {
    map.once('idle', () => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    map.triggerRepaint();
  }));
  await pg.waitForTimeout(500);
};
await settled();

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  -- ' + x : ''}`); };

const clip = { x: 0, y: 0, width: 500, height: 380 };
await pg.screenshot({ path: join(OUT, 'present.png'), clip });
const present = analyse(join(OUT, 'present.png'));

// The coarse layer must have no maxzoom, or it cannot back anything up above 8.
const zoomRange = await pg.evaluate(() => {
  const l = map.getStyle().layers.find((x) => x.id === 'basemap-land');
  return { minzoom: l.minzoom ?? null, maxzoom: l.maxzoom ?? null };
});
check('the coarse land layer is not capped by zoom',
  zoomRange.maxzoom === null || zoomRange.maxzoom >= 13, JSON.stringify(zoomRange));
check('land is actually drawn at z13', present.land > 5,
  `land ${present.land}%, ocean ${present.ocean}%`);

// Detail tiles gone: this is the rider on flaky cell data.
await pg.evaluate(() => { map.setLayoutProperty('basemap-land-detail', 'visibility', 'none'); });
await settled();
await pg.screenshot({ path: join(OUT, 'nodetail.png'), clip });
const nodetail = analyse(join(OUT, 'nodetail.png'));
check('losing the detail tiles does not flood the map with ocean',
  nodetail.ocean <= present.ocean + 4,
  `ocean ${present.ocean}% -> ${nodetail.ocean}%`);
check('and land still covers the ground',
  nodetail.land >= present.land - 4,
  `land ${present.land}% -> ${nodetail.land}%`);

// Control: with the backdrop ALSO gone, ocean must visibly take over. If this
// does not happen the test is not measuring anything and the checks above are
// vacuous.
await pg.evaluate(() => { map.setLayoutProperty('basemap-land', 'visibility', 'none'); });
await settled();
await pg.screenshot({ path: join(OUT, 'nobackdrop.png'), clip });
const bare = analyse(join(OUT, 'nobackdrop.png'));
check('control: with no land layer at all, ocean does take over',
  bare.ocean > present.ocean + 8 && bare.land < 5,
  `ocean ${present.ocean}% -> ${bare.ocean}%, land ${bare.land}%`);

await browser.close();
await site.close();
rmSync(OUT, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
