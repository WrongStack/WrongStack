import type { ContentBlock, SessionEvent, SessionSummary } from '@wrongstack/core/types';

/**
 * Stable WebSocket projection for the WebUI history surfaces.
 *
 * Keep this mapping shared by the standalone and CLI-hosted WebUI servers so
 * an initial list, rename refresh, and delete refresh cannot silently expose
 * different session metadata.
 */
export interface SessionHistoryWireEntry {
  id: string;
  title: string;
  name?: string | undefined;
  startedAt: string;
  endedAt?: string | undefined;
  model: string;
  provider: string;
  tokenTotal: number;
  lastActivityAt?: string | undefined;
  messageCount?: number | undefined;
  lastUserMessage?: string | undefined;
  iterationCount?: number | undefined;
  toolCallCount?: number | undefined;
  toolErrorCount?: number | undefined;
  fileChangeCount?: number | undefined;
  toolBreakdown?: Record<string, number> | undefined;
  compactionCount?: number | undefined;
  outcome?: SessionSummary['outcome'];
  isCurrent: boolean;
}

// ── Session Inspection Payload ─────────────────────────────────────────
// Payload returned by session.inspect. The handler loads the JSONL,
// extracts every SessionEvent, and summarises them into a typed shape the
// frontend can render without any domain knowledge of the event union.

/**
 * Extract a preview string from a single content block. The discriminated
 * union of ContentBlock kinds each carry their preview under a different
 * field (`text`, `thinking`, `content`); anything else falls back to a
 * labelled placeholder.
 */
function blockText(block: ContentBlock | string): string {
  if (typeof block === 'string') return block;
  switch (block.type) {
    case 'text':
      return block.text;
    case 'thinking':
      return block.thinking;
    case 'tool_use':
      return `[tool:${block.name}]`;
    case 'tool_result':
      return block.content;
    case 'image':
      return '[image]';
    default: {
      const _exhaustive: never = block;
      void _exhaustive;
      return '[block]';
    }
  }
}

interface SessionInspectEvent {
  ts: string;
  type: SessionEvent['type'];
  label: string;
  detail: string;
}

interface SessionInspectFileEntry {
  operation: string;
  filePath: string;
  toolName: string;
  ts: string;
}

interface SessionInspectPayload {
  id: string;
  title: string;
  name?: string | undefined;
  model: string;
  provider: string;
  startedAt: string;
  endedAt?: string | undefined;
  tokenTotal: number;
  outcome?: SessionSummary['outcome'];
  messageCount: number;
  iterationCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  fileChangeCount: number;
  compactionCount: number;
  toolBreakdown: Record<string, number>;
  events: SessionInspectEvent[];
  fileEvents: SessionInspectFileEntry[];
  lastUserMessage?: string | undefined;
}

