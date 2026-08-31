import { createReadStream } from 'node:fs';
import { stat as fspStat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { ContentBlock } from '../../types/blocks.js';
import type { Message } from '../../types/messages.js';
import type { SecretScrubber } from '../../types/secret-scrubber.js';
import type {
  SessionData,
  SessionEvent,
  SessionLoadProgress,
  SessionMetadata,
} from '../../types/session.js';
import { repairToolUseAdjacency } from '../../utils/message-invariants.js';
import type { EventBus } from '../event-bus-port.js';
import { scrubPersistedSessionEvent } from '../session-read-scrubber.js';
import { extractToolCallEnds } from '../session-tool-call-ends.js';
import { applyContextSnapshot, replayableMessage, trackMessageToolState } from './replay.js';

type UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number };

/**
 * Budget for the raw `events` array, in source bytes.
 *
 * `events` used to grow with the file, without limit. Measured, that is a
 * 1.88x heap multiplier over the JSONL — a 564 MB session (15 such files
 * exist in one real project) becomes ~1.03 GB of live objects for this array
 * alone, before `messages` and before parse garbage. Loading one was an OOM,
 * not a slow load.
 *
 * The budget keeps the newest events and drops the oldest, because everything
 * downstream of `events` is tail-oriented: the summary counts, the resume
 * file-observation check, and the transcript all care about recent history.
 * `messages` is unaffected — it is replayed incrementally as lines arrive and
 * carries its own retention.
 *
 * Sized so it never engages for ordinary sessions: 96 MB of JSONL is above
 * all but a handful of sessions ever recorded, so the common path keeps
 * byte-for-byte the behaviour it had.
 */
export const DEFAULT_MAX_RETAINED_EVENT_BYTES = 96 * 1024 * 1024;
/** Evict down to this fraction of the budget so eviction is amortized, not per-line. */
const EVICT_TO_FRACTION = 0.9;
/** What a snapshot event still costs once `stripSnapshotPayload` empties it. */
const SNAPSHOT_ENVELOPE_BYTES = 256;
/** Minimum wall time between onLoadProgress emissions. */
const LOAD_PROGRESS_INTERVAL_MS = 250;

