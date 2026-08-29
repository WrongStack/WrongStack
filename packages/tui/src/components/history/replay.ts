import type {
  DistributiveOmit,
  Message,
  SessionEvent,
  SessionMarker,
  SessionTimelineEntry,
} from '@wrongstack/core/types';
import {
  projectSessionTimeline,
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
 * | `agent_spawned`/`agent_stopped` | excluded    |
 * | `agent_error`            | excluded          |
 * | `mode_changed`           | `info`            |
 * | `skill_activated`/`skill_deactivated` | `info` |
 * | `message_truncated`      | `warn`            |
 *
 * ## Non-resumable events (subagent transcripts)
 *
 * Subagent lifecycle events (`agent_spawned`, `agent_stopped`, `agent_error`)
 * are deliberately excluded from the main TUI history. Their raw journal
 * records stay on disk for a dedicated inspection surface; resume must restore
 * the leader's screen, not a mixed leader/subagent ledger.
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
const TUI_RESUME_EXCLUDED_MARKER_SOURCES: ReadonlySet<SessionEvent['type']> = new Set([
  'agent_spawned',
  'agent_session_linked',
  'agent_stopped',
  'agent_error',
  'delegate_started',
  'delegate_completed',
]);

const MARKER_EVENT_TYPES: ReadonlySet<SessionEvent['type']> = new Set(
  [...SESSION_MARKER_EVENT_TYPES].filter(
    (type) => !TUI_RESUME_EXCLUDED_MARKER_SOURCES.has(type),
  ),
);

type PreEntry = DistributiveOmit<HistoryEntry, 'id'>;

/**
 * Render a core {@link SessionMarker} as a TUI history entry. Only the visual
 * treatment is decided here — the text came from core.
 */
function markerToEntry(marker: SessionMarker): PreEntry | null {
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
 * chronological positions. Subagent/delegate lifecycle markers are excluded
 * from the main resume screen.
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
  // Ordering, pairing and visibility come from core; only the TUI's own
  // presentation is decided here.
  const timeline = projectSessionTimeline({
    messages,
    events,
    markerSources: MARKER_EVENT_TYPES,
    thinkingPlacement: 'inline',
  });

  const entries: HistoryEntry[] = [];
  let nextId = startId;
  for (const item of timeline) {
    const entry = timelineToEntry(item);
    if (entry) entries.push({ ...entry, id: nextId++ } as HistoryEntry);
  }
  return entries;
}

/** Map one core timeline entry to the TUI's history row. */
function timelineToEntry(item: SessionTimelineEntry): PreEntry | null {
  switch (item.kind) {
    case 'marker':
      return markerToEntry({
        ts: item.ts,
        source: item.source,
        level: item.level,
        text: item.text,
        agentId: item.agentId,
        detail: item.detail,
      });
    case 'user':
      // An image-only prompt has no text row of its own in the TUI; the
      // attachment is surfaced by the composer, not the transcript.
      return item.text ? { kind: 'user', text: item.text } : null;
    case 'assistant':
      return { kind: 'assistant', text: item.text, final: item.final };
    case 'system':
      return { kind: 'info', text: item.text };
    case 'thinking':
      return { kind: 'thinking', text: item.text };
    case 'tool':
      // Subagent delegates are journal/audit records, not leader-chat rows on
      // resume. The dedicated subagent history can inspect the raw records.
      if (item.name === 'delegate') return null;
      return {
        kind: 'tool',
        name: item.name,
        durationMs: item.durationMs ?? 0,
        ok: item.ok ?? false,
        input: item.input,
        output: item.output === undefined ? undefined : toolOutputPreview(item.output),
        outputBytes: item.outputBytes,
        outputTokens: item.outputTokens,
        outputLines: item.outputLines,
      };
    default: {
      const _exhaustive: never = item;
      void _exhaustive;
      return null;
    }
  }
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
      return null;

    default:
      // Exhaustive check: ignore unknown event types silently
      return null;
  }
}
