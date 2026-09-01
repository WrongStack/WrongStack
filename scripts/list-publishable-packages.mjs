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
 * The inventory itself lives in `scripts/lib/publishable-packages.mjs`, shared
 * with `scripts/publish-workspace.mjs` so the release and the trusted-publisher
 * checklist can never disagree about which packages ship.
 *
 *   node scripts/list-publishable-packages.mjs
 *   node scripts/list-publishable-packages.mjs --json
 */
import { collectPublishablePackages, layerByDependencies } from './lib/publishable-packages.mjs';

const { publishable, skipped } = collectPublishablePackages();

if (process.argv.includes('--json')) {
  const { layers, cycles } = layerByDependencies(publishable);
  console.log(
    JSON.stringify(
      { publishable, skipped, layers: layers.map((l) => l.map((p) => p.name)), cycles },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log(`${publishable.length} package(s) would be published by \`pnpm release:ci\`:\n`);
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
    '\nwith workflow `release.yml` and environment `npm-publish`.' +
    '\n\nPublish order: `node scripts/publish-workspace.mjs --plan`',
);
