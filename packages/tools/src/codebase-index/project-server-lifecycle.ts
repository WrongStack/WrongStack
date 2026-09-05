import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { restrictFilePermissions } from '@wrongstack/core/security';
import { atomicWrite } from '@wrongstack/persistence';
import type { ProjectIndexServerMetadata } from './project-server-protocol.js';

export function removeMetadataIfOwned(metadataPath: string, pid: number): void {
  try {
    const current = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as { pid?: number };
    if (current.pid === pid) fs.rmSync(metadataPath, { force: true });
  } catch {
    /* absent or owned by a successor */
  }
}

export async function writeProjectServerMetadata(
  metadataPath: string,
  metadata: ProjectIndexServerMetadata,
): Promise<void> {
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  // The token lives ONLY in this owner-only file, never on the wire (WS-027).
  // WS-059: atomicWrite replaces in place with bounded retry and never unlinks
  await atomicWrite(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  // Restrict file permissions on POSIX and Windows (strips inherited ACEs)
  await restrictFilePermissions(metadataPath, {
    label: 'codebase-index-metadata',
    warn: (message: string) => process.stderr.write(`${message}\n`),
  });
}

/**
 * One SIGINT/SIGTERM pair per PROCESS, not per module instance.
 *
 * The in-process test harness imports this module once per test case with a
 * `?case=<n>` query URL, so every case evaluates this module body fresh; a
 * bare top-level `process.once(signal, ...)` pair accumulates one handler
 * per case until Node raises MaxListenersExceededWarning in every coverage
 * run. The guard lives on globalThis under a Symbol.for key: the first
 * evaluation registers the pair, every evaluation re-targets it at its own
 * `stop`, and a fired signal removes the pair (once semantics).
 */
export interface CodebaseIndexSignalGuard {
  arm(stop: (signal: string) => Promise<void>): void;
}

export const SIGNAL_GUARD: unique symbol = Symbol.for(
  'wrongstack.codebase-index.project-server.signalGuard',
);

export function armCodebaseIndexSignalGuard(stop: (signal: string) => Promise<void>): void {
  const signalGuardStore = globalThis as typeof globalThis & {
    [SIGNAL_GUARD]?: CodebaseIndexSignalGuard | undefined;
  };
  let guard = signalGuardStore[SIGNAL_GUARD];
  if (!guard) {
    let current: (signal: string) => Promise<void> = async () => undefined;
    let armed = false;
    const handlers = new Map<string, () => void>();
    const disarm = (): void => {
      if (!armed) return;
      armed = false;
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
      handlers.clear();
    };
    guard = {
      arm(next) {
        current = next;
        if (armed) return;
        armed = true;
        for (const signal of ['SIGINT', 'SIGTERM'] as const) {
          const handler = (): void => {
            disarm();
            void current(signal);
          };
          handlers.set(signal, handler);
          process.on(signal, handler);
        }
      },
    };
    signalGuardStore[SIGNAL_GUARD] = guard;
  }
  guard.arm(stop);
}
