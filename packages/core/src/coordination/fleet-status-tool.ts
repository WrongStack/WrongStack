/**
 * fleet-status-tool — read-only live peer snapshot for any agent.
 *
 * The pull half of peer awareness (the push half is the fleet-pulse
 * digest): any agent — leader or fleet subagent — can ask "who else is
 * working on this project right now, and on what?" before starting work
 * that might overlap, or when deciding whether to wait or proceed.
 *
 * Data source: the project mailbox registry (`getAgentStatuses`), which is
 * cross-process by construction. When the host passes `getLocalAgents`
 * (an AgentStatusTracker view), same-process entries are enriched with the
 * richer live fields the registry doesn't carry (ctxPct, costUsd,
 * partialText tail).
 *
 * @module fleet-status-tool
 */

import type { EventBus } from '../kernel/events.js';
import type { Context } from '../core/context.js';
import type { AgentEntry } from '../session-catalog/session-registry.js';
import type { Tool } from '../types/tool.js';
import { ToolCapabilities } from '../security/capabilities.js';
import { getSharedProjectMailbox } from './remote-mailbox.js';
import {
  defaultResolveProjectDir,
  resolveMailboxIdentity,
  type MailboxResolver,
} from './mailbox-tool.js';
import type { Mailbox } from './mailbox-types.js';

export interface FleetStatusToolOptions {
  /** How to obtain a Mailbox given the execution Context (tests). */
  resolveMailbox?: MailboxResolver | undefined;
  /** Project dir for the shared mailbox. Prefer wpaths.projectDir. */
  projectDir?: string | undefined;
  /** EventBus for mailbox registration surface events. */
  events?: EventBus | undefined;
  /**
   * Same-process rich agent state (AgentStatusTracker snapshot). Merged
   * into registry rows by name when provided — cross-process peers keep
   * registry-only fields.
   */
  getLocalAgents?: (() => AgentEntry[]) | undefined;
}

const TASK_SNIPPET_CHARS = 120;

function snippet(s: string | undefined): string | undefined {
  if (!s) return undefined;
  return s.length > TASK_SNIPPET_CHARS ? `${s.slice(0, TASK_SNIPPET_CHARS)}…` : s;
}

export function makeFleetStatusTool(opts: FleetStatusToolOptions = {}): Tool {
  const resolveMailbox: MailboxResolver =
    opts.resolveMailbox ??
    ((ctx: Context) =>
      getSharedProjectMailbox(opts.projectDir ?? defaultResolveProjectDir(ctx), opts.events));
  return {
    name: 'fleet_status',
    description:
      'Live snapshot of every agent working on this canonical project (all clients, processes, ' +
      'sessions, branches, and linked Git worktrees): who is online, what task each is on, which tool is running, ' +
      'and progress counters. Check it before starting work that might overlap with a peer, ' +
      'when deciding whether to wait for someone or proceed, or when a task mentions ' +
      'another agent. Read-only. Same-session talk: session_note with the returned id. ' +
      'Durable cross-session mail: mail_send.',
    usageHint: 'fleet_status  (optionally: onlineOnly=false to include recently-offline agents)',
    category: 'Coordination',
    permission: 'auto',
    mutating: false,
    capabilities: [ToolCapabilities.COORDINATION_FLEET_READ],
    inputSchema: {
      type: 'object',
      properties: {
        onlineOnly: {
          type: 'boolean',
          description: 'Only agents with a live heartbeat (default true).',
        },
      },
    },
    async execute(input: unknown, ctx: Context) {
      const i = (input ?? {}) as Record<string, unknown>;
      const onlineOnly = (i.onlineOnly as boolean | undefined) ?? true;
      const mb: Mailbox = resolveMailbox(ctx);
      const identity = resolveMailboxIdentity(ctx);
      // Register + heartbeat so this agent shows up in ITS peers' views too.
      try {
        await mb.registerAgent({
          agentId: identity.callerId,
          sessionId: identity.sessionId,
          name: identity.name,
          role: identity.role,
          pid: process.pid,
          source: (ctx.meta['source'] as 'cli' | 'webui' | undefined) ?? 'cli',
        });
        await mb.heartbeat({ agentId: identity.callerId });
      } catch {
        /* best-effort */
      }

      const statuses = await mb.getAgentStatuses().catch(() => []);
      const local = new Map<string, AgentEntry>();
      try {
        for (const e of opts.getLocalAgents?.() ?? []) local.set(e.name, e);
      } catch {
        /* enrichment is optional */
      }

      const rows = statuses
        .filter((s) => (onlineOnly ? s.online : true))
        .map((s) => {
          const rich = local.get(s.name);
          return {
            id: s.agentId,
            name: s.name,
            role: s.role,
            you: s.agentId === identity.callerId,
            status: s.status,
            online: s.online,
            currentTask: snippet(s.currentTask),
            currentTool: rich?.currentTool ?? s.currentTool,
            iterations: rich?.iterations ?? s.iterations,
            toolCalls: rich?.toolCalls ?? s.toolCalls,
            lastSeenAt: s.lastSeenAt,
            ...(rich?.ctxPct !== undefined ? { ctxPct: rich.ctxPct } : {}),
            ...(rich?.costUsd !== undefined ? { costUsd: rich.costUsd } : {}),
          };
        });
      const peers = rows.filter((r) => !r.you);
      return {
        ok: true,
        you: identity.callerId,
        onlineCount: rows.filter((r) => r.online).length,
        agents: rows,
        summary:
          peers.length === 0
            ? 'No other agents are active on this project right now.'
            : `${peers.length} peer agent(s): ${peers
                .map((p) => `${p.name} (${p.status}${p.currentTask ? ` — ${p.currentTask}` : ''})`)
                .join('; ')}`,
      };
    },
  };
}
