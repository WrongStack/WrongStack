/**
 * Session marker projection — the single source of truth for how audit events
 * are rendered as human-readable timeline entries.
 *
 * A session JSONL carries two interleaved streams: the conversation itself
 * (user/assistant/tool turns, reconstructed by `DefaultSessionStore.load`) and
 * an audit stream of things that happened *around* the conversation —
 * compaction, mode switches, skill activation, subagent lifecycle, provider
 * retries, truncation. During a live run every surface renders those audit
 * events as they arrive. On resume/reconnect they must render identically, or
 * the same session looks different before and after a reload.
 *
 * This module owns the event → text mapping so TUI, WebUI, SimpleUI and HQ
 * cannot drift. Each surface still decides *presentation* (icon, colour, chat
 * bubble vs. dimmed line) from {@link SessionMarker.source} and
 * {@link SessionMarker.level}; only the wording lives here.
 *
 * Pure and dependency-free: safe to call from a WebSocket payload builder, a
 * React render path, or a Node stream mapper alike.
 */
import type { SessionEvent } from './session.js';

export type SessionMarkerLevel = 'info' | 'warn' | 'error';

/** One rendered audit-timeline entry. */
export interface SessionMarker {
  ts: string;
  /**
   * The event type this marker was projected from. Surfaces switch on it for
   * presentation (e.g. the TUI picks a different icon for `agent_spawned` vs
   * `agent_stopped`, both of which are `level: 'info'`).
   */
  source: SessionEvent['type'];
  level: SessionMarkerLevel;
  text: string;
  /** Set only for the `agent_*` sources. */
  agentId?: string | undefined;
}

/**
 * Every event type that projects to a marker. Conversation-bearing events
 * (`user_input`, `llm_response`, `tool_*`) are deliberately excluded — those
 * come from the reconstructed message list so legacy logs and the modern
 * `message_appended` journal replay identically.
 */
export const SESSION_MARKER_EVENT_TYPES: ReadonlySet<SessionEvent['type']> = new Set([
  'mode_changed',
  'compaction',
  'checkpoint',
  'skill_activated',
  'skill_deactivated',
  'agent_spawned',
  'agent_stopped',
  'agent_error',
  'error',
  'provider_retry',
  'provider_error',
  'message_truncated',
]);

/**
 * The subset chat-shaped surfaces (WebUI, SimpleUI, HQ Live Console) render.
 *
 * `checkpoint` is excluded: one is written per user prompt
 * (`agent-loop.ts` → `writeCheckpoint`), so in a chat transcript it would be a
 * line restating the user message immediately next to it. Dense timeline
 * surfaces like the TUI use {@link SESSION_MARKER_EVENT_TYPES} instead, where
 * the checkpoint marker doubles as a `/rewind` target hint.
 */
export const CHAT_MARKER_SOURCES: ReadonlySet<SessionEvent['type']> = new Set(
  [...SESSION_MARKER_EVENT_TYPES].filter((type) => type !== 'checkpoint'),
);

/**
 * Project one session event to a marker, or `null` when the event carries no
 * timeline meaning (conversation turns, lifecycle bookkeeping, unknown types).
 */