function labelForEvent(e: SessionEvent): string {
  switch (e.type) {
    case 'session_start':
      return 'Session started';
    case 'session_resumed':
      return 'Session resumed';
    case 'session_forked':
      return `Forked from ${e.parentSessionId}`;
    case 'user_input': {
      const content =
        typeof e.content === 'string'
          ? e.content
          : Array.isArray(e.content)
            ? e.content.map(blockText).join('')
            : '[input]';
      return `User: ${content.length > 100 ? content.slice(0, 100) + '…' : content}`;
    }
    case 'llm_request':
      return 'LLM request';
    case 'llm_response':
      return 'LLM response';
    case 'tool_use':
      return `Tool: ${e.name}`;
    case 'tool_call_start':
      return `Tool start: ${e.name}`;
    case 'tool_call_end':
      return `Tool done: ${e.name} (${e.durationMs}ms, ${e.ok === false ? 'error' : 'ok'})`;
    case 'tool_result':
      return `Tool result: ${e.id}${e.isError ? ' (error)' : ''}`;
    case 'tool_progress':
      return `Progress: ${e.name} — ${e.event.type}`;
    case 'compaction':
      return `Compaction: ${e.before} → ${e.after} tokens`;
    case 'context_snapshot':
      return 'Context snapshot';
    case 'error':
      return `Error: ${e.message.length > 100 ? e.message.slice(0, 100) + '…' : e.message}`;
    case 'session_end':
      return 'Session ended';
    case 'message_appended':
      return `Message appended: ${e.message.role}`;
    case 'message_updated':
      return 'Message updated';
    case 'messages_replaced': {
      const count = e.messagesOmitted ?? e.messages.length;
      return `Messages replaced (${e.messagesOmitted ? '~' : ''}${count} msgs)`;
    }
    case 'messages_dropped':
      return `Oldest ${e.count} message${e.count === 1 ? '' : 's'} evicted`;
    case 'message_truncated':
      return `Message truncated: ${e.before} → ${e.after}`;
    case 'file_event':
      return `File ${e.operation}: ${e.filePath} (${e.toolName})`;
    case 'file_snapshot':
      return `File snapshot at prompt #${e.promptIndex}`;
    case 'file_observation':
      return `File observation: ${e.path}`;
    case 'rewound':
      return `Rewound to prompt #${e.toPromptIndex} (${e.revertedFiles.length} files)`;
    case 'mode_changed':
      return `Mode: ${e.from} → ${e.to}`;
    case 'task_created':
      return `Task created: ${e.title}`;
    case 'task_updated':
      return `Task ${e.taskId}: ${e.status}`;
    case 'task_completed':
      return `Task done: ${e.title}`;
    case 'task_failed':
      return `Task failed: ${e.title} — ${e.error.length > 80 ? e.error.slice(0, 80) + '…' : e.error}`;
    case 'agent_spawned':
      return `Agent spawned: ${e.role}`;
    case 'agent_stopped':
      return 'Agent stopped';
    case 'agent_error':
      return `Agent error: ${e.error.length > 80 ? e.error.slice(0, 80) + '…' : e.error}`;
    case 'provider_retry':
      return `Retry: ${e.description} (attempt ${e.attempt})`;
    case 'provider_error':
      return `Provider error: ${e.description}`;
    case 'checkpoint':
      return `Checkpoint at prompt #${e.promptIndex}`;
    case 'in_flight_start':
      return `In-flight started: ${e.context}`;
    case 'in_flight_end':
      return `In-flight ended: ${e.reason}`;
    case 'side_effect':
      return `Side effect: ${e.toolName} (${e.risk})`;
    case 'delegate_started':
      return `Delegated to ${e.target}`;
    case 'delegate_completed':
      return `Delegation ${e.ok ? 'finished' : 'failed'}: ${e.target}`;
    case 'loop_detected':
      return `Loop detected (${e.action ?? 'cut'})`;
    case 'model_switched':
      return `Model switched (${e.reason})`;
    case 'skill_activated':
      return `Skill: ${e.skillName}`;
    case 'skill_deactivated':
      return `Skill done: ${e.skillName}`;
    case 'agent_session_linked':
      return `Agent ${e.agentId} → session ${e.agentSessionId}`;
    default: {
      // Exhaustiveness check — fires typecheck error if a new event
      // kind is added without a case here. The `never` cast silences
      // the "Property 'type' does not exist on type 'never'" error
      // because TypeScript has already proven this branch is unreachable.
      const _exhaustive: never = e;
      void _exhaustive;
      return String(_exhaustive);
    }
  }
}

