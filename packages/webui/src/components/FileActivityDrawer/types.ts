import { computeLineDiff } from '@wrongstack/tools/tool-diff';
import type { FileActivity } from '@/stores';
import type { ChronicleEventView, ChronicleFileLineageRow } from '@/types';

export type DrawerTab = 'overview' | 'changes' | 'skeleton' | 'context' | 'memory' | 'logs';

export interface ActivityRecord {
  id: string;
  at: number;
  action: string;
  actor: string;
  source: string;
  summary: string;
  sessionId?: string | undefined;
  agentId?: string | undefined;
  taskId?: string | undefined;
  boardId?: string | undefined;
  tool?: string | undefined;
  status?: string | undefined;
  raw?: unknown;
}

export interface FileActivityAnalysis {
  level: 'quiet' | 'active' | 'churn';
  mutationCount: number;
  sessionCount: number;
  actorCount: number;
  taskCount: number;
}

/** Full-history rollup of a file's mutation lineage, sourced from the Chronicle
 *  metrics store (indexed by path) rather than a bounded event scan. */
export interface FileLineageSummary {
  mutations: number;
  sessions: number;
  tasks: number;
  boards: number;
  tools: string[];
  models: string[];
  firstAt?: string | undefined;
  lastAt?: string | undefined;
}

export function summarizeLineage(rows: ChronicleFileLineageRow[]): FileLineageSummary {
  const sessions = new Set<string>();
  const tasks = new Set<string>();
  const boards = new Set<string>();
  const tools = new Set<string>();
  const models = new Set<string>();
  let firstAt: string | undefined;
  let lastAt: string | undefined;
  for (const row of rows) {
    if (row.sessionId) sessions.add(row.sessionId);
    if (row.taskId) tasks.add(row.taskId);
    if (row.boardId) boards.add(row.boardId);
    if (row.toolName) tools.add(row.toolName);
    if (row.modelId) models.add(row.modelId);
    if (!firstAt || row.occurredAt < firstAt) firstAt = row.occurredAt;
    if (!lastAt || row.occurredAt > lastAt) lastAt = row.occurredAt;
  }
  return {
    mutations: rows.length,
    sessions: sessions.size,
    tasks: tasks.size,
    boards: boards.size,
    tools: [...tools],
    models: [...models],
    firstAt,
    lastAt,
  };
}

export const MIN_DRAWER_HEIGHT = 150;
export const DEFAULT_DRAWER_HEIGHT = 224;
export const COLLAPSED_HEIGHT = 38;
export const MUTATION_PATTERN = /(write|edit|update|create|delete|rename|modified|changed)/i;

export function normalizeTrackedPath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .toLowerCase();
}

export function pathsReferToSameFile(left: string, right: string): boolean {
  const a = normalizeTrackedPath(left);
  const b = normalizeTrackedPath(right);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

export function analyzeFileActivity(
  records: Array<Pick<ActivityRecord, 'at' | 'action' | 'actor' | 'sessionId' | 'taskId'>>,
  now = Date.now(),
): FileActivityAnalysis {
  const recent = records.filter((record) => now - record.at <= 30 * 60_000);
  const mutations = recent.filter((record) => MUTATION_PATTERN.test(record.action));
  const sessionCount = new Set(recent.map((record) => record.sessionId).filter(Boolean)).size;
  const actorCount = new Set(recent.map((record) => record.actor).filter(Boolean)).size;
  const taskCount = new Set(recent.map((record) => record.taskId).filter(Boolean)).size;
  const level =
    mutations.length >= 8 || (mutations.length >= 4 && actorCount >= 3)
      ? 'churn'
      : mutations.length > 0
        ? 'active'
        : 'quiet';
  return { level, mutationCount: mutations.length, sessionCount, actorCount, taskCount };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function eventTime(event: ChronicleEventView): number {
  const parsed = Date.parse(event.occurredAt ?? event.observedAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function chronicleRecord(event: ChronicleEventView): ActivityRecord {
  const attributes = event.attributes ?? {};
  const action = asString(attributes['operation']) ?? event.eventType;
  const agentId = event.scope['agentId'];
  const provider = event.runtime?.providerId;
  const model = event.runtime?.modelId;
  return {
    id: event.eventId,
    at: eventTime(event),
    action,
    actor: agentId ?? provider ?? asString(attributes['actor']) ?? 'external',
    source: asString(attributes['source']) ?? event.tags?.['collector'] ?? 'chronicle',
    summary: [event.eventType, provider && model ? `${provider}/${model}` : provider, event.outcome]
      .filter(Boolean)
      .join(' · '),
    sessionId: event.scope['sessionId'],
    agentId,
    taskId: event.scope['taskId'] ?? asString(attributes['taskId']),
    boardId: asString(attributes['boardId']) ?? event.scope['boardId'],
    tool: asString(attributes['toolName']),
    status: event.outcome,
    raw: event,
  };
}

export function liveRecord(activity: FileActivity): ActivityRecord {
  return {
    id: activity.id ?? `${activity.filePath}:${activity.timestamp}:${activity.type}`,
    at: activity.timestamp,
    action: activity.type,
    actor: activity.agentName ?? activity.agent ?? activity.agentId ?? 'external',
    source: activity.source ?? 'live',
    summary: activity.summary,
    sessionId: activity.sessionId,
    agentId: activity.agentId,
    tool: activity.toolName,
    status: activity.status,
    raw: activity,
  };
}

export function uniqueRecords(records: ActivityRecord[]): ActivityRecord[] {
  const seen = new Set<string>();
  return records
    .sort((a, b) => b.at - a.at)
    .filter((record) => {
      const key = `${record.id}:${record.at}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function countLines(text: string): number {
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}

export function byteCount(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function compactId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

export function changeCounts(
  oldText: string,
  newText: string,
): { added: number; removed: number; large: boolean } {
  const rows = computeLineDiff(oldText, newText);
  if (!rows) return { added: 0, removed: 0, large: true };
  return {
    added: rows.filter((row) => row.kind === 'add').length,
    removed: rows.filter((row) => row.kind === 'del').length,
    large: false,
  };
}
