#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = process.env.JRA_PREVIEW_OUTPUT
  ? resolve(process.env.JRA_PREVIEW_OUTPUT) : join(ROOT, 'web-preview');
const baseUrl = process.env.JRA_PREVIEW_BASE_URL
  || 'https://nothinglabs.github.io/randoroute-preview/';
if (!/^https:\/\/[^?#]+\/$/.test(baseUrl)) {
  throw new Error('JRA_PREVIEW_BASE_URL must be an HTTPS directory URL ending in /');
}

execFileSync(process.execPath, [join(ROOT, 'scripts/build_mobile_shell.mjs')], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env,
    JRA_SLIM_SHELL: '1',
    JRA_SHELL_RUNTIME: 'web',
    JRA_SHELL_OUTPUT: output,
    JRA_MAP_STORE_URL: `${baseUrl}maps/`,
  },
});

for (const file of ['sw.js', 'version.json']) {
  await copyFile(join(ROOT, file), join(output, file));
}

// The shell declares these states unbundled, while the same static origin
// serves their store artifacts. The rider still confirms each acquisition and
// MapStore writes verified logical URLs into Cache Storage; physical proximity
// on the server does not turn a state into an installed map.
const store = JSON.parse(await readFile(join(ROOT, 'maps/index.json'), 'utf8'));
const storeFiles = new Set();
for (const state of store.states) {
  for (const file of state.files || []) storeFiles.add(`${state.id}/${file.path}`);
  for (const acquisition of state.acquisitions || []) {
    if (acquisition.catalogue?.path) storeFiles.add(acquisition.catalogue.path);
    if (acquisition.kind === 'routing-partitions') {
      for (const file of acquisition.files || []) storeFiles.add(file.path);
    }
  }
}
for (const relativePath of storeFiles) {
  const destination = join(output, 'maps', relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(ROOT, 'maps', relativePath), destination);
}

await mkdir(join(output, '.github/workflows'), { recursive: true });
await copyFile(join(ROOT, '.github/workflows/pages.yml'),
  join(output, '.github/workflows/pages.yml'));
await writeFile(join(output, '.nojekyll'), '');

const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
}).trim();
const sourceBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
  cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
}).trim();
const version = JSON.parse(await readFile(join(ROOT, 'version.json'), 'utf8')).version;
const catalogue = JSON.parse(await readFile(join(ROOT, 'maps/partition-catalogue.json'), 'utf8'));
const catalogueIdentity = store.states.flatMap((state) => state.acquisitions || [])
  .find((unit) => unit.kind === 'routing-partitions')?.compatibility?.catalogueSha256;
const record = {
  previewFormat: 1,
  sourceRepository: 'nothinglabs/randoroute',
  sourceBranch,
  sourceCommit,
  appVersion: version,
  partitionCatalogue: {
    format: catalogue.partitionCatalogueFormat,
    sha256: catalogueIdentity,
    sourceGraphs: catalogue.build.sourceGraphs,
  },
  states: store.states.map((state) => ({
    id: state.id,
    status: state.status,
    readiness: state.readiness,
    acquisitionBytes: (state.acquisitions || [])
      .reduce((sum, unit) => sum + unit.totalBytes, 0),
  })),
  knownLimitations: [
    'Real released coverage is Washington and Oregon.',
    'Routes may cross at most three states; the third-state gate is synthetic.',
    'Physical-iPhone Cache Storage, memory-pressure and navigation verdicts remain pending.',
  ],
  retention: 'Retain through PR #3 review; remove or archive after the pull request closes.',
};
await writeFile(join(output, 'preview.json'), `${JSON.stringify(record, null, 2)}\n`);
await writeFile(join(output, 'README.md'), `# RandoRoute multi-state review preview

Generated from \`${record.sourceBranch}\` at \`${sourceCommit}\`.
This is a slim PWA shell backed by the Washington/Oregon map store in this
preview. It does not replace the production Pages deployment.
`);

console.log(`Prepared review preview in ${output}`);
console.log(`  ${store.states.length} states, ${storeFiles.size} store files, source ${sourceCommit}`);
