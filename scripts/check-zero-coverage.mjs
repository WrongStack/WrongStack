#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SUMMARY_PATH = path.join(
  repoRoot,
  'coverage',
  'root',
  'coverage-summary.json',
);
export const DEFAULT_BASELINE_PATH = path.join(
  repoRoot,
  'architecture',
  'coverage-zero-baseline.json',
);

export function normalizeCoveragePath(file, root = repoRoot) {
  // Coverage summaries can carry Windows drive-letter paths (generated on a
  // Windows host). POSIX `path.isAbsolute` does not recognise "D:\..." as
  // absolute, so on a Linux host the raw string leaked past the relativize
  // branch and broke ratchet comparisons ("D:/repo/packages/..." vs the
  // expected relative "packages/..."). Route drive-letter paths through
  // path.win32 so normalization is host-independent.
  const fileIsWin = path.win32.isAbsolute(file);
  if (fileIsWin) {
    if (!path.win32.isAbsolute(root)) {
      // Cross-host artifact: a Windows-generated summary cannot be
      // relativized against a POSIX repo root (different trees). Fail
      // loudly instead of silently leaking a raw drive-letter path into
      // the ratchet comparison (it would never match a baseline key).
      throw new Error(
        `coverage summary carries a Windows path (${file}) but the repo root is not Windows-style (${root}); regenerate the summary on this host`,
      );
    }
    const rel = path.win32.relative(root, file);
    return rel.replaceAll('\\', '/').replace(/^\.\//, '');
  }
  const relative = path.isAbsolute(file) ? path.relative(root, file) : file;
  return relative.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function zeroStatementFiles(summary, root = repoRoot) {
  return Object.entries(summary)
    .filter(([file, metrics]) => {
      if (file === 'total' || !metrics || typeof metrics !== 'object') return false;
      const statements = metrics.statements;
      return statements?.total > 0 && statements.covered === 0;
    })
    .map(([file]) => normalizeCoveragePath(file, root))
    .sort();
}

export function compareZeroCoverage(summary, baseline, root = repoRoot) {
  const actual = zeroStatementFiles(summary, root);
  const allowed = new Set(baseline.files ?? []);
  const actualSet = new Set(actual);
  return {
    actual,
    unexpected: actual.filter((file) => !allowed.has(file)),
    resolved: [...allowed].filter((file) => !actualSet.has(file)).sort(),
  };
}

export function checkZeroCoverage(options = {}) {
  const summaryPath = options.summaryPath ?? DEFAULT_SUMMARY_PATH;
  const baselinePath = options.baselinePath ?? DEFAULT_BASELINE_PATH;
  const root = options.repoRoot ?? repoRoot;
  const readJson = options.readJson ?? ((file) => JSON.parse(readFileSync(file, 'utf8')));
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const summary = readJson(summaryPath);
  const baseline = readJson(baselinePath);
  if (baseline.schemaVersion !== 1 || !Array.isArray(baseline.files)) {
    throw new Error('coverage zero baseline must use schemaVersion 1 with a files array');
  }

  const result = compareZeroCoverage(summary, baseline, root);
  if (result.unexpected.length > 0) {
    error('New zero-statement coverage files:');
    for (const file of result.unexpected) error(`  - ${file}`);
    return 1;
  }

  log(`Zero-coverage ratchet passed (${result.actual.length} known file(s)).`);
  if (result.resolved.length > 0) {
    log(`Remove ${result.resolved.length} resolved file(s) from the zero-coverage baseline.`);
  }
  return 0;
}

export function isDirectRun(metaUrl = import.meta.url, argvEntry = process.argv[1]) {
  return typeof argvEntry === 'string' && path.resolve(argvEntry) === fileURLToPath(metaUrl);
}

export function runDirect(options = {}) {
  const check = options.check ?? checkZeroCoverage;
  const errorLog = options.error ?? console.error;
  try {
    return check();
  } catch (error) {
    errorLog(
      `coverage zero ratchet failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

if (isDirectRun()) {
  process.exitCode = runDirect();
}
