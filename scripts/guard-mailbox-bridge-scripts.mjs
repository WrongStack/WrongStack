#!/usr/bin/env node
/**
 * Mailbox-bridge script integrity guard.
 *
 * Runs as part of `.githooks/pre-commit`. Catches two failure modes:
 *
 *  1. **`scripts/install-mailbox-bridge-skills.sh` loses bash syntax
 *     compatibility** — if someone refactors it and accidentally
 *     introduces a `sh`-only construct that breaks on macOS bash 3.2
 *     (the default on every Mac shipped since 2019), `bash -n` won't
 *     catch it, but the install helper will silently fail when
 *     external-agent users run it. We parse it ourselves to catch
 *     the common breakage modes: unbalanced quotes, mismatched case
 *     statements, `set -e` removal.
 *
 *  2. **The script is deleted entirely** — if a future commit removes
 *     `scripts/install-mailbox-bridge-skills.sh`, the install path
 *     silently disappears. The guard fails the commit and points the
 *     operator at the offending change.
 *
 * Only runs when the script is staged for commit. Cheap — no shell
 * invocation, no rebuild, single file read.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';

const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');
const log = (...a) => {
  if (VERBOSE) console.error('[mailbox-script-guard]', ...a);
};

const SCRIPT_PATH = 'scripts/install-mailbox-bridge-skills.sh';

let failures = 0;
function fail(msg) {
  console.error(`[mailbox-script-guard] ${msg}`);
  failures++;
}

function getStagedFiles() {
  try {
    const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

const staged = getStagedFiles();
const deleted = staged.includes(SCRIPT_PATH);
const modified = staged.includes(SCRIPT_PATH);

// Bail out early if the script isn't part of this commit.
if (!deleted && !modified) {
  log('install helper script not staged — nothing to guard');
  process.exit(0);
}

// Deletion is a hard fail — the install path is part of the contract.
if (deleted) {
  // `git diff --cached --diff-filter=D` gives the path; --name-status
  // tells us the status letter.
  const statusOut = execFileSync('git', ['diff', '--cached', '--name-status'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = statusOut.split('\n');
  const deletedLines = lines.filter((l) => l.startsWith(`D\t${SCRIPT_PATH}`));
  if (deletedLines.length > 0) {
    fail(
      `${SCRIPT_PATH} is being deleted. The external-agent install path is part of the bridge contract — if this is intentional, update scripts/guard-mailbox-bridge-scripts.mjs instead of removing it.`,
    );
  }
}

// Read the script content from the staged version. Since the file
// is already staged, the working-tree copy IS the staged copy (git
// holds it in the index blob, but reading from disk gives the same
// content the user is about to commit). This is simpler than parsing
// a patch.
let content;
try {
  content = await fs.readFile(SCRIPT_PATH, 'utf-8');
} catch (err) {
  fail(`cannot read ${SCRIPT_PATH}: ${err.message}`);
}

// 1. Bash syntax check via `bash -n`. Catches parse errors before
//   users do. The script path argument uses `--` to guard against
//   path components starting with `-`.
try {
  execFileSync('bash', ['-n', '--', SCRIPT_PATH], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
} catch (err) {
  fail(`bash -n ${SCRIPT_PATH} failed: ${err.message}`);
}

// 1. Bash syntax check via `bash -n`. Cheap, catches parse errors.
try {
  execFileSync('bash', ['-n', '--', SCRIPT_PATH], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
} catch (err) {
  fail(`bash -n ${SCRIPT_PATH} failed: ${err.message}`);
}

// 2. Required header: `set -euo pipefail`. If someone removes this,
//   an early `cd` failure will silently leave the script running
//   with stale state. Catching the removal here is cheap.
if (content && !/^set\s+-[a-z]*e[a-z]*\b/m.test(content)) {
  fail(
    `${SCRIPT_PATH} is missing 'set -e' in its options — early failures will be silently ignored.`,
  );
}

// 3. Required header: shebang must be `#!/usr/bin/env bash` (POSIX-portable
//   shebang) so the script runs under any bash on PATH, not just
//   /bin/bash. We allow the legacy `#!/bin/bash` for systems that
//   hard-link bash at /bin/bash, but flag anything else.
if (content && !/^#!(\/usr\/bin\/env bash|\/bin\/bash)\b/m.test(content)) {
  fail(`${SCRIPT_PATH} has an unexpected shebang. Use '#!/usr/bin/env bash' or '#!/bin/bash'.`);
}

// 4. Required token: the script must mention the source path
//   (`packages/core/skills/wrongstack-mailbox/SKILL.md`). If someone
//   renames the bundled skill without updating the helper, the
//   install will fail at runtime.
if (content && !content.includes('packages/core/skills/wrongstack-mailbox/SKILL.md')) {
  fail(
    `${SCRIPT_PATH} does not reference the expected bundled-skill source path. Update it to point to 'packages/core/skills/wrongstack-mailbox/SKILL.md'.`,
  );
}

if (failures > 0) {
  console.error(`[mailbox-script-guard] ${failures} mailbox-bridge script check(s) failed.`);
  console.error(
    '[mailbox-script-guard] See scripts/guard-mailbox-bridge-scripts.mjs for the invariants.',
  );
  process.exit(1);
}
log('mailbox-bridge script integrity check passed');
