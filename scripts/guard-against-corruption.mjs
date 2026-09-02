#!/usr/bin/env node
import { execSync, execFileSync } from 'node:child_process';
const MAX_FILES = Number.parseInt(process.env.GUARD_MAX_FILES ?? '', 10) || 500;
const FORCE_FLAG = process.argv.includes('--force');
const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');
const CORRUPTION_FRAGMENT = "{ type: 'worktreeMonitorToggle' }";
// `worktreeMonitorToggle` is now a real, fully-wired TUI feature (state +
// action + reducer + dispatches) and it lives entirely in app.tsx. Treat the
// pattern as legitimate there; flag it only if it reappears in OTHER files,
// which is the actual corruption signature this guard was built to catch.
const CORRUPTION_ALLOWLIST = new Set([
  'packages/tui/src/app.tsx',
  'packages/tui/src/app-reducer.ts',
  'packages/tui/src/app-state.ts',
]);
const SCAN_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.json',
  '.jsonc',
  '.md',
  '.yml',
  '.yaml',
  '.sh',
  '.ps1',
]);
function log(...args) {
  if (VERBOSE) console.error('[guard]', ...args);
}
function isScannable(filePath) {
  const base = filePath.split('/').pop() ?? filePath;
  const ext = '.' + (base.split('.').pop() ?? '');
  if (SCAN_EXTS.has(ext)) {
    if (base === 'guard-against-corruption.mjs') return false;
    return true;
  }
  return false;
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
/**
 * Scan only the staged DIFF (not the full file content) for the corruption
 * pattern. Only added lines (+ prefix) are scanned to avoid false-positives
 * from pre-existing code in modified files.
 */
function findCorruptionInStagedFiles(stagedFiles) {
  const findings = [];
  for (const file of stagedFiles) {
    if (!isScannable(file)) continue;
    if (CORRUPTION_ALLOWLIST.has(file)) continue;
    let diff;
    try {
      diff = execFileSync('git', ['diff', '--cached', '--', file], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      continue;
    }
    const lines = diff.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Only scan added lines (+ prefix) to avoid false positives from context lines
      if (line?.startsWith('+') && !line.startsWith('+++')) {
        if (line.includes(CORRUPTION_FRAGMENT)) {
          findings.push({ file, line: i + 1, snippet: line.slice(0, 120) });
        }
      }
    }
  }
  return findings;
}
function main() {
  log('Starting corruption guard...');
  const stagedFiles = getStagedFiles();
  log('Staged files: ' + stagedFiles.length);
  if (stagedFiles.length === 0) {
    console.error('[guard] No staged files - nothing to check.');
    return 0;
  }
  const corruption = findCorruptionInStagedFiles(stagedFiles);
  if (corruption.length > 0) {
    console.error('');
    console.error('============================================================');
    console.error('  BLOCKED  --  CORRUPTION PATTERN DETECTED');
    console.error('============================================================');
    const uniqueFiles = new Set(corruption.map((c) => c.file)).size;
    console.error(
      '  Found ' + corruption.length + ' infected line(s) across ' + uniqueFiles + ' file(s).',
    );
    console.error('');
    for (const { file, line, snippet } of corruption.slice(0, 20)) {
      console.error('  ' + file + ':' + line);
      console.error('    -> ' + JSON.stringify(snippet.trim()));
    }
    if (corruption.length > 20) console.error('  ... and ' + (corruption.length - 20) + ' more.');
    console.error('');
    console.error('  Fix: git checkout HEAD -- <infected-files>');
    console.error('  Then re-apply your intended changes carefully.');
    console.error('');
    return 1;
  }
  const totalChanged = (() => {
    try {
      const out = execSync('git status --porcelain', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return out.trim().split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  })();
  if (totalChanged > MAX_FILES && !FORCE_FLAG) {
    console.error('');
    console.error('============================================================');
    console.error('  FLAGGED  --  SUSPICIOUS MASS-CHANGE');
    console.error('============================================================');
    console.error('  ' + totalChanged + ' files changed (threshold: ' + MAX_FILES + ').');
    console.error('  This often means a broken global find/replace ran wild.');
    console.error('  Review with `git status` before committing.');
    console.error('  To override: git commit --no-verify');
    console.error('  Or set GUARD_MAX_FILES=' + (totalChanged + 1));
    console.error('');
    return 2;
  }
  log('All checks passed (' + stagedFiles.length + ' staged, ' + totalChanged + ' total changed).');
  return 0;
}
process.exit(main());
