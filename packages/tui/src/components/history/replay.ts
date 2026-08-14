import type {
  DistributiveOmit,
  Message,
  SessionEvent,
  SessionMarker,
} from '@wrongstack/core/types';
import {
  isSystemInjectedMessage,
  SESSION_MARKER_EVENT_TYPES,
  sessionEventToMarker,
} from '@wrongstack/core/types';
import { isFinalTurnStopReason } from '@wrongstack/tools/next-steps';
import type { HistoryEntry } from './types.js';

/**
 * Render a SessionEvent back into a TUI HistoryEntry so a resumed session
 * displays exactly what the user saw during live interaction.
 *
 * ## Entry mapping
 *
 * | Event type                | HistoryEntry kind |
 * |--------------------------|-------------------|
 * | `user_input`             | `user`            |
 * | `llm_response`           | `assistant`       |
 * | `tool_use` + `tool_result` | `tool` (paired) |
 * | `tool_call_start`/`tool_call_end` | `tool`      |
 * | `compaction`             | `info`            |
 * | `error`                  | `error`           |
 * | `provider_retry`         | `warn`            |
 * | `provider_error`         | `error`           |
 * | `checkpoint`             | `info`            |
 * | `agent_spawned`/`agent_stopped` | `subagent`  |
 * | `agent_error`            | `subagent`        |
 * | `mode_changed`           | `info`            |
 * | `skill_activated`/`skill_deactivated` | `info` |
 * | `message_truncated`      | `warn`            |
 *
 * ## Non-resumable events (subagent transcripts)
 *
 * Subagent events (`agent_spawned`, `agent_stopped`, `agent_error`) are
 * rendered as `subagent` entries in the main TUI history but the full
 * subagent tool-call details live in per-subagent JSONL files. The main
 * session only holds the lifecycle markers.
 *
 * ## Compaction events
 *
 * Compaction boundaries are rendered as `info` entries showing how many
 * tokens were collapsed. This keeps the display neat without pretending
 * the full verbose context never existed.
 *
 * @param events  Parsed SessionEvent[] from session JSONL
 * @param startId Starting id counter for the generated entries
 * @returns       Ordered HistoryEntry[] ready for display
 */
/**
 * Event types rendered as interleaved marker entries on top of the message
 * backbone. Conversation-bearing events (user_input/llm_response/tool_*) are
 * intentionally excluded — those come from `messages` so both legacy logs and
 * the modern `message_appended` journal reconstruct identically.
 *
 * The set and the wording both live in core (`types/session-markers.ts`) so the
 * TUI, WebUI, SimpleUI and HQ cannot drift on what a resumed session says.
 */
const MARKER_EVENT_TYPES = SESSION_MARKER_EVENT_TYPES;

type PreEntry = DistributiveOmit<HistoryEntry, 'id'>;

/** Presentation for the subagent lifecycle markers, keyed by source event. */
const SUBAGENT_MARKER_STYLE: Record<string, { color: string; icon: string }> = {
  agent_spawned: { color: 'magenta', icon: '⚡' },
  agent_stopped: { color: 'gray', icon: '⊘' },
  agent_error: { color: 'red', icon: '✗' },
};

/**
 * Render a core {@link SessionMarker} as a TUI history entry. Only the visual
 * treatment is decided here — the text came from core.
 */
function markerToEntry(marker: SessionMarker): PreEntry {
  if (marker.agentId !== undefined) {
    const style = SUBAGENT_MARKER_STYLE[marker.source] ?? { color: 'gray', icon: '·' };
    return {
      kind: 'subagent',
      agentLabel: marker.agentId.slice(0, 8),
      agentColor: style.color,
      icon: style.icon,
      text: marker.text,
    } as PreEntry;
  }
  if (marker.level === 'error') return { kind: 'error', text: marker.text };
  if (marker.level === 'warn') return { kind: 'warn', text: marker.text };
  return { kind: 'info', text: marker.text };
}