function detailForEvent(e: SessionEvent): string {
  switch (e.type) {
    case 'session_start':
      return `${e.model} @ ${e.provider}`;
    case 'session_resumed':
      return `${e.model} @ ${e.provider}`;
    case 'session_forked':
      return `parent checkpoint: ${e.parentCheckpointHash.slice(0, 12)}…`;
    case 'llm_request':
      return `${e.model} · ${e.messageCount} msgs · ${e.toolCount ?? '?'} tools`;
    case 'llm_response':
      return `${e.stopReason} · ${e.usage.input ?? 0}+${e.usage.output ?? 0} tokens`;
    case 'tool_use':
      return `id: ${e.id}`;
    case 'tool_call_start':
      return `id: ${e.id}`;
    case 'tool_call_end':
      return `${(e.outputBytes ?? e.outputSize ?? 0).toLocaleString()} B · ${e.outputLines ?? 0} lines`;
    case 'tool_progress':
      return `${e.event.type}${e.event.text ? `: ${e.event.text}` : ''}`;
    case 'compaction':
      return `saved ~${Math.max(0, e.before - e.after)} tokens`;
    case 'context_snapshot':
      return `${e.messages.length} msgs${e.messagesOmitted ? ` (${e.messagesOmitted} omitted)` : ''}`;
    case 'error':
      return `phase: ${e.phase}`;
    case 'session_end':
      return `${e.usage.input ?? 0}+${e.usage.output ?? 0} total tokens`;
    case 'message_appended':
      return `appended ${e.message.role}`;
    case 'message_updated':
      return `at index ${e.index}`;
    case 'messages_replaced':
      return `${e.messagesOmitted ?? e.messages.length} total`;
    case 'messages_dropped':
      return `dropped ${e.count} from the front`;
    case 'message_truncated':
      return `truncated to ${e.after} tokens`;
    case 'mode_changed':
      return `${e.from} → ${e.to}`;
    case 'task_created':
      return `id: ${e.taskId}`;
    case 'task_updated':
      return `${e.taskId}: ${e.status}`;
    case 'task_completed':
      return `${e.taskId}`;
    case 'task_failed':
      return `${e.taskId}: ${e.error}`;
    case 'agent_spawned':
      return `id: ${e.agentId} (${e.role})`;
    case 'agent_stopped':
      return `id: ${e.agentId}`;
    case 'agent_error':
      return `id: ${e.agentId}: ${e.error}`;
    case 'file_event':
      return `${e.filePath} (${e.toolName})`;
    case 'file_snapshot':
      return `${e.files.length} files at prompt #${e.promptIndex}`;
    case 'file_observation':
      return `${e.source === 'user' ? 'user-saved' : 'tool-written'} at ${e.path}`;
    case 'rewound':
      return `${e.revertedFiles.length} files reverted`;
    case 'in_flight_start':
      return e.context;
    case 'in_flight_end':
      return `${e.reason}`;
    case 'side_effect':
      return `${e.toolName} (${e.risk})${e.outcome ? `: ${e.outcome}` : ''}`;
    case 'provider_retry':
      return `delay ${e.delayMs}ms${e.status ? ` · HTTP ${e.status}` : ''}`;
    case 'provider_error':
      return `${e.retryable ? 'retryable' : 'fatal'}${e.status ? ` · HTTP ${e.status}` : ''}`;
    case 'user_input':
      return typeof e.content === 'string'
        ? `${e.content.length} chars`
        : `${e.content.length} blocks`;
    case 'tool_result':
      return `${e.isError ? 'error' : 'ok'}`;
    case 'checkpoint':
      return `prompt #${e.promptIndex}`;
    case 'delegate_started':
      return e.task.length > 80 ? `${e.task.slice(0, 79)}…` : e.task;
    case 'delegate_completed':
      return `${e.summary} · ${e.iterations} iterations · ${e.toolCalls} tools`;
    case 'loop_detected':
      return `${e.tools || 'message'} ×${e.repeatCount} at iteration ${e.iteration}`;
    case 'model_switched':
      return `${e.from ? `${e.from.providerId}/${e.from.model} → ` : ''}${e.to.providerId}/${e.to.model}`;
    case 'skill_activated':
      return `at ${e.skillName}`;
    case 'skill_deactivated':
      return `at ${e.skillName}`;
    case 'agent_session_linked':
      return e.agentSessionId;
    default: {
      // Exhaustiveness check — fires typecheck error if a new SessionEvent
      // kind is added without a label case here.
      const _exhaustive: never = e;
      void _exhaustive;
      return '';
    }
  }
}

