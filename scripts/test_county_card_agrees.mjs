#!/usr/bin/env node
// The tap card and the map must agree about a county road. They did not:
// factsOf() read the county flag as `n.cg`, but scoreRoad() never emitted it,
// so with county trust on the map drew the road passing while its card still
// said "Fails: shoulder unknown". ON HOLD (see CLAUDE.md).
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
const pg=await (await b.newContext({serviceWorkers:'block',viewport:{width:900,height:900}})).newPage();
await pg.goto(`http://localhost:${port}/index.html`,{waitUntil:'load'});
await pg.evaluate(()=>map.jumpTo({center:[-122.3835,47.9690],zoom:14}));
await pg.waitForFunction(()=>window.routing&&routing.ready,{timeout:90000}).catch(()=>{});
await pg.waitForFunction(()=>map.querySourceFeatures('basemap-roads',{sourceLayer:'roads'})
  .some(f=>f.properties.cg===1),{timeout:60000}).catch(()=>{});
await pg.waitForTimeout(3000);
let pass=0,fail=0;
const ck=(n,ok,x='')=>{(ok?pass++:fail++);console.log(`${ok?'PASS':'FAIL'}  ${n}${x?'  -- '+x:''}`);};
for (const trust of [false,true]){
  const r=await pg.evaluate((t)=>{
    rules.vettedCountyRoutes=t;
    const all=map.querySourceFeatures('basemap-roads',{sourceLayer:'roads'})
      .filter(x=>x.properties.cg===1);
    // A county road that fails on its own merits is the case in question.
    const was=rules.vettedCountyRoutes; rules.vettedCountyRoutes=false;
    const f=all.find(x=>effectiveLevel(scoreRoad(x.properties))===4);
    rules.vettedCountyRoutes=was;
    if(!f) return {err:`no failing county road among ${all.length} cg features`};
    const n=scoreRoad(f.properties);
    return { name:f.properties.n||'(unnamed)', cg:f.properties.cg,
             cardLevel:effectiveLevel(n),
             cardWhy:SafetyModel.evaluate(factsOf(n),rules).rule,
             countyDesignated:factsOf(n).countyDesignated };
  }, trust);
  console.log(`county trust ${trust?'ON ':'OFF'} -> ${JSON.stringify(r)}`);
  if(r.err){ ck('found the road', false, r.err); break; }
  if(trust) ck('trust ON: card passes (matches the map)', r.cardLevel<4 && r.countyDesignated===true);
  else      ck('trust OFF: card fails', r.cardLevel===4);
}
console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); s.close();
process.exit(fail?1:0);
