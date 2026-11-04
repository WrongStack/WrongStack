import { type OfficeSelf, WEBUI_SELF } from '../feed';
/**
 * Pure office-map model resolution — extracted from OfficeMapCanvas.tsx so the
 * (large) canvas component keeps only rendering concerns. Turns the live
 * cross-process session snapshot + local fleet store into the client/agent
 * model the React-Flow nodes render. No React, no JSX — unit-testable.
 */

import type {
  LiveAgentActivity,
  LiveMailActivity,
  LiveSession,
  LiveTodoItem,
  LiveToolActivity,
  MailboxAgent,
  SubagentView,
} from '../types';
import { type ClientStatus, clientNodeType, mapAgentStatus, surfaceLabel } from './utils.js';

/** A resolved agent ready to render as an office desk node. */
export interface ResolvedAgent {
  officeId: string; // `agent-<serverId>`
  serverId: string;
  name: string;
  status: ClientStatus;
  iteration: number;
  toolCalls: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  ctxPct?: number | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  lastActivityAt?: string | undefined;
  currentTool?: string | undefined;
  currentTask?: string | undefined;
  taskId?: string | undefined;
  recentTools?: LiveToolActivity[] | undefined;
  recentMail?: LiveMailActivity[] | undefined;
  activity?: LiveAgentActivity | undefined;
  mailboxId?: string | undefined;
  role?: string | undefined;
  /** Execution-backed presence source; mailbox identities never reach this model alone. */
  presenceSource: 'registry' | 'fleet';
}

/** How long a finished fleet agent stays visible on its leader's office. */
export const FINISHED_AGENT_GRACE_MS = 15 * 60 * 1000;

/** A fleet agent we still remember after its session finished, with the
 *  timestamp we observed the terminal state. */
export interface FinishedFleetAgent {
  agent: SubagentView;
  finishedAt: number;
}

/** A resolved client (one live session) with its agents. */
export interface ResolvedClient {
  id: string; // `client-<sessionId>`
  type: 'tui' | 'webui' | 'repl';
  label: string;
  sublabel: string;
  status: ClientStatus;
  sessionId?: string | undefined;
  pid?: number | undefined;
  branch?: string | undefined;
  workingDir?: string | undefined;
  startedAt?: string | undefined;
  lastHeartbeatAt?: string | undefined;
  latestPrompt?: string | undefined;
  latestPromptAt?: number | undefined;
  activeInstruction?: string | undefined;
  todos?: LiveTodoItem[] | undefined;
  agents: ResolvedAgent[];
}

function sessionLeaf(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  return sessionId.split('/').filter(Boolean).pop() ?? sessionId;
}

function sessionTail(sessionId: string | undefined): string {
  const leaf = sessionLeaf(sessionId) ?? sessionId ?? '';
  return leaf.length > 10 ? `…${leaf.slice(-8)}` : leaf;
}

/**
 * Match a fleet-store `sessionId` to a resolved client. Sessions are stored
 * dated (`YYYY-MM-DD/sess_abc`) but the fleet store and snapshot sometimes
 * carry the bare leaf (`sess_abc`); compare the leaf so both forms match.
 */
function findSessionClient(
  clients: ResolvedClient[],
  sessionId: string | undefined,
): ResolvedClient | undefined {
  const leaf = sessionLeaf(sessionId);
  if (!leaf) return undefined;
  return clients.find((c) => sessionLeaf(c.sessionId) === leaf);
}

/** Build a `ResolvedAgent` from a fleet-store `SubagentView`. */
function fleetAgentView(hostId: string, a: SubagentView): ResolvedAgent {
  const status = mapAgentStatus(a.status);
  return {
    officeId: `${hostId}__agent-${a.id}`,
    serverId: a.id,
    name: a.name ?? a.id,
    status,
    iteration: a.iteration ?? 0,
    toolCalls: a.toolCalls ?? 0,
    costUsd: a.costUsd ?? 0,
    tokensIn: a.tokensIn ?? 0,
    tokensOut: a.tokensOut ?? 0,
    ctxPct: a.ctxPct,
    provider: a.provider,
    model: a.model,
    currentTool: a.currentTool,
    currentTask: a.description,
    taskId: a.taskId,
    presenceSource: 'fleet',
  };
}

