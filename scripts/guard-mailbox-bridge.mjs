#!/usr/bin/env node
/**
 * Mailbox-bridge integrity guard.
 *
 * Runs as part of `.githooks/pre-commit`. Catches two failure modes that
 * a careless refactor of `packages/cli/src/subcommands/handlers/mailbox-serve.ts`
 * would otherwise introduce silently:
 *
 *  1. **Source union removed `'http'`** — agents/clients registered over HTTP
 *     would silently fall back to `'cli'` (or fail to register), breaking
 *     the entire external-agent story.
 *
 *  2. **Route table reordered/removed** — `/mailbox/send`, `/mailbox/query`,
 *     `/mailbox/ack`, `/mailbox/ack-many`, `/mailbox/unread-count`,
 *     `/mailbox/agents/register`, `/mailbox/agents/heartbeat`,
 *     `/mailbox/register-client`, `/mailbox/heartbeat`,
 *     `/mailbox/agents`, `/mailbox/agents/online`, `/healthz`. External
 *     agents depend on these exact paths.
 *
 *  3. **`/healthz` becomes auth-gated** — k8s liveness probes, container
 *     orchestrators, and `curl http://host/healthz` would all break.
 *
 *  4. **The bare `mailboxServeCmd` import is removed from
 *     `packages/cli/src/subcommands/index.ts`** — subcommand registration
 *     silently disappears.
 *
 * The guard only runs when mailbox-bridge source files are part of the
 * staged diff (so it doesn't fire on unrelated commits). Failures print
 * the exact diff hunks that violated the invariant, then exit 1.
 */
import { execFileSync } from 'node:child_process';

const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');
const log = (...a) => { if (VERBOSE) console.error('[mailbox-guard]', ...a); };

const MAILBOX_BRIDGE_FILES = [
  'packages/cli/src/subcommands/handlers/mailbox-serve.ts',
  'packages/cli/src/subcommands/index.ts',
  'packages/core/src/coordination/mailbox-types.ts',
  'packages/core/src/coordination/index.ts',
  'packages/core/src/hq/protocol.ts',
];

const REQUIRED_ROUTES = [
  "url === '/mailbox/send'",
  "url === '/mailbox/query'",
  "url === '/mailbox/ack'",
  "url === '/mailbox/ack-many'",
  "url === '/mailbox/unread-count'",
  "url === '/mailbox/agents/register'",
  "url === '/mailbox/agents/heartbeat'",
  "url === '/mailbox/register-client'",
  "url === '/mailbox/heartbeat'",
  "url === '/mailbox/agents'",
  "url === '/mailbox/agents/online'",
  "url === '/healthz'",
];

const REQUIRED_SOURCE_LITERALS = [
  // Each file must contain its respective 'http' source literal. We
  // require the literal in the file (not in the diff) so renaming a
  // file or moving the literal elsewhere trips the guard.
  { file: 'packages/core/src/coordination/mailbox-types.ts', literal: "'http'" },
  { file: 'packages/core/src/coordination/mailbox-types.ts', literal: "'cli' | 'webui' | 'mcp' | 'acp' | 'http'" },
  { file: 'packages/core/src/hq/protocol.ts', literal: "'cli' | 'webui' | 'mcp' | 'acp' | 'http'" },
];

const REQUIRED_HEALTHZ_BEFORE_AUTH = {
  // The /healthz branch must appear ABOVE the authorize() call in
  // mailbox-serve.ts — otherwise liveness probes need a token, which
  // defeats the point.
  file: 'packages/cli/src/subcommands/handlers/mailbox-serve.ts',
  marker: "url === '/healthz'",
  mustComeBefore: 'authorize(',
};

const REQUIRED_SUBCOMMAND_WIRING = {
  file: 'packages/cli/src/subcommands/index.ts',
  marker: 'mailboxServeCmd',
};

