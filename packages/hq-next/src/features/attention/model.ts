/**
 * The attention queue — everything waiting on a human, from every source.
 *
 * One pure function decides what counts and in which order, so the Overview's
 * "Needs you" list and the Inbox queue can never disagree: they read the same
 * items with the same ids, which is also what makes `/inbox/?item=<id>` links
 * from the Overview land on the right card.
 */
import type { HqAlert, HqAlertMessage, HqCommandAuditEntry, HqSnapshot } from '@wrongstack/hq';
import { machineKeyOf, type ScopeTag } from '../../lib/scope';
import { healthProblems } from '../machines/health';
import { governanceLabel } from './governance';
import { versionDrift } from './versions';

export type AttentionTone = 'critical' | 'warning';

export type AttentionKind =
  | 'approval'
  | 'question'
  | 'agent'
  | 'client'
  | 'machine'
  | 'host'
  | 'command'
  | 'governance'
  | 'run'
  | 'mcp'
  | 'version'
  | 'alert';

/** Kinds that are answered inside the Inbox rather than on another surface. */
export const DECISION_KINDS: ReadonlySet<AttentionKind> = new Set(['approval', 'question']);

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  tone: AttentionTone;
  title: string;
  context: string;
  /** ISO string or epoch ms; used for ordering and the relative time. */
  at: string | number | undefined;
  /** The surface that resolves this item. */
  href: string;
  action: string;
  /** Focus the console on this agent before navigating. */
  focus?: { sessionId: string; agentId: string };
  /** Key into the source collection (toolUseId, request id, …) for detail panes. */
  sourceId: string;
  /** Where it comes from, for the operator's scope. Absent = fleet-wide. */
  origin?: ScopeTag;
}

/** The slice of a pending approval the queue reads. */
export interface ApprovalLike {
  toolUseId: string;
  toolName: string;
  projectId: string;
  /** The publisher that raised it; places it on one machine. */
  clientId?: string;
  destructive: boolean;
  riskTier?: 'safe' | 'standard' | 'destructive' | undefined;
  boundaryReason?: string | undefined;
  requestedAt: string;
}

/** The slice of a pending user-input request the queue reads. */
export interface QuestionLike {
  projectId: string;
  clientId?: string;
  request: { id: string; title: string };
}

export interface AttentionSources {
  snapshot: HqSnapshot | null;
  approvals: readonly ApprovalLike[];
  questions: readonly QuestionLike[];
  /** The live alert feed (WebSocket). */
  alerts: readonly HqAlertMessage[];
  /**
   * Alert rules firing right now (`/api/alerts` → `active`). Without these, a
   * rule that fired before the page loaded would be invisible until it fired
   * again.
   */
  activeAlerts?: readonly HqAlert[];
  commands: readonly HqCommandAuditEntry[];
}

const KIND_ORDER: Record<AttentionKind, number> = {
  approval: 0,
  question: 1,
  agent: 2,
  command: 3,
  run: 4,
  client: 5,
  machine: 5,
  host: 5,
  governance: 6,
  mcp: 7,
  version: 8,
  alert: 9,
};

/** How long a machine that went offline stays in the attention queue. */
const MACHINE_OFFLINE_ATTENTION_MS = 24 * 60 * 60_000;

export function inboxItemHref(id: string): string {
  return `/inbox/?item=${encodeURIComponent(id)}`;
}

/**
 * Where an Overview row goes: blocked agents straight to their conversation,
 * everything else to its Inbox card, which explains it and offers the action.
 */
export function overviewTarget(item: AttentionItem): string {
  return item.kind === 'agent' ? item.href : inboxItemHref(item.id);
}

function projectName(snapshot: HqSnapshot | null, projectId: string): string {
  return (
    snapshot?.projects?.find((project) => project.projectId === projectId)?.projectName ?? projectId
  );
}

