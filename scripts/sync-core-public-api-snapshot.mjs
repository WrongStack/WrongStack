#!/usr/bin/env bun
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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshotOutputs = [
  'architecture/core-public-api-snapshot.json',
  'architecture/core-public-api-usage.json',
];

/** Any module specifier that resolves into `@wrongstack/core`. */
const CORE_SPECIFIER = /@wrongstack\/core(?:\/|['"])/u;

/** Default source reader: read the repo-relative path from disk. */
function readSourceFromDisk(file) {
  return readFileSync(path.join(repoRoot, file), 'utf8');
}

/**
 * Does an edit to `file` feed `core-public-api-{snapshot,usage}.json`?
 *
 * Inputs include the generator itself, its policy, the `packages/core` manifest
 * and `packages/core/src/**` (which become the snapshot inventory), and the census
 * of `@wrongstack/core` imports across `packages`/`apps`/`scripts` (which
 * becomes the usage snapshot). So a file is an input only if it is one of the
 * explicit inputs, or its content actually imports the package.
 *
 * The previous predicate was the bare path shape — every `.ts`/`.tsx`/`.js`
 * under `packages|apps|scripts` — which made the documented `skip` branch
 * (`decideSnapshotAction`) unreachable for every non-Core package commit. A
 * fenced commit that provably cannot move the artifacts was refused because
 * unrelated peers had *some* TS file dirty.
 *
 * `readSource` is injectable so the decision stays testable without touching
 * the filesystem. It FAILS CLOSED: any unreadable file is treated as an input,
 * because a false negative would let a peer's in-flight edit reach the
 * committed artifacts, which is the one failure this guard exists to prevent.
 */
export function isSnapshotInput(file, readSource = readSourceFromDisk) {
  if (
    file === 'packages/core/package.json' ||
    file === 'architecture/core-api-policy.json' ||
    file === 'scripts/snapshot-core-public-api.mjs'
  ) {
    return true;
  }
  // The inventory walks `packages/core/src` unconditionally: every file there
  // contributes to the snapshot whether or not it imports the package.
  if (file.startsWith('packages/core/src/')) {
    return /\.(?:[cm]?[jt]sx?)$/u.test(file);
  }
  if (!/^(?:packages|apps|scripts)\/.+\.(?:[cm]?[jt]sx?)$/u.test(file)) {
    return false;
  }
  let source;
  try {
    source = readSource(file);
  } catch {
    return true; // fail closed — see the docstring
  }
  return CORE_SPECIFIER.test(source);
}

export function changedSnapshotInputs(files, readSource = readSourceFromDisk) {
  return [...new Set(files.filter((file) => isSnapshotInput(file, readSource)))].sort();
}

/**
 * Pure decision for the pre-commit snapshot sync, exported so the regression
 * test can pin the semantics without shelling out to git.
 *
 *   skip     — the staged set touches no snapshot input: regeneration cannot
 *              be affected by (and must not be blocked by) unrelated unstaged
 *              or untracked work elsewhere in the shared tree. This is the
 *              fenced-commit-in-a-dirty-tree case: a peer's in-flight edits
 *              to snapshot inputs must not block a commit whose own staged
 *              files never feed the generated artifacts.
 *   fail     — the staged set DOES touch snapshot inputs (regeneration would
 *              run), and other unstaged/untracked snapshot inputs exist:
 *              regenerating now would capture that unrelated work in the
 *              committed artifacts. Refuse and ask for a clean tree.
 *   generate — staged inputs exist and nothing else dirty touches an input.
 */
export function decideSnapshotAction({ staged, unstaged, untracked }) {
  const stagedInputs = changedSnapshotInputs(staged ?? []);
  if (stagedInputs.length === 0) return { action: 'skip', stagedInputs };
  const unsafeInputs = changedSnapshotInputs([...(unstaged ?? []), ...(untracked ?? [])]);
  if (unsafeInputs.length > 0) return { action: 'fail', stagedInputs, unsafeInputs };
  return { action: 'generate', stagedInputs };
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

  const decision = decideSnapshotAction({
    staged: git(['diff', '--cached', '--name-only', '--diff-filter=ACMRD']),
    unstaged: git(['diff', '--name-only', '--diff-filter=ACMRD']),
    untracked: git(['ls-files', '--others', '--exclude-standard']),
    readSource: readSourceFromDisk,
  });

  if (decision.action === 'skip') {
    // Staged files exist but none feed the Core API snapshots: nothing to
    // regenerate, and unrelated unstaged work elsewhere in the shared tree
    // cannot affect (and must not block) this commit. Logged rather than
    // returning silently so the skip is observable when debugging why no
    // snapshot was refreshed.
    console.log('Core API snapshot sync skipped: staged set touches no Core API snapshot inputs.');
    return;
  }

  if (decision.action === 'fail') {
    throw new Error(
      'Cannot safely auto-update Core API snapshots because snapshot inputs also have ' +
        `unstaged or untracked edits: ${decision.unsafeInputs.join(', ')}. ` +
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
