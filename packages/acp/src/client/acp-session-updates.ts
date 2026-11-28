import type { ACPMessage } from '../types/acp-messages.js';
import type {
  AnySessionUpdate,
  AvailableCommand,
  PlanEntry,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
  UsageCost,
} from '../types/acp-v1.js';
import { acpRuntimeOptions } from './acp-runtime-options.js';
import { extractText, isRecord } from './acp-session-content.js';
import type {
  ACPCapturedDiff,
  ACPCapturedToolCall,
  ACPProgressEvent,
} from './acp-session-types.js';

export interface ACPSessionScratch {
  text: string;
  thoughts: string;
  plan?: PlanEntry[];
  usage?: { used: number; size: number; cost?: UsageCost | undefined };
  toolCalls: Map<string, ACPCapturedToolCall>;
  diffs: ACPCapturedDiff[];
  /**
   * Set when a tool call ran after the last message text: the next text
   * chunk starts a new assistant message, not a continuation.
   */
  messageBreak?: boolean;
  /** Diffs already captured, keyed by tool call; agents resend them on update. */
  seenDiffs?: Set<string>;
  /** Tool calls already reported as started (see captureToolCall). */
  announced?: Set<string>;
}

export function createSessionScratch(): ACPSessionScratch {
  return { text: '', thoughts: '', toolCalls: new Map(), diffs: [] };
}

/** Separates two assistant messages that a tool call split apart. */
const MESSAGE_SEPARATOR = '\n\n';

export function handleAcpSessionUpdate(
  msg: ACPMessage,
  scratch: ACPSessionScratch,
  emitProgress: (event: ACPProgressEvent) => void,
): void {
  const update = (msg as { params?: { update?: unknown } }).params?.update;
  if (typeof update !== 'object' || update === null) return;
  const u = update as { sessionUpdate?: string; [k: string]: unknown };
  emitProgress({ type: 'raw', update: u as AnySessionUpdate });
  switch (u.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = extractText(u.content);
      if (text) {
        // Without a separator, "…the checkout path.Now I'll run…" reads as one
        // garbled sentence in the result WrongStack hands back.
        if (scratch.messageBreak && scratch.text && !/\s$/.test(scratch.text)) {
          scratch.text += MESSAGE_SEPARATOR;
        }
        scratch.messageBreak = false;
        scratch.text += text;
        emitProgress({ type: 'message', text });
      }
      return;
    }
    case 'agent_thought_chunk':
    case 'thought_chunk': {
      const text = extractText(u.content);
      if (text) {
        scratch.thoughts += text;
        emitProgress({ type: 'thought', text });
      }
      return;
    }
    case 'tool_call':
    case 'tool_call_update':
      captureToolCall(u, u.sessionUpdate === 'tool_call', scratch, emitProgress);
      return;
    case 'plan':
      if (Array.isArray(u.entries)) {
        scratch.plan = u.entries as PlanEntry[];
        emitProgress({ type: 'plan', entries: u.entries as PlanEntry[] });
      }
      return;
    case 'usage_update': {
      const rateLimit = (u._meta as Record<string, unknown> | undefined)?.['_claude/rateLimit'];
      if (isRecord(rateLimit)) emitProgress({ type: 'rate_limit', info: rateLimit });
      if (
        typeof u.used === 'number' &&
        Number.isFinite(u.used) &&
        u.used >= 0 &&
        typeof u.size === 'number' &&
        Number.isFinite(u.size) &&
        u.size >= 0
      ) {
        const usage = {
          used: u.used,
          size: u.size,
          ...(typeof u.cost === 'object' && u.cost !== null ? { cost: u.cost as UsageCost } : {}),
        };
        scratch.usage = usage;
        emitProgress({ type: 'usage', usage });
      }
      return;
    }
    case 'available_commands_update': {
      if (Array.isArray(u.availableCommands)) {
        const commands = u.availableCommands.filter(
          (c): c is AvailableCommand =>
            isRecord(c) && typeof c['name'] === 'string' && c['name'].length > 0,
        );
        emitProgress({ type: 'commands', commands });
      }
      return;
    }
    case 'current_mode_update': {
      const modeId =
        typeof u.currentModeId === 'string'
          ? u.currentModeId
          : typeof u.modeId === 'string'
            ? u.modeId
            : undefined;
      if (modeId) emitProgress({ type: 'mode', modeId });
      return;
    }
    case 'config_option_update': {
      const options = acpRuntimeOptions(u.configOptions);
      emitProgress({ type: 'config_options', options });
      return;
    }
    case 'session_info_update': {
      emitProgress({
        type: 'session_info',
        ...(u.title !== undefined ? { title: u.title as string | null } : {}),
        ...(u.updatedAt !== undefined ? { updatedAt: u.updatedAt as string | null } : {}),
      });
      return;
    }
    case 'user_message_chunk':
    case 'next_edit_suggestions':
    case 'elicitation':
      return;
    default:
      return;
  }
}

