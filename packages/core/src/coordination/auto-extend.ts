/**
 * Default auto-extend policy for subagent budgets.
 *
 * The budget's soft-limit path (`SubagentBudget` → `budget.threshold_reached`)
 * only negotiates an extension when SOMETHING listens on the EventBus. Under a
 * `Director`, that listener is the director's own auto-extend handler. On the
 * plain coordinator path (e.g. a bare `/spawn` with no director) nothing
 * listens, so the budget falls back to a hard stop and the subagent dies the
 * moment it crosses a soft limit.
 *
 * `attachAutoExtend` is the additive fix: wire it to a subagent's EventBus and
 * budget overruns are auto-granted headroom instead of killing the run. It is
 * heartbeat-aware for the timeout kind — wall-clock time always advances, so a
 * naive "extend timeout forever" would let a wedged agent run indefinitely.
 * Instead, a timeout extension is granted only when the agent has executed a
 * new tool call or started a new iteration since the last timeout extension.
 * No progress since last time ⇒ the agent is genuinely stuck ⇒ deny and let it
 * fail. The non-timeout kinds (iterations/tool_calls/tokens/cost) extend up to
 * a per-kind cap, then deny — those ceilings are the real runaway guard.
 */
import type { EventBus } from '../kernel/events.js';

export interface AutoExtendCeiling {
  maxIterations?: number | undefined;
  maxToolCalls?: number | undefined;
  maxTokens?: number | undefined;
  maxCostUsd?: number | undefined;
  timeoutMs?: number | undefined;
}

export interface AutoExtendPolicy {
  /** Multiplier applied to the tripped limit when extending. Default 0.5 (+50%). */
  factor?: number | undefined;
  /**
   * Max extensions per NON-timeout kind before denying. Timeout is governed by
   * the heartbeat check, not this cap, so it can extend indefinitely while the
   * agent makes progress. Default 8.
   */
  maxExtensionsPerKind?: number | undefined;
  /** Absolute ceilings — an extension never pushes a limit past these. */
  ceiling?: AutoExtendCeiling | undefined;
}

type AutoExtendCeilingValues = { [K in keyof AutoExtendCeiling]-?: number };

const DEFAULT_CEILING: AutoExtendCeilingValues = {
  maxIterations: 50_000,
  maxToolCalls: 100_000,
  maxTokens: 5_000_000,
  maxCostUsd: 100,
  timeoutMs: 24 * 60 * 60 * 1000,
};

const FIELD_BY_KIND = {
  iterations: 'maxIterations',
  tool_calls: 'maxToolCalls',
  tokens: 'maxTokens',
  cost: 'maxCostUsd',
  timeout: 'timeoutMs',
  idle_timeout: 'timeoutMs',
} as const;

/**
 * Attach an auto-extend policy to a subagent's EventBus. Returns an unsubscribe
 * function that detaches all listeners — call it when the subagent task ends.
 */
export function attachAutoExtend(events: EventBus, policy: AutoExtendPolicy = {}): () => void {
  const factor = policy.factor ?? 0.5;
  const maxPerKind = policy.maxExtensionsPerKind ?? 8;
  const ceiling = { ...DEFAULT_CEILING, ...policy.ceiling };

  const extendCounts = new Map<string, number>();
  // Monotonic progress counter: tool executions + iteration starts. Used to
  // decide whether a timeout extension is warranted (progress) or the agent is
  // wedged (no progress since the last timeout grant).
  let progress = 0;
  let lastTimeoutProgress = -1;
  // Deduplicates rapid re-entrant events for the same (kind, limit) pair.
  // If the C1 fix in the coordinator fails to prevent a duplicate emission,
  // or a listener re-enters synchronously, only the first event is processed.
  let lastSeenKey: string | null = null;

  const unsubs: Array<() => void> = [
    events.on('tool.executed', () => {
      progress++;
    }),
    events.on('iteration.started', () => {
      progress++;
    }),
    events.on('budget.threshold_reached', (e) => {
      const { kind, limit, extend, deny } = e;

      // Deduplicate concurrent events for the same (kind, limit) pair.
      // The coordinator's _watchdogActive guard (C1 fix) prevents duplicate
      // timeout emissions from the budget's own checkTimeout path, but
      // non-timeout kinds and any remaining races are caught here.
      const key = `${kind}:${limit}`;
      if (key === lastSeenKey) return;
      lastSeenKey = key;

      if (kind === 'timeout' || kind === 'idle_timeout') {
        if (progress > lastTimeoutProgress) {
          lastTimeoutProgress = progress;
          const next = Math.min(
            Math.ceil(limit * (1 + factor)),
            ceiling.timeoutMs ?? DEFAULT_CEILING.timeoutMs,
          );
          if (next <= limit) {
            deny();
            return;
          }
          extend({ timeoutMs: next });
        } else {
          // No new work since the last timeout extension — the agent is stuck.
          deny();
        }
        return;
      }

      const count = extendCounts.get(kind) ?? 0;
      if (count >= maxPerKind) {
        deny();
        return;
      }
      extendCounts.set(kind, count + 1);
      const field = FIELD_BY_KIND[kind];
      const cap = ceiling[field] ?? DEFAULT_CEILING[field];
      const next = Math.min(Math.ceil(limit * (1 + factor)), cap);
      if (next <= limit) {
        deny();
        return;
      }
      extend({ [field]: next });
    }),
  ];

  return () => {
    for (const u of unsubs) u();
  };
}
