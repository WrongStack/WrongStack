/**
 * SAGE MCP for external coding agents, attached to a running WrongStack.
 *
 * `wstack sage mcp` runs this over stdio for Claude Code, Codex, Cursor,
 * Antigravity or any MCP client. It differs from the standalone
 * `wstack-sage-mcp` binary in three ways, all on purpose:
 *
 * - **Attach-only.** It never spawns the SAGE daemon. Memory is served while a
 *   WrongStack host has the project open; otherwise every call answers with
 *   `SageProjectServerNotRunningError` and the next call tries again. Startup
 *   never fails on a missing daemon — a client marks a server that exits at
 *   launch as broken and stops calling it.
 * - **Releases the socket when idle.** An open socket counts as a daemon
 *   client, so holding it would keep the daemon alive long after every
 *   WrongStack host left. After `idleReleaseMs` without calls the socket is
 *   dropped; the next call reconnects.
 * - **Read + propose.** The read tools plus `memory_candidates` narrowed to
 *   `list`/`propose`, stamped with the caller's name.
 */
import type { MemoryPort } from '@wrongstack/contracts/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { MCPServer, type MCPServerToolHost, serveStdio } from '@wrongstack/mcp';
import { ProjectSageMemoryPort } from '@wrongstack/sage';
import { createSageMcpToolHost } from './adapter.js';
import { SAGE_MCP_INSTRUCTIONS } from './usage-guide.js';
import { SERVER_INFO } from './version.js';

export const DEFAULT_IDLE_RELEASE_MS = 30_000;

export interface AttachedSageMcpOptions {
  projectRoot: string;
  /**
   * `Sage.storage.directory` from the project's config. Part of the daemon's
   * endpoint name, so it must match what the WrongStack host passes or the
   * bridge looks for a daemon nobody runs.
   */
  directory?: string | undefined;
  /** Caller name stamped on proposals (`claude-code`, `codex`, ...). */
  origin?: string | undefined;
  idleReleaseMs?: number | undefined;
  log?: ((line: string) => void) | undefined;
  /** Test seams. */
  stdin?: NodeJS.ReadableStream | undefined;
  stdout?: NodeJS.WritableStream | undefined;
}

/** The pieces `serveAttachedSageMcpStdio` runs; exported for tests. */
export function createAttachedSageMcp(
  port: MemoryPort & Pick<ProjectSageMemoryPort, 'releaseConnection'>,
  opts: Pick<AttachedSageMcpOptions, 'projectRoot' | 'origin' | 'idleReleaseMs'>,
): { server: MCPServer; host: MCPServerToolHost; dispose(): void } {
  const inner = createSageMcpToolHost(port, {
    projectRoot: opts.projectRoot,
    proposals: true,
    origin: opts.origin,
  });
  const idleMs = opts.idleReleaseMs ?? DEFAULT_IDLE_RELEASE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = 0;
  let disposed = false;
  const armRelease = () => {
    if (disposed || inFlight > 0) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!disposed && inFlight === 0) port.releaseConnection();
    }, idleMs);
    timer.unref?.();
  };

  const host: MCPServerToolHost = {
    listTools: () => inner.listTools(),
    async callTool(name, args, callOptions) {
      if (timer) clearTimeout(timer);
      inFlight++;
      try {
        return await inner.callTool(name, args, callOptions);
      } finally {
        inFlight--;
        armRelease();
      }
    },
  };
  const server = new MCPServer({
    host,
    serverInfo: { name: 'wrongstack-sage', version: SERVER_INFO.version },
    instructions: SAGE_MCP_INSTRUCTIONS,
  });
  return {
    server,
    host,
    dispose: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

export async function serveAttachedSageMcpStdio(opts: AttachedSageMcpOptions): Promise<void> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const port = new ProjectSageMemoryPort({
    projectRoot: opts.projectRoot,
    ...(opts.directory ? { directory: opts.directory } : {}),
    spawnIfMissing: false,
    clientId: `sage-mcp-${opts.origin ?? 'client'}-${process.pid}`,
  });
  const attached = createAttachedSageMcp(port, opts);
  try {
    // One probe so the client's server log says whether memory is live. Never
    // fatal: WrongStack may simply be opened after the client started.
    try {
      await port.initialize();
      log(`wrongstack-sage: attached to the SAGE daemon for ${opts.projectRoot}`);
    } catch (error) {
      log(`wrongstack-sage: ${toErrorMessage(error)} Serving anyway; calls retry.`);
    }
    port.releaseConnection();
    const handle = serveStdio(attached.server, {
      ...(opts.stdin ? { stdin: opts.stdin } : {}),
      ...(opts.stdout ? { stdout: opts.stdout } : {}),
    });
    await handle.done;
  } finally {
    attached.dispose();
    await port.dispose();
  }
}
