import { createHash } from 'node:crypto';
import type { EventBus } from '../kernel/events.js';
import type { ChronicleContext } from './context.js';
import type { ChronicleEventSink } from './sink.js';
import type { ChronicleEventInput, ChronicleOutcome, ChronicleResourceRef } from './types.js';

export interface ChronicleDomainAdapterOptions {
  events: EventBus;
  journal: ChronicleEventSink;
  context: ChronicleContext | (() => ChronicleContext);
  onPersistError?: ((error: unknown, event: ChronicleEventInput) => void) | undefined;
}

// Events owned by specialized adapters or windowed by the rollup adapter.
// One regex test replaces 15 individual pattern tests per EventBus emission.
// Alternatives ending with a literal dollar sign anchor are exact matches;
// others are prefix matches (same semantics as the original array).
// prettier-ignore
const SPECIALIZED_RE =
  /^(?:provider\.attempt\.|tool\.|process\.|brain\.decision_|brain\.human_answered$|brain\.outcome$|file\.activity$|provider\.(?:text_delta|thinking_delta)$|ctx\.pct$|subagent\.ctx_pct$|countdown\.tick$|coordinator\.stats$|session\.agents_updated$|network\.request\.(?:started|completed)$|runtime\.health\.sampled$|provider\.tool_use_(?:start|stop)$)/;
/**
 * Only domains that can improve coding decisions, provenance, reliability or
 * resource/cost control belong in Chronicle. UI presence, navigation and other
 * product-engagement events are intentionally not captured by this bridge.
 */
// prettier-ignore
const CODING_SIGNAL_RE =
  /^(?:(?:agent|subagent|delegate|fleet|session|iteration|context|compaction|checkpoint|in_flight|memory|storage|trust|sdd|worktree|kanban|brain|token|budget|concurrency|provider|mcp|network)\.|file\.event$|error$)/;
const SENSITIVE_KEY =
  /(content|text|prompt|question|rationale|reason|detail|summary|description|context|input|output|error|message|secret|token|password|key)$/i;
const PRESERVE_STRING_KEY =
  /(^|_)(id|status|state|kind|type|source|model|provider|phase|risk|fallback|path|name|role|sha|branch|mode)$/i;
/** Known metadata arrays that carry unbounded accumulated state (mail, tool
 *  history, commands). Chronicle only needs the most recent entries. */
const TRUNCATED_ARRAYS = new Set([
  'recentMail',
  'recentTools',
  'recentCommands',
  'activated',
  'injected',
  // SAGE per-memory rejection evidence — same cap (5) as activated/injected
  // so the journal stays bounded under burst conditions. Each entry is
  // ~120 bytes serialized; cap × entry-count = ~600B per injector_run.
  'rejectedDetail',
]);
const TRUNCATED_ARRAY_MAX = 5;
/** General array cap — enough for agent lists, file lists etc. without
 *  allowing unbounded growth through any array-shaped event field. */
const DEFAULT_ARRAY_MAX = 20;

/** Allowlisted coding-signal bridge for domains not owned by a richer adapter. */
export function wireDomainEventsToChronicle(options: ChronicleDomainAdapterOptions): () => void {
  return options.events.onAny((eventName, payload) => {
    if (SPECIALIZED_RE.test(eventName)) return;
    if (!CODING_SIGNAL_RE.test(eventName)) return;
    const record =
      eventName === 'memory.injector_run'
        ? dedupInjectorTrace(objectPayload(payload))
        : objectPayload(payload);
    // file.event reads are already evidenced by tool.resource.observed edges;
    // only mutations need the durable session/task/board lineage record.
    if (eventName === 'file.event' && record.operation === 'read') return;
    const context = typeof options.context === 'function' ? options.context() : options.context;
    const sessionId = stringField(record, 'sessionId');
    const agentId = stringField(record, 'agentId') ?? stringField(record, 'subagentId');
    const taskId = stringField(record, 'taskId');
    const kanbanBoardId = stringField(record, 'kanbanBoardId') ?? stringField(record, 'boardId');
    const input: ChronicleEventInput = {
      eventType: eventName,
      occurredAt: eventTime(record),
      scope: {
        ...context.scope,
        ...(sessionId ? { sessionId } : {}),
        ...(agentId ? { agentId } : {}),
        ...(taskId ? { taskId } : {}),
        ...(kanbanBoardId ? { kanbanBoardId } : {}),
      },
      correlation: {
        ...context.correlation,
        ...(stringField(record, 'traceId') ? { traceId: stringField(record, 'traceId')! } : {}),
        ...(stringField(record, 'toolCallId')
          ? { toolCallId: stringField(record, 'toolCallId') }
          : {}),
        ...(stringField(record, 'attemptId')
          ? { attemptId: stringField(record, 'attemptId') }
          : {}),
        ...(stringField(record, 'logicalRequestId')
          ? { logicalRequestId: stringField(record, 'logicalRequestId') }
          : {}),
        ...(stringField(record, 'promptManifestId')
          ? { promptManifestId: stringField(record, 'promptManifestId') }
          : {}),
      },
      outcome: inferOutcome(eventName, record),
      runtime: {
        ...((stringField(record, 'providerId') ?? stringField(record, 'provider'))
          ? { providerId: stringField(record, 'providerId') ?? stringField(record, 'provider') }
          : {}),
        ...((stringField(record, 'modelId') ?? stringField(record, 'model'))
          ? { modelId: stringField(record, 'modelId') ?? stringField(record, 'model') }
          : {}),
      },
      resource: inferResource(record, eventName),
      attributes: sanitize(record) as Record<string, unknown>,
      tags: { collector: 'eventbus-domain', family: eventName.split('.')[0] ?? 'unknown' },
    };
    void options.journal.append(input).catch((error) => options.onPersistError?.(error, input));
  });
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : { value };
}
/** Persisted-copy-only dedup: an `injected` memory already present in
 *  `activated` is replaced with an id reference instead of its full
 *  (byte-identical) metadata. Never mutates `record`/its arrays — the same
 *  payload reference is also handed to other live EventBus subscribers
 *  (packages/tui/src/memory-context-monitor.ts, the WebUI memory injector
 *  store) that read full fields off `injected` and must see them intact. */
