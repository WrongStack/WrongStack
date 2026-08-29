/**
 * Session timeline projection — the single source of truth for the ORDER and
 * CONTENT of a replayed session, the way {@link ./session-markers.js} is the
 * single source of truth for marker wording.
 *
 * A session journal carries two interleaved streams: the conversation itself
 * (user/assistant/system turns with their thinking and tool calls) and an
 * audit stream of things that happened around it (compaction, mode switches,
 * skill activation, subagent lifecycle, provider retries). Every surface has
 * to merge the two back into one list when a session is resumed, reconnected
 * or redisplayed — and each of them used to do it separately: the TUI walked
 * the message backbone and two-pointer-merged markers, the WebUI flushed
 * markers only at message boundaries and dropped tool timings entirely, and the
 * SimpleUI built two lists and re-sorted them by timestamp. The same session
 * therefore read differently depending on which window you resumed it in, and
 * none of them matched what had been on screen while it ran.
 *
 * (HQ's `hq/transcript-mapper.ts` is deliberately NOT a caller: its live plane
 * maps one event at a time as frames arrive and cannot buffer a whole session.
 * Its order is journal order and its marker wording comes from
 * `sessionEventToMarker`, so it does not constitute a second ordering.)
 *
 * This module owns that merge. Surfaces map {@link SessionTimelineEntry} to
 * their own row type and decide PRESENTATION only — icon, colour, chat bubble
 * vs dimmed line, how far to truncate a tool body. Ordering, pairing and
 * visibility are settled here, once.
 *
 * Pure and dependency-free, like `session-markers.ts`: safe to call from a
 * WebSocket payload builder, a React render path or an Ink render path alike.
 * It must stay importable from a browser bundle, so nothing here may reach
 * `node:*` (see the note on the narrow subpath import in
 * `webui-protocol/src/replay-payload.ts`).
 */
import type { ContentBlock } from './blocks.js';
import type { Message } from './messages.js';
import {
  isSystemInjectedMessage,
  projectSessionMarkers,
  SESSION_MARKER_EVENT_TYPES,
  type SessionMarker,
  type SessionMarkerDetail,
} from './session-markers.js';
import type { SessionEvent } from './session.js';

/** An image the user attached to a prompt, as it survives in the journal. */
export interface SessionTimelineImage {
  mediaType?: string | undefined;
  /** Base64 payload, when the block carried one. */
  data?: string | undefined;
  /** Remote URL, when the block referenced one instead. */
  url?: string | undefined;
}

/**
 * Tool-call metadata that lives in `tool_call_end` events rather than in the
 * conversation.
 *
 * The message journal records WHICH tool ran with WHICH arguments and WHAT it
 * returned; how long it took and how much it produced is audit detail, in a
 * separate event keyed by the same `tool_use` id. The TUI reads both because
 * it holds the raw event array; the browser surfaces are handed a projection
 * over the wire, so this is the shape that projection carries.
 */
export interface SessionToolMeta {
  /** The `tool_use` id this describes. */
  id: string;
  name?: string | undefined;
  durationMs?: number | undefined;
  outputBytes?: number | undefined;
  outputTokens?: number | undefined;
  outputLines?: number | undefined;
  ok?: boolean | undefined;
  /** Subagent that ran the tool; absent = the session's leader. */
  agentId?: string | undefined;
}

interface TimelineEntryBase {
  ts: string;
}

export interface SessionTimelineUserEntry extends TimelineEntryBase {
  kind: 'user';
  text: string;
  /** Present only when the prompt carried image blocks. */
  images?: SessionTimelineImage[] | undefined;
}

export interface SessionTimelineAssistantEntry extends TimelineEntryBase {
  kind: 'assistant';
  text: string;
  /**
   * True when this prose ended its turn. A message carrying a `tool_use` block
   * stopped for a tool call, so its text is mid-turn — the surfaces use this to
   * decide whether a `<nextsteps>` panel may appear.
   */
  final: boolean;
}

/** A conversation message with `role: 'system'` — resume notices and the like. */
export interface SessionTimelineSystemEntry extends TimelineEntryBase {
  kind: 'system';
  text: string;
}

export interface SessionTimelineThinkingEntry extends TimelineEntryBase {
  kind: 'thinking';
  text: string;
  /** 1-based ordinal across the whole timeline; surfaces label iterations with it. */
  index: number;
}