export function sessionEventToMarker(ev: SessionEvent): SessionMarker | null {
  switch (ev.type) {
    case 'compaction': {
      const before = (ev.before / 1000).toFixed(0);
      const after = (ev.after / 1000).toFixed(0);
      const level = ev.level ? ` (${ev.level})` : '';
      const reductions =
        ev.reductions && ev.reductions.length > 0
          ? ` [${ev.reductions.map((r) => `${r.phase}: −${r.saved}`).join(', ')}]`
          : '';
      return {
        ts: ev.ts,
        source: ev.type,
        level: 'info',
        text: `⟲ context compacted${level}: ${before}K → ${after}K tokens${reductions}`,
      };
    }

    case 'error':
      return {
        ts: ev.ts,
        source: ev.type,
        level: 'error',
        text: ev.phase ? `[${ev.phase}] ${ev.message}` : ev.message,
      };

    case 'provider_retry': {
      const secs = (ev.delayMs / 1000).toFixed(ev.delayMs >= 1000 ? 1 : 2);
      return {
        ts: ev.ts,
        source: ev.type,
        level: 'warn',
        text: ev.status
          ? `⟳ retry ${ev.attempt} (HTTP ${ev.status}) after ${secs}s — ${ev.description}`
          : `⟳ retry ${ev.attempt} after ${secs}s — ${ev.description}`,
      };
    }

    case 'provider_error':
      return {
        ts: ev.ts,
        source: ev.type,
        level: 'error',
        text: ev.status
          ? `provider error (HTTP ${ev.status}, ${ev.retryable ? 'retryable' : 'fatal'}): ${ev.description}`
          : `provider error (${ev.retryable ? 'retryable' : 'fatal'}): ${ev.description}`,
      };

    case 'checkpoint':
      return {
        ts: ev.ts,
        source: ev.type,
        level: 'info',
        text: `✓ checkpoint #${ev.promptIndex}: "${ev.promptPreview.slice(0, 60)}"`,
      };

    case 'agent_spawned':
      return {
        ts: ev.ts,
        source: ev.type,
        level: 'info',
        text: `spawned as ${ev.role}`,
        agentId: ev.agentId,
      };

    case 'agent_stopped':
      return {
        ts: ev.ts,
        source: ev.type,
        level: 'info',
        text: 'stopped',
        agentId: ev.agentId,
      };

    case 'agent_error':
      return {
        ts: ev.ts,
        source: ev.type,
        level: 'error',
        text: `error: ${ev.error.slice(0, 80)}`,
        agentId: ev.agentId,
      };

    case 'mode_changed':
      return {
        ts: ev.ts,
        source: ev.type,
        level: 'info',
        text: `mode: ${ev.from} → ${ev.to}`,
      };

    case 'skill_activated':
      return {
        ts: ev.ts,
        source: ev.type,
        level: 'info',
        text: `skill activated: ${ev.skillName}`,
      };

    case 'skill_deactivated':
      return {
        ts: ev.ts,
        source: ev.type,
        level: 'info',
        text: `skill deactivated: ${ev.skillName}`,
      };

    case 'message_truncated':
      return {
        ts: ev.ts,
        source: ev.type,
        level: 'warn',
        text:
          ev.after < ev.before
            ? `message truncated: ${ev.before} → ${ev.after} tokens`
            : `message truncated at ${ev.after} tokens`,
      };

    default:
      return null;
  }
}

/**
 * Project an event stream to its markers, in JSONL order.
 *
 * `sources` restricts which event types are projected — pass
 * {@link CHAT_MARKER_SOURCES} for chat-shaped surfaces. Defaults to the full
 * {@link SESSION_MARKER_EVENT_TYPES}.
 */
export function projectSessionMarkers(
  events: readonly SessionEvent[],
  sources: ReadonlySet<SessionEvent['type']> = SESSION_MARKER_EVENT_TYPES,
): SessionMarker[] {
  const markers: SessionMarker[] = [];
  for (const ev of events) {
    if (!sources.has(ev.type)) continue;
    const marker = sessionEventToMarker(ev);
    if (marker) markers.push(marker);
  }
  return markers;
}

/**
 * System-injected metadata prefixes that are folded into the conversation
 * as `user`/`system`-role messages by the agent loop at runtime (mailbox,
 * fleet pulse, loop detector, resume validation notices) but should NOT appear
 * in the human-facing chat history on session resume/replay.
 *
 * Also covers routing-noise error bubbles that the WebUI client has already
 * swallowed live (`handleError` drops them) but that earlier turns may have
 * persisted to the on-disk transcript — replay must not resurrect them into
 * the human-visible chat.
 */
export const SYSTEM_INJECTION_PREFIXES: readonly string[] = [
  '[MAILBOX]',
  '[MAILBOX BTW]',
  '[BY THE WAY —',
  '[QUEUED MESSAGES —',
  '[FLEET PULSE]',
  '[loop-detector]',
  '[SESSION RESUME FILE VALIDATION]',
  '[SESSION RESUME INTERRUPTED WORK]',
  '[session.resume] Request targeted session',
];

/**
 * Check if a text block is an internal runtime system injection that should be
 * hidden from the human chat transcript on replay across all surfaces (TUI, WebUI, SimpleUI).
 */
export function isSystemInjectedMessage(text: string): boolean {
  const trimmed = text.trimStart();
  for (const prefix of SYSTEM_INJECTION_PREFIXES) {
    if (trimmed.startsWith(prefix)) return true;
  }
  return false;
}
