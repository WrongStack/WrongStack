/**
 * Service-level queries for `wstack sage service`: is a WrongMemory daemon
 * running, is this project registered there, and releasing it again.
 * Never starts a daemon.
 */
import * as path from 'node:path';
import { type ConnectOptions, METHODS, WrongMemoryClient } from '@wrongstack/wrongmemory-client';
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