export interface SessionTimelineToolEntry extends TimelineEntryBase {
  kind: 'tool';
  /** The provider's `tool_use` id, or the `tool_result`'s id for an orphan result. */
  toolUseId: string;
  name: string;
  input?: unknown;
  /** Untruncated result body. Surfaces decide their own preview length. */
  output?: string | undefined;
  /**
   * `undefined` while a call has no result in the journal — the run was still
   * executing it when the process stopped. A surface renders that as "running"
   * or "interrupted"; it is NOT a failure, and reporting it as one is what the
   * SimpleUI replay used to do.
   */
  ok?: boolean | undefined;
  durationMs?: number | undefined;
  outputBytes?: number | undefined;
  outputTokens?: number | undefined;
  outputLines?: number | undefined;
  agentId?: string | undefined;
}

export interface SessionTimelineMarkerEntry extends TimelineEntryBase {
  kind: 'marker';
  source: SessionEvent['type'];
  level: SessionMarker['level'];
  text: string;
  agentId?: string | undefined;
  /** See {@link SessionMarker.detail} — structured fields for rich sources. */
  detail?: SessionMarkerDetail | undefined;
}

export type SessionTimelineEntry =
  | SessionTimelineUserEntry
  | SessionTimelineAssistantEntry
  | SessionTimelineSystemEntry
  | SessionTimelineThinkingEntry
  | SessionTimelineToolEntry
  | SessionTimelineMarkerEntry;

/**
 * Where a message's thinking blocks land relative to its prose.
 *
 * Not a style choice — it is what the surface did LIVE, and resume has to
 * match the surface it is resuming into:
 *
 * - `'inline'` — one entry per thinking block, before the prose, in provider
 *   block order. The TUI and SimpleUI stream thinking as it arrives and leave
 *   it where it fell.
 * - `'merged-after'` — one entry per message, carrying every thinking block
 *   joined, emitted after that message's prose and tool calls. The WebUI keeps
 *   a transient thinking bubble during a run and only commits the archived log
 *   when the iteration completes, which is after the prose is on screen.
 */
export type ThinkingPlacement = 'inline' | 'merged-after';

/**
 * How a message's text blocks relate to the tool calls between them.
 *
 * Again a record of what the surface did LIVE, not a preference:
 *
 * - `'split'` — a text run becomes its own entry wherever a tool interrupts
 *   it, so prose that followed a tool stays after that tool. The TUI and the
 *   WebUI render a fresh bubble per run.
 * - `'join'` — every text block of a message becomes ONE entry, emitted before
 *   the message's tool entries. The SimpleUI streams a whole iteration into a
 *   single bubble and lists tool calls beside it, so splitting would invent
 *   bubbles that were never on screen.
 */
export type TextBlockMode = 'split' | 'join';

export interface ProjectSessionTimelineInput {
  /** The reconstructed conversation, as `SessionStore.load()` rebuilds it. */
  messages: readonly Message[];
  /**
   * Raw journal events. Callers holding the JSONL (the TUI, the servers) pass
   * this and markers/toolMeta are projected from it.
   */
  events?: readonly SessionEvent[] | undefined;
  /** Pre-projected markers, for callers that received them over the wire. */
  markers?: readonly SessionMarker[] | undefined;
  /** Pre-projected tool metadata, for callers that received it over the wire. */
  toolMeta?: readonly SessionToolMeta[] | undefined;
  /**
   * Which event types project to markers. Defaults to the dense
   * {@link SESSION_MARKER_EVENT_TYPES}; chat-shaped surfaces pass
   * `CHAT_MARKER_SOURCES`. Ignored when `markers` is supplied — the sender
   * already applied its own set.
   */
  markerSources?: ReadonlySet<SessionEvent['type']> | undefined;
  /** See {@link ThinkingPlacement}. Defaults to `'inline'`. */
  thinkingPlacement?: ThinkingPlacement | undefined;
  /** See {@link TextBlockMode}. Defaults to `'split'`. */
  textBlocks?: TextBlockMode | undefined;
  /**
   * Glue between adjacent text blocks of one run. Defaults to `''` — the
   * provider already streamed them as one continuous body, and inserting a
   * separator would put a break where the live render had none.
   */
  textSeparator?: string | undefined;
  /**
   * Drop conversation messages the agent loop injected for the model's benefit
   * (mailbox, fleet pulse, loop detector, resume notices). Defaults to true —
   * every surface hides them, and a surface that wants the raw journal should
   * read the events instead.
   */
  hideSystemInjections?: boolean | undefined;
}

