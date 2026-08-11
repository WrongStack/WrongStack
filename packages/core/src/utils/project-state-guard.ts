import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ensureProjectGitignore } from './project-identity.js';

const PROJECT_STATE_DIRECTORY = '.wrongstack';
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const REPAIR_DEBOUNCE_MS = 25;

export interface ProjectStateGuard {
  readonly directory: string;
  close(): void;
}

export interface ProjectStateGuardOptions {
  /** Fallback for platforms/filesystems that drop watch events. */
  pollIntervalMs?: number | undefined;
  onError?: ((error: unknown) => void) | undefined;
}

interface ActiveGuardSlot {
  guard?: ProjectStateGuard | undefined;
  root?: string | undefined;
}

const ACTIVE_GUARD_KEY = Symbol.for('wrongstack.activeProjectStateGuard');
const globalScope = globalThis as { [ACTIVE_GUARD_KEY]?: ActiveGuardSlot };
globalScope[ACTIVE_GUARD_KEY] ??= {};
const activeGuard = globalScope[ACTIVE_GUARD_KEY];

function normalizedRoot(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function concernsProjectState(filename: string | Buffer | null): boolean {
  if (filename === null) return true;
  const firstSegment = String(filename).replaceAll('\\', '/').split('/')[0];
  return firstSegment?.toLowerCase() === PROJECT_STATE_DIRECTORY;
}

/**
 * Keep the active project's state directory present for the lifetime of a
 * runtime. The root watcher repairs direct deletion immediately; an unref'ed
 * poll covers filesystems where watch events are lossy or unsupported.
 */
export async function startProjectStateGuard(
  projectRoot: string,
  options: ProjectStateGuardOptions = {},
): Promise<ProjectStateGuard> {
  const root = path.resolve(projectRoot);
  const directory = path.join(root, PROJECT_STATE_DIRECTORY);
  const pollIntervalMs = Math.max(25, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  let closed = false;
  let repairPending = false;
  let repairInFlight: Promise<void> | undefined;
  let repairTimer: NodeJS.Timeout | undefined;

  const ensureDirectory = async (): Promise<void> => {
    await fsp.mkdir(directory, { recursive: true });
  };

  const ensureInvariant = async (): Promise<void> => {
    await ensureDirectory();
    try {
      await ensureProjectGitignore(root);
    } catch (error) {
      // A temporarily locked .gitignore must not take down the runtime. The
      // watcher/poll retries while the directory invariant stays intact.
      options.onError?.(error);
    }
  };

  const scheduleRepair = (): void => {
    if (closed) return;
    repairPending = true;
    if (repairInFlight || repairTimer) return;

    // A short delay distinguishes removal of `.wrongstack` from recursive
    // removal of the entire project root. It also collapses the rename burst
    // emitted by Windows into one idempotent repair.
    repairTimer = setTimeout(() => {
      repairTimer = undefined;
      repairInFlight = (async () => {
        while (!closed && repairPending) {
          repairPending = false;
          try {
            const rootState = await fsp.stat(root).catch(() => undefined);
            if (!rootState?.isDirectory()) return;
            await ensureInvariant();
          } catch (error) {
            options.onError?.(error);
          }
        }
      })().finally(() => {
        repairInFlight = undefined;
        if (repairPending && !closed) scheduleRepair();
      });
    }, REPAIR_DEBOUNCE_MS);
    repairTimer.unref?.();
  };

  // Fail activation when the invariant cannot be established initially. A
  // live runtime must not start with a known-broken project state directory.
  await ensureDirectory();
  await ensureProjectGitignore(root).catch((error) => options.onError?.(error));

  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(root, { persistent: false }, (_eventType, filename) => {
      if (concernsProjectState(filename) || String(filename).toLowerCase() === '.gitignore') {
        scheduleRepair();
      }
    });
    watcher.on('error', (error) => {
      options.onError?.(error);
      watcher = undefined;
      scheduleRepair();
    });
  } catch (error) {
    // The poll below remains authoritative when the native watcher is not
    // available (notably some network filesystems).
    options.onError?.(error);
  }

  const poll = setInterval(scheduleRepair, pollIntervalMs);
  poll.unref?.();

  return {
    directory,
    close() {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      if (repairTimer) clearTimeout(repairTimer);
      repairTimer = undefined;
      try {
        watcher?.close();
      } catch {
        // Watchers can close themselves after an async error.
      }
      watcher = undefined;
    },
  };
}

/**
 * Activate the process-wide guard for one project. Switching projects closes
 * the previous guard only after the next directory has been established.
 */
export async function activateProjectStateGuard(
  projectRoot: string,
  options: ProjectStateGuardOptions = {},
): Promise<ProjectStateGuard> {
  const root = normalizedRoot(projectRoot);
  if (activeGuard.root === root && activeGuard.guard) return activeGuard.guard;

  const next = await startProjectStateGuard(projectRoot, options);
  const previous = activeGuard.guard;
  activeGuard.root = root;
  activeGuard.guard = next;
  previous?.close();
  return next;
}