export async function loadSessionDataFromFile(params: {
  id: string;
  file: string;
  full: boolean;
  events?: EventBus | undefined;
  secretScrubber: SecretScrubber;
  maxRetainedEventBytes?: number | undefined;
  /**
   * Byte-level parse progress for large journals. Throttled to one call per
   * `progressIntervalMs` (the per-line accounting approximates delimiters)
   * plus an unthrottled final call at EOF reporting
   * `loadedBytes === totalBytes` exactly. When omitted,
   * no progress work happens at all — not even the source-size stat.
   */
  onLoadProgress?: ((progress: SessionLoadProgress) => void) | undefined;
  /** Test seam: override the throttle window (0 = every line). */
  progressIntervalMs?: number | undefined;
}): Promise<SessionData> {
  const events: SessionEvent[] = [];
  const eventBytes: number[] = [];
  const eventBudget = params.maxRetainedEventBytes ?? DEFAULT_MAX_RETAINED_EVENT_BYTES;
  const evictTo = Math.floor(eventBudget * EVICT_TO_FRACTION);
  let retainedBytes = 0;
  let eventsDropped = 0;
  /** Absolute index (across evictions) of the newest snapshot still in `events`. */
  let lastSnapshotAbsIndex = -1;
  let sessionStartEvent: SessionEvent | undefined;
  let sessionEndEvent: SessionEvent | undefined;
  let sessionModel: string | undefined;
  let sessionProvider: string | undefined;
  let sessionPendingToolUses: string[] | undefined;
  let subagentsAllowed: boolean | undefined;
  let sessionForkedEvent: Extract<SessionEvent, { type: 'session_forked' }> | undefined;
  const messages: Message[] | undefined = params.full ? [] : undefined;
  const openToolUses: Set<string> | undefined = params.full ? new Set<string>() : undefined;
  let exactJournalActive = false;
  let messageIndexOffset = 0;
  let usage: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  /** Newest snapshot seen so far; its predecessor is stripped when it arrives. */
  let lastSnapshot: SnapshotEvent | undefined;

  // Progress is opt-in: without a consumer neither the size stat nor the
  // per-line accounting happens at all. Stat BEFORE constructing the stream:
  // a rejected stat (deleted/unreadable journal) must not leak a stream and
  // readline that the try/finally below has not claimed yet.
  const totalBytes = params.onLoadProgress ? (await fspStat(params.file)).size : 0;

  const stream = createReadStream(params.file, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let loadedBytes = 0;
  let lastProgressAt = 0;
  const progressIntervalMs = params.progressIntervalMs ?? LOAD_PROGRESS_INTERVAL_MS;

  try {
    for await (const line of rl) {
      // Opt-in per contract: the default path (no consumer) must stay a
      // zero-extra-cost scan on OOM-scale journals — no stat, no accounting.
      if (params.onLoadProgress) {
        loadedBytes += Buffer.byteLength(line, 'utf8') + 1;
        if (Date.now() - lastProgressAt >= progressIntervalMs) {
          lastProgressAt = Date.now();
          params.onLoadProgress({ loadedBytes, totalBytes });
        }
      }
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isSessionEventLike(parsed)) continue;
        const ev = scrubPersistedSessionEvent(parsed as SessionEvent, params.secretScrubber);
        // A snapshot event carries a full copy of the conversation, and one is
        // written on every compaction / context rewrite. Replay consumes the
        // copy immediately (see applyContextSnapshot) and nothing downstream
        // reads it back — `replaySessionMessages`, `buildRestoredCheckpoints`,
        // `buildTranscriptFromEvents` and `extractToolCallEnds` all key off
        // other event types. Retaining every copy therefore kept one whole
        // conversation per compaction alive for the caller's lifetime:
        // measured at 495 MB of a 1.2 GB load on a 564 MB session.
        //
        // Keep only the newest snapshot's payload — it is the one that decides
        // the final state, so it stays available for anything that later wants
        // to inspect it — and strip the ones it superseded. Retention becomes
        // O(1) snapshots instead of O(session length).
        events.push(ev);
        eventBytes.push(line.length);
        retainedBytes += line.length;
        if (isSnapshotEvent(ev)) {
          if (lastSnapshot !== undefined) {
            stripSnapshotPayload(lastSnapshot);
            // Refund the stripped payload to the retention budget. Without
            // this the budget would be charged for bytes that are no longer
            // resident, and on a snapshot-heavy session (where source bytes
            // exceed live bytes by an order of magnitude) it would evict
            // events that cost almost nothing to keep.
            const slot = lastSnapshotAbsIndex - eventsDropped;
            if (slot >= 0 && slot < eventBytes.length) {
              const refund = eventBytes[slot]! - SNAPSHOT_ENVELOPE_BYTES;
              if (refund > 0) {
                retainedBytes -= refund;
                eventBytes[slot] = SNAPSHOT_ENVELOPE_BYTES;
              }
            }
          }
          lastSnapshot = ev;
          lastSnapshotAbsIndex = eventsDropped + events.length - 1;
        }
        if (retainedBytes > eventBudget) {
          // Drop from the front in one batch down to `evictTo` — a per-line
          // `shift()` here would be O(n) on every subsequent line.
          let cut = 0;
          while (cut < eventBytes.length && retainedBytes > evictTo) {
            retainedBytes -= eventBytes[cut]!;
            cut++;
          }
          events.splice(0, cut);
          eventBytes.splice(0, cut);
          eventsDropped += cut;
        }

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
        if (ev.type === 'subagent_policy') {
          subagentsAllowed = ev.allowed;
        }

        if (params.full && messages !== undefined && openToolUses !== undefined) {
          const replayState = replaySessionEvent({
            ev,
            id: params.id,
            events: params.events,
            messages,
            openToolUses,
            exactJournalActive,
            messageIndexOffset,
            usage,
          });
          exactJournalActive = replayState.exactJournalActive;
          messageIndexOffset = replayState.messageIndexOffset;
          usage = replayState.usage ?? usage;
        } else if (ev.type === 'llm_response') {
          usage = accumulateUsage(usage, ev);
        }
      } catch {
        // skip malformed JSON
      }
    }
    if (params.onLoadProgress) {
      // Unthrottled EOF marker: the authoritative completion signal — the
      // per-line +1 accounting only approximates delimiters, so report the
      // exact source size (lets callers flip to "parsed — replaying…").
      params.onLoadProgress({ loadedBytes: totalBytes, totalBytes });
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
    const repaired = repairToolUseAdjacency(messages, { preserveTrailingToolUse: true });
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
  const pendingToolUseCount = openToolUses && openToolUses.size > 0 ? openToolUses.size : undefined;
  return {
    metadata: meta,
    events,
    messages: finalMessages,
    usage,
    ...(subagentsAllowed !== undefined ? { subagentsAllowed } : {}),
    toolCallEnds,
    ...(pendingToolUseCount !== undefined ? { pendingToolUseCount } : {}),
    ...(eventsDropped > 0 ? { eventsDropped } : {}),
  };
}

/** Events whose payload is a full copy of the conversation. */
type SnapshotEvent = Extract<SessionEvent, { type: 'messages_replaced' | 'context_snapshot' }>;

function isSnapshotEvent(event: SessionEvent): event is SnapshotEvent {
  return event.type === 'messages_replaced' || event.type === 'context_snapshot';
}

/**
 * Drop a superseded snapshot's conversation copy, recording how long it was.
 *
 * Safe to mutate in place: `scrubPersistedSessionEvent` hands back a fresh
 * object per line, so the loader owns it, and by the time a snapshot is
 * superseded its own replay has already consumed the payload.
 */
function stripSnapshotPayload(event: SnapshotEvent): void {
  if (event.messages.length === 0) return;
  event.messagesOmitted = event.messages.length;
  event.messages = [];
}

/**
 * A snapshot that reached disk with its payload already removed.
 *
 * `stripSnapshotPayload` empties superseded snapshots in place, and anything
 * that copies `SessionData.events` onward — `fork()` is the one that does —
 * can persist the emptied form into another journal. Replaying that as an
 * ordinary snapshot would set the conversation to zero messages and silently
 * discard everything before it, which is exactly the history the fork was
 * supposed to inherit. `messagesOmitted` is the marker the stripper leaves
 * behind, so the pair (empty payload, positive omitted count) is the one case
 * where an empty snapshot means "payload lost", not "conversation was empty".
 */
function isStrippedSnapshot(event: SnapshotEvent): boolean {
  return (
    event.messages.length === 0 &&
    typeof event.messagesOmitted === 'number' &&
    event.messagesOmitted > 0
  );
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
  messageIndexOffset: number;
  usage: UsageTotals;
}): { exactJournalActive: boolean; messageIndexOffset: number; usage?: UsageTotals } {
  const { ev, messages, openToolUses } = params;
  let exactJournalActive = params.exactJournalActive;
  let messageIndexOffset = params.messageIndexOffset;

  if (ev.type === 'message_appended' && ev.version === 1) {
    const message = replayableMessage(ev.message, ev.ts);
    if (message) {
      if (!exactJournalActive && shouldReplaceLegacyReplay(messages, ev.ts)) {
        messages.length = 0;
        openToolUses.clear();
        messageIndexOffset = 0;
      }
      exactJournalActive = true;
      messages.push(message);
      trackMessageToolState(message, openToolUses);
    } else {
      emitDamaged(params, 'Ignored malformed message_appended event');
    }
  } else if (ev.type === 'message_updated' && ev.version === 1) {
    const message = replayableMessage(ev.message, ev.ts);
    const index = ev.index - messageIndexOffset;
    if (message && exactJournalActive && index >= 0 && index < messages.length) {
      messages[index] = message;
      openToolUses.clear();
      for (const current of messages) trackMessageToolState(current, openToolUses);
    } else {
      emitDamaged(params, `Ignored malformed message_updated event at index ${ev.index}`);
    }
  } else if (ev.type === 'messages_replaced' && ev.version === 1) {
    if (isStrippedSnapshot(ev)) {
      emitDamaged(
        params,
        `Ignored messages_replaced event whose payload was stripped before persistence (${String(ev.messagesOmitted)} messages)`,
      );
    } else if (applyContextSnapshot(messages, openToolUses, ev.messages)) {
      exactJournalActive = true;
      messageIndexOffset = 0;
    } else {
      emitDamaged(params, 'Ignored malformed messages_replaced event');
    }
  } else if (ev.type === 'messages_dropped' && ev.version === 1) {
    // The delta form of the eviction that `messages_replaced` used to snapshot.
    // It only means anything against a history this journal itself built, so it
    // is ignored unless the exact journal is live — same guard as
    // `message_updated`, and for the same reason: splicing a prefix off an
    // array reconstructed from inferred events would cut the wrong messages.
    if (exactJournalActive && Number.isInteger(ev.count) && ev.count > 0) {
      const dropped = Math.min(ev.count, messages.length);
      messages.splice(0, dropped);
      messageIndexOffset += dropped;
      openToolUses.clear();
      for (const current of messages) trackMessageToolState(current, openToolUses);
    } else if (!exactJournalActive) {
      emitDamaged(params, 'Ignored messages_dropped event outside the exact journal');
    } else {
      emitDamaged(params, `Ignored malformed messages_dropped event (count ${String(ev.count)})`);
    }
  } else if (ev.type === 'context_snapshot') {
    if (isStrippedSnapshot(ev)) {
      emitDamaged(
        params,
        `Ignored context_snapshot event whose payload was stripped before persistence (${String(ev.messagesOmitted)} messages)`,
      );
    } else if (applyContextSnapshot(messages, openToolUses, ev.messages)) {
      // Same base as `messages_replaced` above: the snapshot replaces the
      // whole array, and the writer's subsequent `message_updated` indices
      // are positions in THAT array (conversation-state emits live array
      // positions — there is no global journal counter). A pre-snapshot
      // `messages_dropped` offset must not leak into them.
      messageIndexOffset = 0;
    } else {
      emitDamaged(params, 'Ignored malformed context_snapshot event');
    }
  } else if (
    ev.type === 'messages_replaced' ||
    ev.type === 'message_appended' ||
    ev.type === 'message_updated' ||
    ev.type === 'messages_dropped'
  ) {
    // Reached only when `version` is not 1. Falling through silently made an
    // unreadable journal look like an empty one; say so instead.
    emitDamaged(params, `Ignored ${ev.type} event with unsupported version`);
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
    return { exactJournalActive, messageIndexOffset, usage: accumulateUsage(params.usage, ev) };
  } else if (!exactJournalActive && ev.type === 'tool_result') {
    if (!openToolUses.has(ev.id)) {
      emitDamaged(params, `Orphan tool_result "${ev.id}" has no matching tool_use`);
      return { exactJournalActive, messageIndexOffset };
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

  return { exactJournalActive, messageIndexOffset };
}

function shouldReplaceLegacyReplay(messages: readonly Message[], eventTs: string): boolean {
  if (messages.length === 0) return true;
  const lastTs = messages[messages.length - 1]?.ts;
  return typeof lastTs === 'string' && lastTs >= eventTs;
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

function emitDamaged(params: { id: string; events?: EventBus | undefined }, detail: string): void {
  params.events?.emit('session.damaged', {
    sessionId: params.id,
    detail,
  });
}
