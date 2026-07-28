#!/usr/bin/env node
// Tapping a county-signed road must give the ROAD's card, with the county's
// route, traffic count and posted speed folded in as extra rows -- not a card
// about the designation that hides the road. Deer Lake Road on Whidbey is the
// fixture: it carries Island County's signed South Whidbey Bike Route.
//
// ON HOLD with the rest of the suite (see CLAUDE.md).
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
await pg.evaluate(()=>map.jumpTo({center:[-122.3835,47.9690],zoom:15}));
await pg.waitForFunction(()=>window.routing&&routing.ready,{timeout:60000}).catch(()=>{});
await pg.waitForTimeout(8000);
let pass=0,fail=0;
const ck=(n,ok,x='')=>{(ok?pass++:fail++);console.log(`${ok?'PASS':'FAIL'}  ${n}${x?'  -- '+x:''}`);};
const card = await pg.evaluate(()=>{
  const p=map.project([-122.3835,47.9690]);
  const f=featureAt(p);
  if(!f) return {err:'nothing hit'};
  renderReadout(f, map.unproject([p.x,p.y]), p);
  return {src:f.layer.id, html:document.getElementById('readout').innerText};
});
console.log('hit layer:', card.src);
console.log('--- card ---\n'+card.html);
ck('tap hits the road, not the ribbon', !/county/i.test(card.src||''));
for (const [label, re] of [
  ['road name', /Deer Lake Road/],
  ['verdict', /Verdict/],
  ['why', /Why/],
  ['speed limit', /Speed limit\t/],
  ['area', /Area/],
  ['road class', /Road class/],
  ['county route', /County route\tSouth Whidbey/],
  ['traffic', /Traffic\t\d[\d,]*\/day — \d of 5/],
  ['county speed', /Speed limit \(county\)\t50 mph/],
]) ck(`card shows ${label}`, re.test(card.html));
ck('no rambling paragraphs', !/[^\n]{160,}/.test(card.html));
ck('no console errors', errs.length===0, errs.slice(0,2).join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); s.close();
process.exit(fail?1:0);
