#!/usr/bin/env node
/**
 * Refuse advisory suppressions that a pull request adds to its own audit gate.
 *
 * `pnpm audit` reads `auditConfig.ignoreGhsas` from `pnpm-workspace.yaml` — and
 * on a pull request it reads the PR's OWN copy. `pnpm-workspace.yaml` is also
 * one of the workflow's trigger paths. So a PR that introduces a vulnerable
 * dependency can add the matching GHSA id in the same commit and the gate that
 * exists to stop it reports success. Reproduced in an isolated project during
 * the 2026-09-10 audit: three added lines flipped a critical advisory from
 * `exit 1` to `exit 0 (1 ignored)`.
 *
 * This is the same "a fork cannot widen its own allowlist" property the repo
 * already enforces for lifecycle scripts (VF-31); it was never applied to
 * advisory suppression.
 *
 * Removing a suppression is always fine — that only ever makes the gate
 * stricter. Adding one is a decision that belongs on the base branch, in front
 * of a reviewer, not inside the change it would unblock.
 *
 * Usage: node scripts/check-audit-suppressions.mjs <base-file> <head-file>
 * Exits 1 when the head file suppresses an advisory the base file does not.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Pull GHSA ids out of the `ignoreGhsas:` block of a pnpm-workspace.yaml.
 *
 * Deliberately not a YAML parse: this runs before any install, so no parser is
 * available, and the shape is a flat list of ids. The scan starts at
 * `ignoreGhsas:` and stops at the next line that is neither a list item nor
 * blank nor a comment, so ids elsewhere in the file cannot leak in.
 */
export function extractIgnoredGhsas(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const ids = new Set();
  let inBlock = false;
  let blockIndent = 0;

  for (const line of lines) {
    if (!inBlock) {
      const start = /^(\s*)ignoreGhsas\s*:/.exec(line);
      if (start) {
        inBlock = true;
        blockIndent = (start[1] ?? '').length;
      }
      continue;
    }

    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    const item = /^(\s*)-\s*(.+?)\s*$/.exec(line);
    if (!item) break; // dedented out of the block
    if ((item[1] ?? '').length <= blockIndent) break;

    // Strip surrounding quotes and any trailing comment.
    const value = (item[2] ?? '')
      .replace(/\s+#.*$/, '')
      .replace(/^['"]|['"]$/g, '')
      .trim();
    if (value) ids.add(value);
  }

  return ids;
}

function main(argv) {
  const [basePath, headPath] = argv;
  if (!basePath || !headPath) {
    console.error('usage: check-audit-suppressions.mjs <base-file> <head-file>');
    return 2;
  }

  // A missing BASE file means the key did not exist there — treat as empty
  // rather than passing, so adding the whole block is still caught.
  let baseText = '';
  try {
    baseText = readFileSync(basePath, 'utf8');
  } catch {
    baseText = '';
  }
  const headText = readFileSync(headPath, 'utf8');

  const base = extractIgnoredGhsas(baseText);
  const head = extractIgnoredGhsas(headText);
  const added = [...head].filter((id) => !base.has(id));
  const removed = [...base].filter((id) => !head.has(id));

  if (removed.length > 0) {
    console.log(`Suppressions removed (gate gets stricter, allowed): ${removed.join(', ')}`);
  }

  if (added.length === 0) {
    console.log(`No new advisory suppressions. (${head.size} in effect)`);
    return 0;
  }

  console.error(
    [
      '',
      'This pull request adds advisory suppressions to its own audit gate:',
      ...added.map((id) => `  - ${id}`),
      '',
      '`pnpm audit` reads `auditConfig.ignoreGhsas` from the branch under test, so',
      'these entries would silence the very advisories this job exists to catch.',
      '',
      'Land the suppression on the base branch first, with the reason it is safe,',
      'or fix the dependency instead.',
      '',
    ].join('\n'),
  );
  return 1;
}

// `pathToFileURL`, not a hand-built `file://` string: on Windows an absolute
// path produces `file:///D:/...` (three slashes) while concatenation yields
// `file://D:/...`, so the comparison never matched and this script exited 0
// having done nothing — a gate that silently passes, which is the exact
// failure class it was written to prevent.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}

export { main };
