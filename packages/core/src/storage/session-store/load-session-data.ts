import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { EventBus } from '../../kernel/events.js';
import type { ContentBlock } from '../../types/blocks.js';
import type { Message } from '../../types/messages.js';
import type { SecretScrubber } from '../../types/secret-scrubber.js';
import type { SessionData, SessionEvent, SessionMetadata } from '../../types/session.js';
import { repairToolUseAdjacency } from '../../utils/message-invariants.js';
import {
  applyContextSnapshot,
  replayableMessage,
  trackMessageToolState,
} from './replay.js';
import { scrubPersistedSessionEvent } from '../session-read-scrubber.js';
import { extractToolCallEnds } from '../session-tool-call-ends.js';

type UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number };

export async function loadSessionDataFromFile(params: {
  id: string;
  file: string;
  full: boolean;
  events?: EventBus | undefined;
  secretScrubber: SecretScrubber;
}): Promise<SessionData> {
  const events: SessionEvent[] = [];
  let sessionStartEvent: SessionEvent | undefined;
  let sessionEndEvent: SessionEvent | undefined;
  let sessionModel: string | undefined;
  let sessionProvider: string | undefined;
  let sessionPendingToolUses: string[] | undefined;
  let sessionForkedEvent: Extract<SessionEvent, { type: 'session_forked' }> | undefined;
  const messages: Message[] | undefined = params.full ? [] : undefined;
  const openToolUses: Set<string> | undefined = params.full ? new Set<string>() : undefined;
  let exactJournalActive = false;
  let usage: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  const stream = createReadStream(params.file, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isSessionEventLike(parsed)) continue;
        const ev = scrubPersistedSessionEvent(parsed as SessionEvent, params.secretScrubber);
        events.push(ev);

        if (ev.type === 'session_start' && !sessionStartEvent) {
          sessionStartEvent = ev;
          sessionModel = ev.model;
          sessionProvider = ev.provider;
        }
        if (ev.type === 'session_end') {
          sessionEndEvent = ev;
          sessionPendingToolUses = ev.pendingToolUses;
        }
        if (ev.type === 'session_forked' && !sessionForkedEvent) {
          sessionForkedEvent = ev;
        }

        if (params.full && messages !== undefined && openToolUses !== undefined) {
          const replayState = replaySessionEvent({
            ev,
            id: params.id,
            events: params.events,
            messages,
            openToolUses,
            exactJournalActive,
            usage,
          });
          exactJournalActive = replayState.exactJournalActive;
          usage = replayState.usage ?? usage;
        } else if (ev.type === 'llm_response') {
          usage = accumulateUsage(usage, ev);
        }
      } catch {
        // skip malformed JSON
      }
    }
  } finally {
    rl.close();
    stream.close();
  }

  let finalMessages: Message[] = [];
  if (params.full && messages !== undefined && openToolUses !== undefined) {
    if (openToolUses.size > 0) {
      params.events?.emit('session.damaged', {
        sessionId: params.id,
        detail: `${openToolUses.size} tool_use blocks without matching results - replay repaired`,
      });
    }
    const repaired = repairToolUseAdjacency(messages);
    if (repaired.report.changed) {
      params.events?.emit('session.damaged', {
        sessionId: params.id,
        detail:
          `Repaired replay adjacency: removed ${repaired.report.removedToolUses.length} tool_use, ` +
          `${repaired.report.removedToolResults.length} tool_result, ` +
          `${repaired.report.removedMessages} empty messages`,
      });
    }
    finalMessages = repaired.messages;
  }

  const meta: SessionMetadata = {
    id: params.id,
    startedAt: sessionStartEvent?.ts ?? new Date(0).toISOString(),
    endedAt: sessionEndEvent?.ts,
    model: sessionModel,
    provider: sessionProvider,
    pendingToolUses: sessionPendingToolUses,
    forkedFrom: sessionForkedEvent
      ? {
          sessionId: sessionForkedEvent.parentSessionId,
          checkpointPromptIndex: sessionForkedEvent.parentCheckpointPromptIndex,
          checkpointHash: sessionForkedEvent.parentCheckpointHash,
          workspace: sessionForkedEvent.workspace,
          workspaceCheckpointHash: sessionForkedEvent.workspaceCheckpointHash,
        }
      : undefined,
  };

  const toolCallEnds = extractToolCallEnds(events);
  const pendingToolUseCount =
    openToolUses && openToolUses.size > 0 ? openToolUses.size : undefined;
  return {
    metadata: meta,
    events,
    messages: finalMessages,
    usage,
    toolCallEnds,
    ...(pendingToolUseCount !== undefined ? { pendingToolUseCount } : {}),
  };
}

