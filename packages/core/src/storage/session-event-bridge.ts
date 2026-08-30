import type { SessionEvent, SessionWriter } from '../types/session.js';

export type AuditLevel = 'minimal' | 'standard' | 'full';

/**
 * Configuration for sampling high-volume events inside the bridge.
 * This allows callers (CLI, TUI, WebUI, plugins) to tune how aggressively
 * noisy events like tool progress are persisted.
 */
export interface ToolProgressSamplingOptions {
  /**
   * How often to persist 'log' and 'partial_output' progress events.
   * - 1 = every message (no sampling)
   * - 8 = keep the first message + every 8th after that (default)
   */
  sampleRate?: number | undefined;
}

export interface SessionSamplingOptions {
  /** Controls sampling behavior for `tool_progress` events (only relevant at auditLevel 'full'). */
  toolProgress?: ToolProgressSamplingOptions | undefined;
}

export interface SessionEventBridgeOptions {
  /** Sampling rules for high-volume audit events. */
  sampling?: SessionSamplingOptions | undefined;
}

/**
 * Small, safe helper that wraps a SessionWriter and enforces the
 * configured auditLevel.
 *
 * All appends are best-effort. Failures are swallowed (with optional
 * diagnostics) so they never crash the agent loop.
 */
export interface SessionEventBridge {
  /** Append an event if allowed by the current audit level. */
  append(event: SessionEvent): Promise<void>;
  /** Batch-append events allowed by the current audit level. */
  appendBatch(events: SessionEvent[]): Promise<void>;

  /** Current audit level. Reflects the latest {@link setAuditLevel} value. */
  readonly level: AuditLevel;

  /**
   * Change the audit level on a live bridge. Subsequent appends are filtered
   * by the new level — used by the TUI `/settings` picker to apply an
   * `auditLevel` change to the running session without a restart.
   */
  setAuditLevel(level: AuditLevel): void;

  /** Returns true if an event of this type should be written at the current level. */
  allows(type: SessionEvent['type']): boolean;
}

/** Core events that are always written regardless of auditLevel. */
export const CORE_RECONSTRUCT_EVENTS = new Set<SessionEvent['type']>([
  'session_start',
  'session_resumed',
  'session_forked',
  'user_input',
  'llm_response',
  'tool_use',
  'tool_result',
  'message_appended',
  'message_updated',
  'messages_replaced',
  'messages_dropped',
  'context_snapshot',
  'checkpoint',
  'file_snapshot',
  'file_observation',
  'rewound',
  'in_flight_start',
  'in_flight_end',
  'session_end',
]);

/**
 * Events that are considered "standard" audit detail.
 * These are lightweight and high-value for forensics.
 */
export const STANDARD_AUDIT_EVENTS = new Set<SessionEvent['type']>([
  'llm_request',
  'tool_call_start',
  'tool_call_end',
  'compaction',
  'error',
  'message_truncated',
  'provider_retry',
  'provider_error',
  'skill_activated',
  'skill_deactivated',
  // Resume markers and fleet lifecycle. These reach disk today only because
  // every producer appends to the raw SessionWriter and bypasses this bridge —
  // routed through it while absent from both sets, `isAllowed` would drop them
  // at the DEFAULT level and the resume timeline would lose them silently.
  'mode_changed',
  'agent_spawned',
  'agent_session_linked',
  'agent_stopped',
  'agent_error',
  'delegate_started',
  'delegate_completed',
  'loop_detected',
  'model_switched',
  'task_created',
  'task_updated',
  'task_completed',
  'task_failed',
  'side_effect',
]);

/**
 * Events that are only allowed at 'full' audit level because they can be
 * very high volume (e.g. streaming tool output).
 */
const FULL_ONLY_EVENTS = new Set<SessionEvent['type']>(['tool_progress']);

/**
 * "full" level allows everything (including potentially heavy events
 * that plugins or future code may emit).
 */
function isAllowed(type: SessionEvent['type'], level: AuditLevel): boolean {
  if (CORE_RECONSTRUCT_EVENTS.has(type)) return true;
  if (level === 'minimal') return false;

  if (STANDARD_AUDIT_EVENTS.has(type)) return true;
  if (level === 'standard') return false;

  // 'full' level events (high volume)
  if (FULL_ONLY_EVENTS.has(type)) {
    return level === 'full';
  }

  // 'full' — allow everything else
  return true;
}

/**
 * Create a safe, audit-level-aware bridge around a SessionWriter.
 *
 * The bridge can also apply sampling for high-volume events (e.g. `tool_progress`)
 * when `auditLevel` is set to `'full'`.
 *
 * @example
 * const bridge = createSessionEventBridge(sessionWriter, 'full', {
 *   sampling: {
 *     toolProgress: { sampleRate: 5 } // more aggressive sampling
 *   }
 * });
 */
