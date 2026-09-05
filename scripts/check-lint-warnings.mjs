#!/usr/bin/env node

// Production lint-warning ratchet.
//
// `biome lint` exits 0 when it finds only warnings, so the plain Lint job
// never sees them. This gate aggregates Biome's JSON diagnostics into
// rule x scope x severity occurrence counts and compares them with
// architecture/lint-warning-baseline.json:
//   - a production-scope warning count ABOVE the baseline fails (new warning);
//   - a production-scope warning count BELOW the baseline also fails
//     (ratchet-down invariant: a fixed warning lowers the baseline in the
//     same change, so the file cannot rot into an ignored allowance);
//   - info-severity diagnostics and non-production scopes (test trees,
//     spec/story files, e2e, fixtures, scripts/ tooling) never gate.
// Mirrors scripts/check-test-typecheck.mjs (flags, exit codes, spawn style).

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = new Set(process.argv.slice(2));
const supported = new Set(['--json', '--print-baseline', '--report-only']);
for (const arg of args) {
  if (!supported.has(arg)) {
    console.error(`Unknown argument: ${arg}`);
    process.exit(2);
  }
}

const repoRoot = process.cwd();
const biomeEntry = path.join(repoRoot, 'node_modules', '@biomejs', 'biome', 'bin', 'biome');
const baselinePath = path.join(repoRoot, 'architecture', 'lint-warning-baseline.json');

function toPosix(value) {
  return value.replaceAll(path.sep, '/');
}

function normalizeFile(file) {
  const absolute = path.isAbsolute(file) ? file : path.resolve(repoRoot, file);
  return toPosix(path.relative(repoRoot, absolute));
}

const NON_PRODUCTION_DIR = /(?:^|\/)(?:tests?|__tests__|e2e|fixtures?|__mocks__|__snapshots__)\//;
const NON_PRODUCTION_FILE = /\.(?:test|spec|stories)\.[cm]?[jt]sx?$/;

function scopeFor(file) {
  if (
    NON_PRODUCTION_DIR.test(file) ||
    NON_PRODUCTION_FILE.test(file) ||
    file.startsWith('scripts/')
  ) {
    return 'test';
  }
  return 'production';
}

function runBiome() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [biomeEntry, 'lint', repoRoot, '--reporter=json'], {
      cwd: repoRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) =>
      resolve({ exitCode: -1, stdout, stderr: `${stderr}\n${error.message}` }),
    );
    child.on('close', (exitCode) => resolve({ exitCode: exitCode ?? -1, stdout, stderr }));
  });
}

function parseDiagnostics(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`biome --reporter=json produced unparseable output: ${error.message}`);
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.diagnostics)
      ? parsed.diagnostics
      : [];
  return list.map((diagnostic) => {
    // Biome 2's JSON reporter emits location.path as a plain string; older
    // shapes (and defensive parsing) use { file }. Handle both — guessing
    // one shape silently classifies every diagnostic as '<unknown>' and
    // collapses all scopes into production.
    const rawPath = diagnostic.location?.path;
    const file = typeof rawPath === 'string' ? rawPath : (rawPath?.file ?? '<unknown>');
    return {
      rule: String(diagnostic.category ?? 'unknown'),
      severity: String(diagnostic.severity ?? 'warning'),
      file: normalizeFile(file),
    };
  });
}