function isSessionEventLike(value: unknown): value is SessionEvent {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { type?: unknown | undefined }).type === 'string' &&
    typeof (value as { ts?: unknown | undefined }).ts === 'string'
  );
}

function replaySessionEvent(params: {
  ev: SessionEvent;
  id: string;
  events?: EventBus | undefined;
  messages: Message[];
  openToolUses: Set<string>;
  exactJournalActive: boolean;
  usage: UsageTotals;
}): { exactJournalActive: boolean; usage?: UsageTotals } {
  const { ev, messages, openToolUses } = params;
  let exactJournalActive = params.exactJournalActive;

  if (ev.type === 'message_appended' && ev.version === 1) {
    const message = replayableMessage(ev.message, ev.ts);
    if (message) {
      if (!exactJournalActive) {
        messages.length = 0;
        openToolUses.clear();
        exactJournalActive = true;
      }
      messages.push(message);
      trackMessageToolState(message, openToolUses);
    } else {
      emitDamaged(params, 'Ignored malformed message_appended event');
    }
  } else if (ev.type === 'message_updated' && ev.version === 1) {
    const message = replayableMessage(ev.message, ev.ts);
    if (message && exactJournalActive && ev.index >= 0 && ev.index < messages.length) {
      messages[ev.index] = message;
      openToolUses.clear();
      for (const current of messages) trackMessageToolState(current, openToolUses);
    } else {
      emitDamaged(params, `Ignored malformed message_updated event at index ${ev.index}`);
    }
  } else if (ev.type === 'messages_replaced' && ev.version === 1) {
    if (applyContextSnapshot(messages, openToolUses, ev.messages)) {
      exactJournalActive = true;
    } else {
      emitDamaged(params, 'Ignored malformed messages_replaced event');
    }
  } else if (ev.type === 'context_snapshot') {
    if (!applyContextSnapshot(messages, openToolUses, ev.messages)) {
      emitDamaged(params, 'Ignored malformed context_snapshot event');
    }
  } else if (!exactJournalActive && ev.type === 'user_input') {
    openToolUses.clear();
    messages.push({ role: 'user', content: ev.content, ts: ev.ts });
  } else if (ev.type === 'llm_response') {
    if (!exactJournalActive) {
      messages.push({ role: 'assistant', content: ev.content, ts: ev.ts });
      for (const b of ev.content) {
        if (b.type === 'tool_use') openToolUses.add(b.id);
      }
    }
    return { exactJournalActive, usage: accumulateUsage(params.usage, ev) };
  } else if (!exactJournalActive && ev.type === 'tool_result') {
    if (!openToolUses.has(ev.id)) {
      emitDamaged(params, `Orphan tool_result "${ev.id}" has no matching tool_use`);
      return { exactJournalActive };
    }
    openToolUses.delete(ev.id);
    const resultBlock: ContentBlock = {
      type: 'tool_result',
      tool_use_id: ev.id,
      content: typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content),
      is_error: ev.isError,
    };
    const last = messages[messages.length - 1];
    const lastIsToolResultUser =
      last?.role === 'user' &&
      Array.isArray(last.content) &&
      last.content.every((b) => (b as ContentBlock).type === 'tool_result');
    if (lastIsToolResultUser && Array.isArray(last.content)) {
      last.content.push(resultBlock);
    } else {
      messages.push({ role: 'user', content: [resultBlock], ts: ev.ts });
    }
  }

  return { exactJournalActive };
}

function accumulateUsage(
  usage: UsageTotals,
  ev: Extract<SessionEvent, { type: 'llm_response' }>,
): UsageTotals {
  return {
    input: usage.input + (ev.usage.input ?? 0),
    output: usage.output + (ev.usage.output ?? 0),
    cacheRead: (usage.cacheRead ?? 0) + (ev.usage.cacheRead ?? 0),
    cacheWrite: (usage.cacheWrite ?? 0) + (ev.usage.cacheWrite ?? 0),
  };
}

function emitDamaged(
  params: { id: string; events?: EventBus | undefined },
  detail: string,
): void {
  params.events?.emit('session.damaged', {
    sessionId: params.id,
    detail,
  });
}
