/**
 * Shared loopback HTTP `ProjectMcpGateway` for ACP workers spawned by `MultiAgentHost`.
 *
 * Mirrors `wrongforge-gateway.ts`: started lazily once per process on `127.0.0.1`
 * with an ephemeral port, serving per-worker isolated MCP servers behind single-use
 * bearer grants. When an ACP client advertises `mcpCapabilities.http`, WrongStack's
 * `filterMcpServers()` picks these zero-subprocess HTTP endpoints automatically;
 * stdio-only clients seamlessly fall back to `wstack mcp serve <name>`.
 */
import { createCodebaseIndexMcpServer } from '@wrongstack/codebase-index-mcp';
import {
  createProjectMailbox,
  MailboxEventEmitter,
  resolveProjectDir,
} from '@wrongstack/coordination';
import { canonicalProjectRoot, wstackGlobalRoot } from '@wrongstack/core/utils';
import type { AcpProjectMcpGrantRequest, AcpProjectMcpGrantResult } from '@wrongstack/fleet';
import { createKanbanMcpServer } from '@wrongstack/kanban-mcp';
import { createMailboxMcpServer } from '@wrongstack/mailbox-mcp';
import { type MCPServer, ProjectMcpGateway } from '@wrongstack/mcp';
import { createRequirementIntakeMcpServer } from '@wrongstack/requirement-intake-mcp';
import { ProjectSageMemoryPort } from '@wrongstack/sage';
import { createAttachedSageMcp } from '@wrongstack/sage-mcp';

let sharedGatewayPromise: Promise<ProjectMcpGateway> | undefined;

async function ensureGateway(): Promise<ProjectMcpGateway> {
  if (sharedGatewayPromise) return sharedGatewayPromise;
  const starting = ProjectMcpGateway.start({ host: '127.0.0.1', port: 0 });
  sharedGatewayPromise = starting;
  starting.catch(() => {
    if (sharedGatewayPromise === starting) sharedGatewayPromise = undefined;
  });
  return starting;
}

/** Tear down the shared loopback gateway (for clean process exit or tests). */
export async function closeSharedAcpProjectMcpGateway(): Promise<void> {
  const pending = sharedGatewayPromise;
  sharedGatewayPromise = undefined;
  if (!pending) return;
  try {
    const gw = await pending;
    await gw.close();
  } catch {
    // best-effort shutdown
  }
}

/**
 * Mint a per-worker bearer grant on the shared `ProjectMcpGateway`.
 *
 * Every requested service is initialized fail-open: if a project daemon
 * (e.g. Mailbox or SAGE) is unavailable, that service is omitted from the HTTP
 * grant and the ACP client's `filterMcpServers()` automatically falls back to
 * its stdio descriptor.
 */
export async function sharedAcpProjectMcpGateway(
  req: AcpProjectMcpGrantRequest,
): Promise<AcpProjectMcpGrantResult | undefined> {
  if (req.servers.length === 0) return undefined;

  const gateway = await ensureGateway();
  const canonicalRoot = canonicalProjectRoot(req.projectRoot);
  const services: Record<string, MCPServer> = {};
  const cleanups: Array<() => void | Promise<void>> = [];

  for (const service of req.servers) {
    try {
      switch (service) {
        case 'codebase-index': {
          // Worktree-aware: each linked worktree keeps its own symbol index.
          const indexRoot = req.worktreeCwd ?? req.projectRoot;
          services['wrongstack-index'] = createCodebaseIndexMcpServer(indexRoot, {
            writable: false,
          });
          break;
        }
        case 'kanban': {
          services['wrongstack-kanban'] = createKanbanMcpServer(canonicalRoot, {
            actor: req.actor,
            ...(req.sessionId ? { sessionId: req.sessionId } : {}),
            writable: true,
          });
          break;
        }
        case 'requirement-intake': {
          services['wrongstack-intake'] = createRequirementIntakeMcpServer(canonicalRoot, {
            actor: req.actor,
            writable: true,
          });
          break;
        }
        case 'sage': {
          const port = new ProjectSageMemoryPort({
            projectRoot: canonicalRoot,
            spawnIfMissing: process.env['WRONGSTACK_SAGE_SPAWN_IF_MISSING'] === '1',
            clientId: `acp-gw-sage-${req.actor}-${process.pid}`,
          });
          const attached = createAttachedSageMcp(port, {
            projectRoot: canonicalRoot,
            origin: req.actor,
          });
          services['wrongstack-sage'] = attached.server;
          cleanups.push(async () => {
            attached.dispose();
            await port.dispose();
          });
          break;
        }
        case 'mailbox': {
          const projectDir = resolveProjectDir(canonicalRoot, wstackGlobalRoot());
          const emitter = new MailboxEventEmitter();
          const mailbox = createProjectMailbox({ projectDir, eventEmitter: emitter });
          await mailbox.initialize();
          services['wrongstack-mailbox'] = createMailboxMcpServer(mailbox, emitter, {
            actor: req.actor,
            ...(req.sessionId ? { sessionId: req.sessionId } : {}),
            ...(req.role ? { actorRole: req.role } : {}),
            writable: true,
          });
          cleanups.push(async () => {
            await mailbox.close();
          });
          break;
        }
      }
    } catch {
      // Fail-open per service: omitted services retain their stdio fallback.
    }
  }

  if (Object.keys(services).length === 0) return undefined;

  let grant: ReturnType<ProjectMcpGateway['registerGrant']>;
  try {
    grant = gateway.registerGrant({
      actor: req.actor,
      sessionId: req.sessionId,
      role: req.role,
      worktreeCwd: req.worktreeCwd,
      services,
    });
  } catch {
    // F107: the shared gateway can close mid-initialization (process
    // shutdown racing a starting worker). Release the services already
    // initialized — the mailbox and SAGE port would otherwise leak — and
    // fail open to the stdio fallback, the documented contract for
    // unavailable HTTP services.
    for (const fn of cleanups) {
      await Promise.resolve(fn()).catch(() => undefined);
    }
    return undefined;
  }

  return {
    mcpServers: grant.mcpServers,
    revoke: async () => {
      grant.revoke();
      for (const fn of cleanups) {
        await Promise.resolve(fn()).catch(() => undefined);
      }
    },
  };
}
