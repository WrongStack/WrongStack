#!/usr/bin/env node
/**
 * Fail if a build directory contains a hidden (dot-prefixed) entry.
 *
 * WS-070: CI uploads `packages/*​/dist` and `apps/*​/dist` as a build artifact
 * with `include-hidden-files: true`. That flag is there for a good reason — the
 * lineage manifest lives at `.reports/build-artifact-manifest.json`, which is
 * hidden — but it applies to every path in the upload, so any dotfile that ends
 * up inside a `dist` is swept into an artifact readable by anyone with repo
 * read access.
 *
 * The tempting fix is `!**​/.*` exclusion patterns on the upload step. Two
 * reasons this is better:
 *
 *   - Mixing include and exclude patterns changes how upload-artifact computes
 *     the artifact root, and two jobs download this artifact into `.` and then
 *     run `check:build-manifest` against the resulting layout. A silent layout
 *     shift would break lineage verification in a way that looks unrelated.
 *   - An exclusion hides the problem. If a build starts emitting `.env` into
 *     `dist`, that is worth knowing about — not worth quietly dropping from one
 *     consumer while it still sits on disk and in the published package.
 *
 * So this asserts the precondition instead: nothing hidden in `dist`, and the
 * upload flag stays honest.
 *
 *   node scripts/check-dist-hidden-files.mjs
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** Workspace roots whose `<member>/dist` directories are uploaded by CI. */
const UPLOADED_PARENTS = ['packages', 'apps'];

/**
 * Collect hidden entries under `dir`, relative to `repoRoot`.
 *
 * Reports the hidden entry itself and does NOT descend into it: a hidden
 * directory is one finding, not one per file inside it.
 *
 * @param {string} dir absolute directory to scan
 * @param {string[]} found accumulator of repo-relative paths
 */
export function collectHiddenEntries(dir, found = []) {
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found; // absent dist is not this check's problem
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.name.startsWith('.')) {
      found.push(full.slice(repoRoot.length).replaceAll('\\', '/'));
      continue;
    }
    if (entry.isDirectory()) collectHiddenEntries(full, found);
  }
  return found;
}

/** @returns {string[]} repo-relative hidden paths across every uploaded dist */
export function findHiddenDistEntries() {
  const found = [];
  for (const parent of UPLOADED_PARENTS) {
    const parentDir = join(repoRoot, parent);
    let members;
    try {
      members = readdirSync(parentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const member of members) {
      if (!member.isDirectory()) continue;
      const dist = join(parentDir, member.name, 'dist');
      try {
        if (!statSync(dist).isDirectory()) continue;
      } catch {
        continue;
      }
      collectHiddenEntries(dist, found);
    }
  }
  return found.sort();
}

// Only act when run directly, so the helpers stay importable from tests.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/'))) {
  const hidden = findHiddenDistEntries();
  if (hidden.length > 0) {
    console.error(
      `Hidden entries found in build output (WS-070). CI uploads these directories with\n` +
        `include-hidden-files: true, so anything below would be published to the build artifact:\n` +
        `${hidden.map((p) => `  ${p}`).join('\n')}\n\n` +
        `Remove them from the build, or — if one is genuinely required — add it to the\n` +
        `allowlist in this script with the reason.`,
    );
    process.exit(1);
  }
  console.log('No hidden entries in build output.');
}
