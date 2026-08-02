#!/usr/bin/env node
// The generated native shell must contain every local script and stylesheet its
// HTML entry points load. A missing palette.js left the native app alive but
// stopped app.js at startup, producing controls over a blank map; the regular
// web tests could not see it because the file exists in the repository.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SHELL = join(ROOT, 'mobile-shell');

execFileSync(process.execPath, [join(HERE, 'build_mobile_shell.mjs')], {
  cwd: ROOT,
  stdio: 'pipe',
});

let checked = 0;
for (const entry of ['index.html', 'route-details.html']) {
  const html = await readFile(join(SHELL, entry), 'utf8');
  const refs = [
    ...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi),
    ...html.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["']/gi),
  ].map((match) => match[1])
    .filter((ref) => !/^(?:[a-z]+:|\/\/|#)/i.test(ref));

  assert.ok(refs.length, `${entry} should load local resources`);
  for (const ref of refs) {
    const path = ref.split(/[?#]/, 1)[0];
    await assert.doesNotReject(
      access(join(SHELL, path)),
      `${entry} loads ${ref}, but the native-shell build did not copy it`,
    );
    checked++;
  }
}

console.log(`Native shell verified: ${checked} local HTML resources are packaged`);
