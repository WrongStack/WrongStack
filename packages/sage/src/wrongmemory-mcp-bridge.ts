/**
 * WM-407: WrongStack's project memory MCP endpoint when WrongMemory owns the
 * store.
 *
 * `wstack mcp serve sage` (and `wstack sage mcp`) are what MCP clients and
 * ACP workers launch for "the project's memory". With WrongMemory as the
 * owner they must not start WrongStack's own SAGE MCP server (a second owner
 * running with host authority). Instead they hand the client to
 * WrongMemory's own stdio bridge under a scoped `read-propose` grant:
 *
 *   wrongmemory --data-root <root> mcp --project <id> --grant <grant-id> --client <origin>
 *
 * Only ids appear in the arguments. The grant secret is written by the
 * daemon into the owner-private data root and never passes through here.
 * One grant per project, labelled {@link WRONGMEMORY_MCP_GRANT_LABEL}, is
 * reused while it is active and its secret file exists.
 */
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import {
  type ConnectOptions,
  grantSecretFile,
  METHODS,
  resolveDataRoot,
  WrongMemoryClient,
} from '@wrongstack/wrongmemory-client';
import type { SageServiceSelection } from './memory-backend.js';
import { type WrongMemoryClientLike, WrongMemoryPort } from './wrongmemory-port.js';

export const WRONGMEMORY_MCP_GRANT_LABEL = 'wrongstack-mcp';

interface GrantInfo {
  grantId: string;
  label: string;
  profile: string;
  projects: string[];
  expiresAtMs?: number | null;
  revokedAtMs?: number | null;
}

export interface WrongMemoryMcpLaunch {
  command: string;
  args: string[];
  projectId: string;
  grantId: string;
}

/** `wrongmemory` next to the configured daemon, next to this executable, or on PATH. */
export function wrongMemoryCliPath(service: SageServiceSelection | undefined): string {
  const exe = process.platform === 'win32' ? 'wrongmemory.exe' : 'wrongmemory';
  for (const dir of [
    service?.daemonPath ? path.dirname(service.daemonPath) : undefined,
    path.dirname(process.execPath),
  ]) {
    if (dir && existsSync(path.join(dir, exe))) return path.join(dir, exe);
  }
  return 'wrongmemory';
}

/**
 * Resolve the project (registering it in `wrongmemory` mode), find or create
 * the project's scoped MCP grant, and return the bridge command line.
 */
export async function prepareWrongMemoryMcpBridge(options: {
  projectRoot: string;
  service: SageServiceSelection | undefined;
  origin: string;
  connect?: ((options: ConnectOptions) => Promise<WrongMemoryClientLike>) | undefined;
  now?: () => number;
}): Promise<WrongMemoryMcpLaunch> {
  const service = options.service ?? {};
  const mode = service.mode === 'wrongmemory' ? 'wrongmemory' : 'auto';
  const port = new WrongMemoryPort({
    projectRoot: options.projectRoot,
    projectId: service.projectId,
    dataRoot: service.dataRoot,
    daemonPath: service.daemonPath,
    startPolicy: mode === 'auto' ? 'never' : (service.startPolicy ?? 'on-demand'),
    register: mode === 'wrongmemory',
    clientName: 'wrongstack-mcp-setup',
    connect: options.connect,
  });
  let projectId: string;
  try {
    await port.initialize();
    const project = port.getProject();
    if (!project) throw new Error('WrongMemory project not resolved');
    projectId = project.projectId;
  } finally {
    await port.dispose();
  }
  const root = resolveDataRoot(service.dataRoot);
  const connect = options.connect ?? ((o: ConnectOptions) => WrongMemoryClient.connect(o) as never);
  const client = await connect({
    dataRoot: service.dataRoot,
    start: false,
    clientName: 'wrongstack-mcp-setup',
  } as ConnectOptions);
  let grantId: string;
  try {
    const now = (options.now ?? Date.now)();
    const { grants } = await client.call<{ grants: GrantInfo[] }>(METHODS.GRANT_LIST, {});
    const reusable = grants.find(
      (g) =>
        g.label === WRONGMEMORY_MCP_GRANT_LABEL &&
        g.profile === 'read-propose' &&
        g.projects.length === 1 &&
        g.projects[0] === projectId &&
        !g.revokedAtMs &&
        (!g.expiresAtMs || g.expiresAtMs > now) &&
        existsSync(grantSecretFile(root, g.grantId)),
    );
    if (reusable) {
      grantId = reusable.grantId;
    } else {
      // The response carries the secret once; the daemon already stored it
      // owner-private, so it is dropped here, never logged or forwarded.
      const created = await client.call<{ grant: GrantInfo }>(METHODS.GRANT_CREATE, {
        label: WRONGMEMORY_MCP_GRANT_LABEL,
        profile: 'read-propose',
        projects: [projectId],
      });
      grantId = created.grant.grantId;
    }
  } finally {
    client.close();
  }
  return {
    command: wrongMemoryCliPath(service),
    args: [
      '--data-root',
      root,
      'mcp',
      '--project',
      projectId,
      '--grant',
      grantId,
      '--client',
      options.origin,
    ],
    projectId,
    grantId,
  };
}
