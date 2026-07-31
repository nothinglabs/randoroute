#!/usr/bin/env node
// The suite runner. `npm test`, or `node scripts/run_tests.mjs <substring>` to
// run a subset.
//
// Every test used to be a standalone script you had to know the name of, run
// one at a time, and there were fifty-three of them. Serially that was about
// twenty minutes, which is why the whole suite ended up on hold. The cost was
// never the assertions -- it was thirteen separate processes each gunzipping
// the same 32 MB graph, and six each launching their own browser, all in a
// queue. Run them concurrently and the wall clock is roughly the slowest single
// file.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const filter = process.argv[2] || '';

const files = readdirSync(HERE)
  .filter((n) => /^test_.+\.(mjs|py)$/.test(n))
  .filter((n) => !filter || n.includes(filter))
  .sort();

if (!files.length) {
  console.error(filter ? `No test matches "${filter}"` : 'No tests found');
  process.exit(1);
}

// Browser tests are the long poles and each wants a couple of cores for
// software GL, so leave headroom rather than launching all of them at once.
const LIMIT = Math.max(2, Math.min(6, availableParallelism() - 1));

function run(name) {
  const started = Date.now();
  const python = name.endsWith('.py');
  return new Promise((finish) => {
    const child = spawn(python ? 'python3' : process.execPath, [join(HERE, name)], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => finish({ name, code: 1, out: String(e), ms: Date.now() - started }));
    child.on('close', (code) => finish({ name, code, out, ms: Date.now() - started }));
  });
}

const results = [];
let next = 0;
async function worker() {
  while (next < files.length) {
    const name = files[next++];
    const result = await run(name);
    results.push(result);
    // 77 is the autotools convention for "this cannot run here", used by tests
    // that need a build tool the container has no reason to carry. A skip must
    // be visibly different from a pass, or missing coverage reads as coverage.
    const mark = result.code === 0 ? 'PASS' : result.code === 77 ? 'SKIP' : 'FAIL';
    const why = result.code === 77
      ? `  ${(/SKIP: .*/.exec(result.out) || [''])[0].replace('SKIP: ', '')}` : '';
    console.log(`${mark}  ${name.padEnd(34)} ${(result.ms / 1000).toFixed(1)}s`
      + `  (${results.length}/${files.length})${why}`);
  }
}

const wallStart = Date.now();
console.log(`Running ${files.length} test files, ${LIMIT} at a time\n`);
await Promise.all(Array.from({ length: Math.min(LIMIT, files.length) }, worker));

const skipped = results.filter((r) => r.code === 77);
const failed = results.filter((r) => r.code !== 0 && r.code !== 77);
for (const f of failed) {
  console.log(`\n${'='.repeat(70)}\nFAILED  ${f.name}\n${'='.repeat(70)}`);
  // The tail is where an assertion message and its stack live; the head is
  // usually setup chatter.
  console.log(f.out.split('\n').slice(-40).join('\n'));
}
console.log(`\n${results.length - failed.length - skipped.length}/${results.length} passed`
  + (skipped.length ? `, ${skipped.length} skipped` : '')
  + (failed.length ? `, ${failed.length} FAILED` : '')
  + ` in ${((Date.now() - wallStart) / 1000).toFixed(1)}s wall`
  + ` (${(results.reduce((a, r) => a + r.ms, 0) / 1000).toFixed(1)}s of work)`);
process.exit(failed.length ? 1 : 0);