/** Project the `tool_call_end` records of an event stream, keyed by tool id. */
export function projectSessionToolMeta(events: Iterable<SessionEvent>): SessionToolMeta[] {
  const out: SessionToolMeta[] = [];
  for (const event of events) {
    if (event.type !== 'tool_call_end') continue;
    out.push({
      id: event.id,
      name: event.name,
      durationMs: event.durationMs,
      // `outputSize` is the legacy name for the same number; prefer the modern
      // field but fall back so old journals keep their tool card stats.
      outputBytes: event.outputBytes ?? event.outputSize,
      outputTokens: event.outputTokens,
      outputLines: event.outputLines,
      ok: event.ok,
      agentId: event.agentId,
    });
  }
  return out;
}

function toolMetaIndex(
  meta: readonly SessionToolMeta[] | undefined,
): Map<string, SessionToolMeta> {
  const index = new Map<string, SessionToolMeta>();
  if (!meta) return index;
  // Last write wins: a tool id is unique per call, and if a journal somehow
  // repeats one the later record is the more complete.
  for (const entry of meta) index.set(entry.id, entry);
  return index;
}

function imagesOf(blocks: readonly ContentBlock[]): SessionTimelineImage[] | undefined {
  const images: SessionTimelineImage[] = [];
  for (const block of blocks) {
    if (block.type !== 'image') continue;
    images.push({
      mediaType: block.source.media_type,
      data: block.source.data,
      url: block.source.url,
    });
  }
  return images.length > 0 ? images : undefined;
}

