#!/usr/bin/env node
// County bike routes are baked into the road tiles, so the map can colour them.
// This is what a runtime overlay could never do. ON HOLD (see CLAUDE.md).
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
await pg.evaluate(()=>map.jumpTo({center:[-122.3835,47.9690],zoom:14}));
await pg.waitForFunction(()=>window.routing&&routing.ready,{timeout:90000}).catch(()=>{});
await pg.waitForTimeout(9000);
let pass=0,fail=0;
const ck=(n,ok,x='')=>{(ok?pass++:fail++);console.log(`${ok?'PASS':'FAIL'}  ${n}${x?'  -- '+x:''}`);};
const r=await pg.evaluate(async()=>{
  const cgFeatures = map.querySourceFeatures('basemap-roads',{sourceLayer:'roads'})
    .filter(f=>f.properties.cg===1);
  const colourOf=()=>{
    // Re-evaluate the map expression the way the renderer does, for a county road.
    const f = cgFeatures.find(x=>x.properties.n==='Deer Lake Road') || cgFeatures[0];
    return f ? SafetyModel.evaluate(factsOf({...f.properties,
      maxspeed_num:f.properties.s, shoulder_width:f.properties.w,
      lanes:f.properties.ln, desig:f.properties.g, cg:f.properties.cg}), rules).level : null;
  };
  rules.vettedCountyRoutes = false;
  const off = { level: colourOf(), expr: JSON.stringify(roadLevelExpr()).includes("\"cg\"") };
  rules.vettedCountyRoutes = true;
  const on = { level: colourOf(), expr: JSON.stringify(roadLevelExpr()).includes("\"cg\"") };
  rules.vettedCountyRoutes = false;
  return { cg: cgFeatures.length, off, on,
    names:[...new Set(cgFeatures.map(f=>f.properties.n).filter(Boolean))].slice(0,5) };
});
console.log(JSON.stringify(r,null,1));
ck('road tiles carry cg', r.cg>0, `${r.cg} features`);
ck('county roads are named as expected', r.names.some(n=>/Deer Lake|Bob Galbreath|Maxwelton/.test(n)), r.names.join(', '));
ck('map expression ignores cg when trust is off', r.off.expr===false);
ck('map expression uses cg when trust is on', r.on.expr===true);
ck('no console errors', errs.length===0, errs.slice(0,2).join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); s.close();
process.exit(fail?1:0);
