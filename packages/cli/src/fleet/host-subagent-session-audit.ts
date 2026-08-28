/**
 * host-subagent-session-audit — the tool-lifecycle and session-lifecycle
 * records a subagent's own JSONL was missing.
 *
 * A subagent gets a real `DefaultSessionStore` writer, the same engine the
 * leader uses, so its transcript carries `session_start`, `user_input`,
 * `llm_request`/`llm_response`, `tool_result` and the message journal. Two
 * things never reached it, both for the same structural reason: the leader's
 * copies are written by `cli/src/session-event-wiring.ts`, which subscribes to
 * the HOST EventBus, while every subagent runs on a private `new EventBus()`
 * (see host-subagent-factory). Nothing was subscribed on that side.
 *
 * The consequences were measurable — over a 3,156-transcript corpus, not one
 * subagent JSONL contained a `tool_call_start`, `tool_call_end`, or
 * `session_end`:
 *
 *  - `SessionSummaryTracker` counts tool calls from `tool_call_start`, so every
 *    subagent summary reported `toolCallCount: 0` and an empty `toolBreakdown`
 *    no matter how much work it did.
 *  - With no `session_end`, `summarizeSessionEventSequence` never sees the
 *    terminal marker, so a cleanly finished subagent is indistinguishable from
 *    one killed mid-flight, and `SessionRecovery` treats both as stale.
 *
 * Audit gating mirrors the leader: `tool_call_start`/`tool_call_end` are
 * STANDARD-level events, so a `minimal` auditLevel drops them here too, exactly
 * as `SessionEventBridge` would. `session_end` is a core reconstruct event and
 * is always written.
 */
import type { EventBus } from '@wrongstack/core/kernel';
import type { SessionEventBridge } from '@wrongstack/core/storage';
import type { SessionWriter, TokenCounter } from '@wrongstack/core/types';

interface SubagentSessionAudit {
  /**
   * Append `session_end` carrying this subagent's own cumulative usage, then
   * drop the tool subscriptions. Call before `session.close()` — close()
   * finalizes the summary sidecar, and a `session_end` appended after it would
   * miss that snapshot.
   *
   * Idempotent: a second call is a no-op, so a dispose path that runs twice
   * cannot write two terminal markers (`metaFromEvents` takes the LAST
   * `session_end`, but recovery treats any trailing marker as a clean exit).
   */
  finalize(): Promise<void>;
}

export function installSubagentSessionAudit(opts: {
  /** The subagent's private EventBus. */
  events: EventBus;
  /** The subagent's own JSONL writer. */
  session: SessionWriter;
  /** The subagent's own counter — never the leader's. */
  tokenCounter: TokenCounter;
  /** Shared audit-level gate, so subagents honor the same config as the leader. */
  bridge: Pick<SessionEventBridge, 'allows'>;
}): SubagentSessionAudit {
  const { events, session, tokenCounter, bridge } = opts;
  const unsubs: Array<() => void> = [];

  // Appends are best-effort by the SessionWriter contract: a failed audit
  // write must never surface as a subagent task failure.
  const append = (event: Parameters<SessionWriter['append']>[0]): void => {
    void session.append(event).catch(() => {});
  };

  if (bridge.allows('tool_call_start')) {
    unsubs.push(
      events.on('tool.started', (e) => {
        append({
          type: 'tool_call_start',
          ts: new Date().toISOString(),
          name: e.name,
          id: e.id,
          input: e.input,
        });
      }),
    );
  }

  if (bridge.allows('tool_call_end')) {
    unsubs.push(
      events.on('tool.executed', (e) => {
        append({
          type: 'tool_call_end',
          ts: new Date().toISOString(),
          name: e.name,
          id: e.id ?? '',
          durationMs: e.durationMs ?? 0,
          // `outputSize` is the legacy field name; both are written so
          // readers pinned to either keep working.
          outputSize: e.outputBytes ?? 0,
          ok: e.ok,
          outputBytes: e.outputBytes ?? 0,
          outputTokens: e.outputTokens,
          outputLines: e.outputLines,
        });
      }),
    );
  }

  let finalized = false;
  return {
    async finalize(): Promise<void> {
      if (finalized) return;
      finalized = true;
      for (const off of unsubs) {
        try {
          off();
        } catch {
          // Unsubscribing must not mask the task result.
        }
      }
      unsubs.length = 0;
      try {
        await session.append({
          type: 'session_end',
          ts: new Date().toISOString(),
          usage: tokenCounter.total(),
          ...(session.pendingToolUses.length > 0
            ? { pendingToolUses: [...session.pendingToolUses] }
            : {}),
        });
      } catch {
        // Best-effort, same contract as every other session append.
      }
    },
  };
}
