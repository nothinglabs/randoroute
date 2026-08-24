#!/usr/bin/env node
// Verify a DEPLOYED map store: every file the live maps/index.json declares
// must be present with exactly the declared byte count. Run after every
// preview/store deploy — a manifest from one build serving files from
// another is how a rider gets "expected 915501 bytes, received 915593"
// mid-download. Usage:
//   node scripts/verify_store_deploy.mjs https://host/path/   (trailing slash)
// Exits non-zero on any skew, listing every mismatched file.

const base = process.argv[2];
if (!base || !/^https?:\/\/.+\/$/.test(base)) {
  console.error('usage: verify_store_deploy.mjs <https://host/base/ with trailing slash>');
  process.exit(2);
}

const bust = () => `?jra-verify=${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
// Ask for an identity transfer: a gzipped response's Content-Length counts
// wire bytes, not the file's, and GitHub Pages compresses some archives on
// some responses. If the server compresses anyway or omits the header, fall
// back to downloading and counting the decoded bytes — the manifest's truth.
const head = async (url) => {
  const res = await fetch(url + bust(), { method: 'HEAD', cache: 'no-store',
    headers: { 'accept-encoding': 'identity' } });
  if (!res.ok) return { ok: false, status: res.status, bytes: -1 };
  const encoding = (res.headers.get('content-encoding') || '').toLowerCase();
  const length = Number(res.headers.get('content-length'));
  if ((!encoding || encoding === 'identity') && Number.isFinite(length)) {
    return { ok: true, status: res.status, bytes: length };
  }
  const full = await fetch(url + bust(), { cache: 'no-store' });
  if (!full.ok) return { ok: false, status: full.status, bytes: -1 };
  return { ok: true, status: full.status, bytes: (await full.arrayBuffer()).byteLength };
};

const indexUrl = new URL('maps/index.json', base).href;
const res = await fetch(indexUrl + bust(), { cache: 'no-store' });
if (!res.ok) {
  console.error(`FAIL ${indexUrl}: HTTP ${res.status}`);
  process.exit(1);
}
const index = await res.json();
const targets = [];
for (const state of index.states) {
  for (const file of state.files || []) {
    targets.push([`maps/${state.id}/${file.path}`, file.bytes]);
  }
  for (const unit of state.acquisitions || []) {
    if (unit.catalogue) targets.push([`maps/${unit.catalogue.path}`, unit.catalogue.bytes]);
    for (const file of unit.files || []) {
      const rel = unit.kind === 'routing-partitions'
        ? `maps/${file.path}` : `maps/${state.id}/${file.path}`;
      targets.push([rel, file.bytes ?? file.compressedBytes]);
    }
  }
}

let bad = 0;
for (const [rel, declared] of targets) {
  const { ok, status, bytes } = await head(new URL(rel, base).href);
  if (!ok || bytes !== declared) {
    bad++;
    console.error(`FAIL ${rel}: manifest ${declared}, live ${ok ? bytes : `HTTP ${status}`}`);
  }
}
if (bad) {
  console.error(`${bad} of ${targets.length} deployed files do not match the live manifest.`);
  process.exit(1);
}
console.log(`ok: all ${targets.length} deployed files match the live manifest at ${base}`);
