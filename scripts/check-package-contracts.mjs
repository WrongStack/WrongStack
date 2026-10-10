#!/usr/bin/env bun
/**
 * Package contract smoke check.
 *
 * Verifies that every publishable workspace package's manifest export
 * targets (main, types, bin, exports) exist on disk after a build. This
 * catches manifest/build drift early — e.g. a package.json that declares
 * `dist/index.js` but the build produces `dist/index.html` only.
 *
 * Run: node scripts/check-package-contracts.mjs
 *
 * Exit 0 = all contracts satisfied, exit 1 = one or more broken.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectPublishablePackages } from './lib/publishable-packages.mjs';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');

function checkTargets(pkgDir) {
  const pkgPath = join(pkgDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const errors = [];

  const checkPath = (rel) => {
    if (!rel || typeof rel !== 'string') return;
    // Skip non-file specifiers (URLs, globs, special exports).
    if (rel.includes('://') || rel.includes('*')) return;
    const abs = join(pkgDir, rel);
    if (!existsSync(abs)) {
      errors.push(`${pkg.name}: missing "${rel}" (referenced in package.json)`);
    }
  };

  // main / types
  if (pkg.main) checkPath(pkg.main);
  if (pkg.types) checkPath(pkg.types);

  // bin
  if (pkg.bin) {
    if (typeof pkg.bin === 'string') {
      checkPath(pkg.bin);
    } else {
      for (const target of Object.values(pkg.bin)) {
        checkPath(target);
      }
    }
  }

  // exports
  if (pkg.exports) {
    for (const [key, value] of Object.entries(pkg.exports)) {
      if (key === './package.json') continue;
      if (typeof value === 'string') {
        checkPath(value);
      } else if (typeof value === 'object' && value !== null) {
        // { types, import, default, ... }
        for (const field of ['types', 'import', 'default', 'require', 'node']) {
          if (value[field]) checkPath(value[field]);
        }
      }
    }
  }

  return errors;
}

// Main
const { publishable } = collectPublishablePackages(root);
const allErrors = [];

for (const pkg of publishable) {
  const errors = checkTargets(pkg.dir);
  allErrors.push(...errors);
}

if (allErrors.length > 0) {
  console.error(`❌ ${allErrors.length} package contract violation(s) detected:`);
  for (const err of allErrors) {
    console.error(`   ${err}`);
  }
  console.error('Run `pnpm build` to produce the missing dist files.');
  process.exit(1);
} else {
  console.log(`✅ All ${publishable.length} publishable package contracts satisfied.`);
}
