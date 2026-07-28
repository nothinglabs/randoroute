#!/usr/bin/env node
// Two properties of the county overlay: only routes the county has BUILT are
// shipped, and county data only re-routes a ride that actually passes through
// that county. ON HOLD with the rest of the suite (see CLAUDE.md).
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--use-gl=swiftshader']});
const pg=await (await b.newContext({serviceWorkers:'block',viewport:{width:430,height:900}})).newPage();
const errs=[]; pg.on('pageerror',e=>errs.push(e.message));
await pg.goto(`http://localhost:${port}/index.html`,{waitUntil:'load'});
await pg.waitForFunction(()=>window.countyBundles&&countyBundles.length>0,{timeout:60000}).catch(()=>{});
await pg.waitForTimeout(3000);
let pass=0,fail=0;
const ck=(n,ok,x='')=>{(ok?pass++:fail++);console.log(`${ok?'PASS':'FAIL'}  ${n}${x?'  -- '+x:''}`);};
const r=await pg.evaluate(()=>{
  const box=CountyData.bounds(countyBundles,2000);
  const set=(pts)=>{ routing.last={coords:pts}; routing.start=pts[0]; routing.end=pts[pts.length-1]; routing.vias=[]; };
  set([[-122.3830,47.6680],[-122.3035,47.6553]]);      // Ballard -> UW
  const seattle=routeTouchesCounty();
  set([[-122.3527,47.9757],[-122.4064,48.0389]]);      // Clinton -> Langley
  const whidbey=routeTouchesCounty();
  routing.last=null; routing.start=null; routing.end=null;
  const none=routeTouchesCounty();
  return {box, seattle, whidbey, none,
    statuses:[...new Set(countyBundles[0].routes.map(x=>x.status))],
    routes:countyBundles[0].routes.length,
    drawn: map.getLayer('countyroutes') ? map.queryRenderedFeatures({layers:['countyroutes']}).length : -1};
});
console.log(JSON.stringify(r,null,1));
ck('only built routes ship', r.routes===2 && r.statuses.join()==='existing');
ck('county bbox is Island County only', r.box.minLat>47.8 && r.box.maxLat<48.5 && r.box.minLon>-123 && r.box.maxLon<-122.2);
ck('a Seattle route does NOT trigger a recompute', r.seattle===false);
ck('a Whidbey route DOES trigger a recompute', r.whidbey===true);
ck('no route at all does not trigger one', r.none===false);
ck('no console errors', errs.length===0, errs.slice(0,2).join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); s.close();
process.exit(fail?1:0);
