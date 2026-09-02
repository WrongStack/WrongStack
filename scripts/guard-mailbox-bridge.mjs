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
 * After the canonical router was extracted into
 * `packages/core/src/coordination/mailbox-http-router.ts`, the route
 * table and `'http'` source literal now live in core. The guard
 * accepts either location so the bridge's delegation continues to
 * keep the public wire contract intact.
 *
 * The guard only runs when mailbox-bridge source files are part of the
 * staged diff (so it doesn't fire on unrelated commits). Failures print
 * the exact diff hunks that violated the invariant, then exit 1.
 */
import { execFileSync } from 'node:child_process';

const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');
const log = (...a) => {
  if (VERBOSE) console.error('[mailbox-guard]', ...a);
};

const _MAILBOX_BRIDGE_FILES = [
  'packages/cli/src/subcommands/handlers/mailbox-serve.ts',
  'packages/cli/src/subcommands/index.ts',
  'packages/core/src/coordination/mailbox-http-router.ts',
  'packages/core/src/coordination/mailbox-types.ts',
  'packages/core/src/coordination/index.ts',
  'packages/core/src/hq/protocol.ts',
];

const REQUIRED_ROUTES = [
  "path === '/mailbox/send'",
  "path === '/mailbox/query'",
  "path === '/mailbox/ack'",
  "path === '/mailbox/ack-many'",
  "path === '/mailbox/unread-count'",
  "path === '/mailbox/agents/register'",
  "path === '/mailbox/agents/heartbeat'",
  "path === '/mailbox/register-client'",
  "path === '/mailbox/heartbeat'",
  "path === '/mailbox/agents'",
  "path === '/mailbox/agents/online'",
  "url === '/healthz'",
];

// Query-parameter literals introduced for the staleness filter. Both live
// in `packages/core/src/coordination/mailbox-http-router.ts`. Callers
// (HQ gateway, standalone bridge, external agents) pass them through the
// URL appended to the route; if the guard ever rejects a router change
// that drops either literal, the staleness filter has been broken at
// the wire.
const REQUIRED_QUERY_PARAM_LITERALS = ["'sinceMs'", 'MAILBOX_HTTP_MAX_AGE_CEILING_MS'];

const REQUIRED_SOURCE_LITERALS = [
  // Each file must contain its respective 'http' source literal. We
  // require the literal in the file (not in the diff) so renaming a
  // file or moving the literal elsewhere trips the guard.
  { file: 'packages/core/src/coordination/mailbox-types.ts', literal: "'http'" },
  {
    file: 'packages/core/src/coordination/mailbox-types.ts',
    literal: "'cli' | 'webui' | 'mcp' | 'acp' | 'http'",
  },
  // The shared router still tags external registrations as 'http'.
  // After extraction, the literal lives in mailbox-http-validation.ts.
  { file: 'packages/core/src/coordination/mailbox-http-validation.ts', literal: "source: 'http'" },
  // Moved from hq/protocol.ts into the hq/protocol/ domain split (R12): the
  // HQ mailbox source union now lives with the HqMailbox* types in mailbox.ts.
  {
    file: 'packages/core/src/hq/protocol/mailbox.ts',
    literal: "'cli' | 'webui' | 'mcp' | 'acp' | 'http'",
  },
];

const REQUIRED_HEALTHZ_UNAUTHENTICATED = {
  // After the canonical router was extracted, the `/healthz` branch lives
  // in `packages/core/src/coordination/mailbox-http-router.ts`. It must
  // appear BEFORE any authorization step in that file so liveness probes
  // never require a token.
  file: 'packages/core/src/coordination/mailbox-http-router.ts',
  marker: "url === '/healthz'",
  mustComeBefore: '.authorize(',
};

const REQUIRED_SUBCOMMAND_WIRING = {
  file: 'packages/cli/src/subcommands/index.ts',
  marker: 'mailboxServeCmd',
};

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

async function readFileAtHEAD(path) {
  try {
    return execFileSync('git', ['show', `HEAD:${path}`], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
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
  // If any mailbox-bridge file is staged, every canonical route must
  // appear in at least one of the canonical files: the bridge
  // (`packages/cli/src/subcommands/handlers/mailbox-serve.ts`) or the
  // shared router (`packages/core/src/coordination/mailbox-http-router.ts`).
  // The bridge delegates to the router, so the route literals only need
  // to live in one place. We read both files from the working tree,
  // which includes staged + unstaged changes, so a focused commit that
  // updates either file passes.
  const staged = getStagedFiles();
  const canonicalFiles = [
    'packages/cli/src/subcommands/handlers/mailbox-serve.ts',
    'packages/core/src/coordination/mailbox-http-router.ts',
    'packages/core/src/coordination/mailbox-http-validation.ts',
  ];
  const anyCanonical = canonicalFiles.some((file) => staged.includes(file));
  if (!anyCanonical) {
    log('no mailbox-bridge canonical file staged — route-table check skipped');
    return;
  }

  let combined = '';
  const fs = await import('node:fs/promises');
  for (const file of canonicalFiles) {
    try {
      combined += `\n${await fs.readFile(file, 'utf-8')}`;
    } catch (err) {
      fail(`cannot read ${file}: ${err.message}`);
      return;
    }
  }

  for (const route of REQUIRED_ROUTES) {
    if (!combined.includes(route)) {
      fail(`missing route check: ${route}`);
    }
  }
}

async function checkHealthzBeforeAuth() {
  let content;
  try {
    const fs = await import('node:fs/promises');
    content = await fs.readFile(REQUIRED_HEALTHZ_UNAUTHENTICATED.file, 'utf-8');
  } catch (err) {
    fail(`cannot read ${REQUIRED_HEALTHZ_UNAUTHENTICATED.file}: ${err.message}`);
    return;
  }
  const healthzIdx = content.indexOf(REQUIRED_HEALTHZ_UNAUTHENTICATED.marker);
  const authIdx = content.indexOf(REQUIRED_HEALTHZ_UNAUTHENTICATED.mustComeBefore);
  if (healthzIdx === -1) {
    fail(
      `missing ${REQUIRED_HEALTHZ_UNAUTHENTICATED.marker} in ${REQUIRED_HEALTHZ_UNAUTHENTICATED.file}`,
    );
    return;
  }
  if (authIdx === -1) {
    fail(
      `cannot find authorize() step in ${REQUIRED_HEALTHZ_UNAUTHENTICATED.file} — healthz ordering check skipped`,
    );
    return;
  }
  if (healthzIdx > authIdx) {
    fail(
      `/healthz must be served BEFORE authorize() — otherwise liveness probes need a token.\n` +
        `        healthz at offset ${healthzIdx}, authorize() at ${authIdx}.\n` +
        `        See /healthz handling in mailbox-http-router.ts.`,
    );
  }
}

async function checkQueryParamLiterals() {
  // Same trigger as checkRoutes — only run when a canonical file is
  // staged. The query-parameter literals live exclusively in the
  // router file, but we still verify them against the canonical-file
  // combined content so a future split of the query-param parser
  // across files would be caught by the new fixture entry rather
  // than silently surviving.
  const staged = getStagedFiles();
  const canonicalFiles = [
    'packages/cli/src/subcommands/handlers/mailbox-serve.ts',
    'packages/core/src/coordination/mailbox-http-router.ts',
    'packages/core/src/coordination/mailbox-http-validation.ts',
  ];
  const anyCanonical = canonicalFiles.some((file) => staged.includes(file));
  if (!anyCanonical) {
    log('no mailbox-bridge canonical file staged — query-param check skipped');
    return;
  }

  let combined = '';
  const fs = await import('node:fs/promises');
  for (const file of canonicalFiles) {
    try {
      combined += `\n${await fs.readFile(file, 'utf-8')}`;
    } catch (err) {
      fail(`cannot read ${file}: ${err.message}`);
      return;
    }
  }

  for (const literal of REQUIRED_QUERY_PARAM_LITERALS) {
    if (!combined.includes(literal)) {
      fail(`missing query-parameter literal: ${literal}`);
    }
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
    if (!content?.includes(literal)) {
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
  if (!content?.includes(REQUIRED_SUBCOMMAND_WIRING.marker)) {
    fail(
      `missing "${REQUIRED_SUBCOMMAND_WIRING.marker}" wiring in ${REQUIRED_SUBCOMMAND_WIRING.file} — subcommand will not be registered`,
    );
  }
}

await checkRoutes();
await checkQueryParamLiterals();
await checkHealthzBeforeAuth();
await checkSourceLiterals();
await checkSubcommandWiring();

if (failures > 0) {
  console.error(`[mailbox-guard] ${failures} mailbox-bridge integrity check(s) failed.`);
  console.error('[mailbox-guard] See scripts/guard-mailbox-bridge.mjs for the invariants.');
  process.exit(1);
}
log('mailbox-bridge integrity check passed');
