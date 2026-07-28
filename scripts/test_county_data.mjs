#!/usr/bin/env node
// County overlays end to end: the bundle loads, reaches the router, draws its
// own toggleable layer, and puts the county's route and traffic count on a road
// card without turning it into an essay. Deer Lake Road on Whidbey is the
// fixture -- it carries Island County's signed South Whidbey Bike Route and
// about 2,000 vehicles a day, none of which WSDOT's state layers know about.
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
const county=[]; pg.on('console',m=>{ if(/[Cc]ounty/.test(m.text())) county.push(m.text()); });
await pg.goto(`http://localhost:${port}/index.html`,{waitUntil:'load'});
// Deer Lake Road, Whidbey.
await pg.evaluate(()=>map.jumpTo({center:[-122.3835,47.9690],zoom:15}));
await pg.waitForFunction(()=>window.routing&&routing.ready,{timeout:60000}).catch(()=>{});
await pg.waitForFunction(()=>window.countyBundles&&countyBundles.length>0,{timeout:60000}).catch(()=>{});
await pg.waitForTimeout(6000);
let pass=0,fail=0;
const ck=(n,ok,x='')=>{(ok?pass++:fail++);console.log(`${ok?'PASS':'FAIL'}  ${n}${x?'  -- '+x:''}`);};

const loaded = await pg.evaluate(()=>({
  bundles: countyBundles.length,
  county: countyBundles[0]?.county,
  routes: countyBundles[0]?.routes?.length,
  traffic: countyBundles[0]?.traffic?.length,
  lookup: !!countyLookup,
  sent: countySentToRouter,
  src: !!map.getSource('countyroutes'),
  layer: !!map.getLayer('countyroutes'),
  drawn: map.getLayer('countyroutes') ? map.queryRenderedFeatures({layers:['countyroutes']}).length : -1,
}));
console.log('loaded:', JSON.stringify(loaded));
ck('county bundle loads', loaded.bundles===1 && loaded.county==='Island');
ck('routes + traffic present', loaded.routes===14 && loaded.traffic>4000);
ck('tap lookup index built', loaded.lookup);
ck('bundles handed to the router', loaded.sent);
ck('map layer exists and draws on Deer Lake Rd', loaded.layer && loaded.drawn>0, `drawn=${loaded.drawn}`);

// The county lookup must answer for Deer Lake Road with the route and the count.
const info = await pg.evaluate(()=>CountyData.lookup(countyLookup,-122.3835,47.9690));
console.log('lookup at Deer Lake Rd:', JSON.stringify(info));
ck('lookup finds the signed route', !!info && /Whidbey/.test(info.route||''));
ck('lookup finds the traffic count', !!info && info.adt>1000 && !!info.adtYear);
ck('lookup finds the county speed limit', !!info && info.countySpeed===50);

// Tap the road: the card must show the county rows.
const card = await pg.evaluate(()=>{
  const layers=HIT_LAYERS.filter(id=>map.getLayer(id)&&map.getLayoutProperty(id,'visibility')!=='none');
  const p=map.project([-122.3835,47.9690]);
  const f=featureAt(p);
  if(!f) return {err:'no feature at Deer Lake Rd'};
  renderReadout(f, map.unproject([p.x,p.y]), p);
  return {name:f.properties?.n, html:document.getElementById('readout').innerText};
});
if(card.err) { console.log(card.err); }
else {
  console.log('--- card ---\n'+card.html);
  ck('card names the county bike route', /South Whidbey Bike Route/.test(card.html));
  ck('card shows traffic count + rating + year', /2,357\/day/.test(card.html) && /3 of 5/.test(card.html) && /2016/.test(card.html));
  ck('card shows the county speed limit', /Speed limit \(county\)\s*50 mph/.test(card.html));
  const dataRows = card.html.split('\n').filter(l=>l.includes('\t'));
  ck('card stays short', dataRows.length <= 4, dataRows.length+' data rows');
}

// The toggle must exist and actually hide the layer.
const toggled = await pg.evaluate(()=>{
  const el=document.getElementById('chk-layer-countyRoutes');
  if(!el) return {err:'no toggle'};
  el.click();
  const off=map.getLayoutProperty('countyroutes','visibility');
  el.click();
  return {off, on:map.getLayoutProperty('countyroutes','visibility')};
});
console.log('toggle:', JSON.stringify(toggled));
ck('layer toggle exists and controls visibility', toggled.off==='none' && toggled.on==='visible');
ck('no console errors', errs.length===0, errs.slice(0,3).join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); s.close();
process.exit(fail?1:0);
