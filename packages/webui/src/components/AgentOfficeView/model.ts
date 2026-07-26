import {
  Building2,
  Check,
  Code2,
  FilePenLine,
  FolderSearch,
  Globe2,
  type LucideIcon,
  ListTodo,
  MemoryStick,
  Search,
  TerminalSquare,
} from 'lucide-react';
import {
  classifyOfficeTool,
  synthesizeCurrentTool,
  type OfficeMailActivity,
  type OfficeToolCall,
  type OfficeToolKind,
} from '@/lib/agent-office';
import type { ResolvedAgent, ResolvedClient } from '../OfficeMapCanvas/resolve.js';

export interface OfficeAgentModel {
  key: string;
  client: ResolvedClient;
  agent: ResolvedAgent;
  calls: OfficeToolCall[];
  current?: OfficeToolCall | undefined;
  display?: OfficeToolCall | undefined;
  history: OfficeToolCall[];
  mail: OfficeMailActivity[];
}

export interface ClientOfficeStats {
  files: number;
  reads: number;
  writes: number;
  edits: number;
  linesAdded: number;
  linesRemoved: number;
  terminalCalls: number;
  incomingMail: number;
  outgoingMail: number;
}

export interface ClientOfficeModel {
  client: ResolvedClient;
  agents: OfficeAgentModel[];
  stats: ClientOfficeStats;
}

export type AgentVisualRole = 'leader' | 'builder' | 'researcher' | 'reviewer' | 'planner' | 'operator';
export type DeskPalette = 'amber' | 'mint' | 'ocean' | 'plum' | 'rose' | 'graphite';

export interface DeskPersonality {
  palette: DeskPalette;
  layout: number;
  clutter: number;
  avatar: number;
  motion: number;
  charm: 'bot' | 'cactus' | 'duck' | 'radio';
}

const DESK_CHARMS: DeskPersonality['charm'][] = ['bot', 'cactus', 'duck', 'radio'];

/**
 * Color is information, not decoration: each visual role owns one desk palette
 * so a glance tells builders (ocean) from reviewers (rose) from the leader
 * (plum). Avatar silhouettes are also role-fixed — the same kind of agent
 * always looks the same, across sessions and clients.
 */
const ROLE_PALETTES: Record<AgentVisualRole, DeskPalette> = {
  leader: 'plum',
  builder: 'ocean',
  researcher: 'mint',
  reviewer: 'rose',
  planner: 'amber',
  operator: 'graphite',
};

const ROLE_AVATARS: Record<AgentVisualRole, number> = {
  leader: 0,
  builder: 1,
  researcher: 2,
  reviewer: 3,
  planner: 4,
  operator: 5,
};

export const TOOL_ICONS: Record<OfficeToolKind, LucideIcon> = {
  read: Search,
  write: FilePenLine,
  edit: FilePenLine,
  terminal: TerminalSquare,
  web: Globe2,
  search: FolderSearch,
  memory: MemoryStick,
  other: Code2,
};

export const AGENT_ROLE_ICONS: Record<AgentVisualRole, LucideIcon> = {
  leader: Building2,
  builder: Code2,
  researcher: Search,
  reviewer: Check,
  planner: ListTodo,
  operator: TerminalSquare,
};

export function agentVisualRole(agent: ResolvedAgent): AgentVisualRole {
  if (agent.serverId === 'leader' || agent.serverId.startsWith('leader@')) return 'leader';
  const description = [agent.role, agent.name, agent.currentTask]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (/review|critic|audit|security|test|qa|verify|checker/.test(description)) return 'reviewer';
  if (/research|analyst|explor|investig|search|hunter|recon/.test(description)) return 'researcher';
  if (/plan|architect|design|coordinat|strateg|spec/.test(description)) return 'planner';
  if (/build|implement|code|develop|engineer|refactor|fix|frontend|backend/.test(description)) {
    return 'builder';
  }
  return 'operator';
}

/**
 * Stable visual variety without desks changing personality on every render.
 * The hash only picks harmless decoration (layout, clutter, motion, charm);
 * palette and avatar silhouette come from the agent's role so they mean
 * something.
 */
export function deskPersonality(identity: string, role: AgentVisualRole): DeskPersonality {
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const seed = hash >>> 0;
  return {
    palette: ROLE_PALETTES[role],
    layout: seed % 4,
    clutter: Math.floor(seed / 4) % 3,
    avatar: ROLE_AVATARS[role],
    motion: Math.floor(seed / 31) % 4,
    charm: DESK_CHARMS[Math.floor(seed / 47) % DESK_CHARMS.length],
  };
}

