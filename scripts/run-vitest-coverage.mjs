#!/usr/bin/env node
/**
 * Run vitest with the coverage/.tmp write guard preloaded.
 *
 * Usage (from repo root or package cwd):
 *   node path/to/run-vitest-coverage.mjs [vitest args...]
 *
 * Example:
 *   node scripts/run-vitest-coverage.mjs run --coverage
 *   node ../../scripts/run-vitest-coverage.mjs run --coverage --config vitest.config.ts
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guardImport = pathToFileURL(path.join(repoRoot, 'scripts', 'coverage-tmp-guard.mjs')).href;

const prior = process.env.NODE_OPTIONS?.trim() ?? '';
// Avoid double-import if nested through coverage-lock / pnpm scripts.
const importFlag = `--import ${guardImport}`;
const nodeOptions = prior.includes('coverage-tmp-guard')
  ? prior
  : [prior, importFlag].filter(Boolean).join(' ');

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

const result = spawnSync(process.execPath, [vitestEntry, ...vitestArgs], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
