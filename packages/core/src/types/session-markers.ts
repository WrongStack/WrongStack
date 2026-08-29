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
  /** Set only for the `agent_*` and `delegate_*` sources. */
  agentId?: string | undefined;
  /**
   * The source event's own fields, for the sources a surface renders as
   * something richer than a line of text.
   *
   * `text` stays the fallback every surface can always use. But the TUI draws
   * a delegation as a labelled subagent row with its own icon, colour and
   * compact stat line, and the WebUI as a two-line assistant message — both
   * built from the structured payload, live. Handing replay only the rendered
   * sentence would have forced those surfaces to show something they never
   * showed while running, which is the exact divergence this module exists to
   * prevent. Kept to the few sources that need it, and JSON-serializable so it
   * survives the wire alongside the rest of the marker.
   */
  detail?: SessionMarkerDetail | undefined;
}

/** Structured payload for the marker sources whose surfaces render richly. */
export type SessionMarkerDetail =
  | {
      kind: 'delegate_started';
      target: string;
      task: string;
    }
  | {
      kind: 'delegate_completed';
      target: string;
      task: string;
      ok: boolean;
      status?: string | undefined;
      summary: string;
      durationMs: number;
      iterations: number;
      toolCalls: number;
      costUsd?: number | undefined;
    };

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
  'agent_session_linked',
  'agent_stopped',
  'agent_error',
  'delegate_started',
  'delegate_completed',
  'loop_detected',
  'model_switched',
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
 *
 * Subagent/delegation lifecycle is excluded from the main chat replay too.
 * Those sessions cannot be resumed as live workers after a process restart, so
 * injecting ended or stale workers into the visible conversation makes resume
 * look busier than the session the user can actually continue. The raw events
 * stay in the journal for a dedicated subagent history view.
 */
const CHAT_EXCLUDED_MARKER_SOURCES: ReadonlySet<SessionEvent['type']> = new Set([
  'checkpoint',
  'agent_spawned',
  'agent_session_linked',
  'agent_stopped',
  'agent_error',
  'delegate_started',
  'delegate_completed',
]);

export const CHAT_MARKER_SOURCES: ReadonlySet<SessionEvent['type']> = new Set(
  [...SESSION_MARKER_EVENT_TYPES].filter((type) => !CHAT_EXCLUDED_MARKER_SOURCES.has(type)),
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

    case 'agent_session_linked':
      return {
        ts: ev.ts,
        source: ev.type,
        level: 'info',
        // The transcript path is the point of the marker: it is how a reader
        // of a resumed session gets from "this agent ran" to what it actually
        // did. Falls back to the journal id when the writer had no file.
        text: `transcript → ${ev.transcriptPath ?? ev.agentSessionId}`,
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

    case 'delegate_started':
      return {
        ts: ev.ts,
        source: ev.type,
        level: 'info',
        text: `🤝 delegating → ${ev.target}: ${ev.task.length > 100 ? `${ev.task.slice(0, 99)}…` : ev.task}`,
        agentId: ev.subagentId,
        detail: { kind: 'delegate_started', target: ev.target, task: ev.task },
      };

    case 'delegate_completed': {
      const cost = ev.costUsd && ev.costUsd > 0 ? ` · $${ev.costUsd.toFixed(4)}` : '';
      return {
        ts: ev.ts,
        source: ev.type,
        level: ev.ok ? 'info' : 'error',
        text: `${ev.ok ? '✅' : '❌'} ${ev.summary}${cost}`,
        agentId: ev.subagentId,
        detail: {
          kind: 'delegate_completed',
          target: ev.target,
          task: ev.task,
          ok: ev.ok,
          status: ev.status,
          summary: ev.summary,
          durationMs: ev.durationMs,
          iterations: ev.iterations,
          toolCalls: ev.toolCalls,
          costUsd: ev.costUsd,
        },
      };
    }

    case 'loop_detected': {
      const what =
        ev.kind === 'message' ? 'the same reply' : ev.tools ? `\`${ev.tools}\`` : 'the same step';
      return {
        ts: ev.ts,
        source: ev.type,
        level: 'warn',
        text:
          ev.action === 'steer'
            ? `🔁 Loop detected — ${what} repeated ${ev.repeatCount}× ; the run was steered.`
            : `🔁 Loop detected — ${what} repeated ${ev.repeatCount}× ; the run was stopped.`,
      };
    }

    case 'model_switched': {
      const to = `${ev.to.providerId}/${ev.to.model}`;
      const from = ev.from ? `${ev.from.providerId}/${ev.from.model} → ` : '';
      return {
        ts: ev.ts,
        source: ev.type,
        level: ev.reason === 'fallback' ? 'warn' : 'info',
        text:
          ev.reason === 'fallback'
            ? `⚠ fallback${ev.status ? ` (HTTP ${ev.status})` : ''}: ${from}${to}`
            : `model: ${from}${to}`,
      };
    }

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
  // Written by `compaction-elision.ts` in place of the tool history it
  // elided — a note addressed to the MODEL about what it can no longer see.
  // It was replaying as the first line of the transcript, so every resumed
  // session opened with a machine-readable inventory of its own compaction
  // instead of the user's first prompt.
  '[tool_history_digest:',
  '[session.resume] Request targeted session',
];

/*
 * NOT in the list, deliberately: `[SESSION RESUME FILE VALIDATION]` and
 * `[SESSION RESUME INTERRUPTED WORK]`.
 *
 * Everything above is addressed to the MODEL — context the agent loop folded
 * into the conversation so the LLM could see it. The resume notices are the
 * opposite: `executeResumeSession` builds them FOR THE HUMAN, to say that
 * files changed underneath the session or that calls were left unfinished.
 * Filtering them meant the store detected the drift, wrote the sentence, and
 * every surface then threw it away — nothing else reads `resumeValidation`
 * either, so the answer existed and reached nobody. Their sibling
 * `[SESSION RESUME CRASH RECOVERY]` was never filtered, which is what makes
 * the omission look accidental rather than intended.
 *
 * Repeated resumes do not stack them: `isResumeNoticeMessage` strips the
 * previous run's notices from the carried conversation before the current
 * run's are appended.
 */

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
