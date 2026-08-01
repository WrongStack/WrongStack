#!/usr/bin/env node
/**
 * List the workspace packages `pnpm publish -r` would publish.
 *
 * WS-040: npm trusted publishing binds trust per PACKAGE, not per org or per
 * repository. Moving releases to OIDC means registering the same trusted
 * publisher on every public package — miss one and its publish fails with a
 * bare 404 that reads like a network problem. This prints the exact list, and
 * flags the `publishConfig` drift that matters for a CI publish.
 *
 *   node scripts/list-publishable-packages.mjs
 *   node scripts/list-publishable-packages.mjs --json
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const packagesDir = join(repoRoot, 'packages');

/** @type {{name: string, version: string, access: string | undefined, provenance: boolean}[]} */
const publishable = [];
/** @type {string[]} */
const skipped = [];

for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(packagesDir, entry.name, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  if (manifest.private === true) {
    skipped.push(`${manifest.name ?? entry.name} (private)`);
    continue;
  }
  publishable.push({
    name: manifest.name,
    version: manifest.version,
    access: manifest.publishConfig?.access,
    provenance: manifest.publishConfig?.provenance === true,
  });
}

publishable.sort((a, b) => a.name.localeCompare(b.name));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ publishable, skipped }, null, 2));
  process.exit(0);
}

console.log(`${publishable.length} package(s) would be published by \`pnpm publish -r\`:\n`);
for (const p of publishable) {
  const notes = [];
  // `--access public` is passed on the command line, so a missing
  // publishConfig.access is not fatal — but the inconsistency is worth seeing
  // when auditing what each package declares about itself.
  if (p.access !== 'public') notes.push('no publishConfig.access');
  // Provenance is emitted automatically by trusted publishing. Declaring it in
  // publishConfig makes a LOCAL publish attempt fail, because provenance
  // requires a CI OIDC context that a laptop does not have.
  if (p.provenance) notes.push('publishConfig.provenance=true → local publish will fail');
  console.log(`  ${p.name}@${p.version}${notes.length ? `  [${notes.join('; ')}]` : ''}`);
}

if (skipped.length > 0) {
  console.log(`\nNot published:\n${skipped.map((s) => `  ${s}`).join('\n')}`);
}

console.log(
  '\nRegister a trusted publisher for EACH package above at' +
    '\n  https://www.npmjs.com/package/<name>/access' +
    '\nwith workflow `release.yml` and environment `npm-publish`.',
);