export function buildInspectPayload(
  summary: SessionSummary | undefined,
  events: SessionEvent[],
  fallback: {
    id: string;
    title: string;
    model: string;
    provider: string;
    startedAt: string;
    endedAt?: string | undefined;
  },
): SessionInspectPayload {
  const inspectEvents: SessionInspectEvent[] = events.map((e) => ({
    ts: e.ts,
    type: e.type,
    label: labelForEvent(e),
    detail: detailForEvent(e),
  }));

  const fileEvents: SessionInspectFileEntry[] = [];
  let computedToolCallCount = 0;
  let computedToolErrorCount = 0;
  let computedFileChangeCount = 0;
  let computedCompactionCount = 0;
  let computedMessageCount = 0;
  let computedIterationCount = 0;
  const computedToolBreakdown: Record<string, number> = {};
  for (const e of events) {
    if (e.type === 'file_event') {
      fileEvents.push({
        operation: e.operation,
        filePath: e.filePath,
        toolName: e.toolName,
        ts: e.ts,
      });
      computedFileChangeCount++;
    } else if (e.type === 'tool_call_end') {
      computedToolCallCount++;
      if (e.ok === false) computedToolErrorCount++;
      computedToolBreakdown[e.name] = (computedToolBreakdown[e.name] ?? 0) + 1;
    } else if (e.type === 'compaction') {
      computedCompactionCount++;
    } else if (e.type === 'user_input') {
      computedMessageCount++;
    } else if (e.type === 'llm_response') {
      computedIterationCount++;
    }
  }

  const s = summary;
  return {
    id: s?.id ?? fallback.id,
    title: s?.title ?? fallback.title,
    ...(s?.name !== undefined ? { name: s.name } : {}),
    model: s?.model ?? fallback.model,
    provider: s?.provider ?? fallback.provider,
    startedAt: s?.startedAt ?? fallback.startedAt,
    ...((s?.endedAt ?? fallback.endedAt) !== undefined
      ? { endedAt: s?.endedAt ?? fallback.endedAt }
      : {}),
    tokenTotal: s?.tokenTotal ?? 0,
    ...(s?.outcome !== undefined ? { outcome: s.outcome } : {}),
    messageCount: s?.messageCount ?? computedMessageCount,
    iterationCount: s?.iterationCount ?? computedIterationCount,
    toolCallCount: s?.toolCallCount ?? computedToolCallCount,
    toolErrorCount: s?.toolErrorCount ?? computedToolErrorCount,
    fileChangeCount: s?.fileChangeCount ?? computedFileChangeCount,
    compactionCount: s?.compactionCount ?? computedCompactionCount,
    toolBreakdown: s?.toolBreakdown ?? computedToolBreakdown,
    events: inspectEvents,
    fileEvents,
    ...(s?.lastUserMessage !== undefined ? { lastUserMessage: s.lastUserMessage } : {}),
  };
}

export function toSessionHistoryEntry(
  summary: SessionSummary,
  currentSessionId: string,
): SessionHistoryWireEntry {
  return {
    id: summary.id,
    title: summary.title,
    ...(summary.name !== undefined ? { name: summary.name } : {}),
    startedAt: summary.startedAt,
    ...(summary.endedAt !== undefined ? { endedAt: summary.endedAt } : {}),
    model: summary.model,
    provider: summary.provider,
    tokenTotal: summary.tokenTotal,
    ...(summary.lastActivityAt !== undefined ? { lastActivityAt: summary.lastActivityAt } : {}),
    ...(summary.messageCount !== undefined ? { messageCount: summary.messageCount } : {}),
    ...(summary.lastUserMessage !== undefined ? { lastUserMessage: summary.lastUserMessage } : {}),
    ...(summary.iterationCount !== undefined ? { iterationCount: summary.iterationCount } : {}),
    ...(summary.toolCallCount !== undefined ? { toolCallCount: summary.toolCallCount } : {}),
    ...(summary.toolErrorCount !== undefined ? { toolErrorCount: summary.toolErrorCount } : {}),
    ...(summary.fileChangeCount !== undefined ? { fileChangeCount: summary.fileChangeCount } : {}),
    ...(summary.toolBreakdown !== undefined ? { toolBreakdown: summary.toolBreakdown } : {}),
    ...(summary.compactionCount !== undefined ? { compactionCount: summary.compactionCount } : {}),
    ...(summary.outcome !== undefined ? { outcome: summary.outcome } : {}),
    isCurrent: summary.id === currentSessionId,
  };
}

export function toSessionHistoryEntries(
  summaries: SessionSummary[],
  currentSessionId: string,
): SessionHistoryWireEntry[] {
  return summaries.map((summary) => toSessionHistoryEntry(summary, currentSessionId));
}
