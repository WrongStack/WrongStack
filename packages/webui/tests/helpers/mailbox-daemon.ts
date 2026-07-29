/**
 * Teardown helpers for suites that drive a server which touches project state.
 *
 * Mirrors `packages/core/tests/helpers/mailbox-daemon.ts` and its CLI twin, but
 * reaches core through the published `@wrongstack/core/coordination` entry
 * point: a relative path into another package's sources drags core's `src/**`
 * into this package's test TypeScript project and trips TS6059 on every module
 * in the import chain.
 *
 * These suites never hold a mailbox themselves — the server resolves project
 * mailboxes on its own, deep inside the temp root — so the sweep enumerates
 * `<globalRoot>/projects/*` rather than taking a directory to close.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { MailboxProjectServerConnection } from '@wrongstack/core/coordination';

/**
 * Ask the detached mailbox owner for `projectDir` to exit. Safe when none runs.
 */
export async function disposeProjectMailbox(projectDir: string): Promise<void> {
  const control = new MailboxProjectServerConnection(projectDir);
  try {
    await control.shutdown('test-teardown');
  } catch {
    // No owner running, or it exited on its own — nothing to shut down.
  } finally {
    control.close();
  }
}

/** Shut down every project mailbox owner under a temp global root. */
export async function disposeProjectMailboxesUnder(globalRoot: string): Promise<void> {
  let dirs: string[];
  try {
    const projectsRoot = path.join(globalRoot, 'projects');
    dirs = (await fs.readdir(projectsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(projectsRoot, entry.name));
  } catch {
    return; // No project state was ever written under this root.
  }
  await Promise.all(dirs.map((dir) => disposeProjectMailbox(dir)));
}

/**
 * `fs.rm` options for a directory that held a SQLite store. `-wal`/`-shm` stay
 * mapped for a moment after the owning process exits.
 */
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 10, retryDelay: 50 } as const;

/**
 * Remove a temp root that held project-daemon state, without ever blocking the
 * teardown for longer than `deadlineMs`.
 *
 * `fs.rm`'s own retry loop is NOT time-bounded. On Windows every entry under a
 * directory something still holds retries independently, so one stuck handle
 * compounds across the tree and takes the 60 s hook timeout with it — the
 * assertions pass and the suite fails in teardown. Shutting the mailbox owner
 * down first is not a guarantee either: a project has five daemons (mailbox,
 * kanban, chronicle, sage, index) and each one's cwd is inside the tree.
 *
 * So bound it and give up quietly. A leftover directory under the OS temp dir
 * is swept eventually; failing an otherwise-green suite over one is not worth
 * it. Callers that genuinely need the directory gone should assert on it.
 */
export async function removeMailboxTempRoot(dir: string, deadlineMs = 5_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const giveUp = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deadlineMs);
    timer.unref?.();
  });
  try {
    await Promise.race([fs.rm(dir, RM_OPTIONS).catch(() => undefined), giveUp]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