/** Truncate a tool_result body to the same ~400-char preview used live. */
function toolOutputPreview(content: unknown): string {
  return (typeof content === 'string' ? content : JSON.stringify(content)).slice(0, 400);
}

/**
 * Canonical session-resume renderer. Rebuilds the visible TUI history for a
 * resumed session from the reconstructed `messages` (the conversation
 * backbone — user/assistant/system text, thinking blocks, and tool calls with
 * their input + output) and interleaves the audit `events` marker stream
 * (mode/compaction/checkpoint/skill/agent/error/retry/truncation) at their
 * chronological positions.
 *
 * Ordering is a two-pointer merge of two already-chronological sequences
 * (message backbone by construction, marker events by JSONL order) so the
 * conversation is never reordered — markers are only inserted between existing
 * turns. This is the single renderer used by BOTH the boot `--resume` path and
 * the in-session resume picker, replacing the previous message-only and
 * meta-only tool-chip variants.
 */
export function replaySessionMessages(
  messages: readonly Message[],
  events: readonly SessionEvent[],
  startId: number,
): HistoryEntry[] {
  const toolEnds = new Map(
    events
      .filter(
        (event): event is Extract<SessionEvent, { type: 'tool_call_end' }> =>
          event.type === 'tool_call_end',
      )
      .map((event) => [event.id, event]),
  );

  // ── Conversation backbone (in message-walk order) ─────────────────────────
  const backbone: Array<{ ts: string; entry: PreEntry }> = [];
  const toolEntries = new Map<string, Extract<PreEntry, { kind: 'tool' }>>();
  let lastTs = '';

  const push = (ts: string, entry: PreEntry): PreEntry => {
    backbone.push({ ts, entry });
    return entry;
  };
  // `final` marks the last assistant message of a turn — the only kind that
  // may surface a `<nextsteps>` panel on replay. A message carrying a tool_use
  // block stopped for a tool call, so its prose is mid-turn.
  const appendText = (role: Message['role'], text: string, ts: string, final: boolean): void => {
    if (!text.trim()) return;
    if (isSystemInjectedMessage(text)) return;
    push(
      ts,
      role === 'assistant'
        ? { kind: 'assistant', text, final }
        : role === 'system'
          ? { kind: 'info', text }
          : { kind: 'user', text },
    );
  };

  for (const message of messages) {
    const ts = message.ts ?? lastTs;
    if (message.ts) lastTs = message.ts;

    if (typeof message.content === 'string') {
      // String content cannot carry a tool_use block, so it always ended its turn.
      appendText(message.role, message.content, ts, true);
      continue;
    }

    // Thinking blocks appear before text/tool_use per the provider contract
    // (blocks.ts) — emit them in that order so resume matches live rendering.
    for (const block of message.content) {
      if (block.type === 'thinking' && block.thinking.trim()) {
        push(ts, { kind: 'thinking', text: block.thinking });
      }
    }

    // Walk content blocks in order, interleaving text and tool entries.
    // Concatenating all text first would move prose that appeared after a
    // tool ahead of that tool on resume — the same class of bug as sorting
    // messages by role instead of by timeline.
    const final = !message.content.some((block) => block.type === 'tool_use');
    const textParts: string[] = [];
    const flushText = (): void => {
      const text = textParts.join('').trim();
      if (text) appendText(message.role, text, ts, final);
      textParts.length = 0;
    };

    for (const block of message.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
        continue;
      }
      if (block.type === 'tool_use') {
        flushText();
        const end = toolEnds.get(block.id);
        const entry = push(ts, {
          kind: 'tool',
          name: block.name,
          durationMs: end?.durationMs ?? 0,
          ok: false,
          input: block.input,
          outputBytes: end?.outputBytes,
          outputTokens: end?.outputTokens,
          outputLines: end?.outputLines,
        }) as Extract<PreEntry, { kind: 'tool' }>;
        toolEntries.set(block.id, entry);
        continue;
      }
      if (block.type !== 'tool_result') continue;
      flushText();
      const existing = toolEntries.get(block.tool_use_id);
      if (existing) {
        existing.output = toolOutputPreview(block.content);
        existing.ok = !block.is_error;
        toolEntries.delete(block.tool_use_id);
        continue;
      }
      const end = toolEnds.get(block.tool_use_id);
      push(ts, {
        kind: 'tool',
        name: block.name ?? block.tool_use_id,
        durationMs: end?.durationMs ?? 0,
        ok: !block.is_error,
        output: toolOutputPreview(block.content),
        outputBytes: end?.outputBytes,
        outputTokens: end?.outputTokens,
        outputLines: end?.outputLines,
      });
    }
    flushText();
  }

  // ── Marker events (already chronological in JSONL order) ──────────────────
  const dummyPending = new Map<string, { name: string; input: unknown; ts: string }>();
  const dummyCompleted = new Map<string, Extract<HistoryEntry, { kind: 'tool' }>>();
  const markers: Array<{ ts: string; entry: PreEntry }> = [];
  for (const ev of events) {
    if (!MARKER_EVENT_TYPES.has(ev.type)) continue;
    const entry = eventToEntry(ev, dummyPending, dummyCompleted);
    if (entry) markers.push({ ts: ev.ts, entry });
  }

  // ── Two-pointer merge: interleave markers into the backbone by ts without
  // ever reordering the conversation. Ties keep the backbone entry first. ────
  const entries: HistoryEntry[] = [];
  let nextId = startId;
  let i = 0;
  let j = 0;
  const emit = (entry: PreEntry): void => {
    entries.push({ ...entry, id: nextId++ } as HistoryEntry);
  };
  while (i < backbone.length && j < markers.length) {
    if (markers[j]!.ts < backbone[i]!.ts) emit(markers[j++]!.entry);
    else emit(backbone[i++]!.entry);
  }
  while (i < backbone.length) emit(backbone[i++]!.entry);
  while (j < markers.length) emit(markers[j++]!.entry);
  return entries;
}

