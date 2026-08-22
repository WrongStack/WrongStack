import type { ACPMessage } from '../types/acp-messages.js';
import type {
  AnySessionUpdate,
  PlanEntry,
  ToolCallContent,
  ToolCallStatus,
  ToolKind,
  UsageCost,
} from '../types/acp-v1.js';
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
}

export function createSessionScratch(): ACPSessionScratch {
  return { text: '', thoughts: '', toolCalls: new Map(), diffs: [] };
}

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
        scratch.text += text;
        emitProgress({ type: 'message', text });
      }
      return;
    }
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
    case 'usage_update':
      if (typeof u.used === 'number' && typeof u.size === 'number') {
        const usage = {
          used: u.used,
          size: u.size,
          ...(typeof u.cost === 'object' && u.cost !== null ? { cost: u.cost as UsageCost } : {}),
        };
        scratch.usage = usage;
        emitProgress({ type: 'usage', usage });
      }
      return;
    case 'available_commands_update':
    case 'current_mode_update':
    case 'config_option_update':
    case 'session_info_update':
    case 'user_message_chunk':
    case 'next_edit_suggestions':
    case 'elicitation':
      return;
    default:
      return;
  }
}

function captureToolCall(
  u: { [k: string]: unknown },
  isNew: boolean,
  scratch: ACPSessionScratch,
  emitProgress: (event: ACPProgressEvent) => void,
): void {
  const toolCallId = typeof u.toolCallId === 'string' ? u.toolCallId : '';
  if (!toolCallId) return;
  const prev = scratch.toolCalls.get(toolCallId);
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
  };
  scratch.toolCalls.set(toolCallId, record);

  if (Array.isArray(u.content)) {
    for (const c of u.content as ToolCallContent[]) {
      if (c && typeof c === 'object' && c.type === 'diff') {
        const diff: ACPCapturedDiff = {
          path: c.path,
          oldText: c.oldText,
          newText: c.newText,
        };
        scratch.diffs.push(diff);
        emitProgress({ type: 'diff', diff });
      }
    }
  }

  emitProgress({
    type: isNew ? 'tool_call' : 'tool_call_update',
    toolCall: record,
  });
}