function resultText(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

/**
 * Merge a session's conversation and audit streams into one ordered timeline.
 *
 * Ordering is a two-pointer merge of two sequences that are each already
 * chronological — the message backbone by construction, the markers by journal
 * order — so the conversation is never reordered: markers are only inserted
 * between existing turns, and a tie keeps the backbone entry first. That is
 * deliberately NOT a sort over the union: message timestamps repeat (every
 * block of one message shares its `ts`), and sorting a repeated key moves tool
 * calls away from the prose they belong to.
 */
export function projectSessionTimeline(
  input: ProjectSessionTimelineInput,
): SessionTimelineEntry[] {
  const {
    messages,
    events,
    thinkingPlacement = 'inline',
    textBlocks = 'split',
    textSeparator = '',
    hideSystemInjections = true,
  } = input;

  const markers =
    input.markers ??
    (events
      ? projectSessionMarkers(events, input.markerSources ?? SESSION_MARKER_EVENT_TYPES)
      : []);
  const meta = toolMetaIndex(input.toolMeta ?? (events ? projectSessionToolMeta(events) : undefined));

  // ── Conversation backbone, in message-walk order ─────────────────────────
  const backbone: SessionTimelineEntry[] = [];
  const toolEntries = new Map<string, SessionTimelineToolEntry>();
  let thinkingIndex = 0;
  let lastTs = '';

  // Outer whitespace on a message body is never meaningful in a transcript —
  // it is padding the provider or the composer left behind — and trimming it
  // in ONE place is what stops the surfaces disagreeing about it. The
  // block-array path already trimmed each run; string content did not, so the
  // same message rendered padded in two surfaces and trimmed in the third.
  const pushText = (role: Message['role'], raw: string, ts: string, final: boolean): void => {
    const text = raw.trim();
    if (!text) return;
    if (hideSystemInjections && isSystemInjectedMessage(text)) return;
    if (role === 'assistant') backbone.push({ kind: 'assistant', ts, text, final });
    else if (role === 'system') backbone.push({ kind: 'system', ts, text });
    else backbone.push({ kind: 'user', ts, text });
  };

  // Stored verbatim: a thinking block's own indentation is part of how the
  // model laid its reasoning out, and the surfaces render it in a pre-shaped
  // box. Only emptiness is judged on the trimmed form.
  const pushThinking = (text: string, ts: string): void => {
    if (!text.trim()) return;
    thinkingIndex += 1;
    backbone.push({ kind: 'thinking', ts, text, index: thinkingIndex });
  };

  for (const message of messages) {
    const ts = message.ts ?? lastTs;
    if (message.ts) lastTs = message.ts;

    if (typeof message.content === 'string') {
      // String content cannot carry a tool_use block, so it always ended its turn.
      pushText(message.role, message.content, ts, true);
      continue;
    }

    const blocks = message.content;

    // Thinking blocks precede text/tool_use per the provider contract
    // (blocks.ts). `'inline'` emits them there; `'merged-after'` holds them
    // until the message's own entries are down.
    if (thinkingPlacement === 'inline') {
      for (const block of blocks) {
        if (block.type === 'thinking') pushThinking(block.thinking, ts);
      }
    }

    const images = message.role === 'user' ? imagesOf(blocks) : undefined;
    const final = !blocks.some((block) => block.type === 'tool_use');
    const textParts: string[] = [];
    const flushText = (): void => {
      // In `'join'` mode a tool does not close the text run — the whole
      // message is one bubble, emitted before its tools by the pre-pass below.
      if (textBlocks === 'join') return;
      const text = textParts.join(textSeparator).trim();
      if (text) pushText(message.role, text, ts, final);
      textParts.length = 0;
    };

    if (textBlocks === 'join') {
      const joined = blocks
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join(textSeparator)
        .trim();
      if (joined) pushText(message.role, joined, ts, final);
    }

    // Walk content blocks IN ORDER, interleaving text and tool entries.
    // Concatenating all text first would move prose that appeared after a tool
    // ahead of that tool on resume — the same class of bug as sorting messages
    // by role instead of by timeline.
    for (const block of blocks) {
      if (block.type === 'text') {
        textParts.push(block.text);
        continue;
      }
      if (block.type === 'tool_use') {
        flushText();
        const known = meta.get(block.id);
        const entry: SessionTimelineToolEntry = {
          kind: 'tool',
          ts,
          toolUseId: block.id,
          name: block.name,
          input: block.input,
          // Left undefined until a tool_result arrives: an unfinished call is
          // not a failed one.
          ok: known?.ok,
          durationMs: known?.durationMs,
          outputBytes: known?.outputBytes,
          outputTokens: known?.outputTokens,
          outputLines: known?.outputLines,
          agentId: known?.agentId,
        };
        backbone.push(entry);
        toolEntries.set(block.id, entry);
        continue;
      }
      if (block.type !== 'tool_result') continue;
      flushText();
      const existing = toolEntries.get(block.tool_use_id);
      if (existing) {
        existing.output = resultText(block.content);
        existing.ok = !block.is_error;
        toolEntries.delete(block.tool_use_id);
        continue;
      }
      // A result whose call is not in the retained window — render it alone
      // rather than dropping the only evidence the tool ran.
      const known = meta.get(block.tool_use_id);
      backbone.push({
        kind: 'tool',
        ts,
        toolUseId: block.tool_use_id,
        name: block.name ?? known?.name ?? block.tool_use_id,
        output: resultText(block.content),
        ok: !block.is_error,
        durationMs: known?.durationMs,
        outputBytes: known?.outputBytes,
        outputTokens: known?.outputTokens,
        outputLines: known?.outputLines,
        agentId: known?.agentId,
      });
    }
    flushText();

    if (thinkingPlacement === 'merged-after') {
      const joined = blocks
        .filter((block): block is Extract<ContentBlock, { type: 'thinking' }> =>
          block.type === 'thinking',
        )
        .map((block) => block.thinking)
        .join('\n\n');
      pushThinking(joined.trim(), ts);
    }

    if (images) {
      // Attach to the prompt's own text entry when it has one; otherwise the
      // images ARE the message and get a bubble of their own.
      const last = backbone[backbone.length - 1];
      if (last?.kind === 'user' && last.ts === ts) last.images = images;
      else backbone.push({ kind: 'user', ts, text: '', images });
    }
  }

  // ── Two-pointer merge with the marker stream ─────────────────────────────
  const out: SessionTimelineEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < backbone.length && j < markers.length) {
    const marker = markers[j]!;
    if (marker.ts < backbone[i]!.ts) {
      out.push(markerEntry(marker));
      j += 1;
    } else {
      out.push(backbone[i]!);
      i += 1;
    }
  }
  while (i < backbone.length) out.push(backbone[i++]!);
  while (j < markers.length) out.push(markerEntry(markers[j++]!));
  return out;
}

function markerEntry(marker: SessionMarker): SessionTimelineMarkerEntry {
  return {
    kind: 'marker',
    ts: marker.ts,
    source: marker.source,
    level: marker.level,
    text: marker.text,
    agentId: marker.agentId,
    detail: marker.detail,
  };
}
