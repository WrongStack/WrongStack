/**
 * WM-107: cooperative handoff of a project's SAGE store from WrongStack's
 * in-process owner (the SAGE project server) to the WrongMemory service.
 *
 * Operator-initiated only (`wstack sage handoff --yes`): adopting a live store
 * is a separately requested step. The sequence:
 *
 *  0. Connect to WrongMemory, starting the daemon unless
 *     `Sage.service.startPolicy` is `never`. Failing here changes nothing.
 *  1. If a SAGE project server runs for the project, ask it to stop through
 *     its authenticated `shutdown` (the token is read from the owner-only
 *     `server.json`) and wait until it no longer answers.
 *  2. Register the project in WrongMemory as `adopted` with write ownership.
 *     `forceOwner` is sent only when `server.json` is still on disk after the
 *     server was verified gone (a crashed owner leaves it behind).
 *  3. Open the store in the daemon so it takes the OS owner lock. From then on
 *     SAGE refuses to open the store (`SageStoreOwnedByWrongMemoryError`).
 *
 * Without `apply` nothing changes: the result is the plan.
 */
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { type ConnectOptions, METHODS, WrongMemoryClient } from '@wrongstack/wrongmemory-client';
import type { SageServiceSelection } from './memory-backend.js';
import { DEFAULT_SAGE_DIR } from './paths.js';
import { SageProjectServerConnection } from './project-server-client.js';
import { sageProjectServerMetadataPath } from './project-server-endpoint.js';
import { wrongMemoryOwnsStore } from './wrongmemory-owner-guard.js';
import type { WrongMemoryClientLike } from './wrongmemory-port.js';

export interface SageHandoffReport {
  projectRoot: string;
  storePath: string;
  applied: boolean;
  /** The local SAGE project server answered when the handoff started. */
  localServerRunning: boolean;
  localServerStopped: boolean;
  projectId?: string | undefined;
  admission?: string | undefined;
  /** WrongMemory holds the owner lock (local SAGE will refuse the store). */
  ownerLocked: boolean;
  steps: string[];
}

/** The local owner: the SAGE project server's control surface (injectable for tests). */
export interface LocalSageOwner {
  status(): Promise<unknown | null>;
  shutdown(reason?: string): Promise<{ stopped: boolean; reason?: string | undefined }>;
}

export async function handOffSageToWrongMemory(options: {
  projectRoot: string;
  directory?: string | undefined;
  service: SageServiceSelection | undefined;
  apply: boolean;
  connect?: ((options: ConnectOptions) => Promise<WrongMemoryClientLike>) | undefined;
  local?: LocalSageOwner | undefined;
  waitMs?: number | undefined;
}): Promise<SageHandoffReport> {
  const directory = options.directory ?? DEFAULT_SAGE_DIR;
  if (path.normalize(directory) !== path.normalize(DEFAULT_SAGE_DIR)) {
    throw new Error(
      `WrongMemory adopts the store at ${DEFAULT_SAGE_DIR}/sage.db; Sage.storage.directory "${directory}" is not supported for a handoff.`,
    );
  }
  const storeDir = path.join(path.resolve(options.projectRoot), DEFAULT_SAGE_DIR);
  const storePath = path.join(storeDir, 'sage.db');
  if (!existsSync(storePath)) throw new Error(`no SAGE store at ${storePath}`);
  const local =
    options.local ??
    new SageProjectServerConnection(options.projectRoot, options.directory, {
      spawnIfMissing: false,
    });
  const steps: string[] = [];
  const running = (await local.status()) !== null;
  const report: SageHandoffReport = {
    projectRoot: options.projectRoot,
    storePath,
    applied: false,
    localServerRunning: running,
    localServerStopped: false,
    ownerLocked: wrongMemoryOwnsStore(storeDir),
    steps,
  };
  steps.push(
    running
      ? 'stop the running SAGE project server for this project (authenticated shutdown)'
      : 'no SAGE project server is running for this project',
    'register the project in WrongMemory as an adopted store with write ownership',
    'open the store in the daemon so it holds the owner lock (local SAGE then refuses the store)',
    'set Sage.service.mode to "wrongmemory" in your user or profile configuration (repo configuration may not select the memory service)',
  );
  if (!options.apply) return report;

  // Reach WrongMemory first, starting the daemon as `Sage.service` allows, so
  // an unreachable service leaves the local owner running and nothing changed.
  const service = options.service ?? {};
  const connect = options.connect ?? ((o: ConnectOptions) => WrongMemoryClient.connect(o) as never);
  const client = await connect({
    dataRoot: service.dataRoot,
    start: service.startPolicy !== 'never',
    ...(service.daemonPath ? { daemonPath: service.daemonPath } : {}),
    clientName: 'wrongstack-handoff',
  } as ConnectOptions);
  if (running) {
    try {
      const stop = await local.shutdown('handoff-to-wrongmemory');
      if (!stop.stopped) throw new Error(`the SAGE project server did not stop: ${stop.reason}`);
      const deadline = Date.now() + (options.waitMs ?? 10_000);
      while ((await local.status()) !== null) {
        if (Date.now() > deadline) throw new Error('the SAGE project server is still answering');
        await new Promise((r) => setTimeout(r, 200));
      }
    } catch (error) {
      client.close();
      throw error;
    }
    report.localServerStopped = true;
  }
  try {
    const leftover = existsSync(
      sageProjectServerMetadataPath(options.projectRoot, options.directory),
    );
    const registered = await client.call<{
      project: { projectId: string; admission: string };
    }>(METHODS.PROJECT_REGISTER, {
      root: path.resolve(options.projectRoot),
      storeKind: 'adopted',
      write: true,
      // Only after the local owner was verified gone (or never ran).
      ...(leftover ? { forceOwner: true } : {}),
    });
    report.projectId = registered.project.projectId;
    report.admission = registered.project.admission;
    // Opening the store takes the owner lock.
    await client.call(METHODS.MEMORY_STATS, {}, { projectId: registered.project.projectId });
  } finally {
    client.close();
  }
  report.ownerLocked = wrongMemoryOwnsStore(storeDir);
  report.applied = true;
  return report;
}