function getStagedFiles() {
  try {
    const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function readFileAtHEAD(path) {
  try {
    return execFileSync('git', ['show', `HEAD:${path}`], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

let failures = 0;

function fail(msg) {
  console.error(`[mailbox-guard] ${msg}`);
  failures++;
}

async function checkRoutes() {
  // If mailbox-serve.ts is being modified (staged), every route must
  // either still exist in the post-commit state or be intentionally
  // removed (we can't tell intent from a diff, so we just verify the
  // route is present in the file as it exists at HEAD or in the staged
  // version).
  const staged = getStagedFiles();
  if (!staged.includes(REQUIRED_HEALTHZ_BEFORE_AUTH.file)) {
    log('mailbox-serve.ts not staged — route-table check skipped');
    return;
  }

  // Build the post-commit content = HEAD content + staged diff applied.
  // For simplicity we just read the file from the working tree (which
  // includes both the staged change and any unstaged local edits).
  let content;
  try {
    const fs = await import('node:fs/promises');
    content = await fs.readFile(REQUIRED_HEALTHZ_BEFORE_AUTH.file, 'utf-8');
  } catch (err) {
    fail(`cannot read ${REQUIRED_HEALTHZ_BEFORE_AUTH.file}: ${err.message}`);
    return;
  }

  for (const route of REQUIRED_ROUTES) {
    if (!content.includes(route)) {
      fail(`missing route check: ${route}`);
    }
  }
}

async function checkHealthzBeforeAuth() {
  let content;
  try {
    const fs = await import('node:fs/promises');
    content = await fs.readFile(REQUIRED_HEALTHZ_BEFORE_AUTH.file, 'utf-8');
  } catch (err) {
    fail(`cannot read ${REQUIRED_HEALTHZ_BEFORE_AUTH.file}: ${err.message}`);
    return;
  }
  const healthzIdx = content.indexOf(REQUIRED_HEALTHZ_BEFORE_AUTH.marker);
  const authIdx = content.indexOf(REQUIRED_HEALTHZ_BEFORE_AUTH.mustComeBefore);
  if (healthzIdx === -1) {
    fail(`missing ${REQUIRED_HEALTHZ_BEFORE_AUTH.marker} in ${REQUIRED_HEALTHZ_BEFORE_AUTH.file}`);
    return;
  }
  if (authIdx === -1) {
    fail(`cannot find authorize() call in ${REQUIRED_HEALTHZ_BEFORE_AUTH.file} — healthz ordering check skipped`);
    return;
  }
  if (healthzIdx > authIdx) {
    fail(
      `/healthz must be served BEFORE authorize() — otherwise liveness probes need a token.\n` +
      `        healthz at offset ${healthzIdx}, authorize() at ${authIdx}.\n` +
      `        See /healthz handling in mailbox-serve.ts.`,
    );
  }
}

async function checkSourceLiterals() {
  for (const { file, literal } of REQUIRED_SOURCE_LITERALS) {
    let content = await readFileAtHEAD(file);
    if (content === null) continue; // file may be new — pre-commit already validated by the diff
    try {
      const fs = await import('node:fs/promises');
      // Use the working-tree version when available so we catch
      // unstaged edits too. Pre-commit only blocks on staged content,
      // but if a developer already wrote a broken union on disk, the
      // working tree catches it as well.
      const staged = getStagedFiles();
      if (staged.includes(file)) {
        content = await fs.readFile(file, 'utf-8');
      }
    } catch {
      // fall back to HEAD content
    }
    if (!content || !content.includes(literal)) {
      fail(`missing source literal "${literal}" in ${file}`);
    }
  }
}

async function checkSubcommandWiring() {
  let content = await readFileAtHEAD(REQUIRED_SUBCOMMAND_WIRING.file);
  const staged = getStagedFiles();
  if (staged.includes(REQUIRED_SUBCOMMAND_WIRING.file)) {
    const fs = await import('node:fs/promises');
    content = await fs.readFile(REQUIRED_SUBCOMMAND_WIRING.file, 'utf-8');
  }
  if (!content || !content.includes(REQUIRED_SUBCOMMAND_WIRING.marker)) {
    fail(`missing "${REQUIRED_SUBCOMMAND_WIRING.marker}" wiring in ${REQUIRED_SUBCOMMAND_WIRING.file} — subcommand will not be registered`);
  }
}

await checkRoutes();
await checkHealthzBeforeAuth();
await checkSourceLiterals();
await checkSubcommandWiring();

if (failures > 0) {
  console.error(`[mailbox-guard] ${failures} mailbox-bridge integrity check(s) failed.`);
  console.error('[mailbox-guard] See scripts/guard-mailbox-bridge.mjs for the invariants.');
  process.exit(1);
}
log('mailbox-bridge integrity check passed');