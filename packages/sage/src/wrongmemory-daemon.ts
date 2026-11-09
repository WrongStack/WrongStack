/**
 * WrongMemory daemon lifecycle: project resolution, reachability probe and
 * on-demand daemon start (see {@link startWrongMemoryDaemon}).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { buildChildEnv } from '@wrongstack/core/utils';
import {
  type ConnectOptions,
  METHODS,
  type ProjectInfo,
  resolveDataRoot,
  WrongMemoryClient,
  WrongMemoryError,
} from '@wrongstack/wrongmemory-client';
import { findWrongMemoryBinary } from './wrongmemory-binaries.js';
import {
  type WrongMemoryClientLike,
  WrongMemoryProjectNotRegisteredError,
} from './wrongmemory-errors.js';
import { compact, normalizeRoot } from './wrongmemory-wire.js';

/**
 * Locate (or, with `register`, create) the WrongMemory project for a root.
 * An explicit `projectId` wins. A root that already holds a project-local
 * SAGE store is registered as `adopted` (the daemon refuses a second
 * authoritative `managed` store for it); otherwise `managed`.
 */
export async function resolveWrongMemoryProject(
  client: WrongMemoryClientLike,
  options: { projectRoot: string; projectId?: string | undefined; register: boolean },
): Promise<ProjectInfo> {
  if (options.projectId) {
    return client.call<ProjectInfo>(METHODS.PROJECT_GET, {}, { projectId: options.projectId });
  }
  const want = normalizeRoot(options.projectRoot);
  const { projects } = await client.call<{ projects: ProjectInfo[] }>(METHODS.PROJECT_LIST, {});
  const found = projects.find((p) => normalizeRoot(p.root) === want);
  if (found) return found;
  if (!options.register) throw new WrongMemoryProjectNotRegisteredError(options.projectRoot);
  const localStore = path.join(options.projectRoot, '.wrongstack', 'memories', 'sage.db');
  const storeKind = existsSync(localStore) ? 'adopted' : 'managed';
  const result = await client.call<{ project: ProjectInfo }>(METHODS.PROJECT_REGISTER, {
    root: options.projectRoot,
    storeKind,
    write: true,
  });
  return result.project;
}

/**
 * `auto` probe: a daemon is reachable (never started) AND the root is
 * already registered. Returns the project, or `undefined` for either miss.
 */
export async function probeWrongMemoryProject(options: {
  projectRoot: string;
  projectId?: string | undefined;
  dataRoot?: string | undefined;
  timeoutMs?: number | undefined;
  connect?: ((options: ConnectOptions) => Promise<WrongMemoryClientLike>) | undefined;
}): Promise<ProjectInfo | undefined> {
  const connect = options.connect ?? ((o: ConnectOptions) => WrongMemoryClient.connect(o));
  let client: WrongMemoryClientLike;
  try {
    client = await connect(
      compact({
        dataRoot: options.dataRoot,
        start: false,
        clientName: 'wrongstack-probe',
        timeoutMs: options.timeoutMs ?? 1_500,
      }) as ConnectOptions,
    );
  } catch {
    return undefined;
  }
  try {
    return await resolveWrongMemoryProject(client, {
      projectRoot: options.projectRoot,
      projectId: options.projectId,
      register: false,
    });
  } catch {
    return undefined;
  } finally {
    client.close();
  }
}

export interface StartDaemonOptions {
  dataRoot?: string | undefined;
  daemonPath?: string | undefined;
  /** Attach attempt (never starts). */
  connect: () => Promise<WrongMemoryClientLike>;
  readyTimeoutMs?: number | undefined;
}

/**
 * Start `wrongmemoryd --data-root <root>` with a sanitized environment
 * ({@link buildChildEnv}: no provider keys or vault passphrase), through the
 * WrongMemory CLI when it sits next to the daemon, and wait until it accepts
 * a connection.
 */
export async function startWrongMemoryDaemon(
  options: StartDaemonOptions,
): Promise<WrongMemoryClientLike> {
  const exe = options.daemonPath ?? findWrongMemoryBinary('daemon')?.path;
  if (!exe || !existsSync(exe)) {
    throw new WrongMemoryError(
      'UNAVAILABLE',
      exe
        ? `daemon executable not found: ${exe}`
        : 'WrongMemory is not installed (no wrongmemoryd found); run `wstack sage service install`',
    );
  }
  const dataRoot = resolveDataRoot(options.dataRoot);
  const deadline = Date.now() + (options.readyTimeoutMs ?? 15_000);
  let spawnError: unknown;
  const cli = path.join(
    path.dirname(exe),
    process.platform === 'win32' ? 'wrongmemory.exe' : 'wrongmemory',
  );
  if (existsSync(cli)) {
    // The WrongMemory CLI starts the daemon outside the caller's job object
    // and without inherited handles. A Node `detached` spawn stays in the
    // job, so a tool's process-tree cleanup could take the shared daemon
    // down with it; a daemon gone that way also releases its owner lock.
    // The CLI returns once the daemon answers; it is awaited so that no
    // starter outlives this call and restarts a daemon stopped since.
    const starter = spawn(cli, ['--data-root', dataRoot, 'daemon', 'start'], {
      stdio: 'ignore',
      windowsHide: true,
      env: buildChildEnv(),
    });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        starter.unref();
        resolve();
      }, deadline - Date.now());
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      starter.once('exit', done);
      starter.once('error', done);
    });
  } else {
    const child = spawn(exe, ['--data-root', dataRoot], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: buildChildEnv(),
    });
    // `exe` passed the existence check, but the spawn can still fail (a
    // directory, or a binary removed in between). Without a listener that
    // surfaces as an unhandled ChildProcess 'error' and takes the host process
    // down; the readiness loop below reports the failure instead.
    child.once('error', (error) => {
      spawnError = error;
    });
    child.unref();
  }
  let last: unknown;
  do {
    try {
      return await options.connect();
    } catch (error) {
      last = error;
      await new Promise((r) => setTimeout(r, 100));
    }
  } while (Date.now() < deadline);
  const failure =
    spawnError instanceof Error
      ? spawnError.message
      : last instanceof Error
        ? last.message
        : String(last);
  throw new WrongMemoryError('UNAVAILABLE', `daemon did not become ready: ${failure}`);
}
