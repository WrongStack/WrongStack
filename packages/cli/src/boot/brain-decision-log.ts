/**
 * brain-decision-log — last-N decision log subscription for /brain status.
 *
 * Pulled out of cli-main.ts as part of PR 8 (Stage 1 of the cli-main split
 * refactor; see `next-1.md`). This module owns the rolling 20-entry buffer
 * that `/brain` reads from to render a compact status line. It subscribes to
 * the four decision events (`brain.decision_answered`,
 * `brain.decision_ask_human`, `brain.decision_denied`, `brain.intervention`)
 * plus `brain.council_resolved`, from which only WARNED resolutions are
 * recorded — panel-integrity signals, not decisions.
 *
 * The host wires this up once at boot and retains a reference to `brainLog`
 * (and indirectly `pushBrainLog`) for the duration of the session.
 */

type BrainDecisionKind =
  | 'answered'
  | 'ask_human'
  | 'denied'
  | 'intervention'
  | 'council_warn';

export interface BrainDecisionEntry {
  at: number;
  kind: BrainDecisionKind;
  question: string;
  outcome: string;
}

const MAX_BRAIN_LOG_ENTRIES = 20;

/**
 * Subscribe to the four brain.* decision events and maintain a rolling
 * 20-entry ring buffer. Caller retains the returned `brainLog` array; the
 * returned `pushBrainLog` lets external code (e.g. slash-command handlers)
 * append additional entries that should appear in /brain status.
 *
 * The returned `dispose` unregisters all four listeners — cli-main.ts wires
 * it into its existing `teardownHandlers` so REPL/TUI re-entry doesn't leak.
 *
 * The events emitter uses EventBus's typed `.on(name, listener)` API; we
 * cast at the call site because the EventBus generic constraint is
 * narrower than the dynamic string event names we register here.
 */
export function subscribeBrainDecisionLog(
  // biome-ignore lint/suspicious/noExplicitAny: dynamic event name dispatch — typed EventBus<E> cannot match a `string` parameter without erasure.
  events: any,
): {
  brainLog: BrainDecisionEntry[];
  pushBrainLog: (entry: BrainDecisionEntry) => void;
  dispose: () => void;
} {
  const listeners: Array<[string, (payload: unknown) => void]> = [];
  const brainLog: BrainDecisionEntry[] = [];
  const pushBrainLog = (entry: BrainDecisionEntry): void => {
    brainLog.push(entry);
    if (brainLog.length > MAX_BRAIN_LOG_ENTRIES) brainLog.shift();
  };

  const subscribe = (name: string, handler: (payload: unknown) => void): void => {
    (events.on as (e: string, h: (payload: unknown) => void) => void)(name, handler);
    listeners.push([name, handler]);
  };

  subscribe('brain.decision_answered', (raw) => {
    const e = raw as {
      at: number;
      request: { question: string };
      decision: { type: string; optionId?: string; text?: string };
    };
    pushBrainLog({
      at: e.at,
      kind: 'answered',
      question: e.request.question,
      outcome: e.decision.type === 'answer' ? (e.decision.optionId ?? e.decision.text ?? '') : '',
    });
  });

  subscribe('brain.decision_ask_human', (raw) => {
    const e = raw as { at: number; request: { question: string } };
    pushBrainLog({
      at: e.at,
      kind: 'ask_human',
      question: e.request.question,
      outcome: 'escalated to human',
    });
  });

  subscribe('brain.decision_denied', (raw) => {
    const e = raw as {
      at: number;
      request: { question: string };
      decision: { type: string; reason?: string };
    };
    pushBrainLog({
      at: e.at,
      kind: 'denied',
      question: e.request.question,
      outcome: e.decision.type === 'deny' ? (e.decision.reason ?? '') : '',
    });
  });

  // Panel-integrity warnings from the council. Not a decision — but neither is
  // `intervention`, and this ring is the one place a human already looks for
  // recent Brain activity. Without it, "your council collapsed onto a single
  // model" was only observable by enabling the replay trace and reading JSONL.
  //
  // Only warned resolutions are recorded: with the default
  // `distinctness: 'none'` the orchestrator emits none at all, so a healthy
  // panel adds nothing to the ring.
  subscribe('brain.council_resolved', (raw) => {
    const e = raw as {
      at: number;
      status: string;
      resolution: string;
      warnings?: string[];
    };
    if (!e.warnings?.length) return;
    pushBrainLog({
      at: e.at,
      kind: 'council_warn',
      question: `council ${e.status} via ${e.resolution}`,
      outcome: e.warnings.join('; '),
    });
  });

  subscribe('brain.intervention', (raw) => {
    const e = raw as {
      at: number;
      request: { question: string };
      intervened: boolean;
    };
    pushBrainLog({
      at: e.at,
      kind: 'intervention',
      question: e.request.question,
      outcome: e.intervened ? 'steered the agent' : 'observed (no action)',
    });
  });

  const dispose = (): void => {
    for (const [name, handler] of listeners) {
      // Call through the EventBus receiver. Detaching `events.off` loses
      // `this` and crashes on shutdown with "reading 'listeners'".
      (events.off as (e: string, h: (payload: unknown) => void) => void).call(
        events,
        name,
        handler,
      );
    }
  };

  return { brainLog, pushBrainLog, dispose };
}