export function createSessionEventBridge(
  writer: SessionWriter | (() => SessionWriter | undefined | null) | undefined | null,
  level: AuditLevel = 'standard',
  options: SessionEventBridgeOptions = {},
): SessionEventBridge {
  // Mutable so setAuditLevel() can re-tune a live bridge in place.
  let currentLevel: AuditLevel = level ?? 'standard';

  // Accept either a writer instance or a getter. A getter lets long-lived
  // hosts (CLI/TUI/WebUI) resolve the CURRENT writer on every append — when
  // the user resumes another session mid-run, audit events follow the swap
  // instead of being silently dropped into the old, closed writer.
  const resolveWriter: () => SessionWriter | undefined | null =
    typeof writer === 'function' ? writer : () => writer;

  // Internal sampling state for high-volume events (e.g. tool_progress).
  // Keyed by tool call id (or name as fallback) to keep sampling per-call.
  const progressCounters = new Map<string, number>();

  const toolProgressConfig = options.sampling?.toolProgress ?? {};
  const TOOL_PROGRESS_SAMPLE_RATE = toolProgressConfig.sampleRate ?? 8;

  /**
   * Decide whether a high-volume event should be sampled in.
   * Currently only implements sampling for 'tool_progress'.
   */
  function shouldSample(event: SessionEvent): boolean {
    if (event.type !== 'tool_progress') return true;

    const progEvent = event as Extract<SessionEvent, { type: 'tool_progress' }>;
    const innerType = progEvent.event?.type;

    // Always let through high-signal structured events
    if (innerType === 'warning' || innerType === 'metric' || innerType === 'file_changed') {
      return true;
    }

    // Sample noisy text streams (log / partial_output)
    if (innerType === 'log' || innerType === 'partial_output') {
      const key = progEvent.id || progEvent.name;
      const count = (progressCounters.get(key) || 0) + 1;
      progressCounters.set(key, count);

      // Always keep the first message + every Nth after that
      return count === 1 || count % TOOL_PROGRESS_SAMPLE_RATE === 0;
    }

    return true;
  }

  return {
    get level() {
      return currentLevel;
    },

    setAuditLevel(next) {
      currentLevel = next ?? 'standard';
    },

    allows(type) {
      return isAllowed(type, currentLevel);
    },

    async append(event) {
      const target = resolveWriter();
      if (!target) return;

      // Clean up sampling state when a tool call ends or returns a result to prevent
      // progressCounters from accumulating keys indefinitely.
      if (event.type === 'tool_call_end' || event.type === 'tool_result') {
        progressCounters.delete(event.id);
      }

      if (!isAllowed(event.type, currentLevel)) return;

      // Apply sampling for high-volume events (only at 'full' level)
      if (!shouldSample(event)) return;

      try {
        await target.append(event);
      } catch (_err) {
        // Best-effort: never let session logging break the agent.
        // The existing FileSessionWriter already does throttled warnings,
        // but we keep this wrapper silent by default to avoid log spam.
        // Callers that care can listen to EventBus 'session.damaged' etc.
      }
    },

    async appendBatch(events) {
      const target = resolveWriter();
      if (!target || events.length === 0) return;

      // Clean up sampling state for any tool_call_end or tool_result events in the batch.
      for (const e of events) {
        if (e.type === 'tool_call_end' || e.type === 'tool_result') progressCounters.delete(e.id);
      }

      const allowed = events.filter((e) => isAllowed(e.type, currentLevel) && shouldSample(e));
      if (allowed.length === 0) return;
      try {
        await target.appendBatch(allowed);
      } catch {
        // best-effort — same contract as append()
      }
    },
  };
}

/**
 * Safely extract the auditLevel from a (possibly partial) Config object.
 * Falls back to 'standard' if not present or invalid.
 */
export function resolveAuditLevel(
  cfg?: { session?: { auditLevel?: AuditLevel | undefined } | undefined } | null,
): AuditLevel {
  const raw = cfg?.session?.auditLevel;
  if (raw === 'minimal' || raw === 'standard' || raw === 'full') {
    return raw;
  }
  return 'standard';
}

/**
 * Fully resolves the session logging configuration with sensible defaults.
 * This is the recommended way for the CLI / TUI / WebUI to read session config.
 */
export function resolveSessionLoggingConfig(
  cfg?: {
    // Every optional here spells out `| undefined` so callers holding a real
    // `Config` can pass it directly. Under `exactOptionalPropertyTypes` an
    // optional property whose type omits `undefined` rejects a source that
    // includes it, which is why both existing call sites had to launder the
    // argument through `as never as Parameters<...>[0]` — a cast that would
    // have silently swallowed any genuine shape drift here.
    session?:
      | {
          auditLevel?: AuditLevel | undefined;
          sampling?:
            | {
                toolProgress?: { sampleRate?: number | undefined } | undefined;
              }
            | undefined;
        }
      | undefined;
  } | null,
): {
  auditLevel: AuditLevel;
  sampling: {
    toolProgress: { sampleRate: number };
  };
} {
  const session = cfg?.session ?? {};

  const auditLevel = resolveAuditLevel(cfg);

  const toolProgressSampleRate = session.sampling?.toolProgress?.sampleRate ?? 8;

  return {
    auditLevel,
    sampling: {
      toolProgress: {
        sampleRate: Math.max(1, Math.floor(toolProgressSampleRate)),
      },
    },
  };
}
