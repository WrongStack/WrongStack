#!/usr/bin/env bun
/**
 * Run vitest with the coverage/.tmp write guard preloaded.
 *
 * Usage (from repo root or package cwd):
 *   bun path/to/run-vitest-coverage.mjs [vitest args...]
 *
 * Example:
 *   bun scripts/run-vitest-coverage.mjs run --coverage
 *   bun ../../scripts/run-vitest-coverage.mjs run --coverage --config vitest.config.ts
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guardImport = path.join(repoRoot, 'scripts', 'coverage-tmp-guard.mjs');

const vitestArgs = process.argv.slice(2);
if (vitestArgs.length === 0) {
  console.error('usage: run-vitest-coverage.mjs <vitest-args...>');
  process.exit(2);
}

// Resolve vitest CLI entry. package exports hide `./vitest.mjs`, so locate
// via package.json and open the sibling CLI file directly.
function resolveVitestEntry(fromDir) {
  const requireFrom = createRequire(path.join(fromDir, 'package.json'));
  const pkgJson = requireFrom.resolve('vitest/package.json');
  return path.join(path.dirname(pkgJson), 'vitest.mjs');
}

let vitestEntry;
try {
  vitestEntry = resolveVitestEntry(process.cwd());
} catch {
  vitestEntry = resolveVitestEntry(repoRoot);
}

const result = spawnSync(process.execPath, ['--preload', guardImport, vitestEntry, ...vitestArgs], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (result.signal) {
  console.error(`Vitest coverage process terminated by ${result.signal}`);
}
process.exit(result.status ?? 1);