async function loadBaselineEntries() {
  let raw;
  try {
    raw = await readFile(baselinePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    throw error;
  }
  // Tolerate a truncated/empty file (e.g. an interrupted redirect created the
  // target before the generator wrote): treat it as "no baseline yet".
  if (!raw.trim()) return {};
  const document = JSON.parse(raw);
  if (
    document.schemaVersion !== 1 ||
    typeof document.entries !== 'object' ||
    document.entries === null
  ) {
    throw new Error('lint-warning baseline must use schemaVersion 1 with an entries object');
  }
  return document.entries;
}

const run = await runBiome();
let diagnostics;
try {
  diagnostics = parseDiagnostics(run.stdout);
} catch (error) {
  console.error(error.message);
  if (run.stderr.trim()) console.error(run.stderr.trim());
  process.exit(1);
}

// Error-severity diagnostics fail the plain `pnpm lint` job anyway; here they
// only block the gate and refuse baseline generation so a broken tree is
// never frozen into architecture/.
const errorDiagnostics = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');

const warningFiles = new Map(); // "rule|scope" -> Map(file -> count)
const infoCounts = new Map(); // "rule|scope|severity" -> count
for (const diagnostic of diagnostics) {
  if (diagnostic.severity === 'error') continue;
  const scope = scopeFor(diagnostic.file);
  if (diagnostic.severity === 'warning') {
    const aggregateKey = `${diagnostic.rule}|${scope}`;
    const files = warningFiles.get(aggregateKey) ?? new Map();
    files.set(diagnostic.file, (files.get(diagnostic.file) ?? 0) + 1);
    warningFiles.set(aggregateKey, files);
  } else {
    const key = `${diagnostic.rule}|${scope}|${diagnostic.severity}`;
    infoCounts.set(key, (infoCounts.get(key) ?? 0) + 1);
  }
}

// Baseline entries are the accepted spec shape: {rule, scope, severity, count}
// flattened to "rule|scope|severity" -> count keys (sorted at print time).
const entries = {};
for (const [ruleScope, files] of warningFiles) {
  entries[`${ruleScope}|warning`] = [...files.values()].reduce((total, count) => total + count, 0);
}

const baselineEntries = await loadBaselineEntries();

function diffScope(scope) {
  const current = new Map();
  const baseline = new Map();
  const suffix = `|${scope}|warning`;
  for (const [key, count] of Object.entries(entries)) {
    if (key.endsWith(suffix)) current.set(key, count);
  }
  for (const [key, count] of Object.entries(baselineEntries)) {
    if (key.endsWith(suffix)) baseline.set(key, count);
  }
  const filesFor = (ruleScope) =>
    [...(warningFiles.get(ruleScope) ?? new Map())]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([file, count]) => ({ file, count }));
  const increased = [...current]
    .filter(([key, count]) => count > (baseline.get(key) ?? 0))
    .map(([key, count]) => {
      const baselineCount = baseline.get(key) ?? 0;
      return {
        key,
        baseline: baselineCount,
        current: count,
        files: filesFor(key.slice(0, key.lastIndexOf('|warning'))),
      };
    });
  const stale = [...baseline]
    .filter(([key, count]) => count > (current.get(key) ?? 0))
    .map(([key, count]) => ({ key, baseline: count, current: current.get(key) ?? 0 }));
  return { increased, stale };
}

const production = diffScope('production');
const test = diffScope('test');

const report = {
  schemaVersion: 1,
  productionWarnings: [...warningFiles.entries()]
    .filter(([key]) => key.endsWith('|production'))
    .reduce(
      (total, [, files]) => total + [...files.values()].reduce((sum, count) => sum + count, 0),
      0,
    ),
  testWarnings: [...warningFiles.entries()]
    .filter(([key]) => key.endsWith('|test'))
    .reduce(
      (total, [, files]) => total + [...files.values()].reduce((sum, count) => sum + count, 0),
      0,
    ),
  infoDiagnostics: [...infoCounts.values()].reduce((total, count) => total + count, 0),
  errorDiagnostics: errorDiagnostics.length,
  productionIncreases: production.increased,
  productionStale: production.stale,
  testIncreases: test.increased,
  testStale: test.stale,
};

function printHuman() {
  console.log(
    `lint warnings: ${report.productionWarnings} production, ${report.testWarnings} non-production, ` +
      `${report.infoDiagnostics} info (non-gating), ${report.errorDiagnostics} errors`,
  );
  for (const warning of report.productionIncreases) {
    console.log(`NEW production warning: ${warning.key} ${warning.baseline} -> ${warning.current}`);
    for (const file of warning.files) console.log(`    ${file.file} (${file.count})`);
  }
  for (const entry of report.productionStale) {
    console.log(
      `STALE baseline entry (lower it in the same change): ${entry.key} ${entry.baseline} -> ${entry.current}`,
    );
  }
  for (const warning of report.testIncreases) {
    console.log(
      `non-production increase (non-gating): ${warning.key} ${warning.baseline} -> ${warning.current}`,
    );
    for (const file of warning.files) console.log(`    ${file.file} (${file.count})`);
  }
  for (const entry of report.testStale) {
    console.log(
      `non-production decrease (non-gating): ${entry.key} ${entry.baseline} -> ${entry.current}`,
    );
  }
  if (report.productionIncreases.length === 0 && report.productionStale.length === 0) {
    console.log('production lint-warning baseline is satisfied.');
  }
}

if (args.has('--print-baseline')) {
  if (errorDiagnostics.length > 0 || run.exitCode !== 0) {
    console.error(
      `Refusing to print a lint-warning baseline while biome reports errors (exit ${run.exitCode}).`,
    );
    if (run.stderr.trim()) console.error(run.stderr.trim());
    process.exit(1);
  }
  const sorted = {};
  for (const key of Object.keys(entries).sort()) sorted[key] = entries[key];
  console.log(JSON.stringify({ schemaVersion: 1, entries: sorted }, null, 2));
} else if (args.has('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printHuman();
}

const gating =
  production.increased.length > 0 ||
  production.stale.length > 0 ||
  errorDiagnostics.length > 0 ||
  run.exitCode !== 0;
if (gating && !args.has('--report-only') && !args.has('--print-baseline')) {
  if (errorDiagnostics.length > 0 || run.exitCode !== 0) {
    console.error(
      `biome reported ${errorDiagnostics.length} error-severity diagnostics (exit ${run.exitCode}); ` +
        'fix these first — the Lint job fails on them regardless.',
    );
  }
  process.exitCode = 1;
}