export function toMillis(value: string | number | undefined): number {
  if (value === undefined) return 0;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Everything that is waiting on a human, most urgent first: critical before
 * warning, then decisions before diagnostics, then newest first.
 */
export function buildAttentionItems(sources: AttentionSources): AttentionItem[] {
  const { snapshot, approvals, questions, alerts, commands } = sources;
  const activeAlerts = sources.activeAlerts ?? [];
  const items: AttentionItem[] = [];

  for (const approval of approvals) {
    const critical =
      approval.destructive ||
      approval.riskTier === 'destructive' ||
      approval.boundaryReason !== undefined;
    const label =
      approval.boundaryReason !== undefined
        ? ' · governance boundary'
        : approval.destructive || approval.riskTier === 'destructive'
          ? ' · destructive'
          : '';
    items.push({
      id: `approval:${approval.toolUseId}`,
      kind: 'approval',
      tone: critical ? 'critical' : 'warning',
      title: `${approval.toolName} is waiting for approval`,
      context: `${projectName(snapshot, approval.projectId)}${label}`,
      at: approval.requestedAt,
      href: '/inbox/',
      action: 'Review',
      sourceId: approval.toolUseId,
      origin: { clientId: approval.clientId, projectId: approval.projectId },
    });
  }

  for (const question of questions) {
    items.push({
      id: `question:${question.request.id}`,
      kind: 'question',
      tone: 'warning',
      title: question.request.title,
      context: `${projectName(snapshot, question.projectId)} · question for you`,
      at: undefined,
      href: '/inbox/',
      action: 'Answer',
      sourceId: question.request.id,
      origin: { clientId: question.clientId, projectId: question.projectId },
    });
  }

  for (const session of snapshot?.liveSessions ?? []) {
    for (const agent of session.agents ?? []) {
      if (agent.status !== 'waiting_user' && agent.status !== 'error') continue;
      const failed = agent.status === 'error';
      items.push({
        id: `agent:${session.sessionId}:${agent.id}`,
        kind: 'agent',
        tone: failed ? 'critical' : 'warning',
        title: `${agent.name} ${failed ? 'stopped with an error' : 'is waiting for you'}`,
        context: `${session.projectName} · ${session.hostname ?? session.machineId}`,
        at: agent.lastActivityAt,
        href: '/fleet/console/',
        action: 'Open conversation',
        focus: { sessionId: session.sessionId, agentId: agent.id },
        sourceId: `${session.sessionId}:${agent.id}`,
        origin: {
          machineKey: session.hostname
            ? machineKeyOf(session.hostname, session.machineId)
            : undefined,
          machineId: session.machineId,
          projectId: session.projectId,
        },
      });
    }
  }

  for (const command of commands) {
    if (command.ackStatus !== 'failed' && command.ackStatus !== 'rejected') continue;
    items.push({
      id: `command:${command.commandId}`,
      kind: 'command',
      tone: 'warning',
      title: `Command "${command.type}" was ${command.ackStatus}`,
      context: command.ackMessage ?? command.clientId,
      at: command.ackedAt ?? command.enqueuedAt,
      href: '/system/',
      action: 'Open command audit',
      sourceId: command.commandId,
      origin: { clientId: command.clientId },
    });
  }

  for (const client of snapshot?.clients ?? []) {
    if (client.connected) continue;
    items.push({
      id: `client:${client.clientId}`,
      kind: 'client',
      tone: 'warning',
      title: `${client.kind.toUpperCase()} on ${client.hostname ?? client.machineId} disconnected`,
      context: projectName(snapshot, client.projectId),
      at: client.lastSeenAt,
      href: '/fleet/',
      action: 'Locate in fleet map',
      sourceId: client.clientId,
      origin: { clientId: client.clientId, projectId: client.projectId },
    });
  }

  // A machine that dropped out of the fleet recently. Measured against the
  // snapshot's own clock so the queue stays a pure function; after a day the
  // Machines list still shows it, but it stops asking for attention.
  const snapshotAt = toMillis(snapshot?.generatedAt);
  for (const machine of snapshot?.offlineMachines ?? []) {
    if (snapshotAt - toMillis(machine.lastSeenAt) > MACHINE_OFFLINE_ATTENTION_MS) continue;
    const hostname = machine.hostname ?? machine.key.replace(/^(host|mid):/, '');
    items.push({
      id: `machine:${machine.key}`,
      kind: 'machine',
      tone: 'warning',
      title: `${hostname} went offline`,
      context:
        machine.projects.map((project) => project.projectName).join(' · ') ||
        'No connected WrongStack client',
      at: machine.lastSeenAt,
      href: `/fleet/machines/?machine=${encodeURIComponent(machine.key)}`,
      action: 'Open the machine',
      sourceId: machine.key,
      origin: { machineKey: machine.key },
    });
  }

  // Live machines whose newest (fresh) health sample is low on disk or memory.
  const healthChecked = new Set<string>();
  for (const machine of snapshot?.machines ?? []) {
    const key = machineKeyOf(machine.hostname, machine.machineId);
    if (healthChecked.has(key)) continue;
    healthChecked.add(key);
    const hostname = machine.hostname || machine.machineId;
    for (const problem of healthProblems(machine.health, machine.healthProblems)) {
      items.push({
        id: `host-${problem.kind}:${key}`,
        kind: 'host',
        tone: 'warning',
        title: `${hostname} is ${problem.summary}`,
        context: problem.kind === 'disk' ? 'The volume that holds the project' : 'Whole machine',
        at: machine.health?.reportedAt,
        href: `/fleet/machines/?machine=${encodeURIComponent(key)}`,
        action: 'Open the machine',
        sourceId: key,
        origin: { machineKey: key },
      });
    }
  }

  for (const project of snapshot?.projects ?? []) {
    const level = project.governance?.signal.level;
    if (level !== 'warning' && level !== 'unavailable') continue;
    items.push({
      id: `governance:${project.projectId}`,
      kind: 'governance',
      tone: 'warning',
      title: `Governance ${level === 'warning' ? 'warning' : 'unavailable'} in ${project.projectName}`,
      context:
        project.governance !== undefined ? governanceLabel(project.governance.signal.code) : '',
      at: project.governance?.observedAt,
      href: '/fleet/',
      action: 'Open fleet map',
      sourceId: project.projectId,
      origin: { projectId: project.projectId },
    });
  }

  // A run that spent its spawn budget while tasks still wait will never drain
  // its queue on its own. Failed tasks alone are history, not a stall.
  for (const fleet of snapshot?.fleets ?? []) {
    if (fleet.remainingSpawns !== 0 || fleet.queuedTasks === 0) continue;
    const session = snapshot?.liveSessions?.find((entry) => entry.clientId === fleet.clientId);
    items.push({
      id: `run:${fleet.runId}`,
      kind: 'run',
      tone: 'warning',
      title: `Subagent run in ${projectName(snapshot, fleet.projectId)} is out of spawns`,
      context: `${fleet.queuedTasks} queued task${fleet.queuedTasks === 1 ? '' : 's'} cannot start`,
      at: fleet.lastActivityAt,
      href:
        session !== undefined
          ? `/fleet/console/?session=${encodeURIComponent(session.sessionId)}`
          : '/',
      action: session !== undefined ? 'Open the session' : 'Open the overview',
      sourceId: fleet.runId,
      origin: { clientId: fleet.clientId, projectId: fleet.projectId },
    });
  }

  // One row per terminal and server: the same server failing in two sessions
  // of one terminal is one connection to fix.
  const seenMcp = new Set<string>();
  for (const server of snapshot?.mcpServers ?? []) {
    if (server.healthState !== 'failed' && server.healthState !== 'degraded') continue;
    const key = `${server.clientId}:${server.name}`;
    if (seenMcp.has(key)) continue;
    seenMcp.add(key);
    const client = snapshot?.clients.find((entry) => entry.clientId === server.clientId);
    items.push({
      id: `mcp:${key}`,
      kind: 'mcp',
      tone: 'warning',
      title: `MCP server ${server.name} ${server.healthState === 'failed' ? 'is failing' : 'is degraded'}`,
      context: `${projectName(snapshot, server.projectId)} · ${client?.hostname ?? client?.machineId ?? 'unknown terminal'}`,
      at: server.lastFailureAt,
      href: `/system/mcp/?server=${encodeURIComponent(key)}`,
      action: 'Open MCP servers',
      sourceId: key,
      origin: { clientId: server.clientId, projectId: server.projectId },
    });
  }

  // One row for the whole fleet: the fix (update those machines) is the same
  // for every client, and a row per client would bury everything else.
  const drift = versionDrift(snapshot?.clients ?? [], snapshot?.hqVersion);
  const off = [...drift.behind, ...drift.ahead];
  if (off.length > 0 || (drift.hub === undefined && drift.mixed)) {
    const named = (off.length > 0 ? off : (snapshot?.clients ?? []).filter((c) => c.connected))
      .slice(0, 3)
      .map((client) => `${client.hostname ?? client.machineId} ${client.version ?? '?'}`);
    items.push({
      id: 'version:fleet',
      kind: 'version',
      tone: 'warning',
      title:
        drift.hub !== undefined
          ? `${off.length} client${off.length === 1 ? ' runs' : 's run'} a different WrongStack than HQ ${drift.hub}`
          : `Clients run ${drift.versions.length} different WrongStack versions`,
      context: named.join(' · '),
      at: undefined,
      href: '/fleet/machines/',
      action: 'Open machines',
      sourceId: 'fleet',
    });
  }

  // Firing rules first; a live alert repeating a firing rule's message is the
  // same signal arriving twice and is shown once.
  const ruleMessages = new Set<string>();
  for (const rule of activeAlerts) {
    if (rule.severity === 'info') continue;
    ruleMessages.add(rule.message);
    items.push({
      id: `rule:${rule.id}`,
      kind: 'alert',
      tone: rule.severity === 'error' ? 'critical' : 'warning',
      title: rule.message,
      context: `Alert rule ${rule.ruleId} · firing`,
      at: rule.lastFiredAt,
      href: '/inbox/alerts/',
      action: 'Open alert history',
      sourceId: rule.id,
    });
  }
  const seenLive = new Set<string>();
  for (const alert of alerts) {
    if (alert.severity === 'info' || ruleMessages.has(alert.message)) continue;
    const id = `alert:${alert.timestamp}:${alert.message}`;
    if (seenLive.has(id)) continue;
    seenLive.add(id);
    items.push({
      id,
      kind: 'alert',
      tone: alert.severity === 'error' ? 'critical' : 'warning',
      title: alert.message,
      context: alert.severity === 'error' ? 'Alert · error' : 'Alert · warning',
      at: alert.timestamp,
      href: '/inbox/alerts/',
      action: 'Open alert history',
      sourceId: id,
    });
  }

  return items.sort(
    (left, right) =>
      (left.tone === right.tone ? 0 : left.tone === 'critical' ? -1 : 1) ||
      KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
      toMillis(right.at) - toMillis(left.at),
  );
}

/** "just now", "4m ago", "3h ago", "2d ago". */
export function relativeTime(value: string | number | undefined, now: number): string {
  const at = toMillis(value);
  if (at === 0) return '';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** "45s left", "3m 05s left"; never negative. */
export function remainingLabel(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s left`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s left`;
}