/**
 * Raw-event replay: renders the JSONL stream directly, without the
 * reconstructed message backbone.
 *
 * @deprecated Not the resume renderer. Use {@link replaySessionMessages} —
 * it is the canonical one, and the only one both the boot `--resume` path and
 * the in-session resume picker use. This variant cannot reconstruct sessions
 * written through the exact message journal (`message_appended`/`_updated`/
 * `_replaced`), because those events carry the conversation and this function
 * ignores them. Kept for the legacy event-only tests and any embedder holding
 * a bare event array; deliberately absent from the package barrel.
 */
export function replaySessionEvents(events: SessionEvent[], startId: number): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  let nextId = startId;
  // Pending tool_use events awaiting their tool_result
  const pendingTools = new Map<string, { name: string; input: unknown; ts: string }>();
  // Tool entries already rendered from a richer `tool_call_end` event. Keep
  // the actual entry so the later core `tool_result` can enrich it with the
  // persisted output without moving it past messages that occurred between
  // the two events or rendering a duplicate call.
  const completedTools = new Map<string, Extract<HistoryEntry, { kind: 'tool' }>>();

  for (const ev of events) {
    const entry = eventToEntry(ev, pendingTools, completedTools);
    if (entry) {
      const completed = { ...entry, id: nextId++ } as HistoryEntry;
      entries.push(completed);
      if (ev.type === 'tool_call_end' && completed.kind === 'tool') {
        completedTools.set(ev.id, completed);
      }
    }
  }

  // Flush any orphaned tool_use events (tool_use without tool_result — e.g. from
  // a crash mid-execution)
  for (const [, tu] of pendingTools) {
    entries.push({
      id: nextId++,
      kind: 'tool',
      name: tu.name,
      durationMs: 0,
      ok: false,
      input: tu.input,
    });
  }

  return entries;
}

/**
 * Convert a single SessionEvent to a HistoryEntry (or null if the event
 * should be skipped in the display). `pendingTools` is mutated to pair
 * tool_use events with their subsequent tool_result.
 *
 * Audit markers are delegated to core's shared projector; only the
 * conversation-bearing events are rendered here, because only the TUI pairs
 * tool_use/tool_result into a single entry.
 */
