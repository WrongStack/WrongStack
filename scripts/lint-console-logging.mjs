#!/usr/bin/env node
/**
 * Guards against ad-hoc console.warn/console.error string literals.
 *
 * Structured JSON logging is the project convention — every warning/error
 * should use `console.warn(JSON.stringify({ level, event, message, ... }))`.
 * This script flags the anti-pattern before it reaches the codebase.
 *
 * Usage:
 *   node scripts/lint-console-logging.mjs           # scan staged TS files
 *   node scripts/lint-console-logging.mjs --all      # scan all tracked TS files
 *   node scripts/lint-console-logging.mjs --force    # exit 0 regardless
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const FORCE = process.argv.includes('--force');
const ALL = process.argv.includes('--all');
const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');

// ── Pattern ──────────────────────────────────────────────────────────
// Matches `console.warn(` or `console.error(` where the FIRST argument is
// a string/template literal (starts with ', ", or `). This catches:
//
//   console.warn("naked string")          ❌
//   console.warn(`template with ${x}`)    ❌
//   console.warn('prefix:', err)          ❌  (ad-hoc context)
//
// And allows:
//   console.warn(JSON.stringify({...}))   ✅  (structured)
//   console.warn(err)                     ✅  (variable — could be structured)
//   console.warn(myFormatter(x))          ✅  (function call)
//   console.warn(new Error('msg'))        ✅  (Error object)
const AD_HOC_RE = /console\.(?:warn|error)\s*\(\s*(['"`])/g;

// ── File selection ───────────────────────────────────────────────────
const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts']);

function isTypeScript(filePath) {
  const base = filePath.split('/').pop() ?? filePath;
  const ext = '.' + base.split('.').slice(1).join('.');
  return TS_EXTS.has(ext);
}

function getStagedFiles() {
  try {
    const out = execSync('git diff --cached --name-only --diff-filter=ACMR', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function getAllTrackedFiles() {
  try {
    const out = execSync('git ls-files', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.trim().split('\n').filter(Boolean).filter(isTypeScript);
  } catch {
    return [];
  }
}

// ── Scan ─────────────────────────────────────────────────────────────

/**
 * Scan a single file for ad-hoc console.warn/error string literals.
 * Returns an array of { file, line, match } objects.
 */
function scanFile(filePath) {
  const findings = [];
  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return findings;
  }

  // Exclude this script itself.
  if (filePath === 'scripts/lint-console-logging.mjs') return findings;

  // Exclude test files — ad-hoc patterns in tests are expected
  // (spying on console.warn with string matchers).
  if (
    filePath.includes('.test.') ||
    filePath.includes('/tests/') ||
    filePath.includes('\\tests\\')
  ) {
    return findings;
  }

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    AD_HOC_RE.lastIndex = 0;
    const m = AD_HOC_RE.exec(line);
    if (m) {
      findings.push({
        file: filePath,
        line: i + 1,
        match: line.trim().slice(0, 120),
      });
    }
  }
  return findings;
}

// ── Main ─────────────────────────────────────────────────────────────

const files = ALL ? getAllTrackedFiles() : getStagedFiles().filter(isTypeScript);

if (files.length === 0) {
  if (VERBOSE) console.error('[lint-console] No staged TypeScript files to scan.');
  process.exit(0);
}

const allFindings = [];
for (const file of files) {
  allFindings.push(...scanFile(file));
}

if (allFindings.length === 0) {
  if (VERBOSE)
    console.error('[lint-console] ✅ No ad-hoc console.warn/error string literals found.');
  process.exit(0);
}

// ── Report ───────────────────────────────────────────────────────────
console.error(
  `\n[lint-console] ❌ ${allFindings.length} ad-hoc console.warn/error call(s) found:\n`,
);

for (const f of allFindings) {
  console.error(`  ${f.file}:${f.line}`);
  console.error(`    ${f.match}\n`);
}

console.error(
  '  Use structured JSON logging instead:\n' +
    '    console.warn(JSON.stringify({ level: "warn", event: "...", message: "...", timestamp: ... }))\n' +
    '  Or pass a variable/Error object:  console.warn(err)\n',
);

if (FORCE) {
  console.error('[lint-console] --force: exiting 0 despite violations.\n');
  process.exit(0);
}

process.exit(1);