function executionSurface(clientType: string | undefined, type: ResolvedClient['type']): string {
  if (clientType === 'cli') return 'CLI';
  if (clientType === 'repl') return 'REPL';
  return surfaceLabel(type);
}

/**
 * Build the office client/agent model from the live cross-process snapshot,
 * preferring the richer local fleet-store data for the attached session's
 * agents and folding any not-yet-snapshotted local agents under a WebUI client.
 *
 * Recently finished fleet agents (within {@link FINISHED_AGENT_GRACE_MS}) are
 * folded into their leader's office so the break-room seat lingers briefly
 * after the backend reaps the agent from the live roster.
 *
 * @param recentlyFinished Retention map from {@link useRecentlyFinishedFleetAgents}.
 * @param now Wall-clock instant captured in the same render as the retention
 *   prune; keeps the `now - finishedAt` arithmetic consistent inside the memo.
 */
export function resolveClients(
  liveSessions: LiveSession[],
  fleetAgents: ReadonlyMap<string, SubagentView>,
  mailboxAgents: MailboxAgent[] = [],
  recentlyFinished: Map<string, FinishedFleetAgent> = new Map(),
  now: number = Date.now(),
  self: OfficeSelf = WEBUI_SELF,
): ResolvedClient[] {
  const rendered = new Set<string>();
  const clients: ResolvedClient[] = [];

  for (const s of liveSessions) {
    const type = clientNodeType(s.clientType);
    const surface = executionSurface(s.clientType, type);
    // Office node ids must be unique across clients — two sessions can each
    // have an agent literally named "leader", which would otherwise collide on
    // `agent-leader` and render as a single node.
    const clientId = `client-${s.sessionId}`;
    const agents: ResolvedAgent[] = [];
    let anyRunning = false;

    for (const a of s.agents) {
      const fleet = fleetAgents.get(a.id);
      const status = mapAgentStatus(fleet?.status ?? a.status);
      // HQ downgrades stale worker telemetry to idle. Keep an idle leader as
      // the session anchor, but do not turn expired workers into office desks.
      if (a.id !== 'leader' && (fleet?.status ?? a.status) === 'idle') {
        rendered.add(a.id);
        continue;
      }
      rendered.add(a.id);
      if (status === 'active' || status === 'streaming') anyRunning = true;
      agents.push({
        officeId: `${clientId}__agent-${a.id}`,
        serverId: a.id,
        name: fleet?.name ?? a.name ?? a.id,
        status,
        iteration: fleet?.iteration ?? a.iterations ?? 0,
        toolCalls: fleet?.toolCalls ?? a.toolCalls ?? 0,
        costUsd: fleet?.costUsd ?? a.costUsd ?? 0,
        tokensIn: fleet?.tokensIn ?? a.tokensIn ?? 0,
        tokensOut: fleet?.tokensOut ?? a.tokensOut ?? 0,
        ctxPct: fleet?.ctxPct ?? a.ctxPct,
        provider: fleet?.provider,
        model: fleet?.model ?? a.model,
        lastActivityAt: a.lastActivityAt,
        currentTool: fleet?.currentTool ?? a.currentTool,
        currentTask: a.currentTask ?? fleet?.description,
        taskId: a.taskId ?? fleet?.taskId,
        recentTools: a.recentTools,
        recentMail: a.recentMail,
        activity: a.activity,
        presenceSource: 'registry',
      });
    }

    const status: ClientStatus =
      s.status === 'closing' || s.status === 'stale' || s.status === 'lost'
        ? 'offline'
        : anyRunning
          ? 'active'
          : 'idle';
    const leader = s.agents.find((agent) => agent.id === 'leader');

    clients.push({
      id: clientId,
      type,
      label: `${surface} · ${s.pid ? `PID ${s.pid}` : sessionTail(s.sessionId)}`,
      sublabel: [
        `session ${sessionTail(s.sessionId)}`,
        s.gitBranch ? `⎇ ${s.gitBranch}` : '',
        s.workingDir ? s.workingDir.split(/[\\/]/).filter(Boolean).pop() : '',
      ]
        .filter(Boolean)
        .join(' · '),
      status,
      sessionId: s.sessionId,
      pid: s.pid,
      branch: s.gitBranch,
      workingDir: s.workingDir,
      startedAt: s.startedAt,
      lastHeartbeatAt: s.lastHeartbeatAt,
      latestPrompt: leader?.latestPrompt,
      latestPromptAt: leader?.latestPromptAt,
      activeInstruction:
        leader?.status === 'running' || leader?.status === 'streaming'
          ? (leader.latestPrompt ?? leader.currentTask)
          : undefined,
      todos: leader?.todos,
      agents,
    });
  }

  // Mailbox presence is not execution presence: profiles, reviewers and
  // synthetic coordinator identities can remain "online" without owning a
  // live process. Only use the roster to decorate an agent that the live
  // session registry already proved exists. Registry/fleet state is the sole
  // authority for desks and offices.
  for (const mailbox of mailboxAgents.filter((agent) => agent.online)) {
    const host = findSessionClient(clients, mailbox.sessionId);
    if (!host) continue;

    const normalizedName = mailbox.name.trim().toLowerCase();
    const existing = host.agents.find(
      (agent) =>
        agent.serverId === mailbox.agentId || agent.name.trim().toLowerCase() === normalizedName,
    );
    if (existing) {
      rendered.add(mailbox.agentId);
      existing.mailboxId = mailbox.agentId;
      existing.role = mailbox.role;
      existing.currentTask = existing.currentTask ?? mailbox.currentTask;
      existing.currentTool = existing.currentTool ?? mailbox.currentTool;
    }
  }

  // Local fleet agents the 5s snapshot hasn't caught up to yet, plus any
  // fleet subagent whose session exists but whose agent row is not yet in
  // the snapshot. Attach each to its matching session's client office so it
  // renders in the right room; only fall back to a synthetic WebUI client
  // when no live session matches.
  const leftover = [...fleetAgents.values()].filter((a) => !rendered.has(a.id));
  let fallbackHost: ResolvedClient | undefined;
  const ensureFallbackHost = (): ResolvedClient => {
    if (fallbackHost) return fallbackHost;
    const existing = clients.find((c) => c.type === 'webui');
    if (existing) {
      fallbackHost = existing;
      return existing;
    }
    fallbackHost = {
      id: 'client-self',
      type: 'webui',
      label: self.label,
      sublabel: self.sublabel,
      status: 'idle',
      agents: [],
    };
    clients.push(fallbackHost);
    return fallbackHost;
  };

  for (const a of leftover) {
    const host = findSessionClient(clients, a.sessionId) ?? ensureFallbackHost();
    const view = fleetAgentView(host.id, a);
    // Don't resurrect a closing/stale/lost session (status 'offline') just
    // because a snapshot-missed fleet agent reports itself as active.
    if ((view.status === 'active' || view.status === 'streaming') && host.status !== 'offline')
      host.status = 'active';
    host.agents.push(view);
    rendered.add(a.id);
  }

  // Recently-finished fleet agents linger on their leader's office for a
  // short grace window so the break-room seat survives the backend reap.
  // Retention is stricter than the live-leftover path: orphan entries whose
  // sessionId matches no live client are silently dropped (no ghost office).
  for (const [id, entry] of recentlyFinished) {
    if (rendered.has(id)) continue;
    if (now - entry.finishedAt > FINISHED_AGENT_GRACE_MS) continue;
    const host = findSessionClient(clients, entry.agent.sessionId);
    if (!host) continue;
    host.agents.push(fleetAgentView(host.id, entry.agent));
  }

  // Never render a fully empty floor — show this WebUI as a connecting client.
  if (clients.length === 0) {
    clients.push({
      id: 'client-self',
      type: 'webui',
      label: self.label,
      sublabel: `${self.sublabel} · connecting…`,
      status: 'idle',
      agents: [],
    });
  }

  return clients;
}

/** Dot colour for a viz event, by kind prefix. */
export function feedColor(kind: string): string {
  if (kind.startsWith('tool')) return 'hsl(var(--warning))';
  if (kind.startsWith('mailbox')) return 'hsl(var(--info))';
  if (kind.startsWith('provider')) return 'hsl(var(--primary))';
  if (kind.startsWith('agent') || kind.startsWith('subagent')) return 'hsl(var(--success))';
  if (kind.includes('error')) return 'hsl(var(--destructive))';
  return 'hsl(var(--primary))';
}
