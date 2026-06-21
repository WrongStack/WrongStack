/**
 * Pure office-map model resolution — extracted from OfficeMapCanvas.tsx so the
 * (large) canvas component keeps only rendering concerns. Turns the live
 * cross-process session snapshot + local fleet store into the client/agent
 * model the React-Flow nodes render. No React, no JSX — unit-testable.
 */
import type { LiveSession } from '@/stores/monitor-store';
import type { SubagentView } from '@/stores/types';
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
  model?: string | undefined;
  lastActivityAt?: string | undefined;
  currentTask?: string | undefined;
}

/** A resolved client (one live session) with its agents. */
export interface ResolvedClient {
  id: string; // `client-<pid|sessionId>`
  type: 'tui' | 'webui' | 'repl';
  label: string;
  sublabel: string;
  status: ClientStatus;
  sessionId?: string | undefined;
  pid?: number | undefined;
  branch?: string | undefined;
  workingDir?: string | undefined;
  startedAt?: string | undefined;
  agents: ResolvedAgent[];
}

/**
 * Build the office client/agent model from the live cross-process snapshot,
 * preferring the richer local fleet-store data for the attached session's
 * agents and folding any not-yet-snapshotted local agents under a WebUI client.
 */
export function resolveClients(
  liveSessions: LiveSession[],
  fleetAgents: Map<string, SubagentView>,
): ResolvedClient[] {
  const rendered = new Set<string>();
  const clients: ResolvedClient[] = [];

  for (const s of liveSessions) {
    const type = clientNodeType(s.clientType);
    // Office node ids must be unique across clients — two sessions can each
    // have an agent literally named "leader", which would otherwise collide on
    // `agent-leader` and render as a single node.
    const clientId = `client-${s.pid ?? s.sessionId}`;
    const agents: ResolvedAgent[] = [];
    let anyRunning = false;

    for (const a of s.agents) {
      rendered.add(a.id);
      const fleet = fleetAgents.get(a.id);
      const status = mapAgentStatus(fleet?.status ?? a.status);
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
        model: fleet?.model ?? a.model,
        lastActivityAt: a.lastActivityAt,
        currentTask: fleet?.currentTool ?? fleet?.lastTool ?? a.currentTool,
      });
    }

    const status: ClientStatus =
      s.status === 'closing' || s.status === 'stale'
        ? 'offline'
        : anyRunning
          ? 'active'
          : 'idle';

    clients.push({
      id: clientId,
      type,
      label: s.projectName || surfaceLabel(type),
      sublabel: [surfaceLabel(type), s.gitBranch ? `⎇ ${s.gitBranch}` : '', s.pid ? `pid ${s.pid}` : '']
        .filter(Boolean)
        .join(' · '),
      status,
      sessionId: s.sessionId,
      pid: s.pid,
      branch: s.gitBranch,
      workingDir: s.workingDir,
      startedAt: s.startedAt,
      agents,
    });
  }

  // Local agents the 5s snapshot hasn't caught up to yet (attached session):
  // attach them to a WebUI client so they appear immediately.
  const leftover = [...fleetAgents.values()].filter((a) => !rendered.has(a.id));
  if (leftover.length > 0) {
    let host = clients.find((c) => c.type === 'webui');
    if (!host) {
      host = { id: 'client-self', type: 'webui', label: 'This WebUI', sublabel: 'Web UI', status: 'idle', agents: [] };
      clients.push(host);
    }
    for (const a of leftover) {
      const status = mapAgentStatus(a.status);
      if (status === 'active' || status === 'streaming') host.status = 'active';
      host.agents.push({
        officeId: `${host.id}__agent-${a.id}`,
        serverId: a.id,
        name: a.name,
        status,
        iteration: a.iteration ?? 0,
        toolCalls: a.toolCalls ?? 0,
        costUsd: a.costUsd ?? 0,
        tokensIn: a.tokensIn ?? 0,
        tokensOut: a.tokensOut ?? 0,
        ctxPct: a.ctxPct,
        model: a.model,
        currentTask: a.currentTool ?? a.lastTool,
      });
    }
  }

  // Never render a fully empty floor — show this WebUI as a connecting client.
  if (clients.length === 0) {
    clients.push({
      id: 'client-self',
      type: 'webui',
      label: 'This WebUI',
      sublabel: 'Web UI · connecting…',
      status: 'idle',
      agents: [],
    });
  }

  return clients;
}

/** Dot colour for a viz event, by kind prefix. */
export function feedColor(kind: string): string {
  if (kind.startsWith('tool')) return '#eab308';
  if (kind.startsWith('mailbox')) return '#06b6d4';
  if (kind.startsWith('provider')) return '#a855f7';
  if (kind.startsWith('agent') || kind.startsWith('subagent')) return '#22c55e';
  if (kind.includes('error')) return '#ef4444';
  return '#6366f1';
}