function dedupInjectorTrace(record: Record<string, unknown>): Record<string, unknown> {
  const activated = Array.isArray(record.activated) ? record.activated : [];
  const injected = Array.isArray(record.injected) ? record.injected : [];
  const activatedIds = new Set(
    activated
      .map((item) => (item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string'),
  );
  return {
    ...record,
    injected: injected.map((item) => {
      const id = item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined;
      return typeof id === 'string' && activatedIds.has(id) ? { id, ref: 'activated' } : item;
    }),
  };
}
function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === 'string' ? (value[key] as string) : undefined;
}
function eventTime(value: Record<string, unknown>): string | undefined {
  const raw = value.at ?? value.ts ?? value.timestamp;
  if (typeof raw === 'number' && Number.isFinite(raw)) return new Date(raw).toISOString();
  if (typeof raw === 'string' && Number.isFinite(Date.parse(raw)))
    return new Date(raw).toISOString();
  return undefined;
}
function inferOutcome(name: string, payload: Record<string, unknown>): ChronicleOutcome {
  if (
    payload.ok === false ||
    /(?:failed|error|damaged|conflict|deadlock|denied|rejected|blocked)$/.test(name)
  )
    return 'failure';
  if (/(?:started|starting|retrying|threshold_reached)$/.test(name)) return 'started';
  if (/(?:cancelled|aborted)$/.test(name)) return 'cancelled';
  if (
    /(?:completed|finished|committed|merged|written|persisted|accepted|recovered|verified|connected|success)$/.test(
      name,
    ) ||
    payload.ok === true
  )
    return 'success';
  return 'unknown';
}
function inferResource(
  payload: Record<string, unknown>,
  eventName?: string,
): ChronicleResourceRef | undefined {
  // file.event's resource IS the file — its taskId/boardId are scope, not the
  // subject. Without this the generic candidate order would pick kind 'task'
  // and drop resource.path, breaking path-filtered lineage queries.
  if (
    eventName === 'file.event' &&
    typeof payload.filePath === 'string' &&
    payload.filePath.length > 0
  ) {
    return { kind: 'file', id: `path:${payload.filePath}`, path: payload.filePath };
  }
  const candidates: Array<[ChronicleResourceRef['kind'], string, unknown]> = [
    ['memory', 'memoryId', payload.memoryId],
    ['task', 'taskId', payload.taskId],
    ['kanban', 'boardId', payload.boardId ?? payload.runId],
    ['artifact', 'worktreeId', payload.worktreeId ?? payload.handleId],
    ['file', 'path', payload.filePath ?? payload.path],
    ['other', 'agentId', payload.agentId ?? payload.subagentId],
    ['network', 'serverAddress', payload.serverAddress],
    ['other', 'sessionId', payload.sessionId],
  ];
  const found = candidates.find(([, , value]) => typeof value === 'string' && value.length > 0);
  if (!found) return undefined;
  const [kind, label, value] = found as [ChronicleResourceRef['kind'], string, string];
  return { kind, id: `${label}:${value}`, ...(kind === 'file' ? { path: value } : {}) };
}

function sanitize(value: unknown, key = '', depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return { type: 'function' };
  if (typeof value === 'string') {
    if (PRESERVE_STRING_KEY.test(key) && !SENSITIVE_KEY.test(key)) return value.slice(0, 512);
    if (SENSITIVE_KEY.test(key))
      return { hash: digest(value), length: value.length, redacted: true };
    return value.length <= 256
      ? value
      : { hash: digest(value), length: value.length, truncated: true };
  }
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return { circular: true };
  if (depth >= 5) return { hash: digest(safeString(value)), depthLimited: true };
  seen.add(value);
  if (Array.isArray(value)) {
    const cap = TRUNCATED_ARRAYS.has(key) ? TRUNCATED_ARRAY_MAX : DEFAULT_ARRAY_MAX;
    const items = value.slice(0, cap).map((item) => sanitize(item, key, depth + 1, seen));
    return value.length > cap ? { items, total: value.length, truncated: true } : items;
  }
  const output: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [childKey, child] of entries.slice(0, 100)) {
    if (
      childKey === 'ctx' ||
      childKey === 'provider' ||
      childKey === 'resolve' ||
      childKey === 'extend' ||
      childKey === 'deny'
    )
      continue;
    output[childKey] = sanitize(child, childKey, depth + 1, seen);
  }
  if (entries.length > 100) output._truncatedKeys = entries.length - 100;
  return output;
}
function safeString(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