/** A tool call update's result text: its `content` text blocks, else a text `rawOutput`. */
function toolOutputText(u: { [k: string]: unknown }): string | undefined {
  const joined = (blocks: unknown[]): string =>
    blocks
      .map(extractText)
      .filter((text) => text.length > 0)
      .join('\n');
  if (Array.isArray(u.content)) {
    const text = joined(
      (u.content as ToolCallContent[]).map((c) =>
        c && typeof c === 'object' && c.type === 'content' ? c.content : undefined,
      ),
    );
    if (text) return text;
  }
  if (typeof u.rawOutput === 'string') return u.rawOutput || undefined;
  if (Array.isArray(u.rawOutput)) return joined(u.rawOutput) || undefined;
  return undefined;
}

/** Diffs kept on one tool call's record (all of them still go to `scratch.diffs`). */
const MAX_CALL_DIFFS = 20;

function captureToolCall(
  u: { [k: string]: unknown },
  isNew: boolean,
  scratch: ACPSessionScratch,
  emitProgress: (event: ACPProgressEvent) => void,
): void {
  const toolCallId = typeof u.toolCallId === 'string' ? u.toolCallId : '';
  if (!toolCallId) return;
  const prev = scratch.toolCalls.get(toolCallId);
  const locations = Array.isArray(u.locations)
    ? (u.locations.filter(
        (loc): loc is ToolCallLocation =>
          isRecord(loc) && typeof loc['path'] === 'string' && loc['path'].length > 0,
      ) as ToolCallLocation[])
    : undefined;
  const terminalIds = Array.isArray(u.content)
    ? (u.content as ToolCallContent[])
        .filter(
          (c): c is Extract<ToolCallContent, { type: 'terminal' }> =>
            isRecord(c) && c['type'] === 'terminal' && typeof c['terminalId'] === 'string',
        )
        .map((c) => c.terminalId)
    : undefined;
  const mergedTerminals =
    terminalIds && terminalIds.length > 0
      ? Array.from(new Set([...(prev?.terminalIds ?? []), ...terminalIds]))
      : prev?.terminalIds;

  const record: ACPCapturedToolCall = {
    toolCallId,
    title: typeof u.title === 'string' ? u.title : (prev?.title ?? toolCallId),
    kind: typeof u.kind === 'string' ? (u.kind as ToolKind) : prev?.kind,
    status:
      typeof u.status === 'string'
        ? (u.status as ToolCallStatus)
        : (prev?.status ?? (isNew ? 'pending' : 'in_progress')),
    rawInput: isRecord(u.rawInput) ? u.rawInput : prev?.rawInput,
    rawOutput: isRecord(u.rawOutput) ? u.rawOutput : prev?.rawOutput,
    output: toolOutputText(u) ?? prev?.output,
    ...(locations && locations.length > 0
      ? { locations }
      : prev?.locations
        ? { locations: prev.locations }
        : {}),
    ...(mergedTerminals && mergedTerminals.length > 0 ? { terminalIds: mergedTerminals } : {}),
    ...(prev?.diffs ? { diffs: prev.diffs } : {}),
  };
  scratch.toolCalls.set(toolCallId, record);
  if (scratch.text) scratch.messageBreak = true;

  if (Array.isArray(u.content)) {
    for (const c of u.content as ToolCallContent[]) {
      if (c && typeof c === 'object' && c.type === 'diff') {
        // Claude's adapter repeats the edit's diff on the completing update.
        const key = `${toolCallId}\0${c.path}\0${c.oldText ?? ''}\0${c.newText}`;
        scratch.seenDiffs ??= new Set();
        if (scratch.seenDiffs.has(key)) continue;
        scratch.seenDiffs.add(key);
        const diff: ACPCapturedDiff = {
          path: c.path,
          oldText: c.oldText,
          newText: c.newText,
        };
        scratch.diffs.push(diff);
        // Bounded: a call that rewrites many files keeps its first ones for display.
        if ((record.diffs?.length ?? 0) < MAX_CALL_DIFFS)
          record.diffs = [...(record.diffs ?? []), diff];
        emitProgress({ type: 'diff', diff });
      }
    }
  }

  // Report a call as started once it says what it does. Claude's adapter
  // opens every call as a bare "Terminal" / "Edit" with no input and sends the
  // command or path in the next update, so announcing on `tool_call` showed
  // live views a row of "Terminal {}". An agent that never sends input is
  // announced at its first update instead.
  scratch.announced ??= new Set();
  if (!scratch.announced.has(toolCallId)) {
    const hasInput = record.rawInput !== undefined && Object.keys(record.rawInput).length > 0;
    if (isNew && !hasInput) return;
    scratch.announced.add(toolCallId);
    emitProgress({ type: 'tool_call', toolCall: record });
    // Announced by an update that already ended the call: report the end too.
    if (isNew || (record.status !== 'completed' && record.status !== 'failed')) return;
  }
  emitProgress({ type: 'tool_call_update', toolCall: record });
}
