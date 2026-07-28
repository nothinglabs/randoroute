#!/usr/bin/env node
// State/national trust and county trust are separate settings over separate
// facts, and neither may stand in for the other. ON HOLD (see CLAUDE.md).
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
await pg.waitForTimeout(5000);
let pass=0,fail=0;
const ck=(n,ok,x='')=>{(ok?pass++:fail++);console.log(`${ok?'PASS':'FAIL'}  ${n}${x?'  -- '+x:''}`);};
const r=await pg.evaluate(()=>{
  const labels=[...document.querySelectorAll('label')].map(e=>e.textContent.trim());
  const F=(d)=>({...{prohibited:false,ferry:false,freeway:false,infra:false,facility:0,
    limitedAccess:false,speed:45,shoulder:0,lanes:4,sidewalk:null,urban:false,
    designated:false,countyDesignated:false,stressRating:null}, ...d});
  const R=(d)=>({...rules, vettedBikeRoutes:false, vettedCountyRoutes:false, ...d});
  const lvl=(f,rr)=>SafetyModel.evaluate(F(f),R(rr)).level;
  return {
    dflt:{state:DEFAULT_RULES.vettedBikeRoutes, county:DEFAULT_RULES.vettedCountyRoutes},
    presets:ROUTING_PRESETS.map(p=>[p.id,p.rules.vettedBikeRoutes,p.rules.vettedCountyRoutes]),
    stateLabel: labels.some(t=>/Assume state bike routes safe/.test(t)),
    countyLabel: labels.some(t=>/Assume county bike routes safe/.test(t)),
    layerState: labels.some(t=>/State & national bike routes/.test(t)),
    layerCounty: labels.some(t=>/^County bike routes$/.test(t)),
    // Independence: neither trust may stand in for the other.
    stateOnly_stateRoad: lvl({designated:true},{vettedBikeRoutes:true}),
    stateOnly_countyRoad: lvl({countyDesignated:true},{vettedBikeRoutes:true}),
    countyOnly_countyRoad: lvl({countyDesignated:true},{vettedCountyRoutes:true}),
    countyOnly_stateRoad: lvl({designated:true},{vettedCountyRoutes:true}),
    neither: lvl({designated:true,countyDesignated:true},{}),
  };
});
console.log(JSON.stringify(r,null,1));
ck('both default off', r.dflt.state===false && r.dflt.county===false);
ck('Randonneur trusts county only', JSON.stringify(r.presets[0])==='["randonneur",false,true]', JSON.stringify(r.presets[0]));
ck('other presets trust neither', r.presets.slice(1).every(p=>p[1]===false&&p[2]===false), JSON.stringify(r.presets.slice(1)));
ck('state setting labelled', r.stateLabel);
ck('county setting labelled', r.countyLabel);
ck('layer menu renamed', r.layerState && r.layerCounty, `state=${r.layerState} county=${r.layerCounty}`);
ck('state trust rescues a state route', r.stateOnly_stateRoad<4);
ck('state trust does NOT rescue a county route', r.stateOnly_countyRoad===4);
ck('county trust rescues a county route', r.countyOnly_countyRoad<4);
ck('county trust does NOT rescue a state route', r.countyOnly_stateRoad===4);
ck('neither trust: both fail', r.neither===4);
ck('no console errors', errs.length===0, errs.slice(0,2).join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); s.close();
process.exit(fail?1:0);
