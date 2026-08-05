#!/usr/bin/env node
/**
 * Keep the committed Core API evidence aligned with a staged source change.
 *
 * `release:check` deliberately verifies committed architecture evidence without
 * writing it: a writer there could make a local release pass while CI still
 * fails from a fresh checkout. This pre-commit helper is the safe automation
 * point. It stages only the two generated artifacts after confirming that no
 * snapshot input has an unstaged or untracked edit that could leak unrelated
 * shared-worktree work into the commit.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshotOutputs = [
  'architecture/core-public-api-snapshot.json',
  'architecture/core-public-api-usage.json',
];

export function isSnapshotInput(file) {
  if (file === 'packages/core/package.json' || file === 'architecture/core-api-policy.json') {
    return true;
  }
  return /^(?:packages|apps|scripts)\/.+\.(?:[cm]?[jt]sx?)$/u.test(file);
}

export function changedSnapshotInputs(files) {
  return [...new Set(files.filter(isSnapshotInput))].sort();
}

function git(args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean);
}

export function helpText() {
  return 'Usage: node scripts/sync-core-public-api-snapshot.mjs';
}

export function main() {
  if (process.argv.includes('--help')) {
    console.log(helpText());
    return;
  }
  if (process.argv.length > 2) {
    throw new Error(`${helpText()}\nThis command does not accept arguments.`);
  }

  const stagedInputs = changedSnapshotInputs(
    git(['diff', '--cached', '--name-only', '--diff-filter=ACMRD']),
  );
  if (stagedInputs.length === 0) return;

  const unsafeInputs = changedSnapshotInputs([
    ...git(['diff', '--name-only', '--diff-filter=ACMRD']),
    ...git(['ls-files', '--others', '--exclude-standard']),
  ]);
  if (unsafeInputs.length > 0) {
    throw new Error(
      'Cannot safely auto-update Core API snapshots because snapshot inputs also have ' +
        `unstaged or untracked edits: ${unsafeInputs.join(', ')}. ` +
        'Stage or set aside those edits first; this prevents unrelated shared-worktree work ' +
        'from being captured in the generated architecture artifacts.',
    );
  }

  const result = spawnSync(process.execPath, ['scripts/snapshot-core-public-api.mjs', '--write'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  if (process.exitCode) return;

  execFileSync('git', ['add', '--', ...snapshotOutputs], { cwd: repoRoot, stdio: 'inherit' });
  console.log('Staged refreshed Core API snapshots for the staged source change.');
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) main();
