/**
 * Replay payload assembly for `session.start`.
 *
 * Two servers build this frame — the standalone WebUI server and the
 * CLI-hosted bridge — and they had already drifted (one fell back to the live
 * in-memory conversation, the other did not; only one applied the message cap
 * consistently). Both now call this, so the wire shape has a single definition.
 *
 * `replayMarkers` carries audit markers (compaction, mode switch, skill
 * activation, subagent lifecycle, provider retries, truncation) that a live
 * client renders as they stream in. Without them a reconnect or a session
 * resume silently drops everything except the conversation, so the same
 * session reads differently before and after a reload. Only the *projected*
 * markers cross the wire — never the raw event stream — so a 50k-event session
 * still costs a few dozen short strings.
 */
import type {
  Message,
  SessionEvent,
  SessionMarker,
  SessionToolMeta,
  Usage,
} from '@wrongstack/core/types';
// Narrow subpath, not the `types` barrel: this module is the only value import
// in `src/protocol/`, which the browser bundles pull in wholesale. Going
// through the barrel reached `types/mode.ts` → `types/mode-prompts.ts` and
// dragged `node:fs`/`node:path`/`node:url` into every UI build.
import { CHAT_MARKER_SOURCES, projectSessionMarkers } from '@wrongstack/core/types/session-markers';
import { projectSessionToolMeta } from '@wrongstack/core/types/session-timeline';

/**
 * Upper bound on replayed conversation messages. A very long session would
 * otherwise push a multi-megabyte frame on every connect; the full transcript
 * remains on disk and in the session store.
 */
export const REPLAY_MESSAGE_CAP = 2_000;

/**
 * How many sessions one connection may hold open at once.
 *
 * Both ends enforce this and they must agree. The browser allocates lanes and
 * tab slots up to this number; the server accepts a declared set up to this
 * number and DROPS the rest — a connection whose extra tabs were trimmed
 * silently stops receiving their runs, their redisplays and their run-state
 * answers, which on screen is a tab that "stopped working" for no visible
 * reason. Two independent constants in two packages had no way to disagree
 * loudly, so this is the one both import.
 */
export const MAX_OPEN_SESSIONS_PER_CONNECTION = 4;

export interface ReplaySource {
  messages: readonly Message[];
  /** Raw JSONL events, when the caller loaded them. Markers are projected from these. */
  events?: readonly SessionEvent[] | undefined;
  usage?: Usage | undefined;
}

export interface ReplayPayloadFields {
  replayMessages?: Message[] | undefined;
  replayMarkers?: SessionMarker[] | undefined;
  /**
   * How long each tool call took and how much it produced.
   *
   * The conversation records WHICH tool ran and WHAT it returned; the timing
   * and output size live in separate `tool_call_end` records, which never
   * crossed the wire. So a browser surface rebuilt its tool cards without a
   * duration or a size chip, and the same call that had shown `read · 1.2s ·
   * 4.1 kB` while it ran came back bare after a reload. The TUI never had the
   * problem because it holds the raw event array; this is the projection that
   * gives the browsers the same facts. Bounded by the number of tool calls,
   * with a handful of numbers each.
   */
  replayToolMeta?: SessionToolMeta[] | undefined;
  replayUsage?: Usage | undefined;
}

/**
 * Build the replay fields of a `session.start` payload. Fields are omitted
 * rather than sent empty, so an existing client's "did the server send a
 * replay?" checks keep working unchanged.
 */
export function buildReplayPayload(source: ReplaySource): ReplayPayloadFields {
  const out: ReplayPayloadFields = {};

  const messages = source.messages;
  if (messages.length > 0) {
    out.replayMessages =
      messages.length > REPLAY_MESSAGE_CAP ? messages.slice(-REPLAY_MESSAGE_CAP) : [...messages];
  }

  if (source.events && source.events.length > 0) {
    const markers = projectSessionMarkers(source.events, CHAT_MARKER_SOURCES);
    if (markers.length > 0) out.replayMarkers = markers;
    const toolMeta = projectSessionToolMeta(source.events);
    if (toolMeta.length > 0) out.replayToolMeta = toolMeta;
  }

  const usage = source.usage;
  if (usage && usage.input + usage.output + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) > 0) {
    out.replayUsage = {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
    };
  }

  return out;
}
