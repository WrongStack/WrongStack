/**
 * Service-level queries for `wstack sage service`: is a WrongMemory daemon
 * running, is this project registered there, and releasing it again.
 * Never starts a daemon.
 */
import * as path from 'node:path';
import { type ConnectOptions, METHODS, WrongMemoryClient } from '@wrongstack/wrongmemory-client';
import { sageServiceBackendFor } from './memory-service-registry.js';
import type { WrongMemoryClientLike } from './wrongmemory-port.js';

export interface WrongMemoryProjectInfo {
  projectId: string;
  storeKind?: string | undefined;
  admission?: string | undefined;
}

export interface WrongMemoryServiceProbe {
  running: boolean;
  project?: WrongMemoryProjectInfo | undefined;
}

type Connect = (options: ConnectOptions) => Promise<WrongMemoryClientLike>;

const defaultConnect: Connect = (o) => WrongMemoryClient.connect(o) as never;

function samePath(a: string, b: string): boolean {
  const n = (p: string) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

/** Whether a daemon answers on `dataRoot`, and this project's registration there. */
export async function probeWrongMemoryService(options: {
  projectRoot: string;
  dataRoot?: string | undefined;
  connect?: Connect | undefined;
}): Promise<WrongMemoryServiceProbe> {
  let client: WrongMemoryClientLike;
  try {
    client = await (options.connect ?? defaultConnect)({
      dataRoot: options.dataRoot,
      start: false,
      clientName: 'wrongstack-service',
    } as ConnectOptions);
  } catch {
    return { running: false };
  }
  try {
    const listed = await client.call<{
      projects: Array<{
        projectId: string;
        root?: string;
        storeKind?: string;
        admission?: string;
      }>;
    }>(METHODS.PROJECT_LIST, {});
    const p = listed.projects.find((x) => x.root && samePath(x.root, options.projectRoot));
    return {
      running: true,
      project: p
        ? { projectId: p.projectId, storeKind: p.storeKind, admission: p.admission }
        : undefined,
    };
  } finally {
    client.close();
  }
}

/**
 * Release a project in WrongMemory so local SAGE can open its store again:
 * a managed store is exported to the project first, an adopted one stays in
 * place.
 */
export async function releaseWrongMemoryProject(options: {
  project: WrongMemoryProjectInfo;
  dataRoot?: string | undefined;
  connect?: Connect | undefined;
}): Promise<void> {
  const client = await (options.connect ?? defaultConnect)({
    dataRoot: options.dataRoot,
    start: false,
    clientName: 'wrongstack-service',
  } as ConnectOptions);
  try {
    await client.call(
      options.project.storeKind === 'managed' ? METHODS.PROJECT_EXPORT : METHODS.PROJECT_DETACH,
      { projectId: options.project.projectId },
    );
  } finally {
    client.close();
  }
}

/** What a connection-health panel shows for a project WrongMemory serves. */
export interface WrongMemoryPanelHealth {
  status: 'healthy' | 'offline';
  mode: 'wrongmemory-service';
  detail: string;
}

/**
 * Panel health for SAGE when this process serves the project through
 * WrongMemory; `undefined` when the project uses local SAGE (the caller then
 * probes the local project server as before). Never starts a daemon.
 */
export async function wrongMemoryPanelHealth(
  projectRoot: string,
  connect?: Connect | undefined,
): Promise<WrongMemoryPanelHealth | undefined> {
  const chosen = sageServiceBackendFor(projectRoot);
  if (chosen?.backend !== 'wrongmemory') return undefined;
  const probe = await probeWrongMemoryService({
    projectRoot,
    dataRoot: chosen.dataRoot,
    connect,
  });
  if (!probe.running) {
    return {
      status: 'offline',
      mode: 'wrongmemory-service',
      detail: 'Served by WrongMemory; its daemon is not running and starts on demand.',
    };
  }
  if (!probe.project) {
    return {
      status: 'offline',
      mode: 'wrongmemory-service',
      detail: 'Served by WrongMemory; the project is registered on first use.',
    };
  }
  return {
    status: 'healthy',
    mode: 'wrongmemory-service',
    detail: `Served by WrongMemory: project ${probe.project.projectId} (${probe.project.storeKind ?? 'store'}, ${probe.project.admission ?? 'access unknown'}).`,
  };
}

/** The refusal a SAGE restart/shutdown action returns for a WrongMemory project. */
export function wrongMemoryServiceActionRefusal(projectRoot: string): string | undefined {
  return sageServiceBackendFor(projectRoot)?.backend === 'wrongmemory'
    ? 'SAGE memory is served by the WrongMemory service here, not the local SAGE server; manage it with `wstack sage service` or `wrongmemory daemon`.'
    : undefined;
}