/** `anthropic/claude-sonnet-4-20250514` → `claude-sonnet-4`; falls back to the raw value. */
export function shortModelName(model: string, max = 22): string {
  const leaf = model.split('/').filter(Boolean).pop() ?? model;
  return leaf.length > max ? `${leaf.slice(0, max - 1)}…` : leaf;
}

export function shortPath(value: string | undefined, max = 46): string | undefined {
  if (!value || value.length <= max) return value;
  const parts = value.split(/[\\/]/);
  const tail = parts.slice(-2).join('/');
  return tail.length <= max ? `…/${tail}` : `…${value.slice(-(max - 1))}`;
}

export function relativeTime(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 5) return 'now';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

export function formatUptime(startedAt: string | undefined, now: number): string {
  if (!startedAt) return '—';
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return '—';
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export function clientOfficeStats(agents: OfficeAgentModel[]): ClientOfficeStats {
  const files = new Set<string>();
  const incomingMail = new Set<string>();
  const outgoingMail = new Set<string>();
  let sessionIncomingMail = 0;
  let sessionOutgoingMail = 0;
  const stats: ClientOfficeStats = {
    files: 0,
    reads: 0,
    writes: 0,
    edits: 0,
    linesAdded: 0,
    linesRemoved: 0,
    terminalCalls: 0,
    incomingMail: 0,
    outgoingMail: 0,
  };
  for (const model of agents) {
    const activity = model.agent.activity;
    for (const filePath of activity?.filesTouched ?? []) files.add(filePath);
    stats.reads += activity?.reads ?? 0;
    stats.writes += activity?.writes ?? 0;
    stats.edits += activity?.edits ?? 0;
    stats.linesAdded += activity?.linesAdded ?? 0;
    stats.linesRemoved += activity?.linesRemoved ?? 0;
    stats.terminalCalls += activity?.terminalCalls ?? 0;
    sessionIncomingMail += activity?.mailReceived ?? 0;
    sessionOutgoingMail += activity?.mailSent ?? 0;
    for (const mail of model.mail) {
      (mail.direction === 'incoming' ? incomingMail : outgoingMail).add(mail.id);
    }
  }
  stats.files = files.size;
  stats.incomingMail = Math.max(sessionIncomingMail, incomingMail.size);
  stats.outgoingMail = Math.max(sessionOutgoingMail, outgoingMail.size);
  return stats;
}

export function fallbackLogCalls(
  agent: ResolvedAgent,
  client: ResolvedClient,
  logs: Array<{ name: string; ok: boolean; durationMs: number; at: number }>,
): OfficeToolCall[] {
  return logs.map((log, index) => ({
    ...synthesizeCurrentTool(agent.serverId, log.name, client.sessionId),
    id: `${agent.serverId}:log:${log.at}:${index}`,
    kind: classifyOfficeTool(log.name),
    status: log.ok ? 'succeeded' : 'failed',
    startedAt: Math.max(0, log.at - log.durationMs),
    completedAt: log.at,
    durationMs: log.durationMs,
    summary: log.ok ? `${log.name} completed` : `${log.name} failed`,
  }));
}

export function mergeCalls(...sources: OfficeToolCall[][]): OfficeToolCall[] {
  const merged: OfficeToolCall[] = [];
  for (const call of sources.flat()) {
    const timestamp = call.completedAt ?? call.startedAt;
    const duplicate = merged.some(
      (candidate) =>
        (candidate.id === call.id || candidate.toolName === call.toolName) &&
        Math.abs((candidate.completedAt ?? candidate.startedAt) - timestamp) < 2500,
    );
    if (!duplicate) merged.push(call);
  }
  return merged.sort(
    (left, right) => (right.completedAt ?? right.startedAt) - (left.completedAt ?? left.startedAt),
  );
}

export function mergeMail(...sources: OfficeMailActivity[][]): OfficeMailActivity[] {
  const merged = new Map<string, OfficeMailActivity>();
  // Snapshot first, then full mailbox records so message body/read state wins.
  for (const mail of sources.flat()) merged.set(mail.id, mail);
  return [...merged.values()]
    .sort((left, right) => right.timestampMs - left.timestampMs)
    .slice(0, 12);
}
