#!/usr/bin/env node
// Desktop-only map controls: the road card must open on a click and never on a
// hover, and MapLibre's +/- buttons must sit clear of the app's own right-hand
// buttons instead of underneath them.
// Playwright is installed globally in this container, not under the project, so
// resolving it is the harness's job rather than each test file's.
import { playwright, chromiumPath } from './testlib/harness.mjs';
const { chromium } = await playwright();
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const T={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.gz':'application/gzip','.png':'image/png','.pmtiles':'application/octet-stream','.bin':'application/octet-stream','.pbf':'application/octet-stream'};
const s=createServer(async(q,r)=>{try{
  let p=decodeURIComponent(q.url.split('?')[0]); if(p==='/')p='/index.html';
  const full=join(ROOT,p); const st=await stat(full); const ct=T[extname(p)]||'application/octet-stream';
  const range=q.headers.range;
  if(range){const m=/^bytes=(\d+)-(\d*)$/.exec(range);
    if(m){const a=+m[1],b=m[2]?+m[2]:st.size-1; const buf=(await readFile(full)).subarray(a,b+1);
      r.writeHead(206,{'content-type':ct,'accept-ranges':'bytes','content-range':`bytes ${a}-${b}/${st.size}`,'content-length':buf.length});
      return r.end(buf);}}
  const d=await readFile(full); r.writeHead(200,{'content-type':ct,'accept-ranges':'bytes'}); r.end(d);
}catch{r.writeHead(404);r.end('x');}});
await new Promise(r=>s.listen(0,r)); const port=s.address().port;
const b=await chromium.launch({executablePath: chromiumPath(),args:['--use-gl=swiftshader']});
// A desktop viewport with a real mouse, so the hover media query matches.
const pg=await (await b.newContext({serviceWorkers:'block',viewport:{width:1200,height:820},
  hasTouch:false, isMobile:false})).newPage();
const errs=[]; pg.on('pageerror',e=>errs.push(e.message));
await pg.goto(`http://localhost:${port}/index.html`,{waitUntil:'load'});
await pg.waitForFunction(()=>window.map&&map.loaded&&map.loaded(),{timeout:30000}).catch(()=>{});
await pg.evaluate(()=>map.jumpTo({center:[-122.3117,47.7200],zoom:16}));
let pass=0,fail=0;
const check=(n,ok,x='')=>{(ok?pass++:fail++);console.log(`${ok?'PASS':'FAIL'}  ${n}${x?'  -- '+x:''}`);};

// 1. Hover must not open the card; a click must.
// Poll for a tappable road rather than sleeping a fixed 4 s and hoping. Tile
// rendering is not on a clock: this runs alongside five other test files under
// software GL, and a flat wait failed here when the machine was loaded. A flaky
// test is worse than a slow one -- it teaches you to ignore a red run.
const findRoad = ()=>pg.evaluate(()=>{
  const layers=HIT_LAYERS.filter(id=>map.getLayer(id)&&map.getLayoutProperty(id,'visibility')!=='none');
  const canvas=map.getCanvas();
  for(const f of map.queryRenderedFeatures({layers})){
    if(!f.properties?.n) continue;
    const line=f.geometry.type==='LineString'?f.geometry.coordinates:f.geometry.coordinates[0];
    for(const c of line){
      const p=map.project(c);
      const x=Math.round(p.x), y=Math.round(p.y);
      // Must be inside the viewport AND not under one of the app's own panels,
      // or the synthetic mouse never reaches the map canvas at all.
      if(x<60||y<60||x>window.innerWidth-60||y>window.innerHeight-60) continue;
      const hit=document.elementFromPoint(x,y);
      if(hit!==canvas && !map.getCanvasContainer().contains(hit)) continue;
      if(!featureAt({x,y})) continue;
      return {x,y,name:f.properties.n};
    }
  }
  return null;
});
let road=null;
for(let attempt=0; attempt<40 && !road; attempt++){
  road=await findRoad();
  if(!road) await pg.waitForTimeout(500);
}
if(!road){
  console.log('FAIL  no tappable road rendered after 20 s -- tiles never arrived');
  process.exit(1);
}
console.log('target road:', road.name);
await pg.mouse.move(road.x, road.y); await pg.waitForTimeout(600);
const afterHover = await pg.evaluate(()=>({
  shown: document.getElementById('readout').classList.contains('show'),
  cursor: map.getCanvas().style.cursor }));
check('hovering a road does not open the card', afterHover.shown===false, JSON.stringify(afterHover));
check('hovering still marks the road with a pointer cursor', afterHover.cursor==='pointer');
await pg.mouse.click(road.x, road.y); await pg.waitForTimeout(700);
check('clicking opens it', await pg.evaluate(()=>document.getElementById('readout').classList.contains('show')));

// 2. The zoom buttons must not be covered by the app's own right-hand buttons.
const boxes = await pg.evaluate(()=>{
  const r=(sel)=>{const e=document.querySelector(sel); if(!e) return null;
    const b=e.getBoundingClientRect(); return {top:Math.round(b.top),bottom:Math.round(b.bottom),
      left:Math.round(b.left),right:Math.round(b.right)};};
  return { zoomIn:r('.maplibregl-ctrl-zoom-in'), layers:r('#layersToggle'), help:r('#appHelpBtn'),
           geolocate:r('.maplibregl-ctrl-geolocate') };
});
console.log('boxes:', JSON.stringify(boxes));
const overlaps=(a,c)=>a&&c&&!(a.bottom<=c.top||c.bottom<=a.top||a.right<=c.left||c.right<=a.left);
check('zoom buttons exist on desktop', !!boxes.zoomIn);
check('zoom does not overlap the Layers button', !overlaps(boxes.zoomIn, boxes.layers));
check('zoom does not overlap the Help button', !overlaps(boxes.zoomIn, boxes.help));
check('zoom does not overlap the geolocate button', !overlaps(boxes.zoomIn, boxes.geolocate));
// And it must actually be the topmost element at its own centre.
const onTop = await pg.evaluate(()=>{
  const e=document.querySelector('.maplibregl-ctrl-zoom-in'); if(!e) return null;
  const b=e.getBoundingClientRect();
  const hit=document.elementFromPoint((b.left+b.right)/2,(b.top+b.bottom)/2);
  return hit && (hit===e || e.contains(hit));
});
check('zoom-in is clickable, not painted over', onTop===true);
check('no console errors', errs.length===0, errs.slice(0,2).join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); s.close();
process.exit(fail?1:0);
