#!/usr/bin/env node
// Ticking "Assume county bike routes safe" must repaint the map, not just
// change routing -- and the FAILURE overlays (roads__fail, __vh, __slash) must
// repaint with it, or a road keeps its red marking while its verdict says it
// passes. Driven through the real checkbox, not by poking `rules`.
// ON HOLD (see CLAUDE.md).
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
const errs=[]; pg.on('pageerror',e=>errs.push(e.message));
await pg.goto(`http://localhost:${port}/index.html`,{waitUntil:'load'});
await pg.evaluate(()=>map.jumpTo({center:[-122.3835,47.9690],zoom:14}));
await pg.waitForFunction(()=>window.routing&&routing.ready,{timeout:90000}).catch(()=>{});
await pg.waitForFunction(()=>map.querySourceFeatures('basemap-roads',{sourceLayer:'roads'})
  .some(f=>f.properties.cg===1),{timeout:60000}).catch(()=>{});
await pg.waitForTimeout(3000);
let pass=0,fail=0;
const ck=(n,ok,x='')=>{(ok?pass++:fail++);console.log(`${ok?'PASS':'FAIL'}  ${n}${x?'  -- '+x:''}`);};

// Which layers actually paint the road verdict?
const layers = await pg.evaluate(()=>map.getStyle().layers
  .filter(l=>l.source==='basemap-roads' && l.type==='line').map(l=>l.id));
console.log('road line layers:', layers.join(', '));

const snap = async (on) => pg.evaluate(async (t)=>{
  const el=document.getElementById('r-vettedCountyRoutes');
  if (!el) return { checkbox:null, live:rules.vettedCountyRoutes, paint:{} };
  if (el.checked !== t) { el.checked = t; el.dispatchEvent(new Event('change', {bubbles:true})); }
  await new Promise(r=>setTimeout(r,1600));
  const out={};
  for (const l of map.getStyle().layers.filter(x=>x.source==='basemap-roads' && x.type==='line')) {
    try { out[l.id]=JSON.stringify([map.getPaintProperty(l.id,'line-color'), map.getFilter(l.id)]); } catch {}
  }
  return { checkbox: el ? el.checked : null, live: rules.vettedCountyRoutes, paint: out };
}, on);

const off = await snap(false);
const on  = await snap(true);
console.log('toggle reached rules:', off.live, '->', on.live, '| checkbox:', off.checkbox, '->', on.checkbox);
ck('the setting has a checkbox', on.checkbox !== null);
ck('toggling reaches the rules object', off.live===false && on.live===true);
const changed = Object.keys(on.paint).filter(k => on.paint[k] !== off.paint[k]);
console.log('layers whose colour expression changed:', changed.length ? changed.join(', ') : 'NONE');
ck('at least one road layer repaints when county trust changes', changed.length>0);
const failLayers=['roads__fail','roads__vh','roads__slash'];
for (const f of failLayers)
  ck(`the failure overlay ${f} also updates`, changed.includes(f),
     changed.includes(f)?'':'still drawn from the old verdict');
for (const k of changed) ck(`  ${k} references cg`, /"cg"/.test(on.paint[k]));
ck('no console errors', errs.length===0, errs.slice(0,2).join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); s.close();
process.exit(fail?1:0);
