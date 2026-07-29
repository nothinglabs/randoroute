#!/usr/bin/env node
// A rebuilt routing graph must actually reach a device. The service worker
// serves /data/ cache-first ignoring the query string, so a graph whose bytes
// changed under an unchanged name was served from cache forever -- county bike
// routes were baked in using a spare flag bit, the format string never moved,
// and riders kept routing on a graph that had never heard of them.
// ON HOLD (see CLAUDE.md).
import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(`${ROOT}/app.js`,'utf8');
const sw  = fs.readFileSync(`${ROOT}/sw.js`,'utf8');
const a = /GRAPH_DATA_VERSION = '([^']+)'/.exec(app)[1];
const s = /GRAPH_DATA_VERSION = '([^']+)'/.exec(sw)[1];
let pass=0,fail=0; const ck=(n,ok,x='')=>{(ok?pass++:fail++);console.log(`${ok?'PASS':'FAIL'}  ${n}${x?'  -- '+x:''}`);};
ck('app and sw agree on the graph version', a===s, `${a} vs ${s}`);
ck('the graph fetch carries it', /graph2\.bin\.gz\?format=\$\{GRAPH_FORMAT_VERSION\}&gv=\$\{GRAPH_DATA_VERSION\}/.test(app));
ck('the sw precache entry carries it', sw.includes('./data/graph2.bin.gz?gv=${GRAPH_DATA_VERSION}'));
ck('the graph is NOT served with ignoreSearch', /graph2\.bin\.gz'\)\) \{[\s\S]{0,400}?cacheFirst\(DATA_CACHE, e\.request, false\)/.test(sw));
ck('other /data/ assets still ignore search', /includes\('\/data\/'\)\) \{\s*\n\s*e\.respondWith\(cacheFirst\(DATA_CACHE, e\.request, true\)\)/.test(sw));
ck('stale graph copies are purged on activate', /purgeStaleGraph/.test(sw) && /\.then\(\(\) => purgeStaleGraph\(\)\)/.test(sw));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
