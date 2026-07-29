#!/usr/bin/env node
// A graph cached before the county bake must be detected and replaced. A
// version string in the URL cannot do it alone: the load that first runs a new
// app.js is still controlled by the previous service worker, which serves
// /data/ ignoring the query string. So the worker reports how many edges carry
// a county route, and a count of zero while county data is loaded means the
// graph is stale. ON HOLD (see CLAUDE.md).
import fs from 'node:fs'; import vm from 'node:vm'; import zlib from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..') + '/';
const g = zlib.gunzipSync(fs.readFileSync(ROOT+'data/graph2.bin.gz'));
const msgs=[];
const ctx=vm.createContext({console,Date,Math,Map,Set,TextDecoder,ArrayBuffer,DataView,
 Float32Array,Float64Array,Int8Array,Int16Array,Int32Array,Uint8Array,Uint16Array,Uint32Array,
 postMessage:(m)=>msgs.push(m)});
ctx.importScripts=(...n)=>{for(const f of n) vm.runInContext(fs.readFileSync(ROOT+f,'utf8'),ctx);};
vm.runInContext(fs.readFileSync(ROOT+'router-worker.js','utf8'),ctx);
ctx.onmessage({data:{type:'graph',buffer:g.buffer.slice(g.byteOffset,g.byteOffset+g.byteLength)}});
const ready=msgs.filter(m=>m.type==='ready').pop();
let pass=0,fail=0; const ck=(n,ok,x='')=>{(ok?pass++:fail++);console.log(`${ok?'PASS':'FAIL'}  ${n}${x?'  -- '+x:''}`);};
console.log('ready:', JSON.stringify(ready));
ck('the worker reports county edges', typeof ready.countyEdges === 'number');
ck('the shipped graph has them', ready.countyEdges > 1000, String(ready.countyEdges));
const app = fs.readFileSync(ROOT+'app.js','utf8');
ck('a county-free graph triggers one reload', /m\.countyEdges === 0[\s\S]{0,400}location\.reload\(\)/.test(app));
ck('the reload is session-guarded', /sessionStorage\.getItem\('jra\.graphReloaded'\)/.test(app));
ck('the version is recorded only on a good graph', /if \(m\.countyEdges > 0\) markGraphDataLoaded\(\);/.test(app));
ck('and not at fetch time any more', !/purgeStaleGraphCache[\s\S]{0,400}localStorage\.setItem\(GRAPH_VERSION_KEY/.test(app));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
