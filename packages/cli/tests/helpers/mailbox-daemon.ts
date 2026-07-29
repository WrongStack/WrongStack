/**
 * Teardown helper for CLI tests that touch a project mailbox.
 *
 * Mirrors `packages/core/tests/helpers/mailbox-daemon.ts`, but reaches core
 * through the published `@wrongstack/core/coordination` entry point instead of
 * a relative path into another package's sources — the latter drags core's
 * `src/**` into this package's test TypeScript project and trips TS6059
 * (`not under rootDir`) on every module in the import chain.
 *
 * The mailbox has one mode: a detached owner per project directory, reached
 * over IPC. A test that sends a single message therefore leaves a real daemon
 * running with the temp project dir as its cwd and an open handle on
 * `_mailbox.sqlite`. On Windows that makes the subsequent `fs.rm` fail with
 * EBUSY on the directory itself — the assertions pass and the teardown throws.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { MailboxProjectServerConnection } from '@wrongstack/core/coordination';

interface ClosableMailbox {
  close(): Promise<void>;
}

/**
 * Shut down the project mailbox owner for `projectDir`, plus any wrappers the
 * test holds. Safe to call when no owner is running.
 *
 * @param projectDir Project state directory (the one `resolveProjectDir`
 *   returns, not the project root).
 * @param wrappers Mailbox wrappers the test created; closed before the owner
 *   so their sockets do not keep `server.close()` waiting.
 */
export async function disposeProjectMailbox(
  projectDir: string,
  ...wrappers: ReadonlyArray<ClosableMailbox | null | undefined>
): Promise<void> {
  for (const wrapper of wrappers) {
    await wrapper?.close().catch(() => undefined);
  }
  const control = new MailboxProjectServerConnection(projectDir);
  try {
    await control.shutdown('test-teardown');
  } catch {
    // No owner running, or it exited on its own — nothing to shut down.
  } finally {
    control.close();
  }
}

/**
 * Shut down every project owner under a temp `WRONGSTACK_HOME`.
 *
 * For suites that drive a server (HQ, WebUI, the HTTP bridge) rather than a
 * mailbox directly: the project dirs are created on demand deep inside the
 * temp root and the test never names them, so there is nothing to pass to
 * {@link disposeProjectMailbox}. Enumerating `<globalRoot>/projects/*` finds
 * them all. Safe when the directory does not exist.
 */
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
 * `fs.rm` options for a directory that held a mailbox store. SQLite keeps
 * `-wal`/`-shm` mapped for a moment after the owning process exits, so the
 * unlink needs a short retry window even once the daemon is gone.
 */
export const MAILBOX_RM_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 50,
} as const;
