/**
 * Global vitest setup — runs in EVERY worker before any test file.
 *
 * Hermetic global root: redirect ALL `~/.wrongstack` state (config, secrets
 * vault, logs, projects/, mailboxes, sessions) to a per-worker temp dir via
 * the WRONGSTACK_HOME override honored by `wstackGlobalRoot()` /
 * `resolveWstackPaths()`.
 *
 * Without this, tests that boot real runtimes (setupPlugins, repl, webui,
 * mailbox, sdd/goal stores) hit the REAL user home: they read the user's
 * real config.json (which once started a second live Telegram poller from
 * inside the test suite), append to the real wrongstack.log, and leak
 * thousands of fixture project dirs under ~/.wrongstack/projects.
 *
 * Per-PID dir: the forks pool gives each worker its own process, so workers
 * never share state; the OS temp cleaner reclaims the dirs.
 *
 * Tests that pass an explicit `userHome`/`globalRoot` to resolveWstackPaths
 * are unaffected — explicit options take precedence over the env override.
 */

// ── Permanent SQLite ExperimentalWarning suppressor ───────────────────────
// Vitest workers (forks pool) are separate processes — they do NOT inherit the
// suppressor installed in cli-entry-point.ts. Install it here so every worker
// suppresses the warning regardless of which test file loads node:sqlite first.
// This catches top-level value imports (e.g. `import { DatabaseSync } from 'node:sqlite'`)
// that fire at module evaluation time, before any lazy-load suppressor is active.
const SQLITE_WARNING_RE = /sqlite is an experimental feature/i;

function installSqliteWarningFilter(): void {
  const originalEmit = process.emitWarning.bind(process);
  process.emitWarning = ((warning: unknown, ...rest: unknown[]): void => {
    const msg = typeof warning === 'string' ? warning : ((warning as Error)?.message ?? '');
    const type =
      typeof warning === 'string' ? (rest[0] as string | undefined) : (warning as Error)?.name;
    if (type === 'ExperimentalWarning' && SQLITE_WARNING_RE.test(msg)) {
      return; // suppressed
    }
    (originalEmit as (w: unknown, ...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

installSqliteWarningFilter();

import * as os from 'node:os';
import * as path from 'node:path';

if (!process.env['WRONGSTACK_HOME']) {
  process.env['WRONGSTACK_HOME'] = path.join(os.tmpdir(), `wstack-vitest-${process.pid}`);
}

// ── Mailbox has no in-process mode ────────────────────────────────────────
// `RemoteMailbox` used to sniff `VITEST`/`NODE_ENV` and silently hand back a
// filesystem mailbox. That is how the agent loop stayed on `_mailbox.jsonl`
// through the entire SQLite migration without a single test noticing: the
// suite was exercising a store production had already left behind.
//
// There is no env var to set here now. Tests reach the mailbox the way every
// process does — over IPC to the one detached owner for their project dir —
// or they construct `SqliteMailbox` directly when the storage layer itself is
// what is under test. Do not add a fallback back into this file.