function eventToEntry(
  ev: SessionEvent,
  pendingTools: Map<string, { name: string; input: unknown; ts: string }>,
  completedTools: Map<string, Extract<HistoryEntry, { kind: 'tool' }>>,
): DistributiveOmit<HistoryEntry, 'id'> | null {
  if (MARKER_EVENT_TYPES.has(ev.type)) {
    const marker = sessionEventToMarker(ev);
    return marker ? markerToEntry(marker) : null;
  }
  switch (ev.type) {
    case 'user_input': {
      const text =
        typeof ev.content === 'string'
          ? ev.content
          : Array.isArray(ev.content)
            ? ev.content
                .filter((b) => (b as { type: string }).type === 'text')
                .map((b) => (b as { text: string }).text)
                .join('')
            : '';
      if (!text.trim()) return null;
      return { kind: 'user', text };
    }

    case 'llm_response': {
      for (const block of ev.content) {
        if (block.type === 'tool_use') {
          pendingTools.set(block.id, { name: block.name, input: block.input, ts: ev.ts });
        }
      }
      const text = ev.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('');
      if (!text.trim()) return null;
      // A `tool_use` stop means the agent loop ran again, so this text is
      // mid-turn prose and must not surface a `<nextsteps>` panel.
      return { kind: 'assistant', text, final: isFinalTurnStopReason(ev.stopReason) };
    }

    case 'tool_use': {
      // Defer — wait for the matching `tool_result` to construct a single
      // tool entry. Store the tool_use data keyed by its id.
      pendingTools.set(ev.id, { name: ev.name, input: ev.input, ts: ev.ts });
      return null;
    }

    case 'tool_result': {
      // Already rendered from the richer tool_call_end for this id —
      // emitting again would duplicate the call (named by its raw id).
      const completed = completedTools.get(ev.id);
      if (completed) {
        const serialized = typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content);
        completed.output = serialized?.slice(0, 400);
        completed.ok = !ev.isError;
        completedTools.delete(ev.id);
        return null;
      }
      // Pair with the previously stored tool_use.
      const tu = pendingTools.get(ev.id);
      pendingTools.delete(ev.id);
      return {
        kind: 'tool',
        name: tu?.name ?? ev.id,
        durationMs: 0, // duration not available from tool_result alone
        ok: !ev.isError,
        input: tu?.input,
        output: typeof ev.content === 'string' ? ev.content.slice(0, 400) : undefined,
      };
    }

    case 'tool_call_start': {
      // Defer — wait for tool_call_end
      pendingTools.set(ev.id, { name: ev.name, input: ev.input, ts: ev.ts });
      return null;
    }

    case 'tool_call_end': {
      const tu = pendingTools.get(ev.id);
      pendingTools.delete(ev.id);
      // The caller registers the completed entry by id after assigning its
      // stable history id, so a later tool_result can enrich it in place.
      // If we have a matching start, use its metadata; otherwise emit standalone.
      return {
        kind: 'tool',
        name: tu?.name ?? ev.name,
        durationMs: ev.durationMs,
        ok: ev.ok ?? false,
        input: tu?.input,
        outputBytes: ev.outputBytes,
        outputTokens: ev.outputTokens,
        outputLines: ev.outputLines,
      };
    }

    // Skipped — internal markers not relevant for display
    case 'session_start':
    case 'session_resumed':
    case 'session_end':
    case 'in_flight_start':
    case 'in_flight_end':
    case 'llm_request':
    case 'tool_progress':
    case 'rewound':
    case 'file_snapshot':
    case 'task_created':
    case 'task_updated':
    case 'task_completed':
    case 'task_failed':
    case 'spec_parsed':
    case 'spec_analyzed':
      return null;

    default:
      // Exhaustive check: ignore unknown event types silently
      return null;
  }
}
